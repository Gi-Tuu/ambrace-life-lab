// M3/M4 在演示里的入口（web 面板那两个开关走的就是这里）。
// 四条闸门各自盯一个"看起来成功了"的坑：
//   1) 默认关必须是真关——页面上不许出现这一层的读数占位
//   2) 开关只准加在 A 侧——B 是登记过的负向对照，把状态通道又接回去，对照就作废了
//   3) 切开关必须回到本次会话的起点重放，两侧刻数对齐——半路改规则的话，前后两段没法归给这一个变量
//   4) 开着要真的在运作、关掉后必须停止增长——否则开关只是页面上的装饰
// 外加一条最容易被忽略的：ctl 过去对未知动作照旧返回 status()，界面点了没反应也显示成功。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'ambrace-layers-'));
process.env.DATA_DIR = DIR;
process.env.SEED_FILE = join(DIR, 'no-seed.json'); // 不吃仓库里的演示种子：起点必须是零刻新建世界

const { host } = await import('./host.mjs');
const snap = () => host.snapshot();
const agentsOf = (p) => Object.values(p.agents);
const sumOf = (p, k) => agentsOf(p).reduce((s, a) => s + (a.counters?.[k] ?? 0), 0);

await host.start();
host.stop();
const ORIGIN = snap(); // startRaw 就是这一份：切开关应当回到这里，而不是回到"随机某个时刻"

test('默认关：两侧都不该有 M3/M4 的读数，未知动作必须报失败', async () => {
  assert.deepEqual(ORIGIN.masks, { m3: false, coupling: false }, 'masks 默认不是全关 ⇒ 页面上写的"默认关"是假的');
  for (const key of ['A', 'B']) {
    for (const a of agentsOf(ORIGIN[key])) {
      assert.equal(a.m3, null, `${key}/${a.id} 关闭时仍给了 M3 读数`);
      assert.equal(a.coupling, null, `${key}/${a.id} 关闭时仍给了 M4 读数`);
      assert.equal(a.counters.m3Decisions ?? 0, 0, `${key}/${a.id} 关闭时 M3 规划器仍在被调用`);
      assert.equal(a.counters.couplingApplied ?? 0, 0, `${key}/${a.id} 关闭时仍有耦合动作被执行`);
    }
  }
  const bogus = await host.ctl({ action: 'teleport' });
  assert.equal(bogus.ok, false, '未知动作被当成成功返回 ⇒ 界面会显示一个没发生的操作');
  assert.equal(bogus.error, 'UNKNOWN_ACTION');
  assert.equal((await host.ctl({ action: 'mask', key: 'nope', on: true })).error, 'UNKNOWN_MASK');
});

test('开关只加在 A 侧：B 的通道掩码必须保持 C2-neg 的定义', async () => {
  await host.ctl({ action: 'mask', key: 'm3', on: true });
  const s = snap();
  assert.deepEqual({ ...s.A.agents.a1.layers }, { m3: 1 }, 'A 侧没标出这一层开着');
  assert.ok(agentsOf(s.B).every((a) => !a.layers.m3), 'B 侧标出了 M3 ⇒ 负向对照组被叠了额外变量');
  assert.equal(host.packs.B.agents.a1.ch.m3, 0, 'B 的掩码被改动 ⇒ 负向对照组里多了一条状态进决策的通道');
  assert.equal(host.packs.A.agents.a1.ch.m3, 1);
  assert.equal(sumOf(s.B, 'm3Decisions'), 0, 'B 侧实际跑了 M3 规划');
  // 刚切上开关、一次决策都还没走：这一层"开着"但不该有承诺读数
  assert.ok(agentsOf(s.A).every((a) => a.m3 === null), '还没决策就给了承诺读数');
});

test('切开关把两个世界拉回同一起点重放，计数不能凭空多也不能凭空少', async () => {
  for (let i = 0; i < 20; i++) await host.tickOnce();
  const before = snap();
  assert.equal(before.A.t, ORIGIN.A.t + 20, '跑了 20 刻，A 的刻数不对');
  assert.equal(before.B.t, before.A.t, '还没开关两侧就已经分叉');
  await host.ctl({ action: 'mask', key: 'coupling', on: true });
  const after = snap();
  assert.equal(after.A.t, ORIGIN.A.t, `A 没回到本次会话起点（应 ${ORIGIN.A.t}，实 ${after.A.t}）`);
  assert.equal(after.B.t, ORIGIN.A.t, 'B 该和 A 一起回到起点，否则两侧比较的是不同长度的历史');
  assert.equal(after.A.agents.a1.counters.actions, ORIGIN.A.agents.a1.counters.actions, '重放改变了动作计数 ⇒ 起点不是同一颗种子');
  const log = after.A.log.at(-1);
  assert.match(String(log.text), /M3|M4/, '事件流里没有这次开关的记号');
  assert.equal(after.A.t, log.t, '开关事件没带时刻');
});

test('开着就真的运作；关掉后计数必须停止增长', async () => {
  for (let i = 0; i < 60; i++) await host.tickOnce();
  const on = snap();
  assert.ok(sumOf(on.A, 'm3Decisions') > 0, '开了 M3 跑 60 刻，规划器一次都没被调用 ⇒ 开关是装饰品');
  assert.ok(agentsOf(on.A).some((a) => a.m3.goal), '60 刻里一个目标都没选定过');
  assert.ok(agentsOf(on.A).some((a) => a.m3.remaining > 0), '目标一次都没被守住过 ⇒ 承诺期名不副实（这是机制侧的结论，不是界面的）');
  assert.ok(agentsOf(on.B).every((a) => !a.counters?.m3Decisions), 'B 侧被牵连');

  await host.ctl({ action: 'mask', key: 'm3', on: false });
  await host.ctl({ action: 'mask', key: 'coupling', on: false });
  const off = snap();
  assert.ok(agentsOf(off.A).every((a) => a.m3 === null && a.coupling === null), '关掉后还留着这一层的读数');
  const atToggle = sumOf(off.A, 'm3Decisions');
  for (let i = 0; i < 30; i++) await host.tickOnce();
  assert.equal(sumOf(snap().A, 'm3Decisions'), atToggle, '关掉之后计数还在涨 ⇒ 开关没真的切断');
});
