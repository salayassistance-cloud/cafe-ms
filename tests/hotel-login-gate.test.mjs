// Real behavioural tests for the Hotel PIN entry/keypad logic.
//
// These import the same pure module the keypad and sign-in gate use, so the
// assertions exercise actual append/backspace/clear/submit behaviour rather
// than matching source text. No DOM, no database, no network.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  HOTEL_PIN_LENGTH,
  appendPinDigit,
  backspacePin,
  canSubmitPin,
  filterIdentitiesForRole,
  isCompletePin,
  sanitizePinDigits,
} from "../lib/hotel/ui/pinEntry.js";

describe("Hotel PIN keypad behaviour", () => {
  test("numeric keys append up to exactly four digits", () => {
    let pin = "";
    for (const digit of ["1", "2", "3", "4"]) {
      pin = appendPinDigit(pin, digit);
      assert.equal(pin.length, ["1", "2", "3", "4"].indexOf(digit) + 1);
    }
    assert.equal(pin, "1234");
    assert.equal(HOTEL_PIN_LENGTH, 4);
  });

  test("a fifth digit is ignored once four digits are entered", () => {
    assert.equal(appendPinDigit("1234", "5"), "1234");
    assert.equal(appendPinDigit("0000", "9"), "0000");
  });

  test("non-digit keys never change the entry", () => {
    assert.equal(appendPinDigit("12", "a"), "12");
    assert.equal(appendPinDigit("12", "!"), "12");
    assert.equal(appendPinDigit("12", ""), "12");
    assert.equal(appendPinDigit("12", null), "12");
  });

  test("backspace removes exactly one digit", () => {
    assert.equal(backspacePin("1234"), "123");
    assert.equal(backspacePin("7"), "");
    assert.equal(backspacePin(""), "");
  });

  test("sanitize strips non-digits and caps at four", () => {
    assert.equal(sanitizePinDigits("12ab34"), "1234");
    assert.equal(sanitizePinDigits("123456"), "1234");
    assert.equal(sanitizePinDigits(null), "");
    assert.equal(sanitizePinDigits(undefined), "");
  });

  test("completion requires exactly four ASCII digits", () => {
    assert.equal(isCompletePin("1234"), true);
    assert.equal(isCompletePin(1234), true);
    assert.equal(isCompletePin("123"), false);
    assert.equal(isCompletePin("12345"), false);
    assert.equal(isCompletePin("12a4"), false);
    assert.equal(isCompletePin(""), false);
  });
});

describe("Hotel login readiness", () => {
  test("Verify is enabled only with a selected identity and four digits", () => {
    assert.equal(canSubmitPin({ pin: "1234", identityId: "abc" }), true);
    assert.equal(canSubmitPin({ pin: "123", identityId: "abc" }), false);
    assert.equal(canSubmitPin({ pin: "1234", identityId: "" }), false);
    assert.equal(
      canSubmitPin({ pin: "1234", identityId: "abc", busy: true }),
      false
    );
  });

  test("the exact reported failure is reproduced: no Receptionist => no submit", () => {
    // The live directory currently contains only a MANAGER identity.
    const directory = [
      { id: "m1", name: "Hotel Manager", role: "MANAGER" },
    ];
    const receptionists = filterIdentitiesForRole(directory, "RECEPTIONIST");
    assert.deepEqual(receptionists, []);
    assert.equal(
      canSubmitPin({
        pin: "1234",
        identityId: receptionists[0]?.id || "",
      }),
      false
    );
    // The Manager portal does receive its identity and can submit.
    const managers = filterIdentitiesForRole(directory, "MANAGER");
    assert.equal(managers.length, 1);
    assert.equal(canSubmitPin({ pin: "1234", identityId: managers[0].id }), true);
  });

  test("identities are scoped to the portal role", () => {
    const directory = [
      { id: "m1", name: "Manager", role: "MANAGER" },
      { id: "r1", name: "Reception One", role: "RECEPTIONIST" },
      { id: "r2", name: "Reception Two", role: "RECEPTIONIST" },
    ];
    assert.deepEqual(
      filterIdentitiesForRole(directory, "RECEPTIONIST").map((i) => i.id),
      ["r1", "r2"]
    );
    assert.deepEqual(
      filterIdentitiesForRole(directory, "MANAGER").map((i) => i.id),
      ["m1"]
    );
    assert.deepEqual(filterIdentitiesForRole(null, "MANAGER"), []);
    assert.deepEqual(filterIdentitiesForRole(directory, ""), []);
  });
});
