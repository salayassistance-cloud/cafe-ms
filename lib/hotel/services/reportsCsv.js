// Hotel-only report CSV rendering.
//
// Pure formatting over the exact object returned by
// `buildHotelReportsSummary` — the same aggregation service powers the JSON
// summary and this export, so exported values reconcile with the on-screen
// report by construction.
//
// Deliberately platform-native: RFC-4180 quoting, one UTF-8 BOM prepended by
// the HTTP handler, CRLF record separators, and a formula-injection guard
// (spreadsheets execute cells beginning with `=`, `+`, `-`, `@`, tab, or CR).
// No CSV/XLSX dependency exists in this project and none is introduced.
//
// Money is rendered in major ETB units from the exact integer minor values.
// Numbers stay ungrouped so Excel recognises them as numbers. Unknown metrics
// render as `N/A`, never as 0.

import { fromHotelMinorUnits } from "../money.js";
import { formatEthiopianDate } from "../../ethiopianCalendar.js";

const FORMULA_PREFIXES = new Set(["=", "+", "-", "@", "\t", "\r"]);

const ROOM_STATUS_LABELS = Object.freeze({
  AVAILABLE: "Available rooms",
  OCCUPIED: "Occupied rooms",
  RESERVED: "Reserved rooms",
  CLEANING: "Rooms being cleaned",
  MAINTENANCE: "Rooms under maintenance",
  OUT_OF_SERVICE: "Out-of-service rooms",
});

const PAYMENT_METHOD_LABELS = Object.freeze({
  CASH: "Cash",
  CARD: "Card",
  BANK_TRANSFER: "Bank transfer",
});

// Stable, user-facing column contract. Tests assert this exact order.
export const HOTEL_REPORT_CSV_DAILY_HEADERS = Object.freeze([
  "Date",
  "Ethiopian date",
  "Occupied room-nights",
  "Available room-nights",
  "Occupancy rate (%)",
  "Payments collected (ETB)",
  "Voided payments (ETB)",
  "Posted room charges (ETB)",
  "Scheduled arrivals",
  "No-show arrivals",
  "Check-ins",
  "Departures due",
  "Check-outs",
]);

export const HOTEL_REPORT_CSV_SUMMARY_HEADERS = Object.freeze([
  "Metric",
  "Value",
]);

function humanizeToken(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

// Spreadsheet cells must never begin with a formula trigger. Text newlines are
// normalised to CRLF so the whole file keeps one record separator convention.
export function escapeHotelCsvCell(value) {
  let text = value === null || value === undefined ? "" : `${value}`;
  text = text.replace(/\r\n|\r|\n/g, "\r\n");
  if (text.length > 0 && FORMULA_PREFIXES.has(text[0])) {
    text = `'${text}`;
  }
  if (
    text.includes('"') ||
    text.includes(",") ||
    text.includes("\n") ||
    text.includes("\r")
  ) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function textCell(value) {
  return value === null || value === undefined ? "" : `${value}`;
}

function moneyCell(minor) {
  if (minor === null || minor === undefined || !Number.isSafeInteger(minor)) {
    return "N/A";
  }
  return fromHotelMinorUnits(minor).toFixed(2);
}

function countCell(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "N/A";
  }
  return String(Number(value));
}

function pctCell(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "N/A";
  }
  return Number(value).toFixed(1);
}

function renderRow(cells) {
  return cells.map((cell) => escapeHotelCsvCell(cell)).join(",");
}

function renderSummaryRows(result) {
  const totals = result.totals;
  return [
    ["Occupied room-nights", countCell(totals.occupiedRoomNights)],
    ["Available room-nights", countCell(totals.availableRoomNights)],
    ["Occupancy rate (%)", pctCell(totals.occupancyRatePct)],
    ["Payments collected (ETB)", moneyCell(totals.paymentsRecordedMinor)],
    ["Payments collected (count)", countCell(totals.paymentsRecordedCount)],
    ["Voided payments (ETB)", moneyCell(totals.paymentsVoidedMinor)],
    ["Voided payments (count)", countCell(totals.paymentsVoidedCount)],
    ["Posted room charges (ETB)", moneyCell(totals.postedRoomChargesMinor)],
    ["Outstanding balance (ETB)", moneyCell(totals.outstandingMinor)],
    ["ADR (ETB)", moneyCell(totals.adrMinor)],
    ["RevPAR (ETB)", moneyCell(totals.revparMinor)],
    ["Scheduled arrivals", countCell(totals.scheduledArrivals)],
    ["No-show arrivals", countCell(totals.noShowArrivals)],
    ["Check-ins", countCell(totals.checkIns)],
    ["Departures due", countCell(totals.departuresDue)],
    ["Check-outs", countCell(totals.checkOuts)],
  ];
}

function renderDailyRows(result) {
  return result.days.map((day) => {
    const startInstant = new Date(`${day.date}T00:00:00.000+03:00`);
    return [
      day.date,
      formatEthiopianDate(startInstant, "en"),
      countCell(day.occupiedRoomNights),
      countCell(day.availableRoomNights),
      pctCell(day.occupancyRatePct),
      moneyCell(day.paymentsRecordedMinor),
      moneyCell(day.paymentsVoidedMinor),
      moneyCell(day.postedRoomChargesMinor),
      countCell(day.scheduledArrivals),
      countCell(day.noShowArrivals),
      countCell(day.checkIns),
      countCell(day.departuresDue),
      countCell(day.checkOuts),
    ];
  });
}

function renderInventoryRows(result) {
  const inventory = result.inventory ?? {};
  const rows = [
    ["Total rooms", countCell(inventory.roomsTotal)],
    ["Active rooms", countCell(inventory.roomsActive)],
    ["Inactive rooms", countCell(inventory.roomsInactive)],
  ];
  for (const [status, count] of Object.entries(
    inventory.roomsByOperationalStatus ?? {}
  )) {
    rows.push([
      ROOM_STATUS_LABELS[status] || humanizeToken(status),
      countCell(count),
    ]);
  }
  rows.push(["Room types total", countCell(inventory.roomTypesTotal)]);
  rows.push(["Active room types", countCell(inventory.roomTypesActive)]);
  return rows;
}

function renderMethodRows(result) {
  const entries = Object.entries(result.methodBreakdown ?? {});
  if (entries.length === 0) {
    return [["No recorded payments in this period", ""]];
  }
  return entries.map(([method, minor]) => [
    PAYMENT_METHOD_LABELS[method] || humanizeToken(method),
    moneyCell(minor),
  ]);
}

export function renderHotelReportsSummaryCsv(result) {
  const lines = [];
  const coverage = result.denominatorCoverage ?? {};

  lines.push(renderRow(["Bono Hotel Room Performance Report"]));
  lines.push(
    renderRow(["Report period", `${result.range.from} to ${result.range.to}`])
  );
  lines.push(renderRow(["Timezone", "Africa/Addis_Ababa"]));
  lines.push(renderRow(["Currency", "ETB"]));
  lines.push(renderRow(["Payments basis", "Recorded date"]));
  lines.push(renderRow(["Voids basis", "Void date"]));
  lines.push(renderRow(["Charges basis", "Checkout date"]));

  lines.push("");
  lines.push(renderRow(["Summary"]));
  lines.push(renderRow([...HOTEL_REPORT_CSV_SUMMARY_HEADERS]));
  for (const [label, value] of renderSummaryRows(result)) {
    lines.push(renderRow([label, value]));
  }

  lines.push("");
  lines.push(renderRow(["Daily detail"]));
  lines.push(renderRow([...HOTEL_REPORT_CSV_DAILY_HEADERS]));
  for (const cells of renderDailyRows(result)) {
    lines.push(renderRow(cells));
  }

  lines.push("");
  lines.push(renderRow(["Live room inventory"]));
  lines.push(renderRow([...HOTEL_REPORT_CSV_SUMMARY_HEADERS]));
  for (const [label, value] of renderInventoryRows(result)) {
    lines.push(renderRow([label, value]));
  }

  lines.push("");
  lines.push(renderRow(["Payments collected by method (ETB)"]));
  lines.push(renderRow(["Method", "Amount (ETB)"]));
  for (const [label, value] of renderMethodRows(result)) {
    lines.push(renderRow([label, value]));
  }

  lines.push("");
  lines.push(renderRow(["Data coverage"]));
  lines.push(
    renderRow([
      "Complete occupancy history",
      coverage.fullyCovered ? "Yes" : "No",
    ])
  );
  if (!coverage.fullyCovered) {
    lines.push(
      renderRow([
        "Dates without complete occupancy history",
        textCell((coverage.uncoveredDates ?? []).join("; ")),
      ])
    );
  }

  // RFC 4180 record separator and a terminating CRLF.
  return `${lines.join("\r\n")}\r\n`;
}
