// Hotel-only Room Route Handler logic.
//
// Reads require ROOMS_READ. Mutations require ROOMS_MANAGE, an exact Origin,
// and the session-bound CSRF header. There is no hard-delete route: rooms are
// deactivated, and occupied/reserved rooms cannot be deactivated.

import {
  HOTEL_ROOM_OPERATIONAL_STATUSES,
} from "../constants.js";
import { HOTEL_PERMISSIONS } from "../auth/authorization.js";
import { hotelSuccess } from "./apiResponse.js";
import { authorizeHotelRequest } from "./authorizedRequest.js";
import { readHotelJsonBody } from "./requestSecurity.js";
import {
  parseHotelOptionalBoolean,
  parseHotelOptionalEnum,
  parseHotelOptionalInteger,
  parseHotelOptionalObjectId,
  parseHotelPagination,
} from "./query.js";
import {
  changeRoomStatus,
  createRoom,
  deactivateRoom,
  getRoom,
  listRooms,
  updateRoom,
} from "../services/rooms.js";
import {
  validateRoomPayload,
  validateRoomStatusPayload,
} from "../validation.js";

async function routeId(context) {
  const params = (await context?.params) ?? {};
  return params.id;
}

export async function handleListRooms(request, context, deps = {}) {
  const auth = await authorizeHotelRequest(request, {
    permission: HOTEL_PERMISSIONS.ROOMS_READ,
    connect: deps.connect,
    allowedOrigins: deps.allowedOrigins,
      authenticate: deps.authenticate,
  });
  if (!auth.ok) return auth.response;

  const searchParams = new URL(request.url).searchParams;
  const pagination = parseHotelPagination(searchParams);
  const isActive = parseHotelOptionalBoolean(searchParams, "isActive");
  const operationalStatus = parseHotelOptionalEnum(
    searchParams,
    "operationalStatus",
    HOTEL_ROOM_OPERATIONAL_STATUSES
  );
  const floor = parseHotelOptionalInteger(searchParams, "floor", {
    min: -10,
    max: 200,
  });
  const roomTypeId = parseHotelOptionalObjectId(searchParams, "roomTypeId");

  const result = await listRooms({
    connection: auth.auth.connection,
    isActive,
    operationalStatus,
    floor,
    roomTypeId,
    ...pagination,
  });
  return hotelSuccess(result);
}

export async function handleCreateRoom(request, context, deps = {}) {
  const auth = await authorizeHotelRequest(request, {
    permission: HOTEL_PERMISSIONS.ROOMS_MANAGE,
    mutation: true,
    connect: deps.connect,
    allowedOrigins: deps.allowedOrigins,
      authenticate: deps.authenticate,
  });
  if (!auth.ok) return auth.response;

  const body = await readHotelJsonBody(request);
  const input = validateRoomPayload(body);
  const result = await createRoom({
    connection: auth.auth.connection,
    input,
    actor: auth.auth.user,
    request,
    now: deps.now,
  });
  return hotelSuccess(result, { status: 201 });
}

export async function handleGetRoom(request, context, deps = {}) {
  const auth = await authorizeHotelRequest(request, {
    permission: HOTEL_PERMISSIONS.ROOMS_READ,
    connect: deps.connect,
    allowedOrigins: deps.allowedOrigins,
      authenticate: deps.authenticate,
  });
  if (!auth.ok) return auth.response;

  const result = await getRoom({
    connection: auth.auth.connection,
    id: await routeId(context),
  });
  return hotelSuccess(result);
}

export async function handleUpdateRoom(request, context, deps = {}) {
  const auth = await authorizeHotelRequest(request, {
    permission: HOTEL_PERMISSIONS.ROOMS_MANAGE,
    mutation: true,
    connect: deps.connect,
    allowedOrigins: deps.allowedOrigins,
      authenticate: deps.authenticate,
  });
  if (!auth.ok) return auth.response;

  const body = await readHotelJsonBody(request);
  const input = validateRoomPayload(body, { partial: true });
  const result = await updateRoom({
    connection: auth.auth.connection,
    id: await routeId(context),
    input,
    actor: auth.auth.user,
    request,
  });
  return hotelSuccess(result);
}

export async function handleDeactivateRoom(request, context, deps = {}) {
  const auth = await authorizeHotelRequest(request, {
    permission: HOTEL_PERMISSIONS.ROOMS_MANAGE,
    mutation: true,
    connect: deps.connect,
    allowedOrigins: deps.allowedOrigins,
      authenticate: deps.authenticate,
  });
  if (!auth.ok) return auth.response;

  const result = await deactivateRoom({
    connection: auth.auth.connection,
    id: await routeId(context),
    actor: auth.auth.user,
    request,
  });
  return hotelSuccess(result);
}

export async function handleChangeRoomStatus(request, context, deps = {}) {
  const auth = await authorizeHotelRequest(request, {
    permission: HOTEL_PERMISSIONS.ROOMS_MANAGE,
    mutation: true,
    connect: deps.connect,
    allowedOrigins: deps.allowedOrigins,
      authenticate: deps.authenticate,
  });
  if (!auth.ok) return auth.response;

  const body = await readHotelJsonBody(request);
  const input = validateRoomStatusPayload(body);
  const result = await changeRoomStatus({
    connection: auth.auth.connection,
    id: await routeId(context),
    input,
    actor: auth.auth.user,
    request,
    now: deps.now,
  });
  return hotelSuccess(result);
}
