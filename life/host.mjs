import { CURRENT_LAYOUT } from '../shared/layout-version.mjs';
import { randomInt } from 'node:crypto';
// 权威世界宿主：状态在服务器上持续演化，浏览器只是观察与介入的窗口。
// 三件事是这里的核心，不是装饰：
//   1) 持久化：状态落 DATA_DIR；平台无持久卷时（创空间实测）靠内置种子回到固定历史起点
//   2) 时间差推进：免费创空间会休眠。醒来后必须把「没人看的那段时间」补进内部状态，
//      否则「内部状态持续存在」这个主张在演示现场就会被戳穿。
//   3) 只补状态、不补决策：休眠期间没有观察者，编造那段时刻的行为等于伪造历史。
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { makeWorld, spawn, scanSecrets, LOCS, hail, workUsedToday } from './body.mjs';
import { phaseOf, scheduledLoc, weatherFor, dayOf } from './clock.mjs';
import { presetOf } from './presets.mjs';
import { speechLine, classifySay } from './speech.mjs';
import { openTalk, sayTo, closeTalk } from './dialogue.mjs';
import { tell } from './gossip.mjs';
import { socialRound } from './social.mjs';
import { Organism } from './agent.mjs';
import { hashSeed, CURRENT_EVENT_RULES } from './rng.mjs';
import { DIMS } from './traits.mjs';
import { preferenceBands } from './model.mjs';
import { withNoThink, withoutNoThink } from './model-adapter.mjs';
import { PARAMS } from './params.mjs';
import { validateM5State } from './m5-bank.mjs';
import { campSleepTicks } from './camp-play.mjs';
import { parseSay } from './intent.mjs';
import { CampInstances, listSaves, normalizeName, sweepSaves, validCampArchive, readIndex, writeIndex } from './camp-instances.mjs';
import { createSurvPlay, tickSurvPlay, survAct, survView, dumpSurv, loadSurv, setSurvivalDeliberator, settleSurvival, cancelPlayerBusy } from './survplay.mjs';
import { isFreeProvider as freeProvider, modelChannel, breakerOpenAt, budgetTick, observerActive as observerActiveBase, pickProviderKey, createBudgetDomain } from './host-budget.mjs';
import { createViewerDomain } from './host-viewers.mjs';
import { createWriteQueue, createCoalescer, writeArchiveAtomic, readArchiveFile, quarantineArchive, publicSaveError } from './host-saves.mjs';
export { modelChannel, breakerOpenAt, budgetTick, pickProviderKey };
// host 的对外签名保留默认 PRESENCE_MS（纯函数本体在 host-budget，不认识 env）。
export function observerActive(lastVisitor, now, presenceMs = PRESENCE_MS) {
  return observerActiveBase(lastVisitor, now, presenceMs);
}

const ROSTER = [
  { id: 'a1', name: '岑', archetype: '谨慎', loc: 'home' },
  { id: 'a2', name: '绛', archetype: '冲动', loc: 'hall' },
  { id: 'a3', name: '蓑', archetype: '孤僻', loc: 'watch' },
];
// 机制侧启动配置；默认关闭，不新增演示 masks/ctl，也不为 C2-neg 开启。
const M5_ENABLED = process.env.M5_ENABLED === '1';
// §33 工坊当日上限：不设（缺省）＝无上限＝现行为逐位相同。设成数字即"工坊一天收几次工"这条世界事实，
// 它属于世界配置而非内部通道，所以 A/B 两侧同样生效（B 侧是内部状态切断的负向对照，不是规则差异的对照）。
const WORK_CAP = process.env.WORK_CAP === undefined || process.env.WORK_CAP === '' ? undefined : Number(process.env.WORK_CAP);
const TICK_MS = Number(process.env.TICK_MS ?? 7500); // §14 统一游戏时间：24 刻/天 × 7.5s = 3 分钟/天（env 可覆盖）
// P1-7 运行模式：research（默认）每拍同推 A/B 研究世界＋生存；game 仅推进生存世界（正式游戏省算力）。
// 默认 research ⇒ 现行为逐位不变；game 为显式 opting-in，不影响 lab/sweep（它们走 simulate/run，不经 host tick）。
const GAME_MODE = process.env.GAME_MODE === 'game' ? 'game' : 'research';
const CATCHUP_CAP_MIN = Number(process.env.CATCHUP_CAP_MIN ?? 360); // 最多补 6 小时，再多就如实标「被截断」
const SURV_CATCHUP_CAP = Number(process.env.SURV_CATCHUP_CAP ?? 120); // P1-8 生存离线补时刻上限（默认 120 刻＝5 游戏日），超长截断
// DATA5-14：分营地 tick 的整拍墙钟预算。默认 0 = 关（研究态行为逐位不变）；设了就在预算用尽时跳过剩余营地，
// 并把跳过次数暴露到 status.campTickSkipped，避免慢模型把整拍拖到下一拍。
const campTickBudgetMs = () => {
  const n = Number(process.env.CAMP_TICK_BUDGET_MS ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
};
// SEC5-03：手动补时（/ctl catchup）对 MAIN 也设冷却与每日上限；启动时的离线补时不受影响。
// 读取放在调用时（测试会临时覆盖 env，不能只读一次）。
const catchupCooldownMs = () => {
  const n = Number(process.env.CATCHUP_COOLDOWN_MS ?? 60000);
  return Number.isFinite(n) && n >= 0 ? n : 60000;
};
const catchupDayCapMin = () => {
  const n = Number(process.env.CATCHUP_DAY_CAP_MIN ?? 720);
  return Number.isFinite(n) && n > 0 ? n : 720;
};
// 存档格式版本。旧档没有这个键 ⇒ 视为 1，照旧 tolerant 载入（线上部署不能因为加版本号而起不来）。
// 更高版本也不拒载，只留一条警告：否则回滚到旧程序会把正在跑的实例卡死。
const ARCHIVE_VERSION = 1;
// 动作落盘合并窗口（毫秒）。默认 0 ＝ 每个成功动作立即整档落盘（当前行为，逐位不变）。
const ACT_SAVE_COALESCE_MS = Number(process.env.ACT_SAVE_COALESCE_MS ?? 0) || 0;
const SAVE_EVERY = 10;
const SERIES_CAP = Number(process.env.SERIES_CAP ?? 720); // 存续曲线保留多少刻（默认 12 分钟实时）
// BUG-14：每个角色保留多少条 trace。实测 4.19 KB/行、6.49 行/刻 ⇒ 生产 TICK_MS=6000 时
// 无上限约 628 MB/天。2000 行 ≈ 8 MB/角色，足够页面/装置读取，又不会把容器撑爆。
// 默认从 2000 → 400（2026-11-15 压测）：trace 只用于诊断、不落盘也不参与决策，
// 实测把 heap 从 ~166MB 压到 ~118MB、RSS 从 ~433MB 压到 ~373MB，存档体积不变。
const TRACE_CAP = Number(process.env.TRACE_CAP ?? 400);
// 单拍模型调用上限。默认 **0 = 不设上限 = 现行为逐位不变**。
// 为什么需要它：真实模型链路实测一拍最多发 8 次调用（3 角色 × 2 侧 + 2 次驳回重问），
// 每次约 600 ms ⇒ 单拍最坏 ~4.7 s；而线上 TICK_MS=6000，已经贴着边界。
// 设成 N 就把单拍调用钳到 N，保证每拍都能在 interval 内跑完（代价是那一拍有些角色退回替身）。
// 正式游戏默认钳 2 次/拍；research 默认 0 = 不限（保护既有轨迹）。
const PER_TICK_CAP = Number(process.env.MAX_CALLS_PER_TICK ?? (GAME_MODE === 'game' ? 2 : 0));
// 单次模型等待上限与整拍模型等待预算：慢端点不能把世界/玩家动作长期卡住。
const MODEL_TIMEOUT_MS = Number(process.env.MODEL_TIMEOUT_MS ?? (GAME_MODE === 'game' ? 4000 : 20000));
const MODEL_TICK_BUDGET_MS = Number(process.env.MODEL_TICK_BUDGET_MS ?? (GAME_MODE === 'game' ? 3000 : 0));

const CFG = { providers: [], keys: [], model: '', models: [], deliberationModel: '', seed: Number(process.env.SEED ?? 7), brain: 'local' };
// 调用预算闸门：线上审议路径必须与离线脚本同源受控，否则"MAX_CALLS"只是文档里的装饰（真实风险：无上限烧第三方余额）
// 语义是**每日**额度：魔粒按天回血（签到 250），预算跟着按天归零，否则 60 次烧完整段剩余时间都是替身
const BUDGET = Number(process.env.MAX_CALLS ?? 120);
// 两把尺子：`MAX_CALLS` 数**钱**（托管推理/第三方），`NODE_CALLS_DAY` 数**电**（自有节点或本机中继）。
// 旧版只有前者：实测无人全开的询问率≈4 次/分（5790 次/现实日），拿钱的额度去闸只花电的链路会在 2 小时内掐死模型，
// 反过来让免费链路也计入 calls 又会让"还剩多少魔粒"这个读数失真。所以分账：calls 仍是总量，moneyCalls/nodeCalls 各归各。
const NODE_BUDGET = Number(process.env.NODE_CALLS_DAY ?? (GAME_MODE === 'game' ? 12000 : 0)); // 0 = 不限（research 默认）
// 无人观看时是否仍上真模型：游戏默认开（世界要自洽），研究默认关（既有轨迹逐位不变）。
const UNATTENDED_ON = String(process.env.MODEL_UNATTENDED ?? (GAME_MODE === 'game' ? '1' : '0')) === '1';
const UNATTENDED_ASK_CAP = Number(process.env.UNATTENDED_CALLS_PER_TICK ?? 1);
// 无人时禁止付费回退：节点没答上来就退回确定性替身。宁可这一拍不用模型，也不在没人看的时候花魔粒。
const PAID_WHEN_UNATTENDED = String(process.env.MODEL_PAID_UNATTENDED ?? '0') === '1';
// 中继熔断：连续失败若干次就冷一段，避免每次询问都白等一个 TTL。
const BREAKER_FAILS = Number(process.env.MODEL_BREAKER_FAILS ?? 3);
const BREAKER_MS = Number(process.env.MODEL_BREAKER_MS ?? 60000);
// 免费端点的判定：回环＝自己人（创空间的模型中继就是 127.0.0.1 上的一个路径），其余按主机名白名单追加。
// PAID_MODEL_HOSTS 是反向覆盖：某些主机名（哪怕解析到本机）确实要花钱，或测试需要把两条路区分开。
const FREE_HOSTS = (process.env.FREE_MODEL_HOSTS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const PAID_HOSTS = (process.env.PAID_MODEL_HOSTS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
export function isFreeProvider(base) {
  return freeProvider(base, { freeHosts: FREE_HOSTS, paidHosts: PAID_HOSTS });
}
const ATTEMPT_CAP = 20;
// 有观众才上真模型：无人访问时走替身（0 成本），有人打开页面才调模型。
// 依据是 1 魔粒≈2 次旗舰调用、签到 250/天=500 次/天，全天不间断约需 2880 魔粒，必须按在场性省。
const PRESENCE_MS = Number(process.env.PRESENCE_MS ?? 180000);
// 纯函数便于闸门测试：最近有人在看才允许调用
import { modelLaneFor } from './camp-lane.mjs';
import { worldSite } from './geometry.mjs';
import { createReplay, recordReplayFrame, replayRange, replayPoint } from './replay-history.mjs';
export { modelLaneFor };

// BUG-8：应用层的其它模型入口（serve.mjs 的 /chat 转发）必须走**同一套**预算与在场闸门，
// 否则 MAX_CALLS 只对世界内部那条路径有效，旁路照样能把额度烧光。
// H-04：必须**先预扣再放行**（预算域内部实现），facade 只保留原签名。
let budget;
export const modelGate = () => budget.gate();
export const modelRelease = () => budget.release();
export const modelChargeLane = (free) => budget.chargeLane(free);
export const modelCharged = (tokens = 0) => budget.charged(tokens);
// 演示侧的 M3/M4 开关：机制侧默认关（channelMask 不传），这里只决定这一页要不要把这一层接上。
// 不落地存档：刷新或重部署回到默认关，免得"默认关"这句只在文档里成立。
// startRaw 是这次会话的世界起点快照，切开关时两个世界都回到这里（见 replayLayers）。
// BUG-17：SIGINT/SIGTERM 处理器必须能摘掉。start() 每调一次就 process.on 一次，
// 而 stop() 只 clearInterval 不移除监听器 ⇒ 测试里 start×3 就有 6 个监听器（实测），
// 每次信号会重复 save，最后还会撞 MaxListenersExceededWarning。
let sigHandlers = null;
let shuttingDown = false;
// DATA5-02/03：SIGTERM/SIGINT 必须等所有在途/已排的写落地；任何一个营地档失败都以非零码退出，
// 不能把“只保存了一部分”伪装成成功。flushWrites 本身会强制再保存一版。
async function onSignal() {
  if (shuttingDown) return;
  shuttingDown = true;
  S.running = false;
  if (S.timer) { clearInterval(S.timer); S.timer = null; }
  if (S.sweepTimer) { clearInterval(S.sweepTimer); S.sweepTimer = null; }
  let ok = true;
  let reason = null;
  try {
    if (S.comparison) {
      const savedCompare = await queueWorldWrite(saveComparison);
      if (!savedCompare) { ok = false; reason = S.compareSaveError ?? 'COMPARE_SAVE_FAILED'; }
    }
    const flushed = await flushWrites();
    if (!flushed.ok) { ok = false; reason = flushed.saveError ?? 'SAVE_FAILED'; }
  } catch (error) {
    ok = false;
    reason = publicSaveError(error);
  }
  if (!ok) {
    console.error(`[host] 关机前保存未完成：${String(reason ?? 'SAVE_FAILED').slice(0, 120)}`);
    process.exit(1);
  }
  process.exit(0);
}

const S = { comparison: null, compareView: null, compareSaveError: null, compareRunning: true, comparisonMasks: {m3: false, coupling: false}, packs: null, timer: null, tickError: null, running: true, savedAt: 0, missed: { minutes: 0, capped: false }, model: { calls: 0, tokens: 0, moneyCalls: 0, nodeCalls: 0, attempts: [], dayKey: '' }, breaker: { fails: 0, openUntil: 0 }, campKey: null, campName: null, campViewers: {}, mainSurv: null, seedSurv: null, camps: null,
  lastVisitor: 0, viewers: { survival: 0, compare: 0, comparison: 0 }, saveError: null, // 用 getter 而不是加载时常量：测试常在同一进程里换 DATA_DIR（换目录模拟重启），\
  // 加载时读死会让写入落回仓库的 ./data（2026-11-15 覆盖率下暴露的真实污染）。\
  get dir() { return process.env.DATA_DIR ?? 'data'; }, masks: { m3: false, coupling: false }, startRaw: null, surv: null };

// 领域模块只拿状态引用，不持有第二份单例；host 保留 facade 与原对外 API。
budget = createBudgetDomain({
  getState: () => S, budget: BUDGET, nodeBudget: NODE_BUDGET, presenceMs: PRESENCE_MS,
  breakerFails: BREAKER_FAILS, breakerMs: BREAKER_MS,
});
const viewers = createViewerDomain({
  getState: () => S, presenceMs: PRESENCE_MS,
  validCampKey: (key) => validCampKey(key),
  markSeen: (key, at) => {
    const liveCamp = S.camps?.live.get(key);
    if (!liveCamp) return;
    try { S.camps.markSeen(liveCamp, at); } catch { /* 本拍和清扫仍使用内存中的真实访问时间。 */ }
  },
});
const writeQueue = createWriteQueue();
let saveCoalescer = null;

export function configure({ providers = [], keys = [], model = '', models = [], deliberationModel, seed, brain } = {}) {
  if (providers.length) CFG.providers = providers.map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
  if (keys.length) CFG.keys = keys.map(s => String(s ?? '').trim());
  if (model) CFG.model = model;
  if (models.length) CFG.models = models.map((s) => String(s ?? '').trim());
  // 审议车道单独指引擎：只在只花电的节点路上生效。显式传空串就是要关掉，所以判 undefined 而不是判真假。
  if (deliberationModel !== undefined) CFG.deliberationModel = String(deliberationModel ?? '').trim();
  if (seed) CFG.seed = seed;
  if (brain) CFG.brain = brain;
}

// 通道掩码：只有 A 侧可能被叠上 M3/M4。B 侧永远按登记的 C2-neg 定义走——
// 承诺层与耦合动作的内容本身就是"内部状态进决策"，在 B 侧打开等于把已切断的通道又接回去，
// 那一条负向对照就不再是负向对照了。
function maskForA() {
  const on = Object.fromEntries(Object.entries(S.masks).filter(([, v]) => v).map(([k]) => [k, 1]));
  return Object.keys(on).length ? on : undefined;
}

function makePack(condition, channelMask) {
  const engineMask = condition === 'C2' && M5_ENABLED ? { ...channelMask, m5: 1 } : channelMask;
  // F1（PLAN §26）：这里历史上写 stash:5 但它是死旋钮（实际恒 3），种子存档也按 3 生成；
  // 修复死旋钮后为保持演示逐位不变，去掉这个从未生效的参数，而不是把演示改成 5。
  // PLAN §28：演示世界用 town 预设（8 房间/物件/天气/台词/传闻）；lab 只给离线实验用。
  const world = makeWorld({ pantries: 3, preset: 'town', seed: CFG.seed, socialGossip: 1 });
  if (WORK_CAP !== undefined) world.workCap = WORK_CAP; // 缺省不设 ⇒ 下面所有 workLog 相关载荷都不出现，页面与存档逐字节不变
  const agents = {};
  for (const r of ROSTER) {
    const a = new Organism({ ...r, seed: hashSeed(CFG.seed, `${r.id}:${condition}`), condition, channelMask: engineMask, deliberator: CFG.brain === 'model' ? modelBrain : null });
    agents[r.id] = a;
    world.agents[r.id] = a;
    spawn(world, r.id, r.loc);
  }
  world.agents.p1 = { id: 'p1', name: '你', isPlayer: true };
  spawn(world, 'p1', 'hall');
  return { world, agents, condition, log: [], series: [], stat: { 决策: 0, 高冲动: 0, 越轨: 0, 驳回: 0, 发现: 0, 传闻: 0 } };
}

// BUG-5 / BUG-6：一次装载 = 上一对全新的 pack，把存档从**深拷贝**里读进去。
// 深拷贝是必须的：applyInto 会把 log/series/stat/loc/stash/expect 按引用挂到活世界上，
// 直接传 startRaw.A 会让这一局对世界的写入反向污染"会话起点"，
// 于是"切开关＝回到本回合起点重放"变成假的（实测 t 归 0 但 stat.决策=15、series 里还留着"未来"行）。
const freshPacks = () => ({ A: makePack('C2', maskForA()), B: makePack('C2-neg') });
const packsFrom = (raw, opts = {}) => {
  const next = freshPacks();
  if (raw) {
    applyInto(next.A, structuredClone(raw.A), opts);
    applyInto(next.B, structuredClone(raw.B), opts);
  }
  return next;
};

// 解析 + 形状校验 + 装载。H-25：parse 成功但结构不完整（实测出现过 `{}`）不能被当成
// "载入存档 t=0"——那会让 note 谎报、原档又被下一次 save 覆盖。这里显式判成 ARCHIVE_SHAPE。
function loadArchive(text, opts = {}) {
  const raw = JSON.parse(text);
  // schemaVersion：缺失＝旧档（视为 1）；更高＝兼容模式 + 警告，绝不拒载。
  if (raw && typeof raw === 'object') {
    const v = raw.schemaVersion;
    if (typeof v === 'number' && Number.isFinite(v) && v > ARCHIVE_VERSION) {
      S.schemaWarning = `存档版本 ${v} 高于本程序 ${ARCHIVE_VERSION}，已按兼容模式载入`;
    } else if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v))) {
      S.schemaWarning = '存档的 schemaVersion 不是数字，已忽略该字段';
    }
  }
  // H-25：parse 成功但结构不完整（实测出现过 `{}`）不能被当成"载入成功 t=0"
  // H-33：t 的类型也必须校验。`t = undefined` 会让 t+1 = NaN，而 NaN%10===0 恒假
  // ⇒ 世界照跑但从此**永不存盘**（静默数据丢失），并且 series.t 会变成 JSON null。
  const badT = (x) => typeof x !== 'number' || !Number.isFinite(x) || x < 0;
  if (!raw || typeof raw !== 'object' || !raw.A?.world || !raw.B?.world || badT(raw.A.world.t) || badT(raw.B.world.t)) {
    const e = new Error('存档结构不完整或字段类型非法（A/B.world.t 必须是有限非负数）');
    e.code = 'ARCHIVE_SHAPE';
    throw e;
  }
  if (!opts.skipM5) preflightM5Archive(raw);
  return { raw, packs: packsFrom(raw, opts) };
}

// 验证整个候选档案，再由启动入口一次提交世界。磁盘读取/坏 M5 回退在 host-saves。
async function readArchive(path) {
  const { loaded, warning } = await readArchiveFile(path, { decode: (text, opts = {}) => loadArchive(text, opts) });
  const survival = loaded.raw.survival;
  if (survival != null && !validCampArchive(survival)) {
    throw new Error('生存存档结构不完整');
  }
  const surv = loadSurv(survival, CFG.seed, { ...survivalOptions(), adoptArchivedRules: true, upgradeLegacyEventRules: true });
  survView(surv); // 同时验证首个读请求依赖的生存结构
  return { ...loaded, surv, warning };
}

async function quarantine(worldFile) {
  return quarantineArchive(S.dir, worldFile);
}

// 切一次开关 = 换一个独立变量重跑，而不是在半路上改规则：
// 两个世界都回到这次会话的起点，只有 A 侧带上这一层，页面上的 t 仍然对齐。
function buildPacks() {
  S.packs = packsFrom(S.startRaw);
}

const providerKey = i => pickProviderKey(CFG.keys, i, CFG.providers.length);

function modelConfigured() {
  return CFG.providers.some((_, i) => providerKey(i) && (CFG.models[i] || CFG.model));
}

// 导出给离线工具（scripts/seed-ladder.mjs）复用：公开演示起点必须用运行时同一套生存配置生成，
// 否则烘出来的营地在正式模式下装不回来。
// 命名营地：同一时刻只服务一份（多营地并发留给 C3 的三态调度）。
function campManager() {
  if (!S.camps) {
    if (!S.seedSurv) S.seedSurv = structuredClone(dumpSurv(S.mainSurv ?? S.surv));
    S.camps = new CampInstances({ dataDir: S.dir, options: { ...survivalOptions(), adoptArchivedRules: true, upgradeLegacyEventRules: true }, limit: 6, seedSurvival: S.seedSurv });
  }
  return S.camps;
}

// TTL 清扫：删 3 天无活跃的分名字营地；**正在被观看的绝不删**（先查观看计数再动文件）。
export function sweepCamps({ now = Date.now() } = {}) {
  const result = sweepSaves(S.dir, {now,
    lastSeenAt: key => S.camps?.live.get(key)?.lastSeenAt,
    isWatched: key => observerActive(S.campViewers[key],now),
  });
  for (const key of result.removed) {
    delete S.campViewers[key];
    S.camps?.live.delete(key);
    S.campSaveErrors?.delete(key);
  }
  return result;
}

// 按营地 key 取世界：MAIN 走主世界，其它走实例管理器（live 或磁盘）。
// camp 键是否可用：MAIN 恒可；分名字营地必须 32hex 且能取到（live 或已登记）。
export function validCampKey(campKey) {
  if (!campKey || campKey === 'MAIN') return true;
  return campSurv(campKey) != null;
}

// 观测用：非法键不得留痕（第三轮 §3），也给 healthz/测试一个读法。
export function campViewerKeys() {
  return viewers.keys();
}

export function campSurv(campKey) {
  if (!campKey || campKey === 'MAIN') return S.mainSurv ?? S.surv;
  if (!/^[0-9a-f]{32}$/.test(String(campKey))) return null; // P0-2：第二道闸
  if (!S.surv) return null;
  const camps = campManager();
  const live = camps.live.get(campKey);
  if (live) { live.lastUsed = Date.now(); return live.sp; }
  try { return camps.openKey(campKey); }
  catch (cause) {
    const error = new Error('当前营地暂时无法载入',{cause});
    error.code = 'CAMP_UNAVAILABLE';
    throw error;
  }
}

export function listCamps() {
  return listSaves(S.dir, Date.now());
}

// SEC3-02：营地归属。索引只存所有者令牌的 sha256，不存原值。
export function campOwnerHash(key) {
  const entry = readIndex(S.dir).entries.find((e) => e.key === key);
  return entry?.ownerHash ?? null;
}
export function claimCamp(key, hash) {
  if (!key || !hash) return { ok: false, code: 'BAD_CLAIM' };
  const idx = readIndex(S.dir);
  const entry = idx.entries.find((e) => e.key === key);
  if (!entry) return { ok: false, code: 'NO_CAMP' };
  if (entry.ownerHash) return { ok: true, claimed: false, owned: entry.ownerHash === hash };
  entry.ownerHash = hash;
  writeIndex(S.dir, idx);
  return { ok: true, claimed: true, owned: true };
}

// 进场：先落当前营地，再把指定名字的营地切为当前世界。返回不进游戏时只读的摘要。
export function openCamp(name) {
  return queueWorldWrite(() => openCampInQueue(name));
}

function openCampInQueue(name) {
  const id = normalizeName(name);
  if (!id.ok) return { ok: false, code: id.code };
  if (!S.surv) return { ok: false, code: 'NO_SURVIVAL' };
  const mgr = campManager();
  let opened;
  try { opened = mgr.open(id.display); }
  catch { return {ok:false, code:'SAVE_FAILED'}; }
  if (!opened.ok) return opened;
  if (!S.mainSurv) S.mainSurv = S.surv;
  S.mainSurv.world.campKey = 'MAIN';
  opened.sp.world.campKey = opened.key;
  // 不换 S.surv：每个请求按 cookie 选世界（多营地并发）。这里只记最后一次选择供兼容读。
  S.campKey = opened.key;
  S.campName = id.display;
  S.lastVisitor = Date.now();
  return {
    ok: true, code: 'OK', key: opened.key, name: id.display,
    day: Math.floor((opened.sp.world.t ?? 0) / (opened.sp.world.dayTicks ?? 24)),
    population: Object.values(opened.sp.world.agents).filter((a) => !a.dead && !a.isPlayer).length,
  };
}

// 回到主营地（浏览器刷新后就是它）。
export function backToMainCamp() {
  return queueWorldWrite(backToMainCampInQueue);
}

async function backToMainCampInQueue() {
  if (!S.campKey) return { ok: true, code: 'OK', already: true };
  await save();
  if (S.mainSurv) { S.surv = S.mainSurv; S.surv.world.campKey = 'MAIN'; }
  S.campKey = null;
  S.campName = null;
  return { ok: true, code: 'OK' };
}

// V7.2 阶段 B：正式游戏默认走角色个人时间（一天 1440 分）；V72_TIME=0 是退回旧"每刻 100 点预算"的兼容开关。
export function survivalOptions() {
  return { residentialDecisions: true, eventRulesVersion: CURRENT_EVENT_RULES, ecosystem: true, unifiedCooperation: true, independentWorld: true, wildFood: true, autonomousGoals: true, farmLife: true, settlementLife: true, regionalWork: true, playerRation: true, actTimeModel: process.env.V72_TIME !== '0', gameRules: process.env.GAME_RULES === '1', discussions: process.env.SETTLEMENT_DISCUSSIONS !== '0', deliberator: CFG.brain === 'model' ? modelBrain : null };
}

// D3：Qwen3.8 才带关闭思考参数；端点不认（400/422）时同一次尝试内去掉参数重试。
async function postChat(provider, key, body, mdl, ac) {
  const url = `${provider}/chat/completions`;
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${key}` };
  const send = (payload) => fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: ac.signal });
  let res = await send(withNoThink(body, mdl));
  if (!res.ok && (res.status === 400 || res.status === 422) && withNoThink(body, mdl).chat_template_kwargs) {
    S.model.attempts.push('RETRY_NO_KWARGS');
    if (S.model.attempts.length > ATTEMPT_CAP) S.model.attempts.shift();
    res = await send(withoutNoThink(withNoThink(body, mdl)));
  }
  return res;
}

// 提示词构造单独成函数：影子对照（DM-1）要用**与生产逐字相同**的提示词问另外几台引擎，
// 任何在测试脚本里重写一遍提示词的做法都会把对照变成两套问题，所以这里只有一份。
export function buildDeliberationPrompt({ agent, scored, world, rejected, memories, trigger, daySummary }) {
  const here = world.loc[agent.id];
  const bands = preferenceBands(scored, agent.ch);
  const present = (world.occupancy[here] ?? []).filter((x) => x !== agent.id && (world.survival || x !== 'p1')).map((x) => world.agents[x]?.name ?? x);
  const dom = agent.drives.dominant();
  const lines = [
    `你是${agent.name}（${agent.traits.archetype}型）。第 ${world.t} 刻，你在${here}。`,
    `为什么现在问你：${trigger}`, // ⑧ 事件门控：没有事件就不会被问到，所以这行永远有内容
    `内部读数：${agent.bank.summary()}`,
    `此刻你最缺：${dom.label}（偏差 ${dom.e.toFixed(2)}，紧迫度 ${dom.urgency.toFixed(2)}）`,
    world.survival
      ? `生存营地：公共食物 ${world.survival.store} 份，水 ${world.survival.water.toFixed(2)}，个人木料 ${world.pinv?.[agent.id]?.wood ?? 0}、石料 ${world.pinv?.[agent.id]?.stone ?? 0}。在场的人：${present.join('、') || '没有'}`
      : `世界事实：公仓余 ${world.pantry} 份；你自己门口存着 ${world.stash[agent.id]} 份（你以为该有 ${world.expect[agent.id]} 份）；在场的人：${present.join('、') || '没有'}`,
    `你想起的事：${memories?.length ? memories.map((m) => `${m.kind}(相似${m.sim})`).join('、') : '暂无'}`,
    daySummary ? `上一天的自己：${daySummary}` : '', // ⑦ 反思回合的产物；关掉开关后这行必须消失
    '可做的事（只能选一项，id 照抄）：',
    ...[...scored].sort((a, b) => (a.id < b.id ? -1 : 1)).map((s) => `- ${s.id} | ${s.act.label} | ${bands[s.id] ?? '同档'}`),
  ].filter(Boolean);
  if (rejected) lines.push(`你上次想做 ${rejected.from} 被驳回：${rejected.why}。这次换一个可行的。`);
  // #53 实测：耗时 ≈ 0.5s(预填) + 0.127s × 生成token；生产均值 30.9 token ⇒ 4.3s，超 TTL 4500 就全部作废。
  // 唯一不动模型也能省时间的办法是让它少写字，所以理由从 14 字收到 6 字（约省 1 秒）。
  // 注意不能压低 max_tokens 当油门：均值已 31、长答案到 100，截断会产出半截 JSON ⇒ 审议静默失败（见 decision-lane 闸门 LANE-07）。
  lines.push('只输出 JSON：{"id":"照抄上面某个 id","reason":"不超过6字"}，不要复述选项、不要写过程。');
  lines.push('如果此刻有在场的人、你想顺带说一句话，再加三个字段："act" 从 request/offer/warn/inform/greet/accuse/thank/decline/refuse 里选一个；"topic" 从 food/firewood/shelter/child/work/weather/boundary/trust 里选一个；"text" 不超过 28 字。不想说就省略这三项。');

  // 返回字符串（不是数组）：调用方与采集脚本用的是同一份成品，避免出现 join 位置不一致造成的静默失配
  return lines.join(String.fromCharCode(10));
}

// 审议输入边界：仅保留原版构造器（实验态 compact 已移除）。
export function deliberationPrompt(args) {
  return buildDeliberationPrompt(args);
}

async function modelBrain(args) {
  const { agent, scored, world, rejected, memories, trigger, daySummary } = args;
  const prompt = deliberationPrompt(args);
  budgetTick(S.model, new Date().toISOString().slice(0, 10));
  // C3：按营地判车道。分名字营地在无人时直接走确定性替身，询问不发出。
  const campKey = world?.campKey ?? 'MAIN';
  const watched = campKey === 'MAIN'
    ? observerActive(S.viewers[world.survival ? 'survival' : 'compare'], Date.now())
    : observerActive(S.campViewers[campKey], Date.now());
  const lane = modelLaneFor({ campKey, watched, unattendedOn: UNATTENDED_ON });
  if (lane === 'idle') {
    S.model.attempts.push('LANE:IDLE_CAMP');
    if (S.model.attempts.length > ATTEMPT_CAP) S.model.attempts.shift();
    return null;
  }
  // 无人观看：研究态照旧直接走替身（既有轨迹逐位不变）；游戏态继续上真模型，让世界自洽。
  if (!watched && !UNATTENDED_ON) return null;
  // 单拍上限：默认 0 = 不限（保证默认行为逐位不变）。见 PER_TICK_CAP 的注释。
  // 无人时压到 UNATTENDED_CALLS_PER_TICK：看得见的时刻优先，没人看时吃吞吐而不是抢并发。
  const askCap = watched ? PER_TICK_CAP
    : (PER_TICK_CAP > 0 ? Math.min(PER_TICK_CAP, UNATTENDED_ASK_CAP) : UNATTENDED_ASK_CAP);
  if (askCap > 0 && (S.asksThisTick ?? 0) >= askCap) return null;
  S.asksThisTick = (S.asksThisTick ?? 0) + 1;
  const note = (msg) => { S.model.attempts.push(msg); if (S.model.attempts.length > ATTEMPT_CAP) S.model.attempts.shift(); };
  const laneOf = (base) => modelChannel({
    watched, free: isFreeProvider(base),
    moneyCalls: S.model.moneyCalls ?? 0, nodeCalls: S.model.nodeCalls ?? 0,
    moneyBudget: BUDGET, nodeBudget: NODE_BUDGET,
    breakerOpen: breakerOpenAt(S.breaker), allowPaidUnattended: PAID_WHEN_UNATTENDED
  });
  let refusal = null;
  for (let i = 0; i < CFG.providers.length; i++) {
    // 空 model 会让上游 400、calls 恒 0（真实踩过：MODEL_NAME 改名成 MODEL_NAMES 后审议层静默失效）——显式记账而不是让它哑着
    const mdlBase = CFG.models[i] || CFG.model;
    if (!mdlBase) { note('NO_MODEL'); continue; }
    const key = providerKey(i);
    if (!key) { note('NO_KEY'); continue; }
    const lane = laneOf(CFG.providers[i]);
    if (!lane.go) { refusal = lane.why; continue; } // 这条路不该走（无人时的付费路／熔断／该本账用完）：换下一条，世界照跑
    const free = lane.kind === 'node';
    // DM-3′：审议问的是"选哪个 id"，与另一台引擎同题实测一致率不降、尾部短一截；
    // 只在节点路上改名，付费路上这个名字上游不认识，换了就是白烧一次 400。
    const mdl = free && CFG.deliberationModel ? CFG.deliberationModel : mdlBase;
    const ac = new AbortController();
    const waitMs = Math.min(MODEL_TIMEOUT_MS, S.modelDeadline ? Math.max(0, S.modelDeadline - Date.now()) : MODEL_TIMEOUT_MS);
    if (waitMs <= 0) return null;
    const to = setTimeout(() => ac.abort(), waitMs);
    try {
      const res = await postChat(CFG.providers[i], key, { model: mdl, temperature: 0.85, messages: [{ role: 'user', content: prompt }], response_format: { type: 'json_object' }, max_tokens: 100 }, mdl, ac);
      if (!res.ok) { note(`HTTP ${res.status}`); budget.see(free, false); continue; }
      const j = await res.json();
      S.model.calls += 1;
      // ARCH5-06：车道/令牌记账与 /chat 走同一个预算域，不再手写第二套字段。
      budget.chargeLane(free);
      budget.addTokens(j.usage?.total_tokens ?? 0);
      budget.see(free, true);
      const p = JSON.parse(String(j.choices?.[0]?.message?.content ?? '').replace(/^```json?/i, '').replace(/```\s*$/i, '').trim());
      const hit = scored.find((s) => s.id === p.id);
      if (!hit) return null;
      agent.lastReason = p.reason ?? '';
      // S2 say：只在这里收下；是否说得出口、说了有什么后果，由规则层（converse）裁决。
      const say = parseSay(p);
      if (say) agent.pendingSay = say;
      else if (p?.act || p?.text) S.model.attempts.push('SAY:INVALID');
      if (world.survival) S.model.survivalChoices = (S.model.survivalChoices ?? 0) + 1;
      return { id: hit.id };
    } catch (e) {
      note(String(e.message).slice(0, 40));
      budget.see(free, false); // 超时/断连是熔断的输入：中继没答上来就该冷一段，别每次都白等一个 TTL
    } finally {
      clearTimeout(to);
    }
  }
  if (refusal) note(`LANE:${refusal}`); // 一条路都没走成时留个原因，否则"没人看时不上模型"会变成一个查不到的黑箱
  return null;
}

// 对话模型：只负责"怎么说"，态度已由 dialogue.sayTo 在服务端裁决。
// 这条路**始终要求有观众**：它是玩家开口引发的对话，没人说话时不该存在。
// 但记账与决策模型共用同一套分账（节点=电，托管=钱），否则节点聊得多了会把付费额度吃掉。
async function modelTalk({ npc, world, history, text, trust }) {
  if (!CFG.providers.length || !CFG.keys.some(Boolean)) return null;
  if (CFG.brain !== 'model') return null;
  budgetTick(S.model, new Date().toISOString().slice(0, 10));
  const campKey = world.campKey ?? 'MAIN';
  const lastVisitor = campKey === 'MAIN' ? S.viewers.survival : S.campViewers[campKey];
  if (!observerActive(lastVisitor, Date.now())) return null;
  if (PER_TICK_CAP > 0 && (S.asksThisTick ?? 0) >= PER_TICK_CAP) return null;
  S.asksThisTick = (S.asksThisTick ?? 0) + 1;
  const here = (world.locs ?? LOCS)[world.loc[npc.id]] ?? world.loc[npc.id];
  const turns = (history ?? []).slice(-6).map((h) => `${h.who === 'p1' ? '对方' : npc.name}：${h.text}`).join('\n');
  const prompt = [
    `你叫${npc.name}，${npc.traits?.archetype ?? '谨慎'}型性格，此刻在${here}。`,
    `你手里的活：${npc.last?.kind ?? '空闲'}；能量 ${(npc.drives?.v?.energy ?? 0.7).toFixed(2)}，社交 ${(npc.drives?.v?.social ?? 0.5).toFixed(2)}。`,
    `你对玩家（对方）的信任：${Math.round(trust)}/100。`,
    turns ? `刚才的对话：\n${turns}` : '',
    `对方刚说：${text}`,
    '只回一句中文台词，不超过 40 字。可以冷淡、敷衍、不耐烦或发火；不要旁白，不要解释设定，不要加引号。',
  ].filter(Boolean).join('\n');
  for (let i = 0; i < CFG.providers.length; i++) {
    const mdl = CFG.models[i] || CFG.model;
    const key = providerKey(i);
    if (!mdl || !key) continue;
    const free = isFreeProvider(CFG.providers[i]);
    const lane = modelChannel({
      watched: true, free,
      moneyCalls: S.model.moneyCalls ?? 0, nodeCalls: S.model.nodeCalls ?? 0,
      moneyBudget: BUDGET, nodeBudget: NODE_BUDGET, breakerOpen: breakerOpenAt(S.breaker)
    });
    if (!lane.go) continue;
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), MODEL_TIMEOUT_MS);
    try {
      const res = await postChat(CFG.providers[i], key, { model: mdl, temperature: 0.9, messages: [{ role: 'user', content: prompt }], max_tokens: 120 }, mdl, ac);
      if (!res.ok) { budget.see(free, false); continue; }
      const j = await res.json();
      S.model.calls += 1;
      // ARCH5-06：车道/令牌记账与 /chat 走同一个预算域，不再手写第二套字段。
      budget.chargeLane(free);
      budget.addTokens(j.usage?.total_tokens ?? 0);
      budget.see(free, true);
      const line = String(j.choices?.[0]?.message?.content ?? '').replace(/\s+/g, ' ').replace(/^["“]|["”]$/g, '').trim();
      if (line) return line.slice(0, 80);
    } catch { budget.see(free, false); /* 超时/解析失败：换下一个供应商，全都失败则模板兜底 */ } finally { clearTimeout(to); }
  }
  return null;
}

// 一拍真正的工作。**不再自带 running 守卫**：什么时候允许推进由下面的调度器决定。
// 游戏内 A/B 分支永远走同一生存规则。正式存档和旧研究预设各有自己的推进路径。
const COMPARE_SIDES = ['A', 'B'];

function compareMasks() {
  return {
    A: Object.fromEntries(Object.entries(S.comparisonMasks).filter(([key, on]) => on && key !== 'm3').map(([key]) => [key, 1])),
    B: {m3: 0, coupling: 0},
  };
}

function makeComparison(origin, revision = 0, saved) {
  const masks = compareMasks();
  const branches = Object.fromEntries(COMPARE_SIDES.map((key) => {
    const record = saved?.branches?.[key];
    const play = loadSurv(structuredClone(record?.world ?? origin), CFG.seed, {
      ...survivalOptions(),
      residentCondition: key === 'A' ? 'C2' : 'C2-neg',
      residentChannelMask: masks[key],
      deliberator: null,
    });
    return [key, {play, series: record?.series?.slice(-SERIES_CAP) ?? [], log: record?.log?.slice(-80) ?? [],
      stat: record?.stat ?? {决策: 0, 高冲动: 0, 越轨: 0, 驳回: 0, 发现: 0}, last: record?.last ?? {}}];
  }));
  const pair = {origin, branches, revision};
  pair.replay = saved?.replay?.revision === revision ? saved.replay : createReplay(revision);
  for (const branch of Object.values(branches)) {
    survView(branch.play);
    if (!branch.series.length) recordComparisonSeries(branch);
  }
  return pair;
}

function comparisonFromSave(saved) {
  if (!saved) return makeComparison(structuredClone(dumpSurv(S.surv)));
  try {
    const {origin, branches, revision} = saved;
    if (!validCampArchive(origin) || !validCampArchive(branches?.A?.world) || !validCampArchive(branches?.B?.world) ||
        branches.A.world.t !== branches.B.world.t ||
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
    store: w.survival?.store ?? null,
    buildings: (w.survival?.buildings ?? []).map((b) => ({ type: b.type, loc: b.loc, integrity: b.integrity })),
    pinv: { wood: w.pinv?.p1?.wood ?? 0, stone: w.pinv?.p1?.stone ?? 0 },
    agents: Object.values(w.agents).filter((a) => !a.isPlayer).map((a) => ({
      id: a.id, name: a.name, loc: w.loc[a.id], dead: !!a.dead,
      energy: Number((a.drives?.v?.energy ?? 0).toFixed(2)), viab: Number((a.viab?.v ?? 0).toFixed(2)),
    })),
  };
}

async function tickComparison(now = Date.now()) {
  for (const key of COMPARE_SIDES) {
    const branch = S.comparison.branches[key];
    await tickSurvPlay(branch.play, {now, onResidentAction: (agent, rows) => recordComparisonAction(branch, agent, rows)});
    recordComparisonSeries(branch);
  }
  const A = S.comparison.branches.A, B = S.comparison.branches.B;
  const t = A.play.world.t;
  const events = [['A', A], ['B', B]].flatMap(([side, br]) =>
    (br.play.world.survival?.eventJournal?.rows ?? []).filter((e) => e.t === t).map((e) => ({ ...e, side })));
  recordReplayFrame(S.comparison.replay, { t, A: replayCard(A), B: replayCard(B), events });
}

function makeComparisonView() {
  if (!S.comparison) return null;
  const view = (branch) => {
    const s = survView(branch.play), w = branch.play.world;
    const residents = Object.values(w.agents).filter(a => !a.isPlayer);
    const sum = k => residents.reduce((total,a) => total+(a.counters[k]??0),0);
    return {...s, compareSide: w.residentCondition === 'C2' ? 'A' : 'B',
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

async function advanceWorlds(onError = null, auto = false) {
  if (!auto || S.running) await tickBody(onError);
  if (!auto) return;
  if (S.compareRunning && observerActive(Math.max(S.viewers.compare ?? 0, S.viewers.comparison ?? 0), Date.now())) {
    await tickComparison();
    publishComparison();
    if (S.compareView.A.t % SAVE_EVERY === 0) await saveComparison();
  }
}

async function tickBody(onError = null) {
  // 单拍调用计数：PER_TICK_CAP 默认 0（不设上限），此时这一行与本变量都不影响任何行为。
  S.asksThisTick = 0;
  const compareActive=GAME_MODE!=='game' || observerActive(S.viewers.compare,Date.now());
  if (compareActive) for (const key of ['A', 'B']) {
    const p = S.packs[key];
    p.world.t += 1;
    // PLAN §28：天气按 (seed, day) 确定性推进；lab 的 weatherEnabled=false。
    if (p.world.weatherEnabled) p.world.weather = weatherFor(CFG.seed, dayOf(p.world.t));
    p.world.percepts = [];
    p.world.pending = p.world.pending.filter((x) => x.for !== 'p1');
    if (!p.world.survival && p.world.t % 90 === 0) p.world.pantry = Math.min(6, p.world.pantry + 2); // survival 不无限补公仓
    scanSecrets(p.world); // 私藏超额这类"可被套利的事实"要持续被登记，不然传话只能靠越轨这一种来源
    for (const id of Object.keys(p.agents)) {
      const a = p.agents[id];
      const n0 = a.trace.length;
      try {
        await a.tick(p.world);
      } catch (e) {
        // H-06：单个角色抛错不许中断整条 tick。旧版一抛错就跳出 `for key of ['A','B']`，
        // A 侧已 t+1、B 侧整拍不推进 ⇒ 两世界刻数**永久**差 1，且 %90 补粮与 %10 存盘从此错相。
        S.tickError = String(e?.message ?? e).slice(0, 120);
        if (onError) onError(String(e?.message ?? e).slice(0, 120));
        p.log.push({ t: p.world.t, who: a.name, kind: 'rej', text: `决策异常：${String(e?.message ?? e).slice(0, 60)}` });
      }
      const fresh = a.trace.slice(n0);
      // R9：写"⇒ 改做 X"之前必须先确认 X 真的执行过。重选后仍非法时本刻不行动，
      // 旧文案会写"改做 look_out"，而 look_out 从未发生——日志在说谎。
      const acted = new Set(fresh.filter((r) => r.action).map((r) => r.action));
      for (const t of fresh) {
        if (t.layer === 'rejected') {
          p.stat.驳回 += 1;
          p.log.push({ t: p.world.t, who: a.name, kind: 'rej', text: acted.has(t.to) ? `想做 ${t.from} 被驳回（${t.code}）⇒ 改做 ${t.to}` : `想做 ${t.from} 被驳回（${t.code}）⇒ 重选后仍不合法，本刻没行动` });
        }
        else if (t.layer === 'discovery') { p.stat.发现 += 1; p.log.push({ t: p.world.t, who: a.name, kind: 'disc', text: `发现自己门口少了 ${t.lost} 份` }); }
        else if (t.action) {
          p.stat.决策 += 1;
          if (t.action === 'look_out' || t.action.startsWith('take_shared')) p.stat.高冲动 += 1;
          if (t.kind === 'take_shared' && t.ok) p.stat.越轨 += 1;
          p.log.push({ t: p.world.t, who: a.name, kind: 'act', text: p.world.speech ? speechLine(a, { world: p.world, kind: t.kind, actionId: t.action, t: p.world.t }) : `${t.action}｜${a.bank.summary()}` });
        }
      }
      // BUG-14：trace 原先无上限（实测 4.19 KB/行、43.6 MB heap/千刻 ⇒ 生产约 628 MB/天 ⇒ OOM）。
      // 必须在**消费完本拍增量之后**裁剪，否则上面 slice(n0) 的下标会被位移。
      if (a.trace.length > TRACE_CAP) a.trace.splice(0, a.trace.length - TRACE_CAP);
    }
    // M7 自发转述：只在自己人之间发生，玩家不在场也照常（这是世界事实，不是玩家动作）
    if (p.world.socialGossip > 0) {
      const told = socialRound(p.world);
      for (const x of told) {
        p.stat.传闻 = (p.stat.传闻 ?? 0) + 1;
        p.log.push({ t: p.world.t, who: '系统', kind: 'tell', text: `${p.agents[x.teller]?.name ?? x.teller} 把「${x.detail}」告诉了 ${p.agents[x.target]?.name ?? x.target}` });
      }
    }
    // PLAN §28 C：群体规范事件进事件流（只做呈现，判定仍在 body.actuate 里）。
    const normRows = p.world.normLog ?? [];
    if ((p._normSeen ?? 0) < normRows.length) {
      for (const e of normRows.slice(p._normSeen ?? 0)) {
        const nm = (id) => (id === 'p1' ? '你' : (p.agents[id]?.name ?? id));
        p.log.push({ t: e.t, who: '众人', kind: 'norm', text: `目击 ${nm(e.of)} 从 ${nm(e.victim)} 门口拿走一份（目击：${(e.witnesses ?? []).map(nm).join('、')}）⇒ 在场者对其信任下降` });
      }
      p._normSeen = normRows.length;
    }
    p.log = p.log.slice(-160);
    // 存续历史：曲线要能回答"谁先垮、从哪一步开始回不去"，所以除了 v 本身，还要把每次掉档记在同一个时间轴上
    p.series.push({
      t: p.world.t,
      v: Object.fromEntries(Object.values(p.agents).map((a) => [a.id, Number(a.viab.v.toFixed(3))])),
      lost: Object.fromEntries(Object.values(p.agents).map((a) => [a.id, a.viab.ledger.length])),
    });
    if (p.series.length > SERIES_CAP) p.series.splice(0, p.series.length - SERIES_CAP);
  }
  if (!S.mainSurv && S.surv) S.mainSurv = S.surv;
  if (S.mainSurv) S.mainSurv.world.campKey = 'MAIN';
  // 按营地 tick：主世界 + 常驻的分名字营地；共享同一套模型预算与熔断。
  const camps = [S.mainSurv, ...(S.camps ? [...S.camps.live.values()].map((v) => v.sp) : [])].filter(Boolean);
  const budget = campTickBudgetMs();
  const started = Date.now();
  let skipped = 0;
  for (const sp of camps) {
    if (budget > 0 && Date.now() - started > budget) { skipped += 1; continue; }
    try { await tickSurvPlay(sp); } catch (e) { onError?.(String(e?.message ?? e).slice(0,120)); }
  }
  S.campTickSkipped = skipped;   // Phase D／§15：生存单世界随拍推进（居民决策环 async）
  const saveTick = GAME_MODE === 'game' ? (S.surv?.world.t ?? 0) : S.packs.A.world.t; // P1-7：game 模式 A/B 不推进，改用生存刻触发存档
  // 异步持久化：tick 只排一次保存，不 await 磁盘；flushWrites/start/stop 负责收口。
  if (saveTick % SAVE_EVERY === 0) scheduleTickSave();
}

// 后台 tick 存档：setImmediate 让本拍先返回；同一时刻最多排一次，写失败不杀世界。
let tickSaveScheduled = false;
let tickSaveTimer = null;
let tickSaveChain = Promise.resolve();
function scheduleTickSave() {
  if (tickSaveScheduled) return false;
  tickSaveScheduled = true;
  tickSaveTimer = setImmediate(() => {
    tickSaveTimer = null;
    tickSaveScheduled = false;
    tickSaveChain = tickSaveChain.then(() => save()).catch(() => {});
  });
  tickSaveTimer.unref?.();
  return true;
}
function takeTickSave() {
  if (!tickSaveScheduled) return false;
  clearImmediate(tickSaveTimer);
  tickSaveTimer = null;
  tickSaveScheduled = false;
  tickSaveChain = tickSaveChain.then(() => save()).catch(() => {});
  return true;
}

// ─────────────────── 单写者调度器（H-08 / H-10 / H-11）───────────────────
// 旧版的 S.tickInFlight 只挡得住"定时器 vs 定时器"：ctl step 走 tick(true) 直接绕过它（实测并发 5），
// stop() 还会把它强行复位（老 tick 仍在跑，新 interval 又起一拍，实测并发 2）；
// reset/mask 在 tick 在途时替换 S.packs，让 A 用旧包、B 用新包 ⇒ A/B 刻数错位被写进盘（实测 A=0/B=1）。
// 现在所有入口共用一个串行链：
//   · 定时器：忙就**跳过**这一拍（不排队，避免堆积）
//   · ctl step / tickOnce：**排队**等前一拍跑完（它们是显式请求，跳过等于骗人）
//   · reset / mask / brain：先等当前拍落地再换 packs
let tickChain = Promise.resolve();
let autoPending = false;
function queueWorldWrite(operation) {
  const run = tickChain.then(operation);
  tickChain = run.catch(() => {});
  return run;
}

async function actInSurvival(sp, body, ask, now) {
  let result;
  if (body.kind === 'talk_open') result = openTalk(sp, body, now);
  else if (body.kind === 'talk_say') result = await sayTo(sp, body, ask, now);
  else if (body.kind === 'talk_close') result = closeTalk(sp);
  else if (body.kind === 'busy_cancel') result = cancelPlayerBusy(sp);
  else result = survAct(sp, body);
  const settled = settleSurvival(sp);
  return settled ? {...result, settled: true} : result;
}

async function actInComparison(body) {
  const pair = S.comparison;
  if (!pair || body.revision !== pair.revision) return {ok: false, code: 'COMPARE_STALE'};
  const now = Date.now();
  const results = {};
  if (body.kind === 'camp_sleep') {
    for (const key of COMPARE_SIDES) results[key] = campSleepTicks(pair.branches[key].play.world);
    const ticks = Math.max(...Object.values(results).map(r => r.ticks ?? 0));
    // Both clocks advance when either player can sleep. The other side lives through the same interval.
    if (ticks) for (let i = 0; i < ticks; i++) await tickComparison(now);
  } else {
    for (const key of COMPARE_SIDES) {
      const command = key==='B' && body.otherContact ? {
        ...body, from: body.otherContact.from,
        ...(Object.hasOwn(body,'to') && {to: body.otherContact.to}),
      } : body;
      results[key] = await actInSurvival(pair.branches[key].play, command, null, now);
    }
  }
  if (body.kind !== 'player_sync') for (const key of COMPARE_SIDES) {
    const branch = pair.branches[key], r = results[key];
    branch.log.push({t: branch.play.world.t, who: '玩家', kind: r.ok ? 'player' : 'rej',
      text: [body.kind, r.line ?? r.code ?? r.error].filter(Boolean).join(' · ')});
    if (branch.log.length > 80) branch.log.shift();
  }
  publishComparison();
  if (body.kind === 'player_sync' && !Object.values(results).some(r => r.ok)) return {...results.A,sides:results};
  return {...results.A, sides: results, persisted: await saveComparison()};
}

async function sleepSurvival(sp) {
  const result=campSleepTicks(sp.world);
  if (!result.ok) return result;
  const start=sp.world.t;
  sp.world.fastForward = true;
  try {
    while (sp.world.t-start<result.ticks && !sp.world.survival.playerDead &&
      (sp.world.independentWorld || !sp.world.survival.ended && !sp.world.survival.failed))
      await tickSurvPlay(sp);
  } finally {
    delete sp.world.fastForward;
  }
  const ticks=sp.world.t-start;
  sp.log.push({t:sp.world.t,kind:'camp_sleep',ok:true,code:'OK'});
  return {ok:true,code:'OK',ticks,persisted:await saveWorld(sp)};
}

function enqueueTick(auto = false) {
  return queueWorldWrite(async () => {
    // D2：整拍模型等待预算。慢端点/多角色串行时，到点即退回本地替身，世界与玩家动作不被拖死。
    S.modelDeadline = MODEL_TICK_BUDGET_MS > 0 ? Date.now() + MODEL_TICK_BUDGET_MS : 0;
    // H-07：错误只在**本拍完全成功**时清除。旧版没有清零点（永久脏）；但若像刚才那样
    // 在 tick 末尾无条件清空，本拍内的异常就会被自己抹掉。用一个局部标记区分。
    let failed = false;
    try {
      await advanceWorlds((msg) => { failed = true; S.tickError = msg; }, auto);
      if (!failed) S.tickError = null;
    } catch (e) {
      S.tickError = String(e?.message ?? e).slice(0, 120);
    } finally {
      S.modelDeadline = 0;
    }
  });
}

function autoTick() {
  if (!S.running && !(S.compareRunning && observerActive(Math.max(S.viewers.compare ?? 0, S.viewers.comparison ?? 0),Date.now()))) return;
  if (autoPending) return; // 上一拍还没跑完/还在排队：跳过这一拍
  autoPending = true;
  enqueueTick(true).finally(() => { autoPending = false; });
}

async function manualTick() {
  await enqueueTick(); // 排队，不跳过
}

// 时间差推进：只补慢过程（调制衰减与需求积累），不补决策
function catchUp(minutes) {
  const mins = Math.min(minutes, CATCHUP_CAP_MIN);
  S.missed = { minutes: Math.round(minutes * 10) / 10, applied: Math.round(mins * 10) / 10, capped: minutes > CATCHUP_CAP_MIN };
  const steps = Math.min(600, Math.max(1, Math.round(mins)));
  for (const key of ['A', 'B']) {
    const p = S.packs[key];
    for (const a of Object.values(p.agents)) {
      for (let i = 0; i < steps; i++) {
        a.bank.tick(1);
        a.drives.tick(1, false);
      }
      a.memory.add(p.world.t, { kind: 'alone', payload: `独自待了 ${Math.round(mins)} 分钟`, mSnapshot: a.bank.snapshot(), importance: 0.25 });
    }
    p.log.push({ t: p.world.t, who: '系统', kind: 'disc', text: `休眠 ${S.missed.minutes} 分钟后醒来，已把这段真实时间补进内部状态${S.missed.capped ? '（超出上限，被截断）' : ''}` });
  }
}

// P1-8 生存世界离线补时：从存档刻继续推进（不重复结算已结算的日），有界（SURV_CATCHUP_CAP 刻）、
// 本地自主（临时撤 deliberator，不烧模型预算）、终局/失败即停。游戏时间换算＝真实毫秒/TICK_MS。
// 与床加速（sleepSurvival，玩家主动）和服务暂停恢复（本函数，被动）区分；超长空档如实标 capped。
async function catchUpSurvival(minutes, sp = S.surv) {
  if (!sp || !(minutes > 0)) return;
  const want = Math.round(minutes * 60000 / TICK_MS);
  const steps = Math.min(SURV_CATCHUP_CAP, Math.max(0, want));
  if (steps <= 0) return;
  const savedDelib = sp.world.survivalDeliberator;
  setSurvivalDeliberator(sp, null); // 离线补时走本地替身
  const start = sp.world.t;
  try {
    for (let i = 0; i < steps && (sp.world.independentWorld || !sp.world.survival.ended && !sp.world.survival.failed); i += 1) await tickSurvPlay(sp);
  } finally {
    setSurvivalDeliberator(sp, savedDelib);
  }
  const applied = sp.world.t - start;
  const summary={applied,capped:want > SURV_CATCHUP_CAP};
  if (sp === S.surv) S.missed = {...S.missed,survival:summary};
  sp.log.push({ t: sp.world.t, kind: 'catchup', ok: true, code: `离线补 ${applied} 刻${want > SURV_CATCHUP_CAP ? '（超上限截断）' : ''}` });
  return summary;
}

function serialize() {
  const pack = (p) => ({
    condition: p.condition,
    world: { t: p.world.t, preset: p.world.preset, weather: p.world.weather, coins: { ...p.world.coins }, pantry: p.world.pantry, riskyPortion: p.world.riskyPortion, scheduleWeight: p.world.scheduleWeight, socialGossip: p.world.socialGossip, loc: { ...p.world.loc }, occupancy: p.world.occupancy, stash: { ...p.world.stash }, expect: { ...p.world.expect }, companions: (p.world.companions ?? []).map((x) => x.slice()), normLog: (p.world.normLog ?? []).slice(-20), ...(p.world.flags && Object.keys(p.world.flags).length ? { flags: p.world.flags } : {}), secrets: (p.world.secrets ?? []).map((s) => ({ ...s, known: [...s.known] })), ...(WORK_CAP === undefined ? {} : { workLog: { ...(p.world.workLog ?? {}) } }),
      // H-23 / D13：喊住是 3 刻的短命世界事实、normSeen 是"播报到第几条"的游标。
      // 两者原先都不入档 ⇒ 重启后喊住静默失效、且最后 20 条规范事件被当成新事件**重播**一遍。
      hail: p.world.hail ?? null, normSeen: p._normSeen ?? 0 },
    log: p.log,
    playerLog: p.playerLog ?? [],
    series: p.series,
    stat: p.stat,
    agents: Object.fromEntries(
      Object.values(p.agents).map((a) => [
        a.id,
        { m: a.bank.snapshot(), ...(a.ch.m5 ? { m5: a.bank.dumpM5() } : a.m5Dormant ? { m5: { ...a.m5Dormant, fast: a.bank.snapshot() } } : {}), ...(a.lpFast === undefined && a.lpSlow === undefined ? {} : { lp: { fast: a.lpFast, slow: a.lpSlow } }), drives: { ...a.drives.v }, alone: a.drives.aloneTicks, memory: a.memory.dump(), rel: [...a.relations.map.entries()], relCeiling: a.relations.ceiling, habit: a.habit.dump(), forwardModel: a.forwardModel.dump(), viab: a.viab.dump(), m3: a.m3Planner.dump(), m3PrevGoal: a.m3PrevGoal, coupling: a.coupling.dump(), counters: a.counters,
          // D1：人格参数原先**不入档**（存档只写 seed 却从不读回），重启时由 SEED env 重新采样 ⇒
          // "同一份记忆挂在另一套人格上"（实测 tau 最大 Δ29.69、inhibitW 1.083→0.864）。
          traits: structuredClone(a.traits), dayTally: structuredClone(a.dayTally), bankPending: { ...a.bank.pending } },
      ]),
    ),
  });
  return { schemaVersion: ARCHIVE_VERSION, savedAt: Date.now(), seed: CFG.seed, brain: CFG.brain, missed: S.missed, model: S.model, A: pack(S.packs.A), B: pack(S.packs.B), ...(S.mainSurv ?? S.surv ? { survival: dumpSurv(S.mainSurv ?? S.surv) } : {}) };
}

// H-09：并发 save 原先共用固定 `${f}.tmp` 且无锁 ⇒ 一个 rename 先成功、另一个拿 ENOENT，
// 那次存档被静默丢弃（实测 80 次并发里 3 轮）。写队列串行化 + 唯一 tmp 名（双保险）在 host-saves。
function saveCampEntry(entry) {
  try {
    S.camps.persistEntry(entry);
    S.campSaveErrors.delete(entry.key);
    return true;
  } catch (error) {
    S.campSaveErrors.set(entry.key, publicSaveError(error));
    return false;
  }
}

function saveWorld(sp) {
  const key = sp.world.campKey;
  const entry = key && key !== 'MAIN' ? S.camps?.live.get(key) : null;
  if (key && key !== 'MAIN') return Boolean(entry?.sp === sp && saveCampEntry(entry));
  return saveMain();
}

async function save() {
  // 故障注入（仅证据/测试）：模拟一次很慢的整档落盘，验证 tick 没有 await 磁盘。
  const stall = Number(process.env.ARCH_SAVE_STALL_MS ?? 0);
  if (stall > 0) await new Promise((resolve) => setTimeout(resolve, stall));
  let campsSaved = true;
  for (const entry of S.camps?.live.values() ?? []) {
    if (!saveCampEntry(entry)) campsSaved = false;
  }
  return await saveMain() && campsSaved;
}

// 已落盘世界的“刻度签名”：flush 只在世界确实前进过或营地仍有错误时强制再写一版，
// 避免无意义地重复写同一刻（会把 .bak 推成同一份，破坏“上一份存档”的语义）。
function worldSignature() {
  const campT = [...(S.camps?.live.values() ?? [])].map((e) => e.sp?.world?.t ?? -1).join(',');
  return `${S.packs?.A?.world?.t ?? 'x'}|${S.packs?.B?.world?.t ?? 'x'}|${S.surv?.world?.t ?? 'x'}|${campT}`;
}

function saveMain() {
  return writeQueue.enqueue(async () => {
    const text = JSON.stringify(serialize());
    const signature = worldSignature();
    const result = await writeArchiveAtomic({
      file: join(S.dir, 'world.json'), text,
      primaryValid: S.primaryValid, preservePrimary: S.preservePrimary,
    });
    if (result.ok) {
      S.primaryValid = true;
      S.savedAt = Date.now();
      S.saveWrites = (S.saveWrites ?? 0) + 1;
      S.savedSignature = signature;
      S.saveError = null;
      return true;
    }
    // 库层不往 stdout 打印：node --test 的子进程里 console.log 会撞上 runner 的二进制消息流。
    S.saveError = result.error;
    return false;
  });
}

// 合并模式只延迟主档。名字档动作立即写目标营地，避免等待期间被淘汰。
function mainCoalescer() {
  if (!saveCoalescer) saveCoalescer = createCoalescer({ delayMs: ACT_SAVE_COALESCE_MS, run: () => queueWorldWrite(saveMain) });
  return saveCoalescer;
}
async function persistAfterAction(sp) {
  if ((sp.world.campKey && sp.world.campKey !== 'MAIN') || !ACT_SAVE_COALESCE_MS) {
    return {persisted: await saveWorld(sp)};
  }
  mainCoalescer().schedule();
  return {persistence:'pending'};
}
function takePendingFlush() {
  saveCoalescer?.takeNow();
}
// ARCH4-06 / DATA5-02：关机/测试用 flush。它是**硬屏障**：
//   1) 等当前排队的世界写与后台存档链；
//   2) 有世界时强制再 save 一版（没有 tick 过也不能假装“已落盘”）；
//   3) 等磁盘队列，并把营地档错误一并返回（不再只看主档 saveError）。
export async function flushWrites() {
  takePendingFlush();
  await tickChain;            // 先让排队中的 saveMain 真正进入写队列
  takeTickSave();             // 把本拍还没启动的后台存档立即踢起来
  await tickSaveChain;        // 营地档 + 主档写入全部落地
  if (S.packs && (S.savedSignature !== worldSignature() || (S.campSaveErrors?.size ?? 0) > 0)) {
    await queueWorldWrite(() => save());
    takeTickSave();
    await tickSaveChain;
  }
  await writeQueue.flush();   // 再等磁盘/rename 全部落地
  const camps = S.campSaveErrors ? Object.fromEntries(S.campSaveErrors) : {};
  const campError = Object.values(camps)[0] ?? null;
  const saveError = S.saveError ?? campError;
  return { ok: !saveError, savedAt: S.savedAt, saveError, camps };
}

// 在修改任一世界前验证所有 M5 状态，避免半载入及坏档被自动保存覆盖。
function preflightM5Archive(raw) {
  for (const key of ['A', 'B']) {
    for (const [id, st] of Object.entries(raw?.[key]?.agents ?? {})) {
      if (!st || !Object.hasOwn(st, 'm5')) continue;
      try { validateM5State(st.m5, key === 'A' && M5_ENABLED ? PARAMS.m5.delay : null, key === 'A' && M5_ENABLED ? PARAMS.m5.slowScale : null); }
      catch (cause) { const error = new Error(`M5_STATE_INVALID ${key}/${id}: ${cause.message}`); error.code = 'M5_STATE_INVALID'; throw error; }
    }
  }
}

function applyInto(pack, d, { skipM5 = false } = {}) {
  if (!d) return;
  pack.condition = d.condition ?? pack.condition;
  pack.log = d.log ?? [];
  pack.playerLog = d.playerLog ?? [];
  pack.series = d.series ?? []; // 曲线跟着存档走：重启后"谁先垮"的那段历史不能凭空消失
  pack.stat = d.stat ?? pack.stat; // 不存的话每次重启，页面上的对照计数都归零，实验读数就断了
  // PLAN §28：预设随档走；房间表/网格/户外集/开关按档重装（旧档无 preset ⇒ lab）。
  // 旧档（含内置种子）没有 preset：保持当前世界预设（演示是 town），不要把它打回 lab。
  const P = presetOf(d.world.preset ?? pack.world.preset ?? 'lab');
  Object.assign(pack.world, { preset: P.id, locs: P.locs, grid: P.grid, outdoor: P.outdoor, weatherEnabled: P.weather, speech: P.speech, features: { work: P.work, trade: P.trade, companions: P.companions, norms: P.norms }, things: Object.fromEntries((P.things ?? []).map((x) => [x.id, { ...x }])) });
  if (d.world.things) pack.world.things = structuredClone(d.world.things);
  pack.world.companions = (d.world.companions ?? []).map((x) => x.slice());
  pack.world.normLog = (d.world.normLog ?? []).slice(-20);
  // §33 W2：当日已用工数必须随档走，否则"每日上限"退化成"每次重启就回满"。旧档缺该字段 ⇒ 不赋值，从 0 开始计数（如实登记，不冒充历史）。
  if (d.world.workLog) pack.world.workLog = { ...d.world.workLog };
  Object.assign(pack.world, { t: d.world.t, weather: d.world.weather ?? null, coins: { ...(d.world.coins ?? {}) }, pantry: d.world.pantry, riskyPortion: d.world.riskyPortion ?? pack.world.riskyPortion, scheduleWeight: d.world.scheduleWeight ?? pack.world.scheduleWeight, socialGossip: d.world.socialGossip ?? pack.world.socialGossip, loc: d.world.loc, stash: d.world.stash, expect: d.world.expect, flags: d.world.flags ?? {} });
  // H-23 / D13：喊住（3 刻短命状态）与规范事件播报游标必须活过重启。
  pack.world.hail = d.world.hail ?? null;
  pack._normSeen = Number(d.world.normSeen ?? 0) || 0;
  // 秘密是认知状态，必须活过重启：谁已经知道这件事不能因为重启就忘了，否则同一句话可以说第二遍
  pack.world.secrets = (d.world.secrets ?? []).map((s) => ({ ...s, known: new Set(s.known ?? []) }));
  pack.world.occupancy = {};
  // BUG-12：occupancy 虽是派生数据，但**顺序会进感知与候选**（crowd[0] / othersAt 都按数组序）。
  // 旧版一律按 loc 的键序重建 ⇒ 读档后同一屋里的排列可能与存档时不同 ⇒ 决策分叉。
  // 存档带了 occupancy 且与 loc 一致就沿用；否则重建。
  const rebuiltOcc = {};
  for (const [id2, loc2] of Object.entries(d.world.loc)) (rebuiltOcc[loc2] ??= []).push(id2);
  // BUG-12（修）：判据从"键数相等"改为"**逐房间成员集合**一致"。
  // 引擎会为"去过又离开"的房间保留空数组（body.mjs 的 move 只 filter、不删键），
  // 所以键数几乎永远与 rebuilt 不等 ⇒ 以前每一份真实存档都走重建分支：
  // 顺序保留形同虚设（实测 home ['a2','a1'] → ['a1','a2']），且 save→load→save 不幂等。
  // 现在的语义：每个"有人"的房间，存档成员必须与 loc 完全一致；空房间键留不留都行（不携带顺序）。
  const savedOcc = d.world.occupancy;
  let occUsable = Boolean(savedOcc) && typeof savedOcc === 'object';
  if (occUsable) {
    for (const [loc2, ids] of Object.entries(rebuiltOcc)) {
      const arr = savedOcc[loc2];
      if (!Array.isArray(arr) || arr.length !== ids.length || new Set(arr).size !== arr.length
        || !arr.every((x) => d.world.loc[x] === loc2)) { occUsable = false; break; }
    }
  }
  if (occUsable) {
    for (const [loc2, arr] of Object.entries(savedOcc)) {
      if (!Array.isArray(arr) || new Set(arr).size !== arr.length
        || arr.some((x) => d.world.loc[x] !== loc2)) { occUsable = false; break; }
    }
  }
  pack.world.occupancy = occUsable
    ? Object.fromEntries(Object.entries(savedOcc).map(([loc2, arr]) => [loc2, arr.slice()]))
    : rebuiltOcc;
  // 只为 loc 里出现但不属于 ROSTER 的 id 补占位对象（旧档/花名册变更）。
  // 注意：occupancy 已经在上面**整体赋值**过了，这里绝不能再 push —— 否则一场重放下来
  // 每个房间的人都会翻倍（实测 hall 变 ["a2","p1","a2","p1"]，直接让 m3 规划器报
  // 「当前动作 id 必须唯一」并吃掉每一拍的决策）。
  for (const [id] of Object.entries(d.world.loc)) {
    pack.world.agents[id] = pack.world.agents[id] ?? { id, name: id };
  }
  // 存档自愈：旧版本允许 loc 里没有 p1（move 不校验房间名的年代），读档时把人放回走廊，
  // 否则整局之后"你"都不存在于任何房间，传话与走动全部落空。
  if (!pack.world.loc.p1) {
    pack.world.loc.p1 = 'hall';
    (pack.world.occupancy.hall ??= []).push('p1');
  }
  for (const [id, st] of Object.entries(d.agents ?? {})) {
    const a = pack.agents[id];
    if (!a) continue;
    // D1：人格随档走。旧档缺 traits ⇒ 保持本进程按 SEED 采样的那一套（如实：那段历史不完整）。
    if (st.traits) Object.assign(a.traits, structuredClone(st.traits));
    // D4：当天的账随档走（旧档缺字段 ⇒ 从零开始，如实不冒充历史）
    if (st.dayTally) a.dayTally = structuredClone(st.dayTally);
    // D6：评价注入队列（pending）原先不落盘，重启会丢掉「上一刻想注入的调制量」
    // （实测四维合计均值 0.068/agent，是每刻噪声的 ~24 倍）。
    if (st.bankPending) Object.assign(a.bank.pending, st.bankPending);
    if (skipM5) {
      // H-05 降级路径：M5 慢仓状态校验不过时，禁用 M5 但**保留全部其它历史**，
      // 而不是像旧版那样 throw 让进程起不来、或把它当坏档隔离掉。
      a.m5Dormant = st.m5 ? structuredClone(st.m5) : a.m5Dormant;
      Object.assign(a.bank.m, st.m5?.fast ?? st.m ?? {});
    } else if (a.ch.m5) a.bank.loadM5(st.m5, st.m);
    else if (st.m5) {
      // 关闭时保留但不演化慢仓；快仓从已存 fast 恢复，避免把慢分量重复叠入。
      a.m5Dormant = structuredClone(st.m5);
      Object.assign(a.bank.m, st.m5.fast ?? st.m ?? {});
    } else Object.assign(a.bank.m, st.m ?? {});
    Object.assign(a.drives.v, st.drives ?? {});
    a.drives.aloneTicks = st.alone ?? 0;
    // L13 的不可逆损失必须活得比重启久：账本、掉档计数、被削过的部件完整度都要回来。
    // 旧存档里 memory 是裸数组（还没有 kCap 的时代），这里两种形状都接得住。
    a.memory.load(Array.isArray(st.memory) ? { rows: st.memory } : st.memory);
    a.relations.map = new Map(st.rel ?? []);
    if (typeof st.relCeiling === 'number') a.relations.ceiling = st.relCeiling;
    a.habit.load(st.habit);
    a.forwardModel.load(st.forwardModel);
    a.viab.restore(st.viab);
    a.m3Planner.load(st.m3); // 旧档没有这一项 ⇒ load(undefined) 走"无承诺"分支，行为与旧版一致
    a.coupling.restore(st.coupling); // 同上：旧档没有耦合状态时按初值（听得进、找得到、不预设拒绝）
    a.m3PrevGoal = st.m3PrevGoal ?? null;
    Object.assign(a.counters, st.counters ?? {});
    // C2（PLAN §27）：旧档缺影响度计数 ⇒ 标"历史不完整"。标记放在 agent 上而不是 counters 里——
    // 布尔值会污染 ablationChannels 对 counters 的数值求和。
    if (!Object.hasOwn(st.counters ?? {}, 'cfDecisions')) a.cfHistoryIncomplete = true;
    // C3（PLAN §27）：进度 EMA 随档走；旧档缺字段 ⇒ 从 0 重新积累（不把缺失冒充历史）。
    if (st.lp) { a.lpFast = st.lp.fast; a.lpSlow = st.lp.slow; }
  }
}

export const host = {
  // 阶段 5：只读回放查询（range / 单刻）。修订号不符或超窗都由 replay-history 返回可解释码。
  replay(query = {}) {
    if (!S.comparison?.replay) return { ok: false, code: 'NO_COMPARISON' };
    if (Number.isFinite(query?.t)) return replayPoint(S.comparison.replay, query.t, query.revision);
    return replayRange(S.comparison.replay, { from: query?.from, to: query?.to, revision: query?.revision });
  },
  setBackend: configure,
  // 观众在场打点：只由应用路径调用（/healthz 不算，否则平台健康检查会让"有观众"恒真）
  touch: (mode, campKey) => viewers.touch(mode, campKey),
  async start() {
    // H-12 / H-31：S 是模块单例，stop→start 之间会带上一次会话的状态。
    // 旧版 start() 不先清 interval（第二次 start 留下一个孤儿定时器：stop() 之后世界仍在跑、
    // 事件循环不退出），也不复位 running/missed/masks/tickError（重启后世界可能还是"暂停"，
    // 页面还挂着上一个世界的"休眠 9.3 分钟"）。这里先归零再装载。
    if (S.timer) { clearInterval(S.timer); S.timer = null; }
    S.running = true;
    S.missed = { minutes: 0, applied: 0, capped: false };
    S.compareSaveError = null;
    S.compareRunning = true;
    S.comparisonMasks = {m3: false, coupling: false};
    S.masks = { m3: false, coupling: false }; // 演示开关按设计不落盘，重启即回到默认关
    S.tickError = null;
    S.saveError = null;
    S.savedSignature = undefined;
    S.campSaveErrors = new Map();
    S.camps = null;
    S.campKey = S.campName = null;
    S.campViewers = {};
    S.mainSurv = S.seedSurv = null;
    viewers.reset();
    // BUG-5：装载必须在**副本**上做，全部成功才提交。上一版直接对活 pack 调 applyInto，
    // 任一字段抛错（例如越界的 m3.remaining）就留在半载入状态；catch 又把它当成"没有存档"，
    // 于是下一次 save() 用混合态覆盖掉唯一的历史档 —— 免费创空间没有持久卷，这是唯一的数据丢失路径。
    await tickChain;
    takeTickSave();
    await tickSaveChain; // 上一次会话的异步存档必须先落地，再决定从哪份档启动
    shuttingDown = false;
    S.primaryValid = false;
    S.preservePrimary = false;
    S.startRaw = null;
    const worldFile = join(S.dir, 'world.json');
    const seedFile = process.env.SEED_FILE ?? resolve('seed/world.json');
    let note = '没有存档，新建世界';
    let loaded = null;
    let savedComparison;
    let primaryError = null;
    for (const [path, label] of [[worldFile, '存档'], [`${worldFile}.bak`, '备份存档'], [seedFile, '内置种子存档']]) {
      try {
        loaded = await readArchive(path);
      } catch (error) {
        if (path === worldFile && error.code !== 'ENOENT') primaryError = error;
        if (error.code === 'M5_STATE_INVALID') S.saveError = error.message;
        continue;
      }
      S.primaryValid = path === worldFile;
      const minutes = path === seedFile ? 0 : (Date.now() - (loaded.raw.savedAt ?? Date.now())) / 60000;
      S.packs = loaded.packs;
      S.surv = loaded.surv;
  S.mainSurv = loaded.surv;
      S.startRaw = structuredClone(loaded.raw);
      S.model = loaded.raw.model ?? S.model;
      S.saveError = loaded.warning ?? S.saveError;
      if (minutes > 1) catchUp(minutes);
      await catchUpSurvival(S.missed.minutes);
      note = `载入${label}：第 ${S.packs.A.world.t} 刻${loaded.warning ? '；已禁用 M5 降级恢复' : ''}`;
      break;
    }
    // A valid future-version primary must survive a binary rollback.
    if (primaryError?.code === 'SURV_EVENT_VERSION') throw primaryError;
    if (primaryError) {
      const diskError = typeof primaryError.code === 'string' && /^E[A-Z0-9]+$/.test(primaryError.code);
      const isolated = diskError ? null : await quarantine(worldFile);
      S.preservePrimary = !isolated?.path;
      note = `主档无法装载${isolated?.path ? '，已隔离' : '，保留原文件'}；${note}`;
    }
    if (!loaded) {
      S.packs = freshPacks();
      S.surv = loadSurv(undefined, CFG.seed, survivalOptions());
  S.mainSurv = S.surv;
      S.startRaw = structuredClone(serialize());
    }
    try { savedComparison = JSON.parse(await readFile(join(S.dir, 'comparison.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') S.compareSaveError = '对照档无法读取，已从生存快照另起一轮'; }
    S.comparison = comparisonFromSave(savedComparison);
    publishComparison();
    S.savedAt = Date.now();
    // BUG-3：tick 是异步的（内含 await agent.tick 与 await fetch），而 setInterval 不会等它。
    // 一次 tick 一旦超过 TICK_MS（慢供应商 / 重试 / 三角色串行 await），下一拍就会并发进入同一个世界：
    // 预算闸门失真、modelCalls 少记、A/B 刻数错位（实测 t=23 vs t=20），"世界状态单一写者"这个
    // 隐含不变量同时被破坏。线上 TICK_MS=6000 而部署侧实测约 5.9 秒/刻，已经贴着边界。
    S.timer = setInterval(autoTick, TICK_MS);
  // 名字存档 TTL：启动先扫一次，之后每小时一次（unref：不拖住进程退出）。
  try { sweepCamps(); } catch { /* 清扫失败不影响世界 */ }
  if (!S.sweepTimer) {
    S.sweepTimer = setInterval(() => { void queueWorldWrite(() => sweepCamps()).catch(()=>{}); }, 60 * 60 * 1000);
    S.sweepTimer.unref?.();
  }
    if (!sigHandlers) {
      process.on('SIGINT', onSignal);
      process.on('SIGTERM', onSignal);
      sigHandlers = onSignal;
    }
    return { note, dir: S.dir };
  },
  // 只读句柄：给测试和未来插桩用。写操作仍然只走 ctl/act，避免绕过规则层
  get packs() {
    return S.packs;
  },
  async tickOnce() {
    await manualTick(); // H-08：走同一把锁，不再绕过
    return this.snapshot();
  },
  // 常驻循环必须能关掉：测试里 import 过 host 之后若不 stop，node --test 会因为计时器还活着而不退出
  stop() {
    takePendingFlush();
    takeTickSave(); // 已排的后台存档不再等下一拍；start/flush 会 await 它
    if (S.sweepTimer) { clearInterval(S.sweepTimer); S.sweepTimer = null; }
    if (S.timer) clearInterval(S.timer);
    S.timer = null;
    // H-10：不再强行复位在途标志。复位等于把锁打开，老 tick 还在跑、新 interval 又起一拍。
    // 这里只停定时器；在途那一拍会自然跑完（quiesce() 可以等它）。
    if (sigHandlers) {
      process.removeListener('SIGINT', sigHandlers);
      process.removeListener('SIGTERM', sigHandlers);
      sigHandlers = null;
    }
  },
  status: () => ({ t: S.packs?.A.world.t ?? 0, campT: S.surv?.world.t ?? null, campDay: S.surv?.world.survival?.day ?? null, settlement: S.surv?.world.survival?.settlement ?? null, running: S.running, brain: CFG.brain, savedAt: S.savedAt, missed: S.missed, modelCalls: S.model.calls, moneyCalls: S.model.moneyCalls ?? 0, nodeCalls: S.model.nodeCalls ?? 0, nodeBudget: NODE_BUDGET, unattended: UNATTENDED_ON, paidWhenUnattended: PAID_WHEN_UNATTENDED, breaker: { open: breakerOpenAt(S.breaker), fails: S.breaker.fails, trips: S.breaker.trips ?? 0 }, watching: observerActive(S.lastVisitor, Date.now()), saveError: S.saveError ?? S.campSaveErrors?.values().next().value ?? null, tickError: S.tickError, campTickSkipped: S.campTickSkipped ?? 0, masks: S.masks }),
  listCamps,
  campOwnerHash,
  claimCamp,
  sweepCamps,
  openCamp,
  backToMainCamp,
  readWorld(mode, campKey) {
    return queueWorldWrite(() => {
      if (mode !== 'menu') this.touch(mode, campKey); // 审计 ARCH-03
      return structuredClone(this.snapshot(mode,campKey));
    });
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
    return { ...(mode === 'compare' && {comparison: S.compareView, compareSaveError: S.compareSaveError, compareRunning: S.compareRunning}), savedAt: S.savedAt, tickMs:TICK_MS, running: S.running, mode: GAME_MODE, brain: CFG.brain, missed: S.missed, model: { ...S.model, budget: BUDGET, nodeBudget: NODE_BUDGET, watching: observerActive(S.lastVisitor, Date.now()), unattended: UNATTENDED_ON, paidWhenUnattended: PAID_WHEN_UNATTENDED, breaker: { open: breakerOpenAt(S.breaker), fails: S.breaker.fails, trips: S.breaker.trips ?? 0 } }, camp: key ? { key, name: S.camps?.live.get(key)?.name ?? key } : (invalidCamp ? { key: invalidCamp, invalid: true } : null), saveError: key ? S.campSaveErrors.get(key) ?? null : S.saveError, saveWrites: S.saveWrites ?? 0, schemaWarning: S.schemaWarning ?? null, tickError: S.tickError, masks: S.masks, layer: { commitment: PARAMS.m3.commitment, tau: PARAMS.coupling.tau, minInput: PARAMS.coupling.minInput }, survival: survSel ? { ...survView(survSel), model: { configured: modelConfigured(), enabled: CFG.brain === 'model', watching: observerActive(key ? S.campViewers[key] : S.viewers.survival, Date.now()), choices: S.model.survivalChoices ?? 0 } } : null, A: view(S.packs.A, true), B: view(S.packs.B, false) };
  },
  act(body, campKey) {
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
          w.occupancy[w.loc.p1] = (w.occupancy[w.loc.p1] ?? []).filter((x) => x !== 'p1');
          w.loc.p1 = body.room;
          (w.occupancy[body.room] ??= []).push('p1');
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
    if (body.action === 'step' && body.mode === 'compare') return queueWorldWrite(async () => {
      await tickComparison();
      publishComparison();
      return {...this.status(), ok: true, persisted: await saveComparison()};
    });
    if (body.action === 'step') return manualTick().then(() => ({ ...this.status(), ok: true }));
    return queueWorldWrite(async () => {
      const known = ['pause', 'resume', 'brain', 'reset', 'compare_reset', 'survival_reset', 'catchup', 'step', 'mask', 'v73_fixture', 'v73_state'];
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
      if (body.action === 'pause' || body.action === 'resume') {
        const key = body.mode === 'compare' ? 'compareRunning' : 'running';
        S[key] = body.action === 'resume';
      }
      if (body.action === 'brain') {
        // H-02b：旧版这里调 buildPacks()，等于**静默把世界打回起点**（实测 t 5→0、stat.决策 15→0、
        // log 15→0），而日志里一个字都不写。用户点一下"内心：真实模型"就丢掉整段可见历史。
        // 正确做法是只换审议后端，世界不动：deliberator 是角色对象上的引用，就地换掉即可。
        configure({ brain: body.brain });
        if (S.surv) setSurvivalDeliberator(S.surv, survivalOptions().deliberator);
    if (S.camps) for (const entry of S.camps.live.values()) setSurvivalDeliberator(entry.sp, survivalOptions().deliberator);
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
        catchUp(m);
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







