// 权威世界宿主：状态在服务器上持续演化，浏览器只是观察与介入的窗口。
// 三件事是这里的核心，不是装饰：
//   1) 持久化：状态落 DATA_DIR；平台无持久卷时（创空间实测）靠内置种子回到固定历史起点
//   2) 时间差推进：免费创空间会休眠。醒来后必须把「没人看的那段时间」补进内部状态，
//      否则「内部状态持续存在」这个主张在演示现场就会被戳穿。
//   3) 只补状态、不补决策：休眠期间没有观察者，编造那段时刻的行为等于伪造历史。
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { makeWorld, spawn, scanSecrets, LOCS, hail } from './body.mjs';
import { phaseOf } from './clock.mjs';
import { tell } from './gossip.mjs';
import { Organism } from './agent.mjs';
import { hashSeed } from './rng.mjs';
import { DIMS } from './traits.mjs';
import { preferenceBands } from './model.mjs';
import { PARAMS } from './params.mjs';

const ROSTER = [
  { id: 'a1', name: '岑', archetype: '谨慎', loc: 'home' },
  { id: 'a2', name: '绛', archetype: '冲动', loc: 'hall' },
  { id: 'a3', name: '蓑', archetype: '孤僻', loc: 'watch' },
];
const TICK_MS = Number(process.env.TICK_MS ?? 1200);
const CATCHUP_CAP_MIN = Number(process.env.CATCHUP_CAP_MIN ?? 360); // 最多补 6 小时，再多就如实标「被截断」
const SAVE_EVERY = 10;
const SERIES_CAP = Number(process.env.SERIES_CAP ?? 720); // 存续曲线保留多少刻（默认 12 分钟实时）

const CFG = { providers: [], keys: [], model: '', seed: Number(process.env.SEED ?? 7), brain: 'local' };
const S = { packs: null, timer: null, running: true, savedAt: 0, missed: { minutes: 0, capped: false }, model: { calls: 0, tokens: 0, attempts: [] }, saveError: null, dir: process.env.DATA_DIR ?? 'data' };

export function configure({ providers = [], keys = [], model = '', seed, brain } = {}) {
  if (providers.length) CFG.providers = providers.map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
  if (keys.length) CFG.keys = keys.map((s) => s.trim()).filter(Boolean);
  if (model) CFG.model = model;
  if (seed) CFG.seed = seed;
  if (brain) CFG.brain = brain;
}

function makePack(condition) {
  const world = makeWorld({ pantries: 3, stash: 5 });
  const agents = {};
  for (const r of ROSTER) {
    const a = new Organism({ ...r, seed: hashSeed(CFG.seed, `${r.id}:${condition}`), condition, deliberator: CFG.brain === 'model' ? modelBrain : null });
    agents[r.id] = a;
    world.agents[r.id] = a;
    spawn(world, r.id, r.loc);
  }
  world.agents.p1 = { id: 'p1', name: '你', isPlayer: true };
  spawn(world, 'p1', 'hall');
  return { world, agents, condition, log: [], series: [], stat: { 决策: 0, 高冲动: 0, 越轨: 0, 驳回: 0, 发现: 0 } };
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
  for (let i = 0; i < CFG.providers.length; i++) {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), 20000);
    try {
      const res = await fetch(`${CFG.providers[i]}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${CFG.keys[i] ?? CFG.keys[0]}` },
        body: JSON.stringify({ model: CFG.model, temperature: 0.85, messages: [{ role: 'user', content: lines.join('\n') }], response_format: { type: 'json_object' }, max_tokens: 100 }),
        signal: ac.signal,
      });
      if (!res.ok) { S.model.attempts.push(`HTTP ${res.status}`); continue; }
      const j = await res.json();
      S.model.calls += 1;
      S.model.tokens += j.usage?.total_tokens ?? 0;
      const p = JSON.parse(String(j.choices?.[0]?.message?.content ?? '').replace(/^```json?/i, '').replace(/```\s*$/i, '').trim());
      const hit = scored.find((s) => s.id === p.id);
      if (!hit) return null;
      agent.lastReason = p.reason ?? '';
      return { id: hit.id };
    } catch (e) {
      S.model.attempts.push(String(e.message).slice(0, 40));
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
          p.log.push({ t: p.world.t, who: a.name, kind: 'act', text: `${t.action}｜${a.bank.summary()}` });
        }
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
    world: { t: p.world.t, pantry: p.world.pantry, riskyPortion: p.world.riskyPortion, loc: { ...p.world.loc }, occupancy: p.world.occupancy, stash: { ...p.world.stash }, expect: { ...p.world.expect }, flags: p.world.flags, secrets: (p.world.secrets ?? []).map((s) => ({ ...s, known: [...s.known] })) },
    log: p.log,
    playerLog: p.playerLog ?? [],
    series: p.series,
    stat: p.stat,
    agents: Object.fromEntries(
      Object.values(p.agents).map((a) => [
        a.id,
        { m: a.bank.snapshot(), drives: { ...a.drives.v }, alone: a.drives.aloneTicks, memory: a.memory.dump(), rel: [...a.relations.map.entries()], relCeiling: a.relations.ceiling, habit: a.habit.dump(), forwardModel: a.forwardModel.dump(), viab: a.viab.dump(), counters: a.counters },
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

function applyInto(pack, d) {
  if (!d) return;
  pack.condition = d.condition ?? pack.condition;
  pack.log = d.log ?? [];
  pack.playerLog = d.playerLog ?? [];
  pack.series = d.series ?? []; // 曲线跟着存档走：重启后"谁先垮"的那段历史不能凭空消失
  pack.stat = d.stat ?? pack.stat; // 不存的话每次重启，页面上的对照计数都归零，实验读数就断了
  Object.assign(pack.world, { t: d.world.t, pantry: d.world.pantry, riskyPortion: d.world.riskyPortion ?? pack.world.riskyPortion, loc: d.world.loc, stash: d.world.stash, expect: d.world.expect, flags: d.world.flags ?? {} });
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
    Object.assign(a.bank.m, st.m ?? {});
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
    Object.assign(a.counters, st.counters ?? {});
  }
}

export const host = {
  setBackend: configure,
  async start() {
    S.packs = { A: makePack('C2'), B: makePack('C2-neg') };
    let note = '没有存档，新建世界';
    try {
      const raw = JSON.parse(await readFile(join(S.dir, 'world.json'), 'utf8'));
      applyInto(S.packs.A, raw.A);
      applyInto(S.packs.B, raw.B);
      const mins = (Date.now() - (raw.savedAt ?? Date.now())) / 60000;
      S.model = raw.model ?? S.model;
      if (mins > 1) catchUp(mins);
      note = `载入存档：世界已跑到第 ${S.packs.A.world.t} 刻，休眠 ${mins.toFixed(1)} 分钟`;
    } catch {
      // 免费创空间实测无跨容器重建持久卷（重新部署即清空 /data）。
      // 没有存档时载入内置种子：一份实跑演化的固定历史起点，重置变成可复现的同一起点。
      // 种子不走 catchUp——它是初始条件，不是休眠，补时会往固定起点里掺真实时间。
      try {
        const raw = JSON.parse(await readFile(process.env.SEED_FILE ?? resolve('seed/world.json'), 'utf8'));
        applyInto(S.packs.A, raw.A);
        applyInto(S.packs.B, raw.B);
        S.model = raw.model ?? S.model;
        note = `载入内置种子存档：从第 ${S.packs.A.world.t} 刻的历史起点继续（seed=${raw.seed}）`;
      } catch {
        /* 连种子也没有就是新世界的正常起点，交给应用层播报 */
      }
    }
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
  status: () => ({ t: S.packs?.A.world.t ?? 0, running: S.running, brain: CFG.brain, savedAt: S.savedAt, missed: S.missed, modelCalls: S.model.calls, saveError: S.saveError }),
  snapshot() {
    const sum = (p, k) => Object.values(p.agents).reduce((s, a) => s + (a.counters[k] ?? 0), 0);
    const view = (p) => ({
      t: p.world.t,
      phase: phaseOf(p.world.t), // L0 时钟：页面上"现在是什么时候"必须是世界事实，不是玩家猜的
      pantry: p.world.pantry,
      loc: p.world.loc,
      occupancy: p.world.occupancy,
      stash: p.world.stash,
      // S3：你知道的事（玩家全知）与每条谁已经知道了。known 是 Set，出去前摊成数组
      secrets: (p.world.secrets ?? []).map((s) => ({ id: s.id, kind: s.kind, detail: s.detail, about: s.about, holder: s.holder, known: [...s.known].map((k) => p.agents[k]?.name ?? k) })),
      // 推理成本账（O11）：事件 / 被问 / 跳过 / 驳回重问 / 被告知
      cost: { 事件: sum(p, 'triggered'), 被问: sum(p, 'asked'), 跳过: sum(p, 'skipped'), 驳回重问: sum(p, 'askedRetry'), 被告知: sum(p, 'informed'), 反思: sum(p, 'reflect') },
      agents: Object.fromEntries(
        Object.values(p.agents).map((a) => [
          a.id,
          { id: a.id, name: a.name, archetype: a.traits.archetype, m: a.bank.snapshot(), baseline: a.traits.baseline, drives: { ...a.drives.v }, summary: a.bank.summary(), viab: { v: Number(a.viab.v.toFixed(3)), reserve: Number(a.viab.reserve.toFixed(3)), lost: a.viab.ledger.map((l) => l.organ) }, counters: a.counters, rel: a.relations.dump(p.world.t), last: [...a.trace].reverse().find((r) => r.action) ?? null, reason: a.lastReason ?? '' },
        ]),
      ),
      log: p.log.slice(-40),
      playerLog: (p.playerLog ?? []).slice(-12), // 玩家自己的动作与驳回：主日志窗口会把它们挤掉
      series: p.series.slice(-SERIES_CAP),
      viabCrit: PARAMS.viab.crit, // 曲线上的操作点参考线：跌破这里，存续才开始影响选择
      stat: p.stat,
    });
    return { savedAt: S.savedAt, running: S.running, brain: CFG.brain, missed: S.missed, model: S.model, saveError: S.saveError, A: view(S.packs.A), B: view(S.packs.B) };
  },
  async act(body) {
    if (!S.packs) return { ok: false, error: 'NO_WORLD' };
    for (const key of ['A', 'B']) {
      const w = S.packs[key].world;
      // 房间名必须真实存在：上一版这里不校验，脚本传了个 undefined 就把玩家从 loc 里写没了
      // （JSON 会丢掉 undefined 键），整局之后都找不到"你"。
      if (body.kind === 'move' && LOCS[body.room] && w.loc.p1 !== body.room) {
        w.occupancy[w.loc.p1] = (w.occupancy[w.loc.p1] ?? []).filter((x) => x !== 'p1');
        w.loc.p1 = body.room;
        (w.occupancy[body.room] ??= []).push('p1');
      }
      if (body.kind === 'say') {
        for (const who of (w.occupancy[w.loc.p1] ?? []).filter((x) => x !== 'p1')) {
          w.pending.push({ for: who, evt: { kind: 'contact', valence: 0.4, selfCaused: false, about: 'p1', serves: 'social' } });
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
    if (body.action === 'pause') S.running = false;
    if (body.action === 'resume') S.running = true;
    if (body.action === 'brain') {
      configure({ brain: body.brain });
      S.packs = { A: makePack('C2'), B: makePack('C2-neg') };
    }
    if (body.action === 'reset') {
      S.packs = { A: makePack('C2'), B: makePack('C2-neg') };
      // 补时记账属于被丢掉的那个世界：不清零的话，重置后的页面还会挂着「休眠 9.3 分钟后醒来」这句话，
      // 而那句话描述的是已经不存在的世界。savedAt 同时刷新，免得下次载入把重置前的空档也算进去。
      S.missed = { minutes: 0, applied: 0, capped: false };
      S.savedAt = Date.now();
      await save();
    }
    if (body.action === 'catchup') catchUp(Number(body.minutes ?? 30));
    if (body.action === 'step') await tick();
    return this.status();
  },
  save,
};

export const DIMS_LIST = DIMS;
