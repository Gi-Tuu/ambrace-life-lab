import { campDistricts, districtHomes } from '../shared/camp-districts.mjs';
import { initWildExpansion, wildExpansionEnabled, wildPlotView } from '../shared/wild-plots.mjs';
// 生存单世界游玩层（Phase D / §14–15 P2）。居民＝完整 Organism（同权：玩家能做的 AI 都能做）。
// 服务端权威；前端只读 /world.survival；玩家动作走 /act {mode:'survival'}。
// additive：不改动 A/B pack、不改动 lab/town 基线；存档以独立键 survival 挂载（缺省 tolerant）。
// 2026-11-18 拆分：动作预算在 survplay-actions，营地动作入口在 survplay-camp，存档在 survplay-save。
import { makeWorld, spawn, move, scanSecrets, actuate, isAlive, livingResidents, PLAYER_UNITS_PER_TICK, advanceTravels } from './body.mjs';
import { GAME_PLAYER_UNITS_PER_TICK } from './space.mjs';
import { initPositions, placeActor, removeActor, travelOf, detachPlayerRoom } from './actor-pos.mjs';
import { residentTimeModel, advanceResidentBusy, residentCanChain, residentBusy, CHAIN_MAX } from './resident-time.mjs';
import { resLedgerView } from './resource-ledger.mjs';
import { facilityOf } from '../shared/camp-facility.mjs';
import { homeAccessView, homeEntry } from './home-access.mjs';
import { finishDiscussion, socialNetwork } from './settlement-social.mjs';
import { leaveTalk, talkInRange } from './dialogue.mjs';
import { speechLine } from './speech.mjs';
import { converseRound, converse } from './intent.mjs';
import { maybeResidentRequest, maybePeerRequest, stepPeerRequests } from './resident-requests.mjs';
import { residentInjury, settleResidentInjuries } from './resident-injury.mjs';
import { campTimberView } from './camp-play.mjs';
import { RESIDENT_HOMES, generateCampLayout } from '../shared/camp-layout.mjs';
import { weatherFor, dayOf, DAY_TICKS, survivalPhaseOf, seasonOf, SEASONS, SEASON_DAYS } from './clock.mjs';
import { effectiveMods, buildingsFor, initFoodStore, produceYield, DEFAULT_LIVESTOCK, PRODUCE_CAP, PRODUCE_KINDS, WILD_BERRIES, EXCHANGE, EXPAND, EXPAND_LABEL, PRODUCE_LABEL, LIVESTOCK_CAP } from './production.mjs';
import { finishCooperation } from './cooperation.mjs';
import { forecastDisasters } from './worldstate.mjs';
import { recordStormWarning } from './settlement-events.mjs';
import { constructionAccessEnabled, constructionDestination, recordConstructionBlock, residentConstructionAccess, roomDoorPoint } from './construction-access.mjs';
import { stepEcosystem, initEcoPop, ECO } from './ecology.mjs';
import { addStanding, restoreSources, sourceView } from './source-produce.mjs';
import { restoreFarmPlots } from './farmland.mjs';
import { Organism } from './agent.mjs';
import { stepRoomWalk } from './room-walk.mjs';
import { hashSeed, survivalRoll, LEGACY_EVENT_RULES, CURRENT_EVENT_RULES } from './rng.mjs';
import { legacyPerTickThink } from './research-policy.mjs';
import { ADULT_DAYS, ELDER_DAYS_GAME, ELDER_DAYS_PLAYER, INFANT_DAYS, elderDaysFor, RESIDENT_CAP, makeHouseholds, residentStage, ageDays, stepHouseholds, stepRelationships, birthHomeStatus, restoreHouseholds } from './households.mjs';
import { createActionDomain } from './survplay-actions.mjs';
import { createSaveDomain } from './survplay-save.mjs';
import { createSimClock, createTokenBucket, bindDerivedTick } from './sim-clock.mjs';
import { bodyClockEnabled, stepBodyMinute, stepBodyHour, ELDER_DECAY_PER_HOUR } from './body-clock.mjs';
import { ghostView } from './ghost.mjs';
import { reapDeaths, DEATHS_CAP, trimDeaths } from './death.mjs';

const SURV_TRACE_LIMIT = 2000;
import { workMotionView } from './work-motion.mjs';
const SURV_LOG_LIMIT = 200;

// P1b：正式游戏每条世界线有一个"已消费到哪一游戏分钟"的游标。
// 放在 WeakMap 里而不是世界对象上：研究态/旧档的 dumpSurv 形状与哈希逐位不变。
const simCursors = new WeakMap();
const MAX_SIM_STEP_MIN = Math.max(60, Number(process.env.SIM_MAX_STEP_MIN ?? 600));
export function simMinuteCursor(world) {
  if (!world?.simClock) return 0;
  let cursor = simCursors.get(world);
  if (cursor === undefined) {
    // 新世界从创建时的时钟接上；旧档在 loadSurv 里显式 reset 到存档分钟。
    cursor = Math.max(0, Math.floor(Number(world.simClock.nowMinutes?.() ?? 0)));
    simCursors.set(world, cursor);
  }
  // 测试/读档可能直接 setGameMinutes 并同步 w.t（没有经过 tick）；以 world.t 的整刻下界兜底，
  // 避免把"跳到第 10 刻"误当成 600 分钟欠账。
  const aligned = Math.max(cursor, Math.floor(Number(world.t ?? 0) * 60));
  if (aligned !== cursor) simCursors.set(world, aligned);
  return aligned;
}
export function resetSimMinuteCursor(world) {
  if (!world?.simClock) return 0;
  const minutes = Math.max(0, Math.floor(Number(world.simClock.nowMinutes?.() ?? 0) + 1e-9));
  simCursors.set(world, minutes);
  return minutes;
}
export async function awaitSurvivalThinks(sp) {
  const w = sp?.world;
  if (!w?.think) return;
  for (let guard = 0; guard < 10000; guard += 1) {
    const pending = Object.values(w.agents ?? {}).map((a) => a.simThinkPromise).filter(Boolean);
    const queued = w.think.queue?.length ?? 0;
    if (!pending.length && !queued) return;
    if (pending.length) await Promise.allSettled(pending);
    else await Promise.resolve();
  }
}

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

export function createSurvPlay(seed=7,{gameRules=false,residentialDecisions=false,deliberator=null,mapSeed=0,layoutVersion=0,ecosystem=false,unifiedCooperation=false,independentWorld=false,wildFood=false,autonomousGoals=false,farmLife=false,settlementLife=false,regionalWork=false,discussions=true,residentChannelMask=null,residentCondition='C2',eventRulesVersion=LEGACY_EVENT_RULES,playerRation=false,actTimeModel=null,lifecycle=null,simTime=false,simClock=null,minuteMetab=null,wildExpansion=false}={}) {
  const world = makeWorld({ preset: 'survival', seed, pantries: 0, coop: true });
  // P1 连续时钟只属于正式游戏（gameRules）且必须显式开启；研究态/旧参数路径不创建、不写字段。
  const continuous = simTime === true && gameRules === true;
  if (continuous) {
    world.simTime = true;
    world.simClock = simClock ?? createSimClock({ startMinutes: 0 });
    // P1：`world.t` 在正式世界是 floor(simClock.nowMinutes()/60) 的派生读法，
    // 不再是独立推进的计数器；写它等同于把时钟重锚到该刻（仅存档/夹具）。
    bindDerivedTick(world);
    resetSimMinuteCursor(world);
    // 1.1 第 2 项：正式游戏默认按游戏分钟积分身体（energy/viab/饥饿）；
    // M5_MINUTE_METAB=0 精确回退到旧“每刻一次”结算（对照/旧档/发布回退）。
    // 研究态没有 simClock ⇒ 不写这个字段，旧 dumpSurv 逐位不变。
    world.minuteMetab = minuteMetab === null || minuteMetab === undefined
      ? process.env.M5_MINUTE_METAB !== '0'
      : Boolean(minuteMetab);
  }
  if (eventRulesVersion !== LEGACY_EVENT_RULES && eventRulesVersion !== CURRENT_EVENT_RULES) {
    const error = new Error(`未知生存概率规则版本 ${eventRulesVersion}`);
    error.code = 'SURV_EVENT_VERSION';
    throw error;
  }
  world.eventRulesVersion = eventRulesVersion;
  world.unifiedCooperation = unifiedCooperation;
  world.independentWorld = independentWorld;
  world.gameRules = gameRules;
  if (gameRules) initFoodStore(world.survival);
  // RES-01（所有者 2026-11-16 拍板：玩家 100 日内饿死是事故，不是设计）：游戏态玩家同样吃日界配给。
  // 研究态不传这个开关 ⇒ `world.survival.playerRation` 恒假 ⇒ worldstate 的 `!a.isPlayer || …` 那条分支照旧，五份基线逐位不变。
  if (playerRation) world.survival.playerRation = true;
  world.autonomousGoals = autonomousGoals;
  if (wildFood) world.survival.wildBerries = { ...WILD_BERRIES };
  world.mapSeed = mapSeed;
  world.layoutVersion = layoutVersion;
  if ([1,2].includes(layoutVersion)) world.campLayout = generateCampLayout(mapSeed,layoutVersion);
  if (farmLife) world.survival.farmLife = true;
  if (settlementLife) {
    world.survival.settlementLife = true;
    world.discussionsEnabled = discussions;
    world.survival.discussions = {};
  }
  if (settlementLife && regionalWork) {
    world.districts=campDistricts(mapSeed,layoutVersion);
    if (residentialDecisions) world.peripheralHomes=districtHomes(world.districts);
    restoreDistricts(world);
  }
  // 1.2 A：荒野宅基地（未认领只是数据；认领后才出现 pad/道路/房屋）。门控在 shared/wild-plots.mjs。
  if (wildExpansion) initWildExpansion(world, { mapSeed, layoutVersion, gameRules, settlementLife, residentialDecisions });
  restoreFarmPlots(world);
  world.survivalDeliberator = deliberator;
  world.residentChannelMask = residentChannelMask;
  world.residentCondition = residentCondition;
  // §15 P2-B：初始 roster 保证两性在场（否则开局即"无异性对"终局）；其余性别确定哈希
  world.sex = { a1: 'M', a2: 'F', a3: sexOf(seed, 'a3'), p1: sexOf(seed, 'p1') };
  for (const [id, name, archetype] of ROSTER) {
    const a = new Organism({ id, name, archetype, seed: hashSeed(seed, `${id}:surv`), condition: residentCondition, deliberator, channelMask: residentChannelMask });
    world.agents[id] = a;
    spawn(world, id, 'home');
  }
  // P0-3：玩家与居民同一套存续/驱动（同权在"会死"这一层也成立）。
  // 决策环仍不跑玩家（isPlayer 跳过），但基础代谢、动作消耗、饥饿压力、进食回补全部一致。
  const p1 = new Organism({ id: 'p1', name: '你', archetype: '谨慎', seed: hashSeed(seed, 'p1:surv'), condition: 'C2', deliberator: null });
  p1.isPlayer = true;
  world.agents.p1 = p1;
  spawn(world, 'p1', 'hall');
  // §15.5 M3：生存无私藏；游戏态 AUD-07 把 expect 一起归零，研究/历史路径保留原值以维持基线。
  for (const id of Object.keys(world.stash ?? {})) { world.stash[id] = 0; if (world.gameRules) world.expect[id] = 0; }
  world.pinv = {}; // §15 P2-C 背包：每角色个人木石
  for (const id of Object.keys(world.agents)) world.pinv[id] = { wood: 0, stone: 0 };
  const s=world.survival;
  if (s.settlementLife) for (const a of Object.values(world.agents)) a.relations.history=[];
  world.housing=Object.fromEntries(Object.entries(RESIDENT_HOMES).map(([id,entry])=>[id,entry.room]));
  if (residentialDecisions) {
    world.locs = { ...world.locs };
    s.households = makeHouseholds(world.housing);
    restoreHouseholds(world);
    // P1-1：创始居民也入生命周期（开局即 fresh 成年，随世界时间衰老）；玩家不衰老（死亡走存续）。
    for (const [id] of ROSTER) s.households.residents[id] ??= { born: -ADULT_DAYS * DAY_TICKS, parents: [], stage: 'adult' };
    // V7.1：正式游戏里玩家也是会老的人。成年起点与居民相同（12 天），研究态不写。
    if (world.independentWorld) s.households.residents.p1 ??= { born: -ADULT_DAYS * DAY_TICKS, parents: [], stage: 'adult' };
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
  s.regionalWork = !!regionalWork; // 审计 DATA-01：规则要能随档写回，不能只留在 create 参数里
  if (s.ecosystem) initEcoPop(s);
  restoreSources(world);
  s.forageStats = { harvest: 0, plant: 0 };
  s.deaths = []; // P0-1：死亡事件史（id/name/t/day/cause），随存档持久化，可查询不删除
  s.farmerId = 'a1'; // §15.7 R1 角色化农夫（网格选定默认开）
  s.roleFarmer = false; // §15.7 网格：R1/R2' 均无效（aiH 不随角色升）⇒ 默认关、负结果留痕；机制代码保留待经济重设计
  s.allHunger = false;
  s.moveUrgency = true; // §16 选点（E4 饥饿需移动候选）
  s.workFeeds = false; // §16 选点：E1 off（E4 已足）
  s.storeHunger = true; // §16 选点：E4 on（公仓目标挂钩饥饿⇒AI 自足 idleWon 2/3）
  s.plantWater = 0.06; // §16 选点：E3 水循环再平衡
  // V7.2 阶段 B：个人时间模型只属于正式游戏（独立世界 + gameRules），研究态（gameRules:false）保持旧预算逐位不变。
  // 显式传入时以显式值为准（host 的 survivalOptions 会显式给 true/false）。
  if (continuous) s.actTimeModel = true;
  else if (actTimeModel ?? (independentWorld && gameRules)) s.actTimeModel = true;
  // P2c：正式游戏在这一刻起建立唯一位置 pos（spawn 发生在 actTimeModel 判定之前）。
  // 用固定槽位表，不在建世界/读档时构建每个房间的 roomSurface（那是玩家进入房间时才算的）。
  if (s.actTimeModel === true) initPositions(world);
  if (continuous) {
    // 决策机会与算力分离：到期节拍按游戏分钟，实际调用由真实毫秒令牌桶 + 硬并发上限约束。
    world.think = {
      everyMin: Math.max(1, Number(process.env.THINK_EVERY_MIN ?? 10)),
      maxConcurrent: Math.max(1, Math.min(2, Number(process.env.THINK_CONCURRENCY ?? 2))),
      queue: [],
      inFlight: 0,
      bucket: createTokenBucket({
        capacity: Math.max(1, Number(process.env.THINK_BUCKET ?? 6)),
        refillMs: Math.max(1, Number(process.env.THINK_REFILL_MS ?? 1000)),
      }),
    };
  }
  if (world.gameRules) {
    // C4：生命参数随档（旧档缺字段时走 households 里的当前默认，不写回、不突变）。
    s.lifecycle = {
      infantDays: INFANT_DAYS, adultDays: ADULT_DAYS, elderDays: ELDER_DAYS_GAME, elderDaysPlayer: ELDER_DAYS_PLAYER,
      ...(lifecycle ?? {}),
    };
  }
  if (world.gameRules) {
    s.actClock = {};
    for (const id of Object.keys(world.agents)) s.actClock[id] = { day: 0, usedMin: 0, busy: null };
  }
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
    if (w.loc[id] !== 'garden') move(w,id,'garden');
    if (wantH) { const r = actuate(w, id, { kind: 'harvest' }); if (r.ok) { s.forageStats.harvest += 1; budgetH -= 1; } }
    if (wantP) { const r = actuate(w, id, { kind: 'plant' }); if (r.ok) { s.forageStats.plant += 1; budgetP -= 1; } }
  }
}

// P0-1 统一收尸与 1.3 幽魂状态在 life/death.mjs（survplay 只做世界推进/视图，行数闸门 <900）。
export function settleSurvival(sp) {
  const w = sp.world;
  const recovered=settleResidentInjuries(w);
  let changed = reapDeaths(w, sp.log) || recovered;
  if (w.survival.settlementLife) {
    const room=w.campPlayerRoom;
    if (room?.startsWith('facility:') && !(facilityOf(w,room)?.integrity>0)) {
      // P2c：房间失效 = 从这扇门回到世界空间（不是把室内坐标当世界坐标）。
      const door = roomDoorPoint(w, room);
      w.survival.playerReachState = null;
      if (door) placeActor(w, 'p1', { x: door[0], z: door[1], space: 'world' }, { mirror: true });
      else detachPlayerRoom(w);
      changed=true;
    }
    for (const id of Object.keys(w.loc)) {
      if (!isAlive(w.agents[id]) || homeEntry(w,id,w.loc[id]).ok) continue;
      move(w,id,'hall');
      changed=true;
    }
  }
  const staleTalk = w.survival.talk && !talkInRange(w, w.survival.talk);
  if (staleTalk) w.survival.talk = null;
  if (w.independentWorld && sp.log.length > SURV_LOG_LIMIT) sp.log.splice(0, sp.log.length - SURV_LOG_LIMIT);
  return changed || Boolean(staleTalk);
}
// 拆分后的域：动作预算/存档 schema 各自一处，survplay 只做世界推进与视图。
const actionDomain = createActionDomain({ settleSurvival });
const { survAct, cancelPlayerBusy, advancePlayerBusy, playerTimeLeft, playerTimeMax } = actionDomain;
const saveDomain = createSaveDomain({ createSurvPlay, newChild, restoreDistricts, logLimit: SURV_LOG_LIMIT, resetSimCursor: resetSimMinuteCursor });
const { dumpSurv, loadSurv } = saveDomain;
export { survAct, cancelPlayerBusy, advancePlayerBusy, playerTimeLeft, playerTimeMax, DEATHS_CAP, trimDeaths, dumpSurv, loadSurv };
export { playerReach } from './survplay-camp.mjs';


// P1-1 老年额外代谢（每刻）：体能随衰老下降。分钟身体路径复用同一常量（body-clock 按 1/60 积分）。
const ELDER_DECAY = ELDER_DECAY_PER_HOUR;
// P1-1 生命周期推进（日界）：阶段跃迁事件（成年/老年）＋老年自然衰老死亡。
// 死亡概率随龄升、用确定哈希（无 Math.random）⇒ 可复现；置 viab=0 交 reapDeaths 统一收尸记录 cause='衰老'。
function stepLifecycle(w, log) {
  const s = w.survival;
  if (!s.households) return;
  const day = dayOf(w.t);
  for (const a of Object.values(w.agents)) {
    if (!isAlive(a)) continue;
    if (a.isPlayer && !w.independentWorld) continue; // 研究态保持原行为
    const rec = s.households.residents[a.id];
    if (!rec) continue;
    const stage = residentStage(w, a.id);
    if (rec.stage && rec.stage !== stage) {
      if (stage === 'adult') log.push({ t: w.t, kind: 'adult', ok: true, code: `${a.name}成年` });
      else if (stage === 'elder') log.push({ t: w.t, kind: 'elder', ok: true, code: `${a.name}步入老年` });
    }
    rec.stage = stage;
    if (stage === 'elder') {
      // 风险从**各自的老年门槛**起算，不是从固定 60 天起算：否则玩家门槛拉到 180 后，
      // 一越过 180 就落到 0.5 的封顶概率上——变成"活到 180 天当天暴毙"，而不是"之后逐渐走下坡"。
      const p = Math.min(0.5, 0.02 + (ageDays(w, a.id) - elderDaysFor(w, a.id)) * 0.01) *
        (w.populationExperiment?.elderHazardScale ?? 1);
      if (survivalRoll(w, 'elder-death', a.id, day) < p) { a.hurtBy = '衰老'; a.viab.v = 0; }
    }
  }
}

function restoreDistricts(world) {
  if (!world.districts) return;
  world.locs={...world.locs};
  world.survival.resStock??={};
  world.outdoor=[...new Set([...world.outdoor,...Object.keys(world.districts)])];
  for (const [loc,district] of Object.entries(world.districts)) {
    world.locs[loc]=district.label;
    world.survival.resStock[loc]??=district.capacity;
  }
}


// P1b：连续路径的世界推进。
// 每分钟只做"身体在时间轴上该发生的事"（玩家/居民 busy 完成、think 到期）；
// 天气/感知/日界/生态/配给/合作/关系等世界重结算只在跨 60 分边界跑一次，
// 避免把 60 次重结算塞进一刻（旧的 60 分保底已删除）。
export async function tickSurvPlay(sp, { now, onResidentAction, advanceMinutes, minutes } = {}) {
  const w = sp.world;
  if (!w.simClock) return tickLegacy(sp, { now, onResidentAction });
  return tickSim(sp, { now, onResidentAction, advanceMinutes, minutes });
}

async function tickLegacy(sp, { now, onResidentAction }) {
  const w = sp.world;
  w.t += 1;
  advancePlayerBusy(sp);
  // 研究态整刻语义（per-tick think）只在 research-policy 声明一次。
  return worldTick(sp, { now, onResidentAction, think: legacyPerTickThink() });
}

async function tickSim(sp, { now, onResidentAction, advanceMinutes, minutes }) {
  const w = sp.world, clock = w.simClock;
  // 目标分钟来自时钟 + 本次显式步长；不再先把时钟整段推到头，再逐分钟处理——
  // 否则 w.t 在整段循环里都是终点派生的刻，分钟边界/感知/日界会错位。
  const requested = Number.isFinite(minutes) ? minutes : Number.isFinite(advanceMinutes) ? advanceMinutes : 0;
  // 1.1：调用方给了 `now` 就按这个共享时刻求目标分钟。compare 的 A/B 用同一个 now，
  // 否则“A 先跑、B 后跑”的几毫秒差会在整分边界把同一拍拆成 M/M+1，两个受控世界就不同步了。
  // 没给 now（主世界自动拍/离线补时/研究态）仍按调用时刻换算，行为不变。
  const atMs = Number.isFinite(now) ? now : undefined;
  const targetMinute = Math.floor(clock.nowMinutes(atMs) + requested + 1e-6);
  const cursor = simMinuteCursor(w);
  if (targetMinute <= cursor) return w;
  const to = Math.min(targetMinute, cursor + MAX_SIM_STEP_MIN);
  const explicit = requested > 0;
  // 1.1：正式世界每个游戏分钟积分一次身体；M5_MINUTE_METAB=0 时走旧 think 结算。
  const minuteBody = bodyClockEnabled(w);
  let dispatched = false;
  for (let minute = cursor + 1; minute <= to; minute += 1) {
    clock.setGameMinutes(minute);
    advancePlayerBusy(sp, minute);
    // 位移按真实时间：居民旅行每游戏分钟推进（18 单位/分），到达按 arriveMin 判定。
    if (w.survival?.actTimeModel === true) advanceTravels(w, { minutes: 1 });
    if (minuteBody) {
      // 身体先于 think 落地：本分钟到期的 think 读到的是“已积分到本分钟”的快照。
      // 步内不消费世界 RNG（见 life/v11-metab.test.mjs 的 RNG 闸门）。
      const population = livingResidents(w).length;
      for (const id of Object.keys(w.agents)) {
        const a = w.agents[id];
        if (!a || !isAlive(a)) continue;
        if (a.isPlayer && !(w.independentWorld || (!w.survival.ended && !w.survival.failed))) continue;
        stepBodyMinute(w, a, { atMin: minute, population });
      }
      if (minute % 60 === 0) {
        // 社交需求/M4 耦合仍按“刻”标定：整点一步，不把 tau 改成分钟。
        const population = livingResidents(w).length;
        for (const id of Object.keys(w.agents)) {
          const a = w.agents[id];
          if (!a || !isAlive(a)) continue;
          if (a.isPlayer && !(w.independentWorld || (!w.survival.ended && !w.survival.failed))) continue;
          stepBodyHour(w, a, { population });
        }
      }
    }
    // 1.2 B：居民室内自由移动。只挪 w.pos（loc/占用/动作/需求都不动），每分钟一步。
    // 研究态没有 pos ⇒ 本调用是空操作；玩家不在室内走动的范围内。
    if (w.survival?.actTimeModel === true) stepRoomWalk(w, minute);
    // 只在跨 60 分边界跑一次世界重结算（天气/percepts/扫描/日界/生态/配给/关系等）。
    if (minute % 60 === 0) await worldTick(sp, { now, onResidentAction, think: false });
    if (residentMinutePass(w, sp, minute, { now, onResidentAction, explicit })) dispatched = true;
    if (dispatched) await Promise.resolve(); // 让本地替身的 think 在下一分钟前落地；慢模型不会被等
  }
  simCursors.set(w, to);
  return w;
}

// 每分钟：推进居民 busy（到 endMin 当分钟结算）、派发到期的 think（异步，有硬并发上限）。
function residentMinutePass(w, sp, atMin, { onResidentAction, explicit }) {
  let dispatched = false;
  for (const id of Object.keys(w.agents)) {
    const a = w.agents[id];
    if (!a || a.isPlayer || !isAlive(a)) continue;
    const travel = w.survival.districtTravel?.[id];
    // 连续世界的旅行在 advanceTravels 里每分钟推进、到 arriveMin 结算；在路上（travel 仍在）
    // 就不派发新决策。无 simClock 的旧路径语义等价（到点即清 travel）。
    if (travel) continue;
    if (w.survival.talk?.target === id) continue;
    const advanced = advanceResidentBusy(w, id, atMin);
    if (advanced.aborted) sp.log.push({ t: w.t, kind: 'residentAbort', ok: false, code: advanced.code });
    if (queueOrStartResidentThink(w, sp, a, atMin, { onResidentAction, explicit })) dispatched = true;
  }
  return dispatched;
}

function markThinkScheduled(w, a, atMin) {
  const think = w.think;
  a.nextThinkMin = (a.nextThinkMin === undefined ? atMin : Math.max(a.nextThinkMin, atMin)) + think.everyMin;
}

function queueOrStartResidentThink(w, sp, a, atMin, ctx) {
  const think = w.think;
  if (!think || a.simThinkPromise || a.simThinkPending) return false;
  if (a.nextThinkMin !== undefined && atMin + 1e-9 < a.nextThinkMin) return false;
  if (think.inFlight >= think.maxConcurrent) {
    // 硬并发上限：每个居民最多排一个 job，队列不会随分钟无限增长。
    if (think.queue.length >= Math.max(2, Object.keys(w.agents).length)) return false;
    markThinkScheduled(w, a, atMin);
    a.simThinkPending = true;
    think.queue.push({ sp, id: a.id, atMin, explicit: Boolean(ctx.explicit), onResidentAction: ctx.onResidentAction });
    return false;
  }
  const bypassBucket = ctx.explicit || w.simClock?.manual;
  if (!bypassBucket && !think.bucket.take()) return false;
  markThinkScheduled(w, a, atMin);
  startResidentThink(w, sp, a, atMin, ctx);
  return true;
}

function startResidentThink(w, sp, a, atMin, ctx) {
  const think = w.think;
  think.inFlight += 1;
  a.simThinkPending = false;
  const traceStart = a.trace.length;
  let promise;
  try {
    // 调用本身同步跑到第一个 await（感知/代谢同步段），之后模型等待不阻塞世界分钟。
    promise = a.tick(w);
  } catch (error) {
    think.inFlight = Math.max(0, think.inFlight - 1);
    noteThinkError(w, sp, error);
    return;
  }
  // 本地替身是同步结算的：立刻收尾，别让决策欠微任务——分钟循环一次只还一个微任务，
  // 批量推进时会把 10 分 think 节拍拖成 ~38 分（1.1 正式钟灭绝的直接原因）。
  if (!promise || typeof promise.then !== 'function') {
    try { afterResidentThink(w, sp, a, traceStart, ctx); }
    catch (error) { noteThinkError(w, sp, error); }
    think.inFlight = Math.max(0, think.inFlight - 1);
    drainThinkQueue(w, sp);
    return;
  }
  a.simThinkPromise = Promise.resolve(promise)
    .then(() => afterResidentThink(w, sp, a, traceStart, ctx))
    .catch((error) => noteThinkError(w, sp, error))
    .finally(() => {
      a.simThinkPromise = null;
      think.inFlight = Math.max(0, think.inFlight - 1);
      drainThinkQueue(w, sp);
    });
}

function noteThinkError(w, sp, error) {
  w.survival.agentErrors = (w.survival.agentErrors ?? 0) + 1;
  sp.log.push({ t: w.t, kind: 'agentError', ok: false, code: String(error?.message ?? error).slice(0, 80) });
}

function afterResidentThink(w, sp, a, traceStart, { onResidentAction } = {}) {
  // S2 say：模型写的那句话，动作执行后由规则层投递（与旧 tick 同口径，完成时点可落在任意分钟）。
  if (w.gameRules && a.pendingSay) {
    const say = a.pendingSay;
    delete a.pendingSay;
    const here = w.loc[a.id];
    const other = (w.occupancy[here] ?? []).find((id) => id !== a.id && w.agents[id] && !w.agents[id].dead);
    if (other) {
      const r = converse(w, a.id, other, { act: say.act, topic: say.topic, say: say.text, served: 'node' });
      if (!r.ok) { w.survival.sayRejects = (w.survival.sayRejects ?? 0) + 1; w.survival.lastSayCode = r.code; }
    } else { w.survival.sayRejects = (w.survival.sayRejects ?? 0) + 1; w.survival.lastSayCode = 'NO_COMPANY'; }
  }
  if (onResidentAction) onResidentAction(a, a.trace.slice(traceStart));
  if (w.independentWorld && a.trace.length > SURV_TRACE_LIMIT) a.trace.splice(0, a.trace.length - SURV_TRACE_LIMIT);
  if (w.independentWorld) settleSurvival(sp);
}

function drainThinkQueue(w, sp) {
  const think = w.think;
  if (!think?.queue?.length) return;
  while (think.inFlight < think.maxConcurrent && think.queue.length) {
    const job = think.queue.shift();
    const a = w.agents[job.id];
    if (!a || !isAlive(a) || a.simThinkPromise) { if (a) a.simThinkPending = false; continue; }
    const nowMin = Math.floor(w.simClock.nowMinutes() + 1e-6);
    const atMin = job.explicit ? job.atMin : Math.max(job.atMin, nowMin);
    startResidentThink(w, job.sp ?? sp, a, atMin, job);
  }
}

async function worldTick(sp, { now, onResidentAction, think }) {
  const w = sp.world;
  // P2c：无 simClock 的正式夹具每整刻推进旅行（连续世界已在 tickSim 按分钟推进）；研究态不调用。
  if (w.survival?.actTimeModel === true && !w.simClock) advanceTravels(w);
  w.weather = weatherFor(w.seed ?? 7, dayOf(w.t));
  // P1：正式连续世界不再"每 60 分整清"感知——事件按 seq 由每个居民的 think 消费一次；
  // 这里只做容量上限。研究态保持旧的每刻清空，dump/轨迹逐位不变。
  if (w.simClock) {
    if ((w.percepts?.length ?? 0) > 200) w.percepts = w.percepts.slice(-200);
  } else {
    w.percepts = [];
  }
  w.pending = (w.pending ?? []).filter((x) => x.for !== 'p1');
  scanSecrets(w);           // 内含 advanceSurvival(日界) + stepCooperation(coop 开)
  if (w.gameRules && forecastDisasters(w).stormTomorrow) recordStormWarning(w, dayOf(w.t) + 1);
  if (!w.unifiedCooperation && w.survival.forage && dayOf(w.t) !== dayOf(w.t - 1)) forageRound(w);
  if (dayOf(w.t) !== dayOf(w.t - 1)) {
    if (w.survival.households && (w.independentWorld || !w.survival.ended && !w.survival.failed)) stepHouseholds(w, sp.log);
    if (w.survival.households && (w.independentWorld || !w.survival.ended && !w.survival.failed)) stepLifecycle(w, sp.log); // P1-1 阶段跃迁＋衰老
    reproduce(w, sp.log); // §15 P2-B 繁衍（日界）；P1-3 人口上限＋出生事件
    // 蓄养/果树日界结算：规则层算增量，写独立产出账，不碰 store/inv。
    w.survival.produce ??= Object.fromEntries(PRODUCE_KINDS.map((k) => [k, 0]));
    let daily, eligible;
    if (w.survival.ecosystem) {
      // P1-4/5/6：动态生态——果树/鸡种群按健康×季节产果/蛋（鸡先吃植物性产出再吃公仓）；牛/羊仍静态。
      const ecoYield = stepEcosystem(w, sp.log);
      daily = produceYield(seasonOf(dayOf(w.t)), { ...w.survival.livestock, chickens: 0, orchards: 0 });
      daily.egg = ecoYield.egg; daily.fruit = ecoYield.fruit;
      eligible = ecoYield.eligible;
      restoreSources(w);
    } else {
      daily = produceYield(seasonOf(dayOf(w.t)), w.survival.livestock ?? DEFAULT_LIVESTOCK);
    }
    const scale = w.ecologyExperiment?.fixedLivestockYieldScale;
    if (scale !== undefined && scale !== 1) {
      const carry = w.survival.fixedLivestockCarry ??= { milk: 0, wool: 0 };
      for (const k of ['milk', 'wool']) {
        const total = daily[k] * scale + carry[k];
        daily[k] = Math.floor(total);
        carry[k] = total - daily[k];
      }
    }
    for (const [k, v] of Object.entries(daily)) {
      const accepted = addStanding(w, k, v, PRODUCE_CAP * 4, eligible?.[k]);
      w.observeProduction?.('gross', k, v);
      w.observeProduction?.('stock', k, accepted);
    }
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
  // 1.1：正式分钟身体路径下，这里不再做“每 60 分一次”的身体结算（已由 tickSim 逐分钟积分）；
  // 旅行/交谈/老年/角色化饥饿/公仓饥饿的旧侧效应由 body-clock 的分钟步与整点步承担。
  const minuteBody = bodyClockEnabled(w);
  if (!minuteBody) {
    // V7.3.3：每刻执行前登记当前在世集合（新生/动态加入不等到下一次 prepare）。
    // 同权：居民走完整决策环（survival affordances 已含全部玩家动作）
    for (const id of Object.keys(w.agents)) {
      const a = w.agents[id];
      if (a.isPlayer) continue;
      if (!isAlive(a)) continue; // P0-1：死者不再参与任何自主决策与行动
      const travel=travelOf(w,id);
      if (travel) {
        if (w.t<travel.arrive && Object.hasOwn(w.locs,travel.to)) {
          a.drives.tick(1,false);
          a.viab.tick(1);
          a.metabCount = (a.metabCount ?? 0) + 1;
          continue;
        }
        // 正式游戏：有路径的旅行已由 advanceTravels 结算；还在路上就不进入决策。
        if (w.survival?.actTimeModel === true && Array.isArray(travel.path) && w.t < travel.arrive) continue;
        if (w.survival?.actTimeModel !== true) {
          delete w.survival.districtTravel[id];
          const site = constructionDestination(w,travel.to);
          const access = site && residentConstructionAccess(w,id,site);
          if (access && !access.ok) recordConstructionBlock(w,id,travel.to,'move_to',access.code);
          else if (Object.hasOwn(w.locs,travel.to) && homeEntry(w,id,travel.to).ok) {
            move(w,id,travel.to);
            if (access?.destination && w.residentTravel[id]) w.residentTravel[id].at = access.destination;
          }
        }
      }
      // 交谈中只跑基础代谢，不做自主决策：否则居民会边聊边走去干活，把对话打断。
      if (w.survival.talk?.target === id) {
        try { a.drives.tick(1, false); a.viab.tick(1); a.metabCount = (a.metabCount ?? 0) + 1; } catch { /* 对话优先 */ }
        continue;
      }
      if (!think) {
        // 连续路径：忙碌/思考已在分钟调度里处理；这里只保留"每 60 分一次"的身体副作用。
        if (w.survival.households && residentStage(w, id) === 'elder') a.viab.v = Math.max(0, a.viab.v - ELDER_DECAY);
        if (w.survival.roleFarmer && id === w.survival.farmerId) a.drives.tick(3, false);
        else if (w.survival.allHunger) a.drives.tick(1, false);
        if (w.survival.storeHunger === true) {
          const popH = livingResidents(w).length;
          const mult = 1 + (w.survival.hungerK ?? 1) * Math.max(0, 1 - w.survival.store / (popH * 3));
          if (mult > 1) a.drives.tick(mult - 1, false);
        }
        continue;
      }
      const traceStart = onResidentAction ? a.trace.length : 0;
      // V7.2：进行中的动作推进（旧路径按刻）。
      if (residentTimeModel(w)) {
        const adv = advanceResidentBusy(w, id);
        if (adv.aborted) sp.log.push({ t: w.t, kind: 'residentAbort', ok: false, code: adv.code });
      }
      try { await a.tick(w); } catch (e) { w.survival.agentErrors = (w.survival.agentErrors ?? 0) + 1; sp.log.push({ t: w.t, kind: 'agentError', ok: false, code: String(e?.message ?? e).slice(0, 80) }); }
      // 旧路径：同一刻在预算内还可以再决策几次（硬上限 CHAIN_MAX）。
      // 正式连续世界不存在"同一拍最多 N 次"：决策机会由 ThinkScheduler 按游戏分钟发放。
      if (!w.simClock && residentTimeModel(w) && a.lastMetabTick === w.t) {
        const last = a.trace.findLast((row) => row.t === w.t && row.kind && row.ok !== false);
        const sameKind = last?.kind && !['move_to', 'look_out', 'talk'].includes(last.kind) && !last.kind.startsWith('discuss_') ? last.kind : null;
        for (let extra = 0; sameKind && extra < CHAIN_MAX; extra += 1) {
          if (!residentCanChain(w, id) || residentBusy(w, id)) break;
          const before = a.counters.actions ?? 0;
          try { await a.decideOn(w, { metab: a.lastMetab, reason: null, told: false, silent: true, sameKind }); } catch { break; }
          if ((a.counters.actions ?? 0) === before) break;
        }
      }
      // S2 say：模型写的那句话，动作执行后由规则层投递（词表/上限/关系后果都在 converse 里）。
      if (w.gameRules && a.pendingSay) {
        const say = a.pendingSay;
        delete a.pendingSay;
        const here = w.loc[a.id];
        const other = (w.occupancy[here] ?? []).find((id) => id !== a.id && w.agents[id] && !w.agents[id].dead);
        if (other) {
          const r = converse(w, a.id, other, { act: say.act, topic: say.topic, say: say.text, served: 'node' });
          if (!r.ok) { w.survival.sayRejects = (w.survival.sayRejects ?? 0) + 1; w.survival.lastSayCode = r.code; }
        } else { w.survival.sayRejects = (w.survival.sayRejects ?? 0) + 1; w.survival.lastSayCode = 'NO_COMPANY'; }
      }
      if (onResidentAction) onResidentAction(a, a.trace.slice(traceStart));
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
    }
  }
  // S2：每刻至多一次遭遇对话（只在游戏态）。规则层先裁决，模型只负责"怎么说"。
  try { converseRound(w); } catch (e) { w.survival.intentErrors = (w.survival.intentErrors ?? 0) + 1; }
  // SOC-01：居民也会主动开口——每刻至多一条请求，等玩家接受/拒绝。
  try { maybeResidentRequest(w); maybePeerRequest(w); stepPeerRequests(w); } catch (e) { w.survival.intentErrors = (w.survival.intentErrors ?? 0) + 1; }
  // V7.1：老年额外代谢对玩家同规则（居民在主循环里处理；分钟身体路径在 body-clock 里处理）。
  if (!minuteBody && w.independentWorld && w.survival.households && w.agents.p1 && isAlive(w.agents.p1) && residentStage(w, 'p1') === 'elder') {
    w.agents.p1.viab.v = Math.max(0, w.agents.p1.viab.v - ELDER_DECAY);
  }
  if (w.unifiedCooperation && w.survival.coop.enabled) finishCooperation(w);
  if (w.survival.settlementLife) finishDiscussion(w,sp.log);
  // 打字太久：居民主动走开（不等你点发送才判）。
  const talk = w.survival.talk;
  if (talk && (now ?? Date.now()) - talk.openAt > talk.patienceMs) {
    const gone = leaveTalk(sp);
    if (gone) sp.log.push({ t: w.t, kind: 'talk_left', ok: true, code: gone.line });
  }
  // P0-3：玩家只跑"需求/存续"这两条，不跑决策环。基础代谢与居民同参数；
  // 存续归零 ⇒ 玩家死亡，终局（与"聚落饿垮"分开显示）。动作消耗由 actuate 统一扣。
  // 1.1 P1-1：分钟身体路径已经给 p1 跑了 60 个 stepBodyMinute（每个 1/60 刻）；
  // 这里再 tick(1) 就是第 61 次结算（实测 -0.024/游戏小时，居民 -0.012）。与 699 行老年衰减同门。
  const pl = w.agents.p1;
  if (!minuteBody && pl?.drives && isAlive(pl) && (w.independentWorld || !w.survival.ended && !w.survival.failed)) {
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
    archetype, seed: hashSeed(seed, `${id}:surv`), condition: w.residentCondition, deliberator: w.survivalDeliberator, channelMask: w.residentChannelMask });
}
function reproduce(w, log) {
  const s = w.survival;
  const day = dayOf(w.t);
  const experiment = w.populationExperiment;
  const report = (reason, detail={}) => w.observeBirth?.({day,reason,...detail});
  if (s.ended || (s.failed && !w.independentWorld)) { report('ended'); return; }
  const interval = experiment?.birthInterval ?? 10;
  const multipleBirths = experiment?.pairCooldown && experiment.multipleBirths !== false;
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
    const currentPop = livingResidents(w).length;
    if (currentPop >= (experiment?.residentCap ?? RESIDENT_CAP)) { report('population', { pair: key }); break; }
    if (s.store < currentPop * 2) { report('food', { pair: key }); break; }
    const n = (s.births ?? 0) + 1;
    const id = `c${n}`;
    const child = newChild(w, id, [a, b]);
    if (s.settlementLife) child.relations.history=[];
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
    report('born',{id,parents:[a.id,b.id],sex:w.sex[id],home:room,archetype:child.traits.archetype});
    born = true;
    log?.push({ t: w.t, kind: 'birth', ok: true, code: `${child.name}出生（${a.name}×${b.name}）` });
    if (!multipleBirths) return;
  }
  if (!born) report('noPair',{rejected});
}

export { PLAYER_TIME } from './camp-catalog.mjs';




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

// 台词只取本刻已经成功执行的自主交谈。读快照不推进世界，也不调用模型。
function currentSpeech(w) {
  const speech = {};
  for (const a of livingResidents(w)) {
    const trace = a.trace ?? [];
    let act;
    for (let i = trace.length - 1; i >= 0 && trace[i].t === w.t; i--) {
      if (trace[i].ok && trace[i].kind === 'talk') { act = trace[i]; break; }
    }
    if (act && isAlive(w.agents[act.target]) && w.loc[a.id] === w.loc[act.target]) {
      speech[a.id] = speechLine(a, { world: w, kind: act.kind, actionId: act.action, t: act.t });
    }
  }
  return speech;
}

export function survView(sp) {
  const w = sp.world; const s = w.survival; const mods = effectiveMods(w);
  const playerDead = Boolean(s.playerDead) || !isAlive(w.agents.p1);
  // 1.3：幽魂观察（正式世界）。只读投影给客户端镜头/HUD，不参与裁决；研究/对照态不下发。
  const ghost = ghostView(w);
  return {
    workMotions: workMotionView(w),
    t: w.t, dayTicks:DAY_TICKS, playerUnitsPerTick: s.actTimeModel === true ? GAME_PLAYER_UNITS_PER_TICK : PLAYER_UNITS_PER_TICK, regionHarvest:s.regionHarvest??{}, eventRulesVersion: w.eventRulesVersion, mapSeed: w.mapSeed, layoutVersion: w.layoutVersion, layout: w.campLayout, phase: survivalPhaseOf(w.t), weather: w.weather,
    // P1：连续时钟只读视图。research/旧路径没有 simClock ⇒ 不出现这两个字段。
    ...(w.simClock ? { timeMode: 'continuous', serverNow: Date.now(), gameMinutes: Number(w.simClock.nowMinutes().toFixed(3)), clock: w.simClock.state(), minuteMetab: w.minuteMetab !== false } : {}),
    season: SEASONS[seasonOf(dayOf(w.t))], dayInSeason: (dayOf(w.t) % SEASON_DAYS) + 1,
    day: dayOf(w.t), targetDays: SURV_TARGET,
    rooms:{...w.locs,...housingLabels(w)}, outdoor:w.outdoor,
    ...(w.districts && {districts:w.districts,peripheralHomes:w.peripheralHomes,districtTravel:s.districtTravel??{},resStock:s.resStock,playerPos:s.playerPos??null}),
    // 1.2 A：荒野宅基地只随正式游戏出现；未认领地块零几何，只给客户端候选/认领态（路只给已认领）。
    ...(!w.districts && wildExpansionEnabled(w) && {peripheralHomes:w.peripheralHomes??{},playerPos:s.playerPos??null}),
    ...(wildExpansionEnabled(w) && {wildPlots:wildPlotView(w)}),
    loc: w.loc, occupancy: w.occupancy,
    ...(constructionAccessEnabled(w) && { constructionArrivals: Object.fromEntries(Object.entries(w.residentTravel??{})
      .filter(([id,row])=>row.at && row.to===w.loc[id]).map(([id,row])=>[id,row.at])) }),
    store: s.store, storeCap: mods.storeCap, food: s.food ?? null, requests: (s.requests ?? []).slice(0, 4), requestsGranted: s.requestsGranted ?? 0, converse: (s.converseLog ?? []).slice(-12), intents: s.intents ?? 0, fuel: (s.inv?.wood ?? 0), light: w.gameRules ? (s.inv?.wood ?? 0) > 0 : null, water: Number(s.water.toFixed(2)), soil: Number(s.soil.toFixed(2)),
    farmLife: Boolean(s.farmLife),
    plots: s.plots.map((p) => ({ id: p.id, bed: p.bed, growth: p.growth >= 1 ? 1 : Math.min(.99, Number(p.growth.toFixed(2))), moisture: p.moisture ?? 0 })),
    inv: s.inv, pinv: w.pinv ?? {}, sites: s.sites, buildings: s.buildings,
    camp:{containers:s.campContainers??{},mealsEaten:s.mealsEaten??0,timber:campTimberView(w)},
    housing: w.housing, homeRoads:s.homeRoads??{}, wildTrust:s.wildTrust??{}, settlementLife: Boolean(s.settlementLife), homeAccess: homeAccessView(w,'p1'), campPlayerRoom:w.campPlayerRoom??null, social: socialNetwork(w),
    households: s.households ? { ...s.households, adultDays: ADULT_DAYS } : null,
    coop: { enabled: s.coop.enabled, task: s.coop.task, completions: s.coop.completions.slice(-10), refusals: s.coop.refusals, replans: s.coop.replans, exits: s.coop.exits ?? 0 },
    agents: Object.fromEntries(Object.values(w.agents).map((a) => [a.id, { id: a.id, name: a.name, isPlayer: !!a.isPlayer, stage: residentStage(w, a.id), age: Math.floor(ageDays(w, a.id)), sex: w.sex?.[a.id] ?? null, injury: residentInjury(w,a), act: a.isPlayer ? 'idle' : lastAct(a, w.t), energy: Number((a.drives?.v?.energy ?? 0).toFixed(2)), loc: w.loc[a.id] ?? null, viab: Number((a.viab?.v ?? 1).toFixed(2)), dead: !!a.dead, death: a.death ?? null, counters: a.counters ?? null, ...(w.pos?.[a.id] ? { pos: w.pos[a.id] } : {}) }])),
    speech: currentSpeech(w),
    talk: s.talk ? { target: s.talk.target, engage: s.talk.engage, patienceMs: s.talk.patienceMs } : null,
    player: { energy: Number((w.agents.p1?.drives?.v?.energy ?? 0).toFixed(2)), viab: Number((w.agents.p1?.viab?.v ?? 1).toFixed(2)), dead: playerDead, stage: residentStage(w, 'p1'), age: Math.floor(ageDays(w, 'p1')), timeLeft: w.independentWorld ? playerTimeLeft(w) : null, timeMax: w.independentWorld ? playerTimeMax(w) : null,
      ...(w.independentWorld ? {
        result: playerDead ? 'dead' : s.playerMilestone ? 'milestone' : 'alive',
        // 1.3：死亡后不再有“行动/体力”入口；客户端据 ghost.observing 切「幽魂观察」。
        ghost: ghost.active,
        observing: ghost.observing,
        // V7.3 第三批：把进行中的 busy 暴露给 UI，供「取消」按钮显示；研究态不输出。
        busy: (() => { const b = w.survival?.actClock?.p1?.busy; return b ? { id: b.id, kind: b.kind, remainMin: Number((b.remainMin ?? 0).toFixed(1)), totalMin: b.totalMin, ...(Number.isFinite(b.endMin) ? { startMin: b.startMin, endMin: b.endMin } : {}) } : null; })(),
      } : {}) },
    ...(w.independentWorld ? { settlement: s.ended ? 'extinct' : (s.failed || s.starveDays > 0) ? 'crisis' : s.wasCrisis ? 'recovering' : 'active', ghost, crisisGoals: crisisGoals(w), crisisDays: s.starveDays ?? 0, nature: { evolving: true } } : {}),
    ...(w.gameRules ? { resources: resLedgerView(w) } : {}),
    failed: s.failed, won: s.won, ended: !!s.ended, endReason: s.endReason ?? null, births: s.births ?? 0, deaths: (s.deaths ?? []).slice(-14), history: s.history.slice(-14),
    ...forecastDisasters(w),
    drought: !!s.drought, disasterToday: s.disasterToday,
    chickenMeal: s.lastChickenMeal ?? null,
    clearStreak: s.clearStreak ?? 0, coldStreak: s.coldStreak ?? 0,
    yieldTotal: s.yieldTotal ?? 0, harvestCount: s.harvestCount ?? 0,
    log: sp.log.slice(-12),
    ...(w.gameRules && { settlementEvents: s.eventJournal?.rows.slice() ?? [] }),
    produce: { ...(s.produce ?? {}) }, livestock: { ...(s.livestock ?? DEFAULT_LIVESTOCK) },
    wildBerries: s.wildBerries, berryPatches: s.berryPatches, ecoSources: sourceView(w),
    eco: s.ecosystem ? { chickens: (s.ecoPop?.chickens ?? []).length, orchards: (s.ecoPop?.orchards ?? []).length, chickenCap: ECO.chickenCap, orchardCap: ECO.orchardCap } : null,
    produceCap: s.produceCap ?? PRODUCE_CAP, forageCd: s.forageCd ?? 0,
    economy: { exchange: EXCHANGE, expand: EXPAND, expandLabel: EXPAND_LABEL, produceLabel: PRODUCE_LABEL, cap: LIVESTOCK_CAP },
    buildingsDef: buildingsFor(w),
  };
}

const SURV_TARGET = 10; // 无尽模式落地前的里程碑显示；P2-B 终局语义替换
// DATA5-13：deaths 随 survival 整块入档，长期运行必须封顶；总死亡数单独累计。
