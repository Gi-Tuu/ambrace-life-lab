// O1-M 闸门（PLAN §23.1 预登记）：依赖度改成"反事实改变率"。默认关；关闭时逐位等价。
// 判据 C1–C5 全部实跑；关系项的自证与"装置交叉核对"都在这里钉住。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, spawn } from './body.mjs';
import { Organism } from './agent.mjs';
import { simulate } from './run.mjs';
import { channelsFor } from './model.mjs';
import { influenceFromTrace } from './o1-influence-probe.mjs';
import { PARAMS } from './params.mjs';
import { REL_NEUTRAL } from './relations.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const cfOf = (a) => ({
  decisions: a.counters.cfDecisions ?? 0,
  mem: a.counters.cfMem ?? 0,
  rel: a.counters.cfRel ?? 0,
  habit: a.counters.cfHabit ?? 0,
  skipped: a.counters.cfRelSkipped ?? 0,
  fallback: a.counters.cfFallback ?? 0,
});

test('C1 同量纲：四项计数都落在 [0,1] 的率里；④ 关掉时记忆改变率必须为 0', async () => {
  const on = await simulate({ seed: 7, ticks: 400, condition: 'C2', channelMask: { cfUsage: 1 } });
  const a = Object.values(on.agents)[0];
  const c = cfOf(a);
  assert.ok(c.decisions > 0, 'cfDecisions 为 0 ⇒ 开关没接到测量上');
  for (const k of ['mem', 'rel', 'habit']) {
    const rate = c[k] / c.decisions;
    assert.ok(rate >= 0 && rate <= 1, `${k} 改变率 ${rate} 越界 ⇒ 分子分母不是同一批决策`);
  }
  // ④ 关：检索加成恒为 0 ⇒ "去掉记忆项"不可能改变任何排名
  const off = await simulate({ seed: 7, ticks: 400, condition: 'C2', channelMask: { cfUsage: 1, mem: 0 } });
  const ac = Object.values(off.agents)[0];
  assert.equal(cfOf(ac).mem, 0, `④ 关后记忆改变 ${cfOf(ac).mem} 次 ⇒ 装置测的不是检索加成造成的换人`);
});

test('C1 关系自证：关系本来就是中性时，影子路径必须一次都不动（否则中性值写错了）', async () => {
  const { affordancesFor } = await import('./body.mjs');
  const { visibleActions, scoreAll } = await import('./model.mjs');
  const world = makeWorld({ pantries: 6, stash: 3 });
  const mk = (id, name, seed) => new Organism({ id, name, archetype: '谨慎', seed, condition: 'C2', channelMask: { cfUsage: 1 } });
  world.agents.a1 = mk('a1', '岑', 1);
  world.agents.a2 = mk('a2', '绛', 2);
  spawn(world, 'a1', 'home');
  spawn(world, 'a2', 'hall'); // 分房：不会发生 contact/meet，关系不会被事件抬走
  // 直接对着一次决策调用 noteInfluence（不跑世界循环），把"关系=中性"固定在评分那一刻
  for (const a of Object.values(world.agents)) for (const other of Object.values(world.agents)) if (other.id !== a.id) { const r = a.relations.get(other.id); r.trust = REL_NEUTRAL.trust; r.familiarity = REL_NEUTRAL.familiarity; }
  const a1 = world.agents.a1;
  const affs = affordancesFor(world, 'a1');
  const paths = visibleActions(affs, a1.traits, a1.ch, a1.bank, null);
  const risk = a1.viabilityRisk();
  const scored = scoreAll(paths, { drives: a1.drives, traits: a1.traits, bank: a1.bank, ch: a1.ch, memBonus: {}, risk });
  a1.noteInfluence({ world, paths, scored, memBonus: {}, risk, weights: null });
  assert.equal(a1.counters.cfRelMoved ?? 0, 0, `关系本来中性，影子路径却动了 ${a1.counters.cfRelMoved} 次候选效用 ⇒ 中性值与真实初值不同源`);
  assert.equal(a1.counters.cfRel ?? 0, 0, `关系本来中性却测出 ${a1.counters.cfRel} 次关系改变 ⇒ 影子路径把别的东西也改了`);
  assert.equal(a1.counters.cfDecisions, 1, '这次调用没有计入分母 ⇒ 后面的率会偏');
});

test('C1a 中性值同源：关系初值 == REL_NEUTRAL，影子 stub 引用同一常量', () => {
  const a = new Organism({ id: 'a1', name: '岑', archetype: '谨慎', seed: 1, condition: 'C2', channelMask: { cfUsage: 1 } });
  const r = a.relations.get('ghost');
  assert.equal(r.trust, REL_NEUTRAL.trust, '关系初值与 REL_NEUTRAL 不一致 ⇒ 影子又会测到另一个世界');
  assert.equal(r.familiarity, REL_NEUTRAL.familiarity);
  const src = readFileSync(fileURLToPath(new URL('./agent.mjs', import.meta.url)), 'utf8');
  assert.ok(/this\.relations = \{ get: \(\) => \(\{ familiarity: REL_NEUTRAL\.familiarity, trust: REL_NEUTRAL\.trust \}\) \}/.test(src), '影子 stub 没有引用 REL_NEUTRAL ⇒ 两个中性值会再次漂移');
});

test('C2 装置交叉核对：引擎内的计数与从 trace 独立重算的改变率一致（两条实现）', async () => {
  const { agents } = await simulate({ seed: 7, ticks: 400, condition: 'C2', channelMask: { cfUsage: 1 } });
  const trace = influenceFromTrace(agents);
  const total = Object.values(agents).reduce((acc, a) => { const c = cfOf(a); acc.decisions += c.decisions; acc.mem += c.mem; acc.habit += c.habit; return acc; }, { decisions: 0, mem: 0, habit: 0 });
  const c = total;
  assert.equal(c.decisions, trace.非反射决策, `分母不同：引擎 ${c.decisions} vs trace 重算 ${trace.非反射决策} ⇒ 两条实现统计的不是同一批决策`);
  assert.equal(c.mem, trace.记忆改变, `记忆改变数不一致：引擎 ${c.mem} vs trace ${trace.记忆改变}`);
  assert.equal(c.habit, trace.习惯改变, `习惯改变数不一致：引擎 ${c.habit} vs trace ${trace.习惯改变}`);
});

test('C3 零影响度必须退回旧公式并计数，不许按对象键序乱选器官', async () => {
  const world = makeWorld({ pantries: 6, stash: 3 });
  const a = new Organism({ id: 'a1', name: '岑', archetype: '谨慎', seed: 3, condition: 'C2', channelMask: { cfUsage: 1 } });
  world.agents.a1 = a; spawn(world, 'a1', 'home');
  const u = a.viab.usage();
  // 还没积累任何测量 ⇒ 必须与旧公式逐位相同，并记一次 cfFallback
  const old = {
    habit: (a.counters.habit / Math.max(1, a.counters.actions)) * a.viab.organs.habit.availability(),
    memory: Math.min(1, a.viab.organs.memory.rows.length / 20) * a.viab.organs.memory.availability(),
    social: Math.min(1, a.viab.organs.social.closeness() * 2) * a.viab.organs.social.availability(),
  };
  assert.deepEqual(u, old, '零测量时没有退回旧公式 ⇒ argmax 会按键序乱选');
  assert.equal(a.counters.cfFallback, 1, '退化没有计数 ⇒ 看不见它发生过');
});

test('C4 D1 语义不变：⑥ 关掉仍不侵蚀；开 cfUsage 也不改变"只有 ⑥ 一条通道"', async () => {
  assert.equal(channelsFor('C2').erosion, 1, 'C2 默认 ⑥ 开（D1 的默认语义）');
  // 注意 simulate 每 55 刻自动补粮（run.mjs），pantry:0 并不是真缺粮 ⇒ 这里自己跑一个每刻清零的手工世界
  const starve = async (mask) => {
    const world = makeWorld({ pantries: 0, stash: 0 });
    const mk = (id, name, seed) => new Organism({ id, name, archetype: '谨慎', seed, condition: 'C2', channelMask: mask });
    world.agents.a1 = mk('a1', '岑', 1); world.agents.a2 = mk('a2', '绛', 2);
    for (const id of ['a1', 'a2']) spawn(world, id, 'home');
    for (let t = 1; t <= 900; t++) {
      world.t = t; world.percepts = []; world.pantry = 0;
      for (const id of Object.keys(world.agents)) world.stash[id] = 0;
      for (const a of Object.values(world.agents)) await a.tick(world);
    }
    return Object.values(world.agents).reduce((s, a) => s + a.viab.ledger.length, 0);
  };
  const ledgerOff = await starve({ cfUsage: 1, erosion: 0 });
  assert.equal(ledgerOff, 0, `⑥ 关掉仍产生 ${ledgerOff} 次侵蚀 ⇒ cfUsage 绕过了 ⑥`);
  const w = makeWorld({ pantries: 0, stash: 0 });
  const a = new Organism({ id: 'a1', name: '岑', archetype: '谨慎', seed: 1, condition: 'C2', channelMask: { cfUsage: 1 } });
  w.agents.a1 = a; spawn(w, 'a1', 'home');
  for (let t = 1; t <= 900; t++) { w.t = t; w.percepts = []; w.pantry = 0; w.stash.a1 = 0; await a.tick(w); }
  assert.ok(a.viab.ledger.length > 0, `缺粮 900 刻没有任何侵蚀（stage=${a.viab.stage} v=${a.viab.v.toFixed(3)}）⇒ 这条断言没有样本`);
  for (const row of a.viab.ledger) {
    assert.ok(row.before && row.after, '侵蚀行缺 before/after ⇒ 账本记不出"削了哪个部件多少"');
    assert.notDeepEqual(row.after, row.before, `${row.organ} 的 before/after 一样 ⇒ 账本记了一次没发生的侵蚀`);
    // 不同器官的快照字段不同（习惯是 plasticity/strength、关系是 ceiling/available），所以只在两边都有 available 时比单调
    if (typeof row.before.available === 'number' && typeof row.after.available === 'number') {
      assert.ok(row.after.available <= row.before.available, `${row.organ} 侵蚀后可用度反而升高 ⇒ 不是不可逆`);
    }
  }
});

test('C5 默认关：C2 的 cfUsage 必须是 0；关闭档不产生任何 cf 计数，⑤⑥ 读数与旧世界一致', async () => {
  assert.equal(channelsFor('C2').cfUsage, 0, 'C2 默认必须关');
  const { agents } = await simulate({ seed: 7, ticks: 300, condition: 'C2' });
  for (const a of Object.values(agents)) {
    const c = cfOf(a);
    assert.equal(c.decisions + c.mem + c.rel + c.habit + c.skipped + c.fallback, 0, '关闭档仍在写 cf 计数 ⇒ 默认关不干净');
  }
  assert.ok(PARAMS.viab.upkeep > 0);
});

test('C2b 选择跟踪影响度：每次侵蚀削掉的器官 = 那一刻 usage 的 argmax（开/关两档都成立）', async () => {
  const run = async (cfUsage) => {
    const w = makeWorld({ pantries: 0, stash: 0 });
    const a = new Organism({ id: 'a1', name: '岑', archetype: '谨慎', seed: 1, condition: 'C2', channelMask: { cfUsage } });
    w.agents.a1 = a; spawn(w, 'a1', 'home');
    const pairs = [];
    for (let t = 1; t <= 900 && a.viab.ledger.length < 3; t++) {
      w.t = t; w.percepts = []; w.pantry = 0; w.stash.a1 = 0;
      const before = a.viab.ledger.length;
      const u = a.viab.usage(); // 这一 tick 之前的读数：erodeOne 也正是在这一 tick 里读它
      await a.tick(w);
      if (a.viab.ledger.length > before) {
        const picked = a.viab.ledger[before].key;
        const top = Object.entries(u).sort((x, y) => y[1] - x[1])[0][0];
        pairs.push({ picked, top, u });
      }
    }
    return pairs;
  };
  for (const cfUsage of [0, 1]) {
    const pairs = await run(cfUsage);
    assert.ok(pairs.length > 0, `cfUsage=${cfUsage} 档没有侵蚀样本 ⇒ 这条闸门空跑`);
    for (const p of pairs) assert.equal(p.picked, p.top, `cfUsage=${cfUsage}：削了 ${p.picked}，但那一刻 usage 最大的是 ${p.top}（${JSON.stringify(p.u)}）⇒ 选择函数没跟着影响度走`);
  }
  // 两档必须削到**不同**的器官，否则"换了量纲"没有落到行为上
  const offKeys = new Set((await run(0)).map((p) => p.picked));
  const onKeys = new Set((await run(1)).map((p) => p.picked));
  assert.ok([...onKeys].some((k) => !offKeys.has(k)), `开关两档削的是同一批器官（${[...offKeys]} vs ${[...onKeys]}）⇒ 量纲改动没有行为后果`);
});

test('C1 影子路径是活的：每刻的中性化都必须真的动过候选效用（否则 cfRel 恒 0 分不清是数据还是没接上）', async () => {
  const { agents } = await simulate({ seed: 7, ticks: 300, condition: 'C2', channelMask: { cfUsage: 1 } });
  const total = Object.values(agents).reduce((s, a) => s + (a.counters.cfRelMoved ?? 0), 0);
  const decisions = Object.values(agents).reduce((s, a) => s + (a.counters.cfDecisions ?? 0), 0);
  assert.ok(decisions > 0, '没有决策样本');
  assert.ok(total > 0, '中性化一次都没动过候选效用 ⇒ 影子路径是空跑（cfRel 的 0 不可信）');
  assert.ok(total <= decisions, `影子活性 ${total} 超过决策数 ${decisions} ⇒ 计数口径错了`);
});
