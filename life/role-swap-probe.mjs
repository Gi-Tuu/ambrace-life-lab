// V7.3 第三批：严格角色互换实验 —— 同一动作由玩家/居民执行，分钟/体力/账本必须同口径。
// 只读模拟：两边各起一个同 seed 的世界，避免先执行的资源变化污染后一侧。
// 用法：node life/role-swap-probe.mjs v73
import { mkdirSync, writeFileSync } from 'node:fs';
import { createSurvPlay, survAct } from './survplay.mjs';
import { move } from './body.mjs';
import { CURRENT_EVENT_RULES } from './rng.mjs';
import { costFor } from './action-cost.mjs';

export const SWAP_OPTIONS = Object.freeze({
  eventRulesVersion: CURRENT_EVENT_RULES, independentWorld: true, gameRules: true,
  residentialDecisions: true, unifiedCooperation: true, settlementLife: true,
  autonomousGoals: true, farmLife: true, regionalWork: true, ecosystem: true,
  wildFood: true, playerRation: true,
});

const fresh = (seed) => {
  const sp = createSurvPlay(seed, SWAP_OPTIONS), w = sp.world;
  w.t = 10; move(w, 'p1', 'yard'); move(w, 'a1', 'yard');
  w.agents.p1.drives.v.energy = 0.8;
  w.agents.a1.drives.v.energy = 0.8;
  w.survival.resStock.yard = 500;
  return { sp, w };
};

const num = (v) => Number((v ?? 0).toFixed(4));

export function measureSwap(seed = 7) {
  const rows = [];
  for (const kind of ['gather', 'forage', 'harvest', 'plant', 'build', 'repair', 'plan', 'talk']) {
    const P = fresh(seed), R = fresh(seed);
    // 玩家
    P.w.survival.sites = kind === 'build' ? [{ type: 'shelter', loc: 'yard', progress: 0 }] : [];
    P.w.pinv.p1 = { wood: 20, stone: 20 };
    const pe0 = P.w.agents.p1.drives.v.energy;
    const pr = survAct(P.sp, { kind });
    const pE = num(pe0 - P.w.agents.p1.drives.v.energy);
    const pM = num(P.w.survival.actionLedger.player.minutes?.[kind] ?? 0);
    // 居民
    R.w.survival.sites = kind === 'build' ? [{ type: 'shelter', loc: 'yard', progress: 0 }] : [];
    R.w.pinv.a1 = { wood: 20, stone: 20 };
    const re0 = R.w.agents.a1.drives.v.energy;
    const rr = R.w.agents.a1.execute(R.w, { kind }, 'deliberation', R.w.t, true);
    const rE = num(re0 - R.w.agents.a1.drives.v.energy);
    const rM = num(R.w.survival.actionLedger.resident.minutes?.[kind] ?? 0);
    const expected = costFor(kind);
    rows.push({ kind, expected: { minutes: expected.minutes, energy: expected.energy },
      player: { ok: !!pr?.ok, code: pr?.code ?? 'OK', energy: pE, minutes: pM },
      resident: { ok: !!rr?.ok, code: rr?.code ?? 'OK', energy: rE, minutes: rM },
      // 两侧都拒绝 ⇒ 本动作在该场景下不可执行，不构成成本差异（接口 code 语义不同）。
      same: (pr?.ok === !!rr?.ok)
        && (pr?.ok ? (Math.abs(pE - rE) < 1e-6 && Math.abs(pM - rM) < 1e-6) : true),
    });
  }
  const allSame = rows.every((r) => r.same);
  return { seed, rows, allSame };
}

if (process.argv[1] && process.argv[1].endsWith('role-swap-probe.mjs')) {
  const tag = process.argv[2] ?? 'v73';
  const seeds = [7, 13, 29];
  const runs = seeds.map((s) => measureSwap(s));
  const out = { tag, seeds, runs, allSame: runs.every((r) => r.allSame) };
  mkdirSync('docs', { recursive: true });
  writeFileSync(`docs/role-swap-${tag}.json`, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ tag, allSame: out.allSame,
    failures: runs.flatMap((r) => r.rows.filter((x) => !x.same).map((x) => `${r.seed}:${x.kind}`)) }, null, 2));
  if (!out.allSame) process.exitCode = 1;
}
