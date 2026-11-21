// Hotel-only RoomType Route Handler logic.
//
// Reads require the ROOM_TYPES_READ permission. Mutations require
// ROOM_TYPES_MANAGE, an exact Origin, and the session-bound CSRF header.

import { HOTEL_PERMISSIONS } from "../auth/authorization.js";
import { hotelSuccess } from "./apiResponse.js";
import { authorizeHotelRequest } from "./authorizedRequest.js";
import { readHotelJsonBody } from "./requestSecurity.js";
import {
  parseHotelOptionalBoolean,
  parseHotelPagination,
} from "./query.js";
import {
  createRoomType,
  deactivateRoomType,
  getRoomType,
  listRoomTypes,
  updateRoomType,
} from "../services/roomTypes.js";
import { validateRoomTypePayload } from "../validation.js";

async function routeId(context) {
  const params = (await context?.params) ?? {};
  return params.id;
}

export async function handleListRoomTypes(request, context, deps = {}) {
  const auth = await authorizeHotelRequest(request, {
    permission: HOTEL_PERMISSIONS.ROOM_TYPES_READ,
    connect: deps.connect,
    allowedOrigins: deps.allowedOrigins,
  });
  if (!auth.ok) return auth.response;

  const searchParams = new URL(request.url).searchParams;
  const pagination = parseHotelPagination(searchParams);
  const isActive = parseHotelOptionalBoolean(searchParams, "isActive");

  const result = await listRoomTypes({
    connection: auth.auth.connection,
    isActive,
    ...pagination,
  });
  return hotelSuccess(result);
}

export async function handleCreateRoomType(request, context, deps = {}) {
  const auth = await authorizeHotelRequest(request, {
    permission: HOTEL_PERMISSIONS.ROOM_TYPES_MANAGE,
    mutation: true,
    connect: deps.connect,
    allowedOrigins: deps.allowedOrigins,
  });
  if (!auth.ok) return auth.response;

  const body = await readHotelJsonBody(request);
  const input = validateRoomTypePayload(body);
  const result = await createRoomType({
    connection: auth.auth.connection,
    input,
    actor: auth.auth.user,
    request,
  });
  return hotelSuccess(result, { status: 201 });
}

export async function handleGetRoomType(request, context, deps = {}) {
  const auth = await authorizeHotelRequest(request, {
    permission: HOTEL_PERMISSIONS.ROOM_TYPES_READ,
    connect: deps.connect,
    allowedOrigins: deps.allowedOrigins,
  });
  if (!auth.ok) return auth.response;

  const result = await getRoomType({
    connection: auth.auth.connection,
    id: await routeId(context),
  });
  return hotelSuccess(result);
}

export async function handleUpdateRoomType(request, context, deps = {}) {
  const auth = await authorizeHotelRequest(request, {
    permission: HOTEL_PERMISSIONS.ROOM_TYPES_MANAGE,
    mutation: true,
    connect: deps.connect,
    allowedOrigins: deps.allowedOrigins,
  });
  if (!auth.ok) return auth.response;

  const body = await readHotelJsonBody(request);
  const input = validateRoomTypePayload(body, { partial: true });
  const result = await updateRoomType({
    connection: auth.auth.connection,
    id: await routeId(context),
    input,
    actor: auth.auth.user,
    request,
  });
  return hotelSuccess(result);
}

export async function handleDeactivateRoomType(request, context, deps = {}) {
  const auth = await authorizeHotelRequest(request, {
    permission: HOTEL_PERMISSIONS.ROOM_TYPES_MANAGE,
    mutation: true,
    connect: deps.connect,
    allowedOrigins: deps.allowedOrigins,
  });
  if (!auth.ok) return auth.response;

  const result = await deactivateRoomType({
    connection: auth.auth.connection,
    id: await routeId(context),
    actor: auth.auth.user,
    request,
  });
  return hotelSuccess(result);
}
