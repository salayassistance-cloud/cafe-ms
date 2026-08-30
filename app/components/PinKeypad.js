"use client";

// Reusable 4-digit PIN keypad — Exact palette spec: #F4F5F9/#FFFFFF/#FFD600 light, #12131A/#1C1D24/#FF5E00 dark

export default function PinKeypad({
  value = "",
  onChange,
  onSubmit,
  disabled = false,
  submitLabel = "Verify",
  hideSubmit = false,
}) {
  const digits = String(value).slice(0, 4);

  function press(d) {
    if (disabled) return;
    if (digits.length < 4) onChange(digits + d);
  }
  function back() {
    if (disabled) return;
    onChange(digits.slice(0, -1));
  }
  function clear() {
    if (disabled) return;
    onChange("");
  }

  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];

  return (
    <div className="w-full">
      {/* PIN dots */}
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

      {/* Keypad grid */}
      <div className="mx-auto grid w-full max-w-[260px] grid-cols-3 gap-2.5">
        {keys.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => press(k)}
            disabled={disabled}
            className="flex h-14 w-full items-center justify-center rounded-xl border border-[#E2E8F0]/60 dark:border-[#2A2B36] bg-white dark:bg-[#1C1D24] text-xl font-bold text-[#1E293B] dark:text-white shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05),0_8px_10px_-6px_rgba(0,0,0,0.01)] dark:shadow-[0_12px_30px_rgba(0,0,0,0.45)] transition-all duration-150 ease-out   hover:bg-[#FFD600] dark:hover:bg-[#FF5E00] hover:text-[#1E293B] dark:hover:text-white   active:shadow-inner disabled:opacity-40"
          >
            {k}
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
          disabled={disabled || digits.length !== 4}
          className="mx-auto mt-4 flex h-12 w-full max-w-[260px] items-center justify-center rounded-xl bg-[#FFD600] dark:bg-[#FF5E00] text-sm font-black uppercase tracking-wide text-[#1E293B] dark:text-white shadow-[0_10px_25px_-5px_rgba(0,0,0,0.05),0_8px_10px_-6px_rgba(0,0,0,0.01)] dark:shadow-[0_12px_30px_rgba(0,0,0,0.45)] transition-all duration-150 ease-out     active:shadow-inner disabled:cursor-not-allowed disabled:opacity-40"
        >
          {submitLabel}
        </button>
      )}
    </div>
  );
}
