// Hotel-only Reports Route Handler logic.
//
// The JSON summary, CSV export, and PDF export are read-only reports protected
// by REPORTS_READ (manager-only per the permission matrix). Reads require no
// Origin/CSRF grant, and the query surface is limited to the exact report
// window fields. Both exports are built from the same aggregation service as
// the JSON summary, so every response reconciles.

import { HotelValidationError } from "../errors.js";
import { HOTEL_PERMISSIONS } from "../auth/authorization.js";
import { hotelSuccess } from "./apiResponse.js";
import { authorizeHotelRequest } from "./authorizedRequest.js";
import { assertHotelQueryFields } from "./query.js";
import { buildHotelReportsSummary } from "../services/reports.js";
import {
  renderHotelReportsSummaryCsv,
} from "../services/reportsCsv.js";
import { renderHotelReportsSummaryPdf } from "../services/reportsPdf.js";

// Downloads must never be cached or served from a shared cache.
const DOWNLOAD_HEADERS = Object.freeze({
  "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
});

const CSV_HEADERS = Object.freeze({
  ...DOWNLOAD_HEADERS,
  "Content-Type": "text/csv; charset=utf-8",
});

const PDF_HEADERS = Object.freeze({
  ...DOWNLOAD_HEADERS,
  "Content-Type": "application/pdf",
});

function readReportWindow({ searchParams }) {
  const from = searchParams.get("from");
  const to = searchParams.get("to");
  const fieldErrors = {};
  if (from == null || from === "") fieldErrors.from = "from is required";
  if (to == null || to === "") fieldErrors.to = "to is required";
  if (Object.keys(fieldErrors).length > 0) {
    throw new HotelValidationError(fieldErrors);
  }
  return { from, to };
}

async function authorizeAndParse(request, deps) {
  const auth = await authorizeHotelRequest(request, {
    permission: HOTEL_PERMISSIONS.REPORTS_READ,
    connect: deps.connect,
    allowedOrigins: deps.allowedOrigins,
      authenticate: deps.authenticate,
  });
  if (!auth.ok) return { authError: auth.response };

  const searchParams = new URL(request.url).searchParams;
  assertHotelQueryFields(searchParams, ["from", "to"]);
  const { from, to } = readReportWindow({ searchParams });

  // One clock value is shared by aggregation (future-window validation) and
  // the PDF generation timestamp so the document is internally consistent.
  const generatedAt = deps.now ?? Date.now();
  return {
    summary: await buildHotelReportsSummary({
      connection: auth.auth.connection,
      from,
      to,
      now: generatedAt,
    }),
    generatedAt,
  };
}

export async function handleHotelReportsSummary(request, context, deps = {}) {
  const { authError, summary } = await authorizeAndParse(request, deps);
  if (authError) return authError;
  return hotelSuccess(summary);
}

export async function handleHotelReportsSummaryExport(
  request,
  context,
  deps = {}
) {
  const { authError, summary } = await authorizeAndParse(request, deps);
  if (authError) return authError;

  const body = `\uFEFF${renderHotelReportsSummaryCsv(summary)}`;
  // RFC 6266 safe filename: both boundary values are validated calendar dates.
  const { from, to } = summary.range;
  const disposition = `attachment; filename="hotel-report-${from}-to-${to}.csv"`;

  return new Response(body, {
    status: 200,
    headers: { ...CSV_HEADERS, "Content-Disposition": disposition },
  });
}

export async function handleHotelReportsSummaryExportPdf(
  request,
  context,
  deps = {}
) {
  const { authError, summary, generatedAt } = await authorizeAndParse(
    request,
    deps
  );
  if (authError) return authError;

  let body;
  try {
    body = await renderHotelReportsSummaryPdf(summary, { generatedAt });
  } catch {
    // Never expose renderer internals, stack traces, or document data. The
    // shared Hotel API wrapper turns this into a generic 500 response.
    throw new Error("The report PDF could not be generated.");
  }

  const { from, to } = summary.range;
  const disposition = `attachment; filename="hotel-report-${from}-to-${to}.pdf"`;

  return new Response(body, {
    status: 200,
    headers: { ...PDF_HEADERS, "Content-Disposition": disposition },
  });
}
