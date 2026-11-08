// O9-M 闸门（PLAN §23.2 预登记）：事件优先于习惯。默认关；反射层不动。
// 判据 E1/E2/E3/E5 全部实跑；E4（调用量倍数与线上见底时间）是披露项，数字随日志一起报，不设阈值。
import test from 'node:test';
import assert from 'node:assert/strict';
import { askAudit } from './o9-ask-audit.mjs';
import { simulate } from './run.mjs';
import { channelsFor } from './model.mjs';
import { Organism } from './agent.mjs';

let cached = null;
// 两臂**不能并行**：askAudit 会临时改写 Organism.prototype.triggerReason，并发时后一个包装会把前一个当"原始方法"，
// 收尾顺序错乱 ⇒ 触发表互相污染（第一版用 Promise.all，on 档的 ask 率被算成 63.6%）。
const audit = () => (cached ??= (async () => ({ off: await askAudit({ eventFirst: 0 }), on: await askAudit({ eventFirst: 1 }) }))());

test('E1 事件优先：三类非生存事件的 ask 率 ≥90%，习惯不再截流，关键事件仍按设计留给反射', async () => {
  const { on } = await audit();
  assert.ok(on.nonSurvivalAskRate >= 0.9, `非生存事件 ask 率 ${(on.nonSurvivalAskRate * 100).toFixed(1)}% < 90% ⇒ 事件仍被截流（预登记线）`);
  assert.equal(on.habitIntercepts, 0, `仍有 ${on.habitIntercepts} 次被习惯接管 ⇒ 开关没接在习惯分支上`);
  assert.equal(on.alarmAsked, 0, `关键事件被问了 ${on.alarmAsked} 次 ⇒ 反射让路了，这超授权（本轮只让习惯让路）`);
  assert.ok(on.alarmCount > 0, '样本里没有关键事件 ⇒ 这条断言是空跑');
});

test('E1 负控：关闭档必须回到"习惯截流"的老世界，否则开关本身没被检验到', async () => {
  const { off } = await audit();
  assert.ok(off.habitIntercepts > 0, `关闭档习惯截流为 0 ⇒ 这条负控没有样本，E1 的差异可能来自别处`);
  assert.ok(off.nonSurvivalAskRate < 0.9, `关闭档 ask 率 ${(off.nonSurvivalAskRate * 100).toFixed(1)}% 已 ≥90% ⇒ 开关前后没差别，E1 是无约束的`);
});

test('E2 默认关：掩码默认 0；同种子两跑逐位相同；开档轨迹必须不同（开关真的起作用）', async () => {
  assert.equal(channelsFor('C2').eventFirst, 0, 'C2 默认必须关（默认关等价的前提）');
  const digest = (agents) => Object.values(agents).map((a) => a.trace.map((r) => `${r.t}|${r.action ?? r.layer}|${r.ok ?? ''}|${r.kind ?? ''}`).join('#')).join('@');
  const a = await simulate({ seed: 7, ticks: 300, condition: 'C2' });
  const b = await simulate({ seed: 7, ticks: 300, condition: 'C2' });
  assert.equal(digest(a.agents), digest(b.agents), '同种子两跑不同 ⇒ 可复现性坏了');
  const on = await simulate({ seed: 7, ticks: 300, condition: 'C2', channelMask: { eventFirst: 1 } });
  assert.notEqual(digest(a.agents), digest(on.agents), '开档与关档轨迹一模一样 ⇒ 开关没有落到行为上（或根本没人读）');
});

test('E3 生存语义不被延迟：alarm 触发后同一刻到走廊，开档与关档的比例必须相同', async () => {
  const { off, on } = await audit();
  assert.ok(off.alarmCount > 0, '没有关键事件样本，E3 无从比较');
  assert.equal(on.alarmToHall / on.alarmCount, off.alarmToHall / off.alarmCount, '开档改变了 alarm→走廊的同刻比例 ⇒ 反射被延迟（硬停损，立即回退）');
  assert.equal(on.alarmToHall, on.alarmCount, `开档有 ${on.alarmCount - on.alarmToHall} 次 alarm 没在同刻到走廊 ⇒ 生存反应被拖慢`);
});

test('E5 不吞并：开档时被驳回仍必重问（askedRetry === rejected），且七/八/九通道读数不变', async () => {
  let asked = 0, retried = 0;
  const delib = async ({ trigger }) => { asked++; if (trigger === '驳回重决策') retried++; return null; };
  const { agents } = await simulate({ seed: 7, ticks: 400, condition: 'C2', channelMask: { eventFirst: 1 }, deliberator: delib });
  const rejected = Object.values(agents).reduce((s, a) => s + (a.counters.rejected ?? 0), 0);
  assert.equal(retried, rejected, `驳回 ${rejected} 次但有 ${retried} 次没重问 ⇒ 第五类触发被开关连坐`);
  assert.ok(asked > 0, '一次都没问 ⇒ 这条断言没有样本');
  const ch = channelsFor('C2', { eventFirst: 1 });
  for (const k of ['reflect', 'ask', 'gossip']) assert.equal(ch[k], 1, `开 eventFirst 顺手关了 ${k} ⇒ 越权`);
});
