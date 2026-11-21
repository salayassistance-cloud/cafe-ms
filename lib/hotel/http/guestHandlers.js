// Hotel-only Guest Route Handler logic.
//
// Reads require GUESTS_READ. Mutations require GUESTS_MANAGE, an exact Origin,
// and the session-bound CSRF header. There is no hard-delete route: guests are
// deactivated, and a guest with active reservations cannot be deactivated.

import { HOTEL_PERMISSIONS } from "../auth/authorization.js";
import { hotelSuccess } from "./apiResponse.js";
import { authorizeHotelRequest } from "./authorizedRequest.js";
import { readHotelJsonBody } from "./requestSecurity.js";
import {
  parseHotelOptionalBoolean,
  parseHotelOptionalSearch,
  parseHotelPagination,
} from "./query.js";
import {
  createGuest,
  deactivateGuest,
  getGuest,
  listGuests,
  updateGuest,
} from "../services/guests.js";
import { validateGuestPayload } from "../validation.js";

async function routeId(context) {
  const params = (await context?.params) ?? {};
  return params.id;
}

export async function handleListGuests(request, context, deps = {}) {
  const auth = await authorizeHotelRequest(request, {
    permission: HOTEL_PERMISSIONS.GUESTS_READ,
    connect: deps.connect,
    allowedOrigins: deps.allowedOrigins,
  });
  if (!auth.ok) return auth.response;

  const searchParams = new URL(request.url).searchParams;
  const pagination = parseHotelPagination(searchParams);
  const isActive = parseHotelOptionalBoolean(searchParams, "isActive");
  const search = parseHotelOptionalSearch(searchParams);

  const result = await listGuests({
    connection: auth.auth.connection,
    isActive,
    search,
    ...pagination,
  });
  return hotelSuccess(result);
}

export async function handleCreateGuest(request, context, deps = {}) {
  const auth = await authorizeHotelRequest(request, {
    permission: HOTEL_PERMISSIONS.GUESTS_MANAGE,
    mutation: true,
    connect: deps.connect,
    allowedOrigins: deps.allowedOrigins,
  });
  if (!auth.ok) return auth.response;

  const body = await readHotelJsonBody(request);
  const input = validateGuestPayload(body);
  const result = await createGuest({
    connection: auth.auth.connection,
    input,
    actor: auth.auth.user,
    request,
  });
  return hotelSuccess(result, { status: 201 });
}

export async function handleGetGuest(request, context, deps = {}) {
  const auth = await authorizeHotelRequest(request, {
    permission: HOTEL_PERMISSIONS.GUESTS_READ,
    connect: deps.connect,
    allowedOrigins: deps.allowedOrigins,
  });
  if (!auth.ok) return auth.response;

  const result = await getGuest({
    connection: auth.auth.connection,
    id: await routeId(context),
  });
  return hotelSuccess(result);
}

export async function handleUpdateGuest(request, context, deps = {}) {
  const auth = await authorizeHotelRequest(request, {
    permission: HOTEL_PERMISSIONS.GUESTS_MANAGE,
    mutation: true,
    connect: deps.connect,
    allowedOrigins: deps.allowedOrigins,
  });
  if (!auth.ok) return auth.response;

  const body = await readHotelJsonBody(request);
  const input = validateGuestPayload(body, { partial: true });
  const result = await updateGuest({
    connection: auth.auth.connection,
    id: await routeId(context),
    input,
    actor: auth.auth.user,
    request,
  });
  return hotelSuccess(result);
}

export async function handleDeactivateGuest(request, context, deps = {}) {
  const auth = await authorizeHotelRequest(request, {
    permission: HOTEL_PERMISSIONS.GUESTS_MANAGE,
    mutation: true,
    connect: deps.connect,
    allowedOrigins: deps.allowedOrigins,
  });
  if (!auth.ok) return auth.response;

  const result = await deactivateGuest({
    connection: auth.auth.connection,
    id: await routeId(context),
    actor: auth.auth.user,
    request,
  });
  return hotelSuccess(result);
}
