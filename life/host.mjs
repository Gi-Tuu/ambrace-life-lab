import { randomInt } from 'node:crypto';
// 权威世界宿主：状态在服务器上持续演化，浏览器只是观察与介入的窗口。
// 三件事是这里的核心，不是装饰：
//   1) 持久化：状态落 DATA_DIR；平台无持久卷时（创空间实测）靠内置种子回到固定历史起点
//   2) 时间差推进：免费创空间会休眠。醒来后必须把「没人看的那段时间」补进内部状态，
//      否则「内部状态持续存在」这个主张在演示现场就会被戳穿。
//   3) 只补状态、不补决策：休眠期间没有观察者，编造那段时刻的行为等于伪造历史。
import { mkdir, readFile, writeFile, rename, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { makeWorld, spawn, scanSecrets, LOCS, hail, workUsedToday } from './body.mjs';
import { phaseOf, scheduledLoc, weatherFor, dayOf } from './clock.mjs';
import { presetOf } from './presets.mjs';
import { speechLine, classifySay } from './speech.mjs';
import { tell } from './gossip.mjs';
import { socialRound } from './social.mjs';
import { Organism } from './agent.mjs';
import { hashSeed } from './rng.mjs';
import { DIMS } from './traits.mjs';
import { preferenceBands } from './model.mjs';
import { PARAMS } from './params.mjs';
import { validateM5State } from './m5-bank.mjs';
import { campSleepTicks } from './camp-play.mjs';
import { createSurvPlay, tickSurvPlay, survAct, survView, dumpSurv, loadSurv, setSurvivalDeliberator } from './survplay.mjs';

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
const CATCHUP_CAP_MIN = Number(process.env.CATCHUP_CAP_MIN ?? 360); // 最多补 6 小时，再多就如实标「被截断」
const SAVE_EVERY = 10;
const SERIES_CAP = Number(process.env.SERIES_CAP ?? 720); // 存续曲线保留多少刻（默认 12 分钟实时）
// BUG-14：每个角色保留多少条 trace。实测 4.19 KB/行、6.49 行/刻 ⇒ 生产 TICK_MS=6000 时
// 无上限约 628 MB/天。2000 行 ≈ 8 MB/角色，足够页面/装置读取，又不会把容器撑爆。
const TRACE_CAP = Number(process.env.TRACE_CAP ?? 2000);
// 单拍模型调用上限。默认 **0 = 不设上限 = 现行为逐位不变**。
// 为什么需要它：真实模型链路实测一拍最多发 8 次调用（3 角色 × 2 侧 + 2 次驳回重问），
// 每次约 600 ms ⇒ 单拍最坏 ~4.7 s；而线上 TICK_MS=6000，已经贴着边界。
// 设成 N 就把单拍调用钳到 N，保证每拍都能在 interval 内跑完（代价是那一拍有些角色退回替身）。
const PER_TICK_CAP = Number(process.env.MAX_CALLS_PER_TICK ?? 0);

const CFG = { providers: [], keys: [], model: '', models: [], seed: Number(process.env.SEED ?? 7), brain: 'local' };
// 调用预算闸门：线上审议路径必须与离线脚本同源受控，否则"MAX_CALLS"只是文档里的装饰（真实风险：无上限烧第三方余额）
// 语义是**每日**额度：魔粒按天回血（签到 250），预算跟着按天归零，否则 60 次烧完整段剩余时间都是替身
const BUDGET = Number(process.env.MAX_CALLS ?? 120);
const ATTEMPT_CAP = 20;
// 有观众才上真模型：无人访问时走替身（0 成本），有人打开页面才调模型。
// 依据是 1 魔粒≈2 次旗舰调用、签到 250/天=500 次/天，全天不间断约需 2880 魔粒，必须按在场性省。
const PRESENCE_MS = Number(process.env.PRESENCE_MS ?? 180000);
// 纯函数便于闸门测试：最近有人在看才允许调用
export function observerActive(lastVisitor, now, presenceMs = PRESENCE_MS) {
  return now - lastVisitor <= presenceMs;
}
// 纯函数便于闸门测试：跨天归零，同日原样返回
export function budgetTick(model, dayKey) {
  if (model.dayKey === dayKey) return model;
  model.dayKey = dayKey;
  model.calls = 0;
  model.tokens = 0;
  if ('survivalChoices' in model) model.survivalChoices = 0;
  model.attempts.length = 0;
  return model;
}
// BUG-8：应用层的其它模型入口（serve.mjs 的 /chat 转发）必须走**同一套**预算与在场闸门，
// 否则 MAX_CALLS 只对世界内部那条路径有效，旁路照样能把额度烧光。
// 返回 null 表示放行；否则返回拒因（'BUDGET' / 'NO_OBSERVER'）。
// H-04：必须**先预扣再放行**。旧版只读不扣，并发请求会在 calls 落账前全部通过检查
// （实测 MAX_CALLS=5 时 30 并发全部 200、calls=30 ⇒ 6 倍超支，熔断形同虚设）。
export function modelGate() {
  budgetTick(S.model, new Date().toISOString().slice(0, 10));
  if (S.model.calls >= BUDGET) return 'BUDGET';
  if (!observerActive(S.lastVisitor, Date.now())) return 'NO_OBSERVER';
  S.model.calls += 1; // 预扣：额度在"决定放行"的此刻就减少，并发下也不可能超发
  S.model.reserved = (S.model.reserved ?? 0) + 1;
  return null;
}
// 调用失败（上游报错/全供应商失败）必须把预扣退回去，否则额度被白吃
export function modelRelease() {
  if (S.model.reserved > 0) S.model.reserved -= 1;
  S.model.calls = Math.max(0, S.model.calls - 1);
}
// 调用成功：预扣转正式消费，只追加 token（calls 已在 gate 里扣过，不能重复计）
export function modelCharged(tokens = 0) {
  if (S.model.reserved > 0) S.model.reserved -= 1;
  S.model.tokens += Number(tokens) || 0;
}
// 演示侧的 M3/M4 开关：机制侧默认关（channelMask 不传），这里只决定这一页要不要把这一层接上。
// 不落地存档：刷新或重部署回到默认关，免得"默认关"这句只在文档里成立。
// startRaw 是这次会话的世界起点快照，切开关时两个世界都回到这里（见 replayLayers）。
// BUG-17：SIGINT/SIGTERM 处理器必须能摘掉。start() 每调一次就 process.on 一次，
// 而 stop() 只 clearInterval 不移除监听器 ⇒ 测试里 start×3 就有 6 个监听器（实测），
// 每次信号会重复 save，最后还会撞 MaxListenersExceededWarning。
let sigHandlers = null;
async function onSignal() {
  await save();
  process.exit(0);
}

const S = { packs: null, timer: null, tickError: null, running: true, savedAt: 0, missed: { minutes: 0, capped: false }, model: { calls: 0, tokens: 0, attempts: [], dayKey: '' }, lastVisitor: 0, viewers: { survival: 0, compare: 0 }, saveError: null, dir: process.env.DATA_DIR ?? 'data', masks: { m3: false, coupling: false }, startRaw: null, surv: null };

export function configure({ providers = [], keys = [], model = '', models = [], seed, brain } = {}) {
  if (providers.length) CFG.providers = providers.map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
  if (keys.length) CFG.keys = keys.map((s) => s.trim()).filter(Boolean);
  if (model) CFG.model = model;
  if (models.length) CFG.models = models.map((s) => String(s).trim()).filter(Boolean);
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

// 载入内置种子（固定历史起点）。种子不走 catchUp——它是初始条件，不是休眠。
// H-05：种子里的 M5 状态与当前配置不符时同样降级（禁用 M5、保留历史），不许让启动砖死。
async function loadSeed() {
  const seedText = await readFile(process.env.SEED_FILE ?? resolve('seed/world.json'), 'utf8');
  let loaded;
  try {
    loaded = loadArchive(seedText);
  } catch (e) {
    if (e?.code !== 'M5_STATE_INVALID') throw e;
    S.saveError = e.message;
    loaded = loadArchive(seedText, { skipM5: true });
    loaded.degraded = true;
  }
  S.packs = loaded.packs;
  S.startRaw = structuredClone(loaded.raw);
  S.model = loaded.raw.model ?? S.model;
  const t = S.packs.A.world.t;
  return `从第 ${t} 刻的历史起点继续（seed=${loaded.raw.seed}${loaded.degraded ? '；M5 状态不符，已禁用 M5' : ''}）`;
}

// 隔离文件不能无限堆：每次约 340KB，免费空间磁盘有限。只留最近 5 份。
async function quarantine(worldFile) {
  const dst = join(S.dir, `world.corrupt-${Date.now()}.json`);
  try {
    await rename(worldFile, dst);
  } catch {
    return { path: null, error: '隔离失败（目录不可写/文件被占）' };
  }
  try {
    const olds = (await readdir(S.dir)).filter((n) => n.startsWith('world.corrupt-')).sort();
    for (const n of olds.slice(0, Math.max(0, olds.length - 5))) await rm(join(S.dir, n), { force: true });
  } catch { /* 清理失败不重要 */ }
  return { path: dst, error: null };
}

// 切一次开关 = 换一个独立变量重跑，而不是在半路上改规则：
// 两个世界都回到这次会话的起点，只有 A 侧带上这一层，页面上的 t 仍然对齐。
function buildPacks() {
  S.packs = packsFrom(S.startRaw);
}

function modelConfigured() {
  return CFG.keys.length > 0 && CFG.providers.some((_, i) => CFG.models[i] || CFG.model);
}

function survivalOptions() {
  return { residentialDecisions: true, deliberator: CFG.brain === 'model' ? modelBrain : null };
}

async function modelBrain({ agent, scored, world, rejected, memories, trigger, daySummary }) {
  if (!CFG.providers.length || !CFG.keys.length || world.fastForward) return null;
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
  lines.push('只输出 JSON：{"id":"照抄上面某个 id","reason":"不超过14字"}');
  budgetTick(S.model, new Date().toISOString().slice(0, 10));
  if (S.model.calls >= BUDGET) return null; // 预算用尽：退回确定性替身，世界照跑，不再发请求
  if (!observerActive(S.viewers[world.survival ? 'survival' : 'compare'], Date.now())) return null;
  // 单拍上限：默认 0 = 不限（保证默认行为逐位不变）。见 PER_TICK_CAP 的注释。
  if (PER_TICK_CAP > 0 && (S.asksThisTick ?? 0) >= PER_TICK_CAP) return null;
  S.asksThisTick = (S.asksThisTick ?? 0) + 1;
  const note = (msg) => { S.model.attempts.push(msg); if (S.model.attempts.length > ATTEMPT_CAP) S.model.attempts.shift(); };
  for (let i = 0; i < CFG.providers.length; i++) {
    // 空 model 会让上游 400、calls 恒 0（真实踩过：MODEL_NAME 改名成 MODEL_NAMES 后审议层静默失效）——显式记账而不是让它哑着
    const mdl = CFG.models[i] ?? CFG.model;
    if (!mdl) { note('NO_MODEL'); continue; }
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), 20000);
    try {
      const res = await fetch(`${CFG.providers[i]}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${CFG.keys[i] ?? CFG.keys[0]}` },
        body: JSON.stringify({ model: mdl, temperature: 0.85, messages: [{ role: 'user', content: lines.join('\n') }], response_format: { type: 'json_object' }, max_tokens: 100 }),
        signal: ac.signal,
      });
      if (!res.ok) { note(`HTTP ${res.status}`); continue; }
      const j = await res.json();
      S.model.calls += 1;
      S.model.tokens += j.usage?.total_tokens ?? 0;
      const p = JSON.parse(String(j.choices?.[0]?.message?.content ?? '').replace(/^```json?/i, '').replace(/```\s*$/i, '').trim());
      const hit = scored.find((s) => s.id === p.id);
      if (!hit) return null;
      agent.lastReason = p.reason ?? '';
      if (world.survival) S.model.survivalChoices = (S.model.survivalChoices ?? 0) + 1;
      return { id: hit.id };
    } catch (e) {
      note(String(e.message).slice(0, 40));
    } finally {
      clearTimeout(to);
    }
  }
  return null;
}

// 一拍真正的工作。**不再自带 running 守卫**：什么时候允许推进由下面的调度器决定。
async function tickBody(onError = null) {
  // 单拍调用计数：PER_TICK_CAP 默认 0（不设上限），此时这一行与本变量都不影响任何行为。
  S.asksThisTick = 0;
  for (const key of ['A', 'B']) {
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
  if (S.surv) await tickSurvPlay(S.surv);   // Phase D／§15：生存单世界随拍推进（居民决策环 async）
  if (S.packs.A.world.t % SAVE_EVERY === 0) await save();
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
let sleepPending=false;
async function sleepSurvival() {
  if (sleepPending) return {ok:false,code:'SLEEP_BUSY'};
  sleepPending=true;
  const run=tickChain.then(async()=>{
    const sp=S.surv;
    const result=campSleepTicks(sp.world);
    if (!result.ok) return result;
    const start=sp.world.t;
    sp.world.fastForward = true;
    try {
      while (sp.world.t-start<result.ticks && !sp.world.survival.ended && !sp.world.survival.failed)
        await tickSurvPlay(sp);
    } finally {
      delete sp.world.fastForward;
    }
    const ticks=sp.world.t-start;
    sp.log.push({t:sp.world.t,kind:'camp_sleep',ok:true,code:'OK'});
    await save();
    return {ok:true,code:'OK',ticks};
  });
  tickChain=run.catch(()=>{});
  try { return await run; } finally { sleepPending=false; }
}

function enqueueTick() {
  const run = tickChain.then(async () => {
    // H-07：错误只在**本拍完全成功**时清除。旧版没有清零点（永久脏）；但若像刚才那样
    // 在 tick 末尾无条件清空，本拍内的异常就会被自己抹掉。用一个局部标记区分。
    let failed = false;
    try {
      await tickBody((msg) => { failed = true; S.tickError = msg; });
      if (!failed) S.tickError = null;
    } catch (e) {
      S.tickError = String(e?.message ?? e).slice(0, 120);
    }
  });
  tickChain = run.catch(() => {});
  return run;
}

function autoTick() {
  if (!S.running) return;
  if (autoPending) return; // 上一拍还没跑完/还在排队：跳过这一拍
  autoPending = true;
  enqueueTick().finally(() => { autoPending = false; });
}

async function manualTick() {
  await enqueueTick(); // 排队，不跳过
}

// 换 packs 之前必须先让在途的拍落地
async function quiesce() {
  await tickChain.catch(() => {});
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

function serialize() {
  const pack = (p) => ({
    condition: p.condition,
    world: { t: p.world.t, preset: p.world.preset, weather: p.world.weather, coins: { ...p.world.coins }, pantry: p.world.pantry, riskyPortion: p.world.riskyPortion, scheduleWeight: p.world.scheduleWeight, socialGossip: p.world.socialGossip, loc: { ...p.world.loc }, occupancy: p.world.occupancy, stash: { ...p.world.stash }, expect: { ...p.world.expect }, companions: (p.world.companions ?? []).map((x) => x.slice()), normLog: (p.world.normLog ?? []).slice(-20), flags: p.world.flags, secrets: (p.world.secrets ?? []).map((s) => ({ ...s, known: [...s.known] })), ...(WORK_CAP === undefined ? {} : { workLog: { ...(p.world.workLog ?? {}) } }),
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
  return { savedAt: Date.now(), seed: CFG.seed, brain: CFG.brain, missed: S.missed, model: S.model, A: pack(S.packs.A), B: pack(S.packs.B), ...(S.surv ? { survival: dumpSurv(S.surv) } : {}) };
}

let saveChain = Promise.resolve();
let saveSeq = 0;

// H-09：并发 save 原先共用固定 `${f}.tmp` 且无锁 ⇒ 一个 rename 先成功、另一个拿 ENOENT，
// 那次存档被静默丢弃（实测 80 次并发里 3 轮）。这里串行化 + 唯一 tmp 名（双保险）。
function save() {
  const run = saveChain.then(async () => {
    const f = join(S.dir, 'world.json');
    const tmp = `${f}.${process.pid}.${(saveSeq += 1)}.tmp`;
    try {
      await mkdir(S.dir, { recursive: true });
      await writeFile(tmp, JSON.stringify(serialize()), 'utf8');
      // D10：rename 之前先把上一份留成 .bak。免费创空间没有持久卷、也没有快照，
      // 一份坏档就是整段历史归零；有 .bak 至少能人工回到上一个存档点（只留 1 份，不占空间）。
      try { await rename(f, `${f}.bak`); } catch { /* 首次保存没有旧档 */ }
      await rename(tmp, f); // 原子写：休眠/被杀时不会留下半截 JSON
      S.savedAt = Date.now();
      S.saveError = null;
    } catch (e) {
      // 库层不往 stdout 打印：node --test 的子进程里 console.log 会撞上 runner 的二进制消息流。
      // 存档失败改成一个可查询的状态，由应用层决定要不要说、怎么说。
      S.saveError = String(e?.message ?? e).slice(0, 80);
    }
  });
  saveChain = run.catch(() => {});
  return run;
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
  let occUsable = Boolean(d.world.occupancy) && typeof d.world.occupancy === 'object'
    && Object.keys(d.world.occupancy).length === Object.keys(rebuiltOcc).length;
  if (occUsable) {
    for (const [loc2, arr] of Object.entries(d.world.occupancy)) {
      if (!Array.isArray(arr) || arr.length !== (rebuiltOcc[loc2] ?? []).length || new Set(arr).size !== arr.length || !arr.every((x) => d.world.loc[x] === loc2)) { occUsable = false; break; }
    }
  }
  pack.world.occupancy = occUsable
    ? Object.fromEntries(Object.entries(d.world.occupancy).map(([loc2, arr]) => [loc2, arr.slice()]))
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
  setBackend: configure,
  // 观众在场打点：只由应用路径调用（/healthz 不算，否则平台健康检查会让"有观众"恒真）
  touch: mode => {
    S.lastVisitor = Date.now();
    if (!mode || mode === 'survival') S.viewers.survival = S.lastVisitor;
    if (!mode || mode === 'compare') S.viewers.compare = S.lastVisitor;
  },
  async start() {
    // H-12 / H-31：S 是模块单例，stop→start 之间会带上一次会话的状态。
    // 旧版 start() 不先清 interval（第二次 start 留下一个孤儿定时器：stop() 之后世界仍在跑、
    // 事件循环不退出），也不复位 running/missed/masks/tickError（重启后世界可能还是"暂停"，
    // 页面还挂着上一个世界的"休眠 9.3 分钟"）。这里先归零再装载。
    if (S.timer) { clearInterval(S.timer); S.timer = null; }
    S.running = true;
    S.missed = { minutes: 0, applied: 0, capped: false };
    S.masks = { m3: false, coupling: false }; // 演示开关按设计不落盘，重启即回到默认关
    S.tickError = null;
    S.saveError = null;
    S.lastVisitor = S.viewers.survival = S.viewers.compare = 0;
    // BUG-5：装载必须在**副本**上做，全部成功才提交。上一版直接对活 pack 调 applyInto，
    // 任一字段抛错（例如越界的 m3.remaining）就留在半载入状态；catch 又把它当成"没有存档"，
    // 于是下一次 save() 用混合态覆盖掉唯一的历史档 —— 免费创空间没有持久卷，这是唯一的数据丢失路径。
    S.packs = freshPacks();
    let note = '没有存档，新建世界';
    const worldFile = join(S.dir, 'world.json');
    let archiveText = null;
    try {
      archiveText = await readFile(worldFile, 'utf8');
      const { raw, packs } = loadArchive(archiveText);
      S.packs = packs;
      S.startRaw = structuredClone(raw);
      const mins = (Date.now() - (raw.savedAt ?? Date.now())) / 60000;
      S.model = raw.model ?? S.model;
      if (mins > 1) catchUp(mins);
      note = `载入存档：世界已跑到第 ${S.packs.A.world.t} 刻，休眠 ${mins.toFixed(1)} 分钟`;
    } catch (error) {
      if (error?.code === 'M5_STATE_INVALID') {
        // H-05：M5 慢仓状态与当前配置不符（改过 PARAMS.m5.*，或 M5_ENABLED 0→1）时，
        // 旧版在这里 rethrow ⇒ serve 顶层 await 崩 ⇒ 容器无限重启，且 world.json 原封不动（不可自愈）。
        // 现在改为：禁用 M5 重装，**历史全部保留**，把降级如实写进 note 与 saveError。
        S.saveError = error.message;
        try {
          const { raw, packs } = loadArchive(archiveText, { skipM5: true });
          S.packs = packs;
          S.startRaw = structuredClone(raw);
          S.model = raw.model ?? S.model;
          note = `M5 状态与当前配置不符（${String(error.message).slice(0, 40)}），本次禁用 M5 装载：第 ${S.packs.A.world.t} 刻，历史保留`;
        } catch (e2) {
          note = `M5 状态不符且降级装载失败（${String(e2?.message ?? e2).slice(0, 40)}）：新建世界`;
        }
      } else if (archiveText === null) {
        // 没有存档文件（免费创空间重新部署即清空 /data）：载入内置种子作固定历史起点。
        try {
          note = `载入内置种子存档：${await loadSeed()}`;
        } catch (e2) {
          if (e2?.code === 'M5_STATE_INVALID') S.saveError = e2.message;
          note = '没有存档，新建世界'; // 连种子也没有就是新世界的正常起点
        }
      } else {
        // BUG-5 / H-25 / H-26：坏档先改名留底，再重建。note 必须如实说明发生了哪一种情况。
        const q = await quarantine(worldFile);
        const why = error?.code === 'ARCHIVE_SHAPE' ? '结构不完整' : '无法装载';
        const qNote = q.path ? `已隔离为 ${q.path.split(/[\\/]/).pop()}` : `隔离失败（${q.error}），原档仍在原处`;
        try {
          note = `存档${why}（${qNote}），改为载入内置种子：${await loadSeed()}`;
        } catch (error2) {
          if (error2?.code === 'M5_STATE_INVALID') S.saveError = error2.message;
          note = `存档${why}（${qNote}），且没有可用种子：新建世界`;
        }
      }
    }
    // 起点没Load到任何东西时，把当前这份新建世界认成本次会话的起点：
    // 否则切 M3/M4 开关会退回"从零刻重跑"，而重跑出来的世界取决于点了多久，读数没法解释。
    S.startRaw ??= structuredClone(serialize());
    // Phase D：生存单世界独立挂载（additive）。存档有 survival 键则续跑，否则新建；不影响 A/B。
    S.surv=loadSurv(S.startRaw?.survival,CFG.seed,survivalOptions());
    S.savedAt = Date.now();
    // BUG-3：tick 是异步的（内含 await agent.tick 与 await fetch），而 setInterval 不会等它。
    // 一次 tick 一旦超过 TICK_MS（慢供应商 / 重试 / 三角色串行 await），下一拍就会并发进入同一个世界：
    // 预算闸门失真、modelCalls 少记、A/B 刻数错位（实测 t=23 vs t=20），"世界状态单一写者"这个
    // 隐含不变量同时被破坏。线上 TICK_MS=6000 而部署侧实测约 5.9 秒/刻，已经贴着边界。
    S.timer = setInterval(autoTick, TICK_MS);
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
  status: () => ({ t: S.packs?.A.world.t ?? 0, running: S.running, brain: CFG.brain, savedAt: S.savedAt, missed: S.missed, modelCalls: S.model.calls, watching: observerActive(S.lastVisitor, Date.now()), saveError: S.saveError, tickError: S.tickError, masks: S.masks }),
  snapshot() {
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
    return { savedAt: S.savedAt, running: S.running, brain: CFG.brain, missed: S.missed, model: { ...S.model, budget: BUDGET, watching: observerActive(S.lastVisitor, Date.now()) }, saveError: S.saveError, tickError: S.tickError, masks: S.masks, layer: { commitment: PARAMS.m3.commitment, tau: PARAMS.coupling.tau, minInput: PARAMS.coupling.minInput }, survival: S.surv ? { ...survView(S.surv), model: { configured: modelConfigured(), enabled: CFG.brain === 'model', watching: observerActive(S.viewers.survival, Date.now()), choices: S.model.survivalChoices ?? 0 } } : null, A: view(S.packs.A, true), B: view(S.packs.B, false) };
  },
  async act(body) {
    if (!S.packs) return { ok: false, error: 'NO_WORLD' };
    // Phase D：生存单世界动作独立路由（mode=survival），不落入 town A/B。
    if (body?.mode === 'survival') {
      if (!S.surv) return {ok:false,error:'NO_SURV'};
      if (body.kind==='camp_sleep') return sleepSurvival();
      if (sleepPending) return {ok:false,code:'SLEEP_BUSY'};
      const result = survAct(S.surv,body);
      if (result.ok && (String(body.kind).startsWith('family_') || body.kind==='camp_resident')) await save();
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
  },
  async ctl(body) {
    const known = ['pause', 'resume', 'brain', 'reset', 'compare_reset', 'survival_reset', 'catchup', 'step', 'mask'];
    if (body.action === 'pause') S.running = false;
    if (body.action === 'resume') S.running = true;
    if (body.action === 'brain') {
      // H-02b：旧版这里调 buildPacks()，等于**静默把世界打回起点**（实测 t 5→0、stat.决策 15→0、
      // log 15→0），而日志里一个字都不写。用户点一下"内心：真实模型"就丢掉整段可见历史。
      // 正确做法是只换审议后端，世界不动：deliberator 是角色对象上的引用，就地换掉即可。
      configure({ brain: body.brain });
      if (S.surv) setSurvivalDeliberator(S.surv, survivalOptions().deliberator);
      for (const key of ['A', 'B']) {
        for (const a of Object.values(S.packs[key].agents)) a.deliberator = CFG.brain === 'model' ? modelBrain : null;
        S.packs[key].log.push({ t: S.packs[key].world.t, who: '系统', kind: 'mask', text: `内心切到${CFG.brain === 'model' ? '真实模型' : '本地替身'}（世界不重置）` });
      }
    }
    if (body.action === 'survival_reset') {
      if (body.confirm !== true) return { ...this.status(), ok: false, error: 'RESET_NEEDS_CONFIRM' };
      const run = tickChain.then(async () => {
        const old = S.surv;
        let seed;
        do { seed = randomInt(1, 0x7fffffff); } while (seed === old?.world.mapSeed);
        S.surv = createSurvPlay(seed, { ...survivalOptions(), mapSeed: seed, layoutVersion: 1 });
        await save();
        if (S.saveError) {
          S.surv = old;
          return { ...this.status(), ok: false, error: 'SAVE_FAILED' };
        }
        return { ...this.status(), ok: true, mapSeed: seed };
      });
      tickChain = run.catch(() => {});
      return run;
    }
    if (body.action === 'compare_reset' && body.confirm !== true) {
      return { ...this.status(), ok: false, error: 'RESET_NEEDS_CONFIRM' };
    }
    if (body.action === 'reset' || body.action === 'compare_reset') {
      await quiesce(); // H-11：在途的一拍先落地，否则它会用旧 pack 继续写、并触发一次 save 把错位写进盘
      // 重置是从零刻新建世界，不是回到种子：这次会话的起点必须跟着改写，
      // 否则之后切一次 M3/M4 会把已经被丢掉的那个世界又拿回来。
      S.packs = freshPacks();
      if (body.action === 'reset') S.surv=createSurvPlay(CFG.seed,survivalOptions());
      S.startRaw = structuredClone(serialize());
      // 补时记账属于被丢掉的那个世界：不清零的话，重置后的页面还会挂着「休眠 9.3 分钟后醒来」这句话，
      // 而那句话描述的是已经不存在的世界。savedAt 同时刷新，免得下次载入把重置前的空档也算进去。
      S.missed = { minutes: 0, applied: 0, capped: false };
      S.savedAt = Date.now();
      await save();
    }
    if (body.action === 'catchup') {
      // H-19：minutes 来自 HTTP 载荷。NaN 会写成 {"minutes":null} 进 API 与存档；
      // 负数被照收；无限次 360 分钟补时能把三个人的 drives 压到 0。
      const m = Number(body.minutes ?? 30);
      if (!Number.isFinite(m) || m <= 0) return { ...this.status(), ok: false, error: 'BAD_MINUTES' };
      catchUp(m);
    }
    // 暂停状态下的"单步"必须真的推进一刻（走同一把锁，排队而不是绕过）
    if (body.action === 'step') await manualTick();
    if (body.action === 'mask') {
      const key = body.key;
      // BUG-7 同族：`key in S.masks` 对 'toString' / '__proto__' 会走原型链而"通过校验"，
      // 随后 S.masks 被写进一个不该存在的键。这里同样只认自有属性。
      if (!Object.hasOwn(S.masks, key)) return { ...this.status(), ok: false, error: 'UNKNOWN_MASK' };
      const next = Boolean(body.on);
      if (next === S.masks[key]) return this.status();
      await quiesce(); // H-11：同 reset，换 packs 前等在途拍落地
      S.masks[key] = next;
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
  },
  save,
};

export const DIMS_LIST = DIMS;
