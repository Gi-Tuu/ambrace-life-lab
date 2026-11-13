// 生存单世界游玩层（Phase D / §14–15 P2）。居民＝完整 Organism（同权：玩家能做的 AI 都能做）。
// 服务端权威；前端只读 /world.survival；玩家动作走 /act {mode:'survival'}。
// additive：不改动 A/B pack、不改动 lab/town 基线；存档以独立键 survival 挂载（缺省 tolerant）。
import { makeWorld, spawn, scanSecrets, actuate, isAlive, livingResidents, SURV_COST } from './body.mjs';
import { validate } from './rules.mjs';
import { leaveTalk, talkInRange } from './dialogue.mjs';
import { campAction, campTimberView } from './camp-play.mjs';
import { constructionLot, RESIDENT_HOMES, generateCampLayout } from '../web/camp-layout.mjs';
import { weatherFor, dayOf, DAY_TICKS, survivalPhaseOf, seasonOf, SEASONS, SEASON_DAYS } from './clock.mjs';
import { effectiveMods, BUILDINGS, produceYield, DEFAULT_LIVESTOCK, PRODUCE_CAP, PRODUCE_KINDS, WILD_BERRIES, EXCHANGE, EXPAND, EXPAND_LABEL, PRODUCE_LABEL, LIVESTOCK_CAP } from './production.mjs';
import { COOP, initCoop, willingness, finishCooperation } from './cooperation.mjs';
import { forecastDisasters, SURV } from './worldstate.mjs';
import { stepEcosystem, initEcoPop, ECO } from './ecology.mjs';
import { Organism } from './agent.mjs';
import { hashSeed, survivalRoll, LEGACY_EVENT_RULES, CURRENT_EVENT_RULES } from './rng.mjs';
import { ADULT_DAYS, ELDER_DAYS, laborStage, RESIDENT_CAP, makeHouseholds, residentStage, ageDays, houseAction, stepHouseholds, stepRelationships, birthHomeStatus, restoreHouseholds } from './households.mjs';

const SURV_TRACE_LIMIT = 2000;
const SURV_LOG_LIMIT = 200;

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

export function createSurvPlay(seed=7,{residentialDecisions=false,deliberator=null,mapSeed=0,layoutVersion=0,ecosystem=false,unifiedCooperation=false,independentWorld=false,wildFood=false,autonomousGoals=false,eventRulesVersion=LEGACY_EVENT_RULES}={}) {
  const world = makeWorld({ preset: 'survival', seed, pantries: 0, coop: true });
  if (eventRulesVersion !== LEGACY_EVENT_RULES && eventRulesVersion !== CURRENT_EVENT_RULES) {
    const error = new Error(`未知生存概率规则版本 ${eventRulesVersion}`);
    error.code = 'SURV_EVENT_VERSION';
    throw error;
  }
  world.eventRulesVersion = eventRulesVersion;
  world.unifiedCooperation = unifiedCooperation;
  world.independentWorld = independentWorld;
  world.autonomousGoals = autonomousGoals;
  if (wildFood) world.survival.wildBerries = { ...WILD_BERRIES };
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
  // P0-3：玩家与居民同一套存续/驱动（同权在"会死"这一层也成立）。
  // 决策环仍不跑玩家（isPlayer 跳过），但基础代谢、动作消耗、饥饿压力、进食回补全部一致。
  const p1 = new Organism({ id: 'p1', name: '你', archetype: '谨慎', seed: hashSeed(seed, 'p1:surv'), condition: 'C2', deliberator: null });
  p1.isPlayer = true;
  world.agents.p1 = p1;
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
    // P1-1：创始居民也入生命周期（开局即 fresh 成年，随世界时间衰老）；玩家不衰老（死亡走存续）。
    for (const [id] of ROSTER) s.households.residents[id] ??= { born: -ADULT_DAYS * DAY_TICKS, parents: [], stage: 'adult' };
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
  s.playerEats = true; // P0-3：玩家与居民同权，占一份日配给（用户裁决：会死亡的个人生存压力）
  s.endFreeze = true; // §11 裁决①
  s.droughts = false; // §13 K2 负 ⇒ 默认关、R3 撤回
  s.ecosystem = !!ecosystem; // P1-4/5/6 动态生态（果树＋鸡种群）；host 游戏开启，sweep 默认关⇒基线不变
  if (s.ecosystem) initEcoPop(s);
  s.forageStats = { harvest: 0, plant: 0 };
  s.deaths = []; // P0-1：死亡事件史（id/name/t/day/cause），随存档持久化，可查询不删除
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
  const pop = livingResidents(w).length; // P0-1：安全网阈值按存活人口
  if (s.store >= pop * (s.forageThreshold ?? 1)) return;
  let budgetH = 1; let budgetP = 1;
  for (const id of Object.keys(w.agents)) {
    if (w.agents[id].isPlayer || !isAlive(w.agents[id]) || (!budgetH && !budgetP)) continue;
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

// P0-1 统一收尸：存续归零的角色标记死亡、记录原因/时间、移出占位（不再被感知/交谈/组队）。
// 死亡不可逆：dead 一旦置位，决策环/配给/繁衍/施工/床位全部排除；历史保留可查询。
// 玩家死亡另触发终局（与聚落饿垮分开）。每拍末调用一次，覆盖代谢/动作/饥饿/伤害所有致死路径。
function reapDeaths(w, log) {
  const s = w.survival;
  let changed = false;
  for (const a of Object.values(w.agents)) {
    if (a.dead || !a.viab || a.viab.v > 0) continue;
    changed = true;
    a.dead = true;
    const cause = a.hurtBy ?? '衰竭';
    a.death = { t: w.t, day: dayOf(w.t), cause };
    (s.deaths ??= []).push({ id: a.id, name: a.name, t: w.t, day: dayOf(w.t), cause });
    const loc = w.loc[a.id];
    if (loc) w.occupancy[loc] = (w.occupancy[loc] ?? []).filter((x) => x !== a.id);
    log.push({ t: w.t, kind: 'death', ok: true, code: `${a.name}死亡（${cause}）` });
    if (a.isPlayer) {
      s.playerDead = true;
      if (!w.independentWorld) { s.failed = true; s.endReason = 'player'; }
      s.talk = null;
    }
  }
  return changed;
}

export function settleSurvival(sp) {
  const w = sp.world;
  const changed = reapDeaths(w, sp.log);
  const staleTalk = w.survival.talk && !talkInRange(w, w.survival.talk);
  if (staleTalk) w.survival.talk = null;
  if (w.independentWorld && sp.log.length > SURV_LOG_LIMIT) sp.log.splice(0, sp.log.length - SURV_LOG_LIMIT);
  return changed || Boolean(staleTalk);
}

// P1-1 老年额外代谢（每刻）：体能随衰老下降。
const ELDER_DECAY = 0.0004;
// P1-1 生命周期推进（日界）：阶段跃迁事件（成年/老年）＋老年自然衰老死亡。
// 死亡概率随龄升、用确定哈希（无 Math.random）⇒ 可复现；置 viab=0 交 reapDeaths 统一收尸记录 cause='衰老'。
function stepLifecycle(w, log) {
  const s = w.survival;
  if (!s.households) return;
  const day = dayOf(w.t);
  for (const a of Object.values(w.agents)) {
    if (a.isPlayer || !isAlive(a)) continue;
    const rec = s.households.residents[a.id];
    if (!rec) continue;
    const stage = residentStage(w, a.id);
    if (rec.stage && rec.stage !== stage) {
      if (stage === 'adult') log.push({ t: w.t, kind: 'adult', ok: true, code: `${a.name}成年` });
      else if (stage === 'elder') log.push({ t: w.t, kind: 'elder', ok: true, code: `${a.name}步入老年` });
    }
    rec.stage = stage;
    if (stage === 'elder') {
      const p = Math.min(0.5, 0.02 + (ageDays(w, a.id) - ELDER_DAYS) * 0.01) *
        (w.populationExperiment?.elderHazardScale ?? 1);
      if (survivalRoll(w, 'elder-death', a.id, day) < p) { a.hurtBy = '衰老'; a.viab.v = 0; }
    }
  }
}

export async function tickSurvPlay(sp) {
  const w = sp.world;
  w.t += 1;
  w.weather = weatherFor(w.seed ?? 7, dayOf(w.t));
  w.percepts = [];
  w.pending = (w.pending ?? []).filter((x) => x.for !== 'p1');
  scanSecrets(w);           // 内含 advanceSurvival(日界) + stepCooperation(coop 开)
  if (!w.unifiedCooperation && w.survival.forage && dayOf(w.t) !== dayOf(w.t - 1)) forageRound(w);
  if (dayOf(w.t) !== dayOf(w.t - 1)) {
    if (w.survival.households && (w.independentWorld || !w.survival.ended && !w.survival.failed)) stepHouseholds(w, sp.log);
    if (w.survival.households && (w.independentWorld || !w.survival.ended && !w.survival.failed)) stepLifecycle(w, sp.log); // P1-1 阶段跃迁＋衰老
    reproduce(w, sp.log); // §15 P2-B 繁衍（日界）；P1-3 人口上限＋出生事件
    // 蓄养/果树日界结算：规则层算增量，写独立产出账，不碰 store/inv。
    w.survival.produce ??= Object.fromEntries(PRODUCE_KINDS.map((k) => [k, 0]));
    let daily;
    if (w.survival.ecosystem) {
      // P1-4/5/6：动态生态——果树/鸡种群按健康×季节产果/蛋（鸡先吃植物性产出再吃公仓）；牛/羊仍静态。
      const ecoYield = stepEcosystem(w, sp.log);
      daily = produceYield(seasonOf(dayOf(w.t)), { ...w.survival.livestock, chickens: 0, orchards: 0 });
      daily.egg = ecoYield.egg; daily.fruit = ecoYield.fruit;
    } else {
      daily = produceYield(seasonOf(dayOf(w.t)), w.survival.livestock ?? DEFAULT_LIVESTOCK);
    }
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
  if (w.survival.talk && !talkInRange(w, w.survival.talk)) w.survival.talk = null;
  // 同权：居民走完整决策环（survival affordances 已含全部玩家动作）
  for (const id of Object.keys(w.agents)) {
    const a = w.agents[id];
    if (a.isPlayer) continue;
    if (!isAlive(a)) continue; // P0-1：死者不再参与任何自主决策与行动
    // 交谈中只跑基础代谢，不做自主决策：否则居民会边聊边走去干活，把对话打断。
    if (w.survival.talk?.target === id) {
      try { a.drives.tick(1, false); a.viab.tick(1); } catch { /* 对话优先 */ }
      continue;
    }
    try { await a.tick(w); } catch (e) { w.survival.agentErrors = (w.survival.agentErrors ?? 0) + 1; sp.log.push({ t: w.t, kind: 'agentError', ok: false, code: String(e?.message ?? e).slice(0, 80) }); }
    if (w.independentWorld && a.trace.length > SURV_TRACE_LIMIT) a.trace.splice(0, a.trace.length - SURV_TRACE_LIMIT);
    if (w.survival.households && residentStage(w, id) === 'elder') a.viab.v = Math.max(0, a.viab.v - ELDER_DECAY); // P1-1 老年体能下降（额外代谢）
    // §15.7：R1 农夫额外衰减（持久饥饿）；R2' 全员额外衰减（community 驱动的替代实现，不碰全局 NEED_META）
    if (w.survival.roleFarmer && id === w.survival.farmerId) a.drives.tick(3, false);
    else if (w.survival.allHunger) a.drives.tick(1, false);
    // §16 E4 公仓目标挂钩饥饿：公仓低于 pop×3 时全员饿感上升⇒集体劳动；§17 L1 强度乘数 hungerK
    if (w.survival.storeHunger === true) {
      const popH = livingResidents(w).length; // P0-1：饥饿压力按存活人口
      const mult = 1 + (w.survival.hungerK ?? 1) * Math.max(0, 1 - w.survival.store / (popH * 3));
      if (mult > 1) a.drives.tick(mult - 1, false);
    }
    // §17 L3 承诺锁链：survival 居民启用 m3 承诺（锁住收/种链，减少往返振荡）
    a.ch.m3 = w.survival.commitChain === true ? 1 : 0;
  }
  if (w.unifiedCooperation && w.survival.coop.enabled) finishCooperation(w);
  // 打字太久：居民主动走开（不等你点发送才判）。
  const talk = w.survival.talk;
  if (talk && Date.now() - talk.openAt > talk.patienceMs) {
    const gone = leaveTalk(sp);
    if (gone) sp.log.push({ t: w.t, kind: 'talk_left', ok: true, code: gone.line });
  }
  // P0-3：玩家只跑"需求/存续"这两条，不跑决策环。基础代谢与居民同参数；
  // 存续归零 ⇒ 玩家死亡，终局（与"聚落饿垮"分开显示）。动作消耗由 actuate 统一扣。
  const pl = w.agents.p1;
  if (pl?.drives && isAlive(pl) && (w.independentWorld || !w.survival.ended && !w.survival.failed)) {
    pl.drives.tick(1, false);
    pl.viab.tick(1);
  }
  settleSurvival(sp);
  if (w.survival.households && (w.independentWorld || !w.survival.ended && !w.survival.failed)) stepRelationships(w, sp.log);
  return w;
}

// §15 P2-B 繁衍：异性存活对＋住所完好＋粮≥pop×2＋信任≥60＋冷却 10 天 ⇒ 新生 Organism（记忆从空开始）
const CHILD_NAMES = ['芽', '苗', '穗', '实', '蘖', '籽'];
const ARCHETYPES = ['谨慎', '冲动', '孤僻'];
function newChild(w, id, parents = null) {
  const seed = w.seed ?? 7;
  const index = Number(id.slice(1)) - 1;
  // P1-2 轻量代际继承：性格倾向随一方父/母（确定哈希）；其余特质由独立 rng 采样 ⇒ 独立个体而非父母复制。
  const pa = parents?.[0], pb = parents?.[1];
  const archetype = (pa?.traits?.archetype && pb?.traits?.archetype)
    ? [pa.traits.archetype, pb.traits.archetype][hashSeed(seed, `arch:${id}`) % 2]
    : ARCHETYPES[hashSeed(seed, `arch:${id}`) % 3];
  return new Organism({ id, name: CHILD_NAMES[index % CHILD_NAMES.length],
    archetype, seed: hashSeed(seed, `${id}:surv`), condition: 'C2', deliberator: w.survivalDeliberator });
}
function reproduce(w, log) {
  const s = w.survival;
  const day = dayOf(w.t);
  const experiment = w.populationExperiment;
  const report = (reason, detail={}) => w.observeBirth?.({day,reason,...detail});
  if (s.ended || (s.failed && !w.independentWorld)) { report('ended'); return; }
  const interval = experiment?.birthInterval ?? 10;
  if (!experiment?.pairCooldown && day - (s.lastBirthDay ?? -99) < interval) { report('cooldown'); return; }
  const pop = livingResidents(w).length; // P0-1：繁衍门槛按存活人口
  if (pop >= (experiment?.residentCap ?? RESIDENT_CAP)) { report('population'); return; } // P1-3：人口上限（算力/生态承载），不无限生成
  if (s.store < pop * 2) { report('food'); return; }
  // 有住户系统时，繁衍门槛由"已婚＋同住＋有床"裁决（familyHomeForBirth）；旧的抽象 shelter
  // 检查会让婚姻永远卡在一栋与住所无关的建筑上。无 households 的旧档保留原门槛。
  if (!s.households && !s.buildings.some((b) => b.type === 'shelter' && b.integrity > 0)) return;
  const alive = Object.values(w.agents).filter(isAlive); // P0-1：死者不参与繁衍
  const rejected = {};
  let born = false;
  for (const a of alive) for (const b of alive) {
    if (a.id >= b.id) continue;
    if ((w.sex?.[a.id] ?? 'M') === (w.sex?.[b.id] ?? 'F')) continue;
    const key = `${a.id}|${b.id}`;
    const status = s.households ? birthHomeStatus(w,a.id,b.id) : { room: 'home' };
    const room = status.room;
    const reason = s.households ? status.reason : (a.relations?.get?.(b.id)?.trust ?? 30) < 60 ? 'trust' : null;
    const blocked = reason ?? (experiment?.pairCooldown && day - (s.birthsByPairDay?.[key] ?? -99) < interval ? 'pairCooldown' : null);
    if (blocked) { if (w.observeBirth) rejected[key]=blocked; continue; }
    if (livingResidents(w).length >= (experiment?.residentCap ?? RESIDENT_CAP) ||
        s.store < livingResidents(w).length * 2) break;
    const n = (s.births ?? 0) + 1;
    const id = `c${n}`;
    const child = newChild(w, id, [a, b]);
    w.agents[id] = child;
    w.sex[id] = survivalRoll(w, 'birth-sex', id, day) < .5 ? 'M' : 'F';
    if (w.stash) w.stash[id] = 0;
    if (s.households) {
      w.pinv[id] = { wood: 0, stone: 0 };
      s.households.residents[id] = { born: w.t, parents: [a.id, b.id], stage: 'infant' };
      w.housing[id] = room;
    }
    // P1-2 亲子纽带：子女与父母初始信任/熟悉高于中性（独立关系，随经历演化）。
    for (const p of [a, b]) {
      if (child.relations) { const r = child.relations.get(p.id); r.trust = 50; r.familiarity = 0.3; }
      if (p.relations) { const r = p.relations.get(id); r.trust = 50; r.familiarity = 0.3; }
    }
    spawn(w, id, room ?? 'home');
    s.births = n;
    s.lastBirthDay = day;
    if (experiment?.pairCooldown) (s.birthsByPairDay ??= {})[key] = day;
    report('born',{id,parents:[a.id,b.id]});
    born = true;
    log?.push({ t: w.t, kind: 'birth', ok: true, code: `${child.name}出生（${a.name}×${b.name}）` });
    if (!experiment?.pairCooldown) return;
  }
  if (!born) report('noPair',{rejected});
}

// P0-A：玩家行动时间。正式游戏（independentWorld）每世界刻预算 100：
// 重劳动 75、中劳动 50、移动/轻交互 25；研究模式不计，保护既有实验轨迹。
// 一个角色在同一世界刻不可能完成两次实质劳动；AI 由决策环天然每刻一次。
export const PLAYER_TIME = Object.freeze({
  move: 25, gather: 75, harvest: 75, plant: 75, plan: 75, build: 75, repair: 75,
  forage: 75, exchange: 50, expand: 75, deposit: 50, withdraw: 50,
  camp_chop: 75, camp_collect: 75, camp_plant: 75, camp_water: 50, camp_craft: 50,
  camp_store: 25, camp_take: 25, camp_eat: 25, coop_request: 25,
});
const PLAYER_BUDGET = 100;
function playerTimeCost(w, kind) {
  if (!w.independentWorld) return 0;
  if (kind.startsWith('family_')) return 10;
  if (kind === 'camp_sleep' || kind.startsWith('talk_')) return 0;
  return PLAYER_TIME[kind] ?? 0;
}
function budgetLeft(w) {
  const s = w.survival;
  if (s.p1BudgetTick !== w.t) { s.p1BudgetTick = w.t; s.p1BudgetLeft = PLAYER_BUDGET; }
  return s.p1BudgetLeft;
}
export function playerTimeLeft(w) { budgetLeft(w); return w.survival.p1BudgetLeft; }
function spendTime(w, cost) {
  budgetLeft(w);
  if (w.survival.p1BudgetLeft + 1e-9 < cost) return false;
  w.survival.p1BudgetLeft -= cost;
  return true;
}

export function survAct(sp, body) {
  const w = sp.world, kind = String(body?.kind ?? '');
  const cost = playerTimeCost(w, kind);
  if (cost > 0 && !spendTime(w, cost)) {
    sp.log.push({ t: w.t, kind, ok: false, code: 'ACTION_BUDGET' });
    if (sp.log.length > 40) sp.log.shift();
    return { ok: false, code: 'ACTION_BUDGET', why: '本世界刻的行动时间已用完，等下一拍' };
  }
  const r = survActInner(sp, body);
  if (w.independentWorld && r.ok) settleSurvival(sp);
  if (!r.ok && cost > 0) { budgetLeft(w); w.survival.p1BudgetLeft += cost; } // 失败退还，避免误点吃掉整刻
  return r;
}

function survActInner(sp, body) {
  const w = sp.world;
  const kind = String(body?.kind ?? '');
  if (w.independentWorld && !isAlive(w.agents.p1)) return { ok: false, code: 'PLAYER_DEAD', error: 'GAME_OVER' };
  if (!w.independentWorld && (w.survival.failed || w.survival.ended)) return { ok: false, code: 'CAMP_ENDED', error: 'GAME_OVER' };
  if (kind === 'move') {
    const room = String(body?.room ?? '');
    if (!Object.hasOwn(w.locs,room) && !Object.values(w.housing).includes(room)) return {ok:false,error:'NO_LOC'};
    w.occupancy[w.loc.p1] = (w.occupancy[w.loc.p1] ?? []).filter((x) => x !== 'p1');
    w.loc.p1 = room; (w.occupancy[room] ??= []).push('p1');
    w.agents.p1?.viab?.spend(SURV_COST.move_to); // P0-2：移动与 AI move_to 同价
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
  // P0-5：玩家在当前工地向指定居民请求协助。AI 按自身需求/关系/天气/任务价值裁决接受/替代/拒绝。
  if (kind === 'coop_request') {
    const s = w.survival;
    if (!s.coop?.enabled) return { ok: false, code: 'COOP_OFF' };
    const target = String(body?.target ?? '');
    const a = w.agents[target];
    if (!a || a.isPlayer || !isAlive(a) || (w.unifiedCooperation && !laborStage(w, target))) return { ok: false, code: 'NO_RESIDENT' };
    const site = s.sites.find((x) => x.loc === w.loc.p1);
    if (!site) return { ok: false, code: 'NO_SITE' };
    const wl = willingness(w, target, { type: site.type, severity: 0.7, requester: 'p1', loc: site.loc });
    if (wl.decision === 'refuse') {
      s.coop.refusals += 1;
      sp.log.push({ t: w.t, kind, ok: false, code: 'REFUSED' });
      if (sp.log.length > 40) sp.log.shift();
      return { ok: false, code: 'REFUSED', decision: 'refuse', score: wl.score, reason: wl.reason };
    }
    let ct = s.coop.task;
    if (!ct || ct.loc !== site.loc) ct = s.coop.task = { type: site.type, loc: site.loc, phase: 'build', workers: [], startedAt: w.t, severity: 0.7, requester: 'p1' };
    if (!ct.workers.includes(target)) {
      if (w.unifiedCooperation && ct.workers.length >= COOP.maxWorkers) return { ok: false, code: 'TEAM_FULL' };
      ct.workers.push(target);
    }
    (ct.commit ??= {})[target] = wl.decision; // assist＝稳定承诺；alternative＝每拍重评，可中途退出
    sp.log.push({ t: w.t, kind, ok: true, code: wl.decision });
    if (sp.log.length > 40) sp.log.shift();
    return { ok: true, code: 'OK', decision: wl.decision, score: wl.score, reason: wl.reason };
  }
  // 同权：玩家与 AI 的这些动作都走 validate → actuate，规则层是唯一"能不能"的裁决者。
  // （旧实现只调 actuate，地点/材料门槛只作用于 AI，构造 POST 可在任意地点收种存取。）
  if (!['harvest', 'plant', 'gather', 'plan', 'build', 'repair', 'deposit', 'withdraw', 'forage', 'exchange', 'expand'].includes(kind)) return { ok: false, error: 'UNKNOWN_KIND' };
  const gate = validate(w, 'p1', { kind, type: body?.type });
  if (!gate.ok) {
    sp.log.push({ t: w.t, kind, ok: false, code: gate.code });
    if (sp.log.length > 40) sp.log.shift();
    return gate;
  }
  const r = actuate(w, 'p1', { kind, type: body?.type });
  if (r.ok) w.agents.p1?.viab?.spend(SURV_COST[kind]); // P0-2：与 AI execute 同表结算，成功才扣，不重复扣
  sp.log.push({ t: w.t, kind, ok: r.ok, code: r.code });
  if (sp.log.length > 40) sp.log.shift();
  return r;
}

// P0-B3：危机阶段的目标提示（服务端给出，前端只负责呈现）。
function crisisGoals(w) {
  const s = w.survival;
  if (!w.independentWorld || s.ended || !(s.failed || s.starveDays > 0 || s.wasCrisis)) return [];
  const goals = [];
  if ((s.store ?? 0) < 3) goals.push("先补食物：收获成熟菜畦 / 采浆果 / 兑换收成");
  if ((s.plots ?? []).some((p) => p.growth === 0)) goals.push("重新播种空菜畦，恢复每日产出");
  if ((s.buildings ?? []).some((b) => b.integrity < 1)) goals.push("修复受损的生产建筑");
  if (s.coop?.enabled) goals.push("在工地按「请居民协助」集合人手");
  if (s.stormTomorrow || s.coldsnapTomorrow) goals.push("下一场灾害将至：储备食物并加固住所");
  return goals.slice(0, 4);
}

export function survView(sp) {
  const w = sp.world; const s = w.survival; const mods = effectiveMods(w);
  const playerDead = Boolean(s.playerDead) || !isAlive(w.agents.p1);
  return {
    t: w.t, eventRulesVersion: w.eventRulesVersion, mapSeed: w.mapSeed, layoutVersion: w.layoutVersion, layout: w.campLayout, phase: survivalPhaseOf(w.t), weather: w.weather,
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
    agents: Object.fromEntries(Object.values(w.agents).map((a) => [a.id, { id: a.id, name: a.name, isPlayer: !!a.isPlayer, stage: residentStage(w, a.id), age: Math.floor(ageDays(w, a.id)), sex: w.sex?.[a.id] ?? null, act: a.isPlayer ? 'idle' : lastAct(a, w.t), energy: Number((a.drives?.v?.energy ?? 0).toFixed(2)), loc: w.loc[a.id] ?? null, viab: Number((a.viab?.v ?? 1).toFixed(2)), dead: !!a.dead, death: a.death ?? null, counters: a.counters ?? null }])),
    talk: s.talk ? { target: s.talk.target, engage: s.talk.engage, patienceMs: s.talk.patienceMs } : null,
    player: { energy: Number((w.agents.p1?.drives?.v?.energy ?? 0).toFixed(2)), viab: Number((w.agents.p1?.viab?.v ?? 1).toFixed(2)), dead: playerDead, timeLeft: w.independentWorld ? playerTimeLeft(w) : null,
      ...(w.independentWorld ? { result: playerDead ? 'dead' : s.playerMilestone ? 'milestone' : 'alive' } : {}) },
    ...(w.independentWorld ? { settlement: s.ended ? 'extinct' : (s.failed || s.starveDays > 0) ? 'crisis' : s.wasCrisis ? 'recovering' : 'active', crisisGoals: crisisGoals(w), crisisDays: s.starveDays ?? 0, nature: { evolving: true } } : {}),
    failed: s.failed, won: s.won, ended: !!s.ended, endReason: s.endReason ?? null, births: s.births ?? 0, deaths: (s.deaths ?? []).slice(-14), history: s.history.slice(-14),
    ...forecastDisasters(w),
    drought: !!s.drought, disasterToday: s.disasterToday,
    clearStreak: s.clearStreak ?? 0, coldStreak: s.coldStreak ?? 0,
    yieldTotal: s.yieldTotal ?? 0, harvestCount: s.harvestCount ?? 0,
    log: sp.log.slice(-12),
    produce: { ...(s.produce ?? {}) }, livestock: { ...(s.livestock ?? DEFAULT_LIVESTOCK) },
    wildBerries: s.wildBerries,
    eco: s.ecosystem ? { chickens: (s.ecoPop?.chickens ?? []).length, orchards: (s.ecoPop?.orchards ?? []).length, chickenCap: ECO.chickenCap, orchardCap: ECO.orchardCap } : null,
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
  const minds = Object.fromEntries(Object.values(w.agents).filter((a) => a.drives && a.viab).map((a) => [a.id, {
    m: a.bank.snapshot(), drives: { ...a.drives.v }, memory: a.memory.dump(),
    rel: [...a.relations.map.entries()], relCeiling: a.relations.ceiling,
    habit: a.habit.dump(), forwardModel: a.forwardModel.dump(), viab: a.viab.dump(),
    traits: structuredClone(a.traits),
    dead: !!a.dead, death: a.death ?? null, hurtBy: a.hurtBy ?? null, // P0-1：死亡事实入档
    rng: a.rng?.state?.() ?? null, setpoint: { ...a.drives.setpoint }, aloneTicks: a.drives.aloneTicks,
    bankPending: { ...a.bank.pending }, bankM5: a.bank.dumpM5?.() ?? null, counters: { ...a.counters }, dayTally: structuredClone(a.dayTally),
    m3Last: a.m3Last ? structuredClone(a.m3Last) : null, m3PrevGoal: a.m3PrevGoal ?? null,
    m3Planner: a.m3Planner?.dump?.() ?? null, coupling: a.coupling?.dump?.() ?? null,
    informedTick: a.informedTick ?? null, lpFast: a.lpFast ?? null, lpSlow: a.lpSlow ?? null, plasticGateNow: a.plasticGateNow ?? null,
  }]));
  return { t: w.t, seed: w.seed, eventRulesVersion: w.eventRulesVersion, mapSeed: w.mapSeed, layoutVersion: w.layoutVersion, loc: w.loc, occupancy: w.occupancy, locs: w.locs, outdoor: w.outdoor, stash: w.stash, expect: w.expect, pantry: w.pantry, riskyPortion: w.riskyPortion, weatherEnabled: w.weatherEnabled, secrets: (w.secrets ?? []).map((x) => ({ ...x, known: [...x.known] })), pending: structuredClone(w.pending ?? []), survival: w.survival, log: sp.log,
    sex: w.sex, pinv: w.pinv, minds, ...(w.survival.households ? { housing: w.housing } : {}) };
}
export function loadSurv(raw,seed=7,options) {
  const sp=createSurvPlay(Number.isSafeInteger(raw?.seed) ? raw.seed : seed,
    { ...options, eventRulesVersion: raw ? raw.eventRulesVersion ?? LEGACY_EVENT_RULES : options?.eventRulesVersion,
      mapSeed: Number.isSafeInteger(raw?.mapSeed) ? raw.mapSeed : 0, layoutVersion: raw?.layoutVersion === 1 ? 1 : 0 });
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
    sp.world.pending = structuredClone(raw.pending ?? []);
    if (raw.locs) sp.world.locs = { ...sp.world.locs, ...raw.locs };
    if (raw.outdoor) sp.world.outdoor = raw.outdoor.slice();
    if (raw.stash) sp.world.stash = { ...sp.world.stash, ...raw.stash };
    if (raw.expect) sp.world.expect = { ...sp.world.expect, ...raw.expect };
    if (Number.isFinite(raw.pantry)) sp.world.pantry = raw.pantry;
    if (Number.isFinite(raw.riskyPortion)) sp.world.riskyPortion = raw.riskyPortion;
    if (typeof raw.weatherEnabled === 'boolean') sp.world.weatherEnabled = raw.weatherEnabled;
    sp.world.secrets = (raw.secrets ?? []).map((x) => ({ ...x, known: new Set(x.known ?? []) }));
    // occupancy 是派生数据但顺序进感知/候选：dumpSurv 不存它，读档必须按 loc 重建，
    // 否则创建期的 spawn 占位与存档位置错位，下一次 move() 取 occupancy[from] 落空。
    sp.world.occupancy = {};
    for (const id of Object.keys(sp.world.agents)) {
      const l = sp.world.loc[id];
      if (l) (sp.world.occupancy[l] ??= []).push(id);
    }
    sp.world.survival = { ...sp.world.survival, ...raw.survival, coop: { ...sp.world.survival.coop, ...(raw.survival.coop ?? {}) } };
    if (w.independentWorld) {
      const s = w.survival;
      if (s.endReason === 'player') { s.playerDead = true; s.failed = false; }
      s.ended = false;
      s.endReason = null;
    }
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
      if (st.setpoint) Object.assign(a.drives.setpoint, st.setpoint);
      if (Number.isFinite(st.aloneTicks)) a.drives.aloneTicks = st.aloneTicks;
      if (st.bankPending) Object.assign(a.bank.pending, st.bankPending);
      if (st.bankM5 !== undefined && typeof a.bank.loadM5 === 'function') a.bank.loadM5(st.bankM5, st.m);
      if (st.counters) Object.assign(a.counters, st.counters);
      if (st.dayTally) a.dayTally = structuredClone(st.dayTally);
      if (st.m3Last !== undefined) a.m3Last = structuredClone(st.m3Last);
      if (st.m3PrevGoal !== undefined) a.m3PrevGoal = st.m3PrevGoal;
      if (st.m3Planner && typeof a.m3Planner?.load === 'function') a.m3Planner.load(st.m3Planner);
      if (st.coupling && typeof a.coupling?.restore === 'function') a.coupling.restore(st.coupling);
      if (st.informedTick !== undefined) a.informedTick = st.informedTick;
      if (Number.isFinite(st.lpFast)) a.lpFast = st.lpFast;
      if (Number.isFinite(st.lpSlow)) a.lpSlow = st.lpSlow;
      if (Number.isFinite(st.plasticGateNow)) a.plasticGateNow = st.plasticGateNow;
      if (typeof a.bank.restore === 'function') a.bank.restore(st.m);
      a.memory.load(Array.isArray(st.memory) ? { rows: st.memory } : st.memory);
      a.relations.map = new Map(st.rel ?? []);
      if (typeof st.relCeiling === 'number') a.relations.ceiling = st.relCeiling;
      a.habit.load(st.habit);
      a.forwardModel.load(st.forwardModel);
      a.viab.restore(st.viab);
      Object.assign(a.traits, st.traits ?? {});
      a.dead = !!st.dead; a.death = st.death ?? null; a.hurtBy = st.hurtBy ?? null; // P0-1：读档恢复死亡事实
      if (st.rng != null && typeof a.rng?.restore === 'function') a.rng.restore(st.rng); // C2：继续原随机序列
    }
    if (w.independentWorld) {
      const s = w.survival;
      s.ended = livingResidents(w).length === 0;
      s.endReason = s.ended ? 'extinct' : null;
      s.failed = !s.ended && s.starveDays >= SURV.starveDaysToFail;
    }
    // P0-1：死者读档后仍移出占位（与死亡时一致），不被感知/交谈/组队。
    for (const a of Object.values(sp.world.agents)) {
      if (a.dead) { const l = sp.world.loc[a.id]; if (l) sp.world.occupancy[l] = (sp.world.occupancy[l] ?? []).filter((x) => x !== a.id); }
    }
    // 历史 agentError 属于旧引擎的故障读数，不是世界事实；随档带回来会让面板永远显示旧红字。
    sp.log = (raw.log ?? []).filter((x) => x?.kind !== 'agentError');
    if (w.independentWorld) sp.log = sp.log.slice(-SURV_LOG_LIMIT);

    // C3：占位顺序会进入感知/候选（crowd[0]）；存档带 occupancy 且与 loc 一致就沿用原顺序。
    const expected = {};
    for (const [id, l] of Object.entries(sp.world.loc)) {
      const a = sp.world.agents[id];
      if (!l || a?.dead) continue;
      (expected[l] ??= []).push(id);
    }
    const rawOcc = raw.occupancy;
    let occOk = Boolean(rawOcc) && typeof rawOcc === 'object';
    if (occOk) {
      const keys = Object.keys(rawOcc).filter((k) => (rawOcc[k] ?? []).length);
      occOk = keys.length === Object.keys(expected).length;
      if (occOk) for (const k of keys) {
        const arr = rawOcc[k];
        if (!Array.isArray(arr) || arr.length !== (expected[k] ?? []).length || new Set(arr).size !== arr.length || !arr.every((x) => sp.world.loc[x] === k && !sp.world.agents[x]?.dead)) { occOk = false; break; }
      }
    }
    sp.world.occupancy = occOk
      ? Object.fromEntries(Object.entries(rawOcc).map(([k, arr]) => [k, Array.isArray(arr) ? arr.slice() : []]))
      : expected;
  }
  return sp;
}