// V7.2 生产配置闸门：V72_TIME=1 时正式游戏真的走个人时间模型。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { survivalOptions } from './host.mjs';
import { createSurvPlay, survAct } from './survplay.mjs';

test('V72 生产配置开启个人时间：同刻多动作、当天用尽 TIME_WAIT', () => {
  const old = process.env.V72_TIME;
  process.env.V72_TIME = '1';
  try {
    const opts = { ...survivalOptions(), gameRules: true, independentWorld: true };
    const sp = createSurvPlay(7, opts);
    const w = sp.world;
    assert.equal(w.survival.actTimeModel, true, '生产开关应落到世界');
    const results = [0, 1, 2, 3].map((i) => survAct(sp, { kind: 'move', room: i % 2 ? 'yard' : 'hall' }));
    assert.equal(results.filter((r) => r.ok).length, 4, JSON.stringify(results));
    w.survival.actClock.p1.usedMin = 1430;
    const r = survAct(sp, { kind: 'move', room: 'yard' });
    assert.equal(r.code, 'TIME_WAIT');
  } finally {
    if (old === undefined) delete process.env.V72_TIME;
    else process.env.V72_TIME = old;
  }
});
