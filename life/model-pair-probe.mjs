// V7.3.2 真模型配对：同一 seed、固定 2 游戏日，local vs suanli 逐决策记录调用/token/延迟/JSON/有效动作/回退。
// 运行：node --env-file=.env life/model-pair-probe.mjs
// 安全：只输出模型名与端点 host；不输出/不写 MODEL_KEY。硬上限 MAX_CALLS。
import { mkdirSync, writeFileSync } from 'node:fs';
import { createSurvPlay, tickSurvPlay } from './survplay.mjs';
import { buildDeliberationPrompt } from './host.mjs';
import { FORMAL_OPTIONS } from './balance-probe.mjs';
import { CURRENT_EVENT_RULES } from './rng.mjs';
import { ledgerStats } from './action-ledger.mjs';

const MAX_CALLS = Math.min(300, Number(process.env.MODEL_MAX_CALLS ?? 80));
const DAYS = Number(process.env.MODEL_DAYS ?? 2);
const BASE = process.env.MODEL_BASE_URL;
const MODEL = process.env.MODEL_NAME;
const KEY = process.env.MODEL_KEY;
if (!BASE || !MODEL || !KEY) {
  console.error('缺少 MODEL_BASE_URL/MODEL_NAME/MODEL_KEY（用 --env-file=.env；不要打印 key）');
  process.exit(2);
}
const host = (() => { try { return new URL(BASE).host; } catch { return 'invalid-url'; } })();
const metrics = { calls: 0, tokens: 0, latencies: [], http: {}, parseFail: 0, invalidId: 0, fallback: 0, nullReturn: 0, decisions: 0 };

function clean(s) { return String(s ?? '').replace(/^```json?/i, '').replace(/```\s*$/i, '').trim(); }
async function realDeliberator(args) {
  metrics.decisions += 1;
  if (metrics.calls >= MAX_CALLS) { metrics.fallback += 1; return null; }
  const prompt = buildDeliberationPrompt(args);
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), Number(process.env.MODEL_TIMEOUT_MS ?? 45000));
  const t0 = Date.now();
  try {
    const res = await fetch(`${BASE.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ model: MODEL, temperature: 0.85, messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' }, max_tokens: 100 }),
      signal: ctl.signal,
    });
    const ms = Date.now() - t0;
    metrics.latencies.push(ms);
    metrics.http[res.status] = (metrics.http[res.status] ?? 0) + 1;
    if (!res.ok) { metrics.fallback += 1; return null; }
    const j = await res.json();
    metrics.calls += 1;
    metrics.tokens += j.usage?.total_tokens ?? 0;
    let p;
    try { p = JSON.parse(clean(j.choices?.[0]?.message?.content)); }
    catch { metrics.parseFail += 1; metrics.fallback += 1; return null; }
    const hit = (args.scored ?? []).find((s) => s.id === p?.id);
    if (!hit) { metrics.invalidId += 1; metrics.fallback += 1; return null; }
    return { id: hit.id };
  } catch {
    metrics.latencies.push(Date.now() - t0);
    metrics.fallback += 1;
    return null;
  } finally { clearTimeout(to); }
}

function summarise(r, arm) {
  const stats = ledgerStats(r.world)?.resident ?? null;
  return {
    arm, seed: r.world.seed, t: r.world.t, days: r.world.t / 24,
    population: Object.values(r.world.agents).filter((a) => !a.isPlayer && !a.dead).length,
    store: r.world.survival.store, food: { ...(r.world.survival.food ?? {}) },
    actions: stats, errors: r.world.survival.agentErrors ?? 0,
  };
}

const local = createSurvPlay(7, { ...FORMAL_OPTIONS, eventRulesVersion: CURRENT_EVENT_RULES });
for (let i = 0; i < DAYS * 24; i += 1) await tickSurvPlay(local);

const real = createSurvPlay(7, { ...FORMAL_OPTIONS, eventRulesVersion: CURRENT_EVENT_RULES, deliberator: realDeliberator });
for (let i = 0; i < DAYS * 24; i += 1) await tickSurvPlay(real);

const sorted = [...metrics.latencies].sort((a, b) => a - b);
const pct = (q) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null;
const out = {
  generatedAt: new Date().toISOString(), model: MODEL, endpointHost: host, maxCalls: MAX_CALLS, days: DAYS,
  local: summarise(local, 'local'), real: summarise(real, 'suanli'),
  realCalls: {
    decisions: metrics.decisions, calls: metrics.calls, tokens: metrics.tokens,
    latencyMs: { n: sorted.length, p50: pct(.5), p95: pct(.95), max: sorted.at(-1) ?? null },
    http: metrics.http, parseFail: metrics.parseFail, invalidId: metrics.invalidId, fallback: metrics.fallback,
  },
  note: 'local arm uses deterministic resident deliberator; real arm uses suanli chat completions via existing prompt builder. Key never logged.',
};
mkdirSync('docs', { recursive: true });
writeFileSync('docs/model-pair-v732.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify({ model: MODEL, host, days: DAYS, calls: metrics.calls, tokens: metrics.tokens,
  p50: out.realCalls.latencyMs.p50, p95: out.realCalls.latencyMs.p95, parseFail: metrics.parseFail,
  invalidId: metrics.invalidId, fallback: metrics.fallback, localPop: out.local.population, realPop: out.real.population }, null, 2));
