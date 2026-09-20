# Windows Runner container image — BLOCKED: this image cannot run yet.
#
# Status (2026-09-20): the server boot entry point now exists (docs/INSTALL.md
# gap G-02 is closed) — `npm start` runs packages/server/dist/index.js and
# `npm run smoke:start` proves it boots. One blocker remains, and it is a
# packaging one:
#
#   G-03/G-04  no bundler, so dist/ is not self-contained. The compiled entry
#         imports `express` and the bare specifier `@windows-runner/shared`,
#         which resolve inside a checkout through node_modules and a workspace
#         symlink that this runtime stage does not copy. This file used to
#         expect an esbuild bundle at packages/server/dist/index.cjs; neither
#         esbuild nor vite is a dependency, so nothing produces one.
#
# Rather than produce an image that builds green and then dies at `docker run`,
# the builder stage asserts the self-contained bundle it needs and fails with an
# actionable message while it is absent. Delete that assertion, and point CMD at
# the bundle, once G-03/G-04 are closed.
#
# No Docker daemon is available in the environment these changes were written in,
# so nothing below has been executed. What *is* enforced runs on Linux in CI:
# packages/server/test/packaging.test.ts, `npm run smoke:packed` and
# `npm run smoke:start` (the last one boots the entry from a checkout).
FROM node:22-alpine AS builder
WORKDIR /app

# The dependency layer copies manifests only, so the root postinstall hook is
# skipped here by design — scripts/ and the sources are not present yet, and a
# verification hook cannot verify a tree that has not been copied. CI installs
# with a plain `npm ci` and does run the hook. WINDOWS_RUNNER_SKIP_POSTINSTALL=1
# is kept so nested npm invocations during the build stay quiet too.
ENV WINDOWS_RUNNER_SKIP_POSTINSTALL=1
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN npm ci --ignore-scripts --no-audit --no-fund

COPY . .
RUN npm run build

# G-03/G-04 guard: fail the build here instead of shipping an image whose entry
# point cannot resolve its imports. `packages/server/dist/index.js` IS the boot
# entry, but it is plain tsc output that depends on node_modules and the
# workspace symlink; only a self-contained bundle is accepted here.
RUN set -eu; \
    entry="packages/server/dist/index.cjs"; \
    if [ ! -f "$entry" ]; then \
      echo "ERROR: no self-contained server bundle." >&2; \
      echo "  expected: $entry" >&2; \
      echo "  built:    $(find packages/server/dist -maxdepth 1 -name '*.js' | tr '\n' ' ')" >&2; \
      echo "  packages/server/dist/index.js is the boot entry (works via npm start)," >&2; \
      echo "  but it imports express and @windows-runner/shared, which this image" >&2; \
      echo "  does not carry. Blocked by docs/INSTALL.md gaps G-03 (no bundler) and" >&2; \
      echo "  G-04 (dist/ not self-contained). The Docker path is not supported." >&2; \
      exit 1; \
    fi


FROM node:22-alpine

# dist/ is NOT self-contained (docs/INSTALL.md, gap G-04): the emitted modules
# import the bare specifier "@windows-runner/shared", which resolves inside a
# checkout through the workspace symlink and would not resolve in this image.
# Bundling shared into the server output (G-03) is what removes this dependency;
# until then the runtime stage would need node_modules copied in as well.
# HOST=0.0.0.0 binds all interfaces *inside the container's network namespace*;
# the entry point refuses that without WINDOWS_RUNNER_ALLOW_REMOTE=1 because the
# API has no authentication (RELEASE_CHECKLIST.md, P0-01). docker-compose.yml
# publishes the port on the host loopback only.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=7634 \
    WINDOWS_RUNNER_ALLOW_REMOTE=1 \
    WINDOWS_RUNNER_PERSISTENCE_MODE=file \
    WINDOWS_RUNNER_DATA_DIR=/home/node/.windows-runner \
    WINDOWS_RUNNER_ALLOWED_ROOTS=/work

WORKDIR /app
COPY --from=builder --chown=node:node /app/packages/server/dist ./packages/server/dist
COPY --from=builder --chown=node:node /app/packages/web/dist ./packages/web/dist
COPY --from=builder --chown=node:node /app/package.json ./package.json

# Data directory for config, sessions and crash reports. Declared in the image
# so a fresh named volume inherits node:node ownership.
RUN mkdir -p /home/node/.windows-runner && chown node:node /home/node/.windows-runner

# Least practical privilege: never run the agent server as root. The container
# still needs write access to the mounted workspace, which is the host's uid
# (see docs/INSTALL.md, "Docker").
USER node

EXPOSE 7634

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||7634)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Unreachable while G-03/G-04 stand: the builder stage above fails before this
# image is produced. Kept explicit so the missing bundle is visible in the file.
# The checkout equivalent is `node packages/server/dist/index.js`.
CMD ["node", "/app/packages/server/dist/index.cjs"]
