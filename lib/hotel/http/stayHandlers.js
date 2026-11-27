// Hotel-only Stay Route Handler logic.
//
// Check-in is a Reservation workflow and requires RESERVATIONS_MANAGE.
// Check-out is a billing-sensitive Stay workflow and requires BILLING_MANAGE.
// Stay reads and history require RESERVATIONS_READ. Mutations additionally
// require an exact Origin and the session-bound CSRF header.
//
// There is no generic Stay status route: IN_HOUSE -> CHECKED_OUT is reachable
// only through the check-out endpoint, and no stay history is ever deleted.

import { HOTEL_STAY_STATUSES } from "../constants.js";
import { HOTEL_PERMISSIONS } from "../auth/authorization.js";
import { hotelSuccess } from "./apiResponse.js";
import { authorizeHotelRequest } from "./authorizedRequest.js";
import { readHotelOptionalJsonBody } from "./requestSecurity.js";
import {
  parseHotelOptionalBoolean,
  parseHotelOptionalEnum,
  parseHotelOptionalLocalDate,
  parseHotelOptionalObjectId,
  parseHotelPagination,
} from "./query.js";
import {
  checkInReservation,
  checkOutStay,
  getStay,
  listGuestStays,
  listReservationStays,
  listStays,
} from "../services/stays.js";
import {
  validateCheckInPayload,
  validateCheckOutPayload,
} from "../validation.js";

async function routeId(context) {
  const params = (await context?.params) ?? {};
  return params.id;
}

export async function handleListStays(request, context, deps = {}) {
  const auth = await authorizeHotelRequest(request, {
    permission: HOTEL_PERMISSIONS.RESERVATIONS_READ,
    connect: deps.connect,
    allowedOrigins: deps.allowedOrigins,
      authenticate: deps.authenticate,
  });
  if (!auth.ok) return auth.response;

  const searchParams = new URL(request.url).searchParams;
  const pagination = parseHotelPagination(searchParams);
  const status = parseHotelOptionalEnum(
    searchParams,
    "status",
    HOTEL_STAY_STATUSES
  );
  const activeOnly = parseHotelOptionalBoolean(searchParams, "activeOnly");
  const reservationId = parseHotelOptionalObjectId(
    searchParams,
    "reservationId"
  );
  const guestId = parseHotelOptionalObjectId(searchParams, "guestId");
  const roomId = parseHotelOptionalObjectId(searchParams, "roomId");
  const checkedInFrom = parseHotelOptionalLocalDate(
    searchParams,
    "checkedInFrom"
  );
  const checkedInTo = parseHotelOptionalLocalDate(searchParams, "checkedInTo");

  const result = await listStays({
    connection: auth.auth.connection,
    status,
    activeOnly,
    reservationId,
    guestId,
    roomId,
    checkedInFrom,
    checkedInTo,
    ...pagination,
  });
  return hotelSuccess(result);
}

export async function handleGetStay(request, context, deps = {}) {
  const auth = await authorizeHotelRequest(request, {
    permission: HOTEL_PERMISSIONS.RESERVATIONS_READ,
    connect: deps.connect,
    allowedOrigins: deps.allowedOrigins,
      authenticate: deps.authenticate,
  });
  if (!auth.ok) return auth.response;

  const result = await getStay({
    connection: auth.auth.connection,
    id: await routeId(context),
  });
  return hotelSuccess(result);
}

export async function handleCheckInReservation(request, context, deps = {}) {
  const auth = await authorizeHotelRequest(request, {
    permission: HOTEL_PERMISSIONS.RESERVATIONS_MANAGE,
    mutation: true,
    connect: deps.connect,
    allowedOrigins: deps.allowedOrigins,
      authenticate: deps.authenticate,
  });
  if (!auth.ok) return auth.response;

  const body = await readHotelOptionalJsonBody(request);
  const input = validateCheckInPayload(body);
  const result = await checkInReservation({
    connection: auth.auth.connection,
    id: await routeId(context),
    input,
    actor: auth.auth.user,
    request,
    now: deps.now,
  });
  return hotelSuccess(result, { status: result.changed ? 201 : 200 });
}

export async function handleCheckOutStay(request, context, deps = {}) {
  const auth = await authorizeHotelRequest(request, {
    permission: HOTEL_PERMISSIONS.BILLING_MANAGE,
    mutation: true,
    connect: deps.connect,
    allowedOrigins: deps.allowedOrigins,
      authenticate: deps.authenticate,
  });
  if (!auth.ok) return auth.response;

  const body = await readHotelOptionalJsonBody(request);
  const input = validateCheckOutPayload(body);
  const result = await checkOutStay({
    connection: auth.auth.connection,
    id: await routeId(context),
    input,
    actor: auth.auth.user,
    request,
    now: deps.now,
  });
  return hotelSuccess(result);
}

export async function handleListReservationStays(request, context, deps = {}) {
  const auth = await authorizeHotelRequest(request, {
    permission: HOTEL_PERMISSIONS.RESERVATIONS_READ,
    connect: deps.connect,
    allowedOrigins: deps.allowedOrigins,
      authenticate: deps.authenticate,
  });
  if (!auth.ok) return auth.response;

  const pagination = parseHotelPagination(new URL(request.url).searchParams);
  const result = await listReservationStays({
    connection: auth.auth.connection,
    reservationId: await routeId(context),
    ...pagination,
  });
  return hotelSuccess(result);
}

export async function handleListGuestStays(request, context, deps = {}) {
  const auth = await authorizeHotelRequest(request, {
    permission: HOTEL_PERMISSIONS.RESERVATIONS_READ,
    connect: deps.connect,
    allowedOrigins: deps.allowedOrigins,
      authenticate: deps.authenticate,
  });
  if (!auth.ok) return auth.response;

  const pagination = parseHotelPagination(new URL(request.url).searchParams);
  const result = await listGuestStays({
    connection: auth.auth.connection,
    guestId: await routeId(context),
    ...pagination,
  });
  return hotelSuccess(result);
}
