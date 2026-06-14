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
# v0.3.0.2: better-sqlite3@11 has no prebuilt binary for
# node-24 + linux-musl, so `prebuild-install` falls through to
# `node-gyp rebuild --release`, which needs Python + make + g++.
# Alpine ships none of these by default. We add them to the builder
# stage only — the runtime stage is a hassio base that already has
# what it needs and we don't want a 200MB Python in the final image.
# See CLAUDE.md "Docker build 关键教训" for the rationale on why we
# keep the runtime lean.
RUN apk add --no-cache python3 make g++
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
# runtime (cors, express, ws, pino, etc.). Use pnpm deploy (same approach
# as web) so we get a self-contained production tree that includes
# package.json + node_modules + dist.
RUN cd /build && pnpm --filter @ha-designer/daemon deploy --prod --legacy /out/daemon
RUN rm -rf /out/daemon/dist
RUN cp -r /build/apps/daemon/dist /out/daemon/dist

# -------- Stage 2: runtime (hassio base + Node.js) --------
FROM ${BUILD_FROM} AS runtime

# hassio base 16 ships Node 20.15.1, but pnpm 9/10's bin shims and the
# web build expect Node 20.18+ (and our builder stage is Node 24).
#
# We can't change the runtime base from hassio's — supervisor only
# accepts add-ons derived from its base images. We also can't tarball
# Node 24 from nodejs.org/dist because that directory no longer ships
# a linux-x64-musl variant for v24 (Alpine is musl-based).
#
# Cleanest fix: copy the Node 24 binary tree from the builder stage
# (which is `FROM node:24-alpine`) into the runtime. We must first
# bump the runtime's libstdc++ — hassio base 16.3.2 is Alpine 3.24
# with libstdc++ 13 (older C++ ABI), and the Node 24 binary needs
# symbols from a newer libstdc++ (it was built against v14+). Just
# `apk add libstdc++` pulls the newest available, which is enough.
#
# We then reinstall npm globally because copying the npm install dir
# from builder doesn't always work (node:24-alpine's npm files end up
# at a different relative path than /usr/local/lib/node_modules/npm/).
RUN apk add --no-cache libstdc++
# Copy the entire /usr/local tree from the builder stage (node:24-alpine
# ships /usr/local with node, npm, npx, corepack, plus their modules
# under /usr/local/lib/node_modules/). Selective COPY of just the
# /usr/local/bin/{node,npm,npx} wrappers left a dangling require
# (../lib/node_modules/npm/...) — so we take the whole tree.
# /usr/local/bin still wins on PATH over the hassio-base /usr/bin/node.
COPY --from=builder /usr/local/ /usr/local/
RUN hash -r \
    && node --version \
    && npm --version

# Copy built artifacts
COPY --from=builder /out/daemon /opt/ha-ai-designer/apps/daemon
COPY --from=builder /out/web /opt/ha-ai-designer/apps/web

# v0.1.21: copy the LLM-facing context (skills/, design-systems/, craft/)
# from the build context. The orchestrator reads these at runtime via
# HA_REPO_ROOT=/opt/ha-ai-designer (set in run.sh). Without this the
# /api/chat route 502s with "Skill ... not found" because orchestrator
# looks in ${HA_REPO_ROOT}/skills/<name>/SKILL.md.
COPY skills /opt/ha-ai-designer/skills
COPY design-systems /opt/ha-ai-designer/design-systems
COPY craft /opt/ha-ai-designer/craft

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
