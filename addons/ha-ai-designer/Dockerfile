# ==============================================================================
# HA AI Designer — multi-stage Dockerfile
# ==============================================================================
# Stage 1: builder (node:24-alpine)
#   - pnpm install → tsc daemon → next build web
#   - pnpm deploy --prod for self-contained web runtime
# Stage 2: runtime (hassio base + Node.js)
#   - Copy daemon dist + deployed web dir
# ==============================================================================
# NOTE: output: 'standalone' is intentionally avoided — it triggers a
# Next.js 14.2.35 internal bug:
#   Error: <Html> should not be imported outside of pages/_document.
#   Error occurred prerendering page "/404".
# We use `pnpm deploy --prod` instead for a clean production layout.
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
    pnpm install --frozen-lockfile

# Copy sources
COPY tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY tools ./tools

# -------- 1. Build daemon (tsc → apps/daemon/dist/) --------
ENV CI=true
RUN rm -rf /build/apps/daemon/node_modules /build/apps/web/node_modules && \
    pnpm install --frozen-lockfile && \
    /build/node_modules/.bin/tsc -p /build/apps/daemon --typeRoots /build/apps/daemon/node_modules/@types

# -------- 2. Build web (Next.js → apps/web/.next/) --------
ENV NEXT_TELEMETRY_DISABLED=1
ENV CI=true
RUN /build/apps/web/node_modules/.bin/next build /build/apps/web

# -------- 3. Deploy production runtime for web --------
# pnpm deploy creates a self-contained copy with only production deps.
# We must deploy BEFORE copying .next so the directory already has node_modules.
RUN cd /build && pnpm --filter @ha-designer/web deploy --prod /out/web

# Copy .next build output into the deployed production directory.
# Also copy public/ (static assets referenced by Next.js).
RUN cp -r /build/apps/web/.next /out/web/
RUN cp -r /build/apps/web/public /out/web/public 2>/dev/null || true
# next.config.mjs is read by `next start` at runtime to resolve env vars etc.
RUN cp /build/apps/web/next.config.mjs /out/web/

# Daemon: tsc compiled JS is self-contained (no extra deps at runtime beyond
# what pnpm already installed).  We copy dist + package.json.
RUN mkdir -p /out/daemon
RUN cp -r /build/apps/daemon/dist /out/daemon/dist
RUN cp /build/apps/daemon/package.json /out/daemon/

# Also copy pnpm-workspace.yaml (daemon may import contracts — though type-only,
# keeping this path for safety)
COPY pnpm-workspace.yaml /out/

# -------- Stage 2: runtime (hassio base + Node.js) --------
FROM ${BUILD_FROM} AS runtime

# Install Node.js (Alpine package).  hassio base 16.3.2 is Alpine-based.
RUN apk add --no-cache --update nodejs && node --version

# Copy built artifacts
COPY --from=builder /out/daemon /opt/ha-ai-designer/apps/daemon
COPY --from=builder /out/web /opt/ha-ai-designer/apps/web

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
