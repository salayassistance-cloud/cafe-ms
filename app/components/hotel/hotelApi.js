// Hotel-only client transport.
// It intentionally does not import POS fetch/auth helpers.

export class HotelRequestError extends Error {
  constructor({
    message,
    status,
    code = null,
    fieldErrors = null,
    details = null,
    generic = false,
  }) {
    super(message);
    this.name = "HotelRequestError";
    this.status = status;
    this.code = code;
    this.fieldErrors = fieldErrors;
    this.details = details;
    // `generic` marks transport-level failures whose message is not a
    // user-facing backend explanation, so callers can substitute a translated
    // fallback while backend messages are preserved verbatim.
    this.generic = generic;
  }
}

export function hotelUrl(path, params = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    query.set(key, String(value));
  }
  const suffix = query.toString();
  return suffix ? `${path}?${suffix}` : path;
}

export async function hotelRequest(path, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const headers = { Accept: "application/json" };
  let body;

  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
  }

  let response;
  try {
    response = await fetch(path, {
      method,
      headers,
      body,
      credentials: "include",
      cache: "no-store",
      signal: options.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    throw new HotelRequestError({
      message:
        "The Hotel service could not be reached. Check the connection and try again.",
      status: 0,
      generic: true,
    });
  }

  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  const apiError =
    payload && typeof payload.error === "object" && payload.error !== null
      ? payload.error
      : null;

  if (!response.ok || payload?.success !== true) {
    const backendMessage =
      apiError?.message ||
      (typeof payload?.error === "string" ? payload.error : null);
    const message =
      backendMessage ||
      `The Hotel service returned status ${response.status}.`;
    throw new HotelRequestError({
      message,
      status: response.status,
      code: apiError?.code || null,
      fieldErrors: apiError?.details?.fieldErrors || null,
      details: apiError?.details || null,
      generic: !backendMessage,
    });
  }

  return payload.data;
}

// Binary downloads (for example the manager report PDF) use the same Hotel
// session cookie and no-store semantics as hotelRequest, but return a Blob
// instead of trying to parse JSON.
export async function hotelDownload(path, options = {}) {
  let response;
  try {
    response = await fetch(path, {
      method: "GET",
      headers: { Accept: options.accept || "application/pdf" },
      credentials: "include",
      cache: "no-store",
      signal: options.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    throw new HotelRequestError({
      message:
        "The Hotel service could not be reached. Check the connection and try again.",
      status: 0,
      generic: true,
    });
  }

  if (!response.ok) {
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    const apiError =
      payload && typeof payload.error === "object" && payload.error !== null
        ? payload.error
        : null;
    const message =
      apiError?.message ||
      `The Hotel service returned status ${response.status}.`;
    throw new HotelRequestError({
      message,
      status: response.status,
      code: apiError?.code || null,
      fieldErrors: apiError?.details?.fieldErrors || null,
      details: apiError?.details || null,
      generic: !apiError?.message,
    });
  }

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/pdf")) {
    throw new HotelRequestError({
      message: "The Hotel service did not return a PDF file.",
      status: response.status,
      generic: true,
    });
  }

  return { blob: await response.blob(), contentType };
}

export function humanHotelError(error, fallback = "The request could not be completed.") {
  if (!error) return fallback;
  // Transport-level failures carry a technical English message that is not a
  // backend business explanation; use the caller's translated fallback instead.
  if (error.generic) return fallback;
  const fieldMessages =
    error.fieldErrors && typeof error.fieldErrors === "object"
      ? Object.values(error.fieldErrors).filter((value) => typeof value === "string")
      : [];
  if (fieldMessages.length > 0) {
    return `${error.message || fallback} ${fieldMessages.join(" ")}`;
  }
  return error.message || fallback;
}
