#!/usr/bin/env node
// V7.3 第三批：两个比赛案例的可复现证据汇总（只读，不改规则、不联网）。
//   案例一「玩家与居民规则对等」：严格角色互换实验 + 共享成本表
//   案例二「高自主生命连续性」：跨日/死亡 busy 结算 + 30/100/200 日长期表
// 用法：node scripts/competition-cases.mjs v73
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { measureSwap } from '../life/role-swap-probe.mjs';
import { measureConservation } from '../life/resource-conservation-probe.mjs';
import { SHARED_COST } from '../life/action-cost.mjs';

const tag = process.argv[2] ?? 'v73';
const swap = [7, 13, 29].map((s) => measureSwap(s));
const cons = [7, 13, 29].map((s) => measureConservation(s, 240));
let b120 = null;
try { b120 = JSON.parse(readFileSync('docs/b120.json', 'utf8')); } catch { /* 未跑过则留空 */ }

const pop = (days) => (b120?.rows ?? []).filter((r) => r.days === days).map((r) => r.population);
const extinct200 = (b120?.rows ?? []).filter((r) => r.days === 200 && r.ended).length;

const out = {
  tag,
  case1_equalRules: {
    claim: '玩家与居民在同一动作上共用一张分钟/体力成本表，且实际执行结果同口径',
    evidence: {
      sharedCostTable: SHARED_COST,
      swapSeeds: swap.map((r) => ({ seed: r.seed, allSame: r.allSame,
        actions: r.rows.map((x) => ({ kind: x.kind, expected: x.expected,
          player: x.player, resident: x.resident, same: x.same })) })),
      allSame: swap.every((r) => r.allSame),
    },
    reproduce: 'node scripts/competition-cases.mjs v73',
  },
  case2_continuousLife: {
    claim: '居民在玩家不操作时仍自主生活；进行中的动作在跨日/死亡时有完整账本与事件，不无限续命',
    evidence: {
      conservation: cons.map((r) => ({ seed: r.seed, balanced: r.balanced, worstResidual: r.worstResidual })),
      longRun: b120 ? { seeds: b120.seeds, pop30: pop(30), pop100: pop(100), pop200: pop(200), extinct200 } : null,
    },
    reproduce: 'node life/resource-conservation-probe.mjs v73 && node life/b120-probe.mjs',
  },
  generatedAt: new Date().toISOString(),
};
mkdirSync('docs', { recursive: true });
writeFileSync(`docs/competition-cases-${tag}.json`, JSON.stringify(out, null, 2));
console.log(JSON.stringify({ tag,
  case1: out.case1_equalRules.evidence.allSame,
  case2: out.case2_continuousLife.evidence.conservation.every((r) => r.balanced) && !!(b120),
  pop100: pop(100), extinct200 }, null, 2));
if (!out.case1_equalRules.evidence.allSame) process.exitCode = 1;
