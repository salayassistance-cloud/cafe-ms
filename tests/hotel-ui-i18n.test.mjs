// Hotel Amharic/English UI coverage tests — DB-free and DOM-free.
//
// These tests protect the shared Hotel translation dictionary, the language
// infrastructure reused from the POS LanguageProvider, and the removal of
// redundant/technical Hotel copy. They never touch Mongo, the network, or any
// browser environment.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HOTEL_UI_TRANSLATIONS,
  translateHotel,
} from "../lib/hotel/uiTranslations.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => readFileSync(join(root, relativePath), "utf8");

const { en, am } = HOTEL_UI_TRANSLATIONS;

const shells = [
  "app/components/hotel/ReceptionUI.jsx",
  "app/components/hotel/RoomsUI.jsx",
  "app/components/hotel/RoomReportsUI.jsx",
];

const translatedSources = [
  "app/components/hotel/ReceptionUI.jsx",
  "app/components/hotel/RoomsUI.jsx",
  "app/components/hotel/RoomReportsUI.jsx",
  "app/components/hotel/HotelSessionGate.jsx",
  "app/components/hotel/ReservationsPanel.jsx",
  "app/components/hotel/InHousePanel.jsx",
  "app/components/hotel/GuestsPanel.jsx",
  "app/components/hotel/NewReservationModal.jsx",
  "app/components/hotel/RoomsPanel.jsx",
  "app/components/hotel/RoomTypesPanel.jsx",
  "app/components/hotel/RoomReportsPanel.jsx",
  "app/components/hotel/RoomInventoryReport.jsx",
  "app/components/hotel/ui.jsx",
  "app/components/hotel/HotelTopBar.jsx",
  "app/components/hotel/HotelLanguageToggle.jsx",
];

describe("Hotel translation dictionary", () => {
  test("keeps English and Amharic complete with identical keys", () => {
    const enKeys = Object.keys(en).sort();
    const amKeys = Object.keys(am).sort();
    assert.deepEqual(amKeys, enKeys, "both locales must define the same keys");

    for (const key of enKeys) {
      assert.equal(typeof en[key], "string", `en.${key} must be a string`);
      assert.ok(en[key].trim().length > 0, `en.${key} must not be empty`);
      assert.equal(typeof am[key], "string", `am.${key} must be a string`);
      assert.ok(am[key].trim().length > 0, `am.${key} must not be empty`);
      assert.ok(
        !am[key].includes("__AM__") && !am[key].includes("__EN__"),
        `am.${key} must not keep a placeholder marker`
      );
    }
  });

  test("interpolates variables and uses an explicit fallback, not a raw key", () => {
    assert.equal(
      translateHotel("en", "common.showing", { start: 1, end: 20, total: 42 }),
      "Showing 1–20 of 42"
    );
    assert.match(
      translateHotel("am", "common.showing", { start: 1, end: 20, total: 42 }),
      /1–20/
    );
    assert.equal(
      translateHotel("am", "missing.key", undefined, "Fallback copy"),
      "Fallback copy"
    );
    // Unknown keys fall back to English when it exists.
    assert.equal(
      translateHotel("am", "reports.title", undefined, "Fallback copy"),
      am["reports.title"]
    );
  });

  test("defines every static key used by the translated Hotel UI", () => {
    const missing = [];
    for (const relativePath of translatedSources) {
      const source = read(relativePath);
      const pattern = /\bt\(\s*["']([^"']+)["']/g;
      let match;
      while ((match = pattern.exec(source))) {
        const key = match[1];
        if (key.includes("${")) continue;
        if (!(key in en)) missing.push(`${relativePath}: ${key}`);
      }
    }
    assert.deepEqual([...new Set(missing)], []);
  });
});

describe("Hotel language infrastructure", () => {
  test("reuses the POS LanguageProvider and hms_lang persistence", () => {
    const hookSource = read("app/components/hotel/HotelI18n.jsx");
    assert.match(hookSource, /from "@\/app\/components\/LanguageProvider"/);
    assert.match(hookSource, /useLanguage\(\)/);
    assert.match(hookSource, /from "@\/lib\/hotel\/uiTranslations"/);
    assert.match(hookSource, /translateHotel\(lang, key, vars, fallback\)/);
  });

  test("renders an EN | አማ toggle that updates the shared language", () => {
    const toggleSource = read("app/components/hotel/HotelLanguageToggle.jsx");
    assert.match(toggleSource, /setLang\("en"\)/);
    assert.match(toggleSource, /setLang\("am"\)/);
    assert.match(toggleSource, />\s*EN\s*</);
    assert.match(toggleSource, />\s*አማ\s*</);
    assert.match(toggleSource, /aria-pressed=\{lang === "en"\}/);
    assert.match(toggleSource, /aria-pressed=\{lang === "am"\}/);
    assert.ok(
      toggleSource.indexOf('setLang("en")') < toggleSource.indexOf('setLang("am")'),
      "English must be the first segment"
    );
  });

  test("places the language and theme toggles together on the right", () => {
    const topBarSource = read("app/components/hotel/HotelTopBar.jsx");
    const languageAt = topBarSource.indexOf("<HotelLanguageToggle />");
    const themeAt = topBarSource.indexOf("<ThemeToggleHome />");
    assert.ok(languageAt >= 0 && themeAt >= 0, "both toggles must render");
    assert.ok(
      languageAt < themeAt,
      "language toggle must precede the theme toggle"
    );
    // Both controls live in the same right-aligned cluster, after the title
    // and after the optional page actions.
    const titleAt = topBarSource.indexOf('className="min-w-0 flex-1"');
    const actionsAt = topBarSource.indexOf("{actions}");
    assert.ok(titleAt >= 0 && actionsAt >= 0, "title block and actions must exist");
    assert.ok(titleAt < languageAt, "title must precede the toggles");
    assert.ok(actionsAt < languageAt, "language toggle must sit in the actions cluster");
    assert.match(
      topBarSource,
      /justify-end[^"]*"[^>]*>[\s\S]*<HotelLanguageToggle \/>/,
      "actions cluster must be right-aligned"
    );
    assert.ok(!topBarSource.includes("ThemeProvider"), "no second theme system");
  });

  test("every Hotel page shell renders the shared top bar", () => {
    for (const relativePath of shells) {
      const source = read(relativePath);
      assert.match(
        source,
        /import HotelTopBar from "\.\/HotelTopBar"/,
        `${relativePath} must import the shared bar`
      );
      assert.match(source, /<HotelTopBar/, `${relativePath} must render the bar`);
      assert.match(source, /lang=\{lang\}/, `${relativePath} must follow the language`);
    }
  });
});

describe("Hotel copy cleanup", () => {
  test("removes the redundant branding, role labels, and visible sign-out", () => {
    for (const relativePath of shells) {
      const source = read(relativePath);
      assert.ok(!source.includes(">Bono Hotel<"), `${relativePath}: branding banner`);
      assert.ok(!source.includes(">Hotel Manager<"), `${relativePath}: role chip`);
      assert.ok(!source.includes(">Sign out<"), `${relativePath}: visible sign-out`);
    }
  });

  test("removes the technical disclaimers called out for removal", () => {
    const removed = [
      "Arrival-sorted reservations with room assignment",
      "Counts are totals returned by the room API",
      "Room changes require Manager permission",
      "Room categories referenced by rooms and reservations",
      "Africa/Addis_Ababa",
    ];
    for (const relativePath of shells) {
      const source = read(relativePath);
      for (const text of removed) {
        assert.ok(!source.includes(text), `${relativePath} must not render: ${text}`);
      }
    }
    const typesSource = read("app/components/hotel/RoomTypesPanel.jsx");
    assert.ok(!typesSource.includes("Room categories referenced by rooms"));
  });
});
