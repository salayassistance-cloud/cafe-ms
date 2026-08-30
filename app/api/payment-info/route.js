import { withApi } from "@/lib/withApi";
import { ok, fail, isDbError } from "@/lib/apiResponse";
import { connectToDatabase } from "@/lib/mongodb";
import { getPaymentInfoModel } from "@/lib/models/PaymentInfo";
import { checkRateLimit, RATE_LIMITS, retryAfterSeconds } from "@/lib/rateLimit";
import { requireAuth } from "@/lib/security";

export const dynamic = "force-dynamic";

function serialize(doc) {
  return {
    _id: String(doc._id),
    id: String(doc._id),
    bankName: doc.bankName || "",
    ownerName: doc.ownerName || "",
    accountNumber: doc.accountNumber || "",
    isActive: doc.isActive !== false,
    createdAt: doc.createdAt ? new Date(doc.createdAt).toISOString() : null,
    updatedAt: doc.updatedAt ? new Date(doc.updatedAt).toISOString() : null,
  };
}

// GET /api/payment-info
// Public read. Returns all payment records. Inactive ones are flagged; the
// /menu client filters to active, the manager client shows everything.
async function getHandler(request) {
  const rl = checkRateLimit(request, { key: "payment_info", ...RATE_LIMITS.GENERAL });
  if (!rl.ok) {
    const res = fail("Too many requests. Please slow down.", 429);
    try { res.headers.set("Retry-After", String(retryAfterSeconds(rl.retryAfterMs))); } catch {}
    return res;
  }
  try {
    const conn = await connectToDatabase();
    const PaymentInfo = getPaymentInfoModel(conn);
    const rows = await PaymentInfo.find({}).sort({ createdAt: -1 }).lean();
    return ok({ paymentInfos: rows.map(serialize) }, 200);
  } catch (e) {
    if (isDbError(e)) return fail("Database connection error. Please retry shortly.", 503);
    console.error("[api] payment-info GET error:", e?.message || e);
    return fail("Failed to load payment information.", 500);
  }
}

// POST /api/payment-info  { bankName, ownerName, accountNumber, isActive }
async function postHandler(request) {
  const auth = await requireAuth(request, ["MANAGER"]);
  if (!auth.ok) return fail(auth.error, auth.status);
  const rl = checkRateLimit(request, { key: "payment_info_write", ...RATE_LIMITS.MANAGER });
  if (!rl.ok) {
    const res = fail("Too many requests. Please slow down.", 429);
    try { res.headers.set("Retry-After", String(retryAfterSeconds(rl.retryAfterMs))); } catch {}
    return res;
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return fail("Invalid JSON body", 400);
  }
  const bankName = typeof body.bankName === "string" ? body.bankName.trim() : "";
  const ownerName = typeof body.ownerName === "string" ? body.ownerName.trim() : "";
  const accountNumber = typeof body.accountNumber === "string" ? body.accountNumber.trim() : "";
  if (!bankName || !ownerName || !accountNumber) {
    return fail("Bank name, owner name and account number are required.", 400);
  }
  const isActive = body.isActive === undefined ? true : !!body.isActive;
  try {
    const conn = await connectToDatabase();
    const PaymentInfo = getPaymentInfoModel(conn);
    const doc = new PaymentInfo({ bankName, ownerName, accountNumber, isActive });
    await doc.save();
    return ok({ paymentInfo: serialize(doc) }, 201);
  } catch (e) {
    if (isDbError(e)) return fail("Database connection error. Please retry shortly.", 503);
    console.error("[api] payment-info POST error:", e?.message || e);
    return fail("Failed to create payment information.", 500);
  }
}

// PUT /api/payment-info?id=...  { bankName, ownerName, accountNumber, isActive }
async function putHandler(request) {
  const auth = await requireAuth(request, ["MANAGER"]);
  if (!auth.ok) return fail(auth.error, auth.status);
  const rl = checkRateLimit(request, { key: "payment_info_write", ...RATE_LIMITS.MANAGER });
  if (!rl.ok) {
    const res = fail("Too many requests. Please slow down.", 429);
    try { res.headers.set("Retry-After", String(retryAfterSeconds(rl.retryAfterMs))); } catch {}
    return res;
  }
  const { searchParams } = new URL(request.url);
  const id = (searchParams.get("id") || "").toString().trim();
  if (!id) return fail("Payment info id required", 400);
  let body;
  try {
    body = await request.json();
  } catch {
    return fail("Invalid JSON body", 400);
  }
  const update = {};
  if (typeof body.bankName === "string") update.bankName = body.bankName.trim();
  if (typeof body.ownerName === "string") update.ownerName = body.ownerName.trim();
  if (typeof body.accountNumber === "string") update.accountNumber = body.accountNumber.trim();
  if (body.isActive !== undefined) update.isActive = !!body.isActive;
  if (Object.keys(update).length === 0) return fail("No fields to update", 400);
  try {
    const conn = await connectToDatabase();
    const PaymentInfo = getPaymentInfoModel(conn);
    const doc = await PaymentInfo.findByIdAndUpdate(id, { $set: update }, { new: true, runValidators: true });
    if (!doc) return fail("Payment information not found", 404);
    return ok({ paymentInfo: serialize(doc) }, 200);
  } catch (e) {
    if (isDbError(e)) return fail("Database connection error. Please retry shortly.", 503);
    console.error("[api] payment-info PUT error:", e?.message || e);
    return fail("Failed to update payment information.", 500);
  }
}

// DELETE /api/payment-info?id=...
async function deleteHandler(request) {
  const auth = await requireAuth(request, ["MANAGER"]);
  if (!auth.ok) return fail(auth.error, auth.status);
  const rl = checkRateLimit(request, { key: "payment_info_write", ...RATE_LIMITS.MANAGER });
  if (!rl.ok) {
    const res = fail("Too many requests. Please slow down.", 429);
    try { res.headers.set("Retry-After", String(retryAfterSeconds(rl.retryAfterMs))); } catch {}
    return res;
  }
  const { searchParams } = new URL(request.url);
  const id = (searchParams.get("id") || "").toString().trim();
  if (!id) return fail("Payment info id required", 400);
  try {
    const conn = await connectToDatabase();
    const PaymentInfo = getPaymentInfoModel(conn);
    const res = await PaymentInfo.deleteOne({ _id: id });
    if (res.deletedCount === 0) return fail("Payment information not found", 404);
    return ok({ deleted: true, id }, 200);
  } catch (e) {
    if (isDbError(e)) return fail("Database connection error. Please retry shortly.", 503);
    console.error("[api] payment-info DELETE error:", e?.message || e);
    return fail("Failed to delete payment information.", 500);
  }
}

export const GET = withApi(getHandler);
export const POST = withApi(postHandler);
export const PUT = withApi(putHandler);
export const DELETE = withApi(deleteHandler);
