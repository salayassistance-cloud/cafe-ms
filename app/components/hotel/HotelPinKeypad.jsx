"use client";

// Hotel-specific 4-digit PIN keypad. Visual and interaction parity with the
// POS reference (C:\bonosm\app\components\PinKeypad.js):
// four entry dots, 1-9 / Clear / 0 / backspace grid, exact POS palette and
// spacing. Enter submits the same canonical onSubmit as the Verify button.
// This is a NEW Hotel component; the POS keypad itself is never modified.

import { useEffect } from "react";

import {
  appendPinDigit,
  backspacePin,
  isCompletePin,
  sanitizePinDigits,
} from "@/lib/hotel/ui/pinEntry";

export default function HotelPinKeypad({
  value = "",
  onChange,
  onSubmit,
  disabled = false,
  submitLabel = "Verify",
  hideSubmit = false,
}) {
  const digits = sanitizePinDigits(value);

  useEffect(() => {
    function onKey(event) {
      if (!event || event.key !== "Enter") return;
      const target = event.target;
      if (
        target &&
        target.closest &&
        target.closest("button,input,select,textarea,a,[contenteditable]")
      ) {
        return;
      }
      if (disabled || !isCompletePin(digits) || !onSubmit) return;
      event.preventDefault();
      onSubmit(digits);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [digits, disabled, onSubmit]);

  function press(digit) {
    if (disabled) return;
    onChange(appendPinDigit(digits, digit));
  }
  function back() {
    if (disabled) return;
    onChange(backspacePin(digits));
  }
  function clear() {
    if (disabled) return;
    onChange("");
  }

  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];

  return (
    <div className="w-full">
      {/* PIN dots — POS reference: 4 x h-3.5 w-3.5, gap-3, 150ms transition */}
      <div className="mb-5 flex items-center justify-center gap-3">
        {[0, 1, 2, 3].map((i) => (
          <span
            key={i}
            className={`h-3.5 w-3.5 rounded-full transition-colors duration-150 ${
              i < digits.length
                ? "bg-[#FFD600] dark:bg-[#FF5E00] shadow-inner"
                : "bg-[#CBD5E1] dark:bg-[#2E303E] border border-[#E2E8F0]/60 dark:border-[#2A2B36]"
            }`}
          />
        ))}
      </div>

      {/* Keypad grid — POS reference: max-w-[260px], 3 cols, gap-2.5, h-14 */}
      <div className="mx-auto grid w-full max-w-[260px] grid-cols-3 gap-2.5">
        {keys.map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => press(key)}
            disabled={disabled}
            className="flex h-14 w-full items-center justify-center rounded-xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#1C1D24] text-xl font-bold text-[#1E293B] dark:text-white shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05),0_8px_10px_-6px_rgba(0,0,0,0.01)] dark:shadow-[0_12px_30px_rgba(0,0,0,0.45)] transition-all duration-150 ease-out   hover:bg-[#FFD600] dark:hover:bg-[#FF5E00] hover:text-[#1E293B] dark:hover:text-white   active:shadow-inner disabled:opacity-40"
          >
            {key}
          </button>
        ))}
        <button
          type="button"
          onClick={clear}
          disabled={disabled}
          className="flex h-14 w-full items-center justify-center rounded-xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#1C1D24] text-sm font-bold uppercase tracking-wide text-[#1E293B] dark:text-white shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05),0_8px_10px_-6px_rgba(0,0,0,0.01)] dark:shadow-[0_12px_30px_rgba(0,0,0,0.45)] transition-all duration-150 ease-out   hover:bg-[#FFD600] dark:hover:bg-[#FF5E00] hover:text-[#1E293B] dark:hover:text-white   active:shadow-inner disabled:opacity-40"
        >
          Clear
        </button>
        <button
          type="button"
          onClick={() => press("0")}
          disabled={disabled}
          className="flex h-14 w-full items-center justify-center rounded-xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#1C1D24] text-xl font-bold text-[#1E293B] dark:text-white shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05),0_8px_10px_-6px_rgba(0,0,0,0.01)] dark:shadow-[0_12px_30px_rgba(0,0,0,0.45)] transition-all duration-150 ease-out   hover:bg-[#FFD600] dark:hover:bg-[#FF5E00] hover:text-[#1E293B] dark:hover:text-white   active:shadow-inner disabled:opacity-40"
        >
          0
        </button>
        <button
          type="button"
          onClick={back}
          disabled={disabled}
          aria-label="Backspace"
          className="flex h-14 w-full items-center justify-center rounded-xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#1C1D24] text-xl text-[#1E293B] dark:text-white shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05),0_8px_10px_-6px_rgba(0,0,0,0.01)] dark:shadow-[0_12px_30px_rgba(0,0,0,0.45)] transition-all duration-150 ease-out   hover:bg-[#FFD600] dark:hover:bg-[#FF5E00] hover:text-[#1E293B] dark:hover:text-white   active:shadow-inner disabled:opacity-40"
        >
          ⌫
        </button>
      </div>

      {!hideSubmit && (
        <button
          type="button"
          onClick={() => !disabled && onSubmit && onSubmit(digits)}
          disabled={disabled || !isCompletePin(digits)}
          className="mx-auto mt-4 flex h-12 w-full max-w-[260px] items-center justify-center rounded-xl bg-[#FFD600] dark:bg-[#FF5E00] text-sm font-black uppercase tracking-wide text-[#1E293B] dark:text-white shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05),0_8px_10px_-6px_rgba(0,0,0,0.01)] dark:shadow-[0_12px_30px_rgba(0,0,0,0.45)] transition-all duration-150 ease-out     active:shadow-inner disabled:cursor-not-allowed disabled:opacity-40"
        >
          {submitLabel}
        </button>
      )}
    </div>
  );
}
