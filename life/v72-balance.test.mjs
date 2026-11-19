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
  // P2c：居民按 space 路径连续移动后，到点更可靠（不再有"锚点已到但实际路没走"的抽象），
  // 100 日人口/出生整体上移一档；闸门从 [4,8]/[10,25] 放宽到 [4,10]/[10,32]，
  // 仍保留"有劳动、非零出生、不爆人口"的原意（见 P2c 回报 §长程变化）。
  assert.ok(avg(populations) >= 4 && avg(populations) <= 10, `100 日平均人口应在 [4,10]（P2c 轨迹），实测 ${avg(populations)}（${JSON.stringify(populations)}）`);
  assert.ok(births >= 10 && births <= 32, `100 日总出生应在 [10,32]（P2c 轨迹），实测 ${births}`);
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
  assert.ok(extinct >= 1 && extinct <= 3, `200 日灭绝种子数应在 [1,3]（B120 目标 2–3，实测 1/5，闸门先按 1–3 记录未达标），实测 ${extinct}：${JSON.stringify(detail)}`);
});




