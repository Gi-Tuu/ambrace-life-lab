// 权威世界宿主：状态在服务器上持续演化，浏览器只是观察与介入的窗口。
// 三件事是这里的核心，不是装饰：
//   1) 持久化：状态落 DATA_DIR；平台无持久卷时（创空间实测）靠内置种子回到固定历史起点
//   2) 时间差推进：免费创空间会休眠。醒来后必须把「没人看的那段时间」补进内部状态，
//      否则「内部状态持续存在」这个主张在演示现场就会被戳穿。
//   3) 只补状态、不补决策：休眠期间没有观察者，编造那段时刻的行为等于伪造历史。
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { makeWorld, spawn, scanSecrets, LOCS, hail } from './body.mjs';
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

const ROSTER = [
  { id: 'a1', name: '岑', archetype: '谨慎', loc: 'home' },
  { id: 'a2', name: '绛', archetype: '冲动', loc: 'hall' },
  { id: 'a3', name: '蓑', archetype: '孤僻', loc: 'watch' },
];
// 机制侧启动配置；默认关闭，不新增演示 masks/ctl，也不为 C2-neg 开启。
const M5_ENABLED = process.env.M5_ENABLED === '1';
const TICK_MS = Number(process.env.TICK_MS ?? 1200);
const CATCHUP_CAP_MIN = Number(process.env.CATCHUP_CAP_MIN ?? 360); // 最多补 6 小时，再多就如实标「被截断」
const SAVE_EVERY = 10;
const SERIES_CAP = Number(process.env.SERIES_CAP ?? 720); // 存续曲线保留多少刻（默认 12 分钟实时）

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
  model.attempts.length = 0;
  return model;
}
// 演示侧的 M3/M4 开关：机制侧默认关（channelMask 不传），这里只决定这一页要不要把这一层接上。
// 不落地存档：刷新或重部署回到默认关，免得"默认关"这句只在文档里成立。
// startRaw 是这次会话的世界起点快照，切开关时两个世界都回到这里（见 replayLayers）。
const S = { packs: null, timer: null, running: true, savedAt: 0, missed: { minutes: 0, capped: false }, model: { calls: 0, tokens: 0, attempts: [], dayKey: '' }, lastVisitor: 0, saveError: null, dir: process.env.DATA_DIR ?? 'data', masks: { m3: false, coupling: false }, startRaw: null };

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

// 切一次开关 = 换一个独立变量重跑，而不是在半路上改规则：
// 两个世界都回到这次会话的起点，只有 A 侧带上这一层，页面上的 t 仍然对齐。
function buildPacks() {
  S.packs = { A: makePack('C2', maskForA()), B: makePack('C2-neg') };
  if (S.startRaw) {
    applyInto(S.packs.A, S.startRaw.A);
    applyInto(S.packs.B, S.startRaw.B);
  }
}

async function modelBrain({ agent, scored, world, rejected, memories, trigger, daySummary }) {
  if (!CFG.providers.length || !CFG.keys.length) return null;
  const here = world.loc[agent.id];
  const bands = preferenceBands(scored, agent.ch);
  const present = (world.occupancy[here] ?? []).filter((x) => x !== agent.id && x !== 'p1').map((x) => world.agents[x]?.name ?? x);
  const dom = agent.drives.dominant();
  const lines = [
    `你是${agent.name}（${agent.traits.archetype}型）。第 ${world.t} 刻，你在${here}。`,
    `为什么现在问你：${trigger}`, // ⑧ 事件门控：没有事件就不会被问到，所以这行永远有内容
    `内部读数：${agent.bank.summary()}`,
    `此刻你最缺：${dom.label}（偏差 ${dom.e.toFixed(2)}，紧迫度 ${dom.urgency.toFixed(2)}）`,
    `世界事实：公仓余 ${world.pantry} 份；你自己门口存着 ${world.stash[agent.id]} 份（你以为该有 ${world.expect[agent.id]} 份）；在场的人：${present.join('、') || '没有'}`,
    `你想起的事：${memories?.length ? memories.map((m) => `${m.kind}(相似${m.sim})`).join('、') : '暂无'}`,
    daySummary ? `上一天的自己：${daySummary}` : '', // ⑦ 反思回合的产物；关掉开关后这行必须消失
    '可做的事（只能选一项，id 照抄）：',
    ...[...scored].sort((a, b) => (a.id < b.id ? -1 : 1)).map((s) => `- ${s.id} | ${s.act.label} | ${bands[s.id] ?? '同档'}`),
  ].filter(Boolean);
  if (rejected) lines.push(`你上次想做 ${rejected.from} 被驳回：${rejected.why}。这次换一个可行的。`);
  lines.push('只输出 JSON：{"id":"照抄上面某个 id","reason":"不超过14字"}');
  budgetTick(S.model, new Date().toISOString().slice(0, 10));
  if (S.model.calls >= BUDGET) return null; // 预算用尽：退回确定性替身，世界照跑，不再发请求
  if (!observerActive(S.lastVisitor, Date.now())) return null; // 无人观看：走替身，把额度留给真正的观众
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
      return { id: hit.id };
    } catch (e) {
      note(String(e.message).slice(0, 40));
    } finally {
      clearTimeout(to);
    }
  }
  return null;
}

async function tick() {
  if (!S.running) return;
  for (const key of ['A', 'B']) {
    const p = S.packs[key];
    p.world.t += 1;
    // PLAN §28：天气按 (seed, day) 确定性推进；lab 的 weatherEnabled=false。
    if (p.world.weatherEnabled) p.world.weather = weatherFor(CFG.seed, dayOf(p.world.t));
    p.world.percepts = [];
    p.world.pending = p.world.pending.filter((x) => x.for !== 'p1');
    if (p.world.t % 90 === 0) p.world.pantry = Math.min(6, p.world.pantry + 2);
    scanSecrets(p.world); // 私藏超额这类"可被套利的事实"要持续被登记，不然传话只能靠越轨这一种来源
    for (const id of Object.keys(p.agents)) {
      const a = p.agents[id];
      const n0 = a.trace.length;
      await a.tick(p.world);
      for (const t of a.trace.slice(n0)) {
        if (t.layer === 'rejected') { p.stat.驳回 += 1; p.log.push({ t: p.world.t, who: a.name, kind: 'rej', text: `想做 ${t.from} 被驳回（${t.code}）⇒ 改做 ${t.to}` }); }
        else if (t.layer === 'discovery') { p.stat.发现 += 1; p.log.push({ t: p.world.t, who: a.name, kind: 'disc', text: `发现自己门口少了 ${t.lost} 份` }); }
        else if (t.action) {
          p.stat.决策 += 1;
          if (t.action === 'look_out' || t.action.startsWith('take_shared')) p.stat.高冲动 += 1;
          if (t.kind === 'take_shared' && t.ok) p.stat.越轨 += 1;
          p.log.push({ t: p.world.t, who: a.name, kind: 'act', text: p.world.speech ? speechLine(a, { world: p.world, kind: t.kind, actionId: t.action, t: p.world.t }) : `${t.action}｜${a.bank.summary()}` });
        }
      }
    }
    // M7 自发转述：只在自己人之间发生，玩家不在场也照常（这是世界事实，不是玩家动作）
    if (p.world.socialGossip > 0) {
      const told = socialRound(p.world);
      for (const x of told) {
        p.stat.传闻 = (p.stat.传闻 ?? 0) + 1;
        p.log.push({ t: p.world.t, who: '系统', kind: 'tell', text: `${p.agents[x.teller]?.name ?? x.teller} 把「${x.detail}」告诉了 ${p.agents[x.target]?.name ?? x.target}` });
      }
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
  if (S.packs.A.world.t % SAVE_EVERY === 0) await save();
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
    world: { t: p.world.t, preset: p.world.preset, weather: p.world.weather, coins: { ...p.world.coins }, pantry: p.world.pantry, riskyPortion: p.world.riskyPortion, scheduleWeight: p.world.scheduleWeight, socialGossip: p.world.socialGossip, loc: { ...p.world.loc }, occupancy: p.world.occupancy, stash: { ...p.world.stash }, expect: { ...p.world.expect }, companions: (p.world.companions ?? []).map((x) => x.slice()), normLog: (p.world.normLog ?? []).slice(-20), flags: p.world.flags, secrets: (p.world.secrets ?? []).map((s) => ({ ...s, known: [...s.known] })) },
    log: p.log,
    playerLog: p.playerLog ?? [],
    series: p.series,
    stat: p.stat,
    agents: Object.fromEntries(
      Object.values(p.agents).map((a) => [
        a.id,
        { m: a.bank.snapshot(), ...(a.ch.m5 ? { m5: a.bank.dumpM5() } : a.m5Dormant ? { m5: { ...a.m5Dormant, fast: a.bank.snapshot() } } : {}), ...(a.lpFast === undefined && a.lpSlow === undefined ? {} : { lp: { fast: a.lpFast, slow: a.lpSlow } }), drives: { ...a.drives.v }, alone: a.drives.aloneTicks, memory: a.memory.dump(), rel: [...a.relations.map.entries()], relCeiling: a.relations.ceiling, habit: a.habit.dump(), forwardModel: a.forwardModel.dump(), viab: a.viab.dump(), m3: a.m3Planner.dump(), m3PrevGoal: a.m3PrevGoal, coupling: a.coupling.dump(), counters: a.counters },
      ]),
    ),
  });
  return { savedAt: Date.now(), seed: CFG.seed, brain: CFG.brain, missed: S.missed, model: S.model, A: pack(S.packs.A), B: pack(S.packs.B) };
}

async function save() {
  try {
    await mkdir(S.dir, { recursive: true });
    const f = join(S.dir, 'world.json');
    const tmp = `${f}.tmp`;
    await writeFile(tmp, JSON.stringify(serialize()), 'utf8');
    await rename(tmp, f); // 原子写：休眠/被杀时不会留下半截 JSON
    S.savedAt = Date.now();
    S.saveError = null;
  } catch (e) {
    // 库层不往 stdout 打印：node --test 的子进程里 console.log 会撞上 runner 的二进制消息流，
    // 报 "Unable to deserialize cloned data"（实测同一份文件时而通过时而崩）。
    // 存档失败改成一个可查询的状态，由应用层决定要不要说、怎么说。
    S.saveError = String(e.message).slice(0, 80);
  }
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

function applyInto(pack, d) {
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
  Object.assign(pack.world, { t: d.world.t, weather: d.world.weather ?? null, coins: { ...(d.world.coins ?? {}) }, pantry: d.world.pantry, riskyPortion: d.world.riskyPortion ?? pack.world.riskyPortion, scheduleWeight: d.world.scheduleWeight ?? pack.world.scheduleWeight, socialGossip: d.world.socialGossip ?? pack.world.socialGossip, loc: d.world.loc, stash: d.world.stash, expect: d.world.expect, flags: d.world.flags ?? {} });
  // 秘密是认知状态，必须活过重启：谁已经知道这件事不能因为重启就忘了，否则同一句话可以说第二遍
  pack.world.secrets = (d.world.secrets ?? []).map((s) => ({ ...s, known: new Set(s.known ?? []) }));
  pack.world.occupancy = {};
  for (const [id, loc] of Object.entries(d.world.loc)) {
    pack.world.agents[id] = pack.world.agents[id] ?? { id, name: id };
    (pack.world.occupancy[loc] ??= []).push(id);
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
    if (a.ch.m5) a.bank.loadM5(st.m5, st.m);
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
  touch: () => { S.lastVisitor = Date.now(); },
  async start() {
    S.packs = { A: makePack('C2', maskForA()), B: makePack('C2-neg') };
    let note = '没有存档，新建世界';
    try {
      const raw = JSON.parse(await readFile(join(S.dir, 'world.json'), 'utf8'));
      preflightM5Archive(raw);
      applyInto(S.packs.A, raw.A);
      applyInto(S.packs.B, raw.B);
      S.startRaw = raw;
      const mins = (Date.now() - (raw.savedAt ?? Date.now())) / 60000;
      S.model = raw.model ?? S.model;
      if (mins > 1) catchUp(mins);
      note = `载入存档：世界已跑到第 ${S.packs.A.world.t} 刻，休眠 ${mins.toFixed(1)} 分钟`;
    } catch (error) {
      if (error?.code === 'M5_STATE_INVALID') { S.saveError = error.message; throw error; }
      // 免费创空间实测无跨容器重建持久卷（重新部署即清空 /data）。
      // 没有存档时载入内置种子：一份实跑演化的固定历史起点，重置变成可复现的同一起点。
      // 种子不走 catchUp——它是初始条件，不是休眠，补时会往固定起点里掺真实时间。
      try {
        const raw = JSON.parse(await readFile(process.env.SEED_FILE ?? resolve('seed/world.json'), 'utf8'));
        preflightM5Archive(raw);
        applyInto(S.packs.A, raw.A);
        applyInto(S.packs.B, raw.B);
        S.startRaw = raw;
        S.model = raw.model ?? S.model;
        note = `载入内置种子存档：从第 ${S.packs.A.world.t} 刻的历史起点继续（seed=${raw.seed}）`;
      } catch (error) {
        if (error?.code === 'M5_STATE_INVALID') { S.saveError = error.message; throw error; }
        /* 连种子也没有就是新世界的正常起点，交给应用层播报 */
      }
    }
    // 起点没Load到任何东西时，把当前这份新建世界认成本次会话的起点：
    // 否则切 M3/M4 开关会退回"从零刻重跑"，而重跑出来的世界取决于点了多久，读数没法解释。
    S.startRaw ??= serialize();
    S.savedAt = Date.now();
    S.timer = setInterval(() => tick(), TICK_MS);
    process.on('SIGINT', async () => {
      await save();
      process.exit(0);
    });
    process.on('SIGTERM', async () => {
      await save();
      process.exit(0);
    });
    return { note, dir: S.dir };
  },
  // 只读句柄：给测试和未来插桩用。写操作仍然只走 ctl/act，避免绕过规则层
  get packs() {
    return S.packs;
  },
  async tickOnce() {
    await tick();
    return this.snapshot();
  },
  // 常驻循环必须能关掉：测试里 import 过 host 之后若不 stop，node --test 会因为计时器还活着而不退出
  stop() {
    if (S.timer) clearInterval(S.timer);
    S.timer = null;
  },
  status: () => ({ t: S.packs?.A.world.t ?? 0, running: S.running, brain: CFG.brain, savedAt: S.savedAt, missed: S.missed, modelCalls: S.model.calls, watching: observerActive(S.lastVisitor, Date.now()), saveError: S.saveError, masks: S.masks }),
  snapshot() {
    const sum = (p, k) => Object.values(p.agents).reduce((s, a) => s + (a.counters[k] ?? 0), 0);
    const view = (p, layered) => ({
      t: p.world.t,
      phase: phaseOf(p.world.t), // L0 时钟：页面上"现在是什么时候"必须是世界事实，不是玩家猜的
      pantry: p.world.pantry,
      // PLAN §28：房间表/网格/天气/开关/铜币都是世界事实，前端按这份渲染（美术资源后接不影响结构）
      rooms: p.world.locs, grid: p.world.grid, outdoor: p.world.outdoor,
      weather: p.world.weather, features: p.world.features, coins: p.world.coins, things: p.world.things, companions: p.world.companions ?? [],
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
          }];
        }),
      ),
      log: p.log.slice(-40),
      playerLog: (p.playerLog ?? []).slice(-12), // 玩家自己的动作与驳回：主日志窗口会把它们挤掉
      series: p.series.slice(-SERIES_CAP),
      viabCrit: PARAMS.viab.crit, // 曲线上的操作点参考线：跌破这里，存续才开始影响选择
      stat: p.stat,
    });
    return { savedAt: S.savedAt, running: S.running, brain: CFG.brain, missed: S.missed, model: { ...S.model, budget: BUDGET, watching: observerActive(S.lastVisitor, Date.now()) }, saveError: S.saveError, masks: S.masks, layer: { commitment: PARAMS.m3.commitment, tau: PARAMS.coupling.tau, minInput: PARAMS.coupling.minInput }, A: view(S.packs.A, true), B: view(S.packs.B, false) };
  },
  async act(body) {
    if (!S.packs) return { ok: false, error: 'NO_WORLD' };
    for (const key of ['A', 'B']) {
      const w = S.packs[key].world;
      // 房间名必须真实存在：上一版这里不校验，脚本传了个 undefined 就把玩家从 loc 里写没了
      // （JSON 会丢掉 undefined 键），整局之后都找不到"你"。
      if (body.kind === 'move' && (w.locs ?? LOCS)[body.room] && w.loc.p1 !== body.room) {
        w.occupancy[w.loc.p1] = (w.occupancy[w.loc.p1] ?? []).filter((x) => x !== 'p1');
        w.loc.p1 = body.room;
        (w.occupancy[body.room] ??= []).push('p1');
      }
      if (body.kind === 'say') {
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
    const known = ['pause', 'resume', 'brain', 'reset', 'catchup', 'step', 'mask'];
    if (body.action === 'pause') S.running = false;
    if (body.action === 'resume') S.running = true;
    if (body.action === 'brain') {
      configure({ brain: body.brain });
      buildPacks();
    }
    if (body.action === 'reset') {
      // 重置是从零刻新建世界，不是回到种子：这次会话的起点必须跟着改写，
      // 否则之后切一次 M3/M4 会把已经被丢掉的那个世界又拿回来。
      S.packs = { A: makePack('C2', maskForA()), B: makePack('C2-neg') };
      S.startRaw = serialize();
      // 补时记账属于被丢掉的那个世界：不清零的话，重置后的页面还会挂着「休眠 9.3 分钟后醒来」这句话，
      // 而那句话描述的是已经不存在的世界。savedAt 同时刷新，免得下次载入把重置前的空档也算进去。
      S.missed = { minutes: 0, applied: 0, capped: false };
      S.savedAt = Date.now();
      await save();
    }
    if (body.action === 'catchup') catchUp(Number(body.minutes ?? 30));
    if (body.action === 'step') await tick();
    if (body.action === 'mask') {
      const key = body.key;
      if (!(key in S.masks)) return { ...this.status(), ok: false, error: 'UNKNOWN_MASK' };
      const next = Boolean(body.on);
      if (next === S.masks[key]) return this.status();
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
