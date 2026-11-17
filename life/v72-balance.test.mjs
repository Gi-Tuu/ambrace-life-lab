// V7.2 §8-6 平衡闸门：正式游戏（gameRules:true）的长期结果必须落在有人看的上下界里。
// 目的不是"钉死某个种子"，而是：
//   1) 正式游戏里居民真的在劳动、真的会出生（不是静止世界）；
//   2) 死亡只能来自既有生存渠道（衰老/饥饿/衰竭），不许冒出新的死因；
//   3) 200 日仍然会自然灭绝（允许将来变温和，但必须仍能结束，且不靠硬造死亡）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { runLong, LONG_SEEDS } from './long-run.mjs';
import { FORMAL_OPTIONS } from './balance-probe.mjs';

const KNOWN_CAUSES = new Set(['衰老', '饥饿', '衰竭']);
const avg = (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

test('B1 正式游戏 100 日（5 种子）：有劳动、有出生、但明显不繁荣', async () => {
  const rows = [];
  for (const seed of LONG_SEEDS) rows.push(await runLong(seed, 100, { checkpoints: [100], options: FORMAL_OPTIONS }));
  const populations = rows.map((r) => r.final.population);
  const births = rows.reduce((s, r) => s + r.final.births, 0);
  const labor = rows.reduce((s, r) => s + (r.final.laborMinutes ?? 0), 0);
  const causes = new Set(rows.flatMap((r) => Object.keys(r.final.deathCauses ?? {})));
  assert.ok(avg(populations) >= 0 && avg(populations) <= 3, `100 日平均人口应在 [0,3]，实测 ${avg(populations)}（${JSON.stringify(populations)}）`);
  assert.ok(births >= 3 && births <= 16, `100 日总出生应在 [3,16]（B 决策：居民 90 天门槛后出生上限随之上移，不是放宽繁荣），实测 ${births}`);
  assert.ok(labor > 0, '正式游戏里居民应该真的在劳动（劳动分钟数 > 0）');
  assert.ok(rows.every((r) => (r.final.agentErrors ?? 0) === 0), '长跑不得出现 agentErrors');
  assert.ok([...causes].every((c) => KNOWN_CAUSES.has(c)), `出现未知死因：${[...causes].join(',')}`);
});

test('B2 正式游戏 200 日（5 种子）：仍会自然灭绝，不假装繁荣', async () => {
  let extinct = 0;
  const detail = [];
  for (const seed of LONG_SEEDS) {
    const r = await runLong(seed, 200, { checkpoints: [200], options: FORMAL_OPTIONS });
    if (r.final.ended) extinct += 1;
    detail.push([seed, r.final.population, r.final.ended]);
  }
  assert.ok(extinct >= 3 && extinct <= 5, `200 日灭绝种子数应在 [3,5]，实测 ${extinct}：${JSON.stringify(detail)}`);
});

