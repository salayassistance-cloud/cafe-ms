"use client";

// Hotel-scoped translation hook.
//
// The Hotel screens share the app-wide language selection (`hms_lang`) with the
// POS, but use their own semantic dictionary so Hotel copy never depends on POS
// translation keys. `t(key, vars, fallback)` resolves in the active language,
// then English, then the explicit fallback.

import { useCallback } from "react";
import { useLanguage } from "@/app/components/LanguageProvider";
import { translateHotel } from "@/lib/hotel/uiTranslations";

export function useHotelI18n() {
  const { lang, setLang } = useLanguage();

  const t = useCallback(
    (key, vars, fallback) => translateHotel(lang, key, vars, fallback),
    [lang]
  );

  return { lang, setLang, t };
}
