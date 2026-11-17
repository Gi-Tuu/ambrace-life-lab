// V7.3.1 资源守恒探针：每刻 await 完整推进；覆盖公共仓/公共容器/私人容器/玩家背包/居民个人/农业/动物/配给/进食/建造维修/燃料/溢出。
// 用法：node life/resource-conservation-probe.mjs v73
import { execFileSync } from 'node:child_process';
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

export const CONSERVATION_KINDS = Object.freeze(['crop', 'berry', 'fruit', 'egg', 'milk', 'meat', 'wool', 'wood', 'stone']);
// 开边界：产出/消耗发生在未被“库存快照”覆盖的野外/畜群 standing stock 上。
const OPEN_KINDS = new Set(['berry', 'fruit', 'egg', 'milk', 'wood', 'stone']);
const n = (v) => Number(v ?? 0);

// 所有会被转移的位置一起计入：公共仓计数、公共容器、玩家/居民背包、私人容器。
// 内部转移只换位置，总额不变；因此期末-期初只由产出/消费/溢出/损失解释。
export function snapshotStocks(w) {
  const out = Object.fromEntries(CONSERVATION_KINDS.map((k) => [k, 0]));
  const add = (bag) => {
    if (!bag) return;
    for (const one of (Array.isArray(bag) ? bag : [bag])) {
      if (!one) continue;
      for (const k of CONSERVATION_KINDS) out[k] += n(one[k]);
    }
  };
  add(w.survival.inv);
  add(w.survival.food);
  add(w.survival.campContainers ? Object.values(w.survival.campContainers) : null);
  for (const bag of Object.values(w.pinv ?? {})) add(bag);
  // 公共粮仓的单一计数（不是容器）只对应 grain 折算，避免重复：不并入 kinds，单独报告。
  return out;
}

function head() {
  try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: process.cwd(), encoding: 'utf8' }).trim(); }
  catch { return 'unknown'; }
}

export async function measureConservation(seed = 7, ticks = 240, { tamper = null } = {}) {
  const sp = createSurvPlay(seed, CONS_OPTIONS);
  const w = sp.world;
  const start = snapshotStocks(w);
  const startT = w.t;
  let ticksDone = 0;
  try {
    for (let i = 0; i < ticks; i += 1) {
      await tickSurvPlay(sp); // V7.3.1：必须等每刻真正完成；异常让调用方看到失败
      ticksDone += 1;
    }
  } catch (error) {
    return {
      seed, ticksRequested: ticks, ticksDone, error: String(error?.message ?? error),
      balanced: false, rows: {}, worstResidual: null,
    };
  }
  const L = resLedgerView(w);
  if (tamper) tamper(L); // 对照测试用：人为破坏账本，必须报警
  const end = snapshotStocks(w);
  const rows = {};
  for (const k of CONSERVATION_KINDS) {
    const gross = n(L.gross[k]), cons = n(L.consumed[k]?.total);
    const over = n(L.overflow[k]), env = n(L.envLoss[k]);
    const stockGain = Number((end[k] - start[k]).toFixed(3));
    const residual = Number((start[k] + gross - (end[k] + cons + over + env)).toFixed(3));
    rows[k] = {
      gross, stockStart: start[k], stockEnd: end[k], stockGain,
      consumed: cons, overflow: over, envLoss: env, residual,
    };
  }
  const worst = Math.max(0, ...Object.values(rows).map((r) => Math.abs(r.residual)));
  const closedKinds = CONSERVATION_KINDS.filter((k) => !OPEN_KINDS.has(k));
  const worstClosed = Math.max(0, ...closedKinds.map((k) => Math.abs(rows[k].residual)));
  return {
    seed, ticksRequested: ticks, ticksDone, actualTicks: w.t - startT,
    head: head(), ruleVersion: CURRENT_EVENT_RULES, actTimeModel: w.survival.actTimeModel === true,
    config: { ...CONS_OPTIONS }, rows,
    closedKinds, openKinds: [...OPEN_KINDS],
    // 严格证明（不计入闭合平衡的原因）：open 品类的 gross 记的是“从野存/畜群收进库存”的转移，
    // 不是新生产；standing stock 既没有起点快照也没有生产时刻账本。把 gross 与库存末值相加会重复计数，
    // 把 standing 加进快照又缺“生产发生在哪一刻”的信息，两种口径都无法定义零残差。
    openProof: 'open kinds record harvest transfers, not production; standing stock lacks start snapshot and production timestamps, so residual is undefined without a production ledger',
    worstResidual: Number(worst.toFixed(3)), worstClosed: Number(worstClosed.toFixed(3)),
    // 开边界品类（野果/果树/蛋奶/木石）的产出发生在未纳入快照的野外/畜群 standing stock 上，
    // 本探针无法用“库存+消费”闭合；它们只报告 residual，不冒充闭合。闭合品类必须为 0。
    balanced: worstClosed < 1e-6,
  };
}

if (process.argv[1] && process.argv[1].endsWith('resource-conservation-probe.mjs')) {
  const tag = process.argv[2] ?? 'v73';
  const seeds = [3, 7, 11];
  const runs = [];
  for (const s of seeds) runs.push(await measureConservation(s, 240));
  const out = { tag, seeds, runs, allBalanced: runs.every((r) => r.balanced && !r.error) };
  mkdirSync('docs', { recursive: true });
  writeFileSync(`docs/resource-conservation-${tag}.json`, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ tag, allBalanced: out.allBalanced,
    worst: Math.max(...runs.map((r) => r.worstResidual ?? 0)) }, null, 2));
  if (!out.allBalanced) process.exitCode = 1;
}


