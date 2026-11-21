import { hotelFailure, hotelSuccess, withHotelApi } from "@/lib/hotel/http/apiResponse";
import { readHotelJsonBody } from "@/lib/hotel/http/requestSecurity";
import { connectToHotelDatabase } from "@/lib/hotel/db/connection";
import { HOTEL_ERROR_CODES, HotelValidationError } from "@/lib/hotel/errors";
import { validateHotelPin, validateObjectIdString } from "@/lib/hotel/validation";
import { HOTEL_AUDIT_ACTIONS, safeRecordHotelAudit } from "@/lib/hotel/audit";
import { revokeAllHotelSessionsForUser } from "@/lib/hotel/auth/session";
import {
  resetReceptionistPin,
  restoreManagedStaff,
  snapshotManagedStaff,
} from "@/lib/hotel/auth/staffService";
import {
  authorizeStaffRequest,
  checkStaffMutationRateLimit,
  requireStaffAudit,
  staffAuditEvent,
} from "@/lib/hotel/auth/staffRouteSupport";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/hotel/staff/[id]/pin — Manager resets ONE Receptionist's PIN.
// No PIN value is logged, audited, or returned. Every active session for that
// identity is revoked so the old credential cannot keep working.
async function handler(request, context) {
  const gate = await authorizeStaffRequest(request, { mutation: true });
  if (!gate.ok) return gate.response;
  const limited = checkStaffMutationRateLimit(request);
  if (limited) return limited;

  let id;
  try {
    id = validateObjectIdString((await context?.params)?.id, "id");
  } catch (error) {
    return hotelFailure({
      code: error?.code || HOTEL_ERROR_CODES.VALIDATION_ERROR,
      status: error?.status || 422,
      message: "Invalid staff id",
    });
  }
  const body = await readHotelJsonBody(request);
  let pin;
  try {
    pin = validateHotelPin(body.pin);
    if (!validateHotelPin(body.confirmPin) || pin !== body.confirmPin) {
      throw new HotelValidationError({ confirmPin: "PINs do not match" });
    }
  } catch (error) {
    if (!(error instanceof HotelValidationError)) throw error;
    await safeRecordHotelAudit(
      await connectToHotelDatabase(),
      {
        action: HOTEL_AUDIT_ACTIONS.STAFF_PIN_CHANGE_REJECTED,
        outcome: "FAILURE",
        actorUserId: gate.auth.user.id,
        actorRole: gate.auth.role,
        entityType: "HotelUser",
        entityId: id ?? null,
        metadata: { reason: "INVALID_PIN_PAYLOAD" },
        request,
      }
    ).catch(() => {});
    return hotelFailure({
      code: HOTEL_ERROR_CODES.VALIDATION_ERROR,
      status: 422,
      message: "PIN must be exactly 4 digits and both values must match",
    });
  }

  const connection = await connectToHotelDatabase();
  const { before } = await snapshotManagedStaff(connection, id);
  const updated = await resetReceptionistPin(
    connection,
    id,
    pin,
    gate.auth.user.id
  );
  // Phase 3F / E-01: revocation failure is fatal to this mutation. The PIN
  // change is compensated and the response never claims sessions were revoked.
  let revoked = 0;
  try {
    revoked = await revokeAllHotelSessionsForUser(connection, id, "SECURITY");
  } catch {
    await restoreManagedStaff(connection, id, before, updated.updatedAt).catch(
      () => {}
    );
    await safeRecordHotelAudit(connection, {
      action: HOTEL_AUDIT_ACTIONS.STAFF_PIN_CHANGE_REJECTED,
      outcome: "FAILURE",
      actorUserId: gate.auth.user.id,
      actorRole: gate.auth.role,
      entityType: "HotelUser",
      entityId: id,
      metadata: { reason: "SESSION_REVOCATION_FAILED" },
      request,
    }).catch(() => {});
    return hotelFailure({
      code: HOTEL_ERROR_CODES.DATABASE_UNAVAILABLE,
      status: 503,
      message: "PIN was not changed: active sessions could not be revoked",
    });
  }

  const auditFailure = await requireStaffAudit(
    connection,
    staffAuditEvent(HOTEL_AUDIT_ACTIONS.STAFF_PIN_RESET, gate.auth, updated, {
      request,
      metadata: { reason: "MANAGER_RESET" },
    }),
    () => restoreManagedStaff(connection, id, before, updated.updatedAt)
  );
  if (auditFailure) return auditFailure;

  return hotelSuccess({
    staff: updated,
    sessionsRevoked: revoked > 0,
    revokedSessionCount: revoked,
  });
}

export const POST = withHotelApi(handler);
