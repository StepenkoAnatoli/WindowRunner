/**
 * Emits the Electron artifacts with esbuild (the repo's existing bundler):
 *
 *   dist/main.cjs     — main process, CommonJS ("main" in package.json)
 *   dist/preload.cjs  — sandboxed preload, CommonJS (ESM preloads cannot be
 *                       sandboxed in Electron)
 *   dist/renderer.js  — browser-context shell script, ESM
 *
 * `electron` stays external (provided by the Electron runtime). TypeScript
 * checking happens in the `tsc -p tsconfig.build.json` step of `npm run build`.
 */
import * as esbuild from "esbuild";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const dist = path.join(root, "dist");

const nodeBundle = (entry, outfile) =>
  esbuild.build({
    entryPoints: [path.join(root, "src", entry)],
    outfile: path.join(dist, outfile),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    sourcemap: true,
    external: ["electron"],
    logLevel: "info",
  });

await nodeBundle("main.ts", "main.cjs");
await nodeBundle("preload.ts", "preload.cjs");

await esbuild.build({
  entryPoints: [path.join(root, "src", "renderer.ts")],
  outfile: path.join(dist, "renderer.js"),
  bundle: true,
  platform: "browser",
  format: "esm",
  target: ["es2022"],
  sourcemap: true,
  // The app entry is loaded at runtime as a same-origin URL import.
  external: ["/app.js"],
  logLevel: "info",
});

console.log("built @windows-runner/desktop -> dist/main.cjs + dist/preload.cjs + dist/renderer.js");
