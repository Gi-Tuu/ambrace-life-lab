// town 世界层参数取舍扫描（PLAN §30 预登记）。只测量：不改产品默认值、不改机制、不加演示入口。
// 三条纪律写在代码里，免得跑的时候手滑：
//  1. 默认档（基线）不传 townGates，也不改补给节奏 ⇒ 它就是现网演示口径；
//  2. 负控档显式传 TOWN_GATES 的默认值 ⇒ digest 必须与基线逐位相同，否则重构泄漏了行为；
//  3. 补给"调到无限"那一档是成本作弊参考，永远不当产品建议（§30 S3）。
import { makeWorld, spawn, scanSecrets, TOWN_GATES } from './body.mjs';
import { Organism } from './agent.mjs';
import { hashSeed } from './rng.mjs';
import { weatherFor, dayOf } from './clock.mjs';
import { socialRound } from './social.mjs';
import { PARAMS } from './params.mjs';
import { COUPLING_VARS, COUPLING_DEFAULT } from './coupling.mjs';

const ROSTER = [
  { id: 'a1', name: '岑', archetype: '谨慎', loc: 'home' },
  { id: 'a2', name: '绛', archetype: '冲动', loc: 'hall' },
  { id: 'a3', name: '蓑', archetype: '孤僻', loc: 'watch' },
];

// 演示口径：host.mjs:82 的 pantry=3 / socialGossip=1；tick 循环里 t%55 补 2、上限 8（run.mjs:41）。
const DEMO = { pantry0: 3, refillEvery: 55, refillAmount: 2, pantryCap: 8, gates: null };

const ARMS = [
  { 档: '基线（演示默认）', cfg: {} },
  { 档: '负控：显式传默认门槛', cfg: { gates: { ...TOWN_GATES } } },
  { 档: '公仓 3→2', cfg: { pantry0: 2 } },
  { 档: '公仓 3→5', cfg: { pantry0: 5 } },
  { 档: '补给节奏 55→35 刻', cfg: { refillEvery: 35 } },
  { 档: '补给节奏 55→90 刻', cfg: { refillEvery: 90 } },
  { 档: '补给量 +2→+1', cfg: { refillAmount: 1 } },
  { 档: '补给量 +2→+4', cfg: { refillAmount: 4 } },
  { 档: '公仓上限 8→6', cfg: { pantryCap: 6 } },
  { 档: '接济信任 30→20', cfg: { gates: { tradeTrust: 20 } } },
  { 档: '接济信任 30→45', cfg: { gates: { tradeTrust: 45 } } },
  { 档: '结伴熟悉度 .30→.15', cfg: { gates: { compFam: 0.15 } } },
  { 档: '结伴熟悉度 .30→.50', cfg: { gates: { compFam: 0.5 } } },
  { 档: '结伴信任 32→22', cfg: { gates: { compTrust: 22 } } },
  { 档: '结伴信任 32→50', cfg: { gates: { compTrust: 50 } } },
  { 档: '参考：补给管够（成本作弊，不采纳）', cfg: { pantry0: 12, refillEvery: 20, refillAmount: 4, pantryCap: 24 } },
];

const SEEDS = (process.env.SWEEP_SEEDS ?? '7,11,13').split(',').map((x) => Number(x.trim())).filter(Number.isFinite);
const TICKS = Number(process.env.SWEEP_TICKS ?? 1200);

const merge = (over) => ({ ...DEMO, ...over });

async function run({ seed, cfg }) {
  const c = merge(cfg);
  const world = makeWorld({ pantries: c.pantry0, preset: 'town', seed, socialGossip: 1 });
  if (c.gates) world.townGates = c.gates;
  const agents = {};
  for (const r of ROSTER) {
    const a = new Organism({ ...r, seed: hashSeed(seed, `${r.id}:C2`), condition: 'C2', deliberator: async () => null });
    agents[r.id] = a;
    world.agents[r.id] = a;
    spawn(world, r.id, r.loc);
  }
  world.agents.p1 = { id: 'p1', name: '你', isPlayer: true };
  spawn(world, 'p1', 'hall');

  const acc = {
    decisions: 0, samples: 0, over: 0, occ: Object.fromEntries(COUPLING_VARS.map((k) => [k, 0])),
    kinds: {}, talkOk: 0, talkTried: 0, together: 0, outdoor: 0, rooms: new Set(),
    coins: 0, companionPeak: 0, companionEnd: 0, norms: 0, asked: 0, habit: 0, rejected: 0,
    endSocial: 0, endViab: 0, stages: 0, collapsed: 0, pantryMin: world.pantry,
  };

  for (let t = 1; t <= TICKS; t++) {
    world.t = t;
    world.percepts = [];
    if (world.weatherEnabled) world.weather = weatherFor(seed, dayOf(t));
    if (t % 97 === 0) world.percepts.push({ for: 'all', kind: 'alarm', subject: '墙外', salience: 0.9 });
    if (t % c.refillEvery === 0) world.pantry = Math.min(c.pantryCap, world.pantry + c.refillAmount);
    scanSecrets(world);
    for (const id of Object.keys(agents)) {
      const a = agents[id];
      const before = a.trace.length;
      await a.tick(world);
      const produced = a.trace.slice(before).filter((x) => x.action);
      if (!produced.length) continue;
      const r = produced[produced.length - 1];
      acc.decisions += 1; acc.samples += 1;
      if (a.drives.v.stimulation > a.drives.setpoint.stimulation) acc.over += 1;
      for (const k of COUPLING_VARS) if (a.coupling.v[k] !== COUPLING_DEFAULT[k]) acc.occ[k] += 1;
      if (r.kind) {
        acc.kinds[r.kind] = (acc.kinds[r.kind] ?? 0) + 1;
        acc.rooms.add(world.loc[id]);
      }
      if (r.kind === 'talk') { acc.talkTried += 1; if (r.ok) acc.talkOk += 1; }
    }
    const byLoc = {};
    for (const id of Object.keys(world.loc)) (byLoc[world.loc[id]] ??= []).push(id);
    acc.together += Object.values(byLoc).reduce((s, g) => s + (g.length >= 2 ? g.length : 0), 0);
    acc.outdoor += Object.values(world.loc).filter((l) => (world.outdoor ?? []).includes(l)).length;
    const pairs = Array.isArray(world.companions) ? world.companions.length : 0;
    if (pairs > acc.companionPeak) acc.companionPeak = pairs;
    if (world.pantry < acc.pantryMin) acc.pantryMin = world.pantry;
  }
  socialRound(world, { presence: false });

  const list = Object.values(agents);
  const lastAction = (a) => a.trace.filter((x) => x.action).slice(-1)[0] ?? { drives: { social: NaN } };
  acc.companionEnd = Array.isArray(world.companions) ? world.companions.length : 0;
  acc.norms = Array.isArray(world.normLog) ? world.normLog.length : 0;
  acc.coins = Object.values(world.coins).reduce((s, v) => s + v, 0);
  acc.asked = list.reduce((s, a) => s + (a.counters.asked ?? 0), 0);
  acc.habit = list.reduce((s, a) => s + (a.counters.habit ?? 0), 0);
  acc.rejected = list.reduce((s, a) => { const v = a.counters.rejected; return s + (typeof v === 'number' ? v : v && typeof v === 'object' ? Object.values(v).reduce((x, y) => x + (typeof y === 'number' ? y : 0), 0) : 0); }, 0);
  acc.endSocial = list.reduce((s, a) => s + lastAction(a).drives.social, 0) / list.length;
  acc.endViab = list.reduce((s, a) => s + a.viab.v, 0) / list.length;
  acc.stages = list.reduce((s, a) => s + a.viab.stage, 0);
  acc.collapsed = list.filter((a) => a.viab.stage > 0).length;
  acc.roomCount = acc.rooms.size;
  acc.rooms = [...acc.rooms];

  const digest = list.map((a) => a.trace.map((r) => `${r.t}|${r.action ?? r.layer}|${r.ok ?? ''}|${r.kind ?? ''}`).join('#')).join('@');
  return { acc, digest };
}

const rows = [];
const digests = {};
const started = Date.now();
for (const { 档, cfg } of ARMS) {
  const acc = {
    decisions: 0, samples: 0, together: 0, outdoor: 0, coins: 0, companionPeak: 0, companionEnd: 0,
    norms: 0, asked: 0, habit: 0, rejected: 0, endSocial: 0, endViab: 0, stages: 0, collapsed: 0,
    roomCount: 0, pantryMin: 0, talkOk: 0, talkTried: 0, over: 0, kinds: {}, occ: Object.fromEntries(COUPLING_VARS.map((k) => [k, 0])),
  };
  digests[档] = {};
  for (const seed of SEEDS) {
    const { acc: r, digest } = await run({ seed, cfg });
    digests[档][seed] = digest;
    for (const k of ['decisions', 'samples', 'together', 'outdoor', 'coins', 'companionPeak', 'companionEnd', 'norms', 'asked', 'habit', 'rejected', 'endSocial', 'endViab', 'stages', 'collapsed', 'roomCount', 'pantryMin', 'talkOk', 'talkTried', 'over']) acc[k] += r[k];
    for (const [k, v] of Object.entries(r.kinds)) acc.kinds[k] = (acc.kinds[k] ?? 0) + v;
    for (const k of COUPLING_VARS) acc.occ[k] += r.occ[k];
  }
  const n = SEEDS.length;
  const econ = ['work', 'buy', 'trade', 'companion'].reduce((s, k) => s + (acc.kinds[k] ?? 0), 0);
  rows.push({
    档,
    经济社交: econ,
    work: acc.kinds.work ?? 0,
    buy: acc.kinds.buy ?? 0,
    trade: acc.kinds.trade ?? 0,
    companion: acc.kinds.companion ?? 0,
    结伴末: Number((acc.companionEnd / n).toFixed(2)),
    规范: Number((acc.norms / n).toFixed(2)),
    共处人刻: Math.round(acc.together / n),
    户外人刻: Math.round(acc.outdoor / n),
    活动房间: Number((acc.roomCount / n).toFixed(2)),
    铜币: Number((acc.coins / n).toFixed(1)),
    末社交: Number((acc.endSocial / n).toFixed(3)),
    末存续: Number((acc.endViab / n).toFixed(3)),
    掉档: Number((acc.stages / n).toFixed(2)),
    过载: `${Number((acc.over / Math.max(1, acc.samples)) * 100).toFixed(1)}%`,
    问到: acc.asked,
    驳回: acc.rejected,
    公仓最低: acc.pantryMin,
  });
}

const base = digests['基线（演示默认）'];
const neg = digests['负控：显式传默认门槛'];
const baseRow = rows[0];
const g3 = (r) => r !== baseRow && r.经济社交 >= baseRow.经济社交 && r.共处人刻 >= baseRow.共处人刻 && r.活动房间 >= baseRow.活动房间;

console.log(`# town 世界层参数取舍扫描（PLAN §30；同种子臂、${SEEDS.length} seed=${SEEDS.join('/')} × ${TICKS} 刻；channelMask 一律不传；stub deliberator 不花钱）`);
console.table(rows);
console.log('# G1 负控（不传 townGates vs 显式传默认值）：', SEEDS.every((s) => neg[s] === base[s]) ? 'digest 逐位相同 ⇒ 门槛重构中性，默认档未受影响' : `有 ${SEEDS.filter((s) => neg[s] !== base[s]).length} 个 seed 不同 ⇒ 重构泄漏了行为，本表作废`);
console.log('# G1 各档相对基线 digest 不同的 seed 数（0 表示这一改在三个 seed 上都没改变任何行为）：');
for (const { 档 } of ARMS) console.log(`   ${档}: ${SEEDS.filter((s) => digests[档][s] !== base[s]).length}/${SEEDS.length}`);
console.log('# G3 满足"更热闹"三条件（经济社交 且 共处人刻 且 活动房间 都不低于基线）的档：', rows.filter(g3).map((r) => r.档).join('、') || '无 ⇒ 按 S2 如实登记：这几个旋钮买不到人气');
console.log(`# 基线三条件取值：经济社交 ${baseRow.经济社交} / 共处人刻 ${baseRow.共处人刻} / 活动房间 ${baseRow.活动房间}`);
console.log('# 末社交／末存续／掉档／过载 必须与热闹结论同句出现（§30 G5）。补给管够那一档是成本作弊参考，不作产品建议（§30 S3）。');
console.log(`耗时 ${((Date.now() - started) / 1000).toFixed(1)} 秒；PARAMS.coupling.tau=${PARAMS.coupling.tau}，日程权重=${PARAMS.schedule.weight}（本表未改任何默认值）`);
