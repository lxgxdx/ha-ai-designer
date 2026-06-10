/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Transpile workspace packages so their TS source is consumable from app routes.
  transpilePackages: ['@ha-designer/contracts'],
  // FIXME: output: 'standalone' triggers a Next.js 14.2.35 internal bug:
  //  "Error: <Html> should not be imported outside of pages/_document"
  //  during prerendering of /404 and /500. Temporarily disabled; the
  //  Dockerfile will copy .next + node_modules and run `next start` instead.
  // output: 'standalone',
  // Forward HA_DAEMON_* env to the server runtime (used by API proxy route).
  env: {
    HA_DAEMON_URL:
      process.env.HA_DAEMON_URL ?? `http://127.0.0.1:${process.env.HA_DAEMON_PORT ?? 7456}`,
  },
};

export default nextConfig;
