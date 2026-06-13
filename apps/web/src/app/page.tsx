import Link from 'next/link';

/**
 * Entry view — v0.1 skeleton.
 *
 * Goal: prove the lifecycle is wired (web reachable, daemon reachable).
 * Goal: surface the connect-HA flow as the next obvious step, even though
 *       the actual connect button is disabled until v0.2.
 */

// Don't statically pre-render this page: the daemon isn't running during
// `next build`, so any fetch to it would fail. Letting Next render it on
// demand at request time avoids build-time 404s on the /about link and
// similar.
export const dynamic = 'force-dynamic';

async function fetchDaemonHealth(): Promise<{
  ok: boolean;
  data?: unknown;
  error?: string;
}> {
  const url = process.env.HA_DAEMON_URL ?? 'http://127.0.0.1:7456';
  // v0.1.22: the daemon now requires X-Addon-Internal-Token on every
  // non-health request. /api/health itself is open, but we still send
  // the token when present so the same fetch helper can be reused for
  // any other future endpoint without forgetting the header.
  const headers: Record<string, string> = {};
  if (process.env.HA_DAEMON_TOKEN) {
    headers['X-Addon-Internal-Token'] = process.env.HA_DAEMON_TOKEN;
  }
  try {
    const res = await fetch(`${url}/api/health`, { cache: 'no-store', headers });
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}` };
    }
    return { ok: true, data: await res.json() };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export default async function HomePage(): Promise<React.ReactElement> {
  const health = await fetchDaemonHealth();

  return (
    <main
      style={{
        maxWidth: 880,
        margin: '0 auto',
        padding: '48px 24px',
        display: 'flex',
        flexDirection: 'column',
        gap: 32,
      }}
    >
      <header style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <h1 style={{ margin: 0, fontSize: 32, letterSpacing: '-0.01em' }}>
          HA AI Designer
        </h1>
        <p style={{ margin: 0, color: 'var(--text-dim)', fontSize: 16 }}>
          本地优先的 Home Assistant Lovelace 仪表板 AI 设计工具。v0.1 骨架 — 下一步：
          连接 HA → 拉实体 → 生成卡片 YAML → 推回 HA。
        </p>
      </header>

      <section
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
          padding: 20,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        <h2 style={{ margin: 0, fontSize: 18 }}>守护进程状态</h2>
        {health.ok ? (
          <pre style={{ margin: 0, padding: 12, background: '#0b1220', borderRadius: 6 }}>
            {JSON.stringify(health.data, null, 2)}
          </pre>
        ) : (
          <p style={{ margin: 0, color: 'var(--err)' }}>
            无法连接 daemon：{health.error}。检查 <code>pnpm tools-dev status</code>。
          </p>
        )}
      </section>

      <section
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
          padding: 20,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        <h2 style={{ margin: 0, fontSize: 18 }}>下一步</h2>
        <ol style={{ margin: 0, paddingLeft: 20, lineHeight: 1.8, color: 'var(--text-dim)' }}>
          <li>v0.2 — HA 接入：填 URL + Long-Lived Token → 拉实体列表</li>
          <li>v0.3 — RAG 知识库：HA 内置卡片 + 主流 HACS 卡片</li>
          <li>v0.4 — LLM 接入：BYOK 代理 + 结构化输出</li>
          <li>v0.5 — 实时预览 iframe</li>
          <li>v0.6 — Tweaks 滑块</li>
          <li>v0.7 — 一键推回 HA + 自动备份</li>
        </ol>
        <p style={{ marginTop: 8, color: 'var(--text-dim)' }}>
          仓库结构与开发规则见 <Link href="/about">关于页</Link>（待补）。架构细节见
          <code> docs/architecture.md</code>。
        </p>
      </section>
    </main>
  );
}
