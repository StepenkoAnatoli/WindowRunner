# Windows Runner container image.
#
# The runtime contract is the self-contained esbuild artifact
# packages/server/dist/index.cjs. The builder installs the full workspace only
# to produce that file; the final image carries no node_modules, source tree,
# TypeScript, or workspace symlink.
#
# Docker build execution remains a final-hardening/CI concern in this checkout.
# The artifact itself is covered by npm run smoke:runtime on Linux.
FROM node:22-alpine AS builder
WORKDIR /app

# The dependency layer copies manifests only, so the root postinstall hook is
# skipped here by design. The source tree and runtime bundle are copied below.
ENV WINDOWS_RUNNER_SKIP_POSTINSTALL=1
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN npm ci --ignore-scripts --no-audit --no-fund

COPY . .
RUN npm run build

# Fail while building, not on the first container start, if the distribution
# contract stops producing the bundled runtime entry.
RUN test -s packages/server/dist/index.cjs
RUN ! grep -Eq '@windows-runner/shared|require\("express"\)|from "express"' packages/server/dist/index.cjs

FROM node:22-alpine

# HOST=0.0.0.0 binds all interfaces inside the container's network namespace.
# The explicit opt-in is required because the API is unauthenticated; compose
# publishes the port on the host loopback only.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=7634 \
    WINDOWS_RUNNER_ALLOW_REMOTE=1 \
    WINDOWS_RUNNER_PERSISTENCE_MODE=file \
    WINDOWS_RUNNER_DATA_DIR=/home/node/.windows-runner \
    WINDOWS_RUNNER_ALLOWED_ROOTS=/work

WORKDIR /app
COPY --from=builder --chown=node:node /app/packages/server/dist/index.cjs ./packages/server/dist/index.cjs

# Data directory for sessions and turn logs. Declared in the image so a fresh
# named volume inherits node:node ownership.
RUN mkdir -p /home/node/.windows-runner && chown node:node /home/node/.windows-runner

# Least practical privilege. The mounted workspace must be writable by uid 1000
# (or compose can override user: "${UID}:${GID}").
USER node

EXPOSE 7634

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||7634)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "/app/packages/server/dist/index.cjs"]
