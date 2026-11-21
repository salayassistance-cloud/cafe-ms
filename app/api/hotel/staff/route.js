import { hotelFailure, hotelSuccess, withHotelApi } from "@/lib/hotel/http/apiResponse";
import { readHotelJsonBody } from "@/lib/hotel/http/requestSecurity";
import { connectToHotelDatabase } from "@/lib/hotel/db/connection";
import { HOTEL_AUDIT_ACTIONS } from "@/lib/hotel/audit";
import { validateHotelPin } from "@/lib/hotel/validation";
import { HotelValidationError, HOTEL_ERROR_CODES } from "@/lib/hotel/errors";
import {
  createReceptionist,
  listManagedStaff,
  removeJustCreatedStaff,
} from "@/lib/hotel/auth/staffService";
import {
  authorizeStaffRequest,
  checkStaffMutationRateLimit,
  requireStaffAudit,
  staffAuditEvent,
} from "@/lib/hotel/auth/staffRouteSupport";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/hotel/staff — Manager-only Receptionist directory.
async function listHandler(request) {
  const gate = await authorizeStaffRequest(request);
  if (!gate.ok) return gate.response;
  const connection = await connectToHotelDatabase();
  const staff = await listManagedStaff(connection);
  return hotelSuccess({ staff, count: staff.length });
}

// POST /api/hotel/staff — create a Receptionist with an individual 4-digit PIN.
async function createHandler(request) {
  const gate = await authorizeStaffRequest(request, { mutation: true });
  if (!gate.ok) return gate.response;
  const limited = checkStaffMutationRateLimit(request);
  if (limited) return limited;

  const body = await readHotelJsonBody(request);
  try {
    validateHotelPin(body.pin);
    validateHotelPin(body.confirmPin);
    if (body.pin !== body.confirmPin) {
      throw new HotelValidationError({ confirmPin: "PINs do not match" });
    }
  } catch (error) {
    if (!(error instanceof HotelValidationError)) throw error;
    return hotelFailure({
      code: HOTEL_ERROR_CODES.VALIDATION_ERROR,
      status: 422,
      message: "PIN must be exactly 4 digits and both values must match",
    });
  }
  const connection = await connectToHotelDatabase();
  const created = await createReceptionist(connection, {
    name: body.name,
    pin: body.pin,
    actorId: gate.auth.user.id,
  });

  const auditFailure = await requireStaffAudit(
    connection,
    staffAuditEvent(
      HOTEL_AUDIT_ACTIONS.STAFF_CREATED,
      gate.auth,
      created,
      { request, metadata: { name: created.name, createdVia: created.createdVia } }
    ),
    async () =>
      (await removeJustCreatedStaff(connection, created.id)).deletedCount > 0
  );
  if (auditFailure) return auditFailure;

  return hotelSuccess({ staff: created }, { status: 201 });
}

export const GET = withHotelApi(listHandler);
export const POST = withHotelApi(createHandler);
