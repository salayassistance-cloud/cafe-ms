import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";

// BONO Inventory V2 — static server-only boundary enforcement.
//
// The `server-only` package is not installed in this repository, so the runtime
// `assertServerOnly()` guard in lib/inventory-v2/server/boundary.js is backed by
// this ESLint rule. Client components and route pages must never import the V2
// server boundary directly; they must go through an API route or a server action.
//
// API routes, server actions, scripts, and tests are intentionally NOT matched
// by these file globs, so legitimate server-side imports remain allowed.
const V2_SERVER_IMPORT_PATTERNS = [
  {
    group: [
      "@/lib/inventory-v2/server",
      "@/lib/inventory-v2/server/*",
      "lib/inventory-v2/server",
      "lib/inventory-v2/server/*",
      "**/lib/inventory-v2/server",
      "**/lib/inventory-v2/server/*",
    ],
    message:
      "Inventory V2 server modules are server-only. Call an API route or server action instead of importing them into a client component or page.",
  },
];

const eslintConfig = defineConfig([
  ...nextVitals,
  {
    files: [
      "app/components/**/*.{js,jsx,ts,tsx}",
      "app/**/page.{js,jsx,ts,tsx}",
      "app/**/*Client.{js,jsx,ts,tsx}",
      "app/**/*UI.{js,jsx,ts,tsx}",
      "app/**/*Modal.{js,jsx,ts,tsx}",
    ],
    rules: {
      "no-restricted-imports": ["error", { patterns: V2_SERVER_IMPORT_PATTERNS }],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
