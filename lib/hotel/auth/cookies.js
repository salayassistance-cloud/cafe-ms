// Hotel session cookie definition. No POS cookie is read or written here.
//
// __Host- prefix requires Secure, Path=/ and no Domain. This is why `secure`
// is always true; localhost remains a secure context in modern browsers.
import { HOTEL_SESSION_ABSOLUTE_MS, HOTEL_SESSION_COOKIE } from "../constants.js";

export { HOTEL_SESSION_COOKIE };

export const HOTEL_SESSION_COOKIE_OPTS = Object.freeze({
  httpOnly: true,
  secure: true,
  sameSite: "strict",
  path: "/",
  maxAge: Math.floor(HOTEL_SESSION_ABSOLUTE_MS / 1000),
});

export const HOTEL_SESSION_COOKIE_DELETE_OPTS = Object.freeze({
  httpOnly: true,
  secure: true,
  sameSite: "strict",
  path: "/",
  maxAge: 0,
});
