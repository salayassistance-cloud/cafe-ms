// Hotel session page-entry contract tests — DB-free and DOM-free.
//
// These tests protect the fix for the visible "Checking Hotel session…" delay:
// the session is resolved once per entry by the /hotel server layout, shared
// through a layout-scoped client provider, and reused across sub-page
// navigation instead of being re-bootstrapped by every page shell.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => readFileSync(join(root, relativePath), "utf8");

const layoutSource = read("app/hotel/layout.js");
const serverSessionSource = read("lib/hotel/auth/serverSession.js");
const providerSource = read("app/components/hotel/HotelSessionProvider.jsx");
const gateSource = read("app/components/hotel/HotelSessionGate.jsx");

const shells = [
  ["ReceptionUI", "app/components/hotel/ReceptionUI.jsx"],
  ["RoomsUI", "app/components/hotel/RoomsUI.jsx"],
  ["RoomReportsUI", "app/components/hotel/RoomReportsUI.jsx"],
].map(([name, path]) => [name, read(path)]);

const requestHookSource = read("app/components/hotel/useHotelRequest.js");

describe("Hotel server layout session gate", () => {
  test("resolves the Hotel session on the server before rendering children", () => {
    assert.match(layoutSource, /export const dynamic = "force-dynamic"/);
    assert.match(layoutSource, /export default async function HotelLayout/);
    assert.match(layoutSource, /await getHotelServerSession\(\)/);
    assert.match(layoutSource, /if \(!result\.ok\)/);
    assert.match(layoutSource, /<HotelSessionGate reason=\{result\.reason\} \/>/);
    assert.match(layoutSource, /<HotelSessionProvider session=\{result\.session\}>/);
    assert.match(layoutSource, /\{children\}/);
  });

  test("uses only Hotel auth infrastructure, never POS guards or sessions", () => {
    for (const forbidden of [
      "getPortalSession",
      "PinGuard",
      "PinLoginModal",
      "@/_lib/pos",
      "@/lib/sessionClient",
      "@/lib/clientFetch",
      "@/lib/mongodb",
    ]) {
      assert.ok(!layoutSource.includes(forbidden), `layout must not use ${forbidden}`);
    }
    assert.match(layoutSource, /@\/lib\/hotel\/auth\/serverSession/);
  });
});

describe("Hotel server session resolver", () => {
  test("reads the Hotel cookie and validates it against the Hotel database", () => {
    assert.match(serverSessionSource, /from "next\/headers"/);
    assert.match(serverSessionSource, /await cookies\(\)/);
    assert.match(serverSessionSource, /HOTEL_SESSION_COOKIE/);
    assert.match(serverSessionSource, /connectToHotelDatabase\(\)/);
    assert.match(serverSessionSource, /resolveHotelSession\(connection, rawToken/);
    assert.match(serverSessionSource, /deriveHotelSessionCsrfToken\(rawToken\)/);
  });

  test("is read-only and fails closed without leaking details", () => {
    assert.match(serverSessionSource, /touch: false/);
    assert.ok(!serverSessionSource.includes("updateOne"));
    assert.ok(!serverSessionSource.includes("deleteOne"));
    assert.match(serverSessionSource, /reason: "no-session"/);
    assert.match(serverSessionSource, /reason: "unavailable"/);
    assert.match(serverSessionSource, /catch \{/);
  });
});

describe("Hotel layout-scoped session provider", () => {
  test("is a client context provider with no browser storage", () => {
    assert.match(providerSource, /^"use client"/);
    assert.match(providerSource, /createContext/);
    assert.match(providerSource, /export function useHotelSession/);
    for (const forbidden of ["localStorage", "sessionStorage", "document.cookie"]) {
      assert.ok(!providerSource.includes(forbidden));
    }
  });

  test("sign-in gate renders no login form and issues no authentication request", () => {
    assert.match(gateSource, /^"use client"/);
    assert.ok(!gateSource.includes("HotelPinLogin"));
    assert.ok(!gateSource.includes("useRouter"));
    assert.ok(!gateSource.includes("router.push"));
    assert.ok(!gateSource.includes("/api/hotel/auth"));
    assert.ok(!gateSource.includes("<input"));
    assert.match(gateSource, /session\.required/);
    assert.match(gateSource, /session\.unavailable/);
    assert.match(gateSource, /role="status"/);
  });
});

describe("Hotel page shells reuse the verified session", () => {
  for (const [name, source] of shells) {
    test(`${name} uses the shared request wrapper with no duplicate bootstrap`, () => {
      assert.match(
        source,
        /import \{ useHotelRequest \} from "\.\/useHotelRequest"/,
        `${name} must consume the shared request wrapper`
      );
      assert.match(source, /const request = useHotelRequest\(\)/);
      assert.ok(
        !source.includes("/api/hotel/auth/me"),
        `${name} must not repeat the session bootstrap`
      );
      assert.ok(!/authState|setAuthState/.test(source));
      assert.ok(!source.includes("ReceptionLogin"));
    });
  }

  test("the shared wrapper reads CSRF from the layout provider without a request", () => {
    assert.match(requestHookSource, /useHotelSession\(\)/);
    assert.match(requestHookSource, /csrfToken: session\?\.csrfToken \|\| null/);
    assert.ok(!requestHookSource.includes("/api/hotel/auth/me"));
    assert.match(requestHookSource, /router\.refresh\(\)/);
  });
});

describe("Hotel session module import/export consistency", () => {
  test("layout's provider import matches the provider's actual export", () => {
    // Regression guard: a default import of a named-only export resolves to
    // undefined and makes React throw "Element type is invalid" in HotelLayout.
    assert.match(
      layoutSource,
      /import \{ HotelSessionProvider \} from "@\/app\/components\/hotel\/HotelSessionProvider"/
    );
    assert.match(
      providerSource,
      /export function HotelSessionProvider\(\{ session, children \}\)/
    );
    assert.ok(
      !/import HotelSessionProvider from /.test(layoutSource),
      "layout must not default-import a named-only provider export"
    );
  });

  test("layout's gate and resolver imports match their exports", () => {
    assert.match(
      layoutSource,
      /import HotelSessionGate from "@\/app\/components\/hotel\/HotelSessionGate"/
    );
    assert.match(gateSource, /export default function HotelSessionGate/);
    assert.match(
      layoutSource,
      /import \{ getHotelServerSession \} from "@\/lib\/hotel\/auth\/serverSession"/
    );
    assert.match(
      serverSessionSource,
      /export async function getHotelServerSession\(\)/
    );
  });

  test("shells' shared hook imports match their actual exports", () => {
    assert.match(providerSource, /export function useHotelSession\(\)/);
    assert.match(requestHookSource, /export function useHotelRequest\(\)/);
    for (const [name, source] of shells) {
      assert.match(
        source,
        /import \{ useHotelRequest \} from "\.\/useHotelRequest"/,
        `${name} must named-import the shared request hook`
      );
      if (source.includes("useHotelSession()")) {
        assert.match(
          source,
          /import \{ useHotelSession \} from "\.\/HotelSessionProvider"/,
          `${name} must named-import the provider hook`
        );
      }
    }
  });
});
