// V7.3.2 P1：正式游戏普通劳动只走共享时间/体力，不扣 viab；clock 累计/跨日重置；取消保留已用。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSurvPlay, survAct, tickSurvPlay, playerTimeLeft } from './survplay.mjs';
import { move } from './body.mjs';
import { clockOf } from './resident-time.mjs';
import { costFor } from './action-cost.mjs';
import { CURRENT_EVENT_RULES } from './rng.mjs';
import { isAlive } from './body.mjs';

const GAME = { eventRulesVersion: CURRENT_EVENT_RULES, independentWorld: true, gameRules: true,
  residentialDecisions: true, unifiedCooperation: true, settlementLife: true, autonomousGoals: true,
  farmLife: true, regionalWork: true, ecosystem: true, wildFood: true, playerRation: true };
const setup = () => {
  const sp = createSurvPlay(7, GAME), w = sp.world;
  w.t = 10; move(w, 'p1', 'yard'); move(w, 'a1', 'yard');
  w.agents.p1.drives.v.energy = 0.8; w.agents.a1.drives.v.energy = 0.8;
  w.survival.resStock.yard = 500;
  w.survival.sites = [{ type: 'shelter', loc: 'yard', progress: 0 }];
  w.survival.buildings = [{ type: 'shelter', loc: 'yard', integrity: 1 }];
  w.pinv.p1 = { wood: 5, stone: 5 }; w.pinv.a1 = { wood: 5, stone: 5 };
  w.survival.lastDay = Math.floor(w.t / 24);
  return { sp, w };
};

test('V732-P1 普通动作成对：玩家/居民 viab 不因劳动下降，体力按共享表扣', () => {
  for (const kind of ['gather', 'build']) {
    const P = setup(), R = setup();
    const pv = P.w.agents.p1.viab.v, rv = R.w.agents.a1.viab.v;
    const pe = P.w.agents.p1.drives.v.energy, re = R.w.agents.a1.drives.v.energy;
    const pr = survAct(P.sp, { kind });
    const rr = R.w.agents.a1.execute(R.w, { kind }, 'deliberation', R.w.t, true);
    assert.equal(pr.ok, true, `${kind} 玩家应成功`);
    assert.equal(rr.ok, true, `${kind} 居民应成功`);
    assert.equal(P.w.agents.p1.viab.v, pv, `${kind} 玩家 viab 不得因劳动下降`);
    assert.equal(R.w.agents.a1.viab.v, rv, `${kind} 居民 viab 不得因劳动下降`);
    assert.ok(Math.abs((pe - P.w.agents.p1.drives.v.energy) - costFor(kind).energy) < 1e-9);
    assert.ok(Math.abs((re - R.w.agents.a1.drives.v.energy) - costFor(kind).energy) < 1e-9);
  }
});

test('V732-P1 clock：本刻/当日累计正确，跨日重置，取消不退还已用', async () => {
  const { sp, w } = setup();
  assert.ok(survAct(sp, { kind: 'gather' }).ok);
  const c = clockOf(w, 'p1');
  assert.equal(c.tick.usedMin, 10);
  assert.equal(c.usedMin, 0, '玩家按 V7.3 设计只有本刻池，不记日账');
  await tickSurvPlay(sp); // 新刻
  assert.equal(c.tick.usedMin, 0, '新刻 tick 归零');
  // 居民：当日累计保留，跨日归零
  const { sp: rs, w: rw } = setup();
  rw.agents.a1.execute(rw, { kind: 'gather' }, 'deliberation', rw.t, true);
  assert.equal(clockOf(rw, 'a1').usedMin, 10);
  await tickSurvPlay(rs);
  assert.ok(clockOf(rw, 'a1').usedMin >= 10, '居民当日累计保留');
  rw.t = 24;
  assert.equal(clockOf(rw, 'a1').usedMin, 0, '居民跨日归零');
  // 取消保留已用
  const { sp: sp2, w: w2 } = setup();
  clockOf(w2, 'p1').tick = { t: w2.t, usedMin: 55, n: 0 };
  assert.equal(survAct(sp2, { kind: 'build' }).code, 'BUSY_START');
  const used = clockOf(w2, 'p1').tick.usedMin;
  assert.equal(survAct(sp2, { kind: 'busy_cancel' }).ok, true);
  assert.equal(clockOf(w2, 'p1').tick.usedMin, used, '取消不得退还已用分钟');
});

test('V732-P1 账本字段：玩家/居民 attempt/success/minutes/energy 同口径，sync 单列', () => {
  const { sp, w } = setup();
  assert.ok(survAct(sp, { kind: 'gather' }).ok);
  const p = w.survival.actionLedger.player;
  assert.equal(p.attempt.gather, 1);
  assert.equal(p.success.gather, 1);
  assert.ok(p.minutes.gather >= 10);
  assert.ok(Math.abs(p.energy.gather - 0.03) < 1e-9);
  const r = w.survival.actionLedger.resident;
  w.agents.a1.execute(w, { kind: 'gather' }, 'deliberation', w.t, true);
  assert.equal(r.attempt.gather, 1);
  assert.equal(r.success.gather, 1);
  assert.ok(r.minutes.gather >= 10);
  assert.ok(Math.abs(r.energy.gather - 0.03) < 1e-9);
  survAct(sp, { kind: 'player_sync', from: [w.survival.playerPos?.x ?? 20, w.survival.playerPos?.z ?? 34] });
  assert.equal(w.survival.actionLedger.player.sync, 1);
  assert.equal(w.survival.actionLedger.player.attempt.player_sync, undefined);
});



