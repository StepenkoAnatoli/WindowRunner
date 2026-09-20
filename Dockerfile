# Windows Runner container image.
#
# Status (2026-09-20): the server boot entry point exists and is bundled into a
# self-contained distribution artifact (packages/server/dist/index.cjs), closing
# packaging gaps G-02, G-03 and G-04. The image runs the standalone server bundle
# directly without requiring node_modules or monorepo workspace symlinks in the
# runtime container.
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

# Verify the self-contained bundle was created
RUN set -eu; \
    entry="packages/server/dist/index.cjs"; \
    if [ ! -f "$entry" ]; then \
      echo "ERROR: no self-contained server bundle found at $entry" >&2; \
      exit 1; \
    fi


FROM node:22-alpine

# The server runs as a self-contained bundle at packages/server/dist/index.cjs
# (gaps G-03/G-04 closed). No node_modules or workspace symlinks needed at runtime.
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

CMD ["node", "/app/packages/server/dist/index.cjs"]
