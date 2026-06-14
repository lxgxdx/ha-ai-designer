'use client';

/**
 * ChatPane — client component for the /chat page.
 *
 * Renders:
 *   - brief textarea
 *   - 生成 / 重新生成 button
 *   - meta + warnings from the orchestrator
 *   - generated YAML in a <pre>
 *   - 应用到主面板 button (gated, calls /api/ha/dashboards/preview)
 *   - 历史备份 list with restore buttons (v0.5d)
 *   - error display
 */

import { useEffect, useState, useTransition } from 'react';

interface ChatResult {
  ok: boolean;
  config?: unknown;
  yaml?: string;
  meta?: {
    skillName: string;
    entitiesIncluded: number;
    model: string;
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  };
  warnings?: string[];
  message?: string;
}

interface PreviewResult {
  ok: boolean;
  sessionId?: string;
  previewUrl?: string;
  backupPath?: string;
  hasBackup?: boolean;
  message?: string;
}

interface BackupEntry {
  sessionId: string;
  backupPath: string;
  sizeBytes: number;
  createdAt: string;
}

interface RestoreResult {
  ok: boolean;
  sessionId?: string;
  config?: unknown;
  message?: string;
}

interface IframePolicy {
  ok: boolean;
  haBaseUrl?: string;
  haPreviewUrl?: string;
  xFrameOptions?: string | null;
  csp?: string | null;
  cspFrameAncestors?: string | null;
  allowsEmbed?: boolean;
  recommendation?: 'iframe' | 'new-tab';
  hint?: string | null;
  error?: string;
}

export function ChatPane(): React.ReactElement {
  const [brief, setBrief] = useState('做一个全屋概览，深蓝主题，控灯光为主。简洁、信息密度高。');
  const [result, setResult] = useState<ChatResult | null>(null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [confirmIntent, setConfirmIntent] = useState('');
  const [applying, setApplying] = useState(false);

  // Backups (v0.5d)
  const [backups, setBackups] = useState<BackupEntry[]>([]);
  const [backupsLoading, setBackupsLoading] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null); // sessionId being restored
  const [restoreIntent, setRestoreIntent] = useState(''); // shared intent input for restore
  const [restoreResult, setRestoreResult] = useState<RestoreResult | null>(null);

  // Iframe policy (v0.5f)
  const [iframePolicy, setIframePolicy] = useState<IframePolicy | null>(null);
  const [iframeLoaded, setIframeLoaded] = useState(false);

  // v0.2.0: streaming LLM output. The brief produces a stream of
  // text-event-stream chunks; we accumulate them into `streamedText` so
  // the user sees the LLM thinking in real time instead of staring at a
  // blank box for 2–8 seconds. Once the `done` event arrives the
  // `result` state is populated with the parsed LovelaceConfig.
  const [streamedText, setStreamedText] = useState('');
  const [streamStatus, setStreamStatus] = useState<'idle' | 'streaming'>('idle');

  // v0.3.2.3: feedback on the generated dashboard. 1-5 stars (we render
  // as 👍/👎 + optional comment). Persisted to
  // ${HA_KNOWLEDGE_DIR}/.feedback/feedback.jsonl by the daemon, which
  // scripts/learn.ts (v0.3.2.4) reads back to drive wiki-note rewrites.
  const [feedbackSubmitting, setFeedbackSubmitting] = useState(false);
  const [feedbackDone, setFeedbackDone] = useState<null | 'up' | 'down'>(null);
  const [feedbackComment, setFeedbackComment] = useState('');
  const [showFeedbackComment, setShowFeedbackComment] = useState(false);

  /** Extract entity_ids the LLM touched by walking the parsed config. */
  function extractEntityRefs(config: unknown): string[] {
    const out = new Set<string>();
    const walk = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (const x of node) walk(x);
        return;
      }
      const obj = node as Record<string, unknown>;
      if (typeof obj.entity === 'string') out.add(obj.entity);
      if (Array.isArray(obj.entities)) {
        for (const e of obj.entities) {
          if (typeof e === 'string') out.add(e);
          else if (e && typeof e === 'object' && typeof (e as { entity?: string }).entity === 'string') {
            out.add((e as { entity: string }).entity);
          }
        }
      }
      for (const k of ['cards', 'sections', 'views', 'entities', 'badges']) {
        if (obj[k] !== undefined) walk(obj[k]);
      }
    };
    walk(config);
    return Array.from(out).slice(0, 200);
  }

  async function submitFeedback(rating: number): Promise<void> {
    if (!result?.yaml) return;
    if (feedbackSubmitting) return;
    setFeedbackSubmitting(true);
    try {
      const res = await fetch(`${daemonUrl}/api/chat/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          brief,
          yaml: result.yaml,
          rating,
          comment: feedbackComment.trim() || undefined,
          entityRefs: extractEntityRefs(result.config),
        }),
      });
      if (!res.ok && res.status !== 204) {
        throw new Error(`HTTP ${res.status}`);
      }
      setFeedbackDone(rating >= 4 ? 'up' : 'down');
    } catch (e) {
      console.warn('failed to submit feedback', e);
      setError(`反馈提交失败：${(e as Error).message}`);
    } finally {
      setFeedbackSubmitting(false);
    }
  }

  // v0.2.0: every daemon call goes through the same-origin Next.js
  // catch-all proxy at /api/daemon/* (apps/web/src/app/api/daemon/[...path]/route.ts),
  // which attaches the X-Addon-Internal-Token header. The browser
  // itself can never reach http://127.0.0.1:7456 (container-internal
  // loopback), so this is the only way /api/chat etc. actually work
  // from the user's browser — even in add-on mode.
  const daemonUrl = '/api/daemon';

  // Load backups on mount + after every successful push (the new one
  // is added to the list).
  async function loadBackups(): Promise<void> {
    setBackupsLoading(true);
    try {
      const res = await fetch(`${daemonUrl}/api/ha/dashboards/preview/backups`);
      const json = (await res.json()) as { backups: BackupEntry[] };
      setBackups(json.backups ?? []);
    } catch (e) {
      // non-fatal
      console.warn('failed to load backups', e);
    } finally {
      setBackupsLoading(false);
    }
  }

  async function loadIframePolicy(): Promise<void> {
    try {
      const res = await fetch(`${daemonUrl}/api/ha/dashboards/preview/iframe-policy`);
      const json = (await res.json()) as IframePolicy;
      setIframePolicy(json);
    } catch (e) {
      console.warn('failed to load iframe policy', e);
    }
  }

  useEffect(() => {
    loadBackups();
    loadIframePolicy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function generate(): Promise<void> {
    setError(null);
    setPreview(null);
    setRestoreResult(null);
    setResult(null);
    setStreamedText('');
    setStreamStatus('streaming');
    startTransition(async () => {
      try {
        const res = await fetch(`${daemonUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
          body: JSON.stringify({ brief }),
        });
        if (!res.ok || !res.body) {
          setStreamStatus('idle');
          setError(`HTTP ${res.status}`);
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let finalResult: ChatResult | null = null;
        let gotDone = false;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          // SSE events are separated by a blank line (\n\n). Split and
          // keep the trailing partial chunk in `buffer`.
          const events = buffer.split('\n\n');
          buffer = events.pop() ?? '';
          for (const ev of events) {
            let eventName = 'message';
            let dataStr = '';
            for (const line of ev.split('\n')) {
              if (line.startsWith('event:')) eventName = line.slice(6).trim();
              else if (line.startsWith('data:')) dataStr += line.slice(5).trim();
            }
            if (!dataStr) continue;
            let payload: {
              ok?: boolean;
              chunk?: string;
              config?: unknown;
              yaml?: string;
              meta?: ChatResult['meta'];
              warnings?: string[];
              message?: string;
            };
            try { payload = JSON.parse(dataStr); } catch { continue; }
            if (eventName === 'llm-chunk' && typeof payload.chunk === 'string') {
              setStreamedText((prev) => prev + payload.chunk!);
            } else if (eventName === 'done' && payload.ok) {
              finalResult = {
                ok: true,
                config: payload.config,
                yaml: payload.yaml,
                meta: payload.meta,
                warnings: payload.warnings,
              };
              gotDone = true;
            } else if (eventName === 'error' || payload.ok === false) {
              setError(payload.message ?? 'LLM 编排失败');
            }
          }
        }
        if (finalResult) setResult(finalResult);
        if (!gotDone && !finalResult) {
          setError('stream ended without a done event');
        }
        setStreamStatus('idle');
      } catch (e) {
        setStreamStatus('idle');
        setError((e as Error).message);
      }
    });
  }

  async function applyToMain(): Promise<void> {
    if (!result?.config) return;
    if (!confirmIntent.trim()) {
      setError('请填写本次推送的目的说明（intent）');
      return;
    }
    setError(null);
    setApplying(true);
    try {
      const res = await fetch(`${daemonUrl}/api/ha/dashboards/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          config: result.config,
          __confirmed_by_user: true,
          intent: confirmIntent,
        }),
      });
      const json = (await res.json()) as PreviewResult;
      if (!res.ok || !json.ok) {
        setError(json.message ?? `HTTP ${res.status}`);
        setPreview(null);
        return;
      }
      setPreview(json);
      setConfirmIntent('');
      // Reload the backup list — the new push created one.
      loadBackups();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setApplying(false);
    }
  }

  async function restoreBackup(sessionId: string): Promise<void> {
    if (!restoreIntent.trim()) {
      setError('请填写本次回滚的目的说明（intent）');
      return;
    }
    setError(null);
    setRestoring(sessionId);
    try {
      const res = await fetch(
        `${daemonUrl}/api/ha/dashboards/preview/backups/${encodeURIComponent(sessionId)}/restore`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            __confirmed_by_user: true,
            intent: restoreIntent,
          }),
        },
      );
      const json = (await res.json()) as RestoreResult;
      if (!res.ok || !json.ok) {
        setError(json.message ?? `HTTP ${res.status}`);
        setRestoreResult(null);
        return;
      }
      setRestoreResult(json);
      setRestoreIntent('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRestoring(null);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <section
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
          padding: 20,
        }}
      >
        <label
          htmlFor="brief"
          style={{ display: 'block', marginBottom: 8, fontSize: 14, color: 'var(--text-dim)' }}
        >
          你的 brief（自然语言）
        </label>
        <textarea
          id="brief"
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          rows={4}
          style={{
            width: '100%',
            background: '#0b1220',
            color: 'var(--text)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            padding: 12,
            fontSize: 14,
            fontFamily: 'inherit',
            resize: 'vertical',
          }}
        />
        <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
          <button
            type="button"
            onClick={generate}
            disabled={isPending || !brief.trim()}
            style={{
              padding: '10px 20px',
              background: isPending ? '#475569' : 'var(--accent)',
              color: 'white',
              border: 'none',
              borderRadius: 6,
              fontSize: 14,
              fontWeight: 600,
              cursor: isPending ? 'wait' : 'pointer',
            }}
          >
            {isPending ? '生成中…（约 30-60 秒）' : '生成 dashboard 草稿'}
          </button>
          {streamStatus === 'streaming' && (
            <span style={{ color: 'var(--text-dim)', fontSize: 13, alignSelf: 'center' }}>
              ⏳ 实时流式生成中…（{streamedText.length} 字符已收）
            </span>
          )}
          {result && (
            <span style={{ color: 'var(--text-dim)', fontSize: 13, alignSelf: 'center' }}>
              {result.meta?.skillName} · {result.meta?.entitiesIncluded} 实体
              {result.meta?.usage && ` · ${result.meta.usage.total_tokens} tokens`}
            </span>
          )}
        </div>
      </section>

      {streamStatus === 'streaming' && (
        <section
          style={{
            background: 'var(--bg-card)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: 16,
          }}
        >
          <h3 style={{ margin: '0 0 8px', fontSize: 14, color: 'var(--text-dim)' }}>
            LLM 实时输出
          </h3>
          <pre
            style={{
              margin: 0,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              fontSize: 13,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              maxHeight: 320,
              overflowY: 'auto',
            }}
          >
            {streamedText}
          </pre>
        </section>
      )}

      {error && (
        <section
          style={{
            background: '#3f1212',
            border: '1px solid var(--err)',
            borderRadius: 'var(--radius)',
            padding: 16,
            color: '#fecaca',
          }}
        >
          <strong>错误：</strong> {error}
        </section>
      )}

      {result && (
        <section
          style={{
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            padding: 20,
            display: 'flex',
            flexDirection: 'column',
            gap: 16,
          }}
        >
          <h2 style={{ margin: 0, fontSize: 20 }}>生成的 YAML 草稿</h2>

          {result.warnings && result.warnings.length > 0 && (
            <div
              style={{
                background: '#3f3012',
                border: '1px solid #f59e0b',
                borderRadius: 6,
                padding: 12,
                color: '#fde68a',
                fontSize: 13,
              }}
            >
              <strong>{result.warnings.length} 条警告：</strong>
              <ul style={{ margin: '8px 0 0', paddingLeft: 20 }}>
                {result.warnings.slice(0, 10).map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
                {result.warnings.length > 10 && <li>…还有 {result.warnings.length - 10} 条</li>}
              </ul>
            </div>
          )}

          {/* v0.3.2.3: feedback row. 👍 (rating=5) / 👎 (rating=2) + optional
              comment. Hidden after submit. Once submitted, the daemon
              writes a JSONL line to ${HA_KNOWLEDGE_DIR}/.feedback/. */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: 10,
              background: '#0b1220',
              border: '1px solid var(--border)',
              borderRadius: 6,
              fontSize: 13,
              color: 'var(--text-dim)',
            }}
          >
            {feedbackDone ? (
              <span style={{ color: 'var(--text)' }}>
                {feedbackDone === 'up' ? '✓ 已记录好评，感谢反馈' : '✓ 已记录差评，learn.ts 会基于此改写 wiki 笔记'}
                {feedbackComment && <em style={{ marginLeft: 8 }}>“{feedbackComment}”</em>}
              </span>
            ) : (
              <>
                <span>这一稿对不对？</span>
                <button
                  type="button"
                  onClick={() => submitFeedback(5)}
                  disabled={feedbackSubmitting}
                  title="5 星：完美 / 直接可用"
                  style={{
                    padding: '6px 12px',
                    background: feedbackSubmitting ? '#475569' : '#16a34a',
                    color: 'white',
                    border: 'none',
                    borderRadius: 4,
                    fontSize: 14,
                    cursor: feedbackSubmitting ? 'wait' : 'pointer',
                  }}
                >
                  👍
                </button>
                <button
                  type="button"
                  onClick={() => submitFeedback(2)}
                  disabled={feedbackSubmitting}
                  title="2 星：有明显问题"
                  style={{
                    padding: '6px 12px',
                    background: feedbackSubmitting ? '#475569' : '#dc2626',
                    color: 'white',
                    border: 'none',
                    borderRadius: 4,
                    fontSize: 14,
                    cursor: feedbackSubmitting ? 'wait' : 'pointer',
                  }}
                >
                  👎
                </button>
                <button
                  type="button"
                  onClick={() => setShowFeedbackComment((v) => !v)}
                  style={{
                    padding: '4px 8px',
                    background: 'transparent',
                    color: 'var(--text-dim)',
                    border: '1px solid var(--border)',
                    borderRadius: 4,
                    fontSize: 12,
                    cursor: 'pointer',
                  }}
                >
                  {showFeedbackComment ? '收起评论' : '加评论'}
                </button>
                {showFeedbackComment && (
                  <input
                    type="text"
                    value={feedbackComment}
                    onChange={(e) => setFeedbackComment(e.target.value)}
                    placeholder="（可选）说明哪里不对，例如 '灯卡全用 tile 但我装的是 mushroom'"
                    style={{
                      flex: 1,
                      minWidth: 200,
                      background: '#0b1220',
                      color: 'var(--text)',
                      border: '1px solid var(--border)',
                      borderRadius: 4,
                      padding: '6px 8px',
                      fontSize: 12,
                    }}
                  />
                )}
              </>
            )}
          </div>

          <pre
            style={{
              margin: 0,
              padding: 16,
              background: '#0b1220',
              borderRadius: 6,
              maxHeight: 480,
              overflow: 'auto',
              fontSize: 12,
              lineHeight: 1.5,
            }}
          >
            {result.yaml}
          </pre>

          <div
            style={{
              borderTop: '1px solid var(--border)',
              paddingTop: 16,
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
            }}
          >
            <h3 style={{ margin: 0, fontSize: 16 }}>应用到主面板（写入你 HA 的 lovelace）</h3>
            <p style={{ margin: 0, color: 'var(--text-dim)', fontSize: 13 }}>
              这一步会<strong>真改</strong>你 HA 的默认 dashboard。工具会先自动备份原 config，
              你随时可以回滚。预览请在你已登录 HA 的浏览器里打开{' '}
              <a
                href="http://192.168.88.183:8123/lovelace/lovelace"
                target="_blank"
                rel="noreferrer"
              >
                http://192.168.88.183:8123/lovelace/lovelace
              </a>
              。
            </p>
            <label
              htmlFor="intent"
              style={{ fontSize: 13, color: 'var(--text-dim)' }}
            >
              写本次的目的（daemon 日志会留痕）
            </label>
            <input
              id="intent"
              value={confirmIntent}
              onChange={(e) => setConfirmIntent(e.target.value)}
              placeholder="例如：'客厅 5 灯重新分组'"
              style={{
                background: '#0b1220',
                color: 'var(--text)',
                border: '1px solid var(--border)',
                borderRadius: 6,
                padding: 10,
                fontSize: 14,
              }}
            />
            <button
              type="button"
              onClick={applyToMain}
              disabled={applying || !result}
              style={{
                alignSelf: 'flex-start',
                padding: '10px 20px',
                background: applying ? '#475569' : '#dc2626',
                color: 'white',
                border: 'none',
                borderRadius: 6,
                fontSize: 14,
                fontWeight: 600,
                cursor: applying ? 'wait' : 'pointer',
              }}
            >
              {applying ? '推送中…' : '⚠ 确认推送到我的 HA'}
            </button>
          </div>
        </section>
      )}

      {preview && (
        <section
          style={{
            background: 'var(--surface)',
            border: '1px solid #22c55e',
            borderRadius: 'var(--radius)',
            padding: 20,
            color: '#bbf7d0',
          }}
        >
          <h2 style={{ margin: 0, fontSize: 18 }}>✓ 已推送</h2>
          <ul style={{ marginTop: 12, lineHeight: 1.8 }}>
            <li>
              <strong>sessionId</strong>: <code>{preview.sessionId}</code>
            </li>
            <li>
              <strong>previewUrl</strong>:{' '}
              <a
                href={`http://192.168.88.183:8123${preview.previewUrl}`}
                target="_blank"
                rel="noreferrer"
              >
                http://192.168.88.183:8123{preview.previewUrl}
              </a>
            </li>
            <li>
              <strong>backup</strong>:{' '}
              {preview.hasBackup ? (
                <code>{preview.backupPath}</code>
              ) : (
                <em>（未备份 — 之前取原 config 失败）</em>
              )}
            </li>
          </ul>

          <div
            style={{
              marginTop: 16,
              padding: 16,
              background: '#0b1220',
              border: '1px solid #1e293b',
              borderRadius: 6,
              color: 'var(--text)',
            }}
          >
            <h3 style={{ margin: 0, fontSize: 15 }}>在 HA 中看效果</h3>
            <p style={{ margin: '8px 0 12px', color: 'var(--text-dim)', fontSize: 13 }}>
              工具和你的 HA 在不同 origin（127.0.0.1:3000 vs 192.168.88.183:8123），HA 默认
              X-Frame-Options: SAMEORIGIN 会拒绝跨域 iframe。下面按你 HA 的策略给最稳的方案。
            </p>

            {iframePolicy && (
              <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 12 }}>
                HA 头：<code>X-Frame-Options: {iframePolicy.xFrameOptions ?? '(none)'}</code>
                {iframePolicy.cspFrameAncestors && (
                  <> · <code>{iframePolicy.cspFrameAncestors}</code></>
                )}
                {iframePolicy.allowsEmbed ? (
                  <span style={{ color: '#86efac' }}> · 允许嵌入</span>
                ) : (
                  <span style={{ color: '#fcd34d' }}> · 拒绝跨域</span>
                )}
              </div>
            )}

            {iframePolicy?.allowsEmbed ? (
              <div>
                <iframe
                  src="http://192.168.88.183:8123/lovelace/lovelace"
                  title="HA preview"
                  sandbox="allow-scripts allow-same-origin allow-forms"
                  onLoad={() => setIframeLoaded(true)}
                  style={{
                    width: '100%',
                    height: 480,
                    background: 'white',
                    border: '1px solid var(--border)',
                    borderRadius: 6,
                  }}
                />
                {!iframeLoaded && (
                  <p style={{ marginTop: 8, color: 'var(--text-dim)', fontSize: 12 }}>
                    iframe 加载中…如果一直空白，多半是 HA 在 iframe 内拒绝登录态
                    —— 用下方大按钮。
                  </p>
                )}
              </div>
            ) : (
              <div
                style={{
                  padding: 12,
                  background: '#1f1505',
                  border: '1px solid #f59e0b',
                  borderRadius: 6,
                  color: '#fde68a',
                  fontSize: 13,
                }}
              >
                <strong>iframe 不可用：</strong>{' '}
                {iframePolicy?.hint ??
                  'HA 默认拒绝跨域 iframe。需要在新窗口打开或在 HA 配反向嵌入。'}
              </div>
            )}

            <div style={{ marginTop: 12, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <a
                href="http://192.168.88.183:8123/lovelace/lovelace"
                target="_blank"
                rel="noreferrer"
                style={{
                  display: 'inline-block',
                  padding: '10px 20px',
                  background: 'var(--accent)',
                  color: 'white',
                  borderRadius: 6,
                  textDecoration: 'none',
                  fontSize: 14,
                  fontWeight: 600,
                }}
              >
                ↗ 在新窗口打开 HA 预览
              </a>
              <a
                href="http://192.168.88.183:8123"
                target="_blank"
                rel="noreferrer"
                style={{
                  display: 'inline-block',
                  padding: '10px 20px',
                  background: '#475569',
                  color: 'white',
                  borderRadius: 6,
                  textDecoration: 'none',
                  fontSize: 14,
                  fontWeight: 600,
                }}
              >
                打开 HA 首页
              </a>
            </div>

            <details style={{ marginTop: 16 }}>
              <summary
                style={{ cursor: 'pointer', color: 'var(--text-dim)', fontSize: 13 }}
              >
                进阶：把工具反向嵌入 HA（消除跨域）
              </summary>
              <div
                style={{
                  marginTop: 8,
                  padding: 12,
                  background: '#0b1220',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  color: 'var(--text-dim)',
                  fontSize: 12,
                  fontFamily: 'ui-monospace, monospace',
                  whiteSpace: 'pre-wrap',
                }}
              >
{`# 在你的 HA configuration.yaml 加：
lovelace:
  dashboards:
    ai-designer:
      mode: yaml
      title: AI Designer
      icon: mdi:robot
      show_in_sidebar: true
      filename: ai-designer.yaml

# 然后创建 ui-lovelace.yaml（或 ai-designer.yaml）：
title: AI Designer
views:
  - title: 工具
    panel: true
    cards:
      - type: iframe
        url: http://127.0.0.1:3000/chat
        aspect_ratio: 100%

# 工具就在 HA 侧栏出现。
# 因为现在工具在 HA 内部（同源），反向嵌回 HA 也不会被 X-Frame-Options 拦。`}
              </div>
            </details>
          </div>

          <p style={{ marginTop: 12, color: '#bbf7d0' }}>
            满意就保持，不满意在下方"历史备份"里一键回滚。
          </p>
        </section>
      )}

      {restoreResult && (
        <section
          style={{
            background: 'var(--surface)',
            border: '1px solid #22c55e',
            borderRadius: 'var(--radius)',
            padding: 20,
            color: '#bbf7d0',
          }}
        >
          <h2 style={{ margin: 0, fontSize: 18 }}>↶ 已回滚到备份 <code>{restoreResult.sessionId}</code></h2>
          <p style={{ marginTop: 8 }}>
            你的 HA dashboard 已恢复到该 session 时的 config。在 HA 浏览器刷新 <code>/lovelace/lovelace</code> 看效果。
          </p>
        </section>
      )}

      <section
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
          padding: 20,
        }}
      >
        <h2 style={{ margin: 0, fontSize: 18 }}>历史备份</h2>
        <p style={{ margin: '8px 0 12px', color: 'var(--text-dim)', fontSize: 13 }}>
          每次"应用到主面板"前自动备份一份当前 config 到 <code>data/backups/lovelace/</code>。
          点恢复即把当时备份推回你的 HA，<strong>会再生成一份当前 backup</strong>以防回滚后悔。
        </p>

        {backupsLoading ? (
          <p style={{ color: 'var(--text-dim)' }}>加载中…</p>
        ) : backups.length === 0 ? (
          <p style={{ color: 'var(--text-dim)', fontSize: 13 }}>
            还没有任何备份。第一次"应用到主面板"后这里会出现条目。
          </p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {backups.map((b) => (
              <li
                key={b.sessionId}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: 10,
                  background: '#0b1220',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 13 }}>
                    {b.sessionId}
                  </div>
                  <div style={{ color: 'var(--text-dim)', fontSize: 12, marginTop: 2 }}>
                    {new Date(b.createdAt).toLocaleString('zh-CN')} ·{' '}
                    {(b.sizeBytes / 1024).toFixed(1)} KB
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => restoreBackup(b.sessionId)}
                  disabled={restoring !== null || !restoreIntent.trim()}
                  style={{
                    padding: '6px 12px',
                    background: restoring === b.sessionId ? '#475569' : '#475569',
                    color: 'white',
                    border: 'none',
                    borderRadius: 4,
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: restoring !== null ? 'wait' : 'pointer',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {restoring === b.sessionId ? '回滚中…' : '↶ 恢复此备份'}
                </button>
              </li>
            ))}
          </ul>
        )}

        <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <label htmlFor="restore-intent" style={{ fontSize: 13, color: 'var(--text-dim)' }}>
            回滚的目的（daemon 日志会留痕）
          </label>
          <input
            id="restore-intent"
            value={restoreIntent}
            onChange={(e) => setRestoreIntent(e.target.value)}
            placeholder="例如：'客厅灯分组不好，回滚'"
            style={{
              background: '#0b1220',
              color: 'var(--text)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              padding: 10,
              fontSize: 14,
            }}
          />
          <p style={{ margin: 0, color: 'var(--text-dim)', fontSize: 12 }}>
            填了 intent 后，"恢复"按钮才会变可点。
          </p>
        </div>
      </section>
    </div>
  );
}
