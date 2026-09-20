#!/usr/bin/env node
/**
 * Windows Runner CLI launcher.
 *
 * Runs the self-contained server bundle from packages/server/dist/index.cjs.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const bundle = path.resolve(here, "../packages/server/dist/index.cjs");
const require = createRequire(import.meta.url);
require(bundle);
