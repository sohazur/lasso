/**
 * Side-effect-only module: loads .env from the lasso/ repo root BEFORE any
 * other module reads process.env. Must be the first import in index.ts.
 *
 * ESM hoists imports, so this runs before config.ts reads env keys.
 */

import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, "../../.env") });
