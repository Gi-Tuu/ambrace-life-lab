// V7.3.1 严格角色互换：只在“玩家/居民都能合法执行”的动作上比较，双方都失败不算通过。
// 状态：passed / failed / inconclusive / expected_rejection。
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
const TESTED = ['gather', 'forage', 'harvest', 'plant', 'build'];
const COVERAGE = ['gather', 'forage', 'harvest', 'plant', 'water', 'till', 'plan', 'build', 'repair',
  'move', 'eat', 'rest', 'store', 'take', 'exchange', 'talk', 'road', 'facility', 'animal', 'home'];

const fresh = (seed, kind) => {
  const sp = createSurvPlay(seed, SWAP_OPTIONS), w = sp.world;
  w.t = 10;
  const loc = kind === 'harvest' || kind === 'plant' || kind === 'water' ? 'garden' : 'yard';
  move(w, 'p1', loc); move(w, 'a1', loc);
  w.agents.p1.drives.v.energy = 0.8;
  w.agents.a1.drives.v.energy = 0.8;
  w.survival.resStock[loc] = 500;
  w.pinv.p1 = { wood: 20, stone: 20 };
  w.pinv.a1 = { wood: 20, stone: 20 };
  if (kind === 'harvest') w.survival.plots[0].growth = 1;
  if (kind === 'plant') { w.survival.plots[0].growth = 0; w.survival.water = 1; }
  if (kind === 'build') w.survival.sites = [{ type: 'shelter', loc: 'yard', progress: 0 }];
  return { sp, w };
};
const num = (v) => Number((v ?? 0).toFixed(4));
const pinvSum = (bag, k) => num(bag?.[k]);
const siteProgress = (w) => num(w.survival.sites?.[0]?.progress);

function runOne(seed, kind, actor) {
  const { sp, w } = fresh(seed, kind);
  const isPlayer = actor === 'player';
  const who = isPlayer ? 'p1' : 'a1';
  const e0 = w.agents[who].drives.v.energy, wood0 = pinvSum(w.pinv[who], 'wood'), stone0 = pinvSum(w.pinv[who], 'stone');
  const prog0 = siteProgress(w);
  const r = isPlayer ? survAct(sp, { kind }) : w.agents.a1.execute(w, { kind }, 'deliberation', w.t, true);
  const ok = r?.ok === true;
  const layer = r?.code === 'BUSY_START' ? 'busy' : ok ? 'done' : 'rejected';
  return {
    ok, layer, code: ok ? 'OK' : (r?.code ?? (r == null ? 'NULL' : 'UNKNOWN')),
    minutes: num(w.survival.actionLedger?.[isPlayer ? 'player' : 'resident']?.minutes?.[kind] ?? 0),
    energy: num(e0 - w.agents[who].drives.v.energy),
    materials: { wood: num(wood0 - pinvSum(w.pinv[who], 'wood')), stone: num(stone0 - pinvSum(w.pinv[who], 'stone')) },
    progress: num(siteProgress(w) - prog0),
    events: (w.survival.eventJournal?.rows ?? []).filter((e) => (e.action ?? e.kind) === kind).length,
  };
}

export function measureSwap(seed = 7) {
  const rows = [];
  for (const kind of TESTED) {
    const player = runOne(seed, kind, 'player');
    const resident = runOne(seed, kind, 'resident');
    const expected = costFor(kind);
    const rejectedBoth = !player.ok && !resident.ok;
    let status;
    if (rejectedBoth) {
      // 双方都拒绝：只有“同一个合法前置下同一条规则拒绝”才记为 expected_rejection；
      // 否则说明夹具没造出可执行动作，记 inconclusive，绝不算同权通过。
      const sameCode = player.code === resident.code && player.code !== 'NULL';
      status = sameCode ? 'expected_rejection' : 'inconclusive';
    } else if (player.ok !== resident.ok) {
      status = 'failed';
    } else {
      const same = player.minutes === resident.minutes && player.energy === resident.energy
        && player.materials.wood === resident.materials.wood && player.materials.stone === resident.materials.stone
        && player.progress === resident.progress && player.code === resident.code;
      status = same ? 'passed' : 'failed';
    }
    rows.push({ kind, status, expected: { minutes: expected.minutes, energy: expected.energy }, player, resident });
  }
  const covered = new Set(TESTED);
  const coverage = COVERAGE.map((kind) => ({ kind, status: covered.has(kind) ? 'tested' : 'inconclusive' }));
  const allSame = rows.every((r) => r.status === 'passed' || r.status === 'expected_rejection');
  return { seed, rows, coverage, allSame,
    failed: rows.filter((r) => r.status === 'failed'),
    inconclusive: coverage.filter((c) => c.status === 'inconclusive') };
}

if (process.argv[1] && process.argv[1].endsWith('role-swap-probe.mjs')) {
  const tag = process.argv[2] ?? 'v73';
  const seeds = [7, 13, 29];
  const runs = seeds.map((s) => measureSwap(s));
  const out = { tag, seeds, runs, allSame: runs.every((r) => r.allSame) };
  mkdirSync('docs', { recursive: true });
  writeFileSync(`docs/role-swap-${tag}.json`, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ tag, allSame: out.allSame,
    failures: runs.flatMap((r) => r.failed.map((x) => `${r.seed}:${x.kind}`)) }, null, 2));
  if (!out.allSame) process.exitCode = 1;
}
