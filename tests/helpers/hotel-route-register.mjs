// Registers the Hotel route-handler test resolver. See hotel-route-loader.mjs.

import { register } from "node:module";

register("./hotel-route-loader.mjs", import.meta.url);
