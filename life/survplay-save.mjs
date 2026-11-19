// 生存存档 schema：dump/load 与旧档宽容迁移。
// createSurvPlay/newChild/restoreDistricts 由 survplay 注入，避免 save 与主模块循环依赖。
import { isAlive, livingResidents } from './body.mjs';
import { weatherFor, dayOf, DAY_TICKS } from './clock.mjs';
import { buildLot, initFoodStore, FOOD_KINDS, addFood, takeFood } from './production.mjs';
import { restoreSettlementEvents } from './settlement-events.mjs';
import { restoreFarmPlots } from './farmland.mjs';
import { restoreSources } from './source-produce.mjs';
import { ADULT_DAYS, restoreHouseholds, settleMarriages, settleHousing } from './households.mjs';
import { facilityOf } from '../shared/camp-facility.mjs';
import { homeEntry } from './home-access.mjs';
import { SURV } from './worldstate.mjs';
import { LEGACY_EVENT_RULES } from './rng.mjs';

export function createSaveDomain({ createSurvPlay, newChild, restoreDistricts, logLimit = 200, resetSimCursor = null }) {
  const SURV_LOG_LIMIT = logLimit;
const DEATHS_CAP = 200;
function trimDeaths(deaths, cap = DEATHS_CAP) {
  if (!Array.isArray(deaths)) return deaths;
  if (deaths.length > cap) deaths.splice(0, deaths.length - cap);
  return deaths;
}

// 持久化（additive）：只 dump 生存世界事实，读回时 tolerant。
function dumpSurv(sp) {
  const w = sp.world;
  // §15 P2-C 心智入档：居民内部状态活过重启（镜像 host serialize 的心智字段）
  const minds = Object.fromEntries(Object.values(w.agents).filter((a) => a.drives && a.viab).map((a) => [a.id, {
    m: a.bank.snapshot(), drives: { ...a.drives.v }, memory: a.memory.dump(),
    rel: [...a.relations.map.entries()], ...(a.relations.history?{relHistory:a.relations.history}:{}), relCeiling: a.relations.ceiling,
    habit: a.habit.dump(), forwardModel: a.forwardModel.dump(), viab: a.viab.dump(),
    traits: structuredClone(a.traits),
    dead: !!a.dead, death: a.death ?? null, hurtBy: a.hurtBy ?? null, // P0-1：死亡事实入档
    rng: a.rng?.state?.() ?? null, setpoint: { ...a.drives.setpoint }, aloneTicks: a.drives.aloneTicks,
    bankPending: { ...a.bank.pending }, bankM5: a.bank.dumpM5?.() ?? null, counters: { ...a.counters }, dayTally: structuredClone(a.dayTally),
    m3Last: a.m3Last ? structuredClone(a.m3Last) : null, m3PrevGoal: a.m3PrevGoal ?? null,
    m3Planner: a.m3Planner?.dump?.() ?? null, coupling: a.coupling?.dump?.() ?? null, mealDay: a.mealDay ?? null,
    informedTick: a.informedTick ?? null, lpFast: a.lpFast ?? null, lpSlow: a.lpSlow ?? null, plasticGateNow: a.plasticGateNow ?? null,
  }]));
  // SAV-02：规则开关随档走。否则换个 env 读同一份档就会静默改世界规则。
  const rules = { independentWorld: !!w.independentWorld, gameRules: !!w.gameRules, unifiedCooperation: !!w.unifiedCooperation, autonomousGoals: !!w.autonomousGoals, regionalWork: !!w.survival.regionalWork, settlementLife: !!w.survival.settlementLife, farmLife: !!w.survival.farmLife, ecosystem: !!w.survival.ecosystem, playerRation: !!w.survival.playerRation };
  return { t: w.t, rules, campPlayerRoom:w.campPlayerRoom, seed: w.seed, eventRulesVersion: w.eventRulesVersion, mapSeed: w.mapSeed, layoutVersion: w.layoutVersion, ...(w.districts && {regionalWork:true}), loc: w.loc, occupancy: w.occupancy, locs: w.locs, residentTravel: w.residentTravel, outdoor: w.outdoor, stash: w.stash, expect: w.expect, pantry: w.pantry, riskyPortion: w.riskyPortion, weatherEnabled: w.weatherEnabled, secrets: (w.secrets ?? []).map((x) => ({ ...x, known: [...x.known] })), pending: structuredClone(w.pending ?? []), survival: w.survival, log: sp.log,
    // P1：连续时钟只随正式游戏入档；研究态没有 simClock ⇒ 哈希逐位不变。
    ...(w.simClock ? { clock: { rate: w.simClock.rate, msPerGameMinute: w.simClock.msPerGameMinute, gameMinutes: w.simClock.nowMinutes(), t: w.t } } : {}),
    sex: w.sex, pinv: w.pinv, minds, ...(w.survival.households ? { housing: w.housing } : {}),
    // V7.3.2：fair 调度的欠账/上次机会随档走，重启后不重置轮转（仅正式游戏）。
 };
}
function loadSurv(raw,seed=7,options) {
  // DATA5-09：settlementLife 的旧档迁移。旧档可能在 7 小时窗口里把 rules/survival 都写成 false，
  // 但 top-level regionalWork=true 或 survival.settlementLife=true 证明分城区曾经存在。
  // 这类“证据优先”的显式 OR 不能让 false 永久吞掉 districts/peripheralHomes。
  const adopt = options?.adoptArchivedRules === true;
  const archivedRules = raw?.rules ?? {};
  const settlementEvidence = adopt && (raw?.regionalWork === true || raw?.survival?.settlementLife === true || archivedRules.settlementLife === true);
  const settlementLife = settlementEvidence
    ? true
    : (adopt ? (archivedRules.settlementLife ?? options?.settlementLife) : options?.settlementLife);
  const regionalWork = settlementEvidence
    ? true
    : (options?.regionalWork ?? raw?.regionalWork ?? (adopt ? raw?.rules?.regionalWork : undefined));
  const sp=createSurvPlay(Number.isSafeInteger(raw?.seed) ? raw.seed : seed,
    { ...options, ...(options?.adoptArchivedRules ? (raw?.rules ?? {}) : {}), settlementLife, regionalWork, eventRulesVersion: raw ? (raw.eventRulesVersion ?? (options?.upgradeLegacyEventRules ? options?.eventRulesVersion : null) ?? LEGACY_EVENT_RULES) : options?.eventRulesVersion,
      mapSeed: Number.isSafeInteger(raw?.mapSeed) ? raw.mapSeed : 0, layoutVersion: [1,2].includes(raw?.layoutVersion) ? raw.layoutVersion : 0 });
  if (raw && typeof raw.t === 'number' && raw.survival) {
    const w = sp.world;
    w.t = raw.t;
    // P1 读档连续：把连续时钟重锚到存档刻；旧档没有 clock 时按 t*60 接上，不补离线空档。
    if (w.simClock) {
      const minutes = Number.isFinite(raw.clock?.gameMinutes) ? Math.max(0, raw.clock.gameMinutes) : w.t * 60;
      w.simClock.setGameMinutes(minutes);
      w.t = Math.max(w.t, w.simClock.nowTick());
      resetSimCursor?.(w);
    }
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
    // V7.1：旧档没有玩家年龄记录 ⇒ 按成年起点回填，绝不把玩家立即判老或触发死亡。
    if (w.independentWorld && w.survival.households) {
      const rec = w.survival.households.residents.p1;
      if (!rec || !Number.isFinite(rec.born)) {
        w.survival.households.residents.p1 = { ...(rec ?? {}), born: w.t - ADULT_DAYS * DAY_TICKS, parents: rec?.parents ?? [], stage: 'adult' };
      }
    }
    // AUD-02：旧档 households 里缺 born 的创始居民不能判成 elder（NaN ⇒ 年龄 null、永久绝育、永不自然死亡）。
    // 按 createSurvPlay 的成人起点回填，属兼容逻辑，不改默认常量、不写回磁盘。
    for (const [id, rec] of Object.entries(w.survival.households?.residents ?? {})) {
      if (!rec || Number.isFinite(rec.born)) continue;
      w.survival.households.residents[id] = { ...rec, born: w.t - ADULT_DAYS * DAY_TICKS, parents: rec.parents ?? [], legacy: true };
    }
    w.weather = weatherFor(w.seed, dayOf(w.t));
    sp.world.loc = { ...sp.world.loc, ...(raw.loc ?? {}) };
    sp.world.pending = structuredClone(raw.pending ?? []);
    if (raw.residentTravel) w.residentTravel = structuredClone(raw.residentTravel);
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
    // 证据优先：坏 rules/survival 的 false 不能把已经证明存在的分城区吞掉。
    if (settlementEvidence && !sp.world.survival.settlementLife) sp.world.survival.settlementLife = true;
    restoreSettlementEvents(w.survival);
    if (sp.world.gameRules) {
      const clock = (sp.world.survival.actClock ??= {});
      for (const id of Object.keys(sp.world.agents)) clock[id] ??= { day: Math.floor(sp.world.t / (sp.world.dayTicks ?? 24)), usedMin: 0, busy: null };
      for (const id of Object.keys(clock)) if (!sp.world.agents[id]) delete clock[id];
    }
    // 旧档（开关之前烘的）没有 food 字段：新建世界留下的分档必须按载入后的 store 重新入账，
    // 否则 Σ分档 与 store 会永久差着一截，配给扣完而公仓显示不变。
    if (sp.world.gameRules && sp.world.survival) {
      const s = sp.world.survival;
      // 旧档没有分档：先按载入后的 store 建账（全部记作物，不凭空猜品类）。
      if (!s.food || typeof s.food !== 'object' || Array.isArray(s.food)) {
        s.store = Number.isFinite(s.store) ? Math.max(0, s.store) : 0;
        initFoodStore(s);
      } else {
        s.food = Object.fromEntries(FOOD_KINDS.map(kind => [
          kind, Number.isFinite(s.food[kind]) ? Math.max(0, s.food[kind]) : 0,
        ]));
        const sum = FOOD_KINDS.reduce((total, kind) => total + s.food[kind], 0);
        const stored = Number.isFinite(s.store) ? Math.max(0, s.store) : sum;
        // 保留历史记录的总量，先用作物消差，作物不足时再扣其他分档。
        s.store = sum;
        if (stored > sum) addFood(s, 'crop', stored - sum);
        if (stored < sum) takeFood(s, 'crop', sum - stored);
      }
    }
    restoreDistricts(w);
    restoreFarmPlots(w);
    restoreSources(w);
    if (w.survival.settlementLife) {
      w.survival.discussions ??= {};
      if (!w.discussionsEnabled) w.survival.discussions.active=null;
    }
    if (w.independentWorld) {
      const s = w.survival;
      if (s.endReason === 'player') { s.playerDead = true; s.failed = false; }
      s.ended = false;
      s.endReason = null;
    }
    for (const key of ['buildings','sites']) sp.world.survival[key]=sp.world.survival[key].map(b=>{
      const lot=buildLot(w,b.loc)??b.lot;
      return lot?{...b,lot}:b;
    });
    sp.world.sex = { ...sp.world.sex, ...(raw.sex ?? {}) };
    sp.world.pinv = { ...sp.world.pinv, ...(raw.pinv ?? {}) };
    for (const [id, st] of Object.entries(raw.minds ?? {})) {
      const a = sp.world.agents[id];
      if (!a || !a.drives || !st) continue;
      Object.assign(a.drives.v, st.drives ?? {});
      if (st.setpoint) Object.assign(a.drives.setpoint, st.setpoint);
      if (Number.isFinite(st.mealDay)) a.mealDay = st.mealDay;
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
      if (w.survival.settlementLife) a.relations.history=st.relHistory??[];
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
    settleMarriages(w);
    // 历史 agentError 属于旧引擎的故障读数，不是世界事实；随档带回来会让面板永远显示旧红字。
    sp.log = (raw.log ?? []).filter((x) => x?.kind !== 'agentError');
    settleHousing(w, sp.log);
    if (w.survival.settlementLife && !w.agents.p1.dead && typeof raw.campPlayerRoom==='string') {
      const room=raw.campPlayerRoom, building=facilityOf(w,room);
      if (room===w.loc.p1 && homeEntry(w,'p1',room).ok || building?.loc===w.loc.p1 && building.integrity>0)
        w.campPlayerRoom=room;
    }
    if (w.survival.settlementLife) {
      for (const id of Object.keys(w.loc)) {
        if (isAlive(w.agents[id]) && !homeEntry(w,id,w.loc[id]).ok) w.loc[id]='hall';
      }
    }
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
    // P1：装载本身会消耗真实毫秒；在最后再重锚一次，保证"读档后的世界分钟 = 存档分钟"，
    // 不让读档磁盘/反序列化的耗时偷偷写进世界时间。
    if (w.simClock) {
      const minutes = Number.isFinite(raw.clock?.gameMinutes) ? Math.max(0, raw.clock.gameMinutes) : w.t * 60;
      w.simClock.setGameMinutes(minutes);
      w.t = Math.max(w.t, w.simClock.nowTick());
      resetSimCursor?.(w);
    }
  }
  // V7.3.2：恢复 fair 调度欠账/上次机会；旧档没有该字段则保持空状态（不伪造历史）。
  return sp;
}

  return { DEATHS_CAP, trimDeaths, dumpSurv, loadSurv };
}
