# ==============================================================================
# HA AI Designer — multi-stage Dockerfile
# ==============================================================================
# Stage 1: build artifacts using pnpm + Node 24 (Linux, where symlinks work)
# Stage 2: copy artifacts into the hassio base image
# Stage 3: shrink by removing dev-only files
# ==============================================================================

# -------- Stage 1: builder --------
ARG BUILD_FROM=ghcr.io/hassio-addons/base:16.3.2
FROM node:24-alpine AS builder

# Standalone build doesn't need gcc/python3 — every dep ships prebuilt.
# (We tried apk-adding them and the gdbm / gcc / python3 extractions
#  frequently I/O-errored on flaky network.)

# Install pnpm directly via npm (corepack was flaky on this build).
ENV PNPM_HOME=/pnpm PATH=/pnpm/bin:$PATH
RUN apk add --no-cache pnpm && which pnpm && pnpm --version

WORKDIR /build

# Copy workspace manifests first (better Docker layer caching)
COPY pnpm-workspace.yaml package.json ./
COPY pnpm-lock.yaml* ./
COPY apps/daemon/package.json ./apps/daemon/
COPY apps/web/package.json ./apps/web/
COPY packages/contracts/package.json ./packages/contracts/
COPY tools/dev/package.json ./tools/dev/

# Install all deps. NODE_ENV=development forces pnpm to install
# devDependencies (typescript, tsx, etc.). pnpm's --prod=false flag
# alone is not enough on some buildkit sandboxes.
# --frozen-lockfile ensures we match the committed lockfile exactly.
ENV NODE_ENV=development
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# Copy sources
COPY tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY tools ./tools
COPY addons/ha-ai-designer ./addons/ha-ai-designer

# 1. Build daemon → apps/daemon/dist/
# NOTE: invoke the tsc shim at /build/node_modules/.bin/tsc directly.
# pnpm 10 hoists bin shims to the workspace root only — it does NOT create
# apps/daemon/node_modules/typescript/bin/tsc — so `pnpm run build`
# (which calls `tsc`) fails with "Cannot find module tsc".
# Also pass --typeRoots so tsc finds @types/node etc. hoisted to the
# workspace root (not in apps/daemon/node_modules/@types/).
# Force pnpm to recreate per-package node_modules (incl. @types)
# on every build — otherwise BuildKit's image layer cache reuses a
# stale symlink whose target points at a Windows path that does not
# exist inside the Linux build container.
ENV CI=true
RUN rm -rf /build/apps/daemon/node_modules /build/apps/web/node_modules && \
    pnpm install --frozen-lockfile && \
    /build/node_modules/.bin/tsc -p /build/apps/daemon --typeRoots /build/apps/daemon/node_modules/@types

# 2. Build web (Next.js standalone) → apps/web/.next/standalone/
# Same caveat: invoke next via the root .bin.
ENV NEXT_TELEMETRY_DISABLED=1
ENV CI=true
RUN /build/apps/web/node_modules/.bin/next build /build/apps/web

# 3. Stage out only the runtime artifacts (no .map, no src, no node_modules cache)
WORKDIR /out
RUN mkdir -p ./apps/daemon ./apps/web
RUN cp -r /build/apps/daemon/dist ./apps/daemon/dist
RUN cp -r /build/apps/daemon/package.json ./apps/daemon/
RUN cp -r /build/apps/web/.next/standalone ./apps/web/standalone
RUN cp -r /build/apps/web/.next/static ./apps/web/.next-static
RUN cp -r /build/apps/web/public ./apps/web/public
# NOTE: @ha-designer/contracts is type-only (`import type {...}` everywhere
# in the daemon). tsc erases these imports, so no runtime artifact needed.
# If a future change introduces a runtime import, re-add the COPY here.

# -------- Stage 2: runtime (hassio base) --------
FROM ${BUILD_FROM} AS runtime

# bashio is provided by the base image; nothing extra to install.

# Copy build artifacts
COPY --from=builder /out/apps/daemon /opt/ha-ai-designer/apps/daemon
COPY --from=builder /out/apps/web /opt/ha-ai-designer/apps/web

# Copy the add-on entry point
COPY addons/ha-ai-designer/run.sh /run.sh
RUN chmod a+x /run.sh

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
