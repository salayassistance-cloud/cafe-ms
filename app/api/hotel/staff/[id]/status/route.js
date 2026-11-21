import { hotelFailure, hotelSuccess, withHotelApi } from "@/lib/hotel/http/apiResponse";
import { readHotelJsonBody } from "@/lib/hotel/http/requestSecurity";
import { connectToHotelDatabase } from "@/lib/hotel/db/connection";
import { validateObjectIdString } from "@/lib/hotel/validation";
import { HOTEL_ERROR_CODES } from "@/lib/hotel/errors";
import { HOTEL_AUDIT_ACTIONS } from "@/lib/hotel/audit";
import { revokeAllHotelSessionsForUser } from "@/lib/hotel/auth/session";
import {
  setReceptionistActive,
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

// POST /api/hotel/staff/[id]/status — activate or deactivate ONE Receptionist.
// Deactivation revokes all of that identity's live Hotel sessions; the session
// resolver also rejects disabled accounts independently.
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
  if (typeof body.isActive !== "boolean") {
    return hotelFailure({
      code: HOTEL_ERROR_CODES.VALIDATION_ERROR,
      status: 422,
      message: "isActive must be a boolean",
    });
  }

  const connection = await connectToHotelDatabase();
  const { before } = await snapshotManagedStaff(connection, id);
  const updated = await setReceptionistActive(
    connection,
    id,
    body.isActive,
    gate.auth.user.id
  );

  let revoked = 0;
  if (!body.isActive) {
    revoked = await revokeAllHotelSessionsForUser(
      connection,
      id,
      "ACCOUNT_DISABLED"
    ).catch(() => 0);
  }

  const auditFailure = await requireStaffAudit(
    connection,
    staffAuditEvent(
      body.isActive
        ? HOTEL_AUDIT_ACTIONS.STAFF_ACTIVATED
        : HOTEL_AUDIT_ACTIONS.STAFF_DEACTIVATED,
      gate.auth,
      updated,
      { request, metadata: { isActive: body.isActive, sessionsRevoked: revoked } }
    ),
    () => restoreManagedStaff(connection, id, before, updated.updatedAt)
  );
  if (auditFailure) return auditFailure;

  return hotelSuccess({ staff: updated, sessionsRevoked: revoked });
}

export const POST = withHotelApi(handler);
