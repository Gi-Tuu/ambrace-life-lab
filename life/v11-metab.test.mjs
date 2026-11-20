// 1.1 第 2 项：分钟级身体 micro-step 闸门。
//
// 规矩（与派单硬约束一致）：
//   · 60 个 1 分钟步的身体总量 == 旧「1 次/小时」一步（≤1e-9），且与 think 次数无关；
//   · 分钟身体步不消费世界 RNG；调制 bank 仍按旧小时点 step(1)，同一 think 日程下 bank/RNG 逐位相同；
//   · 暂停/倍速只改变真实时间→游戏分钟的换算，身体只随游戏分钟积分；
//   · 迟到 think 只读快照，不补结算；旧档（无 minuteMetab 字段）可读并继续按分钟积分；
//   · 研究态（无 simClock）无 minuteMetab、仍按 tick 结算。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSurvPlay, tickSurvPlay, dumpSurv, loadSurv, resetSimMinuteCursor, survView } from './survplay.mjs';
import { createSimClock } from './sim-clock.mjs';
import { CURRENT_EVENT_RULES } from './rng.mjs';
import { NEED_META } from './drives.mjs';
import { bodyClockEnabled } from './body-clock.mjs';

const FORMAL = {
  eventRulesVersion: CURRENT_EVENT_RULES, independentWorld: true, gameRules: true,
  residentialDecisions: true, unifiedCooperation: true, settlementLife: true,
  autonomousGoals: true, farmLife: true, regionalWork: true, ecosystem: true,
  wildFood: true, playerRation: true,
};

function formal(seed = 7, { minuteMetab, rate = 1, paused = false } = {}) {
  const clock = createSimClock({ now: () => 0, tickMs: 3600000, manual: true, rate, paused });
  const sp = createSurvPlay(seed, {
    ...FORMAL, simTime: true, simClock: clock,
    ...(minuteMetab === undefined ? {} : { minuteMetab }),
  });
  resetSimMinuteCursor(sp.world);
  return { sp, clock };
}

// 关掉一切会改变身体的决策：think 仍照常发生，但 decideOn 直接返回 null。
function quiet(sp, { thinks = false, store = 9 } = {}) {
  const w = sp.world;
  w.survival.store = store;
  w.weatherEnabled = false;
  // 本闸门只看身体积分：把玩家挪开，保证每个居民都独处（contact=false），
  // 社交/aloneTicks 的整点步才能与旧一步逐位对齐。
  w.loc.p1 = 'yard';
  for (const room of Object.keys(w.occupancy)) w.occupancy[room] = [];
  for (const id of Object.keys(w.agents)) (w.occupancy[w.loc[id]] ??= []).push(id);
  for (const a of Object.values(w.agents)) {
    if (!a.isPlayer) {
      a.decideOn = () => null;
      a.execute = () => null; // 反射/习惯也不得改身体（本闸门只测身体积分）
      a.nextThinkMin = thinks ? 0 : 1e9;
    }
    // P1-1：p1 也纳入守恒读数。玩家不跑决策环，但身体初值必须与居民同口径，
    // 否则 on/off 或 p1/居民只能比"各自的变化量"，比不了绝对值。
    a.drives.v.energy = 0.9;
    a.drives.v.social = 0.5;
    a.drives.v.stimulation = 0.5;
    a.viab.v = 0.7;
    a.viab.reserve = 0.2;
    a.viab.stage = 0;
    a.viab.ledger = [];
  }
}

function countThinks(a) {
  const original = a.tick.bind(a);
  a.thinks = 0;
  a.tick = async (world) => { a.thinks += 1; return original(world); };
}

function bodyOf(a) {
  return {
    energy: a.drives.v.energy,
    social: a.drives.v.social,
    stimulation: a.drives.v.stimulation,
    aloneTicks: a.drives.aloneTicks,
    v: a.viab.v,
    reserve: a.viab.reserve,
    age: a.viab.age,
    upkeepPaid: a.viab.upkeepPaid,
    stage: a.viab.stage,
    ledger: a.viab.ledger.length,
  };
}

function closeBody(a, b, msg, { skip = [] } = {}) {
  for (const key of Object.keys(a)) {
    if (skip.includes(key)) continue;
    assert.ok(Math.abs(a[key] - b[key]) <= 1e-9, `${msg}: ${key} 差 ${Math.abs(a[key] - b[key])}（${a[key]} vs ${b[key]}）`);
  }
}

const advance = (sp, minutes) => tickSurvPlay(sp, { minutes });

test('V11-METAB-01 60 个 1 分钟步 == 旧 1 次/小时（身体量 ≤1e-9），含 6 次 think', async () => {
  const oldSp = formal(7, { minuteMetab: false }).sp;
  const newSp = formal(7, { minuteMetab: true }).sp;
  quiet(oldSp, { thinks: true });
  quiet(newSp, { thinks: true });
  for (const a of Object.values(oldSp.world.agents)) if (!a.isPlayer) countThinks(a);
  for (const a of Object.values(newSp.world.agents)) if (!a.isPlayer) countThinks(a);
  // 先走到 100 分：让旧路径的首刻补结算/日界配给都过去，取同一窗口内的增量做守恒。
  await advance(oldSp, 100);
  await advance(newSp, 100);
  const BODY_IDS = ['a1', 'a2', 'a3', 'p1']; // P1-1：p1 也必须在守恒闸门里
  const old0 = Object.fromEntries(BODY_IDS.map((id) => [id, bodyOf(oldSp.world.agents[id])]));
  const new0 = Object.fromEntries(BODY_IDS.map((id) => [id, bodyOf(newSp.world.agents[id])]));
  const oldThinks = oldSp.world.agents.a1.thinks;
  const newThinks = newSp.world.agents.a1.thinks;
  await advance(oldSp, 60);
  await advance(newSp, 60);
  for (const id of BODY_IDS) {
    const oldDelta = Object.fromEntries(Object.entries(bodyOf(oldSp.world.agents[id])).map(([k, v]) => [k, v - old0[id][k]]));
    const newDelta = Object.fromEntries(Object.entries(bodyOf(newSp.world.agents[id])).map(([k, v]) => [k, v - new0[id][k]]));
    closeBody(newDelta, oldDelta, `V11-METAB-01 ${id} 60 分钟增量`);
  }
  for (const id of ['a1', 'a2', 'a3']) {
    assert.equal(oldSp.world.agents[id].metabCount, 3, '旧路径 160 分内按派生刻结算 3 次（窗口内 1 次）');
    assert.equal(newSp.world.agents[id].metabCount, 160, '新路径 160 个分钟步');
  }
  assert.equal(newSp.world.agents.p1.metabCount, 160, 'P1-1：p1 只走 160 个分钟步（worldTick 不再第 61 次）');
  assert.equal(oldSp.world.agents.p1.metabCount, undefined, '旧路径 p1 不进分钟步计数');
  assert.equal(oldSp.world.agents.a1.thinks - oldThinks, 6, '旧路径 60 分窗口 6 次 think');
  assert.equal(newSp.world.agents.a1.thinks - newThinks, 6, '新路径 think 次数不变');
});

test('V11-METAB-02 50 分 5 think 与 50 分 0 think 积分逐位一致；身体步不消费 RNG', async () => {
  const withThink = formal(7, { minuteMetab: true }).sp;
  const noThink = formal(7, { minuteMetab: true }).sp;
  quiet(withThink, { thinks: true });
  quiet(noThink, { thinks: false });
  countThinks(withThink.world.agents.a1);
  const rng0 = noThink.world.agents.a1.rng.state();
  await advance(withThink, 50);
  await advance(noThink, 50);
  closeBody(bodyOf(withThink.world.agents.a1), bodyOf(noThink.world.agents.a1), 'V11-METAB-02 a1', { skip: ['stimulation'] });
  closeBody(bodyOf(withThink.world.agents.p1), bodyOf(noThink.world.agents.p1), 'V11-METAB-02 p1');
  assert.equal(withThink.world.agents.a1.thinks, 5, '50 分内 5 次 think');
  assert.equal(withThink.world.agents.a1.metabCount, 50);
  assert.equal(noThink.world.agents.a1.metabCount, 50);
  assert.equal(withThink.world.agents.p1.metabCount, 50, 'P1-1：p1 50 分 = 50 个分钟步（不是 50×2）');
  assert.equal(noThink.world.agents.p1.metabCount, 50);
  assert.equal(noThink.world.agents.a1.rng.state(), rng0, '分钟身体步不得消费世界 RNG');
  // 不是 1 倍（0.012 一整小时），也不是 6 倍；是 50/60 小时。
  const expected = NEED_META.energy.decay * (50 / 60);
  assert.ok(Math.abs((0.9 - withThink.world.agents.a1.drives.v.energy) - expected) <= 1e-12,
    `能量积分 ${0.9 - withThink.world.agents.a1.drives.v.energy} != ${expected}`);
  assert.ok(Math.abs((withThink.world.agents.a1.viab.age - 0) - 50 / 60) <= 1e-12, 'viab.age 应为 50/60 刻');
  // P1-1：p1 与居民同一口径 —— 能量/存续只随 50 个分钟步变化。
  assert.ok(Math.abs((0.9 - withThink.world.agents.p1.drives.v.energy) - expected) <= 1e-12,
    `p1 能量积分 ${0.9 - withThink.world.agents.p1.drives.v.energy} != ${expected}`);
  assert.ok(Math.abs((withThink.world.agents.p1.viab.age - 0) - 50 / 60) <= 1e-12, 'p1 viab.age 应为 50/60 刻');
});

test('V11-METAB-10 玩家 p1 与居民每小时同量：能量 -0.012、存续同幅，p1 只走 60 个分钟步', async () => {
  const { sp } = formal(7, { minuteMetab: true });
  // store 拉高，隔离 storeHunger 的居民额外消耗：本闸门只比"身体基础积分"。
  quiet(sp, { thinks: false, store: 100 });
  sp.world.survival.lastDay = 0; // 跳过首个世界刻的日界配给（+0.5 能量会把本闸门读数盖掉）
  const p1 = sp.world.agents.p1;
  const a1 = sp.world.agents.a1;
  const e0 = p1.drives.v.energy; const ea0 = a1.drives.v.energy;
  const v0 = p1.viab.v; const va0 = a1.viab.v;
  await advance(sp, 60);
  assert.equal(p1.metabCount, 60, 'p1 每游戏小时 60 个分钟步（没有 worldTick 第 61 次）');
  assert.equal(a1.metabCount, 60, '居民同口径 60 个分钟步');
  const p1Energy = e0 - p1.drives.v.energy;
  const a1Energy = ea0 - a1.drives.v.energy;
  assert.ok(Math.abs(p1Energy - a1Energy) <= 1e-12, `p1 能量衰减 ${p1Energy} != 居民 ${a1Energy}`);
  assert.ok(Math.abs((v0 - p1.viab.v) - (va0 - a1.viab.v)) <= 1e-12, `p1 存续衰减 ${v0 - p1.viab.v} != 居民 ${va0 - a1.viab.v}`);
  assert.ok(Math.abs(p1Energy - NEED_META.energy.decay) <= 1e-12, `p1 每小时能量衰减 ${p1Energy} != ${NEED_META.energy.decay}（-0.024 是重复结算）`);
});

test('V11-METAB-03 暂停/倍速只改变真实时间换算，身体只随游戏分钟积分；0 分钟不动', async () => {
  const paused = formal(7, { minuteMetab: true, paused: true }).sp;
  const rate2 = formal(7, { minuteMetab: true, rate: 2 }).sp;
  quiet(paused);
  quiet(rate2);
  const before = bodyOf(paused.world.agents.a1);
  await advance(paused, 0);
  closeBody(bodyOf(paused.world.agents.a1), before, 'V11-METAB-03 0 分钟');
  await advance(paused, 50);
  await advance(rate2, 50);
  closeBody(bodyOf(paused.world.agents.a1), bodyOf(rate2.world.agents.a1), 'V11-METAB-03 paused vs rate2');
  const expected = NEED_META.energy.decay * (50 / 60);
  assert.ok(Math.abs((0.9 - paused.world.agents.a1.drives.v.energy) - expected) <= 1e-12, '暂停/倍速下积分量仍由游戏分钟决定');
});

test('V11-METAB-04 迟到 think 只读快照：不补结算身体、不动 metabCount', async () => {
  const { sp } = formal(7, { minuteMetab: true });
  quiet(sp);
  const a = sp.world.agents.a1;
  await advance(sp, 30);
  const before = bodyOf(a);
  const count = a.metabCount;
  await a.tick(sp.world); // 迟到 30 分钟后才落地的一次 think
  closeBody(bodyOf(a), before, 'V11-METAB-04');
  assert.equal(a.metabCount, count, 'think 不得再结算身体分钟');
});

test('V11-METAB-05 旧档（无 minuteMetab 字段）可读，读后按分钟积分', async () => {
  const oldSp = formal(7, { minuteMetab: false }).sp;
  quiet(oldSp, { thinks: true });
  await advance(oldSp, 30);
  const raw = dumpSurv(oldSp);
  assert.equal(Object.hasOwn(raw, 'minuteMetab'), false, '开关不进入存档 schema');
  const back = loadSurv(raw, 7, { ...FORMAL, simTime: true });
  quiet(back);
  assert.equal(bodyClockEnabled(back.world), true, '旧档读入后走当前默认（分钟积分）');
  const a = back.world.agents.a1;
  const before = a.drives.v.energy;
  const age0 = a.viab.age;
  await advance(back, 10);
  const expected = NEED_META.energy.decay * (10 / 60);
  assert.ok(Math.abs((before - a.drives.v.energy) - expected) <= 1e-9, `旧档续跑 10 分钟能量积分 ${before - a.drives.v.energy} != ${expected}`);
  assert.ok(Math.abs((a.viab.age - age0) - 10 / 60) <= 1e-9, '旧档续跑 10 分钟 viab.age 前进 10/60');
});

test('V11-METAB-06 研究态（无 simClock）无 minuteMetab，仍按 tick 结算', async () => {
  const sp = createSurvPlay(7, {
    eventRulesVersion: CURRENT_EVENT_RULES, independentWorld: false, gameRules: false,
    residentialDecisions: false, ecosystem: false, wildFood: false,
  });
  const w = sp.world;
  assert.equal(w.simClock, undefined);
  assert.equal(w.minuteMetab, undefined);
  assert.equal(bodyClockEnabled(w), false);
  assert.equal(Object.hasOwn(survView(sp), 'timeMode'), false);
  w.survival.store = 9;
  w.survival.lastDay = 0; // 跳过首日的自动配给回补，只看逐 tick 代谢
  w.weatherEnabled = false;
  for (const a of Object.values(w.agents)) {
    if (a.isPlayer) continue;
    a.decideOn = () => null;
    a.drives.v.energy = 0.9;
  }
  const a = w.agents.a1;
  const n0 = a.metabCount ?? 0;
  for (let i = 0; i < 5; i += 1) await tickSurvPlay(sp, { now: () => 0 });
  assert.equal((a.metabCount ?? 0) - n0, 5, '研究态仍每 tick 一次');
  assert.ok(Math.abs((0.9 - a.drives.v.energy) - 5 * NEED_META.energy.decay) <= 1e-12, '研究态仍按 tick 一步一小时');
});

test('V11-METAB-07 bank 仍按旧小时点 step(1)：同 think 日程下 bank 与 RNG 逐位相同', async () => {
  const oldSp = formal(7, { minuteMetab: false }).sp;
  const newSp = formal(7, { minuteMetab: true }).sp;
  quiet(oldSp, { thinks: true });
  quiet(newSp, { thinks: true });
  await advance(oldSp, 50);
  await advance(newSp, 50);
  for (const id of ['a1', 'a2', 'a3']) {
    const a = oldSp.world.agents[id];
    const b = newSp.world.agents[id];
    assert.deepEqual(a.bank.snapshot(), b.bank.snapshot(), `${id} bank 快照应逐位相同`);
    assert.equal(a.rng.state(), b.rng.state(), `${id} RNG 抽取次数/顺序应逐位相同`);
    assert.deepEqual(a.forwardModel.dump(), b.forwardModel.dump(), `${id} 前向模型同日程应逐位相同`);
  }
});

test('V11-METAB-08 开关默认：正式开、研究关；M5_MINUTE_METAB=0 精确回退', () => {
  const saved = process.env.M5_MINUTE_METAB;
  try {
    delete process.env.M5_MINUTE_METAB;
    assert.equal(formal(7).sp.world.minuteMetab, true, '正式游戏默认开');
    const research = createSurvPlay(7, { eventRulesVersion: CURRENT_EVENT_RULES, gameRules: false });
    assert.equal(research.world.minuteMetab, undefined, '研究态不写字段');
    process.env.M5_MINUTE_METAB = '0';
    assert.equal(formal(7).sp.world.minuteMetab, false, 'env=0 回退旧每刻结算');
    assert.equal(formal(7, { minuteMetab: true }).sp.world.minuteMetab, true, '显式选项可覆盖 env（测试/对照用）');
  } finally {
    if (saved === undefined) delete process.env.M5_MINUTE_METAB;
    else process.env.M5_MINUTE_METAB = saved;
  }
});

test('V11-METAB-09 M5 快慢仓同样按旧小时 step(1)：on/off 的 dumpM5 与 RNG 逐位相同', async () => {
  const make = (minuteMetab) => {
    const clock = createSimClock({ now: () => 0, tickMs: 3600000, manual: true });
    const sp = createSurvPlay(7, {
      ...FORMAL, simTime: true, simClock: clock, minuteMetab, residentChannelMask: { m5: 1 },
    });
    resetSimMinuteCursor(sp.world);
    return sp;
  };
  const oldSp = make(false);
  const newSp = make(true);
  quiet(oldSp, { thinks: true });
  quiet(newSp, { thinks: true });
  await advance(oldSp, 50);
  await advance(newSp, 50);
  for (const id of ['a1', 'a2', 'a3']) {
    const a = oldSp.world.agents[id];
    const b = newSp.world.agents[id];
    assert.ok(a.bank.dumpM5, `${id} 必须启用 M5 bank`);
    assert.deepEqual(a.bank.dumpM5(), b.bank.dumpM5(), `${id} M5 快慢仓/队列/暴露应逐位相同`);
    assert.equal(a.rng.state(), b.rng.state(), `${id} M5 的 RNG 抽取次数/顺序应逐位相同`);
  }
});
