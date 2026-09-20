import * as esbuild from "esbuild";
import { cpSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Bundles the browser app to dist/app/ (index.html + app.css copied from
// public/, src/main.ts → app.js) and the provider dashboard to
// dist/dashboard/ (dashboard.html + dashboard.css, src/dashboard.ts →
// dashboard.js). The server serves dist/app at `/` and dist/dashboard at
// `/dashboard` when they exist (packages/server/src/boot.ts
// resolveWebDir / resolveDashboardDir). ESM output, no framework,
// @windows-runner/shared inlined from source.
const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, "..");
const buildOptions = (outfile) => ({
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  sourcemap: true,
  minify: false,
  outfile,
  alias: { "@windows-runner/shared": path.join(webRoot, "..", "shared", "src", "index.ts") },
});

const outDir = path.join(webRoot, "dist", "app");
mkdirSync(outDir, { recursive: true });
await esbuild.build({
  entryPoints: [path.join(webRoot, "src", "main.ts")],
  ...buildOptions(path.join(outDir, "app.js")),
});
cpSync(path.join(webRoot, "public", "index.html"), path.join(outDir, "index.html"));
cpSync(path.join(webRoot, "public", "app.css"), path.join(outDir, "app.css"));

const dashDir = path.join(webRoot, "dist", "dashboard");
mkdirSync(dashDir, { recursive: true });
await esbuild.build({
  entryPoints: [path.join(webRoot, "src", "dashboard.ts")],
  ...buildOptions(path.join(dashDir, "dashboard.js")),
});
cpSync(path.join(webRoot, "public", "dashboard.html"), path.join(dashDir, "dashboard.html"));
cpSync(path.join(webRoot, "public", "dashboard.css"), path.join(dashDir, "dashboard.css"));
console.log("bundled @windows-runner/web -> dist/app/ + dist/dashboard/");
