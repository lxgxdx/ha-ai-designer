import type { Metadata } from 'next';
import './globals.css';

// Force all routes under this layout to be server-rendered on demand.
// This prevents Next.js from trying to statically prerender /404 and /500
// during `next build`, which triggers an internal Pages Router bug:
//   Error: <Html> should not be imported outside of pages/_document.
//   Error occurred prerendering page "/404".
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'HA AI Designer',
  description: 'Local-first AI designer for Home Assistant Lovelace dashboards.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
