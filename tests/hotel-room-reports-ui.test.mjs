// Room Reports UI contract tests — DB-free and DOM-free.
//
// The components are checked at the source level: no browser, Mongo connection,
// module execution, external request, or POS auth component is involved. These
// tests protect the reporting scope: the approved windowed summary endpoint and
// its CSV export plus the existing bounded read endpoints only, no fabricated
// report data, no inferred-money relabelling, and no credential/token storage.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => readFileSync(join(root, relativePath), "utf8");

const pageSource = read("app/hotel/reports/page.js");
const shellSource = read("app/components/hotel/RoomReportsUI.jsx");
const panelSource = read("app/components/hotel/RoomReportsPanel.jsx");
const requestHookSource = read("app/components/hotel/useHotelRequest.js");
const inventorySource = read("app/components/hotel/RoomInventoryReport.jsx");
const apiSource = read("app/components/hotel/hotelApi.js");

const dataSources = [panelSource, inventorySource];
const allSources = [pageSource, shellSource, panelSource, inventorySource];

describe("Room Reports route", () => {
  test("is a Hotel-only dynamic route rendering the Reports UI outside the POS guard", () => {
    assert.match(pageSource, /export const dynamic = "force-dynamic"/);
    assert.match(
      pageSource,
      /import RoomReportsUI from "@\/app\/components\/hotel\/RoomReportsUI"/
    );
    assert.match(pageSource, /<RoomReportsUI \/>/);
    for (const forbidden of [
      "PinGuard",
      "PinLoginModal",
      "PinKeypad",
      "getPortalSession",
    ]) {
      assert.ok(!pageSource.includes(forbidden), `route must not use ${forbidden}`);
    }
  });

  test("has Hotel Report metadata", () => {
    assert.match(pageSource, /title: "Hotel Reports"/);
    assert.ok(!pageSource.includes("Bono Hotel"));
    assert.ok(shellSource.includes("ManagerSidebar"));
  });
});

describe("Room Reports auth shell", () => {
  test("reuses the layout PIN gate and the shared verified-session request wrapper", () => {
    assert.match(shellSource, /import \{ useHotelRequest \} from "\.\/useHotelRequest"/);
    assert.match(shellSource, /const request = useHotelRequest\(\)/);
    assert.ok(!shellSource.includes("/api/hotel/auth/me"));
    assert.ok(!shellSource.includes("ReceptionLogin"));
    assert.match(shellSource, /import ManagerSidebar from "@\/app\/components\/ManagerSidebar"/);
    assert.ok(!shellSource.includes("Sign out"), "the shared Hotel bar has no visible sign-out");
    assert.ok(!shellSource.includes("localStorage"));
    assert.ok(!shellSource.includes("sessionStorage"));
  });

  test("holds the CSRF token only in memory and forwards it through hotelRequest", () => {
    assert.match(requestHookSource, /useHotelSession\(\)/);
    assert.match(requestHookSource, /csrfToken: session\?\.csrfToken \|\| null/);
    assert.ok(
      !requestHookSource.includes("HOTEL_CSRF_HEADER"),
      "header handling stays inside hotelApi"
    );
  });

  test("restricts report data and panels to Manager sessions", () => {
    assert.match(shellSource, /const canReadReports = role === "MANAGER"/);
    assert.match(shellSource, /canReadReports \?/);
    assert.match(shellSource, /t\("reports\.managerOnlyTitle"\)/);
    assert.match(shellSource, /<RoomReportsPanel/);
  });
});

describe("Room Reports API mapping", () => {
  test("derives all report metrics from the approved summary endpoint", () => {
    assert.match(panelSource, /hotelUrl\("\/api\/hotel\/reports\/summary", \{ from, to \}\)/);
    // No parallel metric computation layer: the JSON and CSV exports must come
    // from the same aggregation service.
    assert.match(panelSource, /\/api\/hotel\/reports\/summary\/export\?from=/);
    assert.match(panelSource, /encodeURIComponent\(\s*from\s*\)/);
    assert.match(panelSource, /encodeURIComponent\(\s*to\s*\)/);
  });

  test("uses no POS, payment-list, or analytics endpoint", () => {
    for (const source of dataSources) {
      assert.ok(!source.includes("/api/hotel/payments"));
      assert.ok(!source.includes("/api/manager"));
      assert.ok(!source.includes("/api/analytics"));
      assert.ok(!source.includes("fetch("), "requests go through hotelRequest");
    }
  });

  test("requests stay bounded and partial failures are tolerated", () => {
    assert.match(panelSource, /Promise\.allSettled/);
    // Live in-house count keeps the cheap count-only request.
    assert.match(panelSource, /limit: 1,\s*offset: 0/);
    // Detail lists stay page-bounded, never full-window unbounded loads.
    assert.match(panelSource, /limit: 8,\s*offset: 0/);
    assert.match(panelSource, /typeof result\.value\?\.total === "number"/);
  });

  test("uses only supported date filters for the window and details", () => {
    assert.match(panelSource, /hotelUrl\("\/api\/hotel\/reports\/summary", \{ from, to \}\)/);
    assert.match(panelSource, /arrivalFrom: from/);
    assert.match(panelSource, /arrivalTo: to/);
    assert.match(panelSource, /checkedInFrom: from/);
    assert.match(panelSource, /checkedInTo: to/);
    for (const unsupported of [
      "departureFrom",
      "departureTo",
      "checkedOutFrom",
      "checkedOutTo",
    ]) {
      assert.ok(
        !panelSource.includes(unsupported),
        `must not offer unsupported filter ${unsupported}`
      );
    }
  });

  test("counts all six real room operational statuses and no invented status", () => {
    const block = panelSource.match(/const ROOM_STATUSES = \[([\s\S]*?)\];/i)?.[1] || "";
    for (const status of [
      "AVAILABLE",
      "OCCUPIED",
      "RESERVED",
      "CLEANING",
      "MAINTENANCE",
      "OUT_OF_SERVICE",
    ]) {
      assert.match(block, new RegExp(`"${status}"`));
    }
    assert.ok(!block.includes("BLOCKED"));
    assert.ok(!block.includes("UNKNOWN"));
  });

  test("filters the inventory only with fields the room API accepts", () => {
    assert.match(inventorySource, /params\.operationalStatus/);
    assert.match(inventorySource, /params\.roomTypeId/);
    assert.match(inventorySource, /params\.floor/);
    assert.match(inventorySource, /params\.isActive/);
    assert.match(inventorySource, /params\.limit = PAGE_SIZE/);
    assert.match(inventorySource, /params\.offset = offset/);
    assert.ok(!inventorySource.includes("params.search"));
    assert.ok(!inventorySource.includes("arrivalFrom"));
    assert.match(
      inventorySource,
      /hotelUrl\("\/api\/hotel\/room-types", \{ limit: 100, offset: 0 \}\)/
    );
  });
});

describe("Room Reports manager-facing copy", () => {
  test("does not render backend, API, or implementation explanations", () => {
    const removedCopy = [
      "Live room status and activity from the existing Hotel read APIs.",
      "Current room status is not historical occupancy.",
      "Every metric covers the same Addis-Ababa civil-date window with half-open",
      "Select dates in the Ethiopian calendar. The API receives Hotel-local",
      "Payments collected are net recorded payments by payment recorded",
      "The same per-date series shown above, one row per Addis-Ababa civil date.",
      "Active rooms only, counted separately for each operational status returned by the report API.",
      "Africa/Addis_Ababa",
      "RECORDED payments grouped by recorded date",
      "VOIDED payments grouped by void date",
      "isActive = true",
      "isActive = false",
      "Arrival counts are confirmed reservations, not occupied rooms.",
      "Check-in counts are recorded stays",
      "Insufficient room status history: occupancy denominators",
      "room API",
      "reports endpoint",
      "report API",
      "Hotel-local",
      "civil date",
      "Metric definitions",
      "report.definitions",
    ];
    for (const source of [shellSource, panelSource, inventorySource]) {
      for (const text of removedCopy) {
        assert.ok(!source.includes(text), `must not render: ${text}`);
      }
    }
  });

  test("keeps short business labels and useful data warnings", () => {
    assert.match(shellSource, /titleKey="reports\.title"/);
    assert.match(panelSource, /t\("reports\.reportDates"\)/);
    assert.match(panelSource, /t\("reports\.reportTotals"\)/);
    assert.match(panelSource, /t\("reports\.dailyTitle"\)/);
    assert.match(panelSource, /t\("reports\.liveSnapshot"\)/);
    assert.match(panelSource, /t\("reports\.currentStatus"\)/);
    assert.match(panelSource, /t\("reports\.coverageGap"/);
    assert.match(panelSource, /t\("reports\.roomTypesSummary"/);
  });

  test("renders collected money only as labelled payments, never as revenue", () => {
    assert.match(panelSource, /t\("reports\.paymentsCollected"\)/);
    assert.match(panelSource, /t\("reports\.paymentsVoided"\)/);
    assert.match(panelSource, /t\("reports\.postedCharges"\)/);
  });

  test("shows unknown occupancy as an explicit gap, never a fabricated zero", () => {
    assert.match(panelSource, /formatPct/);
    // Null-safe formatters return an em dash rather than 0 or NaN.
    assert.match(panelSource, /return "—"/);
    assert.match(panelSource, /t\("reports\.coverageGap"/);
  });

  test("keeps ADR and RevPAR visible from the API", () => {
    assert.match(panelSource, /t\("reports\.adr"\)/);
    assert.match(panelSource, /t\("reports\.revpar"\)/);
  });

  test("uses no mock, sample, or random chart series", () => {
    for (const source of dataSources) {
      assert.ok(!/Math\.random/.test(source));
      assert.ok(!/const\s+(SAMPLE|MOCK|FAKE)_/i.test(source));
      assert.ok(!source.includes('from "recharts"'));
    }
    assert.match(panelSource, /statuses\.map\(\(\{ status, total \}\)/);
    assert.match(panelSource, /style=\{\{ width: `\$\{width\}%` \}\}/);
  });

  test("offers CSV and PDF downloads from the same selected range", () => {
    assert.match(panelSource, /t\("reports\.exportCsv"\)/);
    assert.match(panelSource, /t\("reports\.downloadPdf"\)/);
    assert.match(panelSource, /\/api\/hotel\/reports\/summary\/export/);
    assert.match(panelSource, /\/api\/hotel\/reports\/summary\/export\/pdf/);
    assert.match(
      panelSource,
      /hotelUrl\("\/api\/hotel\/reports\/summary\/export\/pdf", \{ from, to \}\)/
    );
    assert.match(panelSource, /href=\{exportHref\}/);
  });
});

describe("Room Reports PDF download", () => {
  test("shows a PDF action with loading and error states", () => {
    assert.match(panelSource, /pdfBusy/);
    assert.match(panelSource, /setPdfBusy\(true\)/);
    assert.match(panelSource, /setPdfBusy\(false\)/);
    assert.match(panelSource, /disabled=\{pdfBusy \|\| loading\}/);
    assert.match(panelSource, /aria-busy=\{pdfBusy\}/);
    assert.match(panelSource, /setPdfError/);
    assert.match(panelSource, /hotelDownload/);
    assert.match(panelSource, /hotel-report-\$\{from\}-to-\$\{to\}\.pdf/);
  });

  test("downloads the binary through the Hotel session transport", () => {
    assert.match(apiSource, /export async function hotelDownload/);
    assert.match(apiSource, /credentials: "include"/);
    assert.match(apiSource, /cache: "no-store"/);
    assert.match(apiSource, /application\/pdf/);
    assert.ok(!panelSource.includes("fetch("), "the panel uses hotelDownload");
  });
});

describe("Room Reports metric definitions removal", () => {
  test("removes the information control and the definitions modal", () => {
    assert.ok(!panelSource.includes("aria-label=\"Metric definitions\""));
    assert.ok(!panelSource.includes("IconInfoCircle"));
    assert.ok(!panelSource.includes("definitionsOpen"));
    assert.ok(!panelSource.includes("<Modal"));
    assert.ok(!panelSource.includes("definitionTitle"));
    assert.ok(!panelSource.includes("report.definitions"));
  });

  test("keeps existing filters, exports, and metric displays functional", () => {
    assert.match(panelSource, /<EthiopianDateRangePicker/);
    assert.match(panelSource, /t\("reports\.exportCsv"\)/);
    assert.match(panelSource, /t\("reports\.downloadPdf"\)/);
    assert.match(panelSource, /t\("reports\.occupiedRoomNights"\)/);
    assert.match(panelSource, /t\("reports\.occupancyRate"\)/);
    assert.match(panelSource, /t\("reports\.adr"\)/);
    assert.match(panelSource, /t\("reports\.revpar"\)/);
  });
});

describe("Room Reports loading, retry, and stale-request handling", () => {
  test("guards report loads against stale responses", () => {
    assert.match(panelSource, /loadIdRef\.current !== requestId/);
    assert.match(inventorySource, /loadIdRef\.current !== requestId/);
  });

  test("cancels superseded requests and disables duplicate refreshes", () => {
    assert.match(panelSource, /new AbortController\(\)/);
    assert.match(inventorySource, /new AbortController\(\)/);
    assert.match(panelSource, /disabled=\{loading \|\| rangeInvalid\}/);
    assert.match(inventorySource, /disabled=\{loading\}/);
  });

  test("shows skeletons, empty states, and retryable errors", () => {
    assert.match(panelSource, /SkeletonRows/);
    assert.match(inventorySource, /SkeletonRows/);
    assert.match(panelSource, /EmptyState/);
    assert.match(inventorySource, /EmptyState/);
    assert.match(panelSource, /<Banner/);
    assert.match(inventorySource, /<Banner/);
    assert.match(panelSource, /t\("common\.tryAgain"\)/);
    assert.match(inventorySource, /t\("common\.tryAgain"\)/);
  });

  test("shows partial-data warnings without fabricating missing values", () => {
    assert.match(panelSource, /t\("reports\.partialError"/);
    assert.match(panelSource, /formatCount/);
    assert.match(panelSource, /return "—"/);
  });
});

describe("Room Reports accessibility", () => {
  test("provides a skip link and a labelled main region", () => {
    assert.match(shellSource, /skipHref="#room-reports-main"/);
    assert.match(shellSource, /id="room-reports-main"/);
    assert.match(shellSource, /skipLabelKey="reports\.skip"/);
  });

  test("labels filters and tables and exposes busy state", () => {
    for (const id of [
      "report-room-status",
      "report-room-type",
      "report-room-floor",
      "report-room-active",
    ]) {
      assert.match(inventorySource, new RegExp(`htmlFor="${id}"`));
      assert.match(inventorySource, new RegExp(`id="${id}"`));
    }
    assert.match(inventorySource, /scope="col"/);
    assert.match(inventorySource, /aria-busy=\{loading\}/);
    assert.match(inventorySource, /<caption className="sr-only">/);
    assert.match(panelSource, /<caption className="sr-only">/);
    assert.match(panelSource, /aria-label=\{ariaLabel\}/);
    assert.match(panelSource, /role="status"/);
    assert.match(inventorySource, /role="alert"/);
  });
});

describe("Room Reports scope boundaries", () => {
  test("contains no mutations, credential handling, or token storage", () => {
    for (const source of dataSources) {
      assert.ok(!/method: "(POST|PUT|PATCH|DELETE)"/.test(source));
      assert.ok(!source.includes("localStorage"));
      assert.ok(!source.includes("sessionStorage"));
      assert.ok(!source.includes("console."));
      assert.ok(!source.includes("pinHash"));
      assert.ok(!source.includes("rotate"));
      assert.ok(!source.includes("provision"));
    }
  });

  test("never imports POS authentication, session, or database helpers", () => {
    for (const source of allSources) {
      for (const forbidden of [
        'from "@/app/components/PinGuard"',
        'from "@/app/components/PinLoginModal"',
        'from "@/app/components/PinKeypad"',
        'from "@/lib/sessionClient"',
        'from "@/lib/clientFetch"',
        'from "@/lib/mongodb"',
        'from "@/lib/hotel/db',
        'from "@/_lib/pos',
      ]) {
        assert.ok(!source.includes(forbidden), `must not import ${forbidden}`);
      }
    }
  });
});
