// 生存单世界游玩层（Phase D / §14–15 P2）。居民＝完整 Organism（同权：玩家能做的 AI 都能做）。
// 服务端权威；前端只读 /world.survival；玩家动作走 /act {mode:'survival'}。
// additive：不改动 A/B pack、不改动 lab/town 基线；存档以独立键 survival 挂载（缺省 tolerant）。
import { makeWorld, spawn, scanSecrets, actuate } from './body.mjs';
import { campAction, campTimberView } from './camp-play.mjs';
import { constructionLot, RESIDENT_HOMES, generateCampLayout } from '../web/camp-layout.mjs';
import { weatherFor, dayOf, DAY_TICKS, survivalPhaseOf, seasonOf, SEASONS, SEASON_DAYS } from './clock.mjs';
import { effectiveMods, BUILDINGS, produceYield, DEFAULT_LIVESTOCK, PRODUCE_CAP, PRODUCE_KINDS, EXCHANGE, EXPAND, EXPAND_LABEL, PRODUCE_LABEL, LIVESTOCK_CAP } from './production.mjs';
import { initCoop } from './cooperation.mjs';
import { forecastDisasters } from './worldstate.mjs';
import { Organism } from './agent.mjs';
import { hashSeed } from './rng.mjs';
import { ADULT_DAYS, makeHouseholds, residentStage, houseAction, stepHouseholds, stepRelationships, familyHomeForBirth, restoreHouseholds } from './households.mjs';

const ROSTER = [['a1', '岑', '谨慎'], ['a2', '绛', '冲动'], ['a3', '蓑', '孤僻']];
// 只读表现字段：从 Organism.trace 里取最近一次成功动作的 kind，供 3D 姿态与图标使用。
// 不改规则层、不参与裁决、不消费 rng；找不到回退 idle。
function lastAct(a, t) {
  const tr = a?.trace;
  if (!Array.isArray(tr)) return 'idle';
  for (let i = tr.length - 1, n = 0; i >= 0 && n < 40; i -= 1, n += 1) {
    const r = tr[i];
    if (!r || !r.ok || !r.kind || r.layer === 'refused' || r.layer === 'aborted') continue;
    if (t - (r.t ?? t) > 3) break;
    return r.kind;
  }
  return 'idle';
}
export const sexOf = (seed, id) => (hashSeed(seed, `sex:${id}`) % 2 === 0 ? 'M' : 'F');

export function createSurvPlay(seed=7,{residentialDecisions=false,deliberator=null,mapSeed=0,layoutVersion=0}={}) {
  const world = makeWorld({ preset: 'survival', seed, pantries: 0, coop: true });
  world.mapSeed = mapSeed;
  world.layoutVersion = layoutVersion;
  if (layoutVersion === 1) {
    world.campLayout = generateCampLayout(mapSeed);
    const [x,z] = world.campLayout.sites.garden;
    for (const plot of world.survival.plots) plot.at = [x+plot.id%2,z+Math.floor(plot.id/2)];
  }
  world.survivalDeliberator = deliberator;
  // §15 P2-B：初始 roster 保证两性在场（否则开局即"无异性对"终局）；其余性别确定哈希
  world.sex = { a1: 'M', a2: 'F', a3: sexOf(seed, 'a3'), p1: sexOf(seed, 'p1') };
  for (const [id, name, archetype] of ROSTER) {
    const a = new Organism({ id, name, archetype, seed: hashSeed(seed, `${id}:surv`), condition: 'C2', deliberator });
    world.agents[id] = a;
    spawn(world, id, 'home');
  }
  world.agents.p1 = { id: 'p1', name: '你', isPlayer: true };
  spawn(world, 'p1', 'hall');
  for (const id of Object.keys(world.stash ?? {})) world.stash[id] = 0; // §15.5 M3：生存无私藏（恒 on 语义 fix）
  world.pinv = {}; // §15 P2-C 背包：每角色个人木石
  for (const id of Object.keys(world.agents)) world.pinv[id] = { wood: 0, stone: 0 };
  const s=world.survival;
  world.housing=Object.fromEntries(Object.entries(RESIDENT_HOMES).map(([id,entry])=>[id,entry.room]));
  if (residentialDecisions) {
    world.locs = { ...world.locs };
    s.households = makeHouseholds(world.housing);
    restoreHouseholds(world);
  }

  // 采集/蓄养：独立产出账，缺省 tolerant（旧档没有这些键也能补上）。
  s.produce = Object.fromEntries(PRODUCE_KINDS.map((k) => [k, 0]));
  s.livestock = { ...DEFAULT_LIVESTOCK };
  s.produceCap = PRODUCE_CAP;
  s.forageCd = 0;
  s.forage = false; // §15 同权后撤安全网代劳（开关保留供对照/负控）
  s.repairEarly = true; // E3a 过 ⇒ 默认开
  s.eco = true; // §12 缓和曲线 H1∧H2 过
  s.disasters = true; // §11 备选档 G1 过
  s.playerEats = false; // §15.4 负结果回滚裁决②：4 人/日受水循环限制不可持续（播种耗水>雨补）；开关保留待水循环共设计预登记
  s.endFreeze = true; // §11 裁决①
  s.droughts = false; // §13 K2 负 ⇒ 默认关、R3 撤回
  s.forageStats = { harvest: 0, plant: 0 };
  s.farmerId = 'a1'; // §15.7 R1 角色化农夫（网格选定默认开）
  s.roleFarmer = false; // §15.7 网格：R1/R2' 均无效（aiH 不随角色升）⇒ 默认关、负结果留痕；机制代码保留待经济重设计
  s.allHunger = false;
  s.moveUrgency = true; // §16 选点（E4 饥饿需移动候选）
  s.workFeeds = false; // §16 选点：E1 off（E4 已足）
  s.storeHunger = true; // §16 选点：E4 on（公仓目标挂钩饥饿⇒AI 自足 idleWon 2/3）
  s.plantWater = 0.06; // §16 选点：E3 水循环再平衡
  return { world, log: [] };
}

// E1 安全网觅食（保留供对照；默认关）：全聚落每日预算 1 收＋1 种。
export function setSurvivalDeliberator(sp, deliberator) {
  sp.world.survivalDeliberator = deliberator;
  for (const a of Object.values(sp.world.agents)) if (!a.isPlayer) a.deliberator = deliberator;
}

function housingLabels(w) {
  if (w.survival.households) return {};
  return Object.fromEntries(Object.entries(w.housing).map(([id,room])=>
    [room,id==='p1'?'我的小屋':`${w.agents[id]?.name??id}的小屋`]));
}

function forageRound(w) {
  const s = w.survival;
  const pop = Object.values(w.agents).filter((a) => !a.isPlayer).length;
  if (s.store >= pop * (s.forageThreshold ?? 1)) return;
  let budgetH = 1; let budgetP = 1;
  for (const id of Object.keys(w.agents)) {
    if (w.agents[id].isPlayer || (!budgetH && !budgetP)) continue;
    const wantH = budgetH > 0 && s.plots.some((p) => p.growth >= 1);
    const wantP = budgetP > 0 && s.plots.some((p) => p.growth === 0) && s.water >= 0.1;
    if (!wantH && !wantP) continue;
    if (w.loc[id] !== 'garden') {
      w.occupancy[w.loc[id]] = (w.occupancy[w.loc[id]] ?? []).filter((x) => x !== id);
      w.loc[id] = 'garden'; (w.occupancy.garden ??= []).push(id);
    }
    if (wantH) { const r = actuate(w, id, { kind: 'harvest' }); if (r.ok) { s.forageStats.harvest += 1; budgetH -= 1; } }
    if (wantP) { const r = actuate(w, id, { kind: 'plant' }); if (r.ok) { s.forageStats.plant += 1; budgetP -= 1; } }
  }
}

export async function tickSurvPlay(sp) {
  const w = sp.world;
  w.t += 1;
  w.weather = weatherFor(w.seed ?? 7, dayOf(w.t));
  w.percepts = [];
  w.pending = (w.pending ?? []).filter((x) => x.for !== 'p1');
  scanSecrets(w);           // 内含 advanceSurvival(日界) + stepCooperation(coop 开)
  if (w.survival.forage && dayOf(w.t) !== dayOf(w.t - 1)) forageRound(w);
  if (dayOf(w.t) !== dayOf(w.t - 1)) {
    if (w.survival.households && !w.survival.ended && !w.survival.failed) stepHouseholds(w, sp.log);
    reproduce(w); // §15 P2-B 繁衍（日界）
    // 蓄养/果树日界结算：规则层算增量，写独立产出账，不碰 store/inv。
    w.survival.produce ??= Object.fromEntries(PRODUCE_KINDS.map((k) => [k, 0]));
    const daily = produceYield(seasonOf(dayOf(w.t)), w.survival.livestock ?? DEFAULT_LIVESTOCK);
    for (const [k, v] of Object.entries(daily)) w.survival.produce[k] = Math.min(PRODUCE_CAP * 4, (w.survival.produce[k] ?? 0) + v);
    sp.log.push({ t: w.t, kind: 'produce', ok: true, code: Object.entries(daily).map(([k, v]) => k + v).join('/') });
    // §15 P2-D 性格-季节慢偏移：冬社交设点降、夏升（人格随季节缓慢变化）
    const season = seasonOf(dayOf(w.t));
    const d = season === 3 ? -0.005 : season === 1 ? 0.005 : 0;
    if (d) for (const a of Object.values(w.agents)) {
      if (a.isPlayer || !a.drives) continue;
      a.drives.setpoint.social = Math.max(0.2, Math.min(0.6, a.drives.setpoint.social + d));
    }
  }
  // 同权：居民走完整决策环（survival affordances 已含全部玩家动作）
  for (const id of Object.keys(w.agents)) {
    const a = w.agents[id];
    if (a.isPlayer) continue;
    try { await a.tick(w); } catch (e) { sp.log.push({ t: w.t, kind: 'agentError', ok: false, code: String(e?.message ?? e).slice(0, 80) }); }
    // §15.7：R1 农夫额外衰减（持久饥饿）；R2' 全员额外衰减（community 驱动的替代实现，不碰全局 NEED_META）
    if (w.survival.roleFarmer && id === w.survival.farmerId) a.drives.tick(3, false);
    else if (w.survival.allHunger) a.drives.tick(1, false);
    // §16 E4 公仓目标挂钩饥饿：公仓低于 pop×3 时全员饿感上升⇒集体劳动；§17 L1 强度乘数 hungerK
    if (w.survival.storeHunger === true) {
      const popH = Object.values(w.agents).filter((x) => !x.isPlayer).length;
      const mult = 1 + (w.survival.hungerK ?? 1) * Math.max(0, 1 - w.survival.store / (popH * 3));
      if (mult > 1) a.drives.tick(mult - 1, false);
    }
    // §17 L3 承诺锁链：survival 居民启用 m3 承诺（锁住收/种链，减少往返振荡）
    a.ch.m3 = w.survival.commitChain === true ? 1 : 0;
  }
  if (w.survival.households && !w.survival.ended && !w.survival.failed) stepRelationships(w, sp.log);
  return w;
}

// §15 P2-B 繁衍：异性存活对＋住所完好＋粮≥pop×2＋信任≥60＋冷却 10 天 ⇒ 新生 Organism（记忆从空开始）
const CHILD_NAMES = ['芽', '苗', '穗', '实', '蘖', '籽'];
function newChild(w, id) {
  const seed = w.seed ?? 7;
  const index = Number(id.slice(1)) - 1;
  return new Organism({ id, name: CHILD_NAMES[index % CHILD_NAMES.length],
    archetype: ['谨慎', '冲动', '孤僻'][hashSeed(seed, `arch:${id}`) % 3],
    seed: hashSeed(seed, `${id}:surv`), condition: 'C2', deliberator: w.survivalDeliberator });
}
function reproduce(w) {
  const s = w.survival;
  if (s.ended || s.failed) return;
  const day = dayOf(w.t);
  if (day - (s.lastBirthDay ?? -99) < 10) return;
  const pop = Object.values(w.agents).filter((a) => !a.isPlayer).length;
  if (s.store < pop * 2) return;
  if (!s.buildings.some((b) => b.type === 'shelter' && b.integrity > 0)) return;
  const alive = Object.values(w.agents).filter((a) => a.isPlayer || (a.viab?.v ?? 1) > 0);
  for (const a of alive) for (const b of alive) {
    if (a.id >= b.id) continue;
    if ((w.sex?.[a.id] ?? 'M') === (w.sex?.[b.id] ?? 'F')) continue;
    const room = s.households ? familyHomeForBirth(w, a.id, b.id) : null;
    if (s.households ? !room : (a.relations?.get?.(b.id)?.trust ?? 30) < 60) continue;
    const n = (s.births ?? 0) + 1;
    const id = `c${n}`;
    w.agents[id] = newChild(w, id);
    w.sex[id] = sexOf(w.seed ?? 7, id);
    if (w.stash) w.stash[id] = 0;
    if (s.households) {
      w.pinv[id] = { wood: 0, stone: 0 };
      s.households.residents[id] = { born: w.t, parents: [a.id, b.id] };
      w.housing[id] = room;
    }
    spawn(w, id, room ?? 'home');
    s.births = n;
    s.lastBirthDay = day;
    return;
  }
}

export function survAct(sp, body) {
  const w = sp.world;
  const kind = String(body?.kind ?? '');
  if (kind === 'move') {
    const room = String(body?.room ?? '');
    if (!Object.hasOwn(w.locs,room) && !Object.values(w.housing).includes(room)) return {ok:false,error:'NO_LOC'};
    w.occupancy[w.loc.p1] = (w.occupancy[w.loc.p1] ?? []).filter((x) => x !== 'p1');
    w.loc.p1 = room; (w.occupancy[room] ??= []).push('p1');
    return { ok: true };
  }
  if (kind.startsWith('family_')) {
    const result = houseAction(w, 'p1', body);
    sp.log.push({ t: w.t, kind, ...result });
    if (sp.log.length > 40) sp.log.shift();
    return result;
  }
  if (kind.startsWith('camp_')) {
    const result=campAction(w,body);
    sp.log.push({t:w.t,kind,ok:result.ok,code:result.code});
    if (sp.log.length>40) sp.log.shift();
    return result;
  }
  // 同权：玩家与 AI 的这些动作都走 actuate → 规则层裁决，不再为玩家开特判。
  if (!['harvest', 'plant', 'gather', 'plan', 'build', 'repair', 'deposit', 'withdraw', 'forage', 'exchange', 'expand'].includes(kind)) return { ok: false, error: 'UNKNOWN_KIND' };
  const r = actuate(w, 'p1', { kind, type: body?.type });
  sp.log.push({ t: w.t, kind, ok: r.ok, code: r.code });
  if (sp.log.length > 40) sp.log.shift();
  return r;
}

export function survView(sp) {
  const w = sp.world; const s = w.survival; const mods = effectiveMods(w);
  return {
    t: w.t, mapSeed: w.mapSeed, layoutVersion: w.layoutVersion, layout: w.campLayout, phase: survivalPhaseOf(w.t), weather: w.weather,
    season: SEASONS[seasonOf(dayOf(w.t))], dayInSeason: (dayOf(w.t) % SEASON_DAYS) + 1,
    day: dayOf(w.t), targetDays: SURV_TARGET,
    rooms:{...w.locs,...housingLabels(w)}, outdoor:w.outdoor,
    loc: w.loc, occupancy: w.occupancy,
    store: s.store, storeCap: mods.storeCap, water: Number(s.water.toFixed(2)), soil: Number(s.soil.toFixed(2)),
    plots: s.plots.map((p) => ({ id: p.id, growth: Number(p.growth.toFixed(2)) })),
    inv: s.inv, pinv: w.pinv ?? {}, sites: s.sites, buildings: s.buildings,
    camp:{containers:s.campContainers??{},mealsEaten:s.mealsEaten??0,timber:campTimberView(w)},
    housing: w.housing,
    households: s.households ? { ...s.households, adultDays: ADULT_DAYS } : null,
    coop: { enabled: s.coop.enabled, task: s.coop.task, completions: s.coop.completions.slice(-10), refusals: s.coop.refusals, replans: s.coop.replans },
    agents: Object.fromEntries(Object.values(w.agents).map((a) => [a.id, { id: a.id, name: a.name, isPlayer: !!a.isPlayer, stage: residentStage(w, a.id), sex: w.sex?.[a.id] ?? null, act: a.isPlayer ? 'idle' : lastAct(a, w.t), energy: a.isPlayer ? null : Number((a.drives?.v?.energy ?? 0).toFixed(2)), loc: w.loc[a.id] ?? null, viab: a.isPlayer ? null : Number((a.viab?.v ?? 1).toFixed(2)) }])),
    failed: s.failed, won: s.won, ended: !!s.ended, endReason: s.endReason ?? null, births: s.births ?? 0, history: s.history.slice(-14),
    ...forecastDisasters(w),
    drought: !!s.drought, disasterToday: s.disasterToday,
    clearStreak: s.clearStreak ?? 0, coldStreak: s.coldStreak ?? 0,
    yieldTotal: s.yieldTotal ?? 0, harvestCount: s.harvestCount ?? 0,
    log: sp.log.slice(-12),
    produce: { ...(s.produce ?? {}) }, livestock: { ...(s.livestock ?? DEFAULT_LIVESTOCK) },
    produceCap: s.produceCap ?? PRODUCE_CAP, forageCd: s.forageCd ?? 0,
    economy: { exchange: EXCHANGE, expand: EXPAND, expandLabel: EXPAND_LABEL, produceLabel: PRODUCE_LABEL, cap: LIVESTOCK_CAP },
    buildingsDef: BUILDINGS,
  };
}

const SURV_TARGET = 10; // 无尽模式落地前的里程碑显示；P2-B 终局语义替换

// 持久化（additive）：只 dump 生存世界事实，读回时 tolerant。
export function dumpSurv(sp) {
  const w = sp.world;
  // §15 P2-C 心智入档：居民内部状态活过重启（镜像 host serialize 的心智字段）
  const minds = Object.fromEntries(Object.values(w.agents).filter((a) => !a.isPlayer && a.drives).map((a) => [a.id, {
    m: a.bank.snapshot(), drives: { ...a.drives.v }, memory: a.memory.dump(),
    rel: [...a.relations.map.entries()], relCeiling: a.relations.ceiling,
    habit: a.habit.dump(), forwardModel: a.forwardModel.dump(), viab: a.viab.dump(),
    traits: structuredClone(a.traits),
  }]));
  return { t: w.t, seed: w.seed, mapSeed: w.mapSeed, layoutVersion: w.layoutVersion, loc: w.loc, survival: w.survival, log: sp.log,
    sex: w.sex, pinv: w.pinv, minds, ...(w.survival.households ? { housing: w.housing } : {}) };
}
export function loadSurv(raw,seed=7,options) {
  const sp=createSurvPlay(Number.isSafeInteger(raw?.seed) ? raw.seed : seed,
    { ...options, mapSeed: Number.isSafeInteger(raw?.mapSeed) ? raw.mapSeed : 0, layoutVersion: raw?.layoutVersion === 1 ? 1 : 0 });
  if (raw && typeof raw.t === 'number' && raw.survival) {
    const w = sp.world;
    w.t = raw.t;
    if (w.survival.households && raw.survival.households) w.survival.households = raw.survival.households;
    for (const id of Object.keys(raw.minds ?? {})) {
      if (!/^c[1-9]\d*$/.test(id)) continue;
      w.agents[id] = newChild(w, id);
      w.pinv[id] = { wood: 0, stone: 0 };
      if (w.survival.households) {
        w.survival.households.residents[id] ??= {
          born: w.t - ADULT_DAYS * DAY_TICKS, parents: [], legacy: true,
        };
      }
    }
    restoreHouseholds(w, raw.housing);
    w.weather = weatherFor(w.seed, dayOf(w.t));
    sp.world.loc = { ...sp.world.loc, ...(raw.loc ?? {}) };
    // occupancy 是派生数据但顺序进感知/候选：dumpSurv 不存它，读档必须按 loc 重建，
    // 否则创建期的 spawn 占位与存档位置错位，下一次 move() 取 occupancy[from] 落空。
    sp.world.occupancy = {};
    for (const id of Object.keys(sp.world.agents)) {
      const l = sp.world.loc[id];
      if (l) (sp.world.occupancy[l] ??= []).push(id);
    }
    sp.world.survival = { ...sp.world.survival, ...raw.survival, coop: { ...sp.world.survival.coop, ...(raw.survival.coop ?? {}) } };
    for (const key of ['buildings','sites']) sp.world.survival[key]=sp.world.survival[key].map(b=>{
      const lot=constructionLot(b.loc, w.campLayout);
      return lot?{...b,lot}:b;
    });
    sp.world.sex = { ...sp.world.sex, ...(raw.sex ?? {}) };
    sp.world.pinv = { ...sp.world.pinv, ...(raw.pinv ?? {}) };
    for (const [id, st] of Object.entries(raw.minds ?? {})) {
      const a = sp.world.agents[id];
      if (!a || !a.drives || !st) continue;
      Object.assign(a.drives.v, st.drives ?? {});
      if (typeof a.bank.restore === 'function') a.bank.restore(st.m);
      a.memory.load(Array.isArray(st.memory) ? { rows: st.memory } : st.memory);
      a.relations.map = new Map(st.rel ?? []);
      if (typeof st.relCeiling === 'number') a.relations.ceiling = st.relCeiling;
      a.habit.load(st.habit);
      a.forwardModel.load(st.forwardModel);
      a.viab.restore(st.viab);
      Object.assign(a.traits, st.traits ?? {});
    }
    // 历史 agentError 属于旧引擎的故障读数，不是世界事实；随档带回来会让面板永远显示旧红字。
    sp.log = (raw.log ?? []).filter((x) => x?.kind !== 'agentError');
  }
  return sp;
}