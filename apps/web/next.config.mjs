/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Transpile workspace packages so their TS source is consumable from app routes.
  transpilePackages: ['@ha-designer/contracts'],
  // Standalone output — emits `.next/standalone/` with a self-contained
  // node_modules tree, so the add-on image can copy just that dir and
  // run `node server.js` without npm install.
  output: 'standalone',
  // Forward HA_DAEMON_* env to the server runtime (used by API proxy route).
  env: {
    HA_DAEMON_URL:
      process.env.HA_DAEMON_URL ?? `http://127.0.0.1:${process.env.HA_DAEMON_PORT ?? 7456}`,
  },
};

export default nextConfig;
