// Hotel-only report PDF rendering.
//
// Pure presentation over the exact object returned by
// `buildHotelReportsSummary` — the same aggregation service powers the JSON
// summary and both exports, so the PDF reconciles with the on-screen report and
// CSV by construction. No metric is recalculated here.
//
// The document is deliberately monochrome, A4 portrait, table-driven, and
// print-friendly. PDFKit's own text measurement and layout primitives are used
// for wrapping and pagination; no table plugin or HTML renderer is involved.

import PDFDocument from "pdfkit";

import { formatEthiopianDate } from "../../ethiopianCalendar.js";

export const HOTEL_REPORT_PDF_PAGE = Object.freeze({
  width: 595.28,
  height: 841.89,
  margin: 48,
});

const CONTENT_WIDTH =
  HOTEL_REPORT_PDF_PAGE.width - HOTEL_REPORT_PDF_PAGE.margin * 2;

// Footer strip is reserved so table rows never collide with page numbers.
const CONTENT_BOTTOM = HOTEL_REPORT_PDF_PAGE.height - 64;

const FONT_BODY = "Helvetica";
const FONT_BOLD = "Helvetica-Bold";
const FONT_ITALIC = "Helvetica-Oblique";

const INK = "#000000";
const MUTED = "#444444";
const RULE = "#000000";
const HAIRLINE = "#999999";

const COUNT_FORMAT = new Intl.NumberFormat("en-US");
const MONEY_FORMAT = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

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

export const HOTEL_REPORT_PDF_DAILY_HEADINGS = Object.freeze([
  "Date / Ethiopian date",
  "Occupied",
  "Available",
  "Occ. %",
  "Payments (ETB)",
  "Voids (ETB)",
  "Charges (ETB)",
  "Arrivals",
  "No-shows",
  "Check-ins",
  "Departures",
  "Check-outs",
]);

export const HOTEL_REPORT_PDF_SUMMARY_HEADINGS = Object.freeze([
  "Metric",
  "Value",
]);

export const HOTEL_REPORT_PDF_INVENTORY_HEADINGS = Object.freeze([
  "Inventory item",
  "Count",
]);

export const HOTEL_REPORT_PDF_METHOD_HEADINGS = Object.freeze([
  "Payment method",
  "Amount (ETB)",
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

function countText(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "N/A";
  }
  return COUNT_FORMAT.format(Number(value));
}

function moneyText(minor) {
  if (minor === null || minor === undefined || !Number.isSafeInteger(minor)) {
    return "N/A";
  }
  return MONEY_FORMAT.format(minor / 100);
}

function pctText(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "N/A";
  }
  return `${Number(value).toFixed(1)}%`;
}

function ethiopianShort(ymd) {
  const instant = new Date(`${ymd}T00:00:00.000+03:00`);
  const formatted = formatEthiopianDate(instant, "en");
  return formatted.replace(/\s*E\.C\.$/i, "");
}

function addisTimestamp(instant) {
  try {
    const formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Africa/Addis_Ababa",
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    return formatter.format(new Date(instant));
  } catch {
    return "N/A";
  }
}

function ensureSpace(doc, state, height) {
  if (state.y + height <= CONTENT_BOTTOM) return;
  doc.addPage();
  state.y = HOTEL_REPORT_PDF_PAGE.margin;
}

function horizontalRule(doc, y, { color = RULE, width = 0.5 } = {}) {
  doc
    .moveTo(HOTEL_REPORT_PDF_PAGE.margin, y)
    .lineTo(HOTEL_REPORT_PDF_PAGE.width - HOTEL_REPORT_PDF_PAGE.margin, y)
    .lineWidth(width)
    .strokeColor(color)
    .stroke();
}

function drawParagraph(
  doc,
  state,
  text,
  { size = 9, font = FONT_BODY, color = MUTED, width = CONTENT_WIDTH, gap = 6 } = {}
) {
  doc.font(font).fontSize(size).fillColor(color);
  const height = doc.heightOfString(text, { width, lineGap: 1.5 });
  ensureSpace(doc, state, height);
  doc.text(text, HOTEL_REPORT_PDF_PAGE.margin, state.y, {
    width,
    lineGap: 1.5,
  });
  state.y += height + gap;
}

function drawSectionTitle(doc, state, title, reserve = 30) {
  ensureSpace(doc, state, 20 + reserve);
  doc.font(FONT_BOLD).fontSize(12).fillColor(INK);
  doc.text(title, HOTEL_REPORT_PDF_PAGE.margin, state.y);
  state.y += 16;
  horizontalRule(doc, state.y, { width: 0.8 });
  state.y += 8;
}

function drawTable(
  doc,
  state,
  columns,
  rows,
  {
    fontSize = 8,
    headerFontSize = 7,
    paddingX = 3,
    paddingY = 3,
    emptyText = null,
  } = {}
) {
  const left = HOTEL_REPORT_PDF_PAGE.margin;
  const tableWidth = columns.reduce((sum, column) => sum + column.width, 0);

  const measureRow = (cells, font, size) => {
    doc.font(font).fontSize(size);
    let height = 0;
    for (let index = 0; index < columns.length; index += 1) {
      const text = cells[index] === null || cells[index] === undefined
        ? ""
        : `${cells[index]}`;
      const cellHeight = doc.heightOfString(text, {
        width: columns[index].width - paddingX * 2,
        align: columns[index].align,
        lineGap: 1,
      });
      if (cellHeight > height) height = cellHeight;
    }
    return Math.max(height, size + 2) + paddingY * 2;
  };

  const drawHeader = () => {
    const headerHeight = measureRow(
      columns.map((column) => column.label),
      FONT_BOLD,
      headerFontSize
    );
    if (state.y + headerHeight > CONTENT_BOTTOM) {
      doc.addPage();
      state.y = HOTEL_REPORT_PDF_PAGE.margin;
    }
    let x = left;
    doc.font(FONT_BOLD).fontSize(headerFontSize).fillColor(INK);
    for (const column of columns) {
      doc.text(column.label, x + paddingX, state.y + paddingY, {
        width: column.width - paddingX * 2,
        align: column.align,
        lineGap: 1,
      });
      x += column.width;
    }
    state.y += headerHeight;
    doc
      .moveTo(left, state.y)
      .lineTo(left + tableWidth, state.y)
      .lineWidth(0.7)
      .strokeColor(RULE)
      .stroke();
  };

  drawHeader();

  if (rows.length === 0) {
    drawParagraph(doc, state, emptyText || "No data available.", {
      size: fontSize,
      gap: 8,
    });
    return;
  }

  for (const row of rows) {
    const cells = row.map((cell) =>
      cell === null || cell === undefined ? "" : `${cell}`
    );
    const rowHeight = measureRow(cells, FONT_BODY, fontSize);
    if (state.y + rowHeight > CONTENT_BOTTOM) {
      doc.addPage();
      state.y = HOTEL_REPORT_PDF_PAGE.margin;
      drawHeader();
    }
    let x = left;
    doc.font(FONT_BODY).fontSize(fontSize).fillColor(INK);
    for (let index = 0; index < columns.length; index += 1) {
      doc.text(cells[index], x + paddingX, state.y + paddingY, {
        width: columns[index].width - paddingX * 2,
        align: columns[index].align,
        lineGap: 1,
      });
      x += columns[index].width;
    }
    state.y += rowHeight;
    doc
      .moveTo(left, state.y)
      .lineTo(left + tableWidth, state.y)
      .lineWidth(0.25)
      .strokeColor(HAIRLINE)
      .stroke();
  }

  state.y += 10;
}

function summaryRows(result) {
  const totals = result.totals ?? {};
  return [
    ["Occupied room-nights", countText(totals.occupiedRoomNights)],
    ["Available room-nights", countText(totals.availableRoomNights)],
    ["Occupancy rate", pctText(totals.occupancyRatePct)],
    ["Payments collected (ETB)", moneyText(totals.paymentsRecordedMinor)],
    ["Payments collected (count)", countText(totals.paymentsRecordedCount)],
    ["Voided payments (ETB)", moneyText(totals.paymentsVoidedMinor)],
    ["Voided payments (count)", countText(totals.paymentsVoidedCount)],
    ["Posted room charges (ETB)", moneyText(totals.postedRoomChargesMinor)],
    ["Outstanding balance (ETB)", moneyText(totals.outstandingMinor)],
    ["ADR (ETB)", moneyText(totals.adrMinor)],
    ["RevPAR (ETB)", moneyText(totals.revparMinor)],
    ["Scheduled arrivals", countText(totals.scheduledArrivals)],
    ["No-show arrivals", countText(totals.noShowArrivals)],
    ["Check-ins", countText(totals.checkIns)],
    ["Departures due", countText(totals.departuresDue)],
    ["Check-outs", countText(totals.checkOuts)],
  ];
}

function dailyRows(result) {
  return (result.days ?? []).map((day) => [
    `${day.date}\n${ethiopianShort(day.date)}`,
    countText(day.occupiedRoomNights),
    countText(day.availableRoomNights),
    pctText(day.occupancyRatePct),
    moneyText(day.paymentsRecordedMinor),
    moneyText(day.paymentsVoidedMinor),
    moneyText(day.postedRoomChargesMinor),
    countText(day.scheduledArrivals),
    countText(day.noShowArrivals),
    countText(day.checkIns),
    countText(day.departuresDue),
    countText(day.checkOuts),
  ]);
}

function inventoryRows(result) {
  const inventory = result.inventory ?? {};
  const rows = [
    ["Total rooms", countText(inventory.roomsTotal)],
    ["Active rooms", countText(inventory.roomsActive)],
    ["Inactive rooms", countText(inventory.roomsInactive)],
  ];
  for (const [status, count] of Object.entries(
    inventory.roomsByOperationalStatus ?? {}
  )) {
    rows.push([
      ROOM_STATUS_LABELS[status] || humanizeToken(status),
      countText(count),
    ]);
  }
  rows.push(["Room types total", countText(inventory.roomTypesTotal)]);
  rows.push(["Active room types", countText(inventory.roomTypesActive)]);
  return rows;
}

function methodRows(result) {
  return Object.entries(result.methodBreakdown ?? {}).map(([method, minor]) => [
    PAYMENT_METHOD_LABELS[method] || humanizeToken(method),
    moneyText(minor),
  ]);
}

function coverageText(result) {
  const coverage = result.denominatorCoverage ?? {};
  const uncovered = Array.isArray(coverage.uncoveredDates)
    ? coverage.uncoveredDates
    : [];
  if (coverage.fullyCovered) {
    return "Room status history covers every day in the selected period. Occupancy, occupancy rate, and RevPAR denominators are complete.";
  }
  const first = uncovered[0];
  const extra = uncovered.length > 1 ? ` (starting ${first})` : first ? ` (${first})` : "";
  return `Room status history does not cover ${countText(
    uncovered.length
  )} day(s) in the selected period${extra}. Occupancy denominators, occupancy rate, and RevPAR are shown as N/A for the affected days rather than a guessed value. Payment and activity totals are unaffected.`;
}

const METRIC_NOTES = Object.freeze([
  [
    "Occupancy rate",
    "Occupied room-nights divided by available room-nights, times 100. N/A when the denominator is unknown or zero.",
  ],
  [
    "Payments collected",
    "RECORDED payments grouped by recorded date. Not an accounting revenue figure.",
  ],
  [
    "Voided payments",
    "VOIDED payments grouped by void date. Never netted into collected payments.",
  ],
  [
    "Posted room charges",
    "Finalized checkout charges grouped by checkout date.",
  ],
  [
    "Outstanding balance",
    "Finalized charges for stays checked out in the period minus all-time recorded payments. N/A when any such checkout is not finalized.",
  ],
  [
    "ADR",
    "Posted room charges divided by occupied room-nights. N/A when occupied room-nights is zero.",
  ],
  [
    "RevPAR",
    "Posted room charges divided by available room-nights. N/A when coverage is incomplete or the denominator is zero.",
  ],
]);

function drawCover(doc, state, result, generatedAt) {
  const range = result.range ?? {};
  const dayCount = Number(range.dayCount ?? (result.days ?? []).length);

  doc.font(FONT_BOLD).fontSize(20).fillColor(INK);
  doc.text("Bono Hotel", HOTEL_REPORT_PDF_PAGE.margin, state.y);
  state.y += 24;

  doc.font(FONT_BOLD).fontSize(14).fillColor(INK);
  doc.text("Room Performance Report", HOTEL_REPORT_PDF_PAGE.margin, state.y);
  state.y += 22;

  horizontalRule(doc, state.y, { width: 1 });
  state.y += 10;

  const meta = [
    ["Report period", `${range.from} to ${range.to} (${countText(dayCount)} day(s))`],
    ["Generated", `${addisTimestamp(generatedAt)} (Africa/Addis_Ababa)`],
    ["Currency", "ETB"],
  ];
  for (const [label, value] of meta) {
    doc.font(FONT_BODY).fontSize(9).fillColor(MUTED);
    doc.text(`${label}: ${value}`, HOTEL_REPORT_PDF_PAGE.margin, state.y, {
      width: CONTENT_WIDTH,
    });
    state.y += 13;
  }

  state.y += 6;
  drawParagraph(
    doc,
    state,
    "Prepared for hotel management. All figures cover the selected Africa/Addis_Ababa civil-date window with half-open days. Payments collected are net recorded payments by recorded date and are not an accounting revenue figure. Posted room charges are finalized checkout charges by checkout date. Values that cannot be established from stored records are shown as N/A rather than zero.",
    { size: 9, color: MUTED, gap: 12 }
  );
}

function drawFooter(doc, result) {
  const range = result.range ?? {};
  const buffered = doc.bufferedPageRange();
  for (let index = 0; index < buffered.count; index += 1) {
    doc.switchToPage(buffered.start + index);
    const previousBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;

    const footerY = HOTEL_REPORT_PDF_PAGE.height - 34;
    horizontalRule(doc, footerY - 8, { color: HAIRLINE, width: 0.35 });
    doc.font(FONT_BODY).fontSize(7.5).fillColor(MUTED);
    doc.text(
      `Bono Hotel · Room Performance Report · ${range.from} to ${range.to}`,
      HOTEL_REPORT_PDF_PAGE.margin,
      footerY,
      { width: CONTENT_WIDTH - 92, lineBreak: false }
    );
    doc.text(
      `Page ${index + 1} of ${buffered.count}`,
      HOTEL_REPORT_PDF_PAGE.width - HOTEL_REPORT_PDF_PAGE.margin - 88,
      footerY,
      { width: 88, align: "right", lineBreak: false }
    );

    doc.page.margins.bottom = previousBottom;
  }
}

function drawDocument(doc, result, { generatedAt }) {
  const state = { y: HOTEL_REPORT_PDF_PAGE.margin };

  drawCover(doc, state, result, generatedAt);

  drawSectionTitle(doc, state, "Summary", 60);
  drawTable(
    doc,
    state,
    [
      { label: HOTEL_REPORT_PDF_SUMMARY_HEADINGS[0], width: 310, align: "left" },
      { label: HOTEL_REPORT_PDF_SUMMARY_HEADINGS[1], width: CONTENT_WIDTH - 310, align: "right" },
    ],
    summaryRows(result),
    { fontSize: 8.5, headerFontSize: 7.5 }
  );

  drawSectionTitle(doc, state, "Daily detail", 70);
  drawTable(
    doc,
    state,
    [
      { label: HOTEL_REPORT_PDF_DAILY_HEADINGS[0], width: 76, align: "left" },
      { label: HOTEL_REPORT_PDF_DAILY_HEADINGS[1], width: 38, align: "right" },
      { label: HOTEL_REPORT_PDF_DAILY_HEADINGS[2], width: 38, align: "right" },
      { label: HOTEL_REPORT_PDF_DAILY_HEADINGS[3], width: 34, align: "right" },
      { label: HOTEL_REPORT_PDF_DAILY_HEADINGS[4], width: 45, align: "right" },
      { label: HOTEL_REPORT_PDF_DAILY_HEADINGS[5], width: 42, align: "right" },
      { label: HOTEL_REPORT_PDF_DAILY_HEADINGS[6], width: 45, align: "right" },
      { label: HOTEL_REPORT_PDF_DAILY_HEADINGS[7], width: 34, align: "right" },
      { label: HOTEL_REPORT_PDF_DAILY_HEADINGS[8], width: 36, align: "right" },
      { label: HOTEL_REPORT_PDF_DAILY_HEADINGS[9], width: 34, align: "right" },
      { label: HOTEL_REPORT_PDF_DAILY_HEADINGS[10], width: 42, align: "right" },
      { label: HOTEL_REPORT_PDF_DAILY_HEADINGS[11], width: 35, align: "right" },
    ],
    dailyRows(result),
    { fontSize: 7.5, headerFontSize: 6.8, paddingX: 2.5, paddingY: 2.5 }
  );

  drawSectionTitle(doc, state, "Live room inventory", 60);
  drawTable(
    doc,
    state,
    [
      { label: HOTEL_REPORT_PDF_INVENTORY_HEADINGS[0], width: 330, align: "left" },
      { label: HOTEL_REPORT_PDF_INVENTORY_HEADINGS[1], width: CONTENT_WIDTH - 330, align: "right" },
    ],
    inventoryRows(result),
    { fontSize: 8.5, headerFontSize: 7.5 }
  );
  drawParagraph(
    doc,
    state,
    "Live snapshot read from current room records; not a historical metric.",
    { size: 8, font: FONT_ITALIC, color: MUTED, gap: 10 }
  );

  drawSectionTitle(doc, state, "Payments collected by method", 60);
  const methods = methodRows(result);
  if (methods.length === 0) {
    drawParagraph(doc, state, "No recorded payments in this period.", {
      size: 8.5,
      color: MUTED,
      gap: 10,
    });
  } else {
    drawTable(
      doc,
      state,
      [
        { label: HOTEL_REPORT_PDF_METHOD_HEADINGS[0], width: 330, align: "left" },
        { label: HOTEL_REPORT_PDF_METHOD_HEADINGS[1], width: CONTENT_WIDTH - 330, align: "right" },
      ],
      methods,
      { fontSize: 8.5, headerFontSize: 7.5 }
    );
  }

  drawSectionTitle(doc, state, "Data coverage", 40);
  drawParagraph(doc, state, coverageText(result), {
    size: 9,
    color: MUTED,
    gap: 10,
  });

  drawSectionTitle(doc, state, "Metric notes", 60);
  drawTable(
    doc,
    state,
    [
      { label: "Metric", width: 150, align: "left" },
      { label: "Definition", width: CONTENT_WIDTH - 150, align: "left" },
    ],
    METRIC_NOTES,
    { fontSize: 8, headerFontSize: 7.5 }
  );

  drawFooter(doc, result);
}

export function createHotelReportsSummaryPdf(
  result,
  { generatedAt = Date.now(), compress = true } = {}
) {
  const range = result.range ?? {};
  const doc = new PDFDocument({
    size: "A4",
    layout: "portrait",
    margin: HOTEL_REPORT_PDF_PAGE.margin,
    bufferPages: true,
    compress,
    info: {
      Title: `Bono Hotel Room Performance Report ${range.from ?? ""} to ${range.to ?? ""}`,
      Subject: "Hotel room performance, payment, and inventory report",
      Author: "Bono Hotel",
      Creator: "Bono Hotel Reporting",
    },
  });

  drawDocument(doc, result, { generatedAt });
  return doc;
}

export function renderHotelReportsSummaryPdf(result, options = {}) {
  const doc = createHotelReportsSummaryPdf(result, options);
  const chunks = [];
  return new Promise((resolve, reject) => {
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.end();
  });
}
