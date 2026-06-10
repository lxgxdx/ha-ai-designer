/**
 * /chat — v0.5 chat page.
 *
 * Workflow:
 *   1. Type a brief in the textarea.
 *   2. Click "生成" → POST /api/chat → daemon runs LLM orchestrator.
 *   3. Result renders below: meta, warnings, generated yaml (in a <pre>).
 *   4. Optional "应用到主面板" button (v0.5b) — gated, requires explicit
 *      confirmation, hits POST /api/ha/dashboards/preview.
 *
 * Note: we don't embed an iframe of the user's HA in v0.5a — same-origin
 * policy would block it from our dev origin. The page surfaces the
 * previewUrl so the user can open it in a separate tab where they're
 * already logged in to HA.
 */

import { Suspense } from 'react';
import { ChatPane } from './ChatPane';

export const dynamic = 'force-dynamic';

export default function ChatPage(): React.ReactElement {
  return (
    <main
      style={{
        maxWidth: 1100,
        margin: '0 auto',
        padding: '32px 24px',
        display: 'flex',
        flexDirection: 'column',
        gap: 24,
      }}
    >
      <header>
        <h1 style={{ margin: 0, fontSize: 28 }}>设计工作台</h1>
        <p style={{ margin: '8px 0 0', color: 'var(--text-dim)' }}>
          用自然语言描述你想要的 dashboard。工具会拉你 HA 的实体、生成 YAML
          草稿、推到你的 HA 让你预览。生成的 config <strong>不会</strong>自动写回 —
          任何"应用"动作都需要你点确认。
        </p>
      </header>

      <Suspense fallback={<p>加载中…</p>}>
        <ChatPane />
      </Suspense>
    </main>
  );
}
