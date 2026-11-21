// Registers the Phase 2.5 `@/` alias loader for the opt-in integration run only.
// See pos-phase25-loader.mjs for the exact command.
import { register } from "node:module";

register(new URL("./pos-phase25-loader.mjs", import.meta.url));
