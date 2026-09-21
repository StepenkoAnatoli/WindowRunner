/**
 * Assembles the desktop distribution payload.
 *
 * Two outputs (both under packages/desktop/dist/, which is what the A2
 * electron-builder config packs):
 *
 * 1. dist/renderer/ — the live renderer shell (index.html + renderer.js) that
 *    the server resolves as `packages/desktop/dist/renderer` and serves at
 *    `/desktop` in the dev/test layout.
 *
 * 2. dist/resources/ — a staged mirror of the monorepo geometry the bundled
 *    server needs at runtime, so `extraResources` can copy it verbatim next to
 *    the packaged executable and `resolveWebDir` / `resolveDashboardDir` /
 *    `resolveDesktopDir` keep working unchanged:
 *
 *      packages/server/dist/index.cjs        (self-contained, copied as-is)
 *      packages/web/dist/app/**              (session UI)
 *      packages/web/dist/dashboard/**        (provider dashboard)
 *      packages/desktop/dist/renderer/**     (desktop shell)
 *
 * dist/main.cjs and dist/preload.cjs need no copying: they are already in the
 * distribution (`files: dist/**`) beside the entry that loads them.
 *
 * No sources, no node_modules, no tests are ever copied.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, "..");
const packagesRoot = path.resolve(desktopRoot, "..");
const dist = path.join(desktopRoot, "dist");

function requireFile(file, hint) {
  if (!fs.existsSync(file)) {
    throw new Error(`copy-assets: missing ${file} — ${hint}`);
  }
}

const serverBundle = path.join(packagesRoot, "server", "dist", "index.cjs");
const webAppDir = path.join(packagesRoot, "web", "dist", "app");
const webDashboardDir = path.join(packagesRoot, "web", "dist", "dashboard");
const rendererJs = path.join(dist, "renderer.js");
const rendererHtml = path.join(desktopRoot, "src", "renderer.html");

requireFile(serverBundle, "run `npm run build` first (packages/server must be built)");
requireFile(path.join(webAppDir, "index.html"), "run `npm run build` first (packages/web must be built)");
requireFile(path.join(webDashboardDir, "dashboard.html"), "run `npm run build` first (packages/web must be built)");
requireFile(rendererJs, "run `node scripts/build.mjs` first");
requireFile(rendererHtml, "source shell is missing");
requireFile(path.join(dist, "main.cjs"), "run `node scripts/build.mjs` first");
requireFile(path.join(dist, "preload.cjs"), "run `node scripts/build.mjs` first");

// 1. Live shell at packages/desktop/dist/renderer (server /desktop route).
const liveShell = path.join(dist, "renderer");
fs.rmSync(liveShell, { recursive: true, force: true });
fs.mkdirSync(liveShell, { recursive: true });
fs.copyFileSync(rendererHtml, path.join(liveShell, "index.html"));
fs.copyFileSync(rendererJs, path.join(liveShell, "renderer.js"));

// 2. Staged resources mirror (monorepo geometry preserved).
const staged = path.join(dist, "resources");
fs.rmSync(staged, { recursive: true, force: true });
const copy = (from, to) => {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true });
};
copy(serverBundle, path.join(staged, "packages", "server", "dist", "index.cjs"));
copy(webAppDir, path.join(staged, "packages", "web", "dist", "app"));
copy(webDashboardDir, path.join(staged, "packages", "web", "dist", "dashboard"));
copy(liveShell, path.join(staged, "packages", "desktop", "dist", "renderer"));

console.log("copy-assets: dist/renderer/ (live shell) + dist/resources/ (packaged payload) ready");
