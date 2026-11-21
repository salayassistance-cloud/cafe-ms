import { hotelFailure, hotelSuccess, withHotelApi } from "@/lib/hotel/http/apiResponse";
import { HOTEL_ERROR_CODES } from "@/lib/hotel/errors";
import { readHotelJsonBody } from "@/lib/hotel/http/requestSecurity";
import { connectToHotelDatabase } from "@/lib/hotel/db/connection";
import { validateObjectIdString } from "@/lib/hotel/validation";
import { HOTEL_AUDIT_ACTIONS } from "@/lib/hotel/audit";
import {
  renameReceptionist,
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

// PATCH /api/hotel/staff/[id] — edit a Receptionist's display name only.
// Role, activation status and credentials are changed through dedicated
// endpoints; Manager identities can never be targeted here.
async function handler(request, context) {
  const gate = await authorizeStaffRequest(request, { mutation: true });
  if (!gate.ok) return gate.response;
  const limited = checkStaffMutationRateLimit(request);
  if (limited) return limited;

  const { id: rawId } = (await context?.params) ?? {};
  let id;
  try {
    id = validateObjectIdString(rawId, "id");
  } catch (error) {
    return hotelFailure({
      code: error?.code || HOTEL_ERROR_CODES.VALIDATION_ERROR,
      status: error?.status || 422,
      message: "Invalid staff id",
    });
  }
  const body = await readHotelJsonBody(request);
  const connection = await connectToHotelDatabase();
  const { before } = await snapshotManagedStaff(connection, id);

  const updated = await renameReceptionist(
    connection,
    id,
    body.name,
    gate.auth.user.id
  );

  const auditFailure = await requireStaffAudit(
    connection,
    staffAuditEvent(HOTEL_AUDIT_ACTIONS.STAFF_UPDATED, gate.auth, updated, {
      request,
      metadata: { name: updated.name },
    }),
    () => restoreManagedStaff(connection, id, before, updated.updatedAt)
  );
  if (auditFailure) return auditFailure;

  return hotelSuccess({ staff: updated });
}

export const PATCH = withHotelApi(handler);
