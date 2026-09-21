/**
 * Web packaging contract (plan B2.5.4): the build must keep producing the two
 * separate asset trees the server routes rely on — `dist/app/` for `/` (the B2
 * route host: providers, usage, settings) and `dist/dashboard/` for
 * `/dashboard` (the compatibility entry). Text-level contracts over the bundle
 * script and the public sources, same style as
 * packages/desktop/test/packaging.test.ts: exact-shape assertions that fail if
 * either side drifts. Runs from `npm test` with no prior build — the CI `Build`
 * step and the packed-artifact smokes verify the outputs themselves.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Normalize CRLF: Windows checkouts can materialize LF files as CRLF, and the
// shape assertions below are newline-sensitive.
const read = (rel: string): string =>
  fs.readFileSync(path.join(webRoot, rel), "utf8").replace(/\r\n/g, "\n");

describe("web packaging contract (scripts/bundle.mjs + public/)", () => {
  const bundle = read("scripts/bundle.mjs");

  it("builds the route app and the dashboard entry into separate trees", () => {
    // Route host: src/main.ts -> dist/app/app.js
    assert.ok(
      bundle.includes('entryPoints: [path.join(webRoot, "src", "main.ts")]'),
      "bundle.mjs must build the route app entry (src/main.ts)"
    );
    assert.ok(
      bundle.includes('...buildOptions(path.join(outDir, "app.js"))'),
      "bundle.mjs must emit the route app to dist/app/app.js"
    );
    // Compatibility entry: src/dashboard.ts -> dist/dashboard/dashboard.js
    assert.ok(
      bundle.includes('entryPoints: [path.join(webRoot, "src", "dashboard.ts")]'),
      "bundle.mjs must build the dashboard entry (src/dashboard.ts)"
    );
    assert.ok(
      bundle.includes('...buildOptions(path.join(dashDir, "dashboard.js"))'),
      "bundle.mjs must emit the dashboard to dist/dashboard/dashboard.js"
    );
  });

  it("ships each entry with its own HTML and CSS", () => {
    for (const [from, to] of [
      ['cpSync(path.join(webRoot, "public", "index.html"), path.join(outDir, "index.html"))', "index.html -> dist/app/"],
      ['cpSync(path.join(webRoot, "public", "app.css"), path.join(outDir, "app.css"))', "app.css -> dist/app/"],
      ['cpSync(path.join(webRoot, "public", "dashboard.html"), path.join(dashDir, "dashboard.html"))', "dashboard.html -> dist/dashboard/"],
      ['cpSync(path.join(webRoot, "public", "dashboard.css"), path.join(dashDir, "dashboard.css"))', "dashboard.css -> dist/dashboard/"],
    ] as const) {
      assert.ok(bundle.includes(from), `bundle.mjs must copy ${to}`);
    }
    // The sources those copies read must exist.
    for (const rel of ["public/index.html", "public/app.css", "public/dashboard.html", "public/dashboard.css"]) {
      assert.ok(fs.existsSync(path.join(webRoot, rel)), `missing ${rel}`);
    }
  });

  it("bundles the B2 route pages into the app entry", () => {
    // The providers/usage/settings pages are modules of the app entry — if an
    // import is dropped, the route stops shipping in app.js and this fails
    // before a build would ever notice.
    const main = read("src/main.ts");
    for (const mod of [
      "./providers/provider-page.js",
      "./usage/usage-page.js",
      "./settings/settings-shell.js",
      "./settings/security-page.js",
      "./settings/storage-page.js",
      "./settings/about-page.js",
    ]) {
      assert.ok(main.includes(`from "${mod}"`), `main.ts must import ${mod} so app.js includes it`);
    }
    // The dashboard entry keeps reusing the shared provider implementation.
    const dash = read("src/dashboard.ts");
    assert.ok(
      dash.includes('from "./providers/compatibility.js"'),
      "dashboard.ts must reuse the shared provider compatibility page"
    );
  });
});
