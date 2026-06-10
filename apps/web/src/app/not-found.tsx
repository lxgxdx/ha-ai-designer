/**
 * Custom 404 page. Marked force-dynamic so the build does not try to
 * statically pre-render it (which would fail because the daemon isn't
 * running during `next build`).
 */
export const dynamic = 'force-dynamic';

export default function NotFound(): React.ReactElement {
  return (
    <main
      style={{
        maxWidth: 720,
        margin: '0 auto',
        padding: '64px 24px',
        textAlign: 'center',
      }}
    >
      <h1 style={{ fontSize: 32, margin: 0 }}>404 — Not Found</h1>
      <p style={{ color: 'var(--text-dim)', marginTop: 16 }}>
        你要找的页面不存在。<a href="/" style={{ color: 'var(--accent)' }}>回首页</a>。
      </p>
    </main>
  );
}
