#!/usr/bin/env node
/**
 * Build the one runtime artifact that the published package and Docker image
 * execute.
 *
 * TypeScript still emits the workspace modules first. That output is useful for
 * declarations, source-level tests and local inspection, but it is not the
 * distribution contract: `packages/server/dist/index.cjs` is an esbuild bundle
 * containing the server, the shared reducer and express. It has no dependency
 * on a workspace symlink or on a runtime node_modules tree.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rootManifest = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const entryPoint = path.join(repoRoot, "packages", "server", "src", "index.ts");
const outfile = path.join(repoRoot, "packages", "server", "dist", "index.cjs");

await build({
  entryPoints: [entryPoint],
  outfile,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  // Resolve the monorepo alias directly to source. All shared runtime code is
  // then folded into the bundle instead of being left as a workspace import.
  alias: {
    "@windows-runner/shared": path.join(repoRoot, "packages", "shared", "src", "index.ts"),
  },
  define: {
    // The source entry uses "dev" under tsx. The packaged/build artifact gets
    // the manifest version without reading packages/server/package.json at run
    // time (that nested manifest is intentionally not published).
    "process.env.WINDOWS_RUNNER_VERSION": JSON.stringify(rootManifest.version ?? "0.0.0"),
  },
  banner: {
    js: "#!/usr/bin/env node",
  },
  sourcemap: false,
  legalComments: "none",
  logLevel: "info",
});

console.log(`windows-runner: bundled ${path.relative(repoRoot, outfile)}`);
