/**
 * Windows Runner — server boot entry point.
 *
 * This is the executable: `npm start` runs the self-contained bundle `dist/index.cjs`,
 * `npm run dev` runs it through `tsx watch`. Importing it starts a server, so
 * import `./boot.js` instead when you need the API.
 *
 *   1. Read configuration from the environment (config.ts). Invalid values
 *      exit 1 with a message naming the variable.
 *   2. Compose the runtime and recover persisted state (boot.ts).
 *   3. Listen, print a banner and the ready line
 *        windows-runner listening on http://127.0.0.1:7634
 *      which scripts/smoke-start.mjs waits for.
 *   4. On SIGINT/SIGTERM/SIGHUP drain gracefully and exit 0. A second signal
 *      while draining exits immediately with 130.
 */
import { createRequire } from "node:module";
import { loadServerConfig, describeConfig, ConfigError } from "./config.js";
import { startServer, type StartedServer } from "./boot.js";

const TAG = "windows-runner";
// Resolves from both src/ (tsx) and dist/ (node): the manifest is one level up either way.
function getVersion(): string {
  try {
    if (typeof __filename !== 'undefined' && typeof require !== 'undefined') {
      try { return require('../package.json').version; } catch {}
      try { return require('../../package.json').version; } catch {}
    }
    const metaUrl = typeof import.meta !== 'undefined' && import.meta.url;
    if (metaUrl) {
      return createRequire(metaUrl)('../package.json').version;
    }
  } catch {}
  return '0.1.0';
}
const VERSION: string = getVersion();
const SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

function fail(err: unknown): never {
  if (err instanceof ConfigError) {
    console.error(`${TAG}: configuration error${err.variable ? ` (${err.variable})` : ""}: ${err.message}`);
  } else if (err instanceof Error) {
    console.error(`${TAG}: failed to start: ${err.stack ?? err.message}`);
  } else {
    console.error(`${TAG}: failed to start: ${String(err)}`);
  }
  process.exit(1);
}

async function main(): Promise<void> {
  let started: StartedServer;
  try {
    const config = loadServerConfig(process.env);
    console.log(`${TAG} v${VERSION} (node ${process.version}, pid ${process.pid})`);
    for (const line of describeConfig(config)) console.log(`  ${line}`);
    started = await startServer(config, { log: (line) => console.log(`  ${line}`) });
  } catch (err) {
    fail(err);
  }

  const ready = started;
  if (ready.authToken !== undefined && ready.boot.auth.tokenSource === "generated" && ready.boot.auth.tokenFile === undefined) {
    // Memory mode: the token exists only in this process, so the terminal is
    // the only place a user can get it. File mode and env-supplied tokens are
    // never echoed; the banner says where they live instead.
    console.log(`  token:       ${ready.authToken}`);
    console.log(`               (generated for this run; send it as "Authorization: Bearer <token>". Set ${"WINDOWS_RUNNER_AUTH_TOKEN"} or use file persistence for a stable one)`);
  }
  if (ready.tools.size === 0) {
    console.log("  tools:       none registered in this checkout (the agent can only answer in text)");
  }
  if (ready.config.provider === "mock") {
    console.log(`  note:        replies come from the offline mock provider and are prefixed "[mock]"`);
  }
  console.log(`${TAG} listening on ${ready.url}`);
  console.log(`  health:      ${ready.url}/healthz  (liveness)   ${ready.url}/api/health  (diagnostics)`);
  console.log("  press Ctrl+C to stop");

  let shuttingDown = false;
  const onSignal = (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      console.error(`${TAG}: received ${signal} again, exiting immediately`);
      process.exit(130);
    }
    shuttingDown = true;
    console.log(`${TAG}: received ${signal}, shutting down (grace ${ready.config.shutdownGraceMs}ms)…`);
    ready
      .close({ reason: `server received ${signal}` })
      .then((result) => {
        if (result.abortedTurns > 0) console.log(`${TAG}: cancelled ${result.abortedTurns} in-flight turn(s)`);
        if (result.forced) console.log(`${TAG}: grace period expired, closed remaining connections`);
        console.log(`${TAG}: stopped`);
        process.exit(0);
      })
      .catch((err) => {
        console.error(`${TAG}: shutdown failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
        process.exit(1);
      });
  };
  for (const signal of SIGNALS) process.on(signal, onSignal);
}

main().catch(fail);
