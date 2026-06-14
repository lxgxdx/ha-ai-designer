import Link from 'next/link';
import { redirect } from 'next/navigation';

/**
 * Entry view — v0.2.0.
 *
 * First-time setup gate: if neither HA nor LLM is configured, redirect
 * the user to /setup. Once both are set, render the dashboard home
 * (daemon health snapshot + chat shortcut + next-step roadmap).
 */

// Don't statically pre-render this page: the daemon isn't running during
// `next build`, so any fetch to it would fail. Letting Next render it on
// demand at request time avoids build-time 404s on the /about link and
// similar.
export const dynamic = 'force-dynamic';

const DAEMON = process.env.HA_DAEMON_URL ?? 'http://127.0.0.1:7456';
const TOKEN = process.env.HA_DAEMON_TOKEN ?? '';

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  return { ...(extra ?? {}), ...(TOKEN ? { 'X-Addon-Internal-Token': TOKEN } : {}) };
}

async function fetchDaemonHealth(): Promise<{
  ok: boolean;
  data?: unknown;
  error?: string;
}> {
  try {
    const res = await fetch(`${DAEMON}/api/health`, { cache: 'no-store', headers: authHeaders() });
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}` };
    }
    return { ok: true, data: await res.json() };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

interface SetupStatus {
  llmConfigured: boolean;
  haConfigured: boolean;
  /**
   * v0.4.0: embedding configuration state. Three values:
   *   - 'configured': llm.embeddingModel is set
   *   - 'skipped':    wizard step 3 chose "Skip RAG" (or embedding
   *                   was never set in v0.3.x and wizard hasn't run)
   *   - 'unknown':    could not read llm config (daemon down, etc.)
   * Embedding is OPTIONAL — chat works in summary-only mode without
   * it. The page does NOT redirect on missing embedding.
   */
  embeddingState: 'configured' | 'skipped' | 'unknown';
}

/**
 * Probe whether the wizard has been completed. We hit the daemon
 * directly (not through /api/daemon/*) because this is a server
 * component, not a browser fetch.
 */
async function fetchSetupStatus(): Promise<SetupStatus> {
  let llmConfigured = false;
  let haConfigured = false;
  let embeddingState: SetupStatus['embeddingState'] = 'unknown';
  try {
    const r = await fetch(`${DAEMON}/api/llm/config`, {
      cache: 'no-store',
      headers: authHeaders(),
    });
    if (r.ok) {
      const j = (await r.json()) as { configured?: boolean; llm?: { embeddingModel?: string } };
      llmConfigured = j.configured === true;
      embeddingState = j.llm?.embeddingModel ? 'configured' : 'skipped';
    }
  } catch { /* leave unknown */ }
  try {
    const r = await fetch(`${DAEMON}/api/ha/ping`, {
      cache: 'no-store',
      headers: authHeaders(),
    });
    if (r.ok) {
      const j = (await r.json()) as { ok?: boolean };
      haConfigured = j.ok === true;
    }
  } catch { /* leave false */ }
  return { llmConfigured, haConfigured, embeddingState };
}

export default async function HomePage(): Promise<React.ReactElement> {
  const [health, setup] = await Promise.all([fetchDaemonHealth(), fetchSetupStatus()]);

  // v0.2.0: gate the home page on the wizard. If either HA or LLM
  // isn't configured, the user hasn't finished setup yet — route
  // them there. (We tolerate daemon-down as "not configured" so
  // fresh installs land on the wizard rather than a scary error page.)
  if (!setup.llmConfigured || !setup.haConfigured || !health.ok) {
    redirect('/setup');
  }

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
          本地优先的 Home Assistant Lovelace 仪表板 AI 设计工具。
          描述你想要的 dashboard 样式，AI 会拉你的实体、生成 YAML、推回 HA。
        </p>
        <p style={{ margin: '8px 0 0' }}>
          <Link href="/chat" style={{ color: 'var(--accent)', fontWeight: 600 }}>
            打开设计工作台 →
          </Link>
          <span style={{ marginLeft: 16, color: 'var(--text-dim)' }}>
            <Link href="/setup" style={{ color: 'inherit' }}>重新配置</Link>
          </span>
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
        <pre style={{ margin: 0, padding: 12, background: '#0b1220', borderRadius: 6 }}>
          {JSON.stringify(health.data, null, 2)}
        </pre>
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
        <h2 style={{ margin: 0, fontSize: 18 }}>路线图</h2>
        <ol style={{ margin: 0, paddingLeft: 20, lineHeight: 1.8, color: 'var(--text-dim)' }}>
          <li>v0.2 — HA 接入 wizard + /api/chat SSE streaming（当前版本）</li>
          <li>v0.3 — RAG 知识库：hha-knowledge 51 张 HA 卡片 + HACS 卡片入 orchestrator</li>
          <li>v0.4 — 实时预览 iframe + Tweaks 滑块</li>
          <li>v0.5 — 多 dashboard 覆盖（非 default storage / YAML 模式）</li>
          <li>v0.6 — 错误恢复 + 离线容忍 + entity 缓存</li>
          <li>v0.7 — HACS / Add-on 商店上架 + i18n</li>
        </ol>
      </section>
    </main>
  );
}
