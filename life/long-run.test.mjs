// P1-D 闸门：正式默认配置、无额外粮/无补生命、关闭 LLM 的 30/100/200 日实验。
import test from 'node:test';
import assert from 'node:assert/strict';
import { runLong, LONG_SEEDS, GAME_OPTIONS } from './long-run.mjs';

test('V3-13 五种种子 30 日：世界无异常推进，记录完整；初始粮为默认值（无额外补给）', async () => {
  for (const seed of LONG_SEEDS) {
    const r = await runLong(seed, 30);
    assert.equal(r.ticks, 720);
    assert.equal(r.final.t, 720);
    assert.equal(r.initial.store, 6, '初始公仓必须是默认值，不能额外补粮');
    assert.equal(r.final.agentErrors, 0, `seed ${seed} agentErrors=${r.final.agentErrors}`);
    assert.equal(r.daily.days, 30);
    assert.ok(r.final.population >= 0);
    assert.ok(Number.isFinite(r.final.viability.avg ?? 0));
    assert.ok(r.runtime.saveBytes > 0);
  }
});

test('V3-14 100 日代表样本与 200 日自然灭绝样本', async () => {
  const success = await runLong(7, 100);
  assert.equal(success.final.t, 2400);
  assert.equal(success.final.ended, false);
  assert.ok(success.final.population > 0);
  assert.ok(success.final.births > 0);
  assert.equal(success.final.agentErrors, 0);

  const boundary = await runLong(13, 100);
  assert.ok(boundary.final.population <= 2, `boundary pop=${boundary.final.population}`);

  const extinct = await runLong(13, 200);
  assert.equal(extinct.final.t, 4800);
  assert.equal(extinct.final.ended, true, '200 日 sample 应自然灭绝');
  assert.equal(extinct.final.population, 0);
  assert.ok(Object.keys(extinct.final.deathCauses).length > 0);
});
