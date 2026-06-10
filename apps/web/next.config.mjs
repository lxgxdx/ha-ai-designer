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
  // Forward HA_DAEMON_* env to the server runtime (used by API proxy route).
  env: {
    HA_DAEMON_URL:
      process.env.HA_DAEMON_URL ?? `http://127.0.0.1:${process.env.HA_DAEMON_PORT ?? 7456}`,
  },
};

export default nextConfig;
