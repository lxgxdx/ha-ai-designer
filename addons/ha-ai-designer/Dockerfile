# ==============================================================================
# HA AI Designer — multi-stage Dockerfile
# ==============================================================================
# Stage 1: builder (node:24-alpine)
#   - pnpm install → tsc daemon → next build web
#   - pnpm deploy --prod for self-contained web runtime
# Stage 2: runtime (hassio base + Node.js)
#   - Copy daemon dist + deployed web dir
# ==============================================================================
# Avoids Next.js' output: 'standalone' (or default server build) which
# triggers "<Html> should not be imported outside of pages/_document" during
# the static-pages prerender phase on both 14.2.x and 15.x.
# We use pnpm deploy --prod to get a self-contained runtime, and the
# container runs `next start` at runtime.
# ==============================================================================

# -------- Stage 1: builder --------
ARG BUILD_FROM=ghcr.io/hassio-addons/base:16.3.2
FROM node:24-alpine AS builder

ENV PNPM_HOME=/pnpm PATH=/pnpm/bin:$PATH
RUN apk add --no-cache pnpm && pnpm --version

WORKDIR /build

# Copy workspace manifests (Docker layer caching)
COPY pnpm-workspace.yaml package.json ./
COPY pnpm-lock.yaml* ./
COPY apps/daemon/package.json ./apps/daemon/
COPY apps/web/package.json ./apps/web/
COPY packages/contracts/package.json ./packages/contracts/
COPY tools/dev/package.json ./tools/dev/

# Install all deps including devDependencies (needed for tsc + next build)
ENV NODE_ENV=development
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile || pnpm install

# Copy sources
COPY tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY tools ./tools

# -------- 1. Build daemon (tsc → apps/daemon/dist/) --------
# Recreate per-package node_modules: BuildKit layer cache may reuse a stale
# symlink whose target points at a Windows path that does not exist inside
# the Linux build container.
ENV CI=true
RUN rm -rf /build/apps/daemon/node_modules /build/apps/web/node_modules && \
    pnpm install --frozen-lockfile && \
    /build/node_modules/.bin/tsc -p /build/apps/daemon --typeRoots /build/apps/daemon/node_modules/@types

# -------- 2. Build web (Next.js → apps/web/.next/) --------
# CRITICAL: NODE_ENV must be 'production' for `next build` to take the
# production code path. We set it to 'development' above for pnpm install
# to fetch devDependencies; here we override it.  Without this override,
# Next.js logs a non-standard-NODE_ENV warning and (with our setup) takes
# the wrong rendering path which triggers the "<Html>" prerender bug.
ENV NEXT_TELEMETRY_DISABLED=1
ENV CI=true
ENV NODE_ENV=production
ENV NEXT_SKIP_TYPESCRIPT=1
RUN /build/apps/web/node_modules/.bin/next build /build/apps/web

# -------- 3. Deploy production runtime for web --------
# pnpm deploy creates a self-contained copy with only production deps.
RUN cd /build && pnpm --filter @ha-designer/web deploy --prod --legacy /out/web

# Copy .next build output into the deployed production directory.
# Also copy public/ and next.config.mjs (read at runtime by `next start`).
RUN cp -r /build/apps/web/.next /out/web/
RUN cp -r /build/apps/web/public /out/web/public 2>/dev/null || true
RUN cp /build/apps/web/next.config.mjs /out/web/

# Daemon: tsc-compiled JS is NOT self-contained — needs node_modules at
# runtime (cors, express, ws, pino, etc.). Copy package.json + run a fresh
# `--prod` install into the deploy dir.
RUN mkdir -p /out/daemon
RUN cp -r /build/apps/daemon/dist /out/daemon/dist
RUN cp /build/apps/daemon/package.json /out/daemon/
RUN cd /out/daemon && pnpm install --prod --ignore-scripts --legacy

# -------- Stage 2: runtime (hassio base + Node.js) --------
FROM ${BUILD_FROM} AS runtime

# hassio base 16 ships Node 20.15.1, but pnpm 9/10's bin shims and the
# web build expect Node 20.18+ (and our builder stage is Node 24). Upgrade
# to Node 24 to match the builder — this also fixes the
# "SyntaxError: missing ) after argument list" in .bin/next (the shim
# is an ESM file Node 20.15 mis-parses).
RUN apk add --no-cache --update nodejs npm \
    && npm install -g n \
    && n 24 \
    && rm -rf /usr/local/bin/node /usr/local/bin/npm \
    && ln -sf /usr/local/n/versions/node/24/bin/node /usr/local/bin/node \
    && ln -sf /usr/local/n/versions/node/24/bin/npm /usr/local/bin/npm \
    && hash -r \
    && node --version && npm --version

# Install pnpm at runtime too (needed for the daemon `pnpm install`).
# pnpm isn't strictly needed at runtime if we COPY a pre-built
# node_modules — but daemon's install above uses pnpm, so we need it
# in the builder stage only. Skip pnpm in runtime.

# Copy built artifacts
COPY --from=builder /out/daemon /opt/ha-ai-designer/apps/daemon
COPY --from=builder /out/web /opt/ha-ai-designer/apps/web

# Copy built artifacts
COPY --from=builder /out/daemon /opt/ha-ai-designer/apps/daemon
COPY --from=builder /out/web /opt/ha-ai-designer/apps/web

# Copy the add-on entry point
COPY addons/ha-ai-designer/run.sh /run.sh
RUN chmod a+x /run.sh

# Register run.sh with s6-overlay's legacy-services.
# s6 does NOT auto-execute /run.sh — it only watches /etc/services.d/<name>/run
# and /etc/cont-init.d/<name>. Without this symlink the add-on banner prints
# fine but legacy-services reports "successfully started" with no script ever
# run, so daemon/web never come up. (v0.1.4 root cause.)
RUN mkdir -p /etc/services.d/ha-ai-designer \
    && ln -sf /run.sh /etc/services.d/ha-ai-designer/run

# Container labels (overridden by build.yaml, but kept for reference)
ARG BUILD_ARCH
ARG BUILD_DATE
ARG BUILD_DESCRIPTION
ARG BUILD_NAME
ARG BUILD_REF
ARG BUILD_REPOSITORY
ARG BUILD_VERSION

LABEL \
    io.hass.name="${BUILD_NAME}" \
    io.hass.description="${BUILD_DESCRIPTION}" \
    io.hass.arch="${BUILD_ARCH}" \
    io.hass.type="addon" \
    io.hass.version=${BUILD_VERSION} \
    maintainer="HA AI Designer contributors <noreply@example.com>" \
    org.opencontainers.image.title="${BUILD_NAME}" \
    org.opencontainers.image.description="${BUILD_DESCRIPTION}" \
    org.opencontainers.image.vendor="ha-ai-designer" \
    org.opencontainers.image.licenses="Apache-2.0" \
    org.opencontainers.image.source="https://github.com/${BUILD_REPOSITORY}" \
    org.opencontainers.image.documentation="https://github.com/${BUILD_REPOSITORY}/blob/main/README.md" \
    org.opencontainers.image.created=${BUILD_DATE} \
    org.opencontainers.image.revision=${BUILD_REF} \
    org.opencontainers.image.version=${BUILD_VERSION}
