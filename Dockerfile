# Windows Runner container image — BLOCKED: this image cannot run yet.
#
# Status (2026-09-20): two gaps recorded in docs/INSTALL.md make a working image
# impossible, and neither is a packaging fix:
#
#   G-02  packages/server has no boot entry point. src/app.ts exports
#         createApp() and never calls listen(), and the workspace declares no
#         start script, so there is nothing for CMD to execute. `npm start` is
#         unavailable for the same reason.
#   G-03  no bundler. This file used to expect an esbuild bundle at
#         packages/server/dist/index.cjs (and a Vite build for packages/web).
#         Neither esbuild nor vite is a dependency, so `npm run build` emits
#         plain tsc output — packages/server/dist/app.js — instead.
#
# Rather than produce an image that builds green and then dies at `docker run`,
# the builder stage asserts the runtime entry it needs and fails with an
# actionable message when it is absent. Delete that assertion, and restore a real
# CMD, once G-02 and G-03 are closed.
#
# No Docker daemon is available in the environment these changes were written in,
# so nothing below has been executed. What *is* enforced runs on Linux in CI:
# packages/server/test/packaging.test.ts and `npm run smoke:packed`.
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

# G-02/G-03 guard: fail the build here instead of shipping an image with no
# runnable entry point. `packages/server/dist/app.js` is a library module
# (createApp) — it is deliberately not accepted as a runtime entry.
RUN set -eu; \
    entry="packages/server/dist/index.cjs"; \
    if [ ! -f "$entry" ]; then \
      echo "ERROR: no server runtime entry point." >&2; \
      echo "  expected: $entry" >&2; \
      echo "  built:    $(find packages/server/dist -maxdepth 1 -name '*.js' | tr '\n' ' ')" >&2; \
      echo "  blocked by docs/INSTALL.md gaps G-02 (no boot entry point) and" >&2; \
      echo "  G-03 (no bundler). The Docker path is not supported." >&2; \
      exit 1; \
    fi


FROM node:22-alpine

# dist/ is NOT self-contained (docs/INSTALL.md, gap G-04): the emitted modules
# import the bare specifier "@windows-runner/shared", which resolves inside a
# checkout through the workspace symlink and would not resolve in this image.
# Bundling shared into the server output (G-03) is what removes this dependency;
# until then the runtime stage would need node_modules copied in as well.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=7634 \
    WINDOWS_RUNNER_DATA_DIR=/home/node/.windows-runner

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

# Unreachable while G-02 stands: the builder stage above fails before this image
# is produced. Kept explicit so the missing entry point is visible in the file.
CMD ["node", "/app/packages/server/dist/index.cjs"]
