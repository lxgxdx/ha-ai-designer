'use client';

/**
 * Custom error page (500 / 404 fallback). Marked force-dynamic so the
 * build does not try to statically pre-render it (which would fail
 * because the daemon isn't running during `next build`).
 */
export const dynamic = 'force-dynamic';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.ReactElement {
  return (
    <main
      style={{
        maxWidth: 720,
        margin: '0 auto',
        padding: '64px 24px',
        textAlign: 'center',
      }}
    >
      <h1 style={{ fontSize: 28, margin: 0, color: 'var(--err)' }}>
        出错了
      </h1>
      <p
        style={{
          color: 'var(--text-dim)',
          marginTop: 12,
          fontFamily: 'ui-monospace, monospace',
          fontSize: 13,
        }}
      >
        {error?.message ?? '未知错误'}
      </p>
      {error?.digest && (
        <p
          style={{
            color: 'var(--text-dim)',
            fontSize: 11,
            marginTop: 8,
            fontFamily: 'ui-monospace, monospace',
          }}
        >
          digest: {error.digest}
        </p>
      )}
      <button
        type="button"
        onClick={reset}
        style={{
          marginTop: 24,
          padding: '8px 20px',
          background: 'var(--accent)',
          color: 'white',
          border: 'none',
          borderRadius: 6,
          fontSize: 14,
          fontWeight: 600,
          cursor: 'pointer',
        }}
      >
        重试
      </button>
    </main>
  );
}
