// 对照/回放域：A/B 两分支的记录、视图、落盘与只读回放查询。
// 世界推进与动作执行仍由 host-world 提供（通过 world 引用调用），这里不复制世界状态。
import { mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { dumpSurv, loadSurv, survView, tickSurvPlay, simMinuteCursor, resetSimMinuteCursor } from './survplay.mjs';
import { campSleepTicks } from './camp-play.mjs';
import { applySleepRecovery } from './rest-energy.mjs';
import { createReplay, recordReplayFrame, replayRange, replayPoint } from './replay-history.mjs';
import { replayTerrain, replayScene } from './replay-scene.mjs';
import { speechLine } from './speech.mjs';
import { PARAMS } from './params.mjs';
import { validCampArchive } from './camp-instances.mjs';
import { createSimClock, worldMinutes } from './sim-clock.mjs';
import { createSimScheduler } from './sim-scheduler.mjs';

export function createReplayDomain({ S, CFG, C, world }) {
  const { SERIES_CAP } = C;
  const { survivalOptions, actInSurvival } = world;
const COMPARE_SIDES = ['A', 'B'];

// P1c/1.1：compare 的状态锁。act、tick、单侧 pause/rate 共用同一条短链：
//   · 临界区内只做世界推进/采集/publish；磁盘 save 与（未来的）模型等待都在锁外。
//   · A/B 在同一临界区里按 A→B 顺序提交，act 与 tick 不能交叉写同一侧。
let compareChain = Promise.resolve();
function withCompareLock(operation) {
  const run = compareChain.then(operation);
  compareChain = run.catch(() => {});
  return run;
}

// 每侧独立调度器：只读该侧 clock 与该侧分钟游标，不共享 cursor。
const compareSchedulers = new Map();
function compareScheduler(side) {
  const branch = S.comparison?.branches?.[side];
  const clock = branch?.play?.world?.simClock;
  if (!clock) return null;
  let scheduler = compareSchedulers.get(side);
  if (!scheduler || scheduler.clock !== clock) {
    scheduler = createSimScheduler({ clock, cursor: () => simMinuteCursor(branch.play.world) });
    compareSchedulers.set(side, scheduler);
  }
  return scheduler;
}
function comparisonWatched(now = Date.now()) {
  const presence = Number(C.PRESENCE_MS ?? 180000);
  return now - Math.max(S.viewers?.compare ?? 0, S.viewers?.comparison ?? 0) <= presence;
}
function comparisonActive(now = Date.now()) {
  return Boolean(S.comparison) && S.compareRunning !== false && comparisonWatched(now);
}

function compareMasks() {
  return {
    A: Object.fromEntries(Object.entries(S.comparisonMasks).filter(([key, on]) => on && key !== 'm3').map(([key]) => [key, 1])),
    B: {m3: 0, coupling: 0},
  };
}

function makeComparison(origin, revision = 0, saved) {
  const masks = compareMasks();
  // 1.1 第 3 项：正式态 A/B 各自独立连续时钟。两侧用同一 now/rate/起点创建；
  // 读档时 loadSurv 会把各自 clock 重锚到存档分钟（旧档无 clock 则按 t*60）。
  const baseRate = Number.isFinite(origin?.clock?.rate) ? origin.clock.rate : (Number.isFinite(S.rate) ? S.rate : 1);
  // 两侧必须在**同一个真实时刻**锚到各自起点，否则 1ms 的创建差会让同一分钟 step 一侧少走 1 分。
  const startNow = Date.now();
  const branches = Object.fromEntries(COMPARE_SIDES.map((key) => {
    const record = saved?.branches?.[key];
    const raw = structuredClone(record?.world ?? origin);
    const savedClock = record?.world?.clock;
    const startMinutes = Number.isFinite(savedClock?.gameMinutes)
      ? Math.max(0, savedClock.gameMinutes)
      : Math.max(0, Number(raw?.t ?? origin?.t ?? 0)) * 60;
    const clock = createSimClock({ rate: Number.isFinite(savedClock?.rate) ? savedClock.rate : baseRate });
    const play = loadSurv(raw, CFG.seed, {
      ...survivalOptions(),
      // 正式态（gameRules）自动接连续钟；研究态 createSurvPlay 仍忽略 simTime，形状不变。
      simTime: true,
      simClock: clock,
      residentCondition: key === 'A' ? 'C2' : 'C2-neg',
      residentChannelMask: masks[key],
      deliberator: null,
    });
    // 读档的 setGameMinutes 在各自加载时刻发生；这里用同一 startNow 重锚，保证同起点。
    if (play.world.simClock) {
      play.world.simClock.setGameMinutes(startMinutes, startNow);
      resetSimMinuteCursor(play.world);
      // 暂停是时钟属性：旧档没有 paused 字段就保持运行（不伪造历史）。
      if (savedClock?.paused === true) play.world.simClock.pause(startNow);
    }
    return [key, {play, series: record?.series?.slice(-SERIES_CAP) ?? [], log: record?.log?.slice(-80) ?? [],
      stat: record?.stat ?? {决策: 0, 高冲动: 0, 越轨: 0, 驳回: 0, 发现: 0}, last: record?.last ?? {}}];
  }));
  const pair = {origin, branches, revision};
  pair.replay = saved?.replay?.revision === revision ? saved.replay : createReplay(revision);
  for (const branch of Object.values(branches)) {
    survView(branch.play);
    if (!branch.series.length) recordComparisonSeries(branch);
  }
  if (!saved) captureComparisonFrame(pair);
  return pair;
}

function comparisonFromSave(saved) {
  if (!saved) return makeComparison(structuredClone(dumpSurv(S.surv)));
  try {
    const {origin, branches, revision} = saved;
    if (!validCampArchive(origin) || !validCampArchive(branches?.A?.world) || !validCampArchive(branches?.B?.world) ||
        // 1.1：A/B 各自独立时钟，暂停/倍速后可合法地停在不同刻；不再要求两树刻数相等。
        [branches.A.world, branches.B.world].some(w => w.seed !== origin.seed || w.mapSeed !== origin.mapSeed) ||
        !Number.isSafeInteger(revision) || revision < 0) throw new Error('对照存档结构无效');
    const formerMasks = S.comparisonMasks;
    S.comparisonMasks = {m3: false, coupling: saved.masks?.coupling === true};
    try { return makeComparison(origin, revision, saved); }
    catch (error) { S.comparisonMasks = formerMasks; throw error; }
  } catch {
    // 生存档可独立恢复；对照记录异常时从生存快照开一轮。
    S.compareSaveError = '对照档状态无效，已从生存快照另起一轮';
    return makeComparison(structuredClone(dumpSurv(S.surv)));
  }
}

function recordComparisonSeries(branch) {
  const w = branch.play.world;
  const residents = Object.values(w.agents).filter(a => !a.isPlayer);
  branch.series.push({t: w.t,
    v: Object.fromEntries(residents.map(a => [a.id, Number(a.viab.v.toFixed(3))])),
    lost: Object.fromEntries(residents.map(a => [a.id, a.viab.ledger.length])),
  });
  if (branch.series.length > SERIES_CAP) branch.series.shift();
}

function recordComparisonAction(branch, a, trace) {
  const w = branch.play.world;
  for (const row of trace) {
    if (row.layer === 'rejected') branch.stat.驳回 += 1;
    if (row.layer === 'discovery') branch.stat.发现 += 1;
    if (!row.action || typeof row.ok !== 'boolean' || row.layer === 'refused') continue;
    branch.stat.决策 += 1;
    if (row.kind === 'look_out' || row.kind === 'take_shared') branch.stat.高冲动 += 1;
    if (row.kind === 'take_shared' && row.ok) branch.stat.越轨 += 1;
    branch.last[a.id] = {action: row.action};
    const line = row.kind === 'talk' && row.ok ? speechLine(a, {world: w, kind: row.kind, actionId: row.action, t: row.t}) : null;
    branch.log.push({t: row.t, who: a.name, kind: line ? 'act' : row.ok ? 'decision' : 'rej', text: line ?? row.obs ?? row.action});
  }
  if (branch.log.length > 80) branch.log.splice(0, branch.log.length - 80);
}

function replayCard(branch) {
  const w = branch.play.world;
  return {
    side: w.residentCondition === 'C2' ? 'A' : 'B', t: w.t,
    minute: Math.max(0, Math.floor(worldMinutes(w))),
    store: w.survival?.store ?? null,
    buildings: (w.survival?.buildings ?? []).map((b) => ({ type: b.type, loc: b.loc, integrity: b.integrity })),
    pinv: { wood: w.pinv?.p1?.wood ?? 0, stone: w.pinv?.p1?.stone ?? 0 },
    agents: Object.values(w.agents).filter((a) => !a.isPlayer).map((a) => ({
      id: a.id, name: a.name, loc: w.loc[a.id], dead: !!a.dead,
      energy: Number((a.drives?.v?.energy ?? 0).toFixed(2)), viab: Number((a.viab?.v ?? 0).toFixed(2)),
    })),
  };
}

function captureComparisonFrame(pair) {
  const {A,B}=pair.branches;
  // 1.1：tick→scene 以分钟为真值。同速时两侧分钟一致；一侧暂停/倍速时取共同前沿，
  // 场景按各自分钟入索引，查不到的一侧在 replayPoint 里返回 null（不借另一侧）。
  const minuteA=Math.max(0,Math.floor(worldMinutes(A.play.world)));
  const minuteB=Math.max(0,Math.floor(worldMinutes(B.play.world)));
  const minute=Math.max(minuteA,minuteB);
  const t=Math.floor(minute/60);
  const views={A:survView(A.play),B:survView(B.play)};
  pair.replay.terrain??=replayTerrain(views.A);
  const events=[['A',A],['B',B]].flatMap(([side,branch])=>
    (branch.play.world.survival?.eventJournal?.rows??[]).filter(e=>e.t===t).map(e=>({...e,side})));
  recordReplayFrame(pair.replay,{t,minute,minutes:{A:minuteA,B:minuteB},A:replayCard(A),B:replayCard(B),events,
    scene:{A:replayScene(views.A,'A'),B:replayScene(views.B,'B')}});
}

async function tickComparisonLocked(now = Date.now(), { minutes, explicit = false } = {}) {
  const pair = S.comparison;
  if (!pair) return pair;
  let advanced = false;
  for (const key of COMPARE_SIDES) {
    const branch = pair.branches[key];
    const w = branch.play.world, clock = w.simClock;
    if (!clock) {
      // 研究态/旧对照没有连续钟：保持旧“一次 step/tick = 一刻”的语义与研究态形状。
      await tickSurvPlay(branch.play, {now, onResidentAction: (agent, rows) => recordComparisonAction(branch, agent, rows)});
      recordComparisonSeries(branch);
      advanced = true;
      continue;
    }
    // 单侧暂停只冻结该侧；全局 compare 暂停不冻结时钟，手动 step 仍显式推进（旧语义）。
    if (clock.paused) continue;
    if (explicit) {
      if (!(minutes > 0)) continue;
      await tickSurvPlay(branch.play, {now, minutes, onResidentAction: (agent, rows) => recordComparisonAction(branch, agent, rows)});
    } else {
      const scheduler = compareScheduler(key);
      const due = scheduler?.peek(now).minutes ?? 0;
      if (due < 1) continue;
      // 自动推进用“推进到真实时间对应的整分钟”，不再额外加 due（否则会把已欠的分钟翻倍）。
      await tickSurvPlay(branch.play, {now, onResidentAction: (agent, rows) => recordComparisonAction(branch, agent, rows)});
    }
    recordComparisonSeries(branch);
    advanced = true;
  }
  if (advanced) {
    // 1.1：同一现实刻两侧时钟各自 setGameMinutes 会把“A 先跑”的耗时写进锚点，
    // 下一拍用同一个 now 求整分钟就可能差 1 分。这里在本拍结束的同一时刻把两侧锚到
    // 各自已结算的分钟：同速率/都未暂停时两侧锚点逐位相同，A/B 分钟与目标永远同步；
    // 暂停/倍速的那一侧跳过（它的钟有自己的锚，不能被本拍强行对齐）。
    const settledAt = Date.now();
    for (const key of COMPARE_SIDES) {
      const w = pair.branches[key].play.world;
      const clock = w.simClock;
      if (!clock || clock.paused) continue;
      clock.setGameMinutes(simMinuteCursor(w), settledAt);
    }
    captureComparisonFrame(pair);
    publishComparison();
  }
  return pair;
}

async function tickComparison(now = Date.now(), options = {}) {
  return withCompareLock(() => tickComparisonLocked(now, options));
}

function comparisonDue(now = Date.now()) {
  if (!comparisonActive(now)) return 0;
  let due = 0;
  for (const key of COMPARE_SIDES) {
    const clock = S.comparison?.branches?.[key]?.play?.world?.simClock;
    // 研究态没有钟：保持旧节拍，让 autoTick 每拍叫一次 compare tick。
    if (!clock) return Math.max(due, 1);
    if (clock.paused) continue;
    due = Math.max(due, compareScheduler(key)?.peek(now).minutes ?? 0);
  }
  return due;
}

// 自动调度唤醒间隔：primary 与 compare 取更近的一个；compare 全局暂停/无观众不催。
function nextComparisonDelayMs(now = Date.now()) {
  if (!comparisonActive(now)) return Infinity;
  let delay = Infinity;
  for (const key of COMPARE_SIDES) {
    const clock = S.comparison?.branches?.[key]?.play?.world?.simClock;
    if (!clock || clock.paused) continue;
    delay = Math.min(delay, compareScheduler(key)?.nextDelayMs(now) ?? Infinity);
  }
  return delay;
}

function makeComparisonView() {
  if (!S.comparison) return null;
  const view = (branch) => {
    const s = survView(branch.play), w = branch.play.world;
    const residents = Object.values(w.agents).filter(a => !a.isPlayer);
    const sum = k => residents.reduce((total,a) => total+(a.counters[k]??0),0);
    return {...s, compareSide: w.residentCondition === 'C2' ? 'A' : 'B',
      clock: w.simClock ? {gameMinutes: Number(w.simClock.nowMinutes().toFixed(3)), t: w.t,
        rate: w.simClock.rate, paused: w.simClock.paused, msPerGameMinute: w.simClock.msPerGameMinute} : null,
      stat: branch.stat, series: branch.series, viabCrit: PARAMS.viab.crit,
      researchLog: branch.log, model: {enabled: false, configured: false},
      cost: {事件: sum('triggered'), 被问: sum('asked'), 跳过: sum('skipped'), 驳回重问: sum('askedRetry')},
      agents: {...s.agents, ...Object.fromEntries(residents.map(a => [a.id, {...s.agents[a.id],
        archetype: a.traits.archetype, m: a.bank.snapshot(), baseline: a.traits.baseline, summary: a.bank.summary(),
        researchViab: {v: a.viab.v, lost: a.viab.ledger.map(l => l.organ)}, last: branch.last[a.id],
        layers: {m3: a.ch.m3, coupling: a.ch.coupling}, m3: a.ch.m3 ? a.m3Last : null,
        coupling: a.ch.coupling ? a.coupling.dump() : null,
      }]))},
    };
  };
  const {branches, origin, revision} = S.comparison;
  return {A: view(branches.A), B: view(branches.B), startTick: origin.t, mapSeed: origin.mapSeed, revision, masks: S.comparisonMasks};
}

function publishComparison() {
  S.compareView = structuredClone(makeComparisonView());
}

async function saveComparison() {
  const {origin, revision, branches} = S.comparison;
  const record = {origin, revision, masks: S.comparisonMasks, replay: S.comparison.replay,
    branches: Object.fromEntries(COMPARE_SIDES.map(key => {
      const {play, ...observations} = branches[key];
      return [key, {...observations, world: dumpSurv(play)}];
    })),
  };
  const dest = join(S.dir, 'comparison.json'), tmp = dest + '.tmp';
  try {
    await mkdir(S.dir, {recursive:true});
    await writeFile(tmp, JSON.stringify(record), 'utf8');
    await rename(tmp, dest);
    S.compareSaveError = null;
    return true;
  } catch (error) {
    S.compareSaveError = String(error.message ?? error).slice(0, 80);
    return false;
  } finally {
    await rm(tmp, {force:true}).catch(()=>{});
  }
}

async function actInComparison(body) {
  const pair = S.comparison;
  if (!pair || body.revision !== pair.revision) return {ok: false, code: 'COMPARE_STALE'};
  const now = Date.now();
  const outcome = await withCompareLock(async () => {
    const current = S.comparison;
    if (!current || body.revision !== current.revision) return {stale: true};
    const results = {};
    if (body.kind === 'camp_sleep') {
      for (const key of COMPARE_SIDES) results[key] = campSleepTicks(current.branches[key].play.world);
      const ticks = Math.max(...Object.values(results).map(r => r.ticks ?? 0));
      // 两侧都度过同一段睡眠：连续钟走内部 locked 版本（避免重入 compareChain），
      // 旧研究态仍按“一刻一次”循环，保持原语义。
      const continuous = COMPARE_SIDES.some(key => current.branches[key].play.world.simClock);
      if (ticks && continuous) await tickComparisonLocked(now, {minutes: ticks * 60, explicit: true});
      else if (ticks) for (let i = 0; i < ticks; i++) await tickComparisonLocked(now);
      // 1.6 C：恢复必须逐分支、按各自实际睡眠小时结算；A/B 仍可逐位对照。
      for (const key of COMPARE_SIDES) {
        const r = results[key], w = current.branches[key].play.world;
        results[key] = {...r, recovery: r.ok ? applySleepRecovery(w, r.ticks ?? 0) : {gain: 0, hours: 0}};
      }
    } else if (body.kind === 'camp_rest') {
      // 对照态不提供通用休息（避免把新恢复来源写进 A/B 轨迹）。
      for (const key of COMPARE_SIDES) results[key] = {ok: false, code: 'REST_UNSUPPORTED'};
    } else {
      for (const key of COMPARE_SIDES) {
        const command = key==='B' && body.otherContact ? {
          ...body, from: body.otherContact.from,
          ...(Object.hasOwn(body,'to') && {to: body.otherContact.to}),
        } : body;
        results[key] = await actInSurvival(current.branches[key].play, command, null, now);
      }
    }
    if (body.kind !== 'player_sync') for (const key of COMPARE_SIDES) {
      const branch = current.branches[key], r = results[key];
      branch.log.push({t: branch.play.world.t, who: '玩家', kind: r.ok ? 'player' : 'rej',
        text: [body.kind, r.line ?? r.code ?? r.error].filter(Boolean).join(' · ')});
      if (branch.log.length > 80) branch.log.shift();
    }
    publishComparison();
    if (body.kind === 'player_sync' && !Object.values(results).some(r => r.ok)) return {early: {...results.A, sides: results}};
    if (body.kind!=='camp_sleep') captureComparisonFrame(current);
    return {result: {...results.A, sides: results}};
  });
  if (outcome.stale) return {ok: false, code: 'COMPARE_STALE'};
  if (outcome.early) return outcome.early;
  // 磁盘写在短锁外：act 的状态提交已完成，不能让慢盘/慢模型占着 compare 临界区。
  return {...outcome.result, persisted: await saveComparison()};
}

  function replayQuery(query = {}) {
    if (!S.comparison?.replay) return { ok: false, code: 'NO_COMPARISON' };
    if (Number.isFinite(query?.t)) return replayPoint(S.comparison.replay, query.t, query.revision);
    return replayRange(S.comparison.replay, { from: query?.from, to: query?.to, revision: query?.revision });
  }

  function clockView(clock) {
    if (!clock) return null;
    return {gameMinutes: Number(clock.nowMinutes().toFixed(3)), t: Math.floor((clock.nowMinutes() + 1e-6) / 60),
      rate: clock.rate, paused: clock.paused, msPerGameMinute: clock.msPerGameMinute};
  }

  // compare 的 pause/resume/rate 也走同一把短锁：不能在世界推进到一半时换挡/冻结。
  function controlComparison(body = {}) {
    return withCompareLock(() => {
      const pair = S.comparison;
      if (!pair) return {ok: false, error: 'NO_COMPARISON'};
      const side = body.side ? String(body.side).toUpperCase() : null;
      if (side && !COMPARE_SIDES.includes(side)) return {ok: false, error: 'BAD_SIDE'};
      if (body.action === 'pause' || body.action === 'resume') {
        if (!side) {
          // 全局暂停只停自动推进；不冻结时钟，手动 step 仍显式推进（旧语义）。
          S.compareRunning = body.action === 'resume';
          return {ok: true, running: S.compareRunning, clocks: {A: clockView(pair.branches.A.play.world.simClock), B: clockView(pair.branches.B.play.world.simClock)}};
        }
        const clock = pair.branches[side].play.world.simClock;
        if (!clock) return {ok: false, error: 'NO_CLOCK'};
        clock[body.action]();
        publishComparison();
        return {ok: true, side, clock: clockView(clock)};
      }
      if (body.action === 'rate') {
        const rate = Number(body.rate ?? body.value);
        if (!Number.isFinite(rate) || rate < 0.1 || rate > 16) return {ok: false, error: 'BAD_RATE'};
        const targets = side ? [side] : COMPARE_SIDES;
        const clocks = {};
        for (const key of targets) {
          const clock = pair.branches[key].play.world.simClock;
          if (!clock) return {ok: false, error: 'NO_CLOCK'};
          clock.setRate(rate);
          clocks[key] = clockView(clock);
        }
        publishComparison();
        return {ok: true, rate, ...(side ? {side} : {}), clocks};
      }
      return {ok: false, error: 'UNKNOWN_ACTION'};
    });
  }

  return { replayQuery, makeComparison, comparisonFromSave, publishComparison, saveComparison,
    tickComparison, actInComparison, makeComparisonView, controlComparison,
    comparisonDue, nextComparisonDelayMs, withCompareLock };
}
