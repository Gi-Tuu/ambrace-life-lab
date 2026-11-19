#!/usr/bin/env node
// 作者侧消融/负控基准：同一 seeds、同一 tick 数、同一初始配置下比较
//   internal = C2（内部状态通道按登记定义接通）
//   cut      = C2-neg（负向对照：切断内部状态进入决策的通道）
//   random   = C2 + 事件门控时随机选候选（只替换“被问到时”的选择，不是通用随机策略）
// 输出行为分布、可复现性与作者侧对照读数。
//
// 重要边界：这是**作者自己的消融/负控**，不是外部独立基准，也不是第三方验证。
// 它只能回答“同一装置里，切断通道后行为分布是否变化、同 seed 是否逐位可复现”。
// 第三方复现协议见 BENCHMARK.md；不要把本文件的数字写成“外部验证通过”。
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSurvPlay, tickSurvPlay } from '../life/survplay.mjs';
import { CURRENT_EVENT_RULES, hashSeed } from '../life/rng.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const TICKS = Math.max(24, Number(argOf('--ticks', 240)) || 240);
const SEEDS = String(argOf('--seeds', '7,13')).split(',').map((x) => Number(x.trim())).filter(Number.isSafeInteger);
const REPEATS = Math.max(1, Number(argOf('--repeats', 2)) || 2);
const OUT = resolve(ROOT, argOf('--out', 'evidence/score/baseline.json'));

const BASE = Object.freeze({
  gameRules: true,
  independentWorld: true,
  unifiedCooperation: true,
  ecosystem: true,
  wildFood: true,
  autonomousGoals: true,
  farmLife: true,
  settlementLife: true,
  playerRation: true,
  discussions: true,
  actTimeModel: true,
  eventRulesVersion: CURRENT_EVENT_RULES,
});

const ACTIONS = ['internal', 'cut', 'random'];

// 随机臂只替换“事件门控真的问到模型”的那一次选择；用 seed/tick/agent 派生，保证同 seed 可复现。
function randomDeliberator(seed) {
  return ({ agent, scored, world }) => {
    if (!scored.length) return null;
    const pick = hashSeed(seed, `random-pick:${world.t}:${agent.id}:${scored.length}`) % scored.length;
    return { id: scored[pick].id, reason: 'random-ask' };
  };
}

function makeArm(arm, seed) {
  const opts = { ...BASE, residentCondition: arm === 'cut' ? 'C2-neg' : 'C2' };
  if (arm === 'random') opts.deliberator = randomDeliberator(seed);
  return createSurvPlay(seed, opts);
}

function collect(sp) {
  const w = sp.world;
  const rows = [];
  for (const id of Object.keys(w.agents).sort()) {
    const a = w.agents[id];
    for (const r of a.trace ?? []) {
      if (!r?.action || r.ok === false) continue;
      if (r.layer === 'refused' || r.layer === 'aborted') continue;
      rows.push({ t: r.t, id, kind: r.kind ?? 'unknown', action: r.action });
    }
  }
  const residents = Object.values(w.agents).filter((a) => !a.isPlayer);
  const counters = residents.reduce((acc, a) => {
    for (const k of ['triggered', 'asked', 'skipped', 'askedRetry', 'informed']) acc[k] = (acc[k] ?? 0) + (a.counters?.[k] ?? 0);
    return acc;
  }, {});
  const alive = residents.filter((a) => !a.dead).length;
  const viabMean = residents.length
    ? residents.reduce((s, a) => s + (a.viab?.v ?? 0), 0) / residents.length
    : 0;
  return {
    t: w.t,
    day: Math.floor(w.t / (w.dayTicks ?? 24)),
    alive,
    deaths: (w.survival?.deaths ?? []).length,
    store: w.survival?.store ?? null,
    viabMean: Number(viabMean.toFixed(6)),
    counters,
    rows,
  };
}

function digestOf(rows, meta) {
  return createHash('sha256').update(JSON.stringify({ meta, rows })).digest('hex');
}

function kindCounts(rows) {
  const counts = {};
  for (const r of rows) counts[r.kind] = (counts[r.kind] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function distribution(rows) {
  const counts = kindCounts(rows);
  const total = Object.values(counts).reduce((a, b) => a + b, 0) || 1;
  return Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, Number((v / total).toFixed(6))]));
}

function kl(p, q) {
  const keys = new Set([...Object.keys(p), ...Object.keys(q)]);
  const eps = 1e-9;
  let sum = 0;
  for (const k of keys) {
    const a = p[k] ?? 0;
    const b = q[k] ?? eps;
    if (a > 0) sum += a * Math.log(a / b);
  }
  return Number(sum.toFixed(6));
}

function jsd(p, q) {
  const keys = new Set([...Object.keys(p), ...Object.keys(q)]);
  const m = {};
  for (const k of keys) m[k] = ((p[k] ?? 0) + (q[k] ?? 0)) / 2;
  return Number(((kl(p, m) + kl(q, m)) / 2).toFixed(6));
}

function entropy(p) {
  let h = 0;
  for (const v of Object.values(p)) if (v > 0) h -= v * Math.log2(v);
  return Number(h.toFixed(6));
}

async function runOne(arm, seed) {
  const sp = makeArm(arm, seed);
  for (let i = 0; i < TICKS; i += 1) await tickSurvPlay(sp);
  return collect(sp);
}

async function main() {
  const started = Date.now();
  const report = {
    kind: 'author-side-ablation',
    externalValidation: false,
    claim: '作者侧消融/负控：同 seeds、同 tick 数比较内部通道开/关/随机策略；不是外部独立基准。',
    generatedAt: new Date().toISOString(),
    environment: { node: process.version, platform: process.platform, arch: process.arch },
    config: { ticks: TICKS, seeds: SEEDS, repeats: REPEATS, arms: ACTIONS, base: BASE },
    arms: {},
    comparisons: {},
    reproducibility: { ok: true, runs: [] },
    caveats: [
      '随机臂只替换事件门控真的问到模型的那一次选择；其余时刻仍走同一确定性替身，因此它不是“通用随机策略”。',
      'C2-neg 是登记过的负向对照，不是外部基线；本文件不证明机制在真实模型或真实玩家下同样成立。',
      '行为分布只统计成功执行的动作 kind；被驳回/中止的单列在原有 trace 中，不在本表里。',
    ],
  };

  const firstByArmSeed = new Map();
  for (const arm of ACTIONS) {
    report.arms[arm] = { seeds: {}, aggregate: {} };
    for (const seed of SEEDS) {
      const runs = [];
      for (let rep = 0; rep < REPEATS; rep += 1) {
        const got = await runOne(arm, seed);
        const digest = digestOf(got.rows, { arm, seed, t: got.t, alive: got.alive, deaths: got.deaths, store: got.store });
        runs.push({ rep, digest, ...got });
        report.reproducibility.runs.push({ arm, seed, rep, digest });
      }
      const same = runs.every((r) => r.digest === runs[0].digest);
      if (!same) report.reproducibility.ok = false;
      const first = runs[0];
      firstByArmSeed.set(`${arm}:${seed}`, first);
      report.arms[arm].seeds[seed] = {
        reproducible: same,
        digest: first.digest,
        t: first.t,
        day: first.day,
        alive: first.alive,
        deaths: first.deaths,
        store: first.store,
        viabMean: first.viabMean,
        counters: first.counters,
        decisions: first.rows.length,
        distribution: distribution(first.rows),
        kindCounts: kindCounts(first.rows),
      };
    }
    const allRows = SEEDS.map((seed) => firstByArmSeed.get(`${arm}:${seed}`).rows).flat();
    const dist = distribution(allRows);
    const counts = kindCounts(allRows);
    report.arms[arm].aggregate = {
      seeds: SEEDS.length,
      ticks: TICKS,
      decisions: allRows.length,
      distinctKinds: Object.keys(counts).length,
      entropyBits: entropy(dist),
      distribution: dist,
      kindCounts: counts,
    };
  }

  for (const [a, b, label] of [
    ['internal', 'cut', 'internal_vs_cut'],
    ['internal', 'random', 'internal_vs_random'],
    ['cut', 'random', 'cut_vs_random'],
  ]) {
    const pa = report.arms[a].aggregate.distribution;
    const pb = report.arms[b].aggregate.distribution;
    report.comparisons[label] = {
      kl: kl(pa, pb),
      jsd: jsd(pa, pb),
      decisions: { [a]: report.arms[a].aggregate.decisions, [b]: report.arms[b].aggregate.decisions },
    };
  }

  const allDiffer = report.comparisons.internal_vs_cut.kl > 0
    && report.comparisons.internal_vs_random.kl > 0;
  const hasDecisions = ACTIONS.every((arm) => report.arms[arm].aggregate.decisions > 0);
  report.checks = {
    reproducible: report.reproducibility.ok,
    distributionsDiffer: allDiffer,
    hasDecisions,
    pass: report.reproducibility.ok && allDiffer && hasDecisions,
  };
  report.durationMs = Date.now() - started;

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n', 'utf8');

  const summary = ACTIONS.map((arm) => {
    const a = report.arms[arm].aggregate;
    return `${arm}: decisions=${a.decisions} distinct=${a.distinctKinds} entropy=${a.entropyBits}`;
  }).join(' | ');
  console.log(`[score-baseline] ${summary}`);
  for (const [k, v] of Object.entries(report.comparisons)) {
    console.log(`[score-baseline] ${k}: KL=${v.kl} JSD=${v.jsd}`);
  }
  console.log(`[score-baseline] reproducible=${report.checks.reproducible} differ=${report.checks.distributionsDiffer} pass=${report.checks.pass}`);
  console.log(`[score-baseline] wrote ${OUT}`);
  if (!report.checks.pass) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
