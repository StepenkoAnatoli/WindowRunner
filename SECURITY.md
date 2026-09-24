# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| `main` (pre-release development) | yes — security fixes land on `main` and ship in the next tagged release |
| 0.1.x | yes, once the first tagged release exists |

## Reporting a vulnerability

**Do not open a public GitHub issue for security problems.**

Use GitHub's **private vulnerability reporting** on this repository
(Report a vulnerability — enabled; it reaches the maintainers privately and
lets us coordinate a fix and a CVE before publication). If private reporting
is unavailable to you for some reason, open a draft security advisory or
contact the repository owner via their GitHub profile.

Please include:

- the affected component (server API, web UI, desktop shell, installer,
  release tooling);
- exact version/commit (`git rev-parse HEAD`, or the app version from
  Settings → About);
- a reproduction (PoC, curl commands, or a screenshot of the crash dialog
  with the crash log path from `%APPDATA%\WindowRunner\logs\`);
- whether the issue is exploitable remotely or requires local access.

Expect an acknowledgement within a few days. Fixes for accepted issues are
released through the normal release process
([`RELEASE_CHECKLIST.md`](./RELEASE_CHECKLIST.md) → "Cutting a release"), and
credited reporters are named in the changelog unless they prefer otherwise.

## Trust model (what we consider in scope)

WindowRunner is a **local-first** coding agent: the server, tools and
persistence run on the user's machine; users bring their own provider API
keys; nothing phones home. The security boundaries we defend are:

- the local API boundary: bearer token on every `/api` route, loopback-only
  bind by default, Host/Origin validation, explicit opt-in for remote binds
  (`packages/server/src/security.ts`);
- the filesystem boundary: every path is authorized against canonicalized
  allowed roots — logical containment first, then a realpath check so a
  symlink cannot escape — and no tool touches the filesystem any other way
  (`packages/server/src/project-root.ts`);
- the provider-key boundary: keys are redacted from responses, errors, logs
  and the UI; provider test/discovery paths scrub them defensively
  (`packages/server/src/provider-profiles.ts`, `provider-discovery.ts`);
- the desktop boundary: sandboxed renderer, contextIsolation, allowlisted IPC
  surface, navigation lockdown, in-memory bootstrap token
  (`packages/desktop/src/main.ts`, `desktop-bridge.ts`);
- the release boundary: checksummed artifacts, CI-proven signing pipeline,
  draft-only releases (`docs/INSTALL.md` → "Code signing and SmartScreen",
  "Verifying a download").

Known, documented limitations (e.g. API keys are plaintext at rest in the
per-user `provider-profiles.json`, minidumps can contain process memory) are
listed in `docs/INSTALL.md` and `RELEASE_CHECKLIST.md`; the B5 review lives at
`docs/research/2026-09-22-b5-security-review.md`.

## Out of scope

- Attacks requiring the user to install a build from a source other than this
  repository's GitHub Releases or the npm tarball (official sources are named
  in `docs/INSTALL.md` → "Verifying a download").
- Compromises of the user's own machine or provider accounts.
- Volumetric DoS against a server the user deliberately exposed with
  `WINDOWS_RUNNER_ALLOW_REMOTE=1` (the docs call out that TLS and exposure
  hardening are the operator's job).
