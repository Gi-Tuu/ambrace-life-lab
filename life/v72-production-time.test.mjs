// V7.2 生产配置闸门：正式游戏默认走个人时间；V72_TIME=0 是退回旧预算的兼容开关。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { survivalOptions } from './host.mjs';
import { createSurvPlay, survAct } from './survplay.mjs';

const withV72 = (value, fn) => {
  const old = process.env.V72_TIME;
  if (value === undefined) delete process.env.V72_TIME;
  else process.env.V72_TIME = value;
  try { return fn(); } finally {
    if (old === undefined) delete process.env.V72_TIME;
    else process.env.V72_TIME = old;
  }
};

test('V72 生产配置默认开启个人时间：同刻多动作、当天用尽 TIME_WAIT', () => withV72(undefined, () => {
  assert.equal(survivalOptions().actTimeModel, true, '不设环境变量时生产配置应默认打开');
  // P1：生产默认已切连续时钟；这条闸门只钉 V7.2 每刻池的兼容路径，必须显式 simTime:false。
  const opts = { ...survivalOptions(), gameRules: true, independentWorld: true, simTime: false };
  const sp = createSurvPlay(7, opts);
  const w = sp.world;
  assert.equal(w.survival.actTimeModel, true, '生产开关应落到世界');
  const results = [0, 1, 2, 3].map((i) => survAct(sp, { kind: 'move', room: i % 2 ? 'yard' : 'hall' }));
  assert.equal(results.filter((r) => r.ok).length, 4, JSON.stringify(results));
  w.survival.actClock.p1.tick = { t: w.t, usedMin: 60, n: 0 }; // V7.3：本刻池用尽
  const r = survAct(sp, { kind: 'move', room: 'yard' });
  assert.equal(r.code, 'TIME_WAIT');
}));

test('V72 兼容开关 V72_TIME=0：正式游戏退回每刻 100 点预算', () => withV72('0', () => {
  assert.equal(survivalOptions().actTimeModel, false, 'V72_TIME=0 必须真的关掉个人时间');
  const opts = { ...survivalOptions(), gameRules: true, independentWorld: true, simTime: false };
  const sp = createSurvPlay(7, opts);
  const w = sp.world;
  assert.equal(w.survival.actTimeModel, undefined, '世界层不该带着个人时间开关');
  assert.ok(survAct(sp, { kind: 'move', room: 'yard' }).ok);
  assert.ok(survAct(sp, { kind: 'gather' }).ok);
  assert.equal(survAct(sp, { kind: 'gather' }).code, 'ACTION_BUDGET', '旧路径必须仍按每刻预算拒绝');
}));

