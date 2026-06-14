/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Transpile workspace packages so their TS source is consumable from app routes.
  transpilePackages: ['@ha-designer/contracts'],
  // NOTE: output: 'standalone' (and the default Next.js server build) trigger
  //  the "<Html> should not be imported outside of pages/_document" error
  //  during the static-pages prerender phase in Next.js 14.2.35 and 15.1.6.
  //  We use pnpm deploy --prod in the Dockerfile instead, which produces a
  //  self-contained runtime with all production deps inlined.
  // output: 'standalone',
  //
  // v0.4.0: HA ingress asset prefix. The HA core ingress reverse proxy
  // strips the `/hassio/ingress/<slug>` prefix before forwarding to
  // the add-on, so the Next.js server inside the container sees bare
  // paths (`/chat`, `/_next/static/...`). The browser, however, hits
  // the add-on under the full prefix path
  // (`<ha-host>:8123/hassio/ingress/<slug>/_next/static/...`).
  //
  // Next.js bakes the assetPrefix into the HTML / RSC payload at
  // BUILD time — it's literally concatenated into string literals in
  // the JS bundles (e.g. `<script src="<prefix>/_next/static/...">`).
  // This means the value MUST be set in the Dockerfile BEFORE
  // `next build` runs. We pass it as an env var that the Dockerfile
  // exports to the build context.
  //
  // The default below is empty (direct-port mode, no prefix). The
  // add-on Dockerfile overrides this to `/hassio/ingress/ha_ai_designer`
  // matching the slug in addons/ha-ai-designer/config.yaml.
  //
  // Trade-off: with the ingress assetPrefix baked in, direct-port
  // access (e.g. http://192.168.88.183:3000) will 404 on static
  // assets. Ingress is the supported access mode; direct-port access
  // is for development and requires a separate build (unset the env
  // before `next build`).
  //
  // Historical context (v0.3.3): we briefly tried basePath+assetPrefix
  // and saw 404s everywhere. The basePath was wrong — supervisor
  // already strips the prefix, so Next.js basePath is unnecessary
  // AND breaks routing. assetPrefix alone is correct: it only affects
  // asset URLs (HTML/JS/CSS chunks), not route matching.
  assetPrefix: process.env.HA_INGRESS_ASSET_PREFIX || '',
  // Forward HA_DAEMON_* env to the server runtime (used by API proxy route).
  env: {
    HA_DAEMON_URL:
      process.env.HA_DAEMON_URL ?? `http://127.0.0.1:${process.env.HA_DAEMON_PORT ?? 7456}`,
  },
};

export default nextConfig;
