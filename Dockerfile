# Windows Runner container image.
#
# Verified: no Docker daemon is available in the environment these changes were
# written in (see docs/BASELINE.md, F11), so this file is reviewed and its
# dependency layer is reproduced in isolation by
# packages/server/test/packaging.test.ts. Docker builds must be smoke-tested
# (`npm run smoke:docker` once a CI runner provides Docker) before the Docker
# path is advertised as supported.
FROM node:20-alpine AS builder
WORKDIR /app

# F11: `npm ci` used to execute the root `postinstall` hook before
# `scripts/postinstall.mjs` and the sources had been copied, failing the image
# build with "Cannot find module '.../scripts/postinstall.mjs'". The fix is
# `--ignore-scripts`: no lifecycle script runs in the dependency layer, and the
# build is an explicit step below. WINDOWS_RUNNER_SKIP_POSTINSTALL=1 is kept so
# nested npm invocations during the build stay quiet too.
ENV WINDOWS_RUNNER_SKIP_POSTINSTALL=1
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN npm ci --ignore-scripts --no-audit --no-fund

COPY . .
RUN npm run build


FROM node:20-alpine

# The server bundle is self-contained (esbuild inlines express, cors, diff,
# gray-matter, ignore, picomatch and the shared workspace package), so the
# runtime image needs no node_modules at all.
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

# Absolute path: compose (and users) set the working directory to the mounted
# workspace, so a relative entry point would resolve against /work and fail.
CMD ["node", "/app/packages/server/dist/index.cjs"]
