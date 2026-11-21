// Registers the Phase 2.3 `@/` alias loader for the opt-in integration run only.
// See pos-phase23-loader.mjs for the exact command.
import { register } from "node:module";

register(new URL("./pos-phase23-loader.mjs", import.meta.url));
