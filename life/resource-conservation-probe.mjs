// V7.3 第三批：资源守恒探针。
// 只读模拟，不改规则。核对每条账本 bucket 与库存变化是否平衡：
//   食物/野果：gross = 库存净增 + consumed + overflow + envLoss
// 用法：node life/resource-conservation-probe.mjs v73
import { mkdirSync, writeFileSync } from 'node:fs';
import { createSurvPlay, tickSurvPlay } from './survplay.mjs';
import { CURRENT_EVENT_RULES } from './rng.mjs';
import { resLedgerView } from './resource-ledger.mjs';

export const CONS_OPTIONS = Object.freeze({
  eventRulesVersion: CURRENT_EVENT_RULES, independentWorld: true, gameRules: true,
  residentialDecisions: true, unifiedCooperation: true, settlementLife: true,
  autonomousGoals: true, farmLife: true, regionalWork: true, ecosystem: true,
  wildFood: true, playerRation: true,
});

const KINDS = ['crop', 'berry', 'fruit', 'egg', 'milk', 'meat', 'wool'];
const n = (v) => Number(v ?? 0);

export function measureConservation(seed = 7, ticks = 240) {
  const sp = createSurvPlay(seed, CONS_OPTIONS);
  const w = sp.world;
  const start = Object.fromEntries(KINDS.map((k) => [k,
    n(w.survival.inv?.[k]) + n(w.survival.food?.[k]) + n(w.pinv?.p1?.[k])]));
  for (let i = 0; i < ticks; i += 1) {
    // 不 await：tickSurvPlay 内部自动链在 host 外是同步可推进的（探针只读）
    void tickSurvPlay(sp);
  }
  const L = resLedgerView(w);
  const end = Object.fromEntries(KINDS.map((k) => [k,
    n(w.survival.inv?.[k]) + n(w.survival.food?.[k]) + n(w.pinv?.p1?.[k])]));
  const rows = {};
  for (const k of KINDS) {
    const gross = n(L.gross[k]), cons = n(L.consumed[k]?.total);
    const over = n(L.overflow[k]), env = n(L.envLoss[k]);
    const stockGain = end[k] - start[k];
    // 公共入库/个人获得是 gross 的内部分配，不再重复计
    // 守恒：期初库存 + 本期产出 = 期末库存 + 消费 + 溢出 + 环境损失
    const residual = start[k] + gross - (end[k] + cons + over + env);
    rows[k] = { gross, stockStart: start[k], stockEnd: end[k], stockGain,
      consumed: cons, overflow: over, envLoss: env, residual: Number(residual.toFixed(3)) };
  }
  const worst = Math.max(0, ...Object.values(rows).map((r) => Math.abs(r.residual)));
  return { seed, ticks, rows, worstResidual: Number(worst.toFixed(3)),
    balanced: worst < 1e-6 };
}

if (process.argv[1] && process.argv[1].endsWith('resource-conservation-probe.mjs')) {
  const tag = process.argv[2] ?? 'v73';
  const seeds = [3, 7, 11];
  const runs = seeds.map((s) => measureConservation(s, 240));
  const out = { tag, seeds, runs, allBalanced: runs.every((r) => r.balanced) };
  mkdirSync('docs', { recursive: true });
  writeFileSync(`docs/resource-conservation-${tag}.json`, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ tag, allBalanced: out.allBalanced,
    worst: Math.max(...runs.map((r) => r.worstResidual)) }, null, 2));
  if (!out.allBalanced) process.exitCode = 1;
}
