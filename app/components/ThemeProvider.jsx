"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
} from "react";

// Global Light/Dark theme context for the Hotel Management System.
//
// STRICT 4-COLOUR PALETTE (see app/globals.css):
//   Gold #FFD700 · Charcoal #212529 · Off-White #FAFAFA · Silver #ADB5BD
//
// Hydration strategy (mirrors LanguageProvider): the server and the very first
// client render both assume "dark" so the markup matches exactly. The real
// preference is applied to <html> by an inline, pre-paint script in layout.js
// (preventing any flash), and reconciled from localStorage inside useEffect
// AFTER mount — never synchronously during render. This guarantees zero SSR/CSR
// hydration mismatches.

const STORAGE_KEY = "hotel_theme";

const ThemeContext = createContext(null);

export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState("dark");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    let active = true;
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      const next = saved === "light" || saved === "dark" ? saved : "dark";
      // Defer so setState isn't synchronous within the effect body.
      setTimeout(() => {
        if (!active) return;
        setTheme(next);
        document.documentElement.classList.toggle("dark", next === "dark");
      }, 0);
    } catch {
      /* storage unavailable — keep default */
    }
    setTimeout(() => {
      if (active) setMounted(true);
    }, 0);
    return () => {
      active = false;
    };
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next = prev === "dark" ? "light" : "dark";
      try {
        window.localStorage.setItem(STORAGE_KEY, next);
      } catch {
        /* ignore */
      }
      document.documentElement.classList.toggle("dark", next === "dark");
      return next;
    });
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme, mounted }}>
      {children}
    </ThemeContext.Provider>
  );
}

// Safe consumer: returns a no-op fallback if used outside the provider so a
// missing wrapper can never crash a component.
export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    return { theme: "dark", toggleTheme: () => {}, mounted: false };
  }
  return ctx;
}
