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
  // v0.3.3: when the add-on is served via HA ingress, the supervisor
  // proxy passes the full path (e.g. /hassio/ingress/ha_ai_designer/chat)
  // to the web container. Without basePath, Next.js routes registered
  // as `/chat` don't match, and the user sees a 404 on every Link click.
  // The slug is hardcoded (matches addons/.../config.yaml:slug) so we
  // don't need a build-time env. If you ever rename the add-on, update
  // both this basePath AND the slug field in config.yaml.
  basePath: '/hassio/ingress/ha_ai_designer',
  assetPrefix: '/hassio/ingress/ha_ai_designer/',
  // Forward HA_DAEMON_* env to the server runtime (used by API proxy route).
  env: {
    HA_DAEMON_URL:
      process.env.HA_DAEMON_URL ?? `http://127.0.0.1:${process.env.HA_DAEMON_PORT ?? 7456}`,
  },
};

export default nextConfig;
