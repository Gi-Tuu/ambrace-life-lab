import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Organism } from './agent.mjs';
import { makeWorld, spawn, move } from './body.mjs';
import { ForwardModel } from './s4-predictor.mjs';
import { DIMS } from './traits.mjs';

function fixture(mask = {}) {
  const world = makeWorld({}); world.t = 1;
  const agent = new Organism({ id: 'a1', name: '岑', archetype: '谨慎', seed: 17, channelMask: mask });
  world.agents.a1 = agent; spawn(world, 'a1', 'hall');
  return { agent, world };
}
const map = value => Object.fromEntries(DIMS.map(d => [d, value]));

test('模型、学习、精度开关分别切断真实 tick 路径', async () => {
  for (const [mask, expected] of [
    [{ forwardModel: 1, forwardLearn: 1, precision: 1 }, { predicted: 0.123, learns: 1, weighted: true }],
    [{ forwardModel: 0, forwardLearn: 1, precision: 1 }, { predicted: null, learns: 1, weighted: true }],
    [{ forwardModel: 1, forwardLearn: 0, precision: 1 }, { predicted: null, learns: 0, weighted: true }],
    [{ forwardModel: 1, forwardLearn: 1, precision: 0 }, { predicted: 0.123, learns: 1, weighted: false }],
  ]) {
    const { agent, world } = fixture(mask); let observed = null, calls = 0, weightArg;
    const originalStateBonus = agent.memory.stateBonus.bind(agent.memory);
    agent.forwardModel.predict = () => ({ mu: map(0.123), weights: map(0.25), probability: map(0.5) });
    agent.forwardModel.observe = (input, prediction) => { calls++; observed = { input, prediction }; };
    agent.memory.stateBonus = (m, candidates, t, opts) => { weightArg = opts.precision; return originalStateBonus(m, candidates, t, opts); };
    await agent.tick(world);
    assert.equal(calls, expected.learns);
    if (calls) assert.equal(observed.prediction.mu.arousal, expected.predicted ?? observed.input.m.arousal);
    assert.equal(Boolean(weightArg), expected.weighted);
    if (expected.weighted) assert.deepEqual(weightArg, map(0.25));
  }
});

test('反射提前接管时不产生模型训练样本', async () => {
  const { agent, world } = fixture();
  world.percepts.push({ for: 'a1', kind: 'alarm', subject: 'test' });
  move(world, 'a1', 'home');
  let count = 0; agent.forwardModel.observe = () => { count++; };
  await agent.tick(world);
  assert.equal(agent.counters.reflex, 1);
  assert.equal(count, 0);
});

test('实际行动写入 actionKind 并被候选相关性检索到，旧记忆兼容', () => {
  const { agent, world } = fixture();
  agent.world = world;
  const result = agent.execute(world, { kind: 'rest' }, 'deliberation', world.t, true);
  assert.equal(result.ok, true);
  const row = agent.memory.rows.at(-1);
  assert.equal(row.actionKind, 'rest');
  assert.equal(row.actionSucceeded, true);
  assert.equal(agent.memory.score(row, agent.bank.m, [{ kind: 'rest' }], world.t).relevance, 0.9);
  const old = { ...row, actionKind: undefined, kind: 'rest' };
  assert.equal(agent.memory.score(old, agent.bank.m, [{ kind: 'rest' }], world.t).relevance, 0.25);
});

test('宿主保存并恢复前向模型，旧存档缺字段可读取', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ambrace-s4-integration-'));
  process.env.DATA_DIR = dir;
  const { host } = await import('./host.mjs');
  try {
    await host.start(); host.stop();
    const agent = host.packs.A.agents.a1;
    const input = { m: agent.bank.snapshot(), pending: { ...agent.bank.pending }, traits: agent.traits };
    agent.forwardModel.observe(input, agent.forwardModel.predict(input), { ...input.m, arousal: Math.min(1, input.m.arousal + 0.1) });
    const expected = agent.forwardModel.dump();
    await host.save(); await host.start(); host.stop();
    assert.deepEqual(host.packs.A.agents.a1.forwardModel.dump(), expected);
    const path = join(dir, 'world.json');
    const old = JSON.parse(await readFile(path, 'utf8'));
    for (const pack of [old.A, old.B]) for (const agent of Object.values(pack.agents)) delete agent.forwardModel;
    await writeFile(path, JSON.stringify(old));
    await host.start(); host.stop();
    assert.deepEqual(host.packs.A.agents.a1.forwardModel.dump(), new ForwardModel().dump());
  } finally { host.stop(); await rm(dir, { recursive: true, force: true }); }
});

test('外部、旧来源及失败经历不会被误当成成功动作加分', async () => {
  const { EpisodicMemory } = await import('./memory.mjs');
  const mem = new EpisodicMemory(), m = map(0.5);
  mem.add(1, { kind: 'rest', payload: '外部事件', mSnapshot: m, importance: 1 });
  mem.add(2, { kind: 'thwarted', actionKind: 'rest', actionSucceeded: false, payload: '失败', mSnapshot: m, importance: 1 });
  const result = mem.stateBonus(m, [{ kind: 'rest' }, { kind: 'talk' }], 3, { stateChannel: true });
  assert.deepEqual(result.bonus, {});
  assert.equal(mem.retrieve(m, [{kind: 'rest'}], 3, 2).length, 2, '事件仍应可以检索');
});

// P5 使用真实静默世界快照；这些断言测机制通路，不把同轨迹的相关样本当独立统计样本。
test('P5：固定状态改变精度会改变可见性和记忆驱动的条件动作分布，切断后不变', async () => {
  const { execFileSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const script = fileURLToPath(new URL('./s4-p5.mjs', import.meta.url));
  const report = JSON.parse(execFileSync(process.execPath, [script], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
  assert.ok(report.visDrawChanges > 0, '精度不能通过可见性影响动作');
  assert.ok(report.memoryDrawChanges > 0, '精度不能通过记忆影响动作');
  assert.ok(report.naturalDrawChanges > 0, '自估精度在这些快照中没有行为影响');
  assert.equal(report.disabledDrawChanges, 0);
  assert.equal(report.offDrawChanges, 0);
});

test('P5：固定误差方差、只改变预测均值，校准评分对同一事件有响应', async () => {
  const { execFileSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const script = fileURLToPath(new URL('./s4-calibration-intervention.mjs', import.meta.url));
  const report = JSON.parse(execFileSync(process.execPath, [script], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
  assert.equal(report.results.length, 8);
  for (const r of report.results) {
    assert.ok(Math.abs(r.brierDifferenceVsBase.plus) > 1e-12 && Math.abs(r.brierDifferenceVsBase.minus) > 1e-12, `${r.dimension}/${r.window} 校准评分对均值干预不敏感`);
  }
});

test('P5：留出种子上固定均值切断逐通道精度，整体可靠性与 Brier 变差', async () => {
  const { execFileSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const script = fileURLToPath(new URL('./s4-precision-ablation.mjs', import.meta.url));
  const report = JSON.parse(execFileSync(process.execPath, [script], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, env: { ...process.env, S4_EVAL_HOLDOUT: '1' } }));
  for (const ticks of [400, 1200]) {
    const rows = report.results.filter(r => r.ticks === ticks), n = rows.reduce((sum, r) => sum + r.n, 0);
    assert.equal(rows.length, 4);
    const brier = arm => rows.reduce((sum, r) => sum + r.n * r.brier[arm], 0) / n;
    const ece = arm => rows.reduce((sum, r) => sum + r.reliability[arm].reduce((v, b) => v + (b.n ? b.n * Math.abs(b.p - b.y) : 0), 0), 0) / n;
    assert.ok(brier('pc') < brier('shared'), `${ticks} tick 逐维精度的整体 Brier 未优于共享方差`);
    assert.ok(ece('pc') < ece('shared'), `${ticks} tick 逐维精度的整体分箱误差未优于共享方差`);
  }
});
