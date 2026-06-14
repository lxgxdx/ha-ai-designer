'use client';

/**
 * /setup — first-run wizard for v0.4.0.
 *
 * v0.4.0 redesign (4 steps):
 *   1. HA connection — auto-detect add-on mode (SUPERVISOR_TOKEN path)
 *      vs. non-add-on (manual baseUrl + token). One of these always works.
 *   2. LLM (chat) configuration — provider dropdown with sane baseUrl +
 *      model defaults; user fills apiKey; "Test" hits /api/llm/test.
 *   3. Embedding (RAG) configuration — 4 options:
 *        - Skip RAG (chat works in summary-only mode)
 *        - Reuse LLM endpoint (auto-fill baseUrl/apiKey from step 2)
 *        - Custom remote (user fills all)
 *        - Local self-hosted (presets: infinity + bge-m3, ollama + nomic-embed)
 *      "Test" hits /api/llm/test-embedding (returns dim + latency).
 *   4. Done — summary card + link to /chat.
 *
 * v0.2.0 → v0.4.0 difference: the v0.2.0 wizard was 3 steps
 * (HA / LLM / Done) with credentials hand-typed in the HA Add-on
 * Configuration page. v0.4.0 pulls everything into the in-app wizard
 * so the Add-on Configuration page only exposes operational knobs
 * (log_level, allowed_origins_extra). v0.4.0 also fixes the run.sh
 * nohup env `#`-comment bug that left HA_DAEMON_TOKEN unset in the
 * web process (root cause of the v0.3.5 401).
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';

const SETUP = {
  saveHa: '/api/setup/save-ha',
  testHa: '/api/setup/test-ha',
  saveLlm: '/api/setup/save-llm',
  testLlm: '/api/setup/test-llm',
  testEmbedding: '/api/setup/test-embedding',
};

// Provider presets — must stay in sync with daemon's /api/llm/providers
// (apps/daemon/src/routes/llm.ts). Both sides reference the same OpenAI-
// compatible /chat/completions shape. baseUrl with empty string means
// "user must fill in".
const LLM_PROVIDERS: { id: string; label: string; baseUrl: string; defaultModel: string; apiKeyHint: string }[] = [
  { id: 'minimax', label: 'MiniMax (m3 / M3 / Text-01)', baseUrl: 'https://api.minimaxi.com/v1', defaultModel: 'MiniMax-M3', apiKeyHint: 'sk-cp-…' },
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4o', apiKeyHint: 'sk-…' },
  { id: 'anthropic', label: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', defaultModel: 'claude-3-5-sonnet-latest', apiKeyHint: 'sk-ant-…' },
  { id: 'qwen', label: 'Qwen (DashScope)', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', defaultModel: 'qwen-plus', apiKeyHint: 'sk-…' },
  { id: 'zhipu', label: 'Zhipu (智谱)', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', defaultModel: 'glm-4-plus', apiKeyHint: '…' },
  { id: 'moonshot', label: 'Moonshot (月之暗面)', baseUrl: 'https://api.moonshot.cn/v1', defaultModel: 'moonshot-v1-32k', apiKeyHint: 'sk-…' },
  { id: 'ollama', label: 'Ollama (local)', baseUrl: 'http://localhost:11434/v1', defaultModel: 'qwen2.5-coder:32b', apiKeyHint: '（本地服务可留空）' },
  { id: 'custom', label: 'Custom (OpenAI-compatible)', baseUrl: '', defaultModel: '', apiKeyHint: '' },
];

// Embedding model presets, grouped by source. The wizard pre-fills
// baseUrl/apiKey based on the mode choice and lets the user override
// the model from this list (or type a custom model id).
const EMBEDDING_PRESETS: { model: string; dim: number; note: string }[] = [
  { model: 'text-embedding-3-small', dim: 1536, note: 'OpenAI · 1536d · 经济' },
  { model: 'text-embedding-3-large', dim: 3072, note: 'OpenAI · 3072d · 最高质量' },
  { model: 'text-embedding-ada-002', dim: 1536, note: 'OpenAI · 1536d · 旧模型' },
  { model: 'BAAI/bge-m3', dim: 1024, note: 'infinity 自托管 · 1024d · 多语言' },
  { model: 'BAAI/bge-large-en-v1.5', dim: 1024, note: 'infinity 自托管 · 1024d · 英文' },
  { model: 'nomic-embed-text', dim: 768, note: 'Ollama · 768d' },
  { model: 'mxbai-embed-large', dim: 1024, note: 'Ollama · 1024d' },
  { model: 'snowflake-arctic-embed', dim: 1024, note: 'Ollama · 1024d · 英文' },
  { model: 'voyage-3', dim: 1024, note: 'Voyage AI · 1024d · 通用' },
  { model: 'embed-english-v3.0', dim: 1024, note: 'Cohere · 1024d · 英文' },
];

type EmbeddingMode = 'skip' | 'reuse' | 'remote' | 'local';
type Step = 1 | 2 | 3 | 4;
type Status = { state: 'idle' | 'busy' | 'ok' | 'err'; msg: string };

const idleStatus: Status = { state: 'idle', msg: '' };

export default function SetupPage(): React.ReactElement {
  const router = useRouter();
  const [step, setStep] = useState<Step>(1);

  // Step 1 — HA
  const [haBaseUrl, setHaBaseUrl] = useState('http://homeassistant.local:8123');
  const [haToken, setHaToken] = useState('');
  const [haAutoDetected, setHaAutoDetected] = useState<boolean | null>(null);
  const [haShowManual, setHaShowManual] = useState(false);
  const [haStatus, setHaStatus] = useState<Status>(idleStatus);

  // Step 2 — LLM
  const [llmProvider, setLlmProvider] = useState('minimax');
  const [llmBaseUrl, setLlmBaseUrl] = useState(LLM_PROVIDERS[0]!.baseUrl);
  const [llmModel, setLlmModel] = useState(LLM_PROVIDERS[0]!.defaultModel);
  const [llmApiKey, setLlmApiKey] = useState('');
  const [llmStatus, setLlmStatus] = useState<Status>(idleStatus);

  // Step 3 — Embedding
  const [embedMode, setEmbedMode] = useState<EmbeddingMode>('reuse');
  const [embedBaseUrl, setEmbedBaseUrl] = useState('');
  const [embedApiKey, setEmbedApiKey] = useState('');
  const [embedModel, setEmbedModel] = useState('text-embedding-3-small');
  const [embedStatus, setEmbedStatus] = useState<Status>(idleStatus);

  /**
   * On mount, auto-probe /api/ha/ping. In add-on mode the daemon
   * already has the SUPERVISOR_TOKEN in /data/config.json (written
   * by run.sh), so the ping succeeds without user input. In non-
   * add-on mode the ping fails with HaConfigError and the wizard
   * shows the manual form.
   */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(SETUP.testHa);
        const j = (await res.json().catch(() => ({}))) as { ok?: boolean; haVersion?: string; wsOk?: boolean; message?: string };
        if (cancelled) return;
        if (j.ok) {
          setHaAutoDetected(true);
          setHaStatus({ state: 'ok', msg: `已通过 supervisor 自动连接 HA ${j.haVersion ?? ''} (WS: ${j.wsOk ? '✓' : '✗'})` });
        } else {
          setHaAutoDetected(false);
        }
      } catch {
        if (!cancelled) setHaAutoDetected(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  function onProviderChange(id: string): void {
    setLlmProvider(id);
    const p = LLM_PROVIDERS.find((x) => x.id === id);
    if (p) {
      setLlmBaseUrl(p.baseUrl);
      setLlmModel(p.defaultModel);
    }
  }

  /**
   * Step 3: when the user picks "Reuse LLM endpoint" or the embedding
   * model is one of the LLM-provider presets, pre-fill baseUrl/apiKey
   * from step 2. This avoids the user re-typing the OpenAI key for
   * embeddings when they're using OpenAI for both.
   */
  useEffect(() => {
    if (embedMode === 'reuse') {
      setEmbedBaseUrl(llmBaseUrl);
      setEmbedApiKey(llmApiKey);
    } else if (embedMode === 'local') {
      // Default to local infinity on the standard port
      if (!embedBaseUrl) setEmbedBaseUrl('http://localhost:7997/v1');
    }
  }, [embedMode, llmBaseUrl, llmApiKey, embedBaseUrl]);

  async function testAndSaveHa(): Promise<void> {
    setHaStatus({ state: 'busy', msg: '正在写入并测试…' });
    try {
      const save = await fetch(SETUP.saveHa, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl: haBaseUrl.trim(), token: haToken.trim() }),
      });
      if (!save.ok) {
        const j = (await save.json().catch(() => ({}))) as { message?: string };
        setHaStatus({ state: 'err', msg: `保存失败: HTTP ${save.status} ${j.message ?? ''}` });
        return;
      }
      const ping = await fetch(SETUP.testHa);
      const j = (await ping.json().catch(() => ({}))) as { ok?: boolean; haVersion?: string; wsOk?: boolean; message?: string };
      if (j.ok) {
        setHaStatus({ state: 'ok', msg: `已连接 HA ${j.haVersion ?? ''} (WS: ${j.wsOk ? '✓' : '✗'})` });
        return;
      }
      setHaStatus({ state: 'err', msg: `连接失败: ${j.message ?? `HTTP ${ping.status}`}` });
    } catch (e) {
      setHaStatus({ state: 'err', msg: (e as Error).message });
    }
  }

  async function testAndSaveLlm(): Promise<void> {
    setLlmStatus({ state: 'busy', msg: '正在写入并测试…' });
    try {
      // PATCH semantics in the daemon: only chat fields are sent.
      // The daemon merges with any existing llm section.
      const save = await fetch(SETUP.saveLlm, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: llmProvider,
          baseUrl: llmBaseUrl.trim(),
          apiKey: llmApiKey.trim(),
          model: llmModel.trim(),
        }),
      });
      if (!save.ok) {
        const j = (await save.json().catch(() => ({}))) as { message?: string; code?: string };
        setLlmStatus({ state: 'err', msg: `保存失败: ${j.message ?? `HTTP ${save.status}`} (${j.code ?? ''})` });
        return;
      }
      const test = await fetch(SETUP.testLlm, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const j = (await test.json().catch(() => ({}))) as { ok?: boolean; model?: string; latencyMs?: number; message?: string };
      if (j.ok) {
        setLlmStatus({ state: 'ok', msg: `已连通 (${j.model ?? ''}, ${j.latencyMs ?? '?'}ms)` });
        return;
      }
      setLlmStatus({ state: 'err', msg: `测试失败: ${j.message ?? `HTTP ${test.status}`}` });
    } catch (e) {
      setLlmStatus({ state: 'err', msg: (e as Error).message });
    }
  }

  /**
   * Step 3 — save embedding. If user picked "skip", we send a
   * clearing PATCH to the daemon. Otherwise we save the chosen
   * baseUrl/apiKey/model and run a probe.
   */
  const testAndSaveEmbedding = useCallback(async (): Promise<void> => {
    setEmbedStatus({ state: 'busy', msg: '正在写入并测试…' });
    try {
      let body: Record<string, unknown>;
      if (embedMode === 'skip') {
        body = { embeddingModel: null, embeddingBaseUrl: null, embeddingApiKey: null };
      } else {
        body = {
          embeddingModel: embedModel.trim(),
          embeddingBaseUrl: embedBaseUrl.trim() || null,
          embeddingApiKey: embedApiKey.trim() || null,
        };
      }
      const save = await fetch(SETUP.saveLlm, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!save.ok) {
        const j = (await save.json().catch(() => ({}))) as { message?: string };
        setEmbedStatus({ state: 'err', msg: `保存失败: ${j.message ?? `HTTP ${save.status}`}` });
        return;
      }
      if (embedMode === 'skip') {
        setEmbedStatus({ state: 'ok', msg: '已跳过 RAG（chat 走 summary-only 模式）' });
        return;
      }
      // Probe the embedding endpoint with the saved config
      const test = await fetch(SETUP.testEmbedding, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const j = (await test.json().catch(() => ({}))) as { ok?: boolean; dim?: number; latencyMs?: number; model?: string; message?: string };
      if (j.ok) {
        setEmbedStatus({ state: 'ok', msg: `已连通 (${j.model ?? ''}, ${j.dim ?? '?'}d, ${j.latencyMs ?? '?'}ms)` });
        return;
      }
      setEmbedStatus({ state: 'err', msg: `测试失败: ${j.message ?? `HTTP ${test.status}`}` });
    } catch (e) {
      setEmbedStatus({ state: 'err', msg: (e as Error).message });
    }
  }, [embedMode, embedModel, embedBaseUrl, embedApiKey]);

  const haOk = haStatus.state === 'ok';
  const llmOk = llmStatus.state === 'ok';
  const embedOk = embedStatus.state === 'ok';

  return (
    <main style={{ maxWidth: 720, margin: '0 auto', padding: '48px 24px', display: 'flex', flexDirection: 'column', gap: 24 }}>
      <header>
        <h1 style={{ margin: 0, fontSize: 28 }}>配置 HA AI Designer</h1>
        <p style={{ margin: '8px 0 0', color: 'var(--text-dim)' }}>
          第一次启动按顺序设置：HA 连接 → LLM → Embedding（可选）→ 完成。
          填完每一步点 <b>测试 & 保存</b>，通过后才能进下一步。
        </p>
      </header>

      <Stepper step={step} />

      {step === 1 && (
        <Card>
          <h2>Step 1 — 连接 Home Assistant</h2>
          {haAutoDetected === true ? (
            <>
              <p style={{ margin: 0, color: 'var(--success, #2a7)' }}>
                ✓ 检测到 add-on 模式：通过 supervisor 令牌自动连接 HA。
              </p>
              <p style={{ margin: '8px 0 0', color: 'var(--text-dim)', fontSize: 13 }}>
                无需手动配置。如需切换到非 supervisor 的 HA 实例（如开发测试），点下方"手动配置"。
              </p>
              <StatusLine status={haStatus} />
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button onClick={() => setStep(2)} style={primaryBtnStyle}>下一步 →</button>
                <button onClick={() => setHaShowManual((s) => !s)} style={secondaryBtnStyle}>
                  {haShowManual ? '收起手动配置' : '手动配置'}
                </button>
              </div>
              {haShowManual && (
                <ManualHaForm
                  baseUrl={haBaseUrl} setBaseUrl={setHaBaseUrl}
                  token={haToken} setToken={setHaToken}
                  onSubmit={testAndSaveHa}
                  status={haStatus}
                />
              )}
            </>
          ) : haAutoDetected === false ? (
            <>
              <p style={{ margin: 0, color: 'var(--text-dim)' }}>
                检测到非 add-on 模式（如本地 <code>pnpm tools-dev run web</code> 启动）。请填写 HA 的 baseUrl 和长期访问令牌。
              </p>
              <ManualHaForm
                baseUrl={haBaseUrl} setBaseUrl={setHaBaseUrl}
                token={haToken} setToken={setHaToken}
                onSubmit={testAndSaveHa}
                status={haStatus}
              />
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button onClick={testAndSaveHa} disabled={haStatus.state === 'busy' || !haToken.trim()} style={primaryBtnStyle}>测试 & 保存</button>
                <button onClick={() => setStep(2)} disabled={!haOk} style={secondaryBtnStyle}>下一步 →</button>
              </div>
            </>
          ) : (
            <p style={{ margin: 0, color: 'var(--text-dim)' }}>正在检测…</p>
          )}
        </Card>
      )}

      {step === 2 && (
        <Card>
          <h2>Step 2 — 配置 LLM（chat）</h2>
          <Field label="Provider">
            <select value={llmProvider} onChange={(e) => onProviderChange(e.target.value)} style={inputStyle}>
              {LLM_PROVIDERS.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>
          </Field>
          <Field label="Base URL" hint="OpenAI 兼容的 /chat/completions 路径">
            <input value={llmBaseUrl} onChange={(e) => setLlmBaseUrl(e.target.value)} style={inputStyle} />
          </Field>
          <Field label="Model">
            <input value={llmModel} onChange={(e) => setLlmModel(e.target.value)} style={inputStyle} />
          </Field>
          <Field label="API Key" hint={LLM_PROVIDERS.find((p) => p.id === llmProvider)?.apiKeyHint ?? ''}>
            <input
              type="password"
              value={llmApiKey}
              onChange={(e) => setLlmApiKey(e.target.value)}
              placeholder="sk-…"
              style={inputStyle}
            />
          </Field>
          <StatusLine status={llmStatus} />
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button
              onClick={testAndSaveLlm}
              disabled={llmStatus.state === 'busy' || (!llmApiKey.trim() && llmProvider !== 'ollama')}
              style={primaryBtnStyle}
            >
              测试 & 保存
            </button>
            <button onClick={() => setStep(1)} style={secondaryBtnStyle}>← 返回</button>
            <button onClick={() => setStep(3)} disabled={!llmOk} style={secondaryBtnStyle}>下一步 →</button>
          </div>
        </Card>
      )}

      {step === 3 && (
        <Card>
          <h2>Step 3 — Embedding（RAG 知识库检索）</h2>
          <p style={{ margin: 0, color: 'var(--text-dim)', fontSize: 13 }}>
            RAG 让 LLM 生成 dashboard 时参考 HA 卡片知识库（hha-knowledge）。
            跳过此步也能用 chat，但 LLM 不会查 wiki，输出质量会低一些。
          </p>

          <fieldset style={{ border: '1px solid var(--border)', borderRadius: 6, padding: 12, marginTop: 8 }}>
            <legend style={{ padding: '0 6px', fontSize: 13, fontWeight: 600 }}>选择 Embedding 模式</legend>
            {([
              ['skip', '跳过 RAG', '不设置 embedding 模型。LLM 走 summary-only 模式（v0.3.0 行为）。'],
              ['reuse', '复用 LLM 端点', `自动用 Step 2 填的 ${llmProvider} 配置。从下方列表挑一个 embedding 模型。`],
              ['remote', '远程独立端点', 'chat 和 embedding 用不同账号/服务商（如 chat 用 OpenAI、embedding 用 Voyage）。'],
              ['local', '本地自托管', 'infinity + bge-m3 / Ollama + nomic-embed 等本地推理。默认 http://localhost:7997/v1'],
            ] as [EmbeddingMode, string, string][]).map(([m, label, hint]) => (
              <label key={m} style={{ display: 'flex', gap: 8, padding: '6px 0', cursor: 'pointer' }}>
                <input
                  type="radio"
                  name="embedMode"
                  value={m}
                  checked={embedMode === m}
                  onChange={() => setEmbedMode(m)}
                  style={{ marginTop: 2 }}
                />
                <span>
                  <b>{label}</b>
                  <span style={{ display: 'block', color: 'var(--text-dim)', fontSize: 12 }}>{hint}</span>
                </span>
              </label>
            ))}
          </fieldset>

          {embedMode !== 'skip' && (
            <>
              {(embedMode === 'remote' || embedMode === 'local') && (
                <>
                  <Field label="Base URL" hint="OpenAI 兼容的 /embeddings 路径">
                    <input
                      value={embedBaseUrl}
                      onChange={(e) => setEmbedBaseUrl(e.target.value)}
                      placeholder={embedMode === 'local' ? 'http://localhost:7997/v1' : 'https://api.openai.com/v1'}
                      style={inputStyle}
                    />
                  </Field>
                  <Field label="API Key" hint="本地服务可留空">
                    <input
                      type="password"
                      value={embedApiKey}
                      onChange={(e) => setEmbedApiKey(e.target.value)}
                      placeholder="sk-…"
                      style={inputStyle}
                    />
                  </Field>
                </>
              )}
              {embedMode === 'reuse' && (
                <Field label="Base URL（自动从 LLM 端点）" hint="修改 LLM 配置后会同步更新">
                  <input value={embedBaseUrl} onChange={(e) => setEmbedBaseUrl(e.target.value)} style={inputStyle} />
                </Field>
              )}
              <Field label="Embedding Model" hint="下拉里是常用预设；也可手动输入其他 id">
                <datalist id="embed-presets">
                  {EMBEDDING_PRESETS.map((p) => (
                    <option key={p.model} value={p.model}>{p.note}</option>
                  ))}
                </datalist>
                <input
                  list="embed-presets"
                  value={embedModel}
                  onChange={(e) => setEmbedModel(e.target.value)}
                  style={inputStyle}
                />
              </Field>
            </>
          )}

          <StatusLine status={embedStatus} />
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button
              onClick={testAndSaveEmbedding}
              disabled={embedStatus.state === 'busy'}
              style={primaryBtnStyle}
            >
              {embedMode === 'skip' ? '保存' : '测试 & 保存'}
            </button>
            <button onClick={() => setStep(2)} style={secondaryBtnStyle}>← 返回</button>
            <button onClick={() => setStep(4)} disabled={!embedOk} style={secondaryBtnStyle}>下一步 →</button>
          </div>
        </Card>
      )}

      {step === 4 && (
        <Card>
          <h2>Step 4 — 完成 ✓</h2>
          <SummaryRow ok={haOk} label="Home Assistant" detail={haStatus.msg} />
          <SummaryRow ok={llmOk} label="LLM (chat)" detail={llmStatus.msg} />
          <SummaryRow ok={embedOk} label="Embedding (RAG)" detail={embedStatus.msg} />
          <p style={{ marginTop: 16, color: 'var(--text-dim)', fontSize: 13 }}>
            配置已写入 /data/config.json（权限 0600，仅当前进程可读写）。修改任一项可重新走对应步骤。
          </p>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button onClick={() => router.push('/chat')} style={primaryBtnStyle}>
              开始设计 dashboard →
            </button>
            <button onClick={() => setStep(1)} style={secondaryBtnStyle}>返回第 1 步</button>
          </div>
        </Card>
      )}
    </main>
  );
}

function ManualHaForm({
  baseUrl, setBaseUrl, token, setToken, onSubmit, status,
}: {
  baseUrl: string; setBaseUrl: (v: string) => void;
  token: string; setToken: (v: string) => void;
  onSubmit: () => void;
  status: Status;
}): React.ReactElement {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12, paddingTop: 12, borderTop: '1px dashed var(--border)' }}>
      <Field label="HA Base URL" hint="例如 http://homeassistant.local:8123">
        <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} style={inputStyle} />
      </Field>
      <Field label="HA Long-Lived Access Token" hint="HA UI → 你的头像 → 长期访问令牌 → 创建">
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…"
          style={inputStyle}
        />
      </Field>
      <StatusLine status={status} />
      <div>
        <button onClick={onSubmit} disabled={status.state === 'busy' || !token.trim()} style={primaryBtnStyle}>
          测试 & 保存
        </button>
      </div>
    </div>
  );
}

function SummaryRow({ ok, label, detail }: { ok: boolean; label: string; detail: string }): React.ReactElement {
  return (
    <div style={{ display: 'flex', gap: 12, padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
      <span style={{ color: ok ? 'var(--success, #2a7)' : 'var(--error, #c33)', fontSize: 18, width: 20 }}>
        {ok ? '✓' : '✗'}
      </span>
      <div>
        <div style={{ fontWeight: 600 }}>{label}</div>
        <div style={{ color: 'var(--text-dim)', fontSize: 12 }}>{detail || (ok ? '已配置' : '未配置')}</div>
      </div>
    </div>
  );
}

function Stepper({ step }: { step: Step }): React.ReactElement {
  const labels = ['HA 连接', 'LLM 配置', 'Embedding', '完成'];
  return (
    <ol style={{ display: 'flex', gap: 8, listStyle: 'none', padding: 0, margin: 0 }}>
      {labels.map((label, i) => {
        const n = (i + 1) as Step;
        const active = step === n;
        const done = step > n;
        return (
          <li
            key={label}
            style={{
              flex: 1,
              padding: '8px 12px',
              borderRadius: 6,
              border: '1px solid var(--border)',
              background: done ? 'var(--accent)' : active ? 'var(--bg-card)' : 'transparent',
              color: done ? 'white' : 'var(--text-dim)',
              fontSize: 13,
            }}
          >
            {n}. {label}
          </li>
        );
      })}
    </ol>
  );
}

function Card({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <section
      style={{
        background: 'var(--bg-card)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: 24,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      {children}
    </section>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }): React.ReactElement {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 13, fontWeight: 600 }}>{label}</span>
      {children}
      {hint && <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>{hint}</span>}
    </label>
  );
}

function StatusLine({ status }: { status: Status }): React.ReactElement | null {
  if (status.state === 'idle') return null;
  const color = status.state === 'busy' ? 'var(--text-dim)' : status.state === 'ok' ? 'var(--success, #2a7)' : 'var(--error, #c33)';
  return (
    <p style={{ margin: '8px 0 0', color, fontSize: 13 }}>
      {status.state === 'busy' ? '⏳' : status.state === 'ok' ? '✓' : '✗'} {status.msg}
    </p>
  );
}

const inputStyle: React.CSSProperties = {
  padding: '8px 10px',
  border: '1px solid var(--border)',
  borderRadius: 4,
  background: 'var(--bg)',
  color: 'var(--text)',
  fontFamily: 'inherit',
  fontSize: 14,
};

const primaryBtnStyle: React.CSSProperties = {
  padding: '10px 16px',
  background: 'var(--accent)',
  color: 'white',
  border: 'none',
  borderRadius: 6,
  cursor: 'pointer',
  fontWeight: 600,
};

const secondaryBtnStyle: React.CSSProperties = {
  padding: '10px 16px',
  background: 'transparent',
  color: 'var(--text)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  cursor: 'pointer',
};
