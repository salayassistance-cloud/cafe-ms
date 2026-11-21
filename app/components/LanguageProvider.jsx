"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useSyncExternalStore,
} from "react";
import {
  defaultLang,
  STORAGE_KEY,
  SUPPORTED_LANGS,
  translate,
} from "@/lib/translations";

// Global i18n context for BONO. Default language is Amharic; the choice is
// persisted in localStorage (`hms_lang`) so it survives refreshes and route
// changes. `t(key)` always returns a safe fallback string.
//
// Language is read through a single external store (useSyncExternalStore):
// the server and the first client (hydration) render snapshot use `defaultLang`,
// so there is no hydration mismatch; after hydration the persisted value is
// read synchronously. This replaces the old deferred setTimeout bootstrap,
// which flashed the default language and could overwrite a fast user click.

const LanguageContext = createContext(null);
const LANGUAGE_EVENT = "bono-language-change";

function subscribe(onStoreChange) {
  window.addEventListener(LANGUAGE_EVENT, onStoreChange);
  window.addEventListener("storage", onStoreChange);
  return () => {
    window.removeEventListener(LANGUAGE_EVENT, onStoreChange);
    window.removeEventListener("storage", onStoreChange);
  };
}

function readPersistedLang() {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    return SUPPORTED_LANGS.includes(saved) ? saved : defaultLang;
  } catch {
    return defaultLang;
  }
}

function getServerLang() {
  return defaultLang;
}

export function LanguageProvider({ children }) {
  // One source of truth — no duplicate local language state, no timeouts.
  const lang = useSyncExternalStore(subscribe, readPersistedLang, getServerLang);

  const setLang = useCallback((next) => {
    const value = SUPPORTED_LANGS.includes(next) ? next : defaultLang;
    try {
      window.localStorage.setItem(STORAGE_KEY, value);
    } catch {
      /* storage unavailable — keep the in-memory snapshot */
    }
    // Notify this provider (and any other mounted providers/tabs) immediately,
    // so the visible text and the selected segment update in the same commit.
    try {
      window.dispatchEvent(new Event(LANGUAGE_EVENT));
    } catch {
      /* ignore */
    }
  }, []);

  const t = useCallback((key) => translate(lang, key), [lang]);
  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t]);

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
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
