// Pure PIN-entry helpers shared by the Hotel login keypad and sign-in gate.
//
// No React, no DOM, no I/O: these functions are unit-testable in plain Node so
// keypad behaviour (append, backspace, clear, four-digit completion) can be
// verified as real logic rather than by asserting source text.

export const HOTEL_PIN_LENGTH = 4;

// Keep only ASCII digits and never exceed four. This is the single source of
// truth for the keypad's entry cap.
export function sanitizePinDigits(value) {
  return String(value ?? "")
    .replace(/\D/g, "")
    .slice(0, HOTEL_PIN_LENGTH);
}

// Append one digit when the entry is not already complete. Non-digits and
// overflow are ignored, matching the POS keypad's `digits.length < 4` guard.
export function appendPinDigit(value, digit) {
  const current = sanitizePinDigits(value);
  const next = String(digit ?? "")
    .replace(/\D/g, "")
    .slice(0, 1);
  if (!next || current.length >= HOTEL_PIN_LENGTH) return current;
  return current + next;
}

// Remove the last entered digit.
export function backspacePin(value) {
  return sanitizePinDigits(value).slice(0, -1);
}

// A PIN is submittable only when exactly four ASCII digits are present.
// Unlike sanitizePinDigits (which caps entry), this rejects over-long input.
export function isCompletePin(value) {
  return /^\d{4}$/.test(String(value ?? ""));
}

// The public directory lists every Hotel identity; each portal only offers the
// identities allowed to sign in there.
export function filterIdentitiesForRole(identities, role) {
  if (!Array.isArray(identities) || !role) return [];
  return identities.filter((item) => item && item.role === role);
}

// The Verify control and the Enter key share this predicate. It is false while
// a request is in flight, when no identity is selected, and before four digits.
export function canSubmitPin({ pin, identityId, busy = false } = {}) {
  return !busy && Boolean(identityId) && isCompletePin(pin);
}
