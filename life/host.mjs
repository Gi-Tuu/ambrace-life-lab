// 权威世界宿主 facade：状态单例、常量与对外 API 的组装处。
// 世界创建/tick/生命周期在 host-world；模型在 host-model；对照/回放在 host-replay。
// 这里只保留 HTTP 面需要的请求整形（snapshot/act/ctl）与原导出，避免主路径继续膨胀。
import { CURRENT_LAYOUT } from '../shared/layout-version.mjs';
import { randomInt } from 'node:crypto';
import { LOCS, workUsedToday, hail, move, startMove } from './body.mjs';
import { worldSite } from './geometry.mjs';
import { classifySay } from './speech.mjs';
import { tell } from './gossip.mjs';
import { phaseOf, scheduledLoc } from './clock.mjs';
import { prepareSay, finishSay } from './dialogue.mjs';
import { prepareFreeSay, finishFreeSay } from './resident-dialogue.mjs';
import { createSurvPlay, setSurvivalDeliberator, survView, dumpSurv, settleSurvival } from './survplay.mjs';
import { observerActive as observerActiveBase, modelChannel, breakerOpenAt, budgetTick, pickProviderKey } from './host-budget.mjs';
import { DIMS } from './traits.mjs';
import { PARAMS } from './params.mjs';
import { createModelDomain } from './host-model.mjs';
import { createReplayDomain } from './host-replay.mjs';
import { createHostWorld } from './host-world.mjs';
export { modelChannel, breakerOpenAt, budgetTick, pickProviderKey };
export { modelLaneFor } from './camp-lane.mjs';

const PRESENCE_MS = Number(process.env.PRESENCE_MS ?? 180000);
export function observerActive(lastVisitor, now, presenceMs = PRESENCE_MS) {
  return observerActiveBase(lastVisitor, now, presenceMs);
}

const ROSTER = [
  { id: 'a1', name: '岑', archetype: '谨慎', loc: 'home' },
  { id: 'a2', name: '绛', archetype: '冲动', loc: 'hall' },
  { id: 'a3', name: '蓑', archetype: '孤僻', loc: 'watch' },
];
const M5_ENABLED = process.env.M5_ENABLED === '1';
const WORK_CAP = process.env.WORK_CAP === undefined || process.env.WORK_CAP === '' ? undefined : Number(process.env.WORK_CAP);
// TICK_MS 只决定研究态/非连续世界的整拍间隔；正式连续世界的自动调度读 world.simClock
// （GAME_MS_PER_MINUTE，默认 6000ms/游戏分），不再从这里派生 1 游戏分钟。
const TICK_MS = Number(process.env.TICK_MS ?? 7500);
const GAME_MODE = process.env.GAME_MODE === 'game' ? 'game' : 'research';
const CATCHUP_CAP_MIN = Number(process.env.CATCHUP_CAP_MIN ?? 360);
const SURV_CATCHUP_CAP = Number(process.env.SURV_CATCHUP_CAP ?? 120);
const campTickBudgetMs = () => {
  const n = Number(process.env.CAMP_TICK_BUDGET_MS ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
};
const catchupCooldownMs = () => {
  const n = Number(process.env.CATCHUP_COOLDOWN_MS ?? 60000);
  return Number.isFinite(n) && n >= 0 ? n : 60000;
};
const catchupDayCapMin = () => {
  const n = Number(process.env.CATCHUP_DAY_CAP_MIN ?? 720);
  return Number.isFinite(n) && n > 0 ? n : 720;
};
const ARCHIVE_VERSION = 1;
const ACT_SAVE_COALESCE_MS = Number(process.env.ACT_SAVE_COALESCE_MS ?? 0) || 0;
const SAVE_EVERY = (() => {
  const n = Number(process.env.SAVE_EVERY ?? 10);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 10;
})();
const SERIES_CAP = Number(process.env.SERIES_CAP ?? 720);
const TRACE_CAP = Number(process.env.TRACE_CAP ?? 400);
const PER_TICK_CAP = Number(process.env.MAX_CALLS_PER_TICK ?? (GAME_MODE === 'game' ? 2 : 0));
const MODEL_TIMEOUT_MS = Number(process.env.MODEL_TIMEOUT_MS ?? (GAME_MODE === 'game' ? 4000 : 20000));
const MODEL_TICK_BUDGET_MS = Number(process.env.MODEL_TICK_BUDGET_MS ?? (GAME_MODE === 'game' ? 3000 : 0));
const CFG = { providers: [], keys: [], model: '', models: [], deliberationModel: '', seed: Number(process.env.SEED ?? 7), brain: 'local' };
const BUDGET = Number(process.env.MAX_CALLS ?? 120);
const NODE_BUDGET = Number(process.env.NODE_CALLS_DAY ?? (GAME_MODE === 'game' ? 12000 : 0));
const UNATTENDED_ON = String(process.env.MODEL_UNATTENDED ?? (GAME_MODE === 'game' ? '1' : '0')) === '1';
const UNATTENDED_ASK_CAP = Number(process.env.UNATTENDED_CALLS_PER_TICK ?? 1);
const PAID_WHEN_UNATTENDED = String(process.env.MODEL_PAID_UNATTENDED ?? '0') === '1';
const BREAKER_FAILS = Number(process.env.MODEL_BREAKER_FAILS ?? 3);
const BREAKER_MS = Number(process.env.MODEL_BREAKER_MS ?? 60000);
const FREE_HOSTS = (process.env.FREE_MODEL_HOSTS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const PAID_HOSTS = (process.env.PAID_MODEL_HOSTS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const ATTEMPT_CAP = 20;

const C = {
  ROSTER, M5_ENABLED, WORK_CAP, TICK_MS, GAME_MODE, CATCHUP_CAP_MIN, SURV_CATCHUP_CAP,
  campTickBudgetMs, catchupCooldownMs, catchupDayCapMin, ARCHIVE_VERSION, ACT_SAVE_COALESCE_MS,
  SAVE_EVERY, SERIES_CAP, TRACE_CAP, BUDGET, NODE_BUDGET, PER_TICK_CAP, MODEL_TIMEOUT_MS,
  MODEL_TICK_BUDGET_MS, UNATTENDED_ON, UNATTENDED_ASK_CAP, PAID_WHEN_UNATTENDED, BREAKER_FAILS,
  BREAKER_MS, FREE_HOSTS, PAID_HOSTS, ATTEMPT_CAP, PRESENCE_MS,
};

const S = { comparison: null, compareView: null, compareSaveError: null, compareRunning: true, comparisonMasks: {m3: false, coupling: false}, packs: null, timer: null, tickError: null, running: true, savedAt: 0, missed: { minutes: 0, capped: false }, model: { calls: 0, tokens: 0, moneyCalls: 0, nodeCalls: 0, attempts: [], dayKey: '', chatter: { asked: 0, ok: 0, timeout: 0, http: 0, empty: 0, invalid: 0 } }, breaker: { fails: 0, openUntil: 0 }, campKey: null, campName: null, campViewers: {}, mainSurv: null, seedSurv: null, camps: null,
  lastVisitor: 0, viewers: { survival: 0, compare: 0, comparison: 0 }, saveError: null,
  get dir() { return process.env.DATA_DIR ?? 'data'; }, masks: { m3: false, coupling: false }, startRaw: null, surv: null };

// /healthz 的只读时钟投影：与 /world 读同一个 world.simClock，不建第二套时间。
// 只给排查 UI 时间所需的四个量；不暴露 anchor/pausedAtMs、数据目录或供应商配置。
function statusClock() {
  const clock = (S.mainSurv ?? S.surv)?.world?.simClock;
  if (!clock) return null;
  return {
    gameMinutes: Number(clock.nowMinutes().toFixed(3)),
    msPerGameMinute: clock.msPerGameMinute,
    rate: clock.rate,
    paused: clock.paused,
  };
}

let model, replay;
const world = createHostWorld({ S, CFG, C, getModel: () => model, getReplay: () => replay, observerActive });
model = createModelDomain({ S, CFG, C, observerActive });
replay = createReplayDomain({ S, CFG, C, world });
const {
  configure, isFreeProvider, modelGate, modelRelease, modelChargeLane, modelCharged,
  modelBrain, modelTalk, modelChat, modelChatter, modelPlayerSpeech, modelConfigured, buildDeliberationPrompt, deliberationPrompt, chatterNote,
} = model;
const { replayQuery, makeComparison, publishComparison, saveComparison, tickComparison, actInComparison, controlComparison } = replay;
const {
  viewers, writeQueue, start, stop, flushWrites, save, saveWorld, saveMain, saveCampEntry,
  campManager, sweepCamps, validCampKey, campViewerKeys, campSurv, listCamps, guestCampView, campOwnerHash,
  claimCamp, openCamp, backToMainCamp, survivalOptions, queueWorldWrite, manualTick,
  catchUp, catchUpSurvival, actInSurvival, sleepSurvival, persistAfterAction, serialize,
  makePack, freshPacks, packsFrom, buildPacks, queueAct, v12Fixture,
} = world;

// 旧导出名全部保留：调用方（serve/scripts/测试）不需要知道模块内部怎么分层。
export {
  configure, isFreeProvider, modelGate, modelRelease, modelChargeLane, modelCharged,
  buildDeliberationPrompt, deliberationPrompt, flushWrites, survivalOptions,
  sweepCamps, validCampKey, campViewerKeys, campSurv, listCamps, guestCampView, campOwnerHash,
  claimCamp, openCamp, backToMainCamp, modelPlayerSpeech,
};

// P1：正式生存动作走短串行（只保护状态提交），不再等当前 tick / 模型。
// P1c：talk_say / camp_sleep / compare 也迁到同一短锁；talk_say 的模型等待放在锁外。
async function actSurvivalFast(body, campKey) {
  if (!S.packs) return { ok: false, error: 'NO_WORLD' };
  const reqCamp = campKey && campKey !== 'MAIN' ? String(campKey) : null;
  if (reqCamp && !validCampKey(reqCamp)) return { ok: false, code: 'CAMP_INVALID' };
  const survSel = campSurv(reqCamp);
  if (!survSel) return { ok: false, error: 'NO_SURV' };
  const now = Date.now();
  // 睡眠：短锁内原子推进 60 游戏分/步（见 sleepSurvival），不排在旧 tickChain 后面。
  if (body.kind === 'camp_sleep') return queueAct(() => sleepSurvival(survSel));
  // 对话：prepare（锁内）→ 模型（锁外）→ finish（锁内）。模型等待期间普通输入仍可推进；
  // 同一段对话并发句子由 prepare 的 pendingSay 闸门拒绝（SAY_PENDING），不会重复调模型。
  if (body.kind === 'talk_say') return actTalkSayFast(survSel, body, now);
  // 1.5 自由输入：prepare（短锁）→ 模型（锁外）→ finish（短锁）。不每句落盘；
  // 关闭对话或下一次 tick 才把 survival 写进档。
  if (body.kind === 'camp_talk_say' && typeof body.text === 'string' && body.text.trim()) {
    return actFreeTalkFast(survSel, body, now);
  }
  return queueAct(async () => {
    const result = await actInSurvival(survSel, body, modelTalk, now);
    if (result.ok || result.settled) return { ...result, ...await persistAfterAction(survSel) };
    return result;
  });
}

async function actTalkSayFast(sp, body, now) {
  const prep = await queueAct(() => prepareSay(sp, body, now));
  let result = prep;
  if (prep?.pending) {
    const pending = prep.pending;
    let line = null;
    if (pending.canAsk) {
      try { line = await modelTalk(pending.askArgs); } catch { line = null; }
    }
    result = await queueAct(() => finishSay(sp, pending, line));
  }
  if (!result?.ok && !result?.settled) return result;
  const settledNow = settleSurvival(sp);
  const out = settledNow ? { ...result, settled: true } : result;
  return { ...out, ...await persistAfterAction(sp) };
}

async function actFreeTalkFast(sp, body, now) {
  const prep = await queueAct(() => prepareFreeSay(sp.world, body, now));
  let result = prep;
  if (prep?.pending) {
    const pending = prep.pending;
    let line = null;
    if (pending.canAsk) {
      try { line = await modelChat({ world: sp.world, prompt: pending.prompt }); } catch { line = null; }
    }
    result = await queueAct(() => finishFreeSay(sp.world, pending, line, now));
    // 模型回了话但被 sanitize 判无效（JSON 形状/纯符号）时，玩家看到的是模板，而 askLine 只记得到 ok。
    // 这一格只能在 host 侧补：sanitize 在 resident-dialogue 里，返回值 served 是唯一能区分两者的地方。
    if (result?.served === 'template' && line) chatterNote('invalid');
  }
  return result;
}

function continuousCamp(campKey) {
  try {
    const reqCamp = campKey && campKey !== 'MAIN' ? String(campKey) : null;
    if (reqCamp && !validCampKey(reqCamp)) return null;
    return campSurv(reqCamp);
  } catch { return null; }
}

function actComparisonFast(body) {
  return queueAct(() => actInComparison(body));
}

export const host = {
  replay(query = {}) { return replayQuery(query); },
  setBackend: configure,
  // 观众在场打点：只由应用路径调用（/healthz 不算，否则平台健康检查会让"有观众"恒真）
  touch: (mode, campKey) => viewers.touch(mode, campKey),
  async start() { return start(); },
  // 只读句柄：给测试和未来插桩用。写操作仍然只走 ctl/act，避免绕过规则层
  get packs() {
    return S.packs;
  },
  async tickOnce() { await manualTick(); return this.snapshot(); },
  stop() { return stop(); },
  // 只读：serve 的 /export、/import 用它定位 saves/（不把路径回显给客户端）。
  get dataDir() { return S.dir; },
  status: () => ({ t: S.packs?.A.world.t ?? 0, campT: S.surv?.world.t ?? null, rate: (S.mainSurv ?? S.surv)?.world?.simClock?.rate ?? S.rate ?? 1, clock: statusClock(), campDay: S.surv?.world.survival?.day ?? null, settlement: S.surv?.world.survival?.settlement ?? null, running: S.running, brain: CFG.brain, savedAt: S.savedAt, missed: S.missed, modelCalls: S.model.calls, moneyCalls: S.model.moneyCalls ?? 0, nodeCalls: S.model.nodeCalls ?? 0, nodeBudget: NODE_BUDGET, unattended: UNATTENDED_ON, paidWhenUnattended: PAID_WHEN_UNATTENDED, breaker: { open: breakerOpenAt(S.breaker), fails: S.breaker.fails, trips: S.breaker.trips ?? 0 }, watching: observerActive(S.lastVisitor, Date.now()), saveError: S.saveError ?? S.campSaveErrors?.values().next().value ?? null, tickError: S.tickError, campTickSkipped: S.campTickSkipped ?? 0, masks: S.masks }),
  listCamps,
  guestCampView,
  campOwnerHash,
  claimCamp,
  sweepCamps,
  openCamp,
  backToMainCamp,
  async readWorld(mode, campKey) {
    // P1：读路径不再排队。snapshot 是同步只读，tick 在 await 模型时也能立即返回上一致状态；
    // 读不等待写，也不会被一拍模型拖到 TICK_MS 之后。保留 async 是路由/测试的 Promise 契约。
    if (mode !== 'menu') this.touch(mode, campKey); // 审计 ARCH-03
    return structuredClone(this.snapshot(mode,campKey));
  },
  snapshot(mode, campKey) {
    // 第三轮 N1：请求里的 camp 不可用（格式错/未登记/过期）⇒ 按主营地服务。
    // 绝不把请求原语回显到 camp.name，也绝不让 survival 变 null（那是一个空世界）。
    const requested = campKey && campKey !== 'MAIN' ? String(campKey) : null;
    const key = requested && validCampKey(requested) ? requested : null;
    // SAV-05：格式合法但已失效（被 TTL 扫掉/文件丢失）的 key —— 明确告诉前端"该营地已回收"。
    const invalidCamp = requested && !key && /^[0-9a-f]{32}$/.test(requested) ? requested : null;
    const survSel = campSurv(key);
    const sum = (p, k) => Object.values(p.agents).reduce((s, a) => s + (a.counters[k] ?? 0), 0);
    const view = (p, layered) => ({
      t: p.world.t,
      phase: phaseOf(p.world.t), // L0 时钟：页面上"现在是什么时候"必须是世界事实，不是玩家猜的
      pantry: p.world.pantry,
      // PLAN §28：房间表/网格/天气/开关/铜币都是世界事实，前端按这份渲染（美术资源后接不影响结构）
      rooms: p.world.locs, grid: p.world.grid, outdoor: p.world.outdoor,
      weather: p.world.weather, features: p.world.features, coins: p.world.coins, things: p.world.things, companions: p.world.companions ?? [],
      ...(WORK_CAP === undefined ? {} : { workCap: WORK_CAP }), // §33 W3：上限是公开的世界事实，页面上要能追问"今天还收几次工"
      normLog: (p.world.normLog ?? []).slice(-10).map((e) => ({ t: e.t, of: p.agents[e.of]?.name ?? e.of, victim: p.agents[e.victim]?.name ?? e.victim, witnesses: (e.witnesses ?? []).map((w) => (w === 'p1' ? '你' : (p.agents[w]?.name ?? w))) })),
      loc: p.world.loc,
      occupancy: p.world.occupancy,
      stash: p.world.stash,
      // S3：你知道的事（玩家全知）与每条谁已经知道了。known 是 Set，出去前摊成数组
      secrets: (p.world.secrets ?? []).map((s) => ({ id: s.id, kind: s.kind, detail: s.detail, about: s.about, holder: s.holder, known: [...s.known].map((k) => p.agents[k]?.name ?? k) })),
      // 推理成本账（O11）：事件 / 被问 / 跳过 / 驳回重问 / 被告知
      cost: { 事件: sum(p, 'triggered'), 被问: sum(p, 'asked'), 跳过: sum(p, 'skipped'), 驳回重问: sum(p, 'askedRetry'), 被告知: sum(p, 'informed'), 反思: sum(p, 'reflect') },
      agents: Object.fromEntries(
        Object.values(p.agents).map((a) => {
          // layers = 这一侧现在叠着哪些可选层（开关状态）；下面的承诺/耦合读数 = 它当时真的被调用过。
          // 分开是必须的：刚切上开关还没走决策时 m3Last 仍是 null，此时不许摆一个空目标假装在运作。
          const layers = layered ? Object.fromEntries(Object.entries(S.masks).filter(([, v]) => v).map(([k]) => [k, 1])) : {};
          return [a.id, {
            id: a.id, name: a.name, archetype: a.traits.archetype, m: a.bank.snapshot(), baseline: a.traits.baseline, drives: { ...a.drives.v }, summary: a.bank.summary(), viab: { v: Number(a.viab.v.toFixed(3)), reserve: Number(a.viab.reserve.toFixed(3)), lost: a.viab.ledger.map((l) => l.organ) }, counters: a.counters, cfHistory: a.cfHistoryIncomplete ? 'incomplete' : null, coins: p.world.coins?.[a.id] ?? 0, rel: a.relations.dump(p.world.t), last: [...a.trace].reverse().find((r) => r.action) ?? null, reason: a.lastReason ?? '', sched: (p.world.scheduleWeight > 0 ? (() => { const s = scheduledLoc(a.traits.archetype, p.world.t); return s ? { should: LOCS[s], onTime: p.world.loc[a.id] === s } : null; })() : null),
            layers,
            m3: layers.m3 && a.m3Last ? { goal: a.m3Last.goal, previous: a.m3Last.previous, remaining: a.m3Last.remaining, reused: a.m3Last.reused, interrupted: a.m3Last.interrupted ?? null } : null,
            coupling: layers.coupling ? a.coupling.dump() : null,
            ...(WORK_CAP === undefined ? {} : { work: { cap: WORK_CAP, today: workUsedToday(p.world, a.id) } }),
          }];
        }),
      ),
      log: p.log.slice(-40),
      playerLog: (p.playerLog ?? []).slice(-12), // 玩家自己的动作与驳回：主日志窗口会把它们挤掉
      series: p.series.slice(-SERIES_CAP),
      viabCrit: PARAMS.viab.crit, // 曲线上的操作点参考线：跌破这里，存续才开始影响选择
      stat: p.stat,
    });
    return { ...(mode === 'compare' && {comparison: S.compareView, compareSaveError: S.compareSaveError, compareRunning: S.compareRunning}), savedAt: S.savedAt, tickMs:TICK_MS, running: S.running, mode: GAME_MODE, brain: CFG.brain, missed: S.missed, model: { ...S.model, budget: BUDGET, nodeBudget: NODE_BUDGET, watching: observerActive(S.lastVisitor, Date.now()), unattended: UNATTENDED_ON, paidWhenUnattended: PAID_WHEN_UNATTENDED, breaker: { open: breakerOpenAt(S.breaker), fails: S.breaker.fails, trips: S.breaker.trips ?? 0 } }, camp: key ? { key, name: S.camps?.live.get(key)?.name ?? key } : (invalidCamp ? { key: invalidCamp, invalid: true } : null), saveError: key ? S.campSaveErrors.get(key) ?? null : S.saveError, saveWrites: S.saveWrites ?? 0, schemaWarning: S.schemaWarning ?? null, tickError: S.tickError, masks: S.masks, layer: { commitment: PARAMS.m3.commitment, tau: PARAMS.coupling.tau, minInput: PARAMS.coupling.minInput }, survival: survSel ? { ...survView(survSel), model: { configured: modelConfigured(), enabled: CFG.brain === 'model', watching: observerActive(key ? S.campViewers[key] : S.viewers.survival, Date.now()), choices: S.model.survivalChoices ?? 0, chatter: S.model.chatter } } : null, A: view(S.packs.A, true), B: view(S.packs.B, false) };
  },
  act(body, campKey) {
    // P1c：正式连续世界（simClock 存在）里，talk_say/camp_sleep/compare 与普通 /act 共用
    // 同一把短状态锁，不再排进 tickChain；研究态没有 simClock，继续走旧完整写链。
    if (body?.mode === 'survival') {
      const sp = continuousCamp(campKey);
      if (sp?.world?.simClock) return actSurvivalFast(body, campKey);
    }
    if (body?.mode === 'compare' && GAME_MODE === 'game') return actComparisonFast(body);
    return queueWorldWrite(async () => {
      if (!S.packs) return { ok: false, error: 'NO_WORLD' };
      // Phase D：生存单世界动作独立路由（mode=survival），不落入 town A/B。
      if (body?.mode === 'survival' || body?.mode === 'compare') {
        if (body.mode === 'compare') return actInComparison(body);
        const reqCamp = campKey && campKey !== 'MAIN' ? String(campKey) : null;
        if (reqCamp && !validCampKey(reqCamp)) return { ok: false, code: 'CAMP_INVALID' };
        const survSel = campSurv(reqCamp);
        if (!survSel) return {ok:false,error:'NO_SURV'};
        if (body.kind === 'camp_sleep') return sleepSurvival(survSel);
        const result = await actInSurvival(survSel, body, modelTalk);
        if (result.ok || result.settled) return {...result, ...await persistAfterAction(survSel)};
        return result;
      }
      const kind = String(body?.kind ?? '');
      // H-20：旧版没有 kind 白名单。未知 kind 会一路落到末尾，记一条"走到undefined"的玩家日志
      // 却返回 ok:true（前端只看 ok）。显式拒绝。
      if (!['move', 'say', 'tell', 'hail'].includes(kind)) return { ok: false, error: 'UNKNOWN_KIND' };
      // BUG-7：房间名与目标 id 必须走 Object.hasOwn，不能靠真值判断。
      // `(locs ?? LOCS)[room]` 对 'toString' / 'constructor' / '__proto__' 会从原型链上读到函数而"通过校验"，
      // 随后 loc.p1 被写成 '__proto__'、occupancy['__proto__'].push 抛 TypeError，玩家从所有房间消失，
      // 而且这个坏态会被存档持久化 —— 远程一条 POST 即可触发，不需要鉴权。
      if (kind === 'move') {
        const room = String(body?.room ?? '');
        if (!room || !Object.hasOwn(S.packs.A.world.locs ?? LOCS, room)) return { ok: false, error: 'NO_LOC' };
        body = { ...body, room };
      }
      if (kind === 'hail' || kind === 'tell') {
        const target = String(body?.target ?? '');
        if (!target || !Object.hasOwn(S.packs.A.world.agents, target)) return { ok: false, error: 'NO_TARGET' };
        // H-20：world.hail 是单槽。允许 target='p1' 会让"喊住了 你"覆盖掉 NPC 的喊住状态。
        if (target === 'p1') return { ok: false, error: 'BAD_TARGET' };
        body = { ...body, target };
      }
      for (const key of ['A', 'B']) {
        const w = S.packs[key].world;
        // 房间名必须真实存在：上一版这里不校验，脚本传了个 undefined 就把玩家从 loc 里写没了
        // （JSON 会丢掉 undefined 键），整局之后都找不到"你"。
        if (kind === 'move' && w.loc.p1 !== body.room) {
          move(w, 'p1', body.room);
        }
        if (kind === 'say') {
          // PLAN §28 D：town 下按关键词意图映射为评价事件与信任增量；lab 保持旧的固定接触事件。
          const intent = w.speech ? classifySay(body.text) : { kind: 'contact', valence: 0.4, trust: 0 };
          for (const who of (w.occupancy[w.loc.p1] ?? []).filter((x) => x !== 'p1')) {
            w.pending.push({ for: who, evt: { kind: w.speech ? `say_${intent.kind}` : 'contact', valence: intent.valence, selfCaused: false, about: 'p1', serves: 'social' } });
            if (w.speech && intent.trust && w.agents[who]?.relations) w.agents[who].relations.meet('p1', w.t, { delta: { trust: intent.trust, familiarity: 0.02 }, why: `玩家说话(${intent.kind})` });
          }
        }
        // 喊住：隔着一间屋也能喊，被喊的人几刻内不换地方。玩家因此能追上人再传话（O12）
        if (body.kind === 'hail') {
          const r = hail(w, body.target, Number(body.ticks ?? 3));
          const who = w.agents[body.target]?.name ?? body.target;
          const text2 = r.ok ? `喊住了 ${who}（${r.until - w.t} 刻内不换地方）` : `喊不住 ${who}`;
          const rowH = { t: w.t, who: '玩家', kind: r.ok ? 'hail' : 'rej', text: text2 };
          S.packs[key].log.push(rowH);
          S.packs[key].playerLog = (S.packs[key].playerLog ?? []).concat(rowH).slice(-12);
          continue;
        }
        // S3：传话。规则层裁决能不能说（在场 / 知不知道 / 是不是重复），后果只走"被告知→评价"。
        // 两个世界各传一次：这是这个 demo 的对照前提——同一句话讲给两个世界。
        let text = body.kind === 'say' ? `说：${String(body.text ?? '').slice(0, 40)}` : `走到${body.room}`;
        if (body.kind === 'tell') {
          const r = tell(w, 'p1', body.target, body.secret, { presence: true });
          const who = w.agents[body.target]?.name ?? body.target;
          text = r.ok ? `把「${r.detail}」告诉了 ${who}` : `想告诉 ${who}，被驳回（${r.code}：${r.why}）`;
          const row = { t: w.t, who: '玩家', kind: r.ok ? 'tell' : 'rej', text };
          S.packs[key].log.push(row);
          // 玩家动作单独留一份：主日志只有最后 40 条，而三个角色每刻都在写，
          // 玩家自己那条几秒就会被挤出窗口——实测因此误判过一次"传话没生效"。
          S.packs[key].playerLog = (S.packs[key].playerLog ?? []).concat(row).slice(-12);
          continue;
        }
        const actRow = { t: w.t, who: '玩家', kind: 'act', text };
        S.packs[key].log.push(actRow);
        S.packs[key].playerLog = (S.packs[key].playerLog ?? []).concat(actRow).slice(-12);
      }
      return { ok: true, t: S.packs.A.world.t };
    });
  },
  ctl(body, campKey) {
    if (body.action === 'step' && body.mode === 'compare') {
      // 手动单步仍是显式 60 游戏分/侧；锁、publish 在 tickComparison 内，落盘在锁外。
      return tickComparison(Date.now(), {minutes: 60, explicit: true}).then(async (pair) => {
        if (!pair) return {...this.status(), ok: false, error: 'NO_COMPARISON'};
        return {...this.status(), ok: true, persisted: await saveComparison()};
      });
    }
    // 1.1 第 3 项：compare 的单侧/全局 pause、resume、rate 走同一把 compare 短锁。
    if (body.mode === 'compare' && ['pause', 'resume', 'rate'].includes(body.action)) {
      return controlComparison(body).then((result) => ({...this.status(), ...result}));
    }
    if (body.action === 'step') return manualTick().then(() => ({ ...this.status(), ok: true }));
    return queueWorldWrite(async () => {
      const known = ['pause', 'resume', 'rate', 'brain', 'reset', 'compare_reset', 'survival_reset', 'catchup', 'step', 'mask', 'v73_fixture', 'v73_state', 'quickstart_death', 'v13_state', 'v13_fixture', 'v12_state', 'v12_fixture'];
      // 1.2 浏览器验收夹具（V73_TEST=1 才生效；实装在 host-world，位置/占用的唯一写入口仍受静态闸门约束）。
      if (body.action === 'v12_state' || body.action === 'v12_fixture') return v12Fixture(body);
      // V7.3 第三批浏览器夹具：只在 V73_TEST=1 下暴露的受控接口（不进入生产默认路径）。
      if (body.action === 'v73_fixture') {
        if (process.env.V73_TEST !== '1') return { ok: false, code: 'DISABLED' };
        const sp = S.mainSurv ?? S.surv;
        if (!sp) return { ok: false, code: 'NO_SURVIVAL' };
        const w = sp.world;
        w.survival.sites = [{ type: 'shelter', loc: 'yard', progress: 0 }];
        w.pinv.p1 = { wood: 5, stone: 5 };
        w.survival.resStock.yard = 500;
        return { ok: true, code: 'OK' };
      }
      if (body.action === 'v73_state') {
        if (process.env.V73_TEST !== '1') return { ok: false, code: 'DISABLED' };
        const sp = S.mainSurv ?? S.surv;
        if (!sp) return { ok: false, code: 'NO_SURVIVAL' };
        const w = sp.world, s = w.survival, clock = s.actClock?.p1;
        return {
          ok: true, usedMin: clock?.tick?.usedMin ?? null,
          busy: clock?.busy ? { kind: clock.busy.kind, remainMin: clock.busy.remainMin, minutesDone: clock.busy.totalMin - clock.busy.remainMin } : null,
          cancelled: s.actionLedger?.player?.cancelled ?? {},
          events: (s.eventJournal?.rows ?? []).filter((e) => e.kind === 'player_action'),
          progress: s.sites?.[0]?.progress ?? null,
          energy: w.agents.p1?.drives?.v?.energy ?? null,
          t: w.t,
          store: s.store,
          mealsEaten: s.mealsEaten ?? 0,
          hallSite: w.campLayout?.sites?.hall ?? null,
          anchor: worldSite(w, w.loc.p1),
          playerPos: s.playerPos ?? null,
          bag: { wood: w.pinv?.p1?.wood ?? 0, stone: w.pinv?.p1?.stone ?? 0, crop: w.pinv?.p1?.crop ?? 0 },
          resStockYard: s.resStock?.yard ?? null,
          residents: Object.values(w.agents).filter((a) => !a.isPlayer).map((a) => ({
            id: a.id, loc: w.loc[a.id] ?? null, action: a.trace?.at(-1)?.kind ?? null, ok: a.trace?.at(-1)?.ok ?? null,
          })),
        };
      }
      if (body.action === 'pace_move_fixture') {
        // 2026-11-21 位移修复的浏览器夹具（仅 V73_TEST=1）：让一名居民立刻出发去别的区，
        // 供 evidence/pace-move-fix 用真实 /world 位置量“居民 10 秒真实位移”。
        // 只调用真实 startMove（不做任何位置写入），与游戏内居民出行同一条代码路径。
        if (process.env.V73_TEST !== '1') return { ok: false, code: 'DISABLED' };
        const sp = S.mainSurv ?? S.surv;
        if (!sp) return { ok: false, code: 'NO_SURVIVAL' };
        const w = sp.world, id = String(body.resident ?? 'a1');
        const from = w.loc?.[id] ?? null;
        const to = Object.keys(w.districts ?? {}).find((loc) => loc !== from) ?? null;
        if (!w.agents?.[id] || !to) return { ok: false, code: 'NO_DISTRICT' };
        startMove(w, id, to);
        const row = w.survival?.districtTravel?.[id] ?? null;
        return { ok: Boolean(row), id, from, to, length: row?.length ?? null,
          arriveMin: row?.arriveMin ?? null, arrive: row?.arrive ?? null, path: row?.path?.length ?? 0,
          // 诊断字段：确认被 tick 的世界就是被改的世界（证据脚本会落盘）。
          t: w.t, campKey: w.campKey ?? null, clockMinutes: w.simClock?.nowMinutes?.() ?? null,
          mainIsSurv: S.mainSurv === S.surv, tickError: S.tickError ?? null,
          loc: w.loc?.[id] ?? null, pos: w.pos?.[id] ?? null,
          travel: row ? { arriveMin: row.arriveMin, arrive: row.arrive, length: row.length, index: row.index ?? 0, cursor: row.cursor ?? null } : null };
      }
      if (body.action === 'quickstart_death') {
        // 浏览器验收夹具（仅 V73_TEST=1）：把玩家存续归零，验证“个人死亡后世界继续”的页面路径。
        if (process.env.V73_TEST !== '1') return { ok: false, code: 'DISABLED' };
        const sp = S.mainSurv ?? S.surv;
        if (!sp) return { ok: false, code: 'NO_SURVIVAL' };
        sp.world.agents.p1.viab.v = 0;
        settleSurvival(sp);
        return { ok: true, dead: Boolean(sp.world.agents.p1.dead), t: sp.world.t };
      }
      // 1.3 幽魂验收夹具（仅 V73_TEST=1）：只读状态 + 两个受控场景（睡梦中饿死 / 聚落灭绝）。
      if (body.action === 'v13_state') {
        if (process.env.V73_TEST !== '1') return { ok: false, code: 'DISABLED' };
        const sp = S.mainSurv ?? S.surv;
        if (!sp) return { ok: false, code: 'NO_SURVIVAL' };
        const w = sp.world, view = survView(sp);
        return {
          ok: true, t: w.t,
          clockMinutes: w.simClock?.nowMinutes?.() ?? null,
          rate: w.simClock?.rate ?? null,
          paused: w.simClock?.paused ?? null,
          running: S.running,
          population: Object.values(w.agents).filter((a) => !a.isPlayer && !a.dead).length,
          residentActions: Object.fromEntries(Object.entries(w.agents).filter(([id]) => id !== 'p1')
            .map(([id, a]) => [id, a.counters?.actions ?? 0])),
          player: { dead: Boolean(w.agents.p1?.dead), viab: w.agents.p1?.viab?.v ?? null, pos: w.pos?.p1 ?? null, loc: w.loc?.p1 ?? null },
          ghost: view.ghost ?? null,
          settlement: view.settlement ?? null,
          ended: view.ended, endReason: view.endReason,
          log: (sp.log ?? []).slice(-6),
        };
      }
      if (body.action === 'v13_fixture') {
        if (process.env.V73_TEST !== '1') return { ok: false, code: 'DISABLED' };
        const sp = S.mainSurv ?? S.surv;
        if (!sp) return { ok: false, code: 'NO_SURVIVAL' };
        const w = sp.world, s = w.survival, op = String(body.op ?? '');
        if (op === 'starve') {
          const v = Number(body.v ?? 0.0015);
          w.agents.p1.viab.v = Math.max(0, Math.min(Number.isFinite(v) ? v : 0.0015, 0.5));
          w.agents.p1.viab.reserve = 0;
          return { ok: true, op, viab: w.agents.p1.viab.v, t: w.t, clockMinutes: w.simClock?.nowMinutes?.() ?? null, loc: w.loc.p1 };
        }
        if (op === 'kill_residents') {
          for (const a of Object.values(w.agents)) if (!a.isPlayer) a.viab.v = 0;
          settleSurvival(sp);
          return { ok: true, op, population: Object.values(w.agents).filter((a) => !a.isPlayer && !a.dead).length, playerDead: Boolean(s.playerDead), ghost: Boolean(s.ghost?.active) };
        }
        return { ok: false, code: 'BAD_OP', op };
      }
      if (body.action === 'pause' || body.action === 'resume') {
        const key = body.mode === 'compare' ? 'compareRunning' : 'running';
        S[key] = body.action === 'resume';
        // P1：连续时钟要跟着宿主暂停/恢复，否则暂停期间真实时间仍在走，恢复时会凭空跳一段。
        if (body.mode !== 'compare') {
          const worlds = [S.mainSurv, S.surv, ...(S.camps?.live.values() ?? [])].filter(Boolean);
          const seen = new Set();
          for (const entry of worlds) {
            const clock = (entry.world ?? entry.sp?.world)?.simClock;
            if (!clock || seen.has(clock)) continue;
            seen.add(clock);
            clock[body.action]();
          }
        }
      }
      if (body.action === 'rate') {
        // P1c：倍速是时钟属性，不是第二套换算。在线调度、离线补时都读同一个 clock.rate。
        const rate = Number(body.rate ?? body.value);
        if (!Number.isFinite(rate) || rate < 0.1 || rate > 16) return { ...this.status(), ok: false, error: 'BAD_RATE' };
        const worlds = [S.mainSurv, S.surv, ...(S.camps?.live.values() ?? [])].filter(Boolean);
        const seen = new Set();
        for (const entry of worlds) {
          const clock = (entry.world ?? entry.sp?.world)?.simClock;
          if (!clock || seen.has(clock)) continue;
          seen.add(clock);
          clock.setRate(rate);
        }
        S.rate = rate;
        return { ...this.status(), ok: true, rate };
      }
      if (body.action === 'brain') {
        // H-02b：旧版这里调 buildPacks()，等于**静默把世界打回起点**（实测 t 5→0、stat.决策 15→0、
        // log 15→0），而日志里一个字都不写。用户点一下"内心：真实模型"就丢掉整段可见历史。
        // 正确做法是只换审议后端，世界不动：deliberator 是角色对象上的引用，就地换掉即可。
        configure({ brain: body.brain });
        const opts = survivalOptions();
        if (S.surv) setSurvivalDeliberator(S.surv, opts.deliberator, opts.chatModel, opts.playerSpeechModel);
    if (S.camps) for (const entry of S.camps.live.values()) setSurvivalDeliberator(entry.sp, opts.deliberator, opts.chatModel, opts.playerSpeechModel);
        for (const key of ['A', 'B']) {
          for (const a of Object.values(S.packs[key].agents)) a.deliberator = CFG.brain === 'model' ? modelBrain : null;
          S.packs[key].log.push({ t: S.packs[key].world.t, who: '系统', kind: 'mask', text: `内心切到${CFG.brain === 'model' ? '真实模型' : '本地替身'}（世界不重置）` });
        }
      }
      if (body.action === 'survival_reset') {
        if (body.confirm !== true) return { ...this.status(), ok: false, error: 'RESET_NEEDS_CONFIRM' };
        const old = campSurv(campKey);
        if (!old) return {...this.status(), ok:false, error:'NO_SURV'};
        let seed;
        do { seed = randomInt(1, 0x7fffffff); } while (seed === old.world.mapSeed);
        const next = createSurvPlay(seed, {...survivalOptions(), mapSeed:seed, layoutVersion:CURRENT_LAYOUT});
        const entry = S.camps?.live.get(campKey);
        if (entry) {
          next.world.campKey = entry.key;
          const replacement = {...entry, sp:next, lastUsed:Date.now(), lastSeenAt:Date.now()};
          if (!saveCampEntry(replacement)) return {...this.status(), ok:false, error:'SAVE_FAILED'};
          S.camps.live.set(entry.key, replacement);
        } else {
          const formerSurv = S.surv, formerMain = S.mainSurv;
          next.world.campKey = 'MAIN';
          S.surv = S.mainSurv = next;
          if (!await saveMain()) {
            S.surv = formerSurv;
            S.mainSurv = formerMain;
            return {...this.status(), ok:false, error:'SAVE_FAILED'};
          }
        }
        return {...this.status(), saveError:null, ok:true, mapSeed:seed};
      }
      if (body.action === 'compare_reset' && body.confirm !== true) {
        return { ...this.status(), ok: false, error: 'RESET_NEEDS_CONFIRM' };
      }
      if (body.action === 'compare_reset' && body.mode === 'compare') {
        const previous = S.comparison;
        const source = body.fromSurvival === true ? campSurv(campKey) : null;
        if (body.fromSurvival === true && !source) return {...this.status(), ok:false, error:'NO_SURV'};
        const origin = source ? structuredClone(dumpSurv(source)) : previous.origin;
        S.comparison = makeComparison(origin, previous.revision + 1);
        if (await saveComparison()) { publishComparison(); return {...this.status(), ok: true}; }
        S.comparison = previous;
        return {...this.status(), ok: false, error: 'SAVE_FAILED'};
      }
      if (body.action === 'reset' || body.action === 'compare_reset') {
        // 重置是从零刻新建世界，不是回到种子：这次会话的起点必须跟着改写，
        // 否则之后切一次 M3/M4 会把已经被丢掉的那个世界又拿回来。
        S.packs = freshPacks();
        if (body.action === 'reset') {
      S.surv=createSurvPlay(CFG.seed,survivalOptions());
      S.mainSurv=S.surv;
      // 审计 ARCH-07：重置后的新世界才是后续营地的 fork 起点。
      S.seedSurv = structuredClone(dumpSurv(S.surv));
      if (S.camps) S.camps.seedSurvival = structuredClone(dumpSurv(S.surv));
    }
        S.startRaw = structuredClone(serialize());
        // 补时记账属于被丢掉的那个世界：不清零的话，重置后的页面还会挂着「休眠 9.3 分钟后醒来」这句话，
        // 而那句话描述的是已经不存在的世界。savedAt 同时刷新，免得下次载入把重置前的空档也算进去。
        S.missed = { minutes: 0, applied: 0, capped: false };
        S.savedAt = Date.now();
        S.savedSignature = undefined; // 重置后的世界是全新内容，下一次 flush 必须真写一版
        S.catchupAt = {};
        S.catchupDay = {};
        await save();
      }
      if (body.action === 'catchup') {
        // H-19：minutes 来自 HTTP 载荷。NaN 会写成 {"minutes":null} 进 API 与存档；
        // 负数被照收；无限次 360 分钟补时能把三个人的 drives 压到 0。
        const m = Number(body.minutes ?? 30);
        if (!Number.isFinite(m) || m <= 0) return { ...this.status(), ok: false, error: 'BAD_MINUTES' };
        if (m > 720) return { ...this.status(), ok: false, error: 'TOO_MANY_MINUTES' }; // 审计 SEC-05
        const ck = campKey || 'MAIN';
        const now = Date.now();
        S.catchupAt ??= {};
        // SEC5-03：MAIN 与具名营地统一冷却；每日累计也按营地记，防止“等 5 秒再点一次”无限快进。
        if (catchupCooldownMs() > 0 && now - (S.catchupAt[ck] ?? 0) < catchupCooldownMs()) {
          return { ...this.status(), ok: false, error: 'CATCHUP_COOLDOWN' };
        }
        const dayKey = new Date(now).toISOString().slice(0, 10);
        S.catchupDay ??= {};
        if (S.catchupDay[ck]?.day !== dayKey) S.catchupDay[ck] = { day: dayKey, minutes: 0 };
        if (S.catchupDay[ck].minutes + m > catchupDayCapMin()) {
          return { ...this.status(), ok: false, error: 'CATCHUP_DAILY_CAP' };
        }
        S.catchupAt[ck] = now;
        S.catchupDay[ck].minutes += m;
        if (campKey && campKey !== 'MAIN') {
          const target=campSurv(campKey);
          if (!target) return {...this.status(),ok:false,error:'NO_SURV'};
          const summary=await catchUpSurvival(m,target);
          const persisted=await saveWorld(target);
          return {...this.status(),ok:persisted,persisted,catchup:summary,...(!persisted && {error:'SAVE_FAILED'})};
        }
        // P1c：正式连续世界只走 catchUpSurvival 一套 rate/step；A/B 的研究态补时不再参与正式。
        if (!(S.mainSurv ?? S.surv)?.world?.simClock) catchUp(m);
        await catchUpSurvival(m);
        await save(); // P1-8：手动补时也推进生存世界
      }
      // 暂停状态下的"单步"必须真的推进一刻（走同一把锁，排队而不是绕过）
      if (body.action === 'mask') {
        const key = body.key;
        // BUG-7 同族：`key in S.masks` 对 'toString' / '__proto__' 会走原型链而"通过校验"，
        // 随后 S.masks 被写进一个不该存在的键。这里同样只认自有属性。
        if (!Object.hasOwn(S.masks, key)) return { ...this.status(), ok: false, error: 'UNKNOWN_MASK' };
        const next = Boolean(body.on);
        const masks = body.mode === 'compare' ? S.comparisonMasks : S.masks;
        if (next === masks[key]) return {...this.status(), ok: true};
        masks[key] = next;
        if (body.mode === 'compare') {
          const previous = S.comparison;
          S.comparison = makeComparison(previous.origin, previous.revision + 1);
          if (await saveComparison()) { publishComparison(); return {...this.status(), ok: true}; }
          S.comparison = previous;
          masks[key] = !next;
          return {...this.status(), ok: false, error: 'SAVE_FAILED'};
        }
        buildPacks();
        const label = key === 'm3' ? 'M3 目标承诺层' : 'M4 耦合调制权';
        const t = S.packs.A.world.t;
        for (const k of ['A', 'B']) {
          S.packs[k].log.push({ t, who: '系统', kind: 'mask', text: `${label}${next ? '开' : '关'}（只作用于 A 侧）· 两个世界回到第 ${t} 刻起点重放` });
        }
      }
      // 未知动作必须明说：上一版这里对任何 action 都返回 status()，界面点了没反应也显示"成功"。
      if (!known.includes(body.action)) return { ...this.status(), ok: false, error: 'UNKNOWN_ACTION' };
      return { ...this.status(), ok: true };
    });
  },
  save: () => queueWorldWrite(save),
};

export const DIMS_LIST = DIMS;
