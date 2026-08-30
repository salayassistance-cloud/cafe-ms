// Localization helpers for the Hotel Management System POS.
//
// Item/category names may arrive as a plain string (legacy payloads) or as a
// multilingual object { am, en, om }. These helpers extract a standard string
// so React never renders an object as a JSX child.

// Safely extract a standard string from a possibly-localized value.
// Defaults to the Amharic (am) variant, falling back through am -> en -> any.
export function getLocalizedSingleString(val, lang = "am") {
  if (!val) return "";
  if (typeof val === "string") return val;
  if (typeof val === "object") {
    return (
      val[lang] || val["am"] || val["en"] || Object.values(val)[0] || ""
    );
  }
  return String(val);
}

// Legacy alias used server-side (defaults to English for reporting).
export function displayName(name, lang = "en") {
  if (!name) return "";
  if (typeof name === "string") return name;
  if (typeof name === "object") {
    return name[lang] || name.en || name.am || name.om || "";
  }
  return String(name);
}
