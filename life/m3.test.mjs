// M3 行为状态的接入闸门。每条都能变红；负控必须真跑，不许空样本通过（预登记 2026-11-07）。
import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { simulate } from './run.mjs';
import { Organism } from './agent.mjs';
import { makeWorld, spawn, affordancesFor } from './body.mjs';
import { validate } from './rules.mjs';
import { PARAMS, assertFrozen, paramsFingerprint } from './params.mjs';
import { ShortHorizonPlanner } from './m3-planner.mjs';
import { digests } from './m3-baseline.mjs';

test('M3 闸门③：默认关闭时 seed 7/11 的 400/1200 刻行为指纹与 2026-11-09 装置更正后的基线逐位相同', async () => {
  // 2026-11-09 装置更正（BUG-1：驳回重选后必须再过一次 validate）：这条修复改变了默认决策路径，
  // 因此 e74af7d 那份指纹不再是当前引擎的基线。旧文件保留为历史读数，新基线由
  // `node life/m3-baseline.mjs > life/m3-baseline-20261109.json` 在本树上重新生成。
  // 本闸门的语义不变：它守的是"M3 这层默认关时不引入新行为"，而不是"引擎自 e74af7d 起没变过"。
  const base = JSON.parse(readFileSync(new URL('./m3-baseline-20261109.json', import.meta.url), 'utf8'));
  const now = await digests({ seeds: [7, 11], ticks: 400 });
  for (const k of Object.keys(base)) {
    assert.equal(now[k]?.n, base[k].n, `${k} 动作数变了 ⇒ 默认关也产生了新行为`);
    assert.equal(now[k]?.sha256, base[k].sha256, `${k} 行为指纹变了 ⇒ M3 默认关并不等价于旧引擎`);
  }
});

test('M3 闸门①：只改内部需求，功能目标与两条可行路径的相对分数都会变', () => {
  const snap = (energy) => ({ selfId: 'a1', loc: 'home', energy, social: 0.6, pantry: 3, energySetpoint: 0.55, socialSetpoint: 0.5, companions: {} });
  const mk = () => [{ id: 'rest', kind: 'rest', cost: 0.02 }, { id: 'eat', kind: 'eat', cost: 0.05 }, { id: 'move_to:hall', kind: 'move_to', to: 'hall', cost: 0.06 }];
  const rich = new ShortHorizonPlanner().step({ snapshot: snap(0.95), actions: mk(), catalog: mk() });
  const poor = new ShortHorizonPlanner().step({ snapshot: snap(0.05), actions: mk(), catalog: mk() });
  assert.equal(rich.goal, 'maintain', `能量满时目标是 ${rich.goal}，应为 maintain`);
  assert.equal(poor.goal, 'recover', `能量见底时目标是 ${poor.goal}，应为 recover ⇒ 内部需求没有改变状态选择`);
  const score = (r, id) => r.plans.find((p) => p.first.id === id && p.second === null)?.score;
  assert.ok(score(poor, 'eat') > score(rich, 'eat'), 'eat 的分数没有随能量缺口上升 ⇒ 需求没进比较');
  assert.ok(score(poor, 'rest') > score(rich, 'rest'), 'rest 的分数也没变 ⇒ 缺口差没被算进路径比较');
  assert.ok(score(poor, 'eat') > score(poor, 'rest'), '能量见底时 eat 没赢过 rest ⇒ 两条可行路径的相对分数没分开');
});

test('M3 闸门②：承诺 N 按非反射机会递减；默认关不产生 M3 决策；反射刻不带目标', async () => {
  const { agents } = await simulate({ seed: 7, ticks: 60, condition: 'C2', channelMask: { m3: 1 } });
  for (const a of Object.values(agents)) {
    const rows = a.trace.filter((r) => r.m3);
    assert.equal(rows.length, a.counters.m3Decisions, `${a.name} 的 M3 决策数与计数器不符`);
    assert.ok(rows.length > 0, '开启 M3 却一条决策都没有');
    assert.ok(a.trace.filter((r) => r.layer === 'reflex').every((r) => r.m3 === null), '反射刻带上了 M3 目标 ⇒ 承诺按 tick 计而不是按机会计');
    assert.equal(rows[0].m3.remaining, PARAMS.m3.commitment - 1, '第一次决策后 remaining 不是 N-1');
    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1].m3;
      const cur = rows[i].m3;
      if (cur.reused) assert.equal(cur.remaining, prev.remaining - 1, `第 ${i} 次复用后承诺没有恰好 −1`);
      else assert.equal(cur.remaining, PARAMS.m3.commitment - 1, `换目标后 remaining 不是 N-1（第 ${i} 条）`);
    }
  }
  const off = await simulate({ seed: 7, ticks: 60, condition: 'C2' });
  for (const a of Object.values(off.agents)) {
    assert.equal(a.counters.m3Decisions ?? 0, 0, '默认关却跑了规划器');
    assert.ok(a.trace.every((r) => r.m3 === null || r.m3 === undefined), '默认关的轨迹里出现了 M3 字段');
  }
});

test('M3 闸门②：承诺长度进冻结指纹，同组内改 N 必须报参数漂移', () => {
  assert.notEqual(paramsFingerprint({ m3: 4 }), paramsFingerprint({ m3: 1 }), 'N 不在指纹里 ⇒ 同组可以偷偷换承诺长度');
  const label = 'M3指纹组';
  try {
    assertFrozen(label, paramsFingerprint({ m3: 4 }));
    assert.throws(() => assertFrozen(label, paramsFingerprint({ m3: 1 })), /参数漂移/, '同组内改 N 没有被指纹抓到');
  } finally {
    assertFrozen.seen.delete(label);
  }
});

test('M3 闸门④：夜禁在规划器与规则层一致；即使调用方给错事实，规则层仍兜底', () => {
  const a = new Organism({ id: 'a1', name: '岑', archetype: '谨慎', seed: 3, condition: 'C2', channelMask: { m3: 1 } });
  const w = makeWorld({ pantries: 3, stash: 3 });
  w.agents.a1 = a;
  spawn(w, 'a1', 'home');
  w.t = 22;
  a.drives.v.energy = 0.05;
  const paths = affordancesFor(w, 'a1');
  const snap = a.m3Snapshot(w);
  assert.equal(snap.lookOutLegal, false, '夜里快照仍标记为合法');
  const r = a.m3Planner.step({ snapshot: snap, actions: paths, catalog: paths });
  assert.ok(!r.plans.some((p) => p.first.kind === 'look_out'), '夜里规划器仍排出瞭台');
  const v = validate(w, 'a1', { kind: 'look_out' });
  assert.equal(v.ok, false, '夜里瞭台居然合法 ⇒ 校验层失效');
  assert.equal(v.code, 'LOCKED_HOUR');
  // 负控：即使调用方把夜禁事实给错，规则层仍然驳回——M3 不是唯一的守门人
  const forced = a.m3Planner.step({ snapshot: { ...snap, lookOutLegal: true }, actions: paths, catalog: paths });
  assert.ok(forced.plans.some((p) => p.first.kind === 'look_out'), '强制放行后规划器应当给出瞭台，否则这个反例没成立');
  assert.equal(validate(w, 'a1', { kind: 'look_out' }).ok, false, '给错事实时规则层没有兜底');
});

test('M3 闸门④：驳回重决策在开启后仍可达（用打桩的规划器固定选 look_out）', async () => {
  const a = new Organism({ id: 'a1', name: '岑', archetype: '谨慎', seed: 3, condition: 'C2', channelMask: { m3: 1 } });
  const w = makeWorld({ pantries: 3, stash: 3 });
  w.agents.a1 = a;
  spawn(w, 'a1', 'home');
  w.t = 22;
  // 这里打桩的是规划器（它的正确性由自己的 23 条单测负责），目的是验"过滤之后仍然走 choose→validate→驳回"这条链
  a.m3Planner.step = () => ({ goal: 'explore', remaining: 3, reused: false, interrupted: null, plans: [{ goal: 'explore', first: { id: 'look_out', kind: 'look_out' }, second: null }], action: null });
  await a.tick(w); // tick 是 async：不 await 的话，断言读到的是决策之前的计数器（这个坑刚踩过一次）
  assert.equal(a.counters.rejected, 1, `被驳回次数 ${a.counters.rejected} ⇒ M3 把非法动作直接执行了`);
});

test('M3 闸门④：承诺状态可存档恢复，旧档缺字段时安全初始化', () => {
  const snap = { selfId: 'a1', loc: 'home', energy: 0.1, social: 0.2, pantry: 3, energySetpoint: 0.55, socialSetpoint: 0.5, companions: {} };
  const acts = [{ id: 'eat', kind: 'eat', cost: 0.05 }, { id: 'rest', kind: 'rest', cost: 0.02 }];
  const p = new ShortHorizonPlanner({ commitment: 4 });
  p.step({ snapshot: snap, actions: acts, catalog: acts });
  const dumped = p.dump();
  const q = new ShortHorizonPlanner({ commitment: 4 });
  q.load(dumped);
  assert.deepEqual(q.dump(), dumped, '存档往返后承诺状态变了');
  const old = new ShortHorizonPlanner({ commitment: 4 });
  old.load(undefined); // 旧档没有 m3 这一项
  assert.equal(old.remaining, 0);
  assert.equal(old.state, null);
  assert.doesNotThrow(() => old.step({ snapshot: snap, actions: acts, catalog: acts }), '旧档初始化后第一次决策就抛错');
});

test('M3 闸门④：告知注入在开启后照常改变对持有者的信任', async () => {
  const { world, agents } = await simulate({ seed: 7, ticks: 400, condition: 'C2', channelMask: { m3: 1 } });
  const a = agents.a2;
  const holder = 'a1';
  const secret = { id: 's-m3-test', kind: 'theft', about: holder, holder, known: new Set(['a2']), valence: -0.7, violates: 'order', t: world.t };
  const before = a.relations.map.get(holder)?.trust ?? 30;
  a.receive(world, secret, 'player');
  assert.ok(a.counters.informed > 0, '告知计数没有增加');
  const after = a.relations.map.get(holder)?.trust ?? 30;
  assert.notEqual(after, before, '开启 M3 后告知不再改变对持有者的信任 ⇒ 告知被吞掉了');
});

test('M3 在引擎里真的过滤候选：recover 目标下只留该目标的首步（含"为去吃而移动"）', () => {
  // 不能用"开启/关闭两次跑序列不同"来证明承重：hashSeed 把掩码编进了种子，那种对照测的是随机流（§31 已记）。
  // 也不能按 kind 白名单断言：recover 目标允许"先走到公仓再吃"，那正是两步规划的意义。
  const a = new Organism({ id: 'a1', name: '岑', archetype: '谨慎', seed: 3, condition: 'C2', channelMask: { m3: 1 } });
  const w = makeWorld({ pantries: 3, stash: 3 });
  w.agents.a1 = a;
  spawn(w, 'a1', 'home');
  a.drives.v.energy = 0.05;
  const paths = affordancesFor(w, 'a1');
  const out = a.m3Choose(w, paths);
  assert.equal(a.m3Last.goal, 'recover', `能量 0.05 时目标是 ${a.m3Last.goal}，应为 recover`);
  // plans 与承诺状态无关（先枚举再匹配承诺），所以用全新规划器重算同一份计划集来核对过滤结果
  const fresh = new ShortHorizonPlanner().step({ snapshot: a.m3Snapshot(w), actions: paths, catalog: paths });
  const keep = new Set(fresh.plans.filter((p) => p.goal === a.m3Last.goal).map((p) => p.first.id));
  assert.deepEqual(out.map((p) => p.id).sort(), paths.filter((p) => keep.has(p.id)).map((p) => p.id).sort(), '过滤结果与规划器给出的目标内首步不一致');
  assert.ok(out.length < paths.length, '候选集没有被过滤 ⇒ M3 只是读了一下规划器');
  assert.ok(out.some((p) => p.kind === 'eat'), 'recover 目标下没有 eat');
  assert.ok(!out.some((p) => p.kind === 'look_out'), 'recover 目标下还留着 look_out（explore 类）');
});

test('M3 承诺在需求被满足后仍然锁定：第二次决策复用同一目标', () => {
  const a = new Organism({ id: 'a1', name: '岑', archetype: '谨慎', seed: 3, condition: 'C2', channelMask: { m3: 1 } });
  const w = makeWorld({ pantries: 3, stash: 3 });
  w.agents.a1 = a;
  spawn(w, 'a1', 'home');
  const paths = affordancesFor(w, 'a1');
  a.drives.v.energy = 0.05;
  a.m3Choose(w, paths);
  const firstRemaining = a.m3Last.remaining;
  a.drives.v.energy = 0.95; // 需求已经满足，但承诺未到期
  a.m3Choose(w, paths);
  assert.equal(a.m3Last.goal, 'recover', '能量满了就立刻改目标 ⇒ 承诺没有兑现');
  assert.equal(a.m3Last.reused, true, '第二次决策没有复用承诺目标');
  assert.equal(a.m3Last.remaining, firstRemaining - 1, '承诺没有按机会递减');
});
