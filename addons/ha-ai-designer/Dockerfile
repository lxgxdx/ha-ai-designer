# ==============================================================================
# HA AI Designer — multi-stage Dockerfile
# ==============================================================================
# Stage 1: builder (node:24-alpine)
#   - pnpm install → tsc daemon → next build web (with output: 'standalone')
# Stage 2: runtime (hassio base + Node.js)
#   - Copy daemon dist + web .next/standalone
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

# -------- 2. Build web (Next.js standalone → apps/web/.next/standalone/) --------
ENV NEXT_TELEMETRY_DISABLED=1
ENV CI=true
RUN /build/apps/web/node_modules/.bin/next build /build/apps/web

# -------- 3. Stage out only the runtime artifacts --------
# Standalone output already includes a pruned node_modules.
WORKDIR /out
RUN mkdir -p ./apps/daemon ./apps/web
RUN cp -r /build/apps/daemon/dist ./apps/daemon/dist
RUN cp /build/apps/daemon/package.json ./apps/daemon/
RUN cp -r /build/apps/web/.next/standalone ./apps/web/standalone
RUN cp -r /build/apps/web/.next/static ./apps/web/.next-static
RUN cp -r /build/apps/web/public ./apps/web/public 2>/dev/null || true

# -------- Stage 2: runtime (hassio base + Node.js) --------
FROM ${BUILD_FROM} AS runtime

# hassio base is Alpine-based; install Node.js.
RUN apk add --no-cache --update nodejs && node --version

# Copy built artifacts
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
