// O9-M 闸门（PLAN §23.2 预登记）：事件优先于习惯。默认关；反射层不动。
// 判据 E1/E2/E3/E5 全部实跑；E4（调用量倍数与线上见底时间）是披露项，数字随日志一起报，不设阈值。
import test from 'node:test';
import assert from 'node:assert/strict';
import { askAudit } from './o9-ask-audit.mjs';
import { simulate } from './run.mjs';
import { channelsFor } from './model.mjs';
import { Organism } from './agent.mjs';
import { makeWorld, spawn } from './body.mjs';
import { makeRng } from './rng.mjs';

// F2（PLAN §26）：同种子臂。simulate 把 channelMask 哈希进每角色种子，直接比 mask 两档是种子混杂
// （§24.2 登记的 E2 恒真弱点）；这里两臂显式传相同 rng 流，只让开关不同。
async function sameSeedArm(seed, mask, ticks = 300) {
  const w = makeWorld({ pantries: 6, stash: 3 });
  const agents = {};
  [['a1', '岑', '谨慎'], ['a2', '绛', '冲动'], ['a3', '蓑', '孤僻']].forEach(([id, name, arch], i) => {
    const a = new Organism({ id, name, archetype: arch, seed, condition: 'C2', channelMask: mask, rng: makeRng(seed * 100 + i) });
    agents[id] = a; w.agents[id] = a; spawn(w, id, ['home', 'hall', 'watch'][i]);
  });
  for (let t = 1; t <= ticks; t++) {
    w.t = t; w.percepts = [];
    if (t % 55 === 0) w.pantry = Math.min(8, w.pantry + 2);
    for (const a of Object.values(agents)) await a.tick(w);
  }
  return Object.values(agents).map((a) => a.trace.map((r) => `${r.t}|${r.action ?? r.layer}|${r.ok ?? ''}|${r.kind ?? ''}`).join('#')).join('@');
}

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

test('E2 默认关：掩码默认 0；同种子两跑逐位相同；同种子臂开/关必须不同（开关真的起作用）', async () => {
  assert.equal(channelsFor('C2').eventFirst, 0, 'C2 默认必须关（默认关等价的前提）');
  const digest = (agents) => Object.values(agents).map((a) => a.trace.map((r) => `${r.t}|${r.action ?? r.layer}|${r.ok ?? ''}|${r.kind ?? ''}`).join('#')).join('@');
  const a = await simulate({ seed: 7, ticks: 300, condition: 'C2' });
  const b = await simulate({ seed: 7, ticks: 300, condition: 'C2' });
  assert.equal(digest(a.agents), digest(b.agents), '同种子两跑不同 ⇒ 可复现性坏了');
  // F2：同种子臂比较（旧版比 mask 两档，因 mask 进种子而恒真，no-op 开关也能绿）
  const off = await sameSeedArm(7, {});
  const on = await sameSeedArm(7, { eventFirst: 1 });
  assert.notEqual(off, on, '同种子臂开/关轨迹一模一样 ⇒ 开关没有落到行为上（或根本没人读）');
});

test('E3 生存语义不被延迟：alarm 触发后同一刻到走廊，开档不许比关档差', async () => {
  const { off, on } = await audit();
  assert.ok(off.alarmCount > 0, '没有关键事件样本，E3 无从比较');
  // 生存语义的硬要求：开档后**每一次** alarm 都必须在同一刻经反射走到走廊。
  assert.equal(on.alarmToHall, on.alarmCount, `开档有 ${on.alarmCount - on.alarmToHall} 次 alarm 没在同刻到走廊 ⇒ 生存反应被拖慢`);
  // 并且开档不许比关档更差。原先这里要求"两臂比例完全相等"——但关档那臂允许习惯截流掉个别 alarm，
  // 一旦轨迹重抽就会出现 53/54 vs 54/54 这种合法差异（实测），把"比例相等"当成判据会误报。
  const onRatio = on.alarmToHall / on.alarmCount;
  const offRatio = off.alarmToHall / off.alarmCount;
  assert.ok(onRatio >= offRatio, `开档比例 ${onRatio.toFixed(4)} 低于关档 ${offRatio.toFixed(4)} ⇒ 反射被延迟`);
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
