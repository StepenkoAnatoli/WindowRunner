import * as esbuild from "esbuild";
import { chmodSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, "..");
const entryPoint = path.join(serverRoot, "src", "index.ts");
const outfile = path.join(serverRoot, "dist", "index.cjs");

await esbuild.build({
  entryPoints: [entryPoint],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile,
  banner: {
    js: "#!/usr/bin/env node\n",
  },
  define: {
    "import.meta.url": "undefined",
  },
});

try {
  chmodSync(outfile, 0o755);
} catch {
  // best-effort on platforms that do not support POSIX permissions
}

console.log("bundled @windows-runner/server -> dist/index.cjs");
