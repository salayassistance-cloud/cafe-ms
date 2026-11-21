// Hotel-only reporting service.
//
// Single source of truth: every metric is aggregation over canonical persisted
// records (Stay, HotelPayment, Reservation, Room) on the dedicated Hotel
// connection. No metric is inferred from a live room status snapshot, from a
// reservation price, or from UI-side list counts. No denormalized report record
// is created or read: reports are computed on request.
//
// Date semantics (matching the existing Hotel services and the canonical
// `lib/ethiopianCalendar.js` conventions):
// - Business dates are Africa/Addis_Ababa civil dates. A Gregorian YYYY-MM-DD
//   value is transport-only input; the canonical instant is Addis local
//   midnight (`parseHotelLocalDate`).
// - Day windows are half-open [dayStart, nextDayStart), matching the stay
//   filters in `services/stays.js` and POS cashier/report windows.
// - `availableRoomNights` is reconstructed ONLY from the room's statusHistory
//   (room creation seeds the first entry). A day whose denominator cannot be
//   fully established by history is reported as `null`, never zero, per the
//   approved null-coverage policy.
//
// Money: payments are integer minor units (santim). Stay charges are decimal
// major units and are converted exactly once via `toHotelMinorUnits`. Integer
// accumulation only; window totals are never floats.
//
// This module performs no writes and issues no index changes.

import { HotelValidationError } from "../errors.js";
import {
  HOTEL_REPORT_MAX_WINDOW_DAYS,
  HOTEL_ROOM_OPERATIONAL_STATUSES,
  HOTEL_STAY_CHARGE_RULE,
} from "../constants.js";
import {
  addHotelLocalDays,
  formatHotelLocalDate,
  hotelLocalToday,
  parseHotelLocalDate,
} from "../dates.js";
import { toHotelMinorUnits } from "../money.js";
import { getHotelPaymentModel } from "../models/hotelPayment.js";
import { getReservationModel } from "../models/reservation.js";
import { getRoomModel } from "../models/room.js";
import { getRoomTypeModel } from "../models/roomType.js";
import { getStayModel } from "../models/stay.js";

// Addis Ababa civil dates are computed from local-midnight instants (fixed
// UTC+03:00, no DST), so consecutive day starts are exactly 24 hours apart.
const HOTEL_DAY_MS = 24 * 60 * 60 * 1000;

// Stable metric-definition labels returned with every report so the UI can
// display the exact semantics that produced the numbers.
export const HOTEL_REPORT_DEFINITIONS = Object.freeze({
  dateBasis:
    "All dates are Africa/Addis_Ababa civil dates. Day windows are half-open [start, next start).",
  occupiedRoomNights:
    "Room-nights from real Stay check-in/check-out instants intersecting each civil day, deduplicated per room per day. Cancelled reservations without a Stay never count. An in-house Stay counts through the end of the selected window.",
  availableRoomNights:
    "Eligible rooms for a day are rooms whose status history covers the whole day (an entry exists at or before day start). A covered room is available when it is not OUT_OF_SERVICE at any point of that day. Manual deactivation (isActive=false) is not recoverable historically and is not part of the historical denominator.",
  occupancyRatePct:
    "Occupied room-nights / available room-nights x 100, one decimal. Null when the denominator is unknown or zero; never 0 in place of null.",
  paymentsRecordedMinor:
    "Sum of amountMinor over HotelPayment rows whose current status is RECORDED and whose recordedAt instant falls in the window (payment recorded date). Replays return the same row, so no retry is double-counted.",
  paymentsVoidedMinor:
    "Sum of amountMinor over VOIDED rows grouped by their voidedAt instant (void date), reported separately and excluded from collected totals.",
  postedRoomChargesMinor:
    "Sum of Stay totalCharges (converted exactly to minor units) for stays checked out in the window whose charge snapshot is finalized: billableNights >= 1, non-null roomCharges and totalCharges, and chargeRule CALENDAR_NIGHTS_MIN_ONE (checkout date).",
  adrMinor:
    "Posted room charges / occupied room-nights, rounded to the nearest minor unit. Null when occupied room-nights is 0.",
  revparMinor:
    "Posted room charges / available room-nights, rounded to the nearest minor unit. Null when any day in the window lacks full denominator history or the denominator is 0.",
  scheduledArrivals:
    "Reservations with an arrivalDate on the day and any status except CANCELLED. It is a booking count, never an occupied-room count.",
  noShowArrivals:
    "Reservations with arrivalDate on the day and status NO_SHOW, reported separately from scheduled arrivals.",
  checkIns:
    "Stays whose checkedInAt instant falls on the day (actual check-ins).",
  departuresDue:
    "Stays whose immutable snapshot departureDate is on the day, whatever their remaining status. It is a due count, not a completed checkout.",
  checkOuts:
    "Stays whose checkedOutAt instant falls on the day (actual check-outs).",
  outstandingMinor:
    "For stays checked out in the window: finalized total charges minus all RECORDED payments for those stays over all time (as of now). Null when any such stay has an unfinalized charge snapshot; never a guessed zero. Stays still in house are not included.",
  inventorySnapshot:
    "Live counts read directly from the current Room and RoomType documents; not a historical metric.",
});

function dayIndexFor(days, instant) {
  const ymd = formatHotelLocalDate(instant);
  for (let index = 0; index < days.length; index += 1) {
    if (days[index].date === ymd) return index;
  }
  return null;
}

function finalizeStayCharges(stay) {
  // Mirrors the folio charge-finalization rules (services/folio.js): the
  // completed checkout, the preserved non-null charge snapshot, the minimum
  // charge rule, and an integer billable-night count.
  const billable = stay.billableNights;
  if (!Number.isInteger(billable) || billable < 1) return null;
  if (stay.roomCharges === null || stay.roomCharges === undefined) return null;
  if (stay.totalCharges === null || stay.totalCharges === undefined) return null;
  if (stay.chargeRule !== HOTEL_STAY_CHARGE_RULE) return null;
  try {
    return toHotelMinorUnits(stay.totalCharges);
  } catch {
    return null;
  }
}

function buildDayScaffold(fromInstant, dayCount) {
  const days = [];
  for (let index = 0; index < dayCount; index += 1) {
    const dayStart = addHotelLocalDays(fromInstant, index);
    days.push({
      date: formatHotelLocalDate(dayStart),
      startMs: dayStart.getTime(),
      endMs: dayStart.getTime() + HOTEL_DAY_MS,
      occupiedRoomIds: new Set(),
      availableRoomNights: null,
      paymentsRecordedMinor: 0,
      paymentsVoidedMinor: 0,
      postedRoomChargesMinor: 0,
      scheduledArrivals: 0,
      noShowArrivals: 0,
      checkIns: 0,
      departuresDue: 0,
      checkOuts: 0,
    });
  }
  return days;
}

function countOccupiedRoomNights(days, stays) {
  for (const stay of stays) {
    const checkInMs = new Date(stay.checkedInAt).getTime();
    const checkOutMs = stay.checkedOutAt
      ? new Date(stay.checkedOutAt).getTime()
      : null;
    const roomKey = String(stay.roomId);
    for (const day of days) {
      if (checkInMs < day.endMs && (checkOutMs === null || checkOutMs >= day.startMs)) {
        day.occupiedRoomIds.add(roomKey);
      }
    }
  }
}

function countRoomAvailability(days, rooms) {
  const uncoveredDates = [];
  const uncoveredSeen = new Set();
  for (const day of days) {
    let available = 0;
    let unknown = false;
    for (const room of rooms) {
      const history = Array.isArray(room.statusHistory) ? room.statusHistory : [];
      let firstEntryMs = null;
      let statusAtStart = null;
      let statusAtStartMs = null;
      let entryInsideDayOOS = false;
      for (const entry of history) {
        const changedAtMs = new Date(entry.changedAt).getTime();
        if (firstEntryMs === null || changedAtMs < firstEntryMs) {
          firstEntryMs = changedAtMs;
        }
        if (changedAtMs <= day.startMs) {
          if (statusAtStartMs === null || changedAtMs >= statusAtStartMs) {
            statusAtStart = entry.status;
            statusAtStartMs = changedAtMs;
          }
        } else if (changedAtMs < day.endMs && entry.status === "OUT_OF_SERVICE") {
          entryInsideDayOOS = true;
        }
      }
      const covered = firstEntryMs !== null && firstEntryMs <= day.startMs;
      if (!covered) {
        // Without whole-day history the room's availability is unknowable for
        // that day. A room that already existed at day start (or whose
        // creation instant is unknown) makes the day's denominator null
        // instead of a guessed count. A room created during the day simply is
        // not eligible for that day; the next day starts its coverage.
        const createdAtMs = room.createdAt
          ? new Date(room.createdAt).getTime()
          : null;
        if (createdAtMs === null || createdAtMs <= day.startMs) {
          unknown = true;
          if (!uncoveredSeen.has(day.date)) {
            uncoveredSeen.add(day.date);
            uncoveredDates.push(day.date);
          }
        }
        continue;
      }
      if (statusAtStart !== "OUT_OF_SERVICE" && !entryInsideDayOOS) {
        available += 1;
      }
    }
    day.availableRoomNights = unknown ? null : available;
  }
  return { uncoveredDates };
}

function countActivity(days, stays, reservations) {
  for (const stay of stays) {
    const index = dayIndexFor(days, new Date(stay.checkedInAt));
    if (index !== null) days[index].checkIns += 1;

    if (stay.checkedOutAt) {
      const outIndex = dayIndexFor(days, new Date(stay.checkedOutAt));
      if (outIndex !== null) days[outIndex].checkOuts += 1;
    }
    if (stay.departureDate) {
      const depIndex = dayIndexFor(days, new Date(stay.departureDate));
      if (depIndex !== null) days[depIndex].departuresDue += 1;
    }
  }
  for (const reservation of reservations) {
    if (reservation.status === "CANCELLED") continue;
    const index = dayIndexFor(days, new Date(reservation.arrivalDate));
    if (index === null) continue;
    if (reservation.status === "NO_SHOW") {
      days[index].noShowArrivals += 1;
    } else {
      days[index].scheduledArrivals += 1;
    }
  }
}

function countCharges(days, stays) {
  for (const stay of stays) {
    if (!stay.checkedOutAt) continue;
    const charges = finalizeStayCharges(stay);
    if (charges === null) continue;
    const index = dayIndexFor(days, new Date(stay.checkedOutAt));
    if (index === null) continue;
    days[index].postedRoomChargesMinor += charges;
  }
}

function countPayments(days, recordedPayments, voidedPayments) {
  for (const payment of recordedPayments) {
    const index = dayIndexFor(days, new Date(payment.recordedAt));
    if (index === null) continue;
    days[index].paymentsRecordedMinor += payment.amountMinor;
  }
  for (const payment of voidedPayments) {
    const index = dayIndexFor(days, new Date(payment.voidedAt));
    if (index === null) continue;
    days[index].paymentsVoidedMinor += payment.amountMinor;
  }
}

function sumIntegers(values) {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

function validateReportWindow({ from, to, now }) {
  const fromInstant = parseHotelLocalDate(from, "from");
  const toInstant = parseHotelLocalDate(to, "to");
  if (fromInstant.getTime() > toInstant.getTime()) {
    throw new HotelValidationError({ to: "to must be on or after from" });
  }
  const dayCount =
    Math.round((toInstant.getTime() - fromInstant.getTime()) / HOTEL_DAY_MS) + 1;
  if (
    !Number.isSafeInteger(dayCount) ||
    dayCount < 1 ||
    dayCount > HOTEL_REPORT_MAX_WINDOW_DAYS
  ) {
    throw new HotelValidationError({
      to: `the report window must cover at most ${HOTEL_REPORT_MAX_WINDOW_DAYS} days`,
    });
  }
  const today = hotelLocalToday(now);
  if (to > today) {
    throw new HotelValidationError({ to: "to must not be in the future" });
  }
  return { fromInstant, toInstant, dayCount };
}

export async function buildHotelReportsSummary({
  connection,
  from,
  to,
  now = Date.now(),
} = {}) {
  const { fromInstant, dayCount } = validateReportWindow({ from, to, now });
  const windowStartMs = fromInstant.getTime();
  const windowEndMs = addHotelLocalDays(fromInstant, dayCount).getTime();

  const Stay = getStayModel(connection);
  const Payment = getHotelPaymentModel(connection);
  const Reservation = getReservationModel(connection);
  const Room = getRoomModel(connection);
  const RoomType = getRoomTypeModel(connection);

  const [stays, recordedPayments, voidedPayments, arrivals, rooms, roomTypes] =
    await Promise.all([
      Stay.find({
        checkedInAt: { $lt: new Date(windowEndMs) },
        $or: [
          { checkedOutAt: null },
          { checkedOutAt: { $gte: new Date(windowStartMs) } },
        ],
      })
        .select(
          "roomId checkedInAt checkedOutAt departureDate status billableNights roomCharges totalCharges chargeRule"
        )
        .lean(),
      Payment.find({
        status: "RECORDED",
        recordedAt: { $gte: new Date(windowStartMs), $lt: new Date(windowEndMs) },
      })
        .select("amountMinor method recordedAt")
        .lean(),
      Payment.find({
        status: "VOIDED",
        voidedAt: { $gte: new Date(windowStartMs), $lt: new Date(windowEndMs) },
      })
        .select("amountMinor voidedAt")
        .lean(),
      Reservation.find({
        arrivalDate: { $gte: new Date(windowStartMs), $lt: new Date(windowEndMs) },
      })
        .select("arrivalDate status")
        .lean(),
      Room.find({})
        .select(
          "roomNumber floor isActive operationalStatus statusHistory createdAt"
        )
        .lean(),
      RoomType.find({})
        .select("name code capacity baseNightlyRate isActive")
        .lean(),
    ]);

  const days = buildDayScaffold(fromInstant, dayCount);

  countOccupiedRoomNights(days, stays);
  const { uncoveredDates } = countRoomAvailability(days, rooms);
  countActivity(days, stays, arrivals);
  countCharges(days, stays);
  countPayments(days, recordedPayments, voidedPayments);

  // Finalize per-day derived fields and strip internal scaffolding keys.
  for (const day of days) {
    day.occupiedRoomNights = day.occupiedRoomIds.size;
    day.occupancyRatePct =
      day.availableRoomNights === null || day.availableRoomNights === 0
        ? null
        : Math.round((day.occupiedRoomNights / day.availableRoomNights) * 1000) /
          10;
    delete day.occupiedRoomIds;
    delete day.startMs;
    delete day.endMs;
  }

  // Voided payments keyed by void date; a void inside the window that exceeds
  // the same window's recorded rows still reports independently by void date.
  const totals = {
    occupiedRoomNights: sumIntegers(days.map((day) => day.occupiedRoomNights)),
    availableRoomNights:
      days.some((day) => day.availableRoomNights === null)
        ? null
        : sumIntegers(days.map((day) => day.availableRoomNights)),
    paymentsRecordedMinor: sumIntegers(
      days.map((day) => day.paymentsRecordedMinor)
    ),
    paymentsRecordedCount: recordedPayments.length,
    paymentsVoidedMinor: sumIntegers(days.map((day) => day.paymentsVoidedMinor)),
    paymentsVoidedCount: voidedPayments.length,
    postedRoomChargesMinor: sumIntegers(
      days.map((day) => day.postedRoomChargesMinor)
    ),
    scheduledArrivals: sumIntegers(days.map((day) => day.scheduledArrivals)),
    noShowArrivals: sumIntegers(days.map((day) => day.noShowArrivals)),
    checkIns: sumIntegers(days.map((day) => day.checkIns)),
    departuresDue: sumIntegers(days.map((day) => day.departuresDue)),
    checkOuts: sumIntegers(days.map((day) => day.checkOuts)),
    outstandingMinor: null,
    adrMinor: null,
    revparMinor: null,
    occupancyRatePct: null,
  };

  totals.occupancyRatePct =
    totals.availableRoomNights === null || totals.availableRoomNights === 0
      ? null
      : Math.round(
          (totals.occupiedRoomNights / totals.availableRoomNights) * 1000
        ) / 10;
  totals.adrMinor =
    totals.occupiedRoomNights === 0
      ? null
      : Math.round(totals.postedRoomChargesMinor / totals.occupiedRoomNights);
  totals.revparMinor =
    totals.availableRoomNights === null || totals.availableRoomNights === 0
      ? null
      : Math.round(totals.postedRoomChargesMinor / totals.availableRoomNights);

  // Outstanding balance for stays checked out inside the window.
  const windowStays = stays.filter((stay) => {
    if (!stay.checkedOutAt) return false;
    const ms = new Date(stay.checkedOutAt).getTime();
    return ms >= windowStartMs && ms < windowEndMs;
  });
  const finalizedInWindow = [];
  let unfinalizedCount = 0;
  for (const stay of windowStays) {
    const charges = finalizeStayCharges(stay);
    if (charges === null) {
      unfinalizedCount += 1;
    } else {
      finalizedInWindow.push({ stay, charges });
    }
  }
  if (unfinalizedCount > 0) {
    totals.outstandingMinor = null;
  } else if (finalizedInWindow.length === 0) {
    totals.outstandingMinor = 0;
  } else {
    const stayIds = finalizedInWindow.map((entry) => entry.stay._id);
    const appliedPayments = stayIds.length
      ? await Payment.find({
          status: "RECORDED",
          stayId: { $in: stayIds },
        })
          .select("amountMinor stayId")
          .lean()
      : [];
    const settledStayIds = new Set(stayIds.map((id) => String(id)));
    let appliedMinor = 0;
    for (const payment of appliedPayments) {
      if (settledStayIds.has(String(payment.stayId))) {
        appliedMinor += payment.amountMinor;
      }
    }
    const chargesMinor = finalizedInWindow.reduce((sum, entry) => {
      return sum + entry.charges;
    }, 0);
    totals.outstandingMinor = Math.max(0, chargesMinor - appliedMinor);
  }

  // Live inventory snapshot (not a historical metric).
  const inventory = {
    roomsTotal: rooms.length,
    roomsActive: rooms.filter((room) => room.isActive === true).length,
    roomsInactive: rooms.filter((room) => room.isActive === false).length,
    roomsByOperationalStatus: {},
    roomTypesTotal: roomTypes.length,
    roomTypesActive: roomTypes.filter((type) => type.isActive === true).length,
  };
  for (const status of HOTEL_ROOM_OPERATIONAL_STATUSES) {
    inventory.roomsByOperationalStatus[status] = rooms.filter(
      (room) => room.isActive === true && room.operationalStatus === status
    ).length;
  }

  const methodBreakdown = {};
  for (const payment of recordedPayments) {
    // Method values come from the schema enum; an unrecognized value would be
    // its own honest bucket rather than silently folded into another method.
    const key = String(payment.method);
    methodBreakdown[key] = (methodBreakdown[key] ?? 0) + payment.amountMinor;
  }

  return {
    range: {
      from: days[0].date,
      to: days[days.length - 1].date,
      dayCount,
      fromInstant: new Date(windowStartMs).toISOString(),
      toInstant: new Date(windowEndMs).toISOString(),
    },
    definitions: HOTEL_REPORT_DEFINITIONS,
    labels: {
      payments: "recorded date",
      voids: "void date",
      charges: "checkout date",
    },
    totals,
    days,
    methodBreakdown,
    inventory,
    denominatorCoverage: {
      fullyCovered: totals.availableRoomNights !== null,
      uncoveredDates,
    },
  };
}
