// Hotel-only payment and folio Route Handler logic.
//
// Recording and voiding require BILLING_MANAGE. Reading a folio or payment
// requires BILLING_READ. Mutations additionally require an exact Origin and the
// session-bound CSRF header. Both Hotel roles currently hold both permissions;
// authorization is still evaluated against the live HotelUser.role.
//
// There is no amount/method edit endpoint and no hard delete.

import { HOTEL_PERMISSIONS } from "../auth/authorization.js";
import { hotelSuccess } from "./apiResponse.js";
import { authorizeHotelRequest } from "./authorizedRequest.js";
import {
  readHotelJsonBody,
  readHotelOptionalJsonBody,
} from "./requestSecurity.js";
import {
  getHotelPayment,
  getStayFolio,
  recordStayPayment,
  voidHotelPayment,
} from "../services/payments.js";

async function routeId(context) {
  const params = (await context?.params) ?? {};
  return params.id;
}

export async function handleRecordStayPayment(request, context, deps = {}) {
  const auth = await authorizeHotelRequest(request, {
    permission: HOTEL_PERMISSIONS.BILLING_MANAGE,
    mutation: true,
    connect: deps.connect,
    allowedOrigins: deps.allowedOrigins,
  });
  if (!auth.ok) return auth.response;

  const body = await readHotelJsonBody(request);
  const result = await recordStayPayment({
    connection: auth.auth.connection,
    stayId: await routeId(context),
    input: body,
    actor: auth.auth.user,
    request,
    now: deps.now,
  });
  return hotelSuccess(result, { status: result.created ? 201 : 200 });
}

export async function handleGetStayFolio(request, context, deps = {}) {
  const auth = await authorizeHotelRequest(request, {
    permission: HOTEL_PERMISSIONS.BILLING_READ,
    connect: deps.connect,
    allowedOrigins: deps.allowedOrigins,
  });
  if (!auth.ok) return auth.response;

  const result = await getStayFolio({
    connection: auth.auth.connection,
    stayId: await routeId(context),
  });
  return hotelSuccess(result);
}

export async function handleGetHotelPayment(request, context, deps = {}) {
  const auth = await authorizeHotelRequest(request, {
    permission: HOTEL_PERMISSIONS.BILLING_READ,
    connect: deps.connect,
    allowedOrigins: deps.allowedOrigins,
  });
  if (!auth.ok) return auth.response;

  const result = await getHotelPayment({
    connection: auth.auth.connection,
    id: await routeId(context),
  });
  return hotelSuccess(result);
}

export async function handleVoidHotelPayment(request, context, deps = {}) {
  const auth = await authorizeHotelRequest(request, {
    permission: HOTEL_PERMISSIONS.BILLING_MANAGE,
    mutation: true,
    connect: deps.connect,
    allowedOrigins: deps.allowedOrigins,
  });
  if (!auth.ok) return auth.response;

  const body = await readHotelOptionalJsonBody(request);
  const result = await voidHotelPayment({
    connection: auth.auth.connection,
    paymentId: await routeId(context),
    input: body,
    actor: auth.auth.user,
    request,
    now: deps.now,
  });
  return hotelSuccess(result);
}
