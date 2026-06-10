import type { Metadata } from 'next';
import './globals.css';

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
