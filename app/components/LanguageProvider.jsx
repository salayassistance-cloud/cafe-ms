"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
} from "react";
import {
  defaultLang,
  STORAGE_KEY,
  SUPPORTED_LANGS,
  translate,
} from "@/lib/translations";

// Global i18n context for the Executive POS. Default language is Amharic; the
// choice is persisted in localStorage (`hms_lang`) so it survives refreshes
// and navigation. `t(key)` always returns a safe fallback string.

const LanguageContext = createContext(null);

export function LanguageProvider({ children }) {
  const [lang, setLangState] = useState(defaultLang);
  const [hydrated, setHydrated] = useState(false);

  // Hydrate the persisted preference only AFTER the first client mount to
  // prevent React Hydration Mismatch (server renders defaultLang, client
  // must match until useEffect fires).
  useEffect(() => {
    let active = true;
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (SUPPORTED_LANGS.includes(saved)) {
        // Defer so setState isn't synchronous within the effect body.
        setTimeout(() => {
          if (active) setLangState(saved);
        }, 0);
      }
    } catch {
      /* storage unavailable — keep default */
    }
    setTimeout(() => {
      if (active) setHydrated(true);
    }, 0);
    return () => {
      active = false;
    };
  }, []);

  const setLang = useCallback((next) => {
    const value = SUPPORTED_LANGS.includes(next) ? next : defaultLang;
    setLangState(value);
    try {
      window.localStorage.setItem(STORAGE_KEY, value);
    } catch {
      /* ignore */
    }
  }, []);

  const t = useCallback((key) => translate(lang, key), [lang]);

  return (
    <LanguageContext.Provider value={{ lang, setLang, t }}>
      {children}
    </LanguageContext.Provider>
  );
}

// Safe consumer: returns a no-op fallback if used outside the provider so a
// missing wrapper can never crash a component.
export function useLanguage() {
  const ctx = useContext(LanguageContext);
  if (!ctx) {
    return {
      lang: defaultLang,
      setLang: () => {},
      t: (key) => translate(defaultLang, key),
    };
  }
  return ctx;
}
