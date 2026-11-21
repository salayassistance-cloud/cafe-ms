// Hotel-only protected-route gate.
//
// Read routes authenticate and check the permission matrix. Mutation routes
// additionally require an exact Origin and the session-bound CSRF header before
// any body parsing or database write.

import { authenticateHotelRequest } from "../auth/service.js";
import { hotelFailure } from "./apiResponse.js";
import {
  assertHotelRequestOrigin,
  readHotelCsrfHeader,
} from "./requestSecurity.js";

export async function authorizeHotelRequest(
  request,
  {
    permission,
    allowedRoles = null,
    mutation = false,
    connect,
    allowedOrigins,
  } = {}
) {
  if (mutation) {
    assertHotelRequestOrigin(request, { allowedOrigins });
  }

  const auth = await authenticateHotelRequest(request, {
    permission,
    allowedRoles,
    connect,
    requireCsrf: mutation,
    csrfToken: mutation ? readHotelCsrfHeader(request) : null,
  });

  if (!auth.ok) {
    return { ok: false, response: hotelFailure(auth) };
  }
  return { ok: true, auth };
}
