import * as esbuild from "esbuild";
import { cpSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Bundles the browser app to dist/app/: index.html + app.css copied from
// public/, src/main.ts bundled to app.js. The server serves dist/app at `/`
// when it exists (packages/server/src/boot.ts resolveWebDir). ESM output,
// no framework, @windows-runner/shared inlined from source.
const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, "..");
const outDir = path.join(webRoot, "dist", "app");
mkdirSync(outDir, { recursive: true });

await esbuild.build({
  entryPoints: [path.join(webRoot, "src", "main.ts")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  outfile: path.join(outDir, "app.js"),
  sourcemap: true,
  minify: false,
  alias: { "@windows-runner/shared": path.join(webRoot, "..", "shared", "src", "index.ts") },
});
cpSync(path.join(webRoot, "public", "index.html"), path.join(outDir, "index.html"));
cpSync(path.join(webRoot, "public", "app.css"), path.join(outDir, "app.css"));
console.log("bundled @windows-runner/web -> dist/app/");
