// 世界宿主：创建/装载、tick 串行链、定时器、离线补时、存档与生命周期。
// S/CFG 由 host 以引用传入（单例不复制）；model/replay 用惰性 getter，避免域间循环依赖。
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { makeWorld, spawn, scanSecrets } from './body.mjs';
import { weatherFor, dayOf } from './clock.mjs';
import { presetOf } from './presets.mjs';
import { speechLine } from './speech.mjs';
import { openTalk, sayTo, closeTalk, prepareSay, finishSay } from './dialogue.mjs';
import { socialRound } from './social.mjs';
import { Organism } from './agent.mjs';
import { hashSeed, CURRENT_EVENT_RULES } from './rng.mjs';
import { PARAMS } from './params.mjs';
import { validateM5State } from './m5-bank.mjs';
import { campSleepTicks } from './camp-play.mjs';
import { CampInstances, listSaves, normalizeName, sweepSaves, validCampArchive, readIndex, writeIndex, readOwnerSidecar, writeOwnerSidecar, rebuildIndexFromSaves } from './camp-instances.mjs';
import { tickSurvPlay, survAct, survView, dumpSurv, loadSurv, setSurvivalDeliberator, settleSurvival, cancelPlayerBusy, advancePlayerBusy, simMinuteCursor } from './survplay.mjs';
import { createSimScheduler, gameMinutesForRealMinutes } from './sim-scheduler.mjs';
import { worldTick } from './sim-clock.mjs';
import { createViewerDomain } from './host-viewers.mjs';
import { createWriteQueue, createCoalescer, writeArchiveAtomic, readArchiveFile, quarantineArchive, publicSaveError } from './host-saves.mjs';

export function createHostWorld({ S, CFG, C, getModel, getReplay, observerActive }) {
  const { ROSTER, M5_ENABLED, WORK_CAP, TICK_MS, GAME_MODE, CATCHUP_CAP_MIN, SURV_CATCHUP_CAP,
    campTickBudgetMs, catchupCooldownMs, catchupDayCapMin, ARCHIVE_VERSION,
    ACT_SAVE_COALESCE_MS, SAVE_EVERY, SERIES_CAP, TRACE_CAP, PRESENCE_MS, MODEL_TICK_BUDGET_MS } = C;
  // 域间调用只在运行时取：host 先建世界、后建 model/replay。
  const comparisonFromSave = (...a) => getReplay().comparisonFromSave(...a);
  const publishComparison = () => getReplay().publishComparison();
  const saveComparison = () => getReplay().saveComparison();
  const tickComparison = (...a) => getReplay().tickComparison(...a);
  // 1.1：compare 两侧各有独立连续钟；自动调度要能回答“哪一侧到点了”和“最近一次唤醒”。
  const comparisonDue = (...a) => getReplay().comparisonDue?.(...a) ?? 0;
  const nextComparisonDelayMs = (...a) => getReplay().nextComparisonDelayMs?.(...a) ?? Infinity;
  const modelBrain = (...a) => getModel().modelBrain(...a);
  let sigHandlers = null;
  let shuttingDown = false;
async function onSignal() {
  if (shuttingDown) return;
  shuttingDown = true;
  S.running = false;
  if (S.timer) { clearTimeout(S.timer); S.timer = null; }
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

// 领域模块只拿状态引用，不持有第二份单例；host 保留 facade 与原对外 API。
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
function sweepCamps({ now = Date.now() } = {}) {
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
function validCampKey(campKey) {
  if (!campKey || campKey === 'MAIN') return true;
  return campSurv(campKey) != null;
}

// 观测用：非法键不得留痕（第三轮 §3），也给 healthz/测试一个读法。
function campViewerKeys() {
  return viewers.keys();
}

function campSurv(campKey) {
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

function listCamps() {
  return listSaves(S.dir, Date.now());
}

// SEC3-02 / DATA5-05：营地归属。索引是主视图，ownerHash 同时写侧车；索引丢了从侧车恢复。
function campOwnerHash(key) {
  const entry = readIndex(S.dir).entries.find((e) => e.key === key);
  if (entry?.ownerHash) return entry.ownerHash;
  return readOwnerSidecar(S.dir, key)?.ownerHash ?? null;
}
function claimCamp(key, hash) {
  if (!key || !hash) return { ok: false, code: 'BAD_CLAIM' };
  const idx = readIndex(S.dir);
  const entry = idx.entries.find((e) => e.key === key);
  if (!entry) return { ok: false, code: 'NO_CAMP' };
  // DATA5-05：索引没有 ownerHash 时先看侧车；有侧车就回填索引，绝不把老 owner 换掉。
  const side = readOwnerSidecar(S.dir, key);
  const effective = entry.ownerHash ?? side?.ownerHash ?? null;
  if (effective) {
    if (!entry.ownerHash) {
      entry.ownerHash = effective;
      writeIndex(S.dir, idx);
    }
    return { ok: true, claimed: false, owned: effective === hash };
  }
  entry.ownerHash = hash;
  writeIndex(S.dir, idx);
  writeOwnerSidecar(S.dir, key, { name: entry.name, ownerHash: hash });
  return { ok: true, claimed: true, owned: true };
}

// 进场：先落当前营地，再把指定名字的营地切为当前世界。返回不进游戏时只读的摘要。
function openCamp(name) {
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
function backToMainCamp() {
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
function survivalOptions() {
  return { residentialDecisions: true, eventRulesVersion: CURRENT_EVENT_RULES, ecosystem: true, unifiedCooperation: true, independentWorld: true, wildFood: true, autonomousGoals: true, farmLife: true, settlementLife: true, regionalWork: true, playerRation: true, actTimeModel: process.env.V72_TIME !== '0', gameRules: process.env.GAME_RULES === '1', simTime: process.env.SIM_TIME !== '0', discussions: process.env.SETTLEMENT_DISCUSSIONS !== '0', deliberator: CFG.brain === 'model' ? modelBrain : null };
}

async function advanceWorlds(onError = null, auto = false) {
  // 手动 step/测试仍按"一刻=60 游戏分钟"推进；自动 tick 交给连续时钟按真实 elapsed 推进。
  if (!auto || S.running) await tickBody(onError, auto ? undefined : 60);
  if (!auto) return;
  if (S.compareRunning && observerActive(Math.max(S.viewers.compare ?? 0, S.viewers.comparison ?? 0), Date.now())) {
    await tickComparison();
    publishComparison();
    if (S.compareView.A.t % SAVE_EVERY === 0) await saveComparison();
  }
}
async function tickBody(onError = null, advanceMinutes) {
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
    try { await tickSurvPlay(sp, sp.world?.simClock && Number.isFinite(advanceMinutes) ? { advanceMinutes } : undefined); } catch (e) { onError?.(String(e?.message ?? e).slice(0,120)); }
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
// P1 输入解耦：普通生存动作只和彼此串行（保护状态提交），不再排在长 tick/模型等待后面。
// talk_say 会 await 模型、camp_sleep 会内嵌多拍结算，仍走 queueWorldWrite 以保安全。
let actChain = Promise.resolve();
function queueAct(operation) {
  const run = actChain.then(operation);
  actChain = run.catch(() => {});
  return run;
}
// P1b：连续世界的自动推进由 SimScheduler 叫醒（1 游戏分钟/步），不再等 7.5s 整拍。
// 非连续世界（研究态 / SIM_TIME=0）保持原 TICK_MS 节拍；两者都不另起时钟。
let simScheduler = null;
function primarySimScheduler() {
  const sp = S.mainSurv ?? S.surv;
  const clock = sp?.world?.simClock;
  if (!clock) { simScheduler = null; return null; }
  if (!simScheduler || simScheduler.clock !== clock) {
    simScheduler = createSimScheduler({ clock, cursor: () => simMinuteCursor(sp.world) });
  }
  return simScheduler;
}
function armAutoTick(minDelayMs = 5) {
  if (S.timer) { clearTimeout(S.timer); S.timer = null; }
  const scheduler = primarySimScheduler();
  // primary 与 compare 谁先到点就按谁叫醒；compare 全局暂停/无观众返回 Infinity。
  const delay = Math.max(minDelayMs, Math.min(
    scheduler ? scheduler.nextDelayMs() : TICK_MS,
    nextComparisonDelayMs(),
  ));
  S.timer = setTimeout(() => {
    S.timer = null;
    autoTick();
    // 上一拍还在途时不要 1ms 空转：给队列/模型一个喘息窗口；正常节奏仍由 SimScheduler 决定。
    armAutoTick(autoPending ? 25 : 5);
  }, delay);
}
async function actInSurvival(sp, body, ask, now) {
  let result;
  // 玩家长动作到点后，在下一次输入/读档时补结算；不要求正好落在 tick 边界。
  advancePlayerBusy(sp);
  if (body.kind === 'talk_open') result = openTalk(sp, body, now);
  else if (body.kind === 'talk_say') result = await sayTo(sp, body, ask, now);
  else if (body.kind === 'talk_close') result = closeTalk(sp);
  else if (body.kind === 'busy_cancel') result = cancelPlayerBusy(sp);
  else result = survAct(sp, body);
  const settled = settleSurvival(sp);
  return settled ? {...result, settled: true} : result;
}
async function sleepSurvival(sp) {
  const result=campSleepTicks(sp.world);
  if (!result.ok) return result;
  const w=sp.world, start=worldTick(w);
  // P1c：睡眠不再是"内嵌等整拍"的旧链，而是在短锁内显式按 60 游戏分推进同一个连续时钟。
  // 其它输入是否要等这段睡眠见 docs/回报-债务-时间-2026-11-20.md（一次睡眠是短锁内的原子事务）。
  while (worldTick(w)-start<result.ticks && !w.survival.playerDead &&
    (w.independentWorld || !w.survival.ended && !w.survival.failed))
    await tickSurvPlay(sp, w.simClock ? { minutes: 60 } : undefined);
  const ticks=worldTick(w)-start;
  sp.log.push({t:w.t,kind:'camp_sleep',ok:true,code:'OK'});
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
  // 连续世界由 SimScheduler 判定"是否真的过了一个整游戏分钟"；没有欠账就不排队。
  // 1.1：primary 没有欠账但 compare 到了分钟，也要叫醒，否则对照会停在原地。
  const scheduler = primarySimScheduler();
  if (scheduler && scheduler.peek().minutes < 1 && comparisonDue() < 1) return;
  autoPending = true;
  enqueueTick(true).finally(() => { autoPending = false; });
}

async function manualTick() {
  const run = enqueueTick(); // 排队，不跳过
  // P1b：居民 think 是异步派发的；显式 step 之间让出一个 macrotask，给模型 I/O 落地机会。
  // 这里只让出事件循环，不等待任何模型（慢模型仍不会拖住 step/输入）。
  await new Promise((resolve) => setImmediate(resolve));
  await run;
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

// P1-8 生存世界离线补时：与在线共用同一个 rate / 1 游戏分钟步长；cap 仍是 120 刻（=7200 游戏分）。
// 本地自主（临时撤 deliberator，不烧模型预算）、终局/失败即停。
async function catchUpSurvival(minutes, sp = S.surv) {
  if (!sp || !(minutes > 0)) return;
  const savedDelib = sp.world.survivalDeliberator;
  setSurvivalDeliberator(sp, null); // 离线补时走本地替身
  const start = sp.world.t;
  let summary;
  try {
    if (sp.world.simClock) {
      // 单一换算源：真实分钟 × 60000 × rate / msPerGameMinute（默认 480 游戏分/真实分）。
      const wantMinutes = gameMinutesForRealMinutes(minutes, sp.world.simClock);
      const capMinutes = SURV_CATCHUP_CAP * 60;
      const targetMinutes = Math.min(wantMinutes, capMinutes);
      let remaining = Math.floor(targetMinutes + 1e-9);
      while (remaining > 0 && (sp.world.independentWorld || !sp.world.survival.ended && !sp.world.survival.failed)) {
        // 60 分一块只是外层批量；tickSurvPlay 内部仍逐 1 分钟推进 busy/think，世界重结算只在块内 60 分边界跑。
        const chunk = Math.min(60, remaining);
        await tickSurvPlay(sp, { minutes: chunk });
        remaining -= chunk;
      }
      const applied = sp.world.t - start;
      summary = {
        applied,
        appliedMinutes: Math.round((targetMinutes - remaining) * 10) / 10,
        requestedMinutes: Math.round(wantMinutes * 10) / 10,
        capped: wantMinutes > capMinutes,
        capMinutes,
      };
    } else {
      // 非连续世界保持旧"每刻=60 分"的补时口径。
      const want = Math.round(minutes * 60000 / TICK_MS);
      const steps = Math.min(SURV_CATCHUP_CAP, Math.max(0, want));
      if (steps <= 0) return;
      for (let i = 0; i < steps && (sp.world.independentWorld || !sp.world.survival.ended && !sp.world.survival.failed); i += 1) {
        await tickSurvPlay(sp);
      }
      summary = { applied: sp.world.t - start, capped: want > SURV_CATCHUP_CAP };
    }
  } finally {
    setSurvivalDeliberator(sp, savedDelib);
  }
  if (sp === S.surv) S.missed = {...S.missed,survival:summary};
  sp.log.push({ t: sp.world.t, kind: 'catchup', ok: true, code: `离线补 ${summary.applied} 刻${summary.capped ? '（超上限截断）' : ''}` });
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
async function flushWrites() {
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
  async function start() {
    // H-12 / H-31：S 是模块单例，stop→start 之间会带上一次会话的状态。
    // 旧版 start() 不先清 interval（第二次 start 留下一个孤儿定时器：stop() 之后世界仍在跑、
    // 事件循环不退出），也不复位 running/missed/masks/tickError（重启后世界可能还是"暂停"，
    // 页面还挂着上一个世界的"休眠 9.3 分钟"）。这里先归零再装载。
    if (S.timer) { clearTimeout(S.timer); S.timer = null; }
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
    let loadedFromPrimary = false;
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
      if (path === worldFile) loadedFromPrimary = true;
      const minutes = path === seedFile ? 0 : (Date.now() - (loaded.raw.savedAt ?? Date.now())) / 60000;
      S.packs = loaded.packs;
      S.surv = loaded.surv;
  S.mainSurv = loaded.surv;
      S.startRaw = structuredClone(loaded.raw);
      S.model = loaded.raw.model ?? S.model;
      S.saveError = loaded.warning ?? S.saveError;
      // 1.1 P1-2：停机时长必须先落进 S.missed（start() 开场会把它归零），否则正式连续世界
      // 在下面走到 catchUpSurvival(0) 就什么也不补。正式世界（simClock）不跑 A/B 的 catchUp——
      // 那是研究态"1 真实分 = 1 刻"的旧口径；统一交给 catchUpSurvival，内部按同一
      // simClock.rate / msPerGameMinute 换算，cap 仍是 SURV_CATCHUP_CAP*60（默认 120 刻=7200 游戏分）。
      // 两条分支都只补一次：正式世界只走 survival 补时，非连续世界才额外补 A/B。
      if (minutes > 1) {
        const archivedSurvival = loaded.raw.survival != null;
        if (S.surv?.world?.simClock && archivedSurvival) {
          S.missed = { minutes: Math.round(minutes * 10) / 10, applied: 0, capped: false };
          await catchUpSurvival(minutes);
        } else if (!S.surv?.world?.simClock) {
          catchUp(minutes);
          await catchUpSurvival(S.missed.minutes);
        }
        // 只带 A/B、没有 survival 块的旧档：readArchive 会新建一份生存世界，但它并不存在于
        // 停机期间，不能把这段离线时间算到它头上（上面两个分支都不走）。
      }
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
    // DATA5-05：索引整体丢失（无 corrupt 备份）时，从营地档 + owner 侧车重建。
    try {
      const rebuilt = rebuildIndexFromSaves(S.dir);
      if (rebuilt > 0) note += `；已从存档重建营地索引 ${rebuilt} 条`;
    } catch { /* 重建失败不阻塞启动；/saves 仍可用空索引 */ }
    // BUG-3：tick 是异步的（内含 await agent.tick 与 await fetch），而 setInterval 不会等它。
    // 一次 tick 一旦超过 TICK_MS（慢供应商 / 重试 / 三角色串行 await），下一拍就会并发进入同一个世界：
    // 预算闸门失真、modelCalls 少记、A/B 刻数错位（实测 t=23 vs t=20），"世界状态单一写者"这个
    // 隐含不变量同时被破坏。线上 TICK_MS=6000 而部署侧实测约 5.9 秒/刻，已经贴着边界。
  // 名字存档 TTL：启动先扫一次，之后每小时一次（unref：不拖住进程退出）。
  try { sweepCamps(); } catch { /* 清扫失败不影响世界 */ }
  if (!S.sweepTimer) {
    S.sweepTimer = setInterval(() => { void queueWorldWrite(() => sweepCamps()).catch(()=>{}); }, 60 * 60 * 1000);
    S.sweepTimer.unref?.();
  }
  // DATA5-01：启动即写一版基线档（只写一次），让"首个 SAVE_EVERY 窗口"至少有第 0 刻可恢复。
  // 失败不阻塞启动，但必须可见：S.saveError 会让 /healthz 503，note 也会带上原因。
  // 必须在 setInterval 之前完成：否则慢磁盘会让第一拍在启动收口前跑掉（pending 等状态被 tick 消费）。
  let baselineSaved = true;
  if (!loadedFromPrimary) {
    const archiveFatal = /M5_STATE_INVALID/.test(String(S.saveError ?? ''));
    // 主档已经可直接载入时不再重写（M5 降级装载也属于“文件必须原封不动”的契约）；
    // 种子/主档都是坏 M5 时也不写：尊重“坏档不新建世界档案”，启动仍继续（saveError 可见）。
    // 只有新建/从 .bak 或种子恢复时才需要补写一版基线。
    if (!archiveFatal) {
      try { baselineSaved = await save(); }
      catch (error) { S.saveError = publicSaveError(error); baselineSaved = false; }
    }
  }
  if (!loadedFromPrimary && !baselineSaved) {
    note += `；启动基线档写入失败（${S.saveError ?? 'SAVE_FAILED'}），世界仍可运行但当前无最新主档`;
    console.error(`[host] 启动基线档写入失败：${S.saveError ?? 'SAVE_FAILED'}`);
  }
  // 启动收口完成后再开始推进世界。连续世界用 SimScheduler 自调度（1 游戏分钟/步），
  // 研究态/旧时间模型仍按 TICK_MS；暂停由 autoTick + clock.paused 双重兜住。
  simScheduler = null;
  armAutoTick();
    if (!sigHandlers) {
      process.on('SIGINT', onSignal);
      process.on('SIGTERM', onSignal);
      sigHandlers = onSignal;
    }
    return { note, dir: S.dir, baselineSaved, saveError: S.saveError ?? null };
  }

  function stop() {
    takePendingFlush();
    takeTickSave(); // 已排的后台存档不再等下一拍；start/flush 会 await 它
    if (S.sweepTimer) { clearInterval(S.sweepTimer); S.sweepTimer = null; }
    if (S.timer) clearTimeout(S.timer);
    S.timer = null;
    // H-10：不再强行复位在途标志。复位等于把锁打开，老 tick 还在跑、新 interval 又起一拍。
    // 这里只停定时器；在途那一拍会自然跑完（quiesce() 可以等它）。
    if (sigHandlers) {
      process.removeListener('SIGINT', sigHandlers);
      process.removeListener('SIGTERM', sigHandlers);
      sigHandlers = null;
    }
  }

  return {
    viewers, writeQueue, start, stop, flushWrites, save, saveWorld, saveMain, saveCampEntry,
    serialize, applyInto, loadArchive, readArchive, quarantine, buildPacks, makePack, freshPacks, packsFrom,
    catchUp, catchUpSurvival, actInSurvival, sleepSurvival, persistAfterAction, takePendingFlush,
    campManager, sweepCamps, validCampKey, campViewerKeys, campSurv, listCamps, campOwnerHash,
    claimCamp, openCamp, backToMainCamp, survivalOptions, queueWorldWrite, queueAct, manualTick, autoTick,
    scheduleTickSave, takeTickSave, onSignal,
  };
}
