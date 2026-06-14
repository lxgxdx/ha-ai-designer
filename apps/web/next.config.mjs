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
  // v0.3.3 set basePath: '/hassio/ingress/ha_ai_designer' + assetPrefix
  // based on the assumption that HA ingress passes the full prefix path
  // to the web container. After install, every route 404'd — empirically
  // HA ingress appears to ALREADY strip the ingress prefix before
  // forwarding, so the web container sees `/chat`, not
  // `/hassio/ingress/ha_ai_designer/chat`. basePath is wrong here.
  //
  // v0.2.0 worked WITHOUT basePath, which corroborates the strip
  // behavior. Reverting. If sub-page 404 ever comes back, the next
  // step is to read HA supervisor's strip config (in
  // /usr/share/hassio/share/) or switch to output: 'standalone' + a
  // custom server.
  // basePath: '/hassio/ingress/ha_ai_designer',  // v0.3.3 — wrong, see above
  // assetPrefix: '/hassio/ingress/ha_ai_designer/',  // v0.3.3 — wrong
  // Forward HA_DAEMON_* env to the server runtime (used by API proxy route).
  env: {
    HA_DAEMON_URL:
      process.env.HA_DAEMON_URL ?? `http://127.0.0.1:${process.env.HA_DAEMON_PORT ?? 7456}`,
  },
};

export default nextConfig;
