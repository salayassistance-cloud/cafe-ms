// Hotel Ethiopian calendar UI tests — DB-free and DOM-free.
//
// These tests protect the migration of every Hotel date surface from Gregorian
// pickers/labels to the shared POS Ethiopian (Addis Ababa) calendar, while the
// Hotel API keeps receiving exact Gregorian YYYY-MM-DD transport strings.
//
// They also pin the backend-oriented copy that was removed from the Reception,
// Reports, and Hotel Login screens. No Mongo, network, or browser is touched.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HOTEL_UI_TRANSLATIONS,
} from "../lib/hotel/uiTranslations.js";
import {
  addisYMDToUTCStart,
  daysInEthMonth,
  fromEthiopian,
  getAddisYMD,
  gregYMD,
  isEthLeapYear,
  toEthiopian,
  validateEthiopianDate,
} from "../lib/ethiopianCalendar.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => readFileSync(join(root, relativePath), "utf8");

const { en, am } = HOTEL_UI_TRANSLATIONS;

const hotelSources = [
  "app/components/hotel/ReservationsPanel.jsx",
  "app/components/hotel/InHousePanel.jsx",
  "app/components/hotel/NewReservationModal.jsx",
  "app/components/hotel/RoomsPanel.jsx",
  "app/components/hotel/RoomTypesPanel.jsx",
  "app/components/hotel/RoomReportsPanel.jsx",
  "app/components/hotel/HotelTopBar.jsx",
];

describe("Hotel copy cleanup", () => {
  test("removes the redundant technical copy keys from both locales", () => {
    const removedKeys = [
      "login.brandNote",
      "login.sessionNote",
      "newres.description",
      "newres.assignNowHint",
      "assign.description",
      "roomForm.createDescription",
      "roomForm.initialStatusHint",
      "roomStatus.description",
      "roomDetail.description",
      "typeForm.createDescription",
      "daily.colEthiopian",
    ];
    for (const key of removedKeys) {
      assert.ok(!(key in en), `en must not define ${key}`);
      assert.ok(!(key in am), `am must not define ${key}`);
    }
  });

  test("keeps only the short, user-facing replacements", () => {
    assert.equal(en["assign.info"], "Operational status is shown for context.");
    assert.equal(en["newres.rateNote"], "Base nightly rate {rate} · capacity {capacity}.");
    assert.equal(en["newres.selectedStatus"], "Selected room status is shown for context.");
    assert.equal(
      en["roomForm.editDescription"],
      "Status is not changed here — use Change status."
    );
  });

  test("no removed backend-oriented sentence survives in the dictionary", () => {
    const removedCopy = [
      "Rooms are created active with a manual housekeeping status",
      "Available, Cleaning, Maintenance, or Out of service",
      "Current status: {status}",
      "Room types define capacity and the base nightly rate",
      "Room availability, overlap, and rate snapshots are validated by the Hotel service",
      "Your session is held securely",
      "Front-desk access for Hotel managers",
    ];
    const allValues = [...Object.values(en), ...Object.values(am)].join("\n");
    for (const copy of removedCopy) {
      assert.ok(!allValues.includes(copy), `dictionary still contains: ${copy}`);
    }
  });

  test("the legacy username login screen is fully removed", () => {
    assert.equal(
      existsSync(join(root, "app/components/hotel/ReceptionLogin.jsx")),
      false,
      "the obsolete username + PIN login component must not exist"
    );
  });
});

describe("Hotel Ethiopian date picker", () => {
  test("NewReservationModal uses the Ethiopian picker, not a native date input", () => {
    const source = read("app/components/hotel/NewReservationModal.jsx");
    assert.ok(!source.includes('type="date"'), "no Gregorian date input");
    assert.match(
      source,
      /import EthiopianDatePicker from "@\/app\/components\/EthiopianDatePicker"/
    );
    assert.match(source, /<EthiopianDatePicker[\s\S]*?id="reservation-arrival"/);
    assert.match(source, /<EthiopianDatePicker[\s\S]*?id="reservation-departure"/);
    assert.equal(
      (source.match(/<EthiopianDatePicker/g) || []).length,
      2,
      "arrival and departure each get one picker"
    );
    // The picker emits a Gregorian YMD string straight into the form state used
    // by the POST payload — no Ethiopian string ever reaches the API.
    assert.match(source, /onChange=\{\(ymd\) => update\("arrivalDate", ymd\)\}/);
    assert.match(source, /onChange=\{\(ymd\) => update\("departureDate", ymd\)\}/);
  });

  test("EthiopianDatePicker mirrors the POS converter conventions", () => {
    const source = read("app/components/EthiopianDatePicker.jsx");
    assert.match(source, /from '@\/lib\/ethiopianCalendar'/);
    assert.match(source, /fromEthiopian/);
    assert.match(source, /gregYMD/);
    assert.match(source, /addisYMDToUTCStart/);
    assert.match(source, /useLanguage\(\)/);
    assert.ok(
      !source.includes('type="date"'),
      "picker never falls back to a date input"
    );
    assert.ok(!source.includes("toLocaleDateString"), "no Gregorian locale labels");
    assert.ok(
      !/new Date\(\s*[A-Za-z_$][\w$]*\s*,/.test(source),
      "no browser-local new Date(y, m, d) construction"
    );
  });

  test("Hotel date labels are Ethiopian-only and no Gregorian helper remains", () => {
    for (const relativePath of hotelSources) {
      const source = read(relativePath);
      assert.ok(
        !source.includes("formatLocalDate"),
        `${relativePath} must not render Gregorian local dates`
      );
    }
    const reports = read("app/components/hotel/RoomReportsPanel.jsx");
    assert.ok(!reports.includes("daily.colEthiopian"), "redundant column removed");
    const topBar = read("app/components/hotel/HotelTopBar.jsx");
    assert.ok(!topBar.includes("formatLocalDate"), "top bar date is Ethiopian only");
  });
});

describe("Ethiopian calendar boundaries (Addis timezone)", () => {
  test("month lengths follow the EC calendar, including Pagume", () => {
    for (let month = 1; month <= 12; month += 1) {
      assert.equal(daysInEthMonth(2019, month), 30, `month ${month} is 30 days`);
    }
    assert.equal(isEthLeapYear(2019), false);
    assert.equal(daysInEthMonth(2019, 13), 5);
    assert.equal(isEthLeapYear(2020), true);
    assert.equal(daysInEthMonth(2020, 13), 6);
  });

  test("EC month boundaries convert to consecutive Gregorian days", () => {
    // 2019 EC New Year = 2026-09-11 in the Addis business calendar.
    assert.equal(gregYMD(fromEthiopian(2019, 1, 1)), "2026-09-11");
    assert.equal(gregYMD(fromEthiopian(2019, 1, 30)), "2026-10-10");
    assert.equal(gregYMD(fromEthiopian(2019, 2, 1)), "2026-10-11");
  });

  test("EC year rollover and leap Pagume map without gaps or overlaps", () => {
    assert.equal(gregYMD(fromEthiopian(2019, 13, 5)), "2027-09-10");
    assert.equal(gregYMD(fromEthiopian(2020, 1, 1)), "2027-09-11");
    assert.ok(validateEthiopianDate(2020, 13, 6), "leap Pagume 6 is valid");
    assert.equal(gregYMD(fromEthiopian(2020, 13, 6)), "2028-09-10");
    assert.equal(gregYMD(fromEthiopian(2021, 1, 1)), "2028-09-11");
    assert.equal(validateEthiopianDate(2019, 13, 6), null, "non-leap Pagume 6 rejected");
  });

  test("Addis conversion ignores the browser timezone", () => {
    const start = addisYMDToUTCStart("2026-09-11");
    // Addis is UTC+3, so civil midnight is 21:00Z the previous day — never the
    // process-local offset.
    assert.equal(start.toISOString(), "2026-09-10T21:00:00.000Z");
    assert.deepEqual(toEthiopian(start), { year: 2019, month: 1, day: 1 });

    // A UTC instant inside the same Addis day still resolves to that business day.
    assert.deepEqual(toEthiopian(new Date("2026-09-11T00:00:00Z")), {
      year: 2019,
      month: 1,
      day: 1,
    });
    // getAddisYMD reads the Addis wall date, not the local one.
    assert.equal(getAddisYMD(new Date("2026-09-10T21:30:00Z")), "2026-09-11");
  });

  test("around midnight, a reservation stays on the correct EC day", () => {
    const beforeMidnight = addisYMDToUTCStart("2026-10-10");
    const atNextMidnight = addisYMDToUTCStart("2026-10-11");
    assert.deepEqual(toEthiopian(beforeMidnight), { year: 2019, month: 1, day: 30 });
    assert.deepEqual(toEthiopian(atNextMidnight), { year: 2019, month: 2, day: 1 });
    // 20:59Z is still 2026-10-10 in Addis; 21:00Z flips to 2026-10-11.
    assert.equal(getAddisYMD(new Date("2026-10-10T20:59:00Z")), "2026-10-10");
    assert.equal(getAddisYMD(new Date("2026-10-10T21:00:00Z")), "2026-10-11");
  });

  test("selected ranges stay Gregorian YYYY-MM-DD and ordered", () => {
    const arrival = gregYMD(fromEthiopian(2019, 1, 30));
    const departure = gregYMD(fromEthiopian(2019, 2, 1));
    assert.match(arrival, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(departure, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(arrival < departure, "departure must sort after arrival");
    assert.equal(arrival, "2026-10-10");
    assert.equal(departure, "2026-10-11");
  });

  test("cross-year ranges keep consecutive Gregorian days", () => {
    const start = gregYMD(fromEthiopian(2019, 13, 4));
    const end = gregYMD(fromEthiopian(2020, 1, 2));
    assert.equal(start, "2027-09-09");
    assert.equal(end, "2027-09-12");
    assert.ok(start < end);
  });
});
