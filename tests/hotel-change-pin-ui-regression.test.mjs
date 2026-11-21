// Regression guards for the Hotel self-service PIN change UI defect (F-23b).
//
// The server correctly revokes every Hotel session for the identity on a PIN
// change. The previous client left the stale authenticated page on screen
// because it never asked the server layout to re-read the (now revoked) cookie.
// These tests pin the client-side contract that closes that gap:
//
//   successful change -> clear inputs -> close modal -> router.refresh()
//
// The end-to-end credential behavior itself is covered behaviorally by
// tests/hotel-pin-change-route.test.mjs. These assertions are structural
// (SOURCE-INSPECTED) because the repository has no React DOM test harness;
// they prevent the refresh call from being silently removed again.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

const source = readFileSync(
  new URL("../app/components/hotel/HotelChangePinModal.jsx", import.meta.url),
  "utf8"
);

function successBranch() {
  const start = source.indexOf("if (response.ok && data?.success)");
  assert.notEqual(start, -1, "success branch must exist");
  const end = source.indexOf("} else {", start);
  assert.notEqual(end, -1, "success branch must have an else");
  return source.slice(start, end);
}

describe("Hotel change-PIN modal post-success behavior", () => {
  test("uses the Next router so the server layout can re-validate", () => {
    assert.match(source, /import\s*\{\s*useRouter\s*\}\s*from\s*"next\/navigation"/);
    assert.match(source, /const\s+router\s*=\s*useRouter\(\)/);
  });

  test("refreshes the server layout after a successful change", () => {
    const branch = successBranch();
    assert.match(branch, /router\.refresh\(\)/);
    const refreshAt = branch.indexOf("router.refresh()");
    const closeAt = branch.indexOf("onClose?.()");
    assert.notEqual(closeAt, -1, "the modal must close after success");
    assert.ok(refreshAt > closeAt, "refresh must follow the modal close");
  });

  test("clears all PIN inputs after success and on cancel", () => {
    const branch = successBranch();
    for (const setter of ["setCurrentPin(\"\")", "setNewPin(\"\")", "setConfirmPin(\"\")"]) {
      assert.ok(branch.includes(setter), `success must call ${setter}`);
    }
    const cancelStart = source.indexOf("function closeIfIdle()");
    const cancelEnd = source.indexOf("\n  }", cancelStart);
    const cancel = source.slice(cancelStart, cancelEnd);
    for (const setter of ["setCurrentPin(\"\")", "setNewPin(\"\")", "setConfirmPin(\"\")"]) {
      assert.ok(cancel.includes(setter), `cancel must call ${setter}`);
    }
  });

  test("still forwards the memory-only CSRF token and never selects a target", () => {
    assert.match(source, /headers\[HOTEL_CSRF_HEADER\]\s*=\s*session\.csrfToken/);
    assert.ok(!/staffId|hotelUserId|identityId/.test(source));
    assert.ok(!/localStorage|sessionStorage/.test(source));
  });
});
