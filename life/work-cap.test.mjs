// §33 工坊当日上限的闸门（预登记 W0–W3）。两条红线：不设上限时行为必须逐位不变；额度必须在决策前就不可见。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeWorld, spawn, affordancesFor, workUsedToday, workCapLeft } from './body.mjs';
import { validate } from './rules.mjs';
import { Organism } from './agent.mjs';
import { hashSeed } from './rng.mjs';
import { weatherFor, dayOf, DAY_TICKS } from './clock.mjs';
import { socialRound } from './social.mjs';

const ROSTER = [
  { id: 'a1', name: '岑', archetype: '谨慎', loc: 'home' },
  { id: 'a2', name: '绛', archetype: '冲动', loc: 'hall' },
  { id: 'a3', name: '蓑', archetype: '孤僻', loc: 'watch' },
];

function build({ seed = 7, workCap }) {
  const world = makeWorld({ pantries: 3, preset: 'town', seed, socialGossip: 1 });
  if (workCap !== undefined) world.workCap = workCap;
  const agents = {};
  for (const r of ROSTER) {
    const a = new Organism({ ...r, seed: hashSeed(seed, `${r.id}:C2`), condition: 'C2', deliberator: async () => null });
    agents[r.id] = a; world.agents[r.id] = a; spawn(world, r.id, r.loc);
  }
  world.agents.p1 = { id: 'p1', name: '你', isPlayer: true }; spawn(world, 'p1', 'hall');
  return { world, agents };
}

async function drive({ seed = 7, ticks = 60, workCap }) {
  const { world, agents } = build({ seed, workCap });
  for (let t = 1; t <= ticks; t++) {
    world.t = t; world.percepts = [];
    world.weather = weatherFor(seed, dayOf(t));
    if (t % 97 === 0) world.percepts.push({ for: 'all', kind: 'alarm', subject: '墙外', salience: 0.9 });
    if (t % 55 === 0) world.pantry = Math.min(8, world.pantry + 2);
    for (const a of Object.values(agents)) await a.tick(world);
  }
  socialRound(world, { presence: false });
  const digest = Object.values(agents).map((a) => a.trace.map((r) => `${r.t}|${r.action ?? r.layer}|${r.ok ?? ''}|${r.kind ?? ''}`).join('#')).join('@');
  const works = Object.values(agents).reduce((s, a) => s + a.trace.filter((r) => r.kind === 'work' && r.ok).length, 0);
  const capped = Object.values(agents).reduce((s, a) => s + a.trace.filter((r) => r.code === 'DAY_CAP').length, 0);
  return { world, agents, digest, works, capped };
}

test('W0 负控：不设上限与"上限大到够不着"必须逐位相同（额度机制本身不许扰动轨迹）', async () => {
  const off = await drive({ ticks: 400 });
  const huge = await drive({ ticks: 400, workCap: 999999 });
  assert.equal(off.digest, huge.digest, '两者轨迹不同 ⇒ 上限的实现方式在没触及时就已经改行为');
  assert.ok(off.works > 0, '样本里一次工都没打成 ⇒ 这条负控是空跑');
  assert.equal(off.capped, 0, '未触及上限却出现 DAY_CAP 驳回');
});

test('W1 额度用尽：候选层不再给出 work，规则层留一条可追问的裁决', () => {
  const { world, agents } = build({ workCap: 1 });
  world.t = 5; world.weather = weatherFor(7, dayOf(5));
  const a = agents.a1;
  world.loc.a1 = 'workshop';
  (world.occupancy['home'] ??= []).splice(0); // 工坊里没人，排除 talk 干扰
  const before = affordancesFor(world, 'a1').filter((x) => x.kind === 'work');
  assert.equal(before.length, 1, '还没干过时工坊不该给出 work 才对');
  a.trace.length = 0;
  world.workLog = { a1: { day: dayOf(world.t), n: 1 } }; // 今天这一次已经用掉
  const after = affordancesFor(world, 'a1').filter((x) => x.kind === 'work');
  assert.equal(after.length, 0, '额度用尽后候选里仍有 work ⇒ 上限只在执行后拦，决策看不见（§33 W1 违反）');
  const v = validate(world, 'a1', { kind: 'work' });
  assert.equal(v.ok, false, '规则层放行了一个超额度的工');
  assert.equal(v.code, 'DAY_CAP');
  assert.match(v.why, /不收人/, '驳回原因要说得清是"今天不收人"，不是"这里没有工坊"');
});

test('W2 额度换天自动回满，且不靠任何外部时钟', async () => {
  const { world, agents } = build({ workCap: 1 });
  world.t = DAY_TICKS * 3 + 5; // 第 4 天
  world.workLog = { a1: { day: dayOf(world.t) - 1, n: 1 } }; // 昨天干满过
  world.loc.a1 = 'workshop';
  assert.equal(workCapLeft(world, 'a1'), 1, '换天后额度没回满');
  assert.equal(workUsedToday(world, 'a1'), 0);
  assert.equal(validate(world, 'a1', { kind: 'work' }).ok, true);
  void agents;
});

test('W2b 记账只认"真干成了"：被规则驳回的那一次不占额度', async () => {
  const { world, agents } = build({ workCap: 2 });
  world.t = 7; world.loc.a1 = 'store'; // 不在工坊，work 该被 NO_WORKSHOP 驳回
  const v = validate(world, 'a1', { kind: 'work' });
  assert.equal(v.code, 'NO_WORKSHOP');
  assert.equal(workUsedToday(world, 'a1'), 0, '没干成的活占了额度');
  void agents;
});

test('W3 载荷与存档：设了上限才出现 workCap/work，且当日已用工数随档走', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ambrace-workcap-'));
  const script = [
    'const { host } = await import("./life/host.mjs");',
    'await host.start(); host.stop();',
    'const s = host.snapshot();',
    'console.log(JSON.stringify({ workCap: s.A.workCap ?? null, a1: s.A.agents.a1.work ?? null, b1: s.B.agents.a1.work ?? null }));',
  ].join('\n');
  const withCap = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: { ...process.env, DATA_DIR: dir, SEED_FILE: join(dir, 'no-seed.json'), TICK_MS: '1000000', WORK_CAP: '2', BRAIN: 'local' },
  });
  assert.equal(withCap.status, 0, withCap.stderr);
  const on = JSON.parse(withCap.stdout.trim().split('\n').pop());
  assert.equal(on.workCap, 2, '设了 WORK_CAP 但 /world 里没有 workCap ⇒ 上限不是公开事实（§33 W3）');
  assert.ok(on.a1 && on.a1.cap === 2 && typeof on.a1.today === 'number', '角色行缺 今日已用工 读数');
  assert.ok(on.b1 && on.b1.cap === 2, '上限是世界事实，不该只加在 A 侧（B 侧是内部通道的负向对照，不是规则差异的对照）');

  delete process.env.WORK_CAP;
  const noCap = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: { ...process.env, DATA_DIR: dir, SEED_FILE: join(dir, 'no-seed.json'), TICK_MS: '1000000', BRAIN: 'local' },
  });
  assert.equal(noCap.status, 0, noCap.stderr);
  const off = JSON.parse(noCap.stdout.trim().split('\n').pop());
  assert.equal(off.workCap, null, '默认档（不设 WORK_CAP）的载荷里出现了 workCap ⇒ 默认路径被改动');
  assert.equal(off.a1, null, '默认档的角色行出现了 work 字段');
});
