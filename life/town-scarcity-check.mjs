// §32 A 项验收装置：工钱改成延迟兑现后，town 基线档到底会不会有人垮、垮得是不是"选择的结果"。
// 判据线全部照 PLAN §32 跑前定死的原文，本脚本不自己发明阈值。
// 只测量：不改默认值、不调 τ/供给/门槛；channelMask 一律不传（演示档就是机制全关）。
import { makeWorld, spawn, scanSecrets } from './body.mjs';
import { Organism } from './agent.mjs';
import { hashSeed } from './rng.mjs';
import { weatherFor, dayOf } from './clock.mjs';
import { socialRound } from './social.mjs';

const ROSTER = [
  { id: 'a1', name: '岑', archetype: '谨慎', loc: 'home' },
  { id: 'a2', name: '绛', archetype: '冲动', loc: 'hall' },
  { id: 'a3', name: '蓑', archetype: '孤僻', loc: 'watch' },
];
const SEEDS = (process.env.SWEEP_SEEDS ?? '7,11,13').split(',').map((x) => Number(x.trim())).filter(Number.isFinite);

async function run({ seed, ticks, mask = null }) {
  const world = makeWorld({ pantries: 3, preset: 'town', seed, socialGossip: 1 });
  const agents = {};
  for (const r of ROSTER) {
    const a = new Organism({ ...r, seed: hashSeed(seed, `${r.id}:C2`), condition: 'C2', channelMask: mask, deliberator: async () => null });
    agents[r.id] = a;
    world.agents[r.id] = a;
    spawn(world, r.id, r.loc);
  }
  world.agents.p1 = { id: 'p1', name: '你', isPlayer: true };
  spawn(world, 'p1', 'hall');

  let samples = 0, over = 0, together = 0, talkOk = 0, talkTried = 0;
  const kinds = {};
  const drops = []; // 每次掉档的 {t, who}
  for (let t = 1; t <= ticks; t++) {
    world.t = t;
    world.percepts = [];
    if (world.weatherEnabled) world.weather = weatherFor(seed, dayOf(t));
    if (t % 97 === 0) world.percepts.push({ for: 'all', kind: 'alarm', subject: '墙外', salience: 0.9 });
    if (t % 55 === 0) world.pantry = Math.min(8, world.pantry + 2);
    scanSecrets(world);
    const stageBefore = Object.fromEntries(Object.values(agents).map((a) => [a.id, a.viab.stage]));
    for (const id of Object.keys(agents)) {
      const a = agents[id];
      const before = a.trace.length;
      await a.tick(world);
      const produced = a.trace.slice(before).filter((x) => x.action);
      if (!produced.length) continue;
      const r = produced[produced.length - 1];
      samples += 1;
      if (a.drives.v.stimulation > a.drives.setpoint.stimulation) over += 1;
      if (r.kind) kinds[r.kind] = (kinds[r.kind] ?? 0) + 1;
      if (r.kind === 'talk') { talkTried += 1; if (r.ok) talkOk += 1; }
    }
    for (const a of Object.values(agents)) if (a.viab.stage > stageBefore[a.id]) drops.push({ t, who: a.name, stage: a.viab.stage });
    const byLoc = {};
    for (const id of Object.keys(world.loc)) (byLoc[world.loc[id]] ??= []).push(id);
    together += Object.values(byLoc).reduce((s, g) => s + (g.length >= 2 ? g.length : 0), 0);
  }
  if (world.socialGossip > 0) socialRound(world, { presence: false });

  const list = Object.values(agents);
  const lastAction = (a) => a.trace.filter((x) => x.action).slice(-1)[0] ?? { drives: { social: NaN } };
  const organRows = list.flatMap((a) => Object.entries(a.viab.organs).filter(([, o]) => o.availability !== undefined && o.availability() < 1).map(([k, o]) => `${a.name}:${k}=${o.availability()}`));
  return {
    掉档次数: drops.length,
    垮过个体: list.filter((a) => a.viab.stage > 0).length,
    末存续: Number((list.reduce((s, a) => s + a.viab.v, 0) / list.length).toFixed(3)),
    末社交: Number((list.reduce((s, a) => s + lastAction(a).drives.social, 0) / list.length).toFixed(3)),
    经济社交: ['work', 'buy', 'trade', 'companion'].reduce((s, k) => s + (kinds[k] ?? 0), 0),
    工作: kinds.work ?? 0, 买粮: kinds.buy ?? 0, 接济: kinds.trade ?? 0, 结伴: kinds.companion ?? 0,
    共处人刻: together,
    过载: Number(((over / Math.max(1, samples)) * 100).toFixed(1)),
    talk: `${talkOk}/${talkTried}`,
    规范: Array.isArray(world.normLog) ? world.normLog.length : 0,
    掉档时刻: drops.map((d) => `${d.t}(${d.who})`).join(',') || '无',
    掉档桶: [...new Set(drops.map((d) => Math.floor((d.t - 1) / 100)))].sort().join('/'),
    部件现状: organRows.join(' ') || '无削减',
  };
}

const LINES = { A1窗口: 600, A1掉档seed数: 2, A1末存续: 0.85, A2窗口: 1200, A2经济线: 154 * 0.5, A2共处线: Math.round(1819 * 0.8) };
const out = { 新工钱: {}, erosion关: {} };
for (const seed of SEEDS) {
  out.新工钱[seed] = await run({ seed, ticks: LINES.A1窗口 });
  out.erosion关[seed] = await run({ seed, ticks: LINES.A1窗口, mask: { erosion: 0 } });
}
const long = {};
for (const seed of SEEDS) long[seed] = await run({ seed, ticks: LINES.A2窗口 });

console.log(`# §32 A 项验收（town 基线档、channelMask 不传、演示口径 pantry=3 + socialGossip=1 + p1 在场；stub 不花钱）`);
console.log('\n## A1 可观察性：3 seed × 600 刻（线：≥2 个 seed 出现掉档 且 末存续均值 ≤0.85）');
console.table(out.新工钱);
const a1Seeds = SEEDS.filter((s) => out.新工钱[s].掉档次数 > 0).length;
const a1Viab = Number((SEEDS.reduce((s, x) => s + out.新工钱[x].末存续, 0) / SEEDS.length).toFixed(3));
console.log(`A1 判定：掉档 seed ${a1Seeds}/${SEEDS.length}（需 ≥${LINES.A1掉档seed数}），末存续均值 ${a1Viab}（需 ≤${LINES.A1末存续}）⇒ ${a1Seeds >= LINES.A1掉档seed数 && a1Viab <= LINES.A1末存续 ? '通过' : '不达标'}`);

console.log('\n## A2/A5：同机制 3 seed × 1200 刻（线：经济社交 ≥77、共处人刻 ≥1456；代价四项同表报出）');
console.table(long);
const econ = SEEDS.reduce((s, x) => s + long[x].经济社交, 0);
const together = SEEDS.reduce((s, x) => s + long[x].共处人刻, 0);
console.log(`A2 判定：经济社交合计 ${econ}（线 ${LINES.A2经济线}）、共处人刻合计 ${together}（线 ${LINES.A2共处线 * SEEDS.length}）⇒ ${econ >= LINES.A2经济线 && together >= LINES.A2共处线 * SEEDS.length ? '通过' : '不达标（触发 S2）'}`);

console.log('\n## A3 D1：⑥ erosion=0 臂（存续照常演化，但部件不削）');
console.table(out.erosion关);
const eroded = SEEDS.some((s) => out.erosion关[s].部件现状 !== '无削减');
const erodedOn = SEEDS.some((s) => out.新工钱[s].部件现状 !== '无削减');
console.log(`\nA3 判定（⑥ erosion=0 时部件不许被削）：erosion=0 臂削减 ${eroded ? '出现 ⇒ ⑥ 没被真正切断，判失败' : '零出现'}；开⑥臂削减 ${erodedOn ? '出现 ⇒ 与切断臂形成对照' : '也零出现 ⇒ 没有掉档样本，本条等于没检验（不算通过）'}`);

const dropsSeen = SEEDS.some((s) => out.新工钱[s].掉档次数 > 0);
const buckets = SEEDS.map((s) => out.新工钱[s].掉档桶).filter((b) => b && b !== '');
const collapsedCounts = [...new Set(SEEDS.map((s) => out.新工钱[s].垮过个体))];
// A3/A4 都要有掉档样本才算被检验过：0 掉档时它们不是"通过"，是"没测到"，必须这样印出来。
console.log(`\nA4 判定：掉档桶 ${buckets.join(' | ') || '无'}（线：跨 ≥2 个不同的 100 刻桶）；各 seed 垮过个体数 ${collapsedCounts.join('/')}（线：不全等）⇒ ${!dropsSeen ? '无掉档样本，本条没被检验（判据以 A1 为准，不算通过也不算 S3）' : buckets.length >= 2 && collapsedCounts.length > 1 ? '通过' : '不达标（触发 S3）'}`);
console.log('# 参照：§30.1 旧工钱口径的 1200 刻基线 = 经济社交 154 / 共处人刻 1819 / 末存续 0.998 / 掉档 0；§31 = 3600 刻仍 0 掉档。');
