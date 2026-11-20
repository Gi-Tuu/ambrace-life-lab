// P1c 时间债务收口闸门：talk/sleep/compare 短锁、正式路径 0 旧配额、world.t 派生、
// 感知只消费一次、离线/在线同 rate、居民生理不 6 倍。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'p1c-time-'));
process.env.SEED_FILE = join(ROOT, 'seed', 'world.json');
process.env.TICK_MS = '3600000'; // 1 游戏分钟 = 1 真实分钟：测试期间自动调度不会自己推进世界
process.env.GAME_MODE = 'game';
process.env.GAME_RULES = '1';
process.env.BRAIN = 'local';
process.env.MODEL_UNATTENDED = '0';
process.env.V73_TEST = '1';
process.env.SAVE_EVERY = '1000000';
process.env.ACT_SAVE_COALESCE_MS = '1000000';
process.env.CATCHUP_COOLDOWN_MS = '0';
process.env.MAX_CALLS_PER_TICK = '1';
process.env.UNATTENDED_CALLS_PER_TICK = '1';

const { host, campSurv } = await import('./host.mjs');
const { createSurvPlay, tickSurvPlay, dumpSurv, loadSurv, resetSimMinuteCursor, awaitSurvivalThinks } = await import('./survplay.mjs');
const { createSimClock } = await import('./sim-clock.mjs');
const { emitPercept } = await import('./body.mjs');
const { CURRENT_EVENT_RULES } = await import('./rng.mjs');
const { NEED_META } = await import('./drives.mjs');

const FORMAL = {
  eventRulesVersion: CURRENT_EVENT_RULES, independentWorld: true, gameRules: true,
  residentialDecisions: true, unifiedCooperation: true, settlementLife: true,
  autonomousGoals: true, farmLife: true, regionalWork: true, ecosystem: true,
  wildFood: true, playerRation: true,
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function formalWorld(seed = 7) {
  const clock = createSimClock({ now: () => 0, tickMs: 3600000, manual: true });
  const sp = createSurvPlay(seed, { ...FORMAL, simTime: true, simClock: clock });
  resetSimMinuteCursor(sp.world);
  return { sp, clock };
}
function setFormalMinutes(sp, minutes) {
  sp.world.simClock.setGameMinutes(minutes);
  resetSimMinuteCursor(sp.world);
}

test('P1c-01 正式 host 路径同一刻 12 个动作全成，0 旧超时码', async (t) => {
  await host.start();
  t.after(() => host.stop());
  assert.ok((await host.ctl({ action: 'v73_fixture' })).ok);
  const live = campSurv(null);
  setFormalMinutes(live, live.world.simClock.nowMinutes() + 600);
  const moved = await host.act({ mode: 'survival', kind: 'move', room: 'yard' });
  assert.equal(moved.ok, true, JSON.stringify(moved));
  const rows = [];
  for (let i = 0; i < 12; i += 1) rows.push(await host.act({ mode: 'survival', kind: 'gather' }));
  assert.deepEqual(rows.map((r) => r.code ?? 'OK'), Array(12).fill('OK'), JSON.stringify(rows));
  assert.ok(!rows.some((r) => r.code === 'TIME_WAIT'));
  const view = host.snapshot().survival;
  assert.equal(view.player.timeMax, 1440);
  assert.ok(view.player.timeLeft < 1440, '12 个 10 分动作必须记入日统计');
});

test('P1c-02 talk_say 两阶段：模型等待不持锁，并发第二句 SAY_PENDING 且只调一次模型', async (t) => {
  await host.start();
  t.after(() => host.stop());
  const sp = campSurv(null), w = sp.world;
  setFormalMinutes(sp, 0);
  w.agents.a1.drives.v.social = 0.5;
  w.agents.a1.drives.v.energy = 0.9;
  w.loc.a1 = w.loc.p1; // 对话夹具：同屋
  (w.occupancy[w.loc.p1] ??= []).push('a1');
  host.touch('survival');

  let enteredResolve;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  let releaseModel;
  const gate = new Promise((resolve) => { releaseModel = resolve; });
  let talkCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init?.body ?? '{}');
    const prompt = String(body.messages?.[0]?.content ?? '');
    if (prompt.includes('只回一句中文台词')) {
      talkCalls += 1;
      enteredResolve();
      await gate;
      return new Response(JSON.stringify({ choices: [{ message: { content: '模型台词' } }], usage: { total_tokens: 2 } }), { headers: { 'content-type': 'application/json' } });
    }
    const id = /^- ([^ ]+) \| /m.exec(prompt)?.[1];
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ id, reason: '夹具' }) } }] }), { headers: { 'content-type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  host.setBackend({ providers: ['http://fixture.local'], keys: ['fixture'], models: ['fixture'], brain: 'model' });
  assert.ok((await host.act({ mode: 'survival', kind: 'talk_open', target: 'a1' })).ok);

  const first = host.act({ mode: 'survival', kind: 'talk_say', target: 'a1', text: '你好' });
  await entered;
  // 模型在途：普通输入不被对话锁阻塞（用不改位置的技术输入，避免对话因离开而失效）。
  const actAt = Date.now();
  const moved = await host.act({ mode: 'survival', kind: 'busy_cancel' });
  const actMs = Date.now() - actAt;
  assert.equal(moved.code, 'NO_BUSY', JSON.stringify(moved));
  assert.ok(actMs < 500, `模型等待期间普通输入被阻塞：${actMs}ms`);
  // 并发第二句：不得重复调模型、不得覆盖对话状态。
  const second = await host.act({ mode: 'survival', kind: 'talk_say', target: 'a1', text: '再说一句' });
  assert.equal(second.code, 'SAY_PENDING', JSON.stringify(second));
  assert.equal(talkCalls, 1);
  releaseModel();
  const said = await first;
  assert.equal(said.ok, true, JSON.stringify(said));
  assert.equal(said.line, '模型台词');
});

test('P1c-03 camp_sleep 在 tick 在途时可返回；睡眠是短锁内原子事务，其它输入排在后面', async (t) => {
  await host.start();
  t.after(() => host.stop());
  const { Organism } = await import('./agent.mjs');
  const original = Organism.prototype.tick;
  let enteredResolve, releaseTick;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  const gate = new Promise((resolve) => { releaseTick = resolve; });
  Organism.prototype.tick = async function slowTick(world) {
    enteredResolve();
    await gate;
    return original.call(this, world);
  };
  try {
    const sp = campSurv(null);
    setFormalMinutes(sp, 0); // hour=0 ⇒ 睡 4 刻
    assert.equal((await host.act({ mode: 'survival', kind: 'move', room: 'home' })).ok, true);
    const step = host.ctl({ action: 'step' }); // tick 在途（A/B 分支 await 居民 tick）
    await entered;
    const before = host.snapshot().survival.t;
    const started = Date.now();
    const slept = await host.act({ mode: 'survival', kind: 'camp_sleep' });
    const sleepMs = Date.now() - started;
    assert.equal(slept.ok, true, JSON.stringify(slept));
    assert.equal(slept.ticks, 4, JSON.stringify(slept));
    assert.equal(host.snapshot().survival.t, before + 4);
    assert.ok(sleepMs < 2500, `睡眠不应等整拍/模型：${sleepMs}ms`);
  } finally {
    releaseTick();
    await host.ctl({ action: 'step' }).catch(() => {});
    Organism.prototype.tick = original;
  }
});

test('P1c-04 感知带 seq/decidedAt：同一事件只被一个 10 分 think 消费一次', async () => {
  const { sp } = formalWorld(13);
  const a = sp.world.agents.a1;
  a.nextThinkMin = 0;
  sp.world.percepts = [{ for: 'a1', kind: 'alarm', subject: '墙外', salience: 0.9 }];
  const base = a.counters.externalEvents ?? 0;
  const consumed0 = a.perceptConsumed ?? 0;
  await tickSurvPlay(sp, { minutes: 20 }); // 两个 10 分 think 落在同一刻
  assert.equal((a.counters.externalEvents ?? 0) - base, 1, '同一事件只触发一次外部事件计数');
  assert.equal((a.perceptConsumed ?? 0) - consumed0, 1, '事件只被消费一次（seq 闸门）');
  assert.ok(Number.isFinite(a.lastPerceptDecidedAt), '消费时必须带 decidedAt');
  await tickSurvPlay(sp, { minutes: 20 });
  assert.equal((a.counters.externalEvents ?? 0) - base, 1, '后续 10 分 think 不得重复消费');
  assert.equal((a.perceptConsumed ?? 0) - consumed0, 1);
  // 迟到事件：超过一个刻还没被 think 消费 ⇒ 丢弃并记 trace，不补消费。
  const late = emitPercept(sp.world, { for: 'a1', kind: 'alarm', subject: '迟到' });
  const expired0 = a.perceptExpired ?? 0;
  sp.world.simClock.setGameMinutes(late.at + 120);
  resetSimMinuteCursor(sp.world);
  a.nextThinkMin = 0;
  await tickSurvPlay(sp, { minutes: 10 });
  assert.ok((a.perceptExpired ?? 0) > expired0, '迟到事件必须记过期');
  assert.ok(a.trace.some((r) => r.layer === 'percept_expired' && r.kind === 'alarm'));
});

test('P1c-05 world.t 是派生 getter：读=floor(minutes/60)，写=重锚，JSON/clone/读档不炸', () => {
  const { sp, clock } = formalWorld();
  const w = sp.world;
  const desc = Object.getOwnPropertyDescriptor(w, 't');
  assert.equal(typeof desc.get, 'function', '正式世界的 t 必须是派生 getter');
  assert.equal(Object.keys(w).includes('t'), true, 'getter 必须可枚举，JSON 快照才会带 t');
  clock.setGameMinutes(610);
  assert.equal(w.t, 10);
  w.t = 12;
  assert.equal(Math.round(clock.nowMinutes()), 720, '写 t 只允许重锚时钟');
  const raw = dumpSurv(sp);
  assert.equal(raw.t, 12);
  assert.equal(raw.clock.gameMinutes, 720);
  const clone = structuredClone(raw);
  assert.equal(clone.t, 12, 'structuredClone 必须读得到派生 t');
  const back = loadSurv(clone, 7, { ...FORMAL, simTime: true });
  assert.equal(back.world.t, 12);
  assert.ok(Math.abs(back.world.simClock.nowMinutes() - 720) < 1e-6);
});

test('P1c-06 暂停/倍速/离线补时同一 rate：rate=2 时 60 真实分补 120 游戏分', async (t) => {
  await host.start();
  t.after(() => host.stop());
  const sp = campSurv(null);
  setFormalMinutes(sp, 0);
  assert.ok((await host.ctl({ action: 'pause' })).ok);
  const t0 = host.snapshot().survival.t;
  const one = await host.ctl({ action: 'catchup', minutes: 60 });
  assert.equal(one.ok, true, JSON.stringify(one));
  assert.equal(host.snapshot().missed.survival.appliedMinutes, 60);
  assert.equal(host.snapshot().survival.t, t0 + 1);
  assert.ok((await host.ctl({ action: 'rate', rate: 2 })).ok);
  assert.equal(host.snapshot().survival.clock.rate, 2);
  const two = await host.ctl({ action: 'catchup', minutes: 60 });
  assert.equal(two.ok, true, JSON.stringify(two));
  assert.equal(host.snapshot().missed.survival.appliedMinutes, 120, '倍速必须和在线共用 clock.rate');
  assert.equal(host.snapshot().survival.t, t0 + 3);
  const resumed = await host.ctl({ action: 'resume' });
  assert.equal(resumed.ok, true);
});

test('P1c-07 居民生理每 60 分只结算一次，不因 6 个 10 分 think 变成 6 倍', async () => {
  const { sp } = formalWorld(19);
  const a = sp.world.agents.a1;
  a.nextThinkMin = 0;
  a.drives.v.energy = 0.9;
  const metab0 = a.metabCount ?? 0;
  const age0 = a.viab.age ?? 0;
  for (let i = 0; i < 5; i += 1) { // 前 50 分钟：同一个派生刻
    await tickSurvPlay(sp, { minutes: 10 });
  }
  assert.equal((a.metabCount ?? 0) - metab0, 1, '5 个 10 分 think 只能结算 1 刻基础代谢');
  assert.ok(Math.abs((a.viab.age ?? 0) - age0 - 1) < 1e-9, 'viab 时间只前进 1 刻');
  await tickSurvPlay(sp, { minutes: 10 }); // 第 60 分钟跨入下一派生刻
  await tickSurvPlay(sp, { minutes: 10 }); // 下一次 10 分 think 落在新刻
  assert.equal((a.metabCount ?? 0) - metab0, 2, '跨刻后结算第二次，绝不是 6 倍');
  assert.ok(Math.abs((a.viab.age ?? 0) - age0 - 2) < 1e-9, '两刻时间对应两次结算');
});

test('P1c-08 正式连续世界取消"每拍最多 N 次"：同刻两个事件都真的问到模型', async (t) => {
  await host.start();
  t.after(() => host.stop());
  const sp = campSurv(null);
  setFormalMinutes(sp, 600);
  host.touch('survival');
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls += 1;
    const body = JSON.parse(init?.body ?? '{}');
    const prompt = String(body.messages?.[0]?.content ?? '');
    const id = /^- ([^ ]+) \| /m.exec(prompt)?.[1];
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ id, reason: '夹具' }) } }] }), { headers: { 'content-type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  host.setBackend({ providers: ['http://fixture.local'], keys: ['fixture'], models: ['fixture'], brain: 'model' });
  assert.ok((await host.ctl({ action: 'brain', brain: 'model' })).ok);
  for (const id of ['a1', 'a2']) {
    sp.world.pending.push({ for: id, evt: { kind: 'contact', valence: 0.2, selfCaused: false, about: 'p1', serves: 'social' } });
    sp.world.agents[id].nextThinkMin = 0;
  }
  await tickSurvPlay(sp, { minutes: 10 });
  await awaitSurvivalThinks(sp);
  await sleep(20);
  assert.ok(calls >= 2, `每拍上限必须只作用于研究态，实际模型调用 ${calls}`);
});

test('P1c-09 compare 动作在 tick 在途时可返回（与普通 /act 同短锁）', async (t) => {
  await host.start();
  t.after(() => host.stop());
  const { Organism } = await import('./agent.mjs');
  const original = Organism.prototype.tick;
  let enteredResolve, releaseTick;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  const gate = new Promise((resolve) => { releaseTick = resolve; });
  Organism.prototype.tick = async function slowTick(world) {
    enteredResolve();
    await gate;
    return original.call(this, world);
  };
  try {
    host.touch('compare');
    const pair = host.snapshot('compare').comparison;
    assert.ok(pair, '对照世界必须存在');
    const step = host.ctl({ action: 'step' });
    await entered;
    const started = Date.now();
    const moved = await host.act({ mode: 'compare', revision: pair.revision, kind: 'move', room: 'yard' });
    const ms = Date.now() - started;
    assert.equal(moved.ok, true, JSON.stringify(moved));
    assert.ok(ms < 1000, `compare 输入不应等 tickChain：${ms}ms`);
    releaseTick();
    await step;
  } finally {
    releaseTick();
    Organism.prototype.tick = original;
  }
});
