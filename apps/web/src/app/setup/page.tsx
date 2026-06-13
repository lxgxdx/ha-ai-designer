'use client';

/**
 * /setup — first-run wizard for HA connection + LLM BYOK credentials.
 *
 * v0.2.0: previously the user had to hand-edit /data/config.json
 * (or rely on the supervisor auto-fill of HA token) and restart the
 * add-on. v0.2.0 puts a small form in front of that, hits the daemon's
 * existing POST /api/ha/config + POST /api/llm/config endpoints
 * (proxied through /api/daemon/* so X-Addon-Internal-Token is
 * attached), verifies with the existing ping + /api/llm/test, then
 * routes the user to /chat.
 *
 * State is reset on every page load — there's no "save and continue
 * later" affordance. Filling the form takes ~30 seconds; the only
 * reason to revisit is a token rotation.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';

// v0.2.0.3: the wizard's writes do NOT go through the
// /api/daemon/[...path] catch-all proxy. That proxy is GET-only
// by security policy (only /api/chat gets POST). Instead, each
// wizard step has its own narrow server-side route under
// /api/setup/* that attaches the X-Addon-Internal-Token and forwards
// to the daemon. The browser never sees the token.
const SETUP = {
  saveHa: '/api/setup/save-ha',
  testHa: '/api/setup/test-ha',
  saveLlm: '/api/setup/save-llm',
  testLlm: '/api/setup/test-llm',
};

const LLM_PROVIDERS: { id: string; label: string; defaultBaseUrl: string; defaultModel: string }[] = [
  { id: 'minimax', label: 'MiniMax (m3 / M3 / Text-01)', defaultBaseUrl: 'https://api.minimaxi.com/v1', defaultModel: 'MiniMax-M3' },
  { id: 'openai', label: 'OpenAI', defaultBaseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4o' },
  { id: 'anthropic', label: 'Anthropic', defaultBaseUrl: 'https://api.anthropic.com/v1', defaultModel: 'claude-3-5-sonnet-latest' },
  { id: 'qwen', label: 'Qwen (DashScope)', defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', defaultModel: 'qwen-plus' },
  { id: 'zhipu', label: 'Zhipu (智谱)', defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4', defaultModel: 'glm-4-plus' },
  { id: 'moonshot', label: 'Moonshot (月之暗面)', defaultBaseUrl: 'https://api.moonshot.cn/v1', defaultModel: 'moonshot-v1-32k' },
  { id: 'ollama', label: 'Ollama (local)', defaultBaseUrl: 'http://localhost:11434/v1', defaultModel: 'qwen2.5-coder:32b' },
  { id: 'custom', label: 'Custom (OpenAI-compatible)', defaultBaseUrl: '', defaultModel: '' },
];

type Step = 1 | 2 | 3;

export default function SetupPage(): React.ReactElement {
  const router = useRouter();
  const [step, setStep] = useState<Step>(1);

  // Step 1 — HA
  const [haBaseUrl, setHaBaseUrl] = useState('http://homeassistant.local:8123');
  const [haToken, setHaToken] = useState('');
  const [haStatus, setHaStatus] = useState<{ state: 'idle' | 'busy' | 'ok' | 'err'; msg: string }>({ state: 'idle', msg: '' });

  // Step 2 — LLM
  const [llmProvider, setLlmProvider] = useState('minimax');
  // `LLM_PROVIDERS[0]` is `T | undefined` under noUncheckedIndexedAccess;
  // narrow with a non-null assertion (we control the array literal, so
  // we know the first element exists).
  const [llmBaseUrl, setLlmBaseUrl] = useState(LLM_PROVIDERS[0]!.defaultBaseUrl);
  const [llmModel, setLlmModel] = useState(LLM_PROVIDERS[0]!.defaultModel);
  const [llmApiKey, setLlmApiKey] = useState('');
  const [llmStatus, setLlmStatus] = useState<{ state: 'idle' | 'busy' | 'ok' | 'err'; msg: string }>({ state: 'idle', msg: '' });

  function onProviderChange(id: string): void {
    setLlmProvider(id);
    const p = LLM_PROVIDERS.find((x) => x.id === id);
    if (p) {
      setLlmBaseUrl(p.defaultBaseUrl);
      setLlmModel(p.defaultModel);
    }
  }

  async function testAndSaveHa(): Promise<void> {
    setHaStatus({ state: 'busy', msg: '正在写入并测试…' });
    try {
      const save = await fetch(SETUP.saveHa, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl: haBaseUrl.trim(), token: haToken.trim() }),
      });
      if (!save.ok) {
        const j = await save.json().catch(() => ({}));
        setHaStatus({ state: 'err', msg: `保存失败: HTTP ${save.status} ${j.message ?? ''}` });
        return;
      }
      const ping = await fetch(SETUP.testHa);
      const j = await ping.json().catch(() => ({}));
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
        const j = await save.json().catch(() => ({}));
        setLlmStatus({ state: 'err', msg: `保存失败: ${j.message ?? `HTTP ${save.status}`} (${j.code ?? ''})` });
        return;
      }
      // /api/llm/test (with empty body) tests the saved config.
      const test = await fetch(SETUP.testLlm, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const j = await test.json().catch(() => ({}));
      if (j.ok) {
        setLlmStatus({ state: 'ok', msg: `已连通 (${j.model ?? ''}, ${j.latencyMs ?? '?'}ms)` });
        return;
      }
      setLlmStatus({ state: 'err', msg: `测试失败: ${j.message ?? `HTTP ${test.status}`}` });
    } catch (e) {
      setLlmStatus({ state: 'err', msg: (e as Error).message });
    }
  }

  function goChat(): void {
    router.push('/chat');
  }

  return (
    <main style={{ maxWidth: 720, margin: '0 auto', padding: '48px 24px', display: 'flex', flexDirection: 'column', gap: 24 }}>
      <header>
        <h1 style={{ margin: 0, fontSize: 28 }}>配置 HA AI Designer</h1>
        <p style={{ margin: '8px 0 0', color: 'var(--text-dim)' }}>
          第一次启动需要填两个东西：Home Assistant 连接 + LLM 凭证。填完后会自动测试连通性。
        </p>
      </header>

      <Stepper step={step} />

      {step === 1 && (
        <Card>
          <h2>Step 1 — 连接 Home Assistant</h2>
          <Field label="HA Base URL" hint="例如 http://homeassistant.local:8123；add-on 模式下通常不用填（自动用 supervisor token）">
            <input value={haBaseUrl} onChange={(e) => setHaBaseUrl(e.target.value)} style={inputStyle} />
          </Field>
          <Field label="HA Long-Lived Access Token" hint="在 HA UI → 你的头像 → 长期访问令牌 → 创建">
            <input
              type="password"
              value={haToken}
              onChange={(e) => setHaToken(e.target.value)}
              placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…"
              style={inputStyle}
            />
          </Field>
          <StatusLine status={haStatus} />
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button onClick={testAndSaveHa} disabled={haStatus.state === 'busy' || !haToken.trim()} style={primaryBtnStyle}>
              测试 & 保存
            </button>
            <button
              onClick={() => setStep(2)}
              disabled={haStatus.state !== 'ok'}
              style={secondaryBtnStyle}
            >
              下一步 →
            </button>
          </div>
        </Card>
      )}

      {step === 2 && (
        <Card>
          <h2>Step 2 — 配置 LLM</h2>
          <Field label="Provider">
            <select value={llmProvider} onChange={(e) => onProviderChange(e.target.value)} style={inputStyle}>
              {LLM_PROVIDERS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Base URL" hint="OpenAI 兼容的 /chat/completions 路径">
            <input value={llmBaseUrl} onChange={(e) => setLlmBaseUrl(e.target.value)} style={inputStyle} />
          </Field>
          <Field label="Model">
            <input value={llmModel} onChange={(e) => setLlmModel(e.target.value)} style={inputStyle} />
          </Field>
          <Field label="API Key" hint="Ollama 等本地服务可留空">
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
            <button onClick={testAndSaveLlm} disabled={llmStatus.state === 'busy' || (!llmApiKey.trim() && llmProvider !== 'ollama')} style={primaryBtnStyle}>
              测试 & 保存
            </button>
            <button onClick={() => setStep(1)} style={secondaryBtnStyle}>← 返回</button>
            <button
              onClick={() => setStep(3)}
              disabled={llmStatus.state !== 'ok'}
              style={secondaryBtnStyle}
            >
              下一步 →
            </button>
          </div>
        </Card>
      )}

      {step === 3 && (
        <Card>
          <h2>Step 3 — 完成</h2>
          <p style={{ color: 'var(--text-dim)' }}>
            HA 连接和 LLM 都已配置好。可以开始生成 dashboard 草稿了。
          </p>
          <button onClick={goChat} style={primaryBtnStyle}>
            开始设计 dashboard →
          </button>
        </Card>
      )}
    </main>
  );
}

function Stepper({ step }: { step: Step }): React.ReactElement {
  const labels = ['HA 连接', 'LLM 配置', '完成'];
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

function StatusLine({ status }: { status: { state: 'idle' | 'busy' | 'ok' | 'err'; msg: string } }): React.ReactElement | null {
  if (status.state === 'idle') return null;
  const color = status.state === 'busy' ? 'var(--text-dim)' : status.state === 'ok' ? 'var(--success, green)' : 'var(--error, #c33)';
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
