#!/usr/bin/env node
// 阶段 D：长期世界逻辑检验（V7 §8）。
// 多种子 × 多周期跑正式游戏态，记录人口/年龄/家庭/房屋/食物/生产/行动分布/异常。
// 只读世界、零联网、不写 data/。用法：node scripts/long-run-v7.mjs [seeds] [days...]
import { execSync } from 'node:child_process';
import { createSurvPlay, tickSurvPlay, survView } from '../life/survplay.mjs';

const HEAD = (() => { try { return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim(); } catch { return 'unknown'; } })();

const GAME = {
  independentWorld: true, gameRules: true, residentialDecisions: true, unifiedCooperation: true,
  settlementLife: true, autonomousGoals: true, farmLife: true, regionalWork: true, ecosystem: true, wildFood: true,
};

const seeds = (process.argv[2] ?? '7,13,29').split(',').map(Number);
const days = (process.argv[3] ?? '30,100').split(',').map(Number);
const DAY_TICKS = 24;

function census(w, sp) {
  const agents = Object.values(w.agents);
  const living = agents.filter((a) => !a.dead && !a.isPlayer);
  const stages = {};
  const view = survView(sp);
  for (const a of living) stages[view.agents[a.id]?.stage ?? '?'] = (stages[view.agents[a.id]?.stage ?? '?'] ?? 0) + 1;
  const h = w.survival.households ?? {};
  const ledger = w.survival.actionLedger ?? null;
  return {
    t: w.t,
    day: Math.floor(w.t / DAY_TICKS),
    living: living.length,
    playerAlive: !w.agents.p1?.dead,
    births: w.survival.births ?? 0,
    deaths: (w.survival.deaths ?? []).length,
    stages,
    spouses: Object.values(h.spouses ?? {}).filter(Boolean).length / 2,
    homes: new Set(Object.values(w.housing ?? {})).size,
    store: w.survival.store,
    buildings: Object.keys(w.survival.buildings ?? {}).length,
    plots: (w.survival.plots ?? []).length,
    coopDone: w.survival.coop?.completions?.length ?? 0,
    ended: !!w.survival.ended,
    starveDays: w.survival.starveDays ?? 0,
    agentErrors: w.survival.agentErrors ?? 0,
    intentErrors: w.survival.intentErrors ?? 0,
    sayRejects: w.survival.sayRejects ?? 0,
  };
}

const out = [];
for (const seed of seeds) {
  for (const dayTarget of days) {
    const sp = createSurvPlay(seed, GAME);
    const w = sp.world;
    if (process.env.V7_PLAYER_RATION === '1') w.survival.playerRation = true; // RES-01 开关（默认关）
    const ticks = dayTarget * DAY_TICKS;
    const started = Date.now();
    for (let i = 0; i < ticks; i += 1) {
      await tickSurvPlay(sp, { now: Date.now() });
      if (w.survival.ended) break;
    }
    const actions = {};
    for (const a of Object.values(w.agents)) {
      if (a.isPlayer) continue;
      for (const rec of a.trace ?? []) if (rec.action) actions[rec.action] = (actions[rec.action] ?? 0) + 1;
    }
    const top = Object.entries(actions).sort((a, b) => b[1] - a[1]).slice(0, 8);
    const ledger = w.survival.actionLedger ?? null;
    out.push({
      seed, targetDays: dayTarget, wallMs: Date.now() - started, ...census(w, sp), topActions: top,
      ledgerTopResident: ledger ? Object.entries(ledger.resident.attempt).sort((a, b) => b[1] - a[1]).slice(0, 10) : null,
      ledgerTopPlayer: ledger ? Object.entries(ledger.player.attempt).sort((a, b) => b[1] - a[1]).slice(0, 10) : null,
      ledgerLayers: ledger ? Object.entries(ledger.resident.byLayer).sort((a, b) => b[1] - a[1]).slice(0, 10) : null,
      ledgerRefused: ledger ? Object.entries(ledger.resident.refused).sort((a, b) => b[1] - a[1]).slice(0, 10) : null,
      head: HEAD,
      playerRation: w.survival.playerRation === true,
      gameRules: !!w.gameRules,
    });
  }
}

console.log(JSON.stringify(out, null, 2));
