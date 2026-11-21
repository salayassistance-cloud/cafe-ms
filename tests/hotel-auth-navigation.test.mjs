// Regression coverage for the Hotel authentication/navigation lifecycle defect:
// after "logout" the Manager routes (Rooms, Reports, Management) appeared to
// bounce back to Reception.
//
// The portal resolution tests import the SAME pure module used by the real
// sign-in gate, so they exercise actual routing behaviour. The remaining tests
// are source contracts for the server guards, logout wiring, and cache policy,
// consistent with the repository's DB-free Hotel test strategy.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import {
  HOTEL_PORTALS,
  hotelHomeForRole,
  isAuthorizedDestinationForRole,
  resolveHotelPortal,
} from "../lib/hotel/ui/portals.js";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("Hotel sign-in gate portal resolution (behavioural)", () => {
  test("every protected route resolves to its own portal and role", () => {
    const cases = [
      ["/hotel/rooms", "ROOMS", "MANAGER", "/hotel/rooms"],
      ["/hotel/management", "MANAGEMENT", "MANAGER", "/hotel/management"],
      ["/hotel/reports", "REPORTS", "MANAGER", "/hotel/reports"],
      ["/hotel/reception", "RECEPTION", "RECEPTIONIST", "/hotel/reception"],
    ];
    for (const [path, key, role, destination] of cases) {
      const portal = resolveHotelPortal(path);
      assert.equal(portal.key, key, path);
      assert.equal(portal.role, role, path);
      assert.equal(portal.destination, destination, path);
    }
  });

  test("Manager routes never silently become a Reception route", () => {
    for (const path of ["/hotel/rooms", "/hotel/management", "/hotel/reports"]) {
      assert.equal(resolveHotelPortal(path).role, "MANAGER");
      assert.notEqual(resolveHotelPortal(path).key, "RECEPTION");
    }
  });

  test("Reception stays a Receptionist-only portal", () => {
    const portal = resolveHotelPortal("/hotel/reception");
    assert.equal(portal.role, "RECEPTIONIST");
    assert.equal(portal.destination, "/hotel/reception");
  });

  test("unknown /hotel paths fall back to the MANAGER-safe Rooms portal", () => {
    for (const path of ["/hotel/unknown", "/hotel", "", null]) {
      assert.equal(resolveHotelPortal(path).key, "ROOMS");
      assert.equal(resolveHotelPortal(path).role, "MANAGER");
    }
  });

  test("query strings, hashes and trailing slashes do not change the portal", () => {
    assert.equal(resolveHotelPortal("/hotel/management/").key, "MANAGEMENT");
    assert.equal(resolveHotelPortal("/hotel/reports?range=today").key, "REPORTS");
    assert.equal(resolveHotelPortal("/hotel/reception#guests").key, "RECEPTION");
  });

  test("post-login destinations are role-authorized", () => {
    assert.equal(hotelHomeForRole("MANAGER"), "/hotel/rooms");
    assert.equal(hotelHomeForRole("RECEPTIONIST"), "/hotel/reception");
    for (const path of ["/hotel/rooms", "/hotel/management", "/hotel/reports"]) {
      assert.equal(isAuthorizedDestinationForRole("MANAGER", path), true);
      assert.equal(isAuthorizedDestinationForRole("RECEPTIONIST", path), false);
    }
    assert.equal(isAuthorizedDestinationForRole("RECEPTIONIST", "/hotel/reception"), true);
    assert.equal(isAuthorizedDestinationForRole("MANAGER", "/hotel/reception"), false);
    assert.equal(isAuthorizedDestinationForRole(null, "/hotel/rooms"), false);
  });

  test("the portal map has exactly the four supported destinations", () => {
    assert.deepEqual(Object.keys(HOTEL_PORTALS).sort(), [
      "MANAGEMENT",
      "RECEPTION",
      "REPORTS",
      "ROOMS",
    ]);
  });
});

describe("Hotel server guard does not bounce signed-out Manager routes", () => {
  const source = read("../lib/hotel/auth/serverSession.js");

  test("missing session returns null instead of redirecting", () => {
    assert.match(
      source,
      /if \(!result\.ok\) return null;/
    );
    // The old combined condition redirected on a missing session too.
    assert.doesNotMatch(source, /if \(!result\.ok \|\|/);
  });

  test("a live wrong-role session is still denied server-side", () => {
    assert.match(
      source,
      /if \(result\.session\?\.role !== requiredRole\) \{\s*redirect\(deniedHref\);/
    );
  });

  test("every protected page renders nothing while the gate is shown", () => {
    for (const page of [
      "../app/hotel/rooms/page.js",
      "../app/hotel/management/page.js",
      "../app/hotel/reports/page.js",
      "../app/hotel/reception/page.js",
    ]) {
      const text = read(page);
      assert.match(text, /requireHotelPageRole\(/, page);
      assert.match(text, /if \(!session\) return null;/, page);
    }
  });
});

describe("Hotel login gate preserves the requested route", () => {
  const source = read("../app/components/hotel/HotelLoginGate.jsx");

  test("gate resolves its portal from the pure routing module", () => {
    assert.match(source, /resolveHotelPortal\(pathname\)/);
    assert.doesNotMatch(source, /PORTALS\[portalForPath/);
  });

  test("post-login destination is validated, not role-hardcoded", () => {
    assert.match(source, /isAuthorizedDestinationForRole\(\s*role,\s*portal\.destination\s*\)/);
    assert.doesNotMatch(source, /data\?\.data\?\.role === "MANAGER"\s*\?\s*"\/hotel\/rooms"/);
  });

  test("PIN-only keypad controls are preserved", () => {
    assert.match(source, /<HotelPinKeypad/);
    assert.match(source, /credentials:\s*"include"/);
    const keypad = read("../app/components/hotel/HotelPinKeypad.jsx");
    assert.match(keypad, /Clear/);
    assert.match(keypad, /Backspace/);
    assert.match(keypad, /\["1", "2", "3", "4", "5", "6", "7", "8", "9"\]/);
    assert.match(keypad, /press\("0"\)/);
  });
});

describe("Hotel logout lifecycle is user-accessible and server-authoritative", () => {
  const button = read("../app/components/hotel/HotelLogoutButton.jsx");
  const topBar = read("../app/components/hotel/HotelTopBar.jsx");
  const api = read("../app/api/hotel/auth/logout/route.js");

  test("a logout control is rendered on every protected Hotel page", () => {
    assert.match(topBar, /<HotelLogoutButton \/>/);
    for (const page of [
      "../app/components/hotel/RoomsUI.jsx",
      "../app/components/hotel/RoomReportsUI.jsx",
      "../app/components/hotel/ReceptionUI.jsx",
      "../app/components/hotel/HotelStaffManagementUI.jsx",
    ]) {
      assert.match(read(page), /<HotelTopBar/, page);
    }
  });

  test("logout posts to the Hotel endpoint through the CSRF-aware wrapper", () => {
    assert.match(button, /useHotelRequest\(\)/);
    assert.match(button, /request\("\/api\/hotel\/auth\/logout", \{ method: "POST" \}\)/);
  });

  test("client refreshes only after a successful server response", () => {
    assert.match(button, /await request\("\/api\/hotel\/auth\/logout"[^\n]*\);[\s\S]*router\.refresh\(\);/);
    const catchBlock = /catch \{[\s\S]*?setError\(t\("session\.logoutError"\)\)/;
    assert.match(button, catchBlock);
    assert.doesNotMatch(button, /\b(?:window\.)?(?:localStorage|sessionStorage)\s*\./);
  });

  test("server logout still revokes the session and expires the cookie", () => {
    assert.match(api, /revokeHotelSession\(connection, rawToken, "LOGOUT"\)/);
    assert.match(api, /verifyHotelSessionCsrf\(resolved\.session, csrfToken, rawToken\)/);
    assert.match(api, /HOTEL_SESSION_COOKIE_DELETE_OPTS/);
    assert.match(api, /assertHotelRequestOrigin\(request\)/);
    assert.match(api, /checkHotelRateLimit\(/);
  });
});

describe("Protected Hotel pages cannot be reused from cache", () => {
  const config = read("../next.config.mjs");
  const layout = read("../app/hotel/layout.js");
  const guard = read("../app/components/hotel/HotelCacheGuard.jsx");

  test("Hotel HTML is served with no-store", () => {
    assert.match(config, /source: "\/hotel\/:path\*"/);
    assert.match(config, /no-store, no-cache, must-revalidate, proxy-revalidate/);
    // Edge enforcement as well (the Next dev server rewrites page Cache-Control,
    // so the proxy rule is what protects other runtimes).
    const proxy = read("../proxy.js");
    assert.match(proxy, /pathname\.startsWith\("\/hotel\/"\)/);
    assert.match(proxy, /"no-store, no-cache, must-revalidate, proxy-revalidate"/);
    assert.match(proxy, /matcher: \["\/api\/:path\*", "\/hotel\/:path\*"\]/);
  });

  test("back/forward cache restores re-validate with the server", () => {
    assert.match(layout, /HotelCacheGuard/);
    assert.match(guard, /event\.persisted/);
    assert.match(guard, /router\.refresh\(\)/);
  });
});
