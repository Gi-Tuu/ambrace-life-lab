// §33 六档扫描：工坊当日上限真装进代码之后，town 默认档能不能自己长出损失。
// 只测量：不采纳任何默认值（采纳规则写在 PLAN §33，跑完按规则定 N 并交给用户点头）。
import { makeWorld, spawn, scanSecrets, workUsedToday } from './body.mjs';
import { Organism } from './agent.mjs';
import { hashSeed } from './rng.mjs';
import { weatherFor, dayOf, DAY_TICKS } from './clock.mjs';
import { socialRound } from './social.mjs';

const ROSTER = [
  { id: 'a1', name: '岑', archetype: '谨慎', loc: 'home' },
  { id: 'a2', name: '绛', archetype: '冲动', loc: 'hall' },
  { id: 'a3', name: '蓑', archetype: '孤僻', loc: 'watch' },
];
const SEEDS = (process.env.SWEEP_SEEDS ?? '7,11,13').split(',').map((x) => Number(x.trim())).filter(Number.isFinite);
const ARMS = [
  { 档: '不设上限（现规则）', workCap: undefined },
  { 档: '每天 4 次', workCap: 4 },
  { 档: '每天 3 次', workCap: 3 },
  { 档: '每天 2 次', workCap: 2 },
  { 档: '每天 1 次', workCap: 1 },
  { 档: '每天 0 次（工坊关门＝负控）', workCap: 0 },
];

async function run({ seed, ticks, workCap }) {
  const world = makeWorld({ pantries: 3, preset: 'town', seed, socialGossip: 1 });
  if (workCap !== undefined) world.workCap = workCap;
  const agents = {};
  for (const r of ROSTER) {
    const a = new Organism({ ...r, seed: hashSeed(seed, `${r.id}:C2`), condition: 'C2', deliberator: async () => null });
    agents[r.id] = a; world.agents[r.id] = a; spawn(world, r.id, r.loc);
  }
  world.agents.p1 = { id: 'p1', name: '你', isPlayer: true }; spawn(world, 'p1', 'hall');

  const kinds = {}; const firstDrop = []; const minV = [];
  let samples = 0, over = 0, together = 0, capped = 0, pantryEmpty = 0, quotaDays = 0;
  for (let t = 1; t <= ticks; t++) {
    world.t = t; world.percepts = [];
    world.weather = weatherFor(seed, dayOf(t));
    if (t % 97 === 0) world.percepts.push({ for: 'all', kind: 'alarm', subject: '墙外', salience: 0.9 });
    if (t % 55 === 0) world.pantry = Math.min(8, world.pantry + 2);
    scanSecrets(world);
    for (const id of Object.keys(agents)) {
      const a = agents[id];
      const before = a.trace.length;
      await a.tick(world);
      samples++;
      if (a.drives.v.stimulation > a.drives.setpoint.stimulation) over++;
      if (a.viab.v < (minV[id] ??= 1)) minV[id] = a.viab.v;
      if (a.viab.stage > 0 && firstDrop[id] === undefined) firstDrop[id] = t;
      for (const r of a.trace.slice(before)) {
        if (r.action && r.kind) kinds[r.kind] = (kinds[r.kind] ?? 0) + 1;
        if (r.code === 'DAY_CAP') capped++;
      }
      if (workCap !== undefined && workUsedToday(world, id) >= workCap) quotaDays++;
    }
    if (world.pantry <= 0) pantryEmpty++;
    const byLoc = {};
    for (const id of Object.keys(world.loc)) (byLoc[world.loc[id]] ??= []).push(id);
    together += Object.values(byLoc).reduce((s, g) => s + (g.length >= 2 ? g.length : 0), 0);
  }
  socialRound(world, { presence: false });
  const list = Object.values(agents);
  const lastAction = (a) => a.trace.filter((x) => x.action).slice(-1)[0] ?? { drives: { social: NaN } };
  return {
    掉档: list.reduce((s, a) => s + a.viab.stage, 0),
    垮过个体: list.filter((a) => a.viab.stage > 0).length,
    首现: list.map((a) => firstDrop[a.id] === undefined ? '-' : firstDrop[a.id]).join('/'),
    末存续: Number((list.reduce((s, a) => s + a.viab.v, 0) / list.length).toFixed(3)),
    最低v: Number(Math.min(...list.map((a) => minV[a.id]))).toFixed(3),
    末社交: Number((list.reduce((s, a) => s + lastAction(a).drives.social, 0) / list.length).toFixed(3)),
    经济社交: ['work', 'buy', 'trade', 'companion'].reduce((s, k) => s + (kinds[k] ?? 0), 0),
    work: kinds.work ?? 0, 吃: kinds.eat ?? 0, 买: kinds.buy ?? 0, 接济: kinds.trade ?? 0, 结伴: kinds.companion ?? 0,
    越轨: kinds.take_shared ?? 0,
    规范: Array.isArray(world.normLog) ? world.normLog.length : 0,
    DAY_CAP驳回: capped, 满额人刻: quotaDays, 公仓见底刻: pantryEmpty,
    共处人刻: together, 过载: `${Number((over / samples) * 100).toFixed(1)}%`,
  };
}

const started = Date.now();
for (const ticks of [600, 3600]) {
  const rows = [];
  for (const arm of ARMS) for (const seed of SEEDS) rows.push({ 档: arm.档, seed, 窗口: ticks, ...(await run({ seed, ticks, workCap: arm.workCap })) });
  console.log(`# §33 工坊当日上限扫描（town 默认档＝channelMask 不传；演示口径 pantry=3 + socialGossip=1 + p1 在场；${SEEDS.length} seed=${SEEDS.join('/')}）`);
  console.table(rows);

  // 采纳规则（跑前写死在 §33）：600 刻内 ≥2/3 seed 掉档、且经济社交 ≥ 同窗无上限档 70% 的最小 N；N=0 按 S2 永不采纳
  if (ticks === 600) {
    const by = (档) => rows.filter((r) => r.档 === 档);
    const baseEcon = by('不设上限（现规则）').reduce((s, r) => s + r.经济社交, 0);
    console.log('# 采纳规则核对（无上限档 600 刻经济社交合计 =', baseEcon, '；线 = 70% ⇒', Math.round(baseEcon * 0.7), '）');
    for (const { 档 } of ARMS) {
      const g = by(档);
      const seedsWithDrop = g.filter((r) => r.掉档 > 0).length;
      const econ = g.reduce((s, r) => s + r.经济社交, 0);
      const ok = 档 !== '不设上限（现规则）' && 档 !== '每天 0 次（工坊关门＝负控）' && seedsWithDrop >= 2 && econ >= baseEcon * 0.7;
      console.log(`   ${档}: 掉档 seed ${seedsWithDrop}/3、经济 ${econ} ⇒ ${档.startsWith('不设') ? '基线' : ok ? '满足采纳规则' : '不满足'}`);
    }
  }
}
console.log('# 参照：§33 事实表——现规则 town 3600 刻 掉档 0、末存续 0.998；坏天断公仓补给也不垮（work 92→121–146、越轨 148→169–201 补上）。');
console.log('# 3 seed、无显著性声称；上限一设即换掉整条轨迹，档间不是配对比较。耗时 ' + ((Date.now() - started) / 1000).toFixed(1) + ' 秒');
