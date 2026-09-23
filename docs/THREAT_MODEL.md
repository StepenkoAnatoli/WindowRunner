# Threat Model

What WindowRunner defends, what it deliberately does not, and which implemented
control carries each claim. Everything here describes **shipped** behavior;
controls that exist only as plans are excluded on purpose.

## Assets and boundaries

- **The user's machine** — files, credentials, terminal access. The highest-value asset; an approved agent command runs with the user's full privileges.
- **The server's HTTP surface** (`/api/*`, `/healthz`, static UIs) — reachable from the local process and, if explicitly enabled, from other machines on the network.
- **Provider API keys** — stored by the server on the user's behalf.
- **Persisted session/trust data** under the data dir.

Crossing boundaries: model providers receive exactly the data needed for the
requests the user sends (conversation context, tool schemas/results). Nothing
else leaves the machine. There is no telemetry, no update phone-home, no
account.

## Controls, one claim at a time

| Threat | Control (where) |
| --- | --- |
| Another local process or a webpage calling the API | Every `/api` route requires a bearer token; constant-time compare; `WWW-Authenticate` on 401 (`security.ts`). Boot refuses `auth=off` on any non-loopback host, and refuses any non-loopback bind without explicit `WINDOWS_RUNNER_ALLOW_REMOTE=1` (`config.ts`, `boot.ts`). |
| A webpage driving the API from the user's browser (DNS rebinding, cross-origin XHR) | Host-header validation against loopback names + explicit allowlist; Origin validation on every request that carries one; wildcards and `null` never accepted; preflights answered only for allowlisted origins (`security.ts`). |
| Unauthenticated payload buffering | The security middleware runs **before** body parsing; an invalid Host/Origin never allocates a body buffer (`app.ts`). |
| Malformed/hostile request bodies | Strict validation with stable error codes: id format, JSON-object-only bodies, 1 MiB cap, message/path/cursor/reason bounds (`http/validate.ts`, route guards). |
| Agent file tools escaping the project | Every path goes through `ProjectRoot` logical containment **and** realpath verification for existing targets (symlinks cannot write through), nearest-existing-parent checks for new files, stable error codes with no raw `ENOENT` leak (`project-root.ts`, `agent/tools/builtin.ts`). |
| Runaway or hostile command execution | `run_terminal` requires approval every call, runs with secrets stripped from its environment, bounded output, wall-clock deadline, and is killed as a **process tree** (POSIX group / `taskkill /T`) on Stop or timeout (`process-tree.ts`). |
| Approval prompts hanging forever or being settled by a stale observer | Approval lifetimes are owned by `ApprovalRegistry`, independent of any SSE connection; timeouts are deadline-bounded with a single expiry source; double-settlement is refused (`approval-registry.ts`, `deadline.ts`). |
| Path/trust confusion across sessions | Sessions pin their project root at creation; later turns cannot change it (`ROOT_MISMATCH`); at most one active turn per session (`session-manager.ts`). |
| A project-supplied tool gaining silent trust | Project trust is a separate, explicit grant keyed by the project's **real** root plus a `sha256` config hash, persisted 0600, re-validated at boot against current allowed roots; approval of one tool call never grants trust (`agent/project-trust.ts`). |
| Provider keys leaking through errors, logs, or the UI | Keys are stored 0600 plaintext at rest, returned masked (`****last4`) only, redacted from every error and log surface; discovery keys live only inside the single request and are never persisted (`provider-service.ts`, `provider-discovery.ts`). |
| Token exfiltration via URL/storage in the desktop app | The renderer token travels only through the sandboxed preload bridge (`getBootstrap`), lives in memory, never in a URL or web storage; the preload exposes an allowlisted method surface only (`desktop/src/desktop-bridge.ts`). |
| Static-UI script injection | Strict CSP (`default-src 'self'`, no inline scripts), `no-store`, `nosniff`, `no-referrer` on every served UI (`http/static-ui.ts`). Deep routes serve a static shell only — nothing is interpolated. |
| Persisted-state tampering across restarts | Boot re-validates every persisted root against **current** allowed roots and never trusts stored metadata for authorization; malformed turn logs are quarantined, not loaded (`agent/file-*-store.ts`). |

## Explicit non-goals

- **Not a sandbox.** An approved terminal command runs as the user, with the
  user's privileges: it can read and write anywhere the user can, reach the
  network, and use the user's credentials. The project-directory restriction
  applies only to the built-in file tools. Running untrusted repositories is a
  VM/container job — do it there.
- **Plain HTTP on the network path.** `WINDOWS_RUNNER_ALLOW_REMOTE=1` exposes
  a bearer-token-only surface over unencrypted HTTP; it is an explicit opt-in
  for trusted networks only.
- **Multi-process persistence.** File persistence supports exactly one writer
  process per data dir; there is no file lock, and the API states this.
- **No defense against a fully-trusted local attacker** who already runs code
  as the user; no OS-level isolation is claimed or attempted.

## Reporting

Found a gap in this model or its implementation? Do not open a public issue —
follow [SECURITY.md](../SECURITY.md).
