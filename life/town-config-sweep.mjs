// town 配置扫描（PLAN §29 预登记）：六个默认关的可选掩码在演示口径下各自开、一起开，行为怎么变。
// 只测量：不改机制、不改默认值、不加演示入口。
// 装置要点：不走 simulate（它把掩码哈希进种子 ⇒ 开关对比恒真，§24.1 登记的弱点）；
// 两臂共用同一批显式种子，"关"这一档就是其余各档的配对对照。世界照 host.mjs 的演示口径搭。
import { makeWorld, spawn, scanSecrets } from './body.mjs';
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

const ARMS = [
  { 档: '① 关（演示默认）', mask: null },
  { 档: '② 显式全 0（负控）', mask: { m3: 0, coupling: 0, eventFirst: 0, cfUsage: 0, plasticGate: 0, lpExplore: 0 } },
  { 档: '③ +m3', mask: { m3: 1 } },
  { 档: '④ +coupling', mask: { coupling: 1 } },
  { 档: '⑤ +eventFirst', mask: { eventFirst: 1 } },
  { 档: '⑥ +cfUsage', mask: { cfUsage: 1 } },
  { 档: '⑦ +plasticGate', mask: { plasticGate: 1 } },
  { 档: '⑧ +lpExplore', mask: { lpExplore: 1 } },
  { 档: '⑨ 全开（六件）', mask: { m3: 1, coupling: 1, eventFirst: 1, cfUsage: 1, plasticGate: 1, lpExplore: 1 } },
];

// 冒烟用小档只改样本量，不改判据（§29 的正式读数是 3 seed × 1200 刻）。
const SEEDS = (process.env.SWEEP_SEEDS ?? '7,11,13').split(',').map((x) => Number(x.trim())).filter(Number.isFinite);
const TICKS = Number(process.env.SWEEP_TICKS ?? 1200);

// 共处人刻：≥2 人（含占位玩家 p1）同室的角色-刻。演示里"镇子看着有人气"最直接的代理。
const together = (world) => {
  const byLoc = {};
  for (const id of Object.keys(world.loc)) {
    const l = world.loc[id];
    (byLoc[l] ??= []).push(id);
  }
  return Object.values(byLoc).reduce((s, g) => s + (g.length >= 2 ? g.length : 0), 0);
};

async function run({ seed, mask }) {
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

  const acc = {
    decisions: 0, samples: 0, over: 0, occ: Object.fromEntries(COUPLING_VARS.map((k) => [k, 0])),
    kinds: {}, talkOk: 0, talkTried: 0, together: 0, coins: 0,
    companionPeak: 0, companionEnd: 0, norms: 0, asked: 0, llmCalls: 0, habit: 0, deliberation: 0, rejected: 0,
    endSocial: 0, endViab: 0, stages: 0, collapsed: 0,
    cf: { cfDecisions: 0, cfMem: 0, cfRel: 0, cfHabit: 0, cfFallback: 0 },
  };

  for (let t = 1; t <= TICKS; t++) {
    world.t = t;
    world.percepts = [];
    if (world.weatherEnabled) world.weather = weatherFor(seed, dayOf(t));
    if (t % 97 === 0) world.percepts.push({ for: 'all', kind: 'alarm', subject: '墙外', salience: 0.9 });
    if (t % 55 === 0) world.pantry = Math.min(8, world.pantry + 2);
    scanSecrets(world);
    for (const id of Object.keys(agents)) {
      const a = agents[id];
      const pre = { ...a.coupling.v };
      const before = a.trace.length;
      await a.tick(world);
      const produced = a.trace.slice(before).filter((x) => x.action);
      if (!produced.length) continue;
      const r = produced[produced.length - 1];
      acc.decisions += 1;
      acc.samples += 1;
      if (a.drives.v.stimulation > a.drives.setpoint.stimulation) acc.over += 1;
      for (const k of COUPLING_VARS) if (a.coupling.v[k] !== COUPLING_DEFAULT[k]) acc.occ[k] += 1;
      if (r.kind) acc.kinds[r.kind] = (acc.kinds[r.kind] ?? 0) + 1;
      if (r.kind === 'talk') { acc.talkTried += 1; if (r.ok) acc.talkOk += 1; }
    }
    acc.together += together(world);
    const pairs = Array.isArray(world.companions) ? world.companions.length : 0;
    if (pairs > acc.companionPeak) acc.companionPeak = pairs;
  }
  if (world.socialGossip > 0) socialRound(world, { presence: false });

  const list = Object.values(agents);
  const lastAction = (a) => a.trace.filter((x) => x.action).slice(-1)[0] ?? { drives: { social: NaN }, viab: { v: NaN } };
  acc.endSocial = list.reduce((s, a) => s + lastAction(a).drives.social, 0) / list.length;
  acc.endViab = list.reduce((s, a) => s + a.viab.v, 0) / list.length;
  acc.stages = list.reduce((s, a) => s + a.viab.stage, 0);
  acc.collapsed = list.filter((a) => a.viab.stage > 0).length;
  acc.coins = Object.values(world.coins).reduce((s, v) => s + v, 0);
  acc.companionEnd = Array.isArray(world.companions) ? world.companions.length : 0;
  acc.norms = Array.isArray(world.normLog) ? world.normLog.length : 0;
  acc.asked = list.reduce((s, a) => s + (a.counters.asked ?? 0), 0);
  acc.llmCalls = list.reduce((s, a) => s + (a.counters.llmCalls ?? 0), 0);
  acc.habit = list.reduce((s, a) => s + (a.counters.habit ?? 0), 0);
  acc.deliberation = list.reduce((s, a) => s + (a.counters.deliberation ?? 0), 0);
  acc.rejected = list.reduce((s, a) => s + rejectTotal(a), 0);
  for (const k of Object.keys(acc.cf)) acc.cf[k] = list.reduce((s, a) => s + (a.counters[k] ?? 0), 0);

  const digest = list.map((a) => a.trace.map((r) => `${r.t}|${r.action ?? r.layer}|${r.ok ?? ''}|${r.kind ?? ''}`).join('#')).join('@');
  return { acc, digest };
}

// 驳回计数在 counters.rejected 里可能是按原因分的对象（不是单个数），这里统一收成总数。
const rejectTotal = (a) => {
  const v = a.counters.rejected;
  if (typeof v === 'number') return v;
  if (v && typeof v === 'object') return Object.values(v).reduce((s, x) => s + (typeof x === 'number' ? x : 0), 0);
  return 0;
};

const rows = [];
const digests = {};
const started = Date.now();
for (const { 档, mask } of ARMS) {
  const acc = {
    decisions: 0, samples: 0, over: 0, occ: Object.fromEntries(COUPLING_VARS.map((k) => [k, 0])),
    kinds: {}, talkOk: 0, talkTried: 0, together: 0, coins: 0, companionPeak: 0, companionEnd: 0,
    norms: 0, asked: 0, llmCalls: 0, habit: 0, deliberation: 0, rejected: 0, endSocial: 0, endViab: 0, stages: 0, collapsed: 0,
    cf: { cfDecisions: 0, cfMem: 0, cfRel: 0, cfHabit: 0, cfFallback: 0 },
  };
  digests[档] = {};
  for (const seed of SEEDS) {
    const { acc: r, digest } = await run({ seed, mask });
    digests[档][seed] = digest;
    for (const k of ['decisions', 'samples', 'over', 'together', 'coins', 'companionPeak', 'companionEnd', 'norms', 'asked', 'llmCalls', 'habit', 'deliberation', 'rejected', 'endSocial', 'endViab', 'stages', 'collapsed']) acc[k] += r[k];
    for (const k of COUPLING_VARS) acc.occ[k] += r.occ[k];
    for (const [k, v] of Object.entries(r.kinds)) acc.kinds[k] = (acc.kinds[k] ?? 0) + v;
    acc.talkOk += r.talkOk; acc.talkTried += r.talkTried;
    for (const k of Object.keys(acc.cf)) acc.cf[k] += r.cf[k];
  }
  const n = SEEDS.length;
  const econ = ['work', 'buy', 'trade', 'companion'].reduce((s, k) => s + (acc.kinds[k] ?? 0), 0);
  rows.push({
    档,
    经济社交动作: econ,
    work: acc.kinds.work ?? 0,
    buy: acc.kinds.buy ?? 0,
    trade: acc.kinds.trade ?? 0,
    companion: acc.kinds.companion ?? 0,
    结伴末: acc.companionEnd / n,
    结伴峰: acc.companionPeak / n,
    规范事件: acc.norms / n,
    共处人刻: Math.round(acc.together / n),
    铜币: acc.coins / n,
    talk成功: `${acc.talkOk}/${acc.talkTried}`,
    末社交: Number((acc.endSocial / n).toFixed(3)),
    末存续: Number((acc.endViab / n).toFixed(3)),
    掉档: acc.stages / n,
    垮过个体: acc.collapsed / n,
    过载: `${Number((acc.over / Math.max(1, acc.samples)) * 100).toFixed(1)}%`,
    听不进: `${Number((acc.occ.input / Math.max(1, acc.samples)) * 100).toFixed(1)}%`,
    叫不到: `${Number((acc.occ.available / Math.max(1, acc.samples)) * 100).toFixed(1)}%`,
    预设不理: `${Number((acc.occ.refuse / Math.max(1, acc.samples)) * 100).toFixed(1)}%`,
    问到: acc.asked,
    实际调用: acc.llmCalls,
    习惯接管: acc.habit,
    驳回: acc.rejected,
    cf决策: acc.cf.cfDecisions,
    cf习惯: acc.cf.cfHabit,
    cf记忆: acc.cf.cfMem,
    cf关系: acc.cf.cfRel,
    兜底: acc.cf.cfFallback,
    决策数: acc.decisions,
  });
}

const base = digests['① 关（演示默认）'];
const diffs = Object.fromEntries(ARMS.map(({ 档 }) => [档, SEEDS.filter((s) => digests[档][s] !== base[s]).length]));

console.log(`# town 配置扫描（PLAN §29；同种子臂，${SEEDS.length} seed=${SEEDS.join('/')} × ${TICKS} 刻；演示口径 pantry=3 + socialGossip=1 + p1 在场；stub deliberator 不花钱）`);
console.table(rows);
console.log('# G2 负控（显式全 0 vs 不传掩码）：', diffs['② 显式全 0（负控）'] === 0 ? 'digest 逐位相同 ⇒ 关档无副作用' : `不同 seed 数=${diffs['② 显式全 0（负控）']} ⇒ 掩码本身在关档有副作用，本表作废`);
console.log(`# G1 各档相对关档的 digest 不同的 seed 数（判据线：≥2/${SEEDS.length} 才算落到行为上）：`);
for (const { 档 } of ARMS) console.log(`   ${档}: ${diffs[档]}/${SEEDS.length}`);
console.log('# 问到是 stub 调用意图计数，不是真实 API 调用数或魔粒；轨迹分叉后不是配对比较，只报各档内分布，不做显著性声称（§29 判据 G5/口径）。');
console.log(`耗时 ${((Date.now() - started) / 1000).toFixed(1)} 秒；PARAMS.coupling.tau=${PARAMS.coupling.tau}，日程权重=${PARAMS.schedule.weight}（本表未改）`);
