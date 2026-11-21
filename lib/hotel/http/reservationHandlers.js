// Hotel-only Reservation Route Handler logic.
//
// Reads require RESERVATIONS_READ. Mutations require RESERVATIONS_MANAGE, an
// exact Origin, and the session-bound CSRF header. There is no hard-delete
// route: cancellation is an explicit state transition that preserves history.

import {
  HOTEL_RESERVATION_STATUSES,
} from "../constants.js";
import { HOTEL_PERMISSIONS } from "../auth/authorization.js";
import { hotelSuccess } from "./apiResponse.js";
import { authorizeHotelRequest } from "./authorizedRequest.js";
import {
  readHotelJsonBody,
  readHotelOptionalJsonBody,
} from "./requestSecurity.js";
import {
  parseHotelOptionalBoolean,
  parseHotelOptionalEnum,
  parseHotelOptionalLocalDate,
  parseHotelOptionalObjectId,
  parseHotelPagination,
} from "./query.js";
import {
  assignReservationRoom,
  cancelReservation,
  createReservation,
  getReservation,
  listReservations,
  updateReservation,
} from "../services/reservations.js";
import {
  validateReservationAssignmentPayload,
  validateReservationCancelPayload,
  validateReservationCreatePayload,
  validateReservationUpdatePayload,
} from "../validation.js";

async function routeId(context) {
  const params = (await context?.params) ?? {};
  return params.id;
}

export async function handleListReservations(request, context, deps = {}) {
  const auth = await authorizeHotelRequest(request, {
    permission: HOTEL_PERMISSIONS.RESERVATIONS_READ,
    connect: deps.connect,
    allowedOrigins: deps.allowedOrigins,
  });
  if (!auth.ok) return auth.response;

  const searchParams = new URL(request.url).searchParams;
  const pagination = parseHotelPagination(searchParams);
  const status = parseHotelOptionalEnum(
    searchParams,
    "status",
    HOTEL_RESERVATION_STATUSES
  );
  const activeOnly = parseHotelOptionalBoolean(searchParams, "activeOnly");
  const guestId = parseHotelOptionalObjectId(searchParams, "guestId");
  const roomTypeId = parseHotelOptionalObjectId(searchParams, "roomTypeId");
  const roomId = parseHotelOptionalObjectId(searchParams, "roomId");
  const arrivalFrom = parseHotelOptionalLocalDate(searchParams, "arrivalFrom");
  const arrivalTo = parseHotelOptionalLocalDate(searchParams, "arrivalTo");

  const result = await listReservations({
    connection: auth.auth.connection,
    status,
    activeOnly,
    guestId,
    roomTypeId,
    roomId,
    arrivalFrom,
    arrivalTo,
    ...pagination,
  });
  return hotelSuccess(result);
}

export async function handleCreateReservation(request, context, deps = {}) {
  const auth = await authorizeHotelRequest(request, {
    permission: HOTEL_PERMISSIONS.RESERVATIONS_MANAGE,
    mutation: true,
    connect: deps.connect,
    allowedOrigins: deps.allowedOrigins,
  });
  if (!auth.ok) return auth.response;

  const body = await readHotelJsonBody(request);
  const input = validateReservationCreatePayload(body);
  const result = await createReservation({
    connection: auth.auth.connection,
    input,
    actor: auth.auth.user,
    request,
    now: deps.now,
  });
  return hotelSuccess(result, { status: 201 });
}

export async function handleGetReservation(request, context, deps = {}) {
  const auth = await authorizeHotelRequest(request, {
    permission: HOTEL_PERMISSIONS.RESERVATIONS_READ,
    connect: deps.connect,
    allowedOrigins: deps.allowedOrigins,
  });
  if (!auth.ok) return auth.response;

  const result = await getReservation({
    connection: auth.auth.connection,
    id: await routeId(context),
  });
  return hotelSuccess(result);
}

export async function handleUpdateReservation(request, context, deps = {}) {
  const auth = await authorizeHotelRequest(request, {
    permission: HOTEL_PERMISSIONS.RESERVATIONS_MANAGE,
    mutation: true,
    connect: deps.connect,
    allowedOrigins: deps.allowedOrigins,
  });
  if (!auth.ok) return auth.response;

  const body = await readHotelJsonBody(request);
  const input = validateReservationUpdatePayload(body);
  const result = await updateReservation({
    connection: auth.auth.connection,
    id: await routeId(context),
    input,
    actor: auth.auth.user,
    request,
    now: deps.now,
  });
  return hotelSuccess(result);
}

export async function handleCancelReservation(request, context, deps = {}) {
  const auth = await authorizeHotelRequest(request, {
    permission: HOTEL_PERMISSIONS.RESERVATIONS_MANAGE,
    mutation: true,
    connect: deps.connect,
    allowedOrigins: deps.allowedOrigins,
  });
  if (!auth.ok) return auth.response;

  const body = await readHotelOptionalJsonBody(request);
  const input = validateReservationCancelPayload(body);
  const result = await cancelReservation({
    connection: auth.auth.connection,
    id: await routeId(context),
    input,
    actor: auth.auth.user,
    request,
    now: deps.now,
  });
  return hotelSuccess(result);
}

export async function handleAssignReservationRoom(
  request,
  context,
  deps = {}
) {
  const auth = await authorizeHotelRequest(request, {
    permission: HOTEL_PERMISSIONS.RESERVATIONS_MANAGE,
    mutation: true,
    connect: deps.connect,
    allowedOrigins: deps.allowedOrigins,
  });
  if (!auth.ok) return auth.response;

  const body = await readHotelJsonBody(request);
  const input = validateReservationAssignmentPayload(body);
  const result = await assignReservationRoom({
    connection: auth.auth.connection,
    id: await routeId(context),
    input,
    actor: auth.auth.user,
    request,
    now: deps.now,
  });
  return hotelSuccess(result);
}
