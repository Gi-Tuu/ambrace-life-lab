// 判据测试。每条都配负向对照——没有变红能力的闸门不算闸门。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulate, p1a, p1b, p2, p3, sweep, ablation, viabilityProfile, recoveryMechanics, recoveryProfile, metabolismAudit } from './run.mjs';
import { p2Intervention } from './s4-p2-intervention.mjs';
import { dist, kl, driverDist, mutualInfo, miNull, divergence, ruleCoverage, recoveryStats } from './metrics.mjs';
import { SelfMaintain } from './viability.mjs';
import { makeWorld, spawn, affordancesFor, BASE_KINDS, actuate } from './body.mjs';
import { scheduledLoc } from './clock.mjs';
import { visibleActions, scoreAll, preferenceBands, channelsFor, BANDS } from './model.mjs';
import { Organism } from './agent.mjs';
import { EpisodicMemory } from './memory.mjs';
import { evaluateTemporal } from './o18-metrics.mjs';
import { appraise } from './appraisal.mjs';
import { sampleTraits, DIMS } from './traits.mjs';
import { BASE_SETPOINT, NEED_META, Drives } from './drives.mjs';
import { PARAMS, assertFrozen, paramsFingerprint } from './params.mjs';
import { Relations } from './relations.mjs';
import { makeRng } from './rng.mjs';

const seqOf = (a) => a.trace.filter((r) => r.action).map((r) => `${r.action}:${r.m.arousal.toFixed(2)}`).join('|');
// 行为序列指纹（不含内部状态数值）：用于"同掩码下开关是否真的无差别"这类对照
const sigOf = (ag) => Object.values(ag).map((a) => a.trace.filter((r) => r.action).map((r) => r.action).join('|')).join('#');

test('可复现：同 seed 重跑，行为序列逐位一致', async () => {
  const a = (await simulate({ seed: 11, ticks: 200 })).agents.a1;
  const b = (await simulate({ seed: 11, ticks: 200 })).agents.a1;
  assert.equal(seqOf(a), seqOf(b));
});

test('L9 会变红：规则层至少真的驳回过，且驳回后重新决策', async () => {
  const { agents } = await simulate({ seed: 7, ticks: 400 });
  const total = Object.values(agents).reduce((s, a) => s + a.counters.rejected, 0);
  assert.ok(total > 0, `规则层从未驳回过（校验层是摆设）。rejected=${total}`);
  assert.ok(Object.values(agents).some((a) => a.trace.some((r) => r.layer === 'rejected')), '没有留下「驳回→重新决策」的痕迹');
});

test('通道④ 承重：状态必须改变检索分数，且能翻转一次排序', () => {
  const mem = new EpisodicMemory();
  const hot = { arousal: 0.9, approach: 0.9, inhibit: 0.1, quiescence: 0.1 };
  const cold = { arousal: 0.2, approach: 0.1, inhibit: 0.9, quiescence: 0.9 };
  mem.add(30, { kind: 'eat', actionKind: 'eat', actionSucceeded: true, payload: 'A', mSnapshot: hot, importance: 0.4 });
  mem.add(29, { kind: 'talk', actionKind: 'talk', actionSucceeded: true, payload: 'B', mSnapshot: cold, importance: 0.4 });
  const cands = [{ kind: 'eat' }, { kind: 'talk' }];
  const withState = mem.retrieve(cold, cands, 30, 2, { stateChannel: true });
  const noState = mem.retrieve(cold, cands, 30, 2, { stateChannel: false });
  assert.ok(Math.abs(withState[0].s.total - noState[0].s.total) > 0.1, '状态没改变检索分数 ⇒ 通道④ 是空的');
  assert.notEqual(withState.map((x) => x.r.kind).join(','), noState.map((x) => x.r.kind).join(','), '状态改变不了排序 ⇒ 通道④ 不承重');
});

// —— L5 认知评价：本轮新增。它必须是「目标×经历×人格」的函数，不是一张表 ——
const ev = (over = {}) => ({ kind: 'witnessed', valence: -0.7, selfCaused: false, about: null, violates: 'order', serves: 'safety', ...over });
const ctxFor = (archetype, rows = []) => {
  const rng = makeRng(5);
  const traits = sampleTraits(rng, archetype);
  const memory = new EpisodicMemory();
  rows.forEach((k, i) => memory.add(i + 1, { kind: k, payload: '', mSnapshot: { arousal: 0.5, approach: 0.5, inhibit: 0.5, quiescence: 0.5 }, importance: 0.5 }));
  const drives = new Drives(rng, traits);
  const relations = new Relations('x');
  return { traits, memory, drives, relations };
};

test('L5 人格参与：同一个事件，三个人格得到的注入向量必须不同', () => {
  const outs = ['谨慎', '冲动', '孤僻'].map((a) => {
    const traits = sampleTraits(makeRng(9), a);
    return appraise(ev(), { m: { ...traits.baseline }, traits, drives: new Drives(makeRng(9), traits), memory: new EpisodicMemory(), relations: new Relations('x'), t: 50 });
  });
  const sig = outs.map((o) => DIMS.map((d) => o.u[d].toFixed(3)).join('|'));
  assert.notEqual(sig[0], sig[1], '谨慎与冲动对同一越轨事件反应相同 ⇒ 人格没进评价');
  assert.notEqual(sig[0], sig[2], '谨慎与孤僻反应相同 ⇒ 人格没进评价');
  assert.ok(outs[0].targets.inhibit > outs[1].targets.inhibit, '秩序/规范更强的人格，越轨事件的目标自制应更高');
});

test('L5 经历参与：事件被重复预期后，意外性必须下降、唤起目标必须回落', () => {
  const traits = sampleTraits(makeRng(9), '谨慎');
  const fresh = appraise(ev(), { m: { ...traits.baseline }, traits, drives: new Drives(makeRng(9), traits), memory: new EpisodicMemory(), relations: new Relations('x'), t: 50 });
  const ctx = ctxFor('谨慎', ['witnessed', 'witnessed', 'witnessed', 'witnessed', 'witnessed', 'relocate']);
  const used = appraise(ev(), { m: { ...traits.baseline }, ...ctx, t: 50 });
  assert.ok(used.parts.unexpectedness < fresh.parts.unexpectedness, '重复发生的事仍算意外 ⇒ 经历没进评价层');
  assert.ok(used.targets.arousal < fresh.targets.arousal, `意外性下降但唤起目标没回落（${used.targets.arousal} vs ${fresh.targets.arousal}）⇒ 评价层还是张死表`);
});

test('关系层：同样一次对话，对熟人比对陌生人更解渴', async () => {
  const { world, agents } = await simulate({ seed: 21, ticks: 120 });
  const a = agents.a1;
  const floorGain = 0.26; // actuate 里给的下限
  a.world = world;
  a.relations.get('a2').familiarity = 0;
  a.drives.v.social = 0.2; // 从不饱和点起测，否则奖励被上限夹住，量不出差别
  const before = a.drives.v.social;
  a.execute(world, { kind: 'talk', target: 'a2' }, 'deliberation', world.t, true);
  const stranger = a.drives.v.social - before;
  a.relations.get('a2').familiarity = 1;
  a.drives.v.social = 0.2;
  const mid = a.drives.v.social;
  a.execute(world, { kind: 'talk', target: 'a2' }, 'deliberation', world.t, true);
  const familiar = a.drives.v.social - mid;
  assert.ok(familiar > stranger + 0.05, `熟人 ${familiar.toFixed(3)} 没明显超过陌生人 ${stranger.toFixed(3)} ⇒ 关系不承重`);
  assert.ok(Math.abs(stranger) > 0.001 || stranger >= floorGain - 0.2, '对话完全没有满足量');
  void before;
});

test('闭环：越轨的后果会自己找上门——被拿的人后来会发现缺口并改变内部状态', async () => {
  const { world, agents } = await simulate({ seed: 7, ticks: 400 });
  const anyNorm = Object.values(agents).some((a) => a.counters.normbreak > 0);
  const anyDiscovery = Object.values(agents).some((a) => a.trace.some((r) => r.layer === 'discovery'));
  assert.ok(anyNorm, '400 tick 里没人越轨 ⇒ 越轨通道没被走到，闭环无从谈起');
  assert.ok(anyDiscovery, '有人被拿了份额却没有发现 ⇒ 后果没有回流到内部状态');
  const disc = Object.values(agents).flatMap((a) => a.trace.filter((r) => r.layer === 'discovery'));
  const before = disc[0].m.arousal;
  assert.ok(Number.isFinite(before));
  assert.ok(world.stash[disc[0].id] <= world.expect[disc[0].id]);
});

test('P1a 通道通电：持续钳制调制维，行为分布必须变', async () => {
  const r = await p1a({ seed: 7, ticks: 320, condition: 'C2' });
  assert.ok(r.meanKl > 0.02, `按住 m 行为却几乎不动（meanKl=${r.meanKl}）⇒ 通道没载流`);
});

test('P1a 负向对照：C2-neg 按住 m 也不该改变行为', async () => {
  const r = await p1a({ seed: 7, ticks: 320, condition: 'C2-neg' });
  assert.ok(r.meanKl < 0.005, `C2-neg 也在变（${r.meanKl}）⇒ 有通道没切断`);
});

test('P1b 人格承重：不动 m、只改慢参数，同一事件序列必须分岔', async () => {
  const r = await p1b({ seed: 7, ticks: 320, condition: 'C2' });
  assert.ok(r.meanKl > 0.02, `改人格参数行为不变（meanKl=${r.meanKl}）⇒ 人格只是文案`);
});

test('P2 无触发自主性：环境完全静默仍有自发行为，且不是卡在同一种动作上', async () => {
  const r = await p2({ seed: 7, ticks: 400, condition: 'C2' });
  for (const [name, v] of Object.entries(r)) {
    assert.equal(v.外部事件, 0, `${name} 的静默设定被破坏`);
    assert.ok(v.动作数 > 0, `${name} 在没有任何输入时一动不动`);
    assert.ok(v.静默熵 > 0.8, `${name} 静默时只会重复同一种动作（熵 ${v.静默熵} bit）⇒ 那不是活，是卡住`);
    assert.ok(v.主动发起 > 0, `${name} 静默时没有任何主动发起的社交/越轨/瞭望行为`);
  }
  // 旧 MI 置换假设时间点独立，已由独立自相关负例证伪；旧读数保留在实验日志。
  // 需求是否进入行动比较由下方独立的受控干预及切断负控检验。
});

test('P2 受控需求干预：条件决策变化，切断需求贡献后不变', async () => {
  const { execFileSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const script = fileURLToPath(new URL('./s4-p2-intervention.mjs', import.meta.url));
  const report = JSON.parse(execFileSync(process.execPath, [script], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
  assert.equal(report.bySeed.length, 8);
  for (const row of report.bySeed) {
    assert.ok(row.n > 0 && row.eligible === row.n, `seed ${row.seed} 缺少可比较的真实快照`);
    assert.ok(row.meanTv > 0 && row.meanEnergyServiceDelta > 0, `seed ${row.seed} 需求未影响条件选择`);
    assert.equal(row.cutDisagree, 0, `seed ${row.seed} 切断需求后采样仍改变`);
    assert.ok(row.maxCutTv < 1e-12, `seed ${row.seed} 切断需求后概率仍改变`);
  }
  // 旧互信息随机标签负控作为诊断保留；它不能为有自相关的观察序列建立有效零分布。
  // 指标本体的对照：保住每个人的 m 序列，把动作换成与该人状态无关的随机标签 ⇒ 必须判「不耦合」。
  // 注意不能用「整体平移标签」当对照：三个人轮流行动，平移会把 A 的状态配上 B 的动作，
  // 反而造出系统性关联（实测 MI=0.18，比真信号还高）。
  const { agents } = await simulate({ seed: 7, ticks: 200, condition: 'C2', events: false });
  for (const a of Object.values(agents)) {
    const recs = a.trace.filter((r) => r.action);
    const kinds = [...new Set(recs.map((r) => r.kind))];
    const rng = makeRng(404);
    const fake = recs.map((r) => {
      const k = kinds[Math.floor(rng() * kinds.length)];
      return { ...r, kind: k, action: k };
    });
    assert.ok(mutualInfo(fake) <= miNull(fake), `${a.name} 的随机标签轨迹被判成耦合（MI=${mutualInfo(fake)} 门槛=${miNull(fake)}）⇒ 门槛算错了，绿灯不可信`);
  }
});

// O13：扫描表曾经打印旧的 MI 耦合人数（C2 与 C0 同为 0.8，读了会得出反结论）。
// 换成 P2 干预列之后，这条测试守的是"两处读数是同一笔账"：列取错字段、或两条入口跑出不同的数，都会在这里变红。
test('扫描表的 P2 列与干预脚本同源：同 seed 的 TV 逐位相同，切断列恒为 0', async () => {
  const s = await sweep({ seeds: [7], ticks: 400 });
  const iv = await p2Intervention({ seeds: [7], ticks: 400 }); // 分开 await：干预脚本改的是 Organism.prototype，两个跑注重叠会互相踩
  assert.equal(s.rows.length, 1, '扫描只自报了 1 档却跑出多档 ⇒ seeds 解析又坏了');
  assert.ok(iv.snapshots > 0, '干预脚本没取到快照，表里的 0 会是空读数而非效应');
  assert.equal(s.rows[0].P2干预TV, Number(iv.bySeed[0].meanTv.toFixed(4)), '扫描表与干预脚本的 P2 TV 不同源');
  assert.ok(s.rows[0].P2干预TV > 0, '扫描表里的 P2 干预 TV 为 0 ⇒ 需求没进条件决策');
  assert.equal(s.rows[0]['P2切断TV'], 0, '扫描表里的切断 TV 不为 0 ⇒ 负控漏了');
});

test('P3 不可脚本复现：C2 的 20 条规则覆盖率不应超过 C0', async () => {
  const c0 = await p3({ seed: 7, ticks: 400, condition: 'C0' });
  const c2 = await p3({ seed: 7, ticks: 400, condition: 'C2' });
  const avg = (o) => Object.values(o).reduce((s, v) => s + v.coverage, 0) / Object.keys(o).length;
  assert.ok(avg(c2) <= avg(c0) + 0.02, `C2(${avg(c2).toFixed(3)}) 比 C0(${avg(c0).toFixed(3)}) 更好复现 ⇒ 它没多出东西`);
});

// —— 倾向带（②的语言化）：给活模型用，必须粗粒度、状态敏感、可切断 ——
function scoredFor(agent, world, ch) {
  const affs = affordancesFor(world, agent.id);
  const paths = visibleActions(affs, agent.traits, ch, agent.bank);
  return scoreAll(paths, { drives: agent.drives, traits: agent.traits, bank: agent.bank, ch, memBonus: {} });
}
function fixture(pins) {
  const agent = new Organism({ id: 'a1', name: '岑', archetype: '谨慎', seed: 3, condition: 'C2' });
  const world = makeWorld({ pantries: 3, stash: 5 });
  world.agents.a1 = agent;
  world.agents.a2 = { id: 'a2', name: '绛' };
  world.agents.a3 = { id: 'a3', name: '蓑' };
  spawn(world, 'a1', 'home');
  spawn(world, 'a2', 'hall');
  spawn(world, 'a3', 'watch');
  agent.drives.v = { energy: 0.6, social: 0.5, stimulation: 0.5 };
  if (pins) Object.assign(agent.bank.m, pins);
  return { agent, world, ch: channelsFor('C2', null) };
}

test('倾向带是粗粒度：景观平时必须出现并列，不能退化成唯一第一名', () => {
  const { agent, world, ch } = fixture();
  const bands = preferenceBands(scoredFor(agent, world, ch), ch);
  const more = Object.values(bands).filter((b) => b === BANDS.more).length;
  assert.ok(Object.keys(bands).length >= 3, `候选太少 ${Object.keys(bands).length}`);
  assert.ok(more >= 2, `「更想做」只有 ${more} 个 ⇒ 这是伪装的 argmax，模型照样能抄`);
});

test('倾向带状态敏感：扫一遍自制水平，带向量必须出现不止一种形态', () => {
  // 只留②+band：①开着会把高冲动路径整个隐藏，两边候选集不同就比不出「换档」——这是 §25 说的通道耦合
  const ch = channelsFor('C2', { vis: 0, temp: 0, mem: 0 });
  const sigs = new Set();
  for (const inh of [0.05, 0.28, 0.5, 0.72, 0.95]) {
    const { agent, world } = fixture({ inhibit: inh, arousal: 0.5 });
    // 给真实一点的需求压力：误差全为 0 时景观被成本主导，任何耦合都跨不过档位边界
    agent.drives.v = { energy: 0.3, social: 0.18, stimulation: 0.5 };
    const bands = preferenceBands(scoredFor(agent, world, ch), ch);
    sigs.add(Object.keys(bands).sort().map((k) => `${k}:${bands[k]}`).join('|'));
  }
  assert.ok(sigs.size >= 2, `扫了 5 档自制，带向量始终一种形态 ⇒ ②的语言化没承载状态`);
});

test('倾向带可切断：band 关时全部同档，模型抄不到任何倾向信息', () => {
  const { agent, world } = fixture();
  const ch = channelsFor('C2', { band: 0 });
  const bands = preferenceBands(scoredFor(agent, world, ch), ch);
  const vals = new Set(Object.values(bands));
  assert.equal(vals.size, 1, `关掉 band 还出现 ${vals.size} 种档位`);
  assert.ok(vals.has(BANDS.none));
});

test('行动来源归因：主导项必须被记录，且关掉②后来源分布必须改变', async () => {
  const full = await simulate({ seed: 7, ticks: 300, condition: 'C2' });
  const recs = Object.values(full.agents).flatMap((a) => a.trace.filter((r) => r.action));
  const withDriver = recs.filter((r) => r.driver && r.driver !== 'none');
  assert.ok(withDriver.length / recs.length > 0.8, `只有 ${(withDriver.length / recs.length).toFixed(2)} 的动作带来源标签`);
  const off = await simulate({ seed: 7, ticks: 300, condition: 'C2', channelMask: { util: 0 } });
  const d1 = driverDist(Object.values(full.agents).flatMap((a) => a.trace));
  const d2 = driverDist(Object.values(off.agents).flatMap((a) => a.trace));
  assert.notEqual(JSON.stringify(d1), JSON.stringify(d2), '关掉②之后来源分布一模一样 ⇒ 归因没有区分力');
  assert.ok(!d2['调制'], '②已关却仍把「调制」记为主导来源');
});

test('消融矩阵跑通并给出实测数字（供人工核对，不做阈值断言）', async () => {
  const rows = await ablation({ seed: 7, ticks: 400 });
  assert.equal(rows.length, 4);
});

// —— L13 自我维持（M1 / D1 不可逆降级）。每条都要能变红，且都要有负向对照 ——
function viabFixture(over = {}) {
  const a = new Organism({ id: 'a1', name: '岑', archetype: '谨慎', seed: 3, condition: 'C2' });
  const world = makeWorld({ pantries: 3, stash: 5 });
  world.agents.a1 = a;
  world.agents.a2 = { id: 'a2', name: '绛' };
  spawn(world, 'a1', 'home');
  spawn(world, 'a2', 'hall');
  Object.assign(a.drives.v, { energy: 0.4, social: 0.3, stimulation: 0.5 }, over.drives ?? {});
  a.viab.v = over.v ?? 1;
  const affs = affordancesFor(world, 'a1');
  const ch = a.ch;
  const risk = ch.viab ? a.viab.risk : 0;
  return { a, world, affs, ch, risk, scored: scoreAll(affs, { drives: a.drives, traits: a.traits, bank: a.bank, ch, memBonus: {}, risk }) };
}

test('P4 规范性：存续跌破阈值必须永久削部件，且补进食不能还原', () => {
  const { a } = viabFixture({ v: 0.9 });
  const before = { mem: a.memory.kCap, ceil: a.relations.ceiling, plast: a.habit.plasticity };
  a.viab.v = 0.45; // 跌过第一档 0.5
  const fired = a.viab.check();
  assert.ok(fired, '存续跌破阈值却没有侵蚀记录 ⇒ D1 没实现');
  assert.equal(a.viab.ledger.length, 1, `跌过一档应记 1 笔，实测 ${a.viab.ledger.length}`);
  assert.ok(a.memory.kCap < before.mem || a.relations.ceiling < before.ceil || a.habit.plasticity < before.plast,
    '三个部件的读数一个都没降 ⇒ 受损的不是它自己的组织，那规范还是我写的一张表');
  // 大补一顿：存续拉满，但账本与部件都不许回来
  a.viab.v = 1;
  a.viab.regen(0.5);
  assert.equal(a.viab.ledger.length, 1, '恢复存续后账本被清空 ⇒ 可完全恢复，违反 D1');
  assert.ok(a.memory.kCap <= before.mem && a.relations.ceiling <= before.ceil && a.habit.plasticity <= before.plast,
    `补一顿饭就把受损部件修回去了（mem ${before.mem}→${a.memory.kCap}, ceil ${before.ceil}→${a.relations.ceiling}, plast ${before.plast}→${a.habit.plasticity}）`);
  a.viab.v = 0.45;
  a.viab.check();
  assert.equal(a.viab.ledger.length, 1, '同一档被重复侵蚀 ⇒ 掉档计数没起作用，损失次数会被虚报');
});

// —— O2 恢复动力学。规矩：先问"机制上能不能恢复、上限在哪里"，再问"世界里实际有没有"。
// 这几条都是纯账本（不含行为），跑满 600 刻只要几毫秒，所以可以把收支的每个分支都钉住。
function bareLedger(v = 0.2, reserve = 0, damage = false) {
  const organ = () => ({ rows: [], availability: () => 1, erode: (k) => ({ before: 1, after: k }), closeness: () => 1 });
  const s = new SelfMaintain({ organs: { habit: organ(), memory: organ(), social: organ() }, agent: { counters: { actions: 1, habit: 0 } }, damage, v });
  s.reserve = reserve;
  return s;
}
const runLedger = (s, { ticks = 600, every = 0, amount = 0.5, work = 0 } = {}) => {
  let crossed = null;
  for (let t = 1; t <= ticks; t++) {
    s.tick(1);
    if (work) s.spend(work);
    if (every && t % every === 0) s.regen(amount);
    if (crossed === null && s.v >= 0.6) crossed = t;
  }
  return crossed;
};

test('O2 储能救济：峰值必须等于解析上限，且"站上操作点→储能耗尽→再跌破"这个顺序成立', () => {
  const m = recoveryMechanics();
  const 救济 = m[0];
  assert.equal(救济.峰值v, 救济.储能上限, `峰值 ${救济.峰值v} 与解析上限 ${救济.储能上限} 不符 ⇒ tick() 的收支结构变了，§30 的校准推导要重做`);
  const up = 救济['首次站上操作点(t)'];
  const dry = 救济['储能耗尽(t)'];
  const back = 救济['站上后跌破(t)'];
  assert.ok(up !== null && dry !== null && back !== null, `储能救济没能站上操作点（${up}/${dry}/${back}）⇒ 恢复通道不存在`);
  assert.ok(up < dry && dry < back, `顺序不对（站上 ${up} → 耗尽 ${dry} → 跌破 ${back}）：耗尽之后才跌破才符合"储能放完就靠代谢往下走"`);
});

test('O2 储能是单向门：垮掉之后吃饭补不进储能，只有高位才攒得下', () => {
  const low = bareLedger(0.2);
  low.regen(0.5);
  assert.equal(Number(low.reserve.toFixed(6)), 0, 'v=0.2 吃一顿就攒下储能 ⇒ 储能从"富余的缓冲"变成了"垮后的救济"，O2 的结论要重写');
  assert.ok(low.v > 0.28 && low.v < 0.3, `低存续时一顿饭补了 ${low.v} ⇒ 直补量不再是 mealYield×amount`);
  const high = bareLedger(0.95);
  high.regen(0.5);
  assert.ok(high.reserve > 0, 'v=0.95 吃一顿储能仍为 0 ⇒ regen 的"先补满 v、补不下才进储能"结构变了');
});

test('O2 打平线：每 50 刻一顿 + 每刻一个普通动作 ⇒ 收支打平，停在原地而不是回升', () => {
  const s = bareLedger(0.2);
  const crossed = runLedger(s, { every: 50, work: 0.06 });
  assert.ok(Math.abs(s.v - 0.2) < 0.005, `打平档跑满 600 刻末存续 ${s.v.toFixed(4)}，偏离起始 0.2 超过 0.005 ⇒ mealYield/upkeep/costScale 的校准关系变了`);
  assert.equal(crossed, null, '打平档居然爬到了操作点 ⇒ 收入被高估，"打平＝不恢复"这条主张不成立');
});

test('O2 低于打平线：每 100 刻一顿 ⇒ 垮掉之后只会更低，不会自己回来', () => {
  const s = bareLedger(0.2);
  runLedger(s, { every: 100, work: 0.06 });
  assert.ok(s.v < 0.2 - 0.02, `低频进食后末存续 ${s.v.toFixed(4)} 没有往下走 ⇒ 收支式子算错了`);
});

test('O2 高于打平线才谈得上恢复：每 25 刻一顿必须爬回操作点以上', () => {
  const s = bareLedger(0.2);
  const crossed = runLedger(s, { every: 25, work: 0.06 });
  assert.ok(crossed !== null, '两倍于打平线的进食都爬不回操作点 ⇒ 这套账本压根没有恢复通道，观察侧的所有回升读数都得作废');
  assert.ok(crossed < 400, `爬回操作点用了 ${crossed} 刻，比"净升 0.0048/刻"推算的还慢 ⇒ 恢复速率的推导与实现不符`);
});

test('O2 恢复不退档：tick 驱动的回升不许把部件还回来', () => {
  const s = bareLedger(0.6, 0, true);
  s.stage = 2;
  s.ledger = [{ organ: '习惯可塑性' }, { organ: '记忆可用性' }];
  runLedger(s, { every: 25, work: 0.06 });
  assert.ok(s.v > 0.6, `这条没测到恢复（末 v ${s.v.toFixed(3)}）⇒ 断言的是空事件，绿灯不算数`);
  assert.equal(s.stage, 2, 'v 回升之后掉档计数退了 ⇒ D1 的不可逆被恢复通道破坏');
  assert.equal(s.ledger.length, 2, '回升时账本被清空 ⇒ 受损记录是可撤销的');
});

test('O2 恢复指标自身的对照：锯齿要报出回升，单调下降必须报 0 次', () => {
  const saw = [];
  for (let t = 1; t <= 200; t++) {
    // 守恒的锯齿：每 50 刻一顿（+0.09），其余每刻掉 0.0018 ⇒ 一个周期先涨 0.088 再跌回去
    const k = Math.floor((t - 1) / 50);
    saw.push({ t, v: Math.max(0, 0.2 + 0.09 * k - 0.0018 * (t - 1)), reserve: 0, ledger: t >= 100 ? 1 : 0, ate: (t - 1) % 50 === 0 });
  }
  const st = recoveryStats(saw, { crit: 0.6 });
  assert.equal(st.drops, 1, `人造序列里只有 1 次掉档，实测 ${st.drops} ⇒ 掉档计数不可信`);
  assert.ok(st.reboundTotal >= 3, `每 50 刻一顿的锯齿只报出 ${st.reboundTotal} 次回升 ⇒ 指标看不见进食脉冲`);
  assert.ok(st.reboundAfterDrop >= 1, '掉档之后的回升没被单独统计 ⇒ "垮后能不能稳"这一栏读的是总回升数，会虚报');
  assert.ok(st.maxReboundAfterDrop > 0.05 && st.maxReboundAfterDrop < 0.15, `回升幅度 ${st.maxReboundAfterDrop.toFixed(3)} 对不上"一顿饭 0.09" ⇒ 幅度算错了`);
  assert.equal(st.ateCoupledShare, 1, `回升与进食的耦合率 ${st.ateCoupledShare}，人造序列里每次回升都紧跟进食 ⇒ 窗口或标记写错了`);
  assert.ok(st.mealsPer100 > 1.9 && st.mealsPer100 < 2.1, `进食频率实测 ${st.mealsPer100.toFixed(2)} 顿/百刻，应约等于 2 ⇒ 分母用的不是时间跨度`);
  const fall = Array.from({ length: 200 }, (_, i) => ({ t: i + 1, v: Math.max(0, 0.9 - 0.004 * (i + 1)), reserve: 0, ledger: 0, ate: false }));
  const st2 = recoveryStats(fall, { crit: 0.6 });
  assert.equal(st2.reboundTotal, 0, '单调下降的序列被判出了回升 ⇒ 指标会自己造信号，观察侧所有读数不可信');
  assert.ok(st2.tailSlopePer100 < 0, `下降序列的末段斜率是 ${st2.tailSlopePer100.toFixed(4)} ⇒ 斜率符号反了`);
  assert.equal(st2.ateCoupledShare, null, '没有回升时耦合率不该是数字');
});

test('O2 观察侧接线：真实轨迹取得到存续序列，储能那一栏不是空读数', async () => {
  const { rows, verdict } = await recoveryProfile({ seeds: [7], ticks: 400 });
  assert.equal(rows.length, 9, `seed 7 × 3 配置应有 9 行，实测 ${rows.length} ⇒ trace 里的 viab 采样没接到`);
  assert.equal(verdict.样本, 9, '判定里的样本数与行数不一致 ⇒ 统计漏了人');
  assert.ok(rows.every((r) => r.末存续 >= 0 && r.末存续 <= 1), '末存续越界 ⇒ 序列取错了字段');
  // 这一条专门守新加的 reserve 字段：没接进 trace 的话，"储能时长占比"会恒为 0，看起来像个结论，其实是空断言
  assert.ok(rows.some((r) => r.储能时长占比 > 0), '400 刻里没有任何一个人攒到过储能 ⇒ viab.reserve 没进轨迹，储能那一栏是空读数');
  assert.ok(verdict.打平线每百刻顿数 > 1.5 && verdict.打平线每百刻顿数 < 2.5, `打平线算出 ${verdict.打平线每百刻顿数} 顿/百刻，与"每 50 刻一顿"不符`);
});

// —— D7 餐后扣存通道（spill）。预登记判据没过，所以默认是 0；下面这些闸门钉的是"它到底是什么"，
// 而不是"它好不好"：守恒、削峰不填谷、可切断、spill=0 逐位退化、参数漂移要能报。
function spillLedger(spill, v0 = 0.2) {
  const prev = PARAMS.viab.spill;
  PARAMS.viab.spill = spill;
  const s = bareLedger(v0);
  const e = [];
  for (let t = 1; t <= 600; t++) {
    s.tick(1);
    s.spend(0.06);
    if (t % 50 === 0) s.regen(0.5);
    e.push({ v: s.v, r: s.reserve });
  }
  PARAMS.viab.spill = prev;
  return e;
}

// —— O16 代谢实测（§40）。这组闸门守的是"收支式子和实现对不对得上"，不是数值好看。
// 两份断言读的是同一次审计：跑两遍要 18 个 1200 刻的仿真，而这两条主张本来就该互相一致
let metabCache = null;
const metab = () => (metabCache ??= metabolismAudit({ ticks: 1200 }));

test('O16 收支账本必须闭合：账面残差归零，否则式子与实现不一致', async () => {
  const { rows } = await metab();
  assert.equal(rows.length, 27, `3 seed × 3 供给应有 27 行，实测 ${rows.length}`);
  for (const r of rows) {
    assert.ok(Math.abs(r.账面残差) < 0.01, `${r.seed}/${r.配置}/${r.角色} 残差 ${r.账面残差} ⇒ 收支式子漏了项（这轮先后查出 mealMin 拒掉的小口、顶满丢弃、反射免付的代谢，都是靠这条暴露的）`);
    assert.ok(r.反射免付刻数 >= 0 && r.反射免付刻数 <= r.动作数, `免付刻数 ${r.反射免付刻数} 越界 ⇒ 账本老化计数与动作数对不上`);
    assert.ok(r.顶满丢弃 >= -1e-9 && r.归零少付 >= -1e-9, '实收超过名义收入或实付超过名义支出 ⇒ 流量记账反了');
  }
  assert.ok(rows.some((r) => r.反射免付刻数 > 0), '没有任何一刻被反射免付 ⇒ 这条补贴没被计量到，残差闸门是空的');
  assert.ok(rows.some((r) => r.顶满丢弃 > 0.01), '没有任何一口被"两个账户都满"丢掉 ⇒ 顶满丢弃这一栏没被计量到，残差闭合是靠不住的');
  assert.ok(rows.some((r) => r.小口被拒 > 0), '没有一次进食被 mealMin 拒掉 ⇒ 这道闸门没被检验到');
  // ⑤ 是不是"状态通道"，看的是它的开启时长会不会随状态变；长期饿着的个体恒开是正确读数，不是缺陷
  const on = rows.map((r) => r.风险开启时长占比);
  assert.ok(Math.max(...on) - Math.min(...on) >= 0.2, `⑤ 的开启时长跨样本只差 ${(Math.max(...on) - Math.min(...on)).toFixed(2)} ⇒ 它更接近常开偏置，不是状态通道`);
  assert.ok(on.some((x) => x > 0 && x < 1), '没有任何一个样本是"有时开有时关"的 ⇒ ⑤ 的作用域没被计量到');
});

test('O17/D8 稀缺仍在但越轨给活路：有人吃不够，也有人靠越轨吃够', async () => {
  const { rows } = await metab();
  const under = rows.filter((r) => r.实测顿每百刻 < r.打平需顿每百刻);
  const over = rows.filter((r) => r.实测顿每百刻 >= r.打平需顿每百刻);
  assert.ok(under.length > 0, '所有样本都吃够 ⇒ 稀缺被 O17 消掉了，世界不再稀缺');
  assert.ok(over.length > 0, '没有样本吃够打平线 ⇒ O17 没给出活路，主张退回旧的「谁都稳不住」');
  assert.ok(over.some((r) => r.越轨次数 > 0), '吃够的样本里没有一个靠越轨 ⇒ 活路不是 O17 给的，归因错误');
});

test('D7 扣存通道不造能量：同一份进食日程，总能量轨迹与 spill=0 逐位相符', () => {
  const a = spillLedger(0);
  const b = spillLedger(0.5);
  const maxDiff = Math.max(...a.map((x, i) => Math.abs(x.v + x.r - (b[i].v + b[i].r))));
  assert.ok(maxDiff < 1e-12, `总能量最大偏差 ${maxDiff.toExponential(2)} ⇒ 分配律里混进了能量，收支校准全部作废`);
  assert.ok(a.some((x, i) => Math.abs(x.v - b[i].v) > 0.001), '两条 v 轨迹居然几乎一样 ⇒ 通道没生效，守恒也就只是没跑起来');
});

test('D7 扣存只能削峰、不可能填谷：谷底对 spill 不变，峰头必须被压低', () => {
  const a = spillLedger(0).slice(200);
  const b = spillLedger(0.5).slice(200);
  const va = a.map((x) => x.v);
  const vb = b.map((x) => x.v);
  const troughA = Math.min(...va);
  const troughB = Math.min(...vb);
  assert.ok(troughB <= troughA + 1e-9, `稳态谷底被扣存抬高了（${troughA.toFixed(4)} → ${troughB.toFixed(4)}）⇒ 分配律改不动的总能量被改动了，D7 的结论要重写`);
  assert.ok(Math.max(...vb) < Math.max(...va) - 0.005, `峰头没被压低（${Math.max(...va).toFixed(4)} → ${Math.max(...vb).toFixed(4)}）⇒ spill 是个装饰参数`);
  assert.ok(troughB >= troughA - 1e-6, `谷底反而掉了 ${troughA.toFixed(4)}→${troughB.toFixed(4)}，超出浮点容差 ⇒ 扣存在周期内没放完，储能变成了漏损而不是延迟线`);
});

test('D7 spill=0 逐位退化成旧式子（等价性核对）', () => {
  const P = PARAMS.viab;
  const prev = P.spill;
  try {
    P.spill = 0;
    for (const [v0, r0, amount] of [[0.2, 0, 0.5], [0.95, 0.1, 0.5], [0.99, 0.59, 0.5], [0.5, 0.3, 0.25]]) {
      const s = bareLedger(v0, r0);
      const intake = P.mealYield * amount;
      const oldDirect = Math.min(Math.max(0, 1 - v0), intake);
      const oldReserve = Math.min(P.reserveMax, r0 + (intake - oldDirect));
      s.regen(amount);
      assert.equal(s.v, v0 + oldDirect, `v=${v0} 吃 ${amount}：直补量与旧式子不符`);
      assert.equal(s.reserve, oldReserve, `v=${v0} 吃 ${amount}：储能增量与旧式子不符`);
    }
  } finally {
    P.spill = prev; // 断言中途红了也不把 spill 留在 0 之外，否则后面所有测试跑的是另一个模型
  }
});

test('D7 通道是开关不是装饰：spill>0 必须真的改变这一顿的分配', () => {
  const prev = PARAMS.viab.spill;
  PARAMS.viab.spill = 0.5;
  const on = bareLedger(0.2);
  on.regen(0.5);
  PARAMS.viab.spill = 0;
  const off = bareLedger(0.2);
  off.regen(0.5);
  PARAMS.viab.spill = prev;
  assert.ok(off.reserve === 0 && on.reserve > 0.04, `低位吃一顿：扣存后储能 ${on.reserve.toFixed(4)}、不扣 ${off.reserve.toFixed(4)} ⇒ 通道没接上 regen`);
  assert.ok(on.v < off.v - 0.03, `当下补的量没少（${on.v.toFixed(4)} vs ${off.v.toFixed(4)}）⇒ 扣存是从别处变出来的`);
});

test('D7 扣存比例进冻结指纹：同组里一半人扣存一半人不扣，必须报参数漂移', () => {
  const prev = PARAMS.viab.spill;
  const label = 'D7指纹组';
  try {
    PARAMS.viab.spill = 0;
    assertFrozen(label, paramsFingerprint({})); // 先把 spill=0 登记进去，否则第二次调用只是首次登记，断言是空的
    PARAMS.viab.spill = 0.5;
    assert.throws(() => assertFrozen(label, paramsFingerprint({})), /参数漂移/, 'spill 改了却没被指纹抓到 ⇒ 代谢量纲可以偷偷漂移');
  } finally {
    PARAMS.viab.spill = prev;
    assertFrozen.seen.delete(label); // 别把这条组的账留给后面的测试
  }
});

test('⑤存续风险进比较：同一份状态，开与关的动作分数必须不同', () => {
  const low = viabFixture({ v: 0.1 });
  const withRisk = low.scored.map((s) => s.u).join(',');
  const without = scoreAll(low.affs, { drives: low.a.drives, traits: low.a.traits, bank: low.a.bank, ch: low.ch, memBonus: {}, risk: 0 }).map((s) => s.u).join(',');
  assert.notEqual(withRisk, without, '存续风险改了操作点与增益，分数却一模一样 ⇒ 它没进比较');
  // 关键的那条：处于"正常吃饱"（高于基线操作点 0.55、但低于风险抬高后的 0.80）的个体，
  // 存续风险也必须制造出亏空——否则 0 乘任何系数还是 0，闭环就成了开环。
  const full = viabFixture({ v: 0.1, drives: { energy: 0.7 } });
  const e = full.a.drives.errors(full.risk).find((x) => x.name === 'energy');
  const e0 = full.a.drives.errors(0).find((x) => x.name === 'energy');
  assert.ok(e.e > e0.e, `能量 0.70 时风险没有制造出额外亏空（${e.e} vs ${e0.e}）⇒ 存续发不出需求，闭环是开环`);
  assert.ok(e.setpoint > e0.setpoint, '操作点没移动 ⇒ 只放大了 0');
  // 边界也得钉住：风险抬高的是标准，不是把它变成无底洞。真吃饱（0.92 > 抬高后的 0.80）不该再产生亏空
  const sated = viabFixture({ v: 0.1, drives: { energy: 0.92 } });
  assert.equal(sated.a.drives.errors(sated.risk).find((x) => x.name === 'energy').e, 0, '真吃饱了还被逼着找吃的 ⇒ 操作点被抬过头了');
});

test('⑤/⑥ 各自可切断：负向对照必须干净', () => {
  const offRisk = new Organism({ id: 'a1', name: '岑', archetype: '谨慎', seed: 5, condition: 'C2', channelMask: { viab: 0 } });
  const offDamage = new Organism({ id: 'a1', name: '岑', archetype: '谨慎', seed: 5, condition: 'C2', channelMask: { erosion: 0 } });
  const on = new Organism({ id: 'a1', name: '岑', archetype: '谨慎', seed: 5, condition: 'C2' });
  for (const a of [on, offRisk, offDamage]) {
    a.viab.v = 0.1;
    a.viab.check();
  }
  assert.ok(on.viab.ledger.length > 0, '全开状态下没有侵蚀记录 ⇒ ⑥ 是摆设');
  assert.equal(offDamage.viab.ledger.length, 0, '⑥ 已关却仍然记了损失 ⇒ 开关不承重');
  assert.equal(offDamage.viab.stage, 0, '⑥ 已关却推进了掉档计数 ⇒ 反事实世界里偷偷受损');
  assert.equal(offRisk.viab.risk > 0, true, '⑤ 关的是"进不进比较"，不是"存续还演不演化"——风险量本身必须照旧存在');
  assert.notEqual(on.ch.viab, offRisk.ch.viab, '⑤ 开关没生效');
});

test('储能机制：吃饱时补不进的存续要能存下来，歇着不算进食', () => {
  const { a } = viabFixture({ v: 1 });
  a.viab.regen(0.05); // rest 的量（0.05 < mealMin 0.2）
  assert.equal(a.viab.reserve, 0, '躺着就攒下储能 ⇒ 稀缺是假的');
  a.viab.regen(0.5); // 一顿饭
  assert.ok(a.viab.reserve > 0, `存续已满时这顿饭应当存进储能，实测 reserve=${a.viab.reserve} ⇒ 上一版"回收全被 clamp 吞掉"的缺陷还在`);
  for (let i = 0; i < 40; i++) a.viab.regen(0.5);
  assert.ok(a.viab.reserve <= PARAMS.viab.reserveMax + 1e-9, `储能溢出上限 ${a.viab.reserve} > ${PARAMS.viab.reserveMax} ⇒ 没有封顶`);
});

// —— S2：L0 时钟、⑧ 事件门控、⑦ 反思回合 ——
test('时钟重构与旧的 t%24>=20 逐位等价（改名不许顺带换轨迹）', async () => {
  const { isNight, phaseOf, isSunset, DAY_TICKS } = await import('./clock.mjs');
  for (let t = 0; t < 2000; t++) assert.equal(isNight(t), t % 24 >= 20, `第 ${t} 刻的夜段判定与旧条件不一致 ⇒ 这次"只是改名"换了世界`);
  assert.equal(DAY_TICKS, 24, '昼夜周期被改动：所有已发表的长程读数都要重测，不该在这种改动里顺手发生');
  assert.ok(isSunset(20) && !isSunset(21) && !isSunset(19), '日落必须是进入夜的第一刻');
  assert.equal(phaseOf(0), '晨');
});

test('⑧ 事件门控：静默世界里模型几乎不被调用，替身路径不受影响', async () => {
  const calls = [];
  const d = async (ctx) => {
    calls.push(ctx.trigger);
    return null; // 返回 null 走退回替身分支，不影响动作分布
  };
  const { agents } = await simulate({ seed: 7, ticks: 400, condition: 'C2', events: false, deliberator: d });
  const decisions = Object.values(agents).reduce((s, a) => s + a.counters.actions, 0);
  const asked = Object.values(agents).reduce((s, a) => s + a.counters.asked, 0);
  const skipped = Object.values(agents).reduce((s, a) => s + a.counters.skipped, 0);
  assert.ok(asked > 0, '400 刻里一次都没被触发 ⇒ 门控把事件也挡住了');
  assert.ok(asked < decisions * 0.15, `被调用 ${asked} 次 / 决策 ${decisions} 次（${(asked / decisions).toFixed(2)}）⇒ 门控没起作用，还是每次审议都问`);
  assert.ok(skipped > asked, `跳过 ${skipped} 应多于调用 ${asked} ⇒ 大部分时刻本该由自主层自己决定`);
  assert.ok(calls.every((c) => typeof c === 'string' && c.length), '每次调用都必须带触发理由');
  // 成本账闭合：每一次调用都要能归到某类触发，且"驳回重决策"的调用数必须等于驳回数
  const triggered = Object.values(agents).reduce((s, a) => s + a.counters.triggered, 0);
  const retry = Object.values(agents).reduce((s, a) => s + (a.counters.askedRetry ?? 0), 0);
  const rejected = Object.values(agents).reduce((s, a) => s + a.counters.rejected, 0);
  assert.equal(retry, rejected, `重决策调用 ${retry} ≠ 驳回 ${rejected} ⇒ 第五类触发没进预算账，asked 与 triggered 的差额无法解释`);
  assert.ok(calls.every((c) => ['关键事件', '遭遇', '发现缺口', '日落', '驳回重决策'].includes(c)), '出现了未登记的触发理由 ⇒ 分类漏了');
  assert.ok(triggered > 0, '静默长跑里一个事件都没有 ⇒ 门控的触发源根本没被走到');
  // 关掉⑧：必须一次都不问。对照必须用**同一个掩码**——hashSeed 把掩码编进了种子（§31 的教训），
  // 拿"无掩码的裸跑"来比，测的其实是两条不同的随机流。
  const noAsk = await simulate({ seed: 7, ticks: 400, condition: 'C2', events: false, deliberator: d, channelMask: { ask: 0 } });
  assert.equal(Object.values(noAsk.agents).reduce((s, a) => s + a.counters.asked, 0), 0, '⑧ 已关却仍调用模型');
  const plainMasked = await simulate({ seed: 7, ticks: 400, condition: 'C2', events: false, channelMask: { ask: 0 } });
  assert.equal(sigOf(noAsk.agents), sigOf(plainMasked.agents), '同掩码下"插了被关掉的模型"与"完全不插模型"结果不同 ⇒ 门控之外还有东西在改轨迹');
});

test('触发分类：四类事件都要被认出来（纯函数层）', async () => {
  const { Organism } = await import('./agent.mjs');
  const a = new Organism({ id: 'a1', name: '岑', archetype: '谨慎', seed: 4, condition: 'C2' });
  assert.equal(a.triggerReason({ alarm: true }), '关键事件');
  assert.equal(a.triggerReason({ contact: true }), '遭遇');
  assert.equal(a.triggerReason({ discovery: true }), '发现缺口');
  assert.equal(a.triggerReason({ sunset: true }), '日落');
  assert.equal(a.triggerReason({}), null, '没有事件时也必须能问出东西 ⇒ 门控是假的');
  assert.equal(a.triggerReason({ alarm: true, contact: true }), '关键事件', '同时多件事时优先级必须确定，否则读数不可复现');
});

test('⑧ 端到端：遭遇与日落真能问出模型；关键事件与发现缺口被反射吞掉（如实记下）', async () => {
  const { Organism } = await import('./agent.mjs');
  const { makeWorld, spawn } = await import('./body.mjs');
  const build = async () => {
    const seen = [];
    const a = new Organism({ id: 'a1', name: '岑', archetype: '谨慎', seed: 4, condition: 'C2', deliberator: async (ctx) => (seen.push(ctx.trigger), null) });
    const world = makeWorld({ pantries: 4, stash: 5 });
    world.agents.a1 = a;
    world.agents.a2 = { id: 'a2', name: '绛' };
    spawn(world, 'a1', 'home');
    spawn(world, 'a2', 'hall');
    return { a, world, seen };
  };
  // 能问出模型的：遭遇、日落
  for (const [label, setup] of [
    ['遭遇', async (w) => { w.pending.push({ for: 'a1', evt: { kind: 'contact', valence: 0.5, about: 'a2', serves: 'social' } }); }],
    ['日落', async (w) => { w.t = 19; }], // 下一刻 t=20 正是进入夜的第一刻
  ]) {
    const { a, world, seen } = await build();
    await setup(world);
    world.t += 1;
    await a.tick(world);
    assert.ok(seen.includes(label), `${label} 没能触发模型调用（实际：${JSON.stringify(seen)}）`);
  }
  // 被反射吞掉的：关键事件、发现缺口。
  // 这不是 bug——DAC 的反应层本来就该先接管——但它意味着"只在四类事件时调 LLM"这句设计话
  // 目前只对两类成立。分开计数（triggered / asked）就是为了把这件事留在读数里而不是藏起来。
  for (const [label, setup] of [
    ['关键事件', async (w) => { w.percepts.push({ for: 'all', kind: 'alarm', subject: '墙外', salience: 0.9 }); }],
    ['发现缺口', async (w) => { w.stash.a1 = Math.max(0, w.stash.a1 - 2); }],
  ]) {
    const { a, world, seen } = await build();
    await setup(world);
    world.t += 1;
    await a.tick(world);
    assert.ok(a.counters.triggered > 0, `${label} 连"事件发生"都没被记下来 ⇒ 吞并变成了隐身`);
    if (a.counters.reflex > 0) {
      assert.equal(seen.length, 0, `${label} 走了反射分支却仍调用了模型`);
    } else {
      assert.ok(seen.includes(label), `${label} 既没走反射也没问模型 ⇒ 门控漏了`);
    }
  }
});

test('⑦ 反思回合：日落写一条自传体记忆，关掉就一条都没有', async () => {
  const on = await simulate({ seed: 7, ticks: 200, condition: 'C2', events: false });
  const off = await simulate({ seed: 7, ticks: 200, condition: 'C2', events: false, channelMask: { reflect: 0 } });
  const refl = (ag) => Object.values(ag).flatMap((a) => a.memory.rows.filter((r) => r.kind === 'reflect'));
  assert.ok(refl(on.agents).length >= 5, `跑了 200 刻（约 8 天）只反思出 ${refl(on.agents).length} 条 ⇒ 回合没挂上日落`);
  assert.equal(refl(off.agents).length, 0, '⑦ 已关却仍有反思记忆 ⇒ 开关不承重');
  assert.ok(refl(on.agents).every((r) => /天|决定/.test(r.payload)), `反思内容不像摘要：${JSON.stringify(refl(on.agents)[0])}`);
  // 上一天的自己必须能被下一天读到；⑦ 关掉后这行必须永远为空
  const a1 = Object.values(on.agents)[0];
  assert.ok(a1.daySummary(9999), '反思写过之后 daySummary 却读不出来 ⇒ 思考层那行是空的');
  const b1 = Object.values(off.agents)[0];
  assert.equal(b1.daySummary(9999), null, '⑦ 关着却能读到上一天的自己 ⇒ D5 之外的泄漏');
  // 反思只写记忆流，**不许动内部状态**：巩固对 m 的影响是 M6 的事，现在做就等于把两个里程碑混成一团。
  const { Organism } = await import('./agent.mjs');
  const { makeWorld, spawn } = await import('./body.mjs');
  const unit = new Organism({ id: 'a1', name: '岑', archetype: '谨慎', seed: 9, condition: 'C2' });
  const w2 = makeWorld({ pantries: 3, stash: 5 });
  w2.agents.a1 = unit;
  w2.agents.a2 = { id: 'a2', name: '绛' };
  spawn(w2, 'a1', 'home');
  spawn(w2, 'a2', 'hall');
  for (let i = 0; i < 12; i++) { w2.t += 1; await unit.tick(w2); }
  const mBefore = JSON.stringify(unit.bank.snapshot());
  const rowsBefore = unit.memory.rows.length;
  const wrote = unit.reflect(w2);
  assert.ok(wrote, 'reflect 在有一整天记录时却没写出任何东西');
  assert.equal(JSON.stringify(unit.bank.snapshot()), mBefore, '反思回合直接改了内部状态 ⇒ 越界到 M6（巩固）的地盘');
  assert.equal(unit.memory.rows.length, rowsBefore + 1, '反思没写进记忆流 ⇒ 它只是句空话');
  // 写进记忆流**必然**干扰检索（top-k 名额被自传体条目占掉），所以长程轨迹一定会分岔。
  // 这条不是 bug，是"摘要进记忆流"这句话的代价；断言它存在，防止后来人把"轨迹不同"当成巩固生效的证据。
  const on2 = await simulate({ seed: 7, ticks: 200, condition: 'C2', events: false });
  const off2 = await simulate({ seed: 7, ticks: 200, condition: 'C2', events: false, channelMask: { reflect: 0 } });
  assert.notEqual(sigOf(on2.agents), sigOf(off2.agents), '反思写了记忆却完全不改变检索结果 ⇒ 那条记忆是死的，P4 的"经验进自我模型"没落地');
});

// —— O12 喊住：玩家追不上角色时的最小介入 ——
test('喊住：被喊的人不换地方但仍照常决定，窗口过后恢复移动', async () => {
  const { hail, isHailed } = await import('./body.mjs');
  const world = makeWorld({ pantries: 4, stash: 5 });
  const a1 = new Organism({ id: 'a1', name: '岑', archetype: '谨慎', seed: 7, condition: 'C2' });
  const a2 = new Organism({ id: 'a2', name: '绛', archetype: '冲动', seed: 8, condition: 'C2' });
  world.agents.a1 = a1;
  world.agents.a2 = a2;
  spawn(world, 'a1', 'home');
  spawn(world, 'a2', 'hall');
  const r = hail(world, 'a1', 3);
  assert.ok(r.ok, '喊住被拒绝了');
  const start = world.loc.a1;
  const moves = { a2: 0 };
  for (let i = 0; i < 3; i++) {
    world.t += 1;
    await a1.tick(world);
    await a2.tick(world);
    if (world.loc.a2 !== 'hall') moves.a2 += 1;
    assert.equal(world.loc.a1, start, `第 ${i + 1} 刻被喊住的人还是换了地方`);
  }
  assert.ok(a1.trace.some((x) => x.action && x.t > 0), '被喊住的人连决定都不做了 ⇒ 那不是"站着别动"，是死机');
  assert.ok(moves.a2 > 0, '另一个人也没动过 ⇒ 这条测试分不清"喊住生效"和"大家都不动"');
  assert.equal(isHailed(world, 'a1'), false, '窗口过后仍在冻结状态');
});

test('喊住的窗口结束后能恢复移动', async () => {
  const { hail } = await import('./body.mjs');
  const world = makeWorld({ pantries: 4, stash: 5 });
  const a1 = new Organism({ id: 'a1', name: '岑', archetype: '冲动', seed: 3, condition: 'C2' });
  world.agents.a1 = a1;
  spawn(world, 'a1', 'home');
  hail(world, 'a1', 1);
  const seen = new Set([world.loc.a1]);
  for (let i = 0; i < 8; i++) {
    world.t += 1;
    await a1.tick(world);
    seen.add(world.loc.a1);
  }
  assert.ok(seen.size > 1, '喊住之后一直没再移动 ⇒ 冻结没解除');
});

// —— S1 / O2 受损速度：三条都要能变红 ——
const profile = await viabilityProfile({ seed: 7, ticks: 1200 });
const stageSum = (cfg) => profile.filter((r) => r.配置 === cfg).reduce((s, r) => s + r.掉档, 0);

test('受损速度随供给单调：越缺粮，累计不可逆损失越多', () => {
  const famine = stageSum('饥馑 · ⑤⑥全开');
  const normal = stageSum('常态 · ⑤⑥全开');
  const ample = stageSum('宽裕 · ⑤⑥全开');
  assert.ok(famine > ample, `饥馑 ${famine} 没超过宽裕 ${ample} ⇒ 存续不由取食决定，那 L13 是编的`);
  assert.ok(famine - ample >= 2, `饥馑 ${famine} 与宽裕 ${ample} 只差 ${famine - ample} 档 ⇒ 余量太薄，换个 seed 就会反号`);
  assert.ok(normal >= ample, `常态 ${normal} 比宽裕 ${ample} 还惨 ⇒ 供给与受损不单调，读数不能用`);
});

test('⑥ 自我侵蚀是结构性的：关掉后累计掉档必须恒为 0', () => {
  for (const cfg of ['饥馑 · ⑤⑥全关', '常态 · ⑤⑥全关']) {
    const rows = profile.filter((r) => r.配置 === cfg);
    assert.equal(rows.reduce((s, r) => s + r.掉档, 0), 0, `${cfg} 里仍有掉档 ⇒ ⑥ 没真的切断`);
    assert.ok(rows.every((r) => r.部件 === '—'), `${cfg} 的账本里出现了部件名 ⇒ 侵蚀照旧发生`);
  }
});

test('⑤ 的切断点与适用域：只在「亏空 × 低储备」的交集里起作用', async () => {
  const mk = async (mask, { energy, v }) => {
    const a = new Organism({ id: 'a1', name: '岑', archetype: '谨慎', seed: 12, condition: 'C2', channelMask: mask });
    const world = makeWorld({ pantries: 3, stash: 5 });
    world.agents.a1 = a;
    world.agents.a2 = { id: 'a2', name: '绛' };
    spawn(world, 'a1', 'home');
    spawn(world, 'a2', 'hall');
    a.viab.v = v;
    a.drives.v.energy = energy;
    return { a, world };
  };
  const scoreOf = (x, world) => scoreAll(affordancesFor(world, 'a1'), { drives: x.a.drives, traits: x.a.traits, bank: x.a.bank, ch: x.a.ch, memBonus: {}, risk: x.a.viabilityRisk() });

  // 亏空 + 低储备：⑤ 开必须让「存续风险」出现在分解里，⑤ 关必须一个都不出现
  const hurtOff = await mk({ viab: 0 }, { energy: 0.5, v: 0.05 });
  const hurtOn = await mk(null, { energy: 0.5, v: 0.05 });
  assert.ok(hurtOff.a.viab.risk > 0.9, `⑤ 关着时风险量都没演化（${hurtOff.a.viab.risk}）⇒ 演化与比较没分开，负向对照会假绿`);
  assert.equal(hurtOff.a.viabilityRisk(), 0, '⑤ 关着却把风险传进了决策');
  assert.ok(hurtOn.a.viabilityRisk() > 0.5, `⑤ 开着风险读数只有 ${hurtOn.a.viabilityRisk()} ⇒ 它没进比较`);
  assert.ok(scoreOf(hurtOn, hurtOn.world).some((s) => s.parts['存续风险'] !== undefined), '⑤ 开着、且个体又饿又重伤，候选分解里却找不到「存续风险」⇒ 它没进比较');
  assert.ok(scoreOf(hurtOff, hurtOff.world).every((s) => s.parts['存续风险'] === undefined), '⑤ 关着的分解里仍出现「存续风险」⇒ 归因会虚报');

  // 适用域（实测出来的限制，不是想当然）：能量已满时，操作点再怎么抬也造不出亏空 ⇒ ⑤ 必须完全沉默。
  // 这条断言的意义是防止后来人把 ⑤ 读成"随时都在起作用的状态通道"。
  const satedOn = await mk(null, { energy: 1, v: 0.05 });
  assert.ok(satedOn.a.viabilityRisk() > 0.5, '风险量本身应当仍然存在（演化不受开关影响）');
  assert.ok(scoreOf(satedOn, satedOn.world).every((s) => s.parts['存续风险'] === undefined), '能量已满时仍产生存续贡献 ⇒ ⑤ 越过了自己的适用域，会把"饱"读成"饿"');
});

// —— §28 量纲修正：努力折扣必须「进入比较但不支配比较」，且参数冻结闸门要能变红 ——
const withEffort = async (w, opts) => {
  const prev = PARAMS.effortWeight;
  PARAMS.effortWeight = w;
  try {
    const { agents } = await simulate({ seed: 7, ticks: 300, condition: 'C2', ...opts });
    const ids = Object.values(agents).flatMap((a) => a.trace.filter((r) => r.action).map((r) => r.action));
    return { agents, ids, d: driverDist(Object.values(agents).flatMap((a) => a.trace)) };
  } finally {
    PARAMS.effortWeight = prev;
  }
};
const NEED_KEYS = ['energy', 'social', 'stimulation'];
const needShare = (d) => NEED_KEYS.reduce((s, k) => s + (d[k] ?? 0), 0);

test('努力折扣进入比较：weight=0 与 weight=1 必须给出不同的行为分布与来源分布', async () => {
  const off = await withEffort(0);
  const on = await withEffort(1);
  assert.ok(kl(dist(on.ids), dist(off.ids)) > 0.02, '把成本整个拿掉行为却几乎不变 ⇒ 这个量只是常数偏移，改它不算改决策');
  assert.ok((off.d['努力折扣'] ?? 0) < 0.02, `折扣设为 0 仍有 ${(off.d['努力折扣'] ?? 0).toFixed(2)} 的动作由它主导 ⇒ 归因和参数没接上`);
  assert.ok((on.d['努力折扣'] ?? 0) > 0.5, `weight=1 时成本只主导 ${(on.d['努力折扣'] ?? 0).toFixed(2)} ⇒ 没复现出 §27 的支配态，改动不等价`);
});

test('量纲已纠正：默认档下需求/状态主导，成本不得反超', async () => {
  const d = (await withEffort(PARAMS.effortWeight)).d;
  assert.ok(needShare(d) > (d['努力折扣'] ?? 0), `需求主导 ${needShare(d).toFixed(3)} 没超过努力折扣 ${(d['努力折扣'] ?? 0).toFixed(3)} ⇒ 还是在选最省事的事`);
  assert.ok(needShare(d) > 0.5, `需求主导只有 ${needShare(d).toFixed(3)}，状态加调制也没接上 ⇒ 主导权去向不明`);
});

test('参数冻结闸门会变红：同组改量纲要报错，换自变量不该报错', async () => {
  assertFrozen.seen ??= new Map();
  assertFrozen.seen.delete('闸门测试');
  const fp = () => paramsFingerprint({ setpoint: BASE_SETPOINT, needs: NEED_META, kinds: BASE_KINDS, pantry: 6, stash: 3 });
  const prev = PARAMS.effortWeight;
  try {
    assert.doesNotThrow(() => assertFrozen('闸门测试', fp()), '首次登记就报错 ⇒ 闸门恒红');
    assert.doesNotThrow(() => assertFrozen('闸门测试', fp()), '同参数重复登记报错 ⇒ 指纹不稳定');
    // 合法的自变量差异（condition / channelMask）走 simulate，不该被算成漂移
    await simulate({ seed: 7, ticks: 40, condition: 'C2-neg', channelMask: { vis: 0 }, group: '闸门测试' });
    PARAMS.effortWeight = prev === 0.1 ? 0.9 : 0.1;
    assert.throws(() => assertFrozen('闸门测试', fp()), /参数漂移/, '单独改这一组的决策量纲没被抓到 ⇒ 闸门是摆设');
    PARAMS.effortWeight = prev;
    assert.throws(() => assertFrozen('闸门测试', paramsFingerprint({ setpoint: BASE_SETPOINT, needs: NEED_META, kinds: BASE_KINDS, pantry: 9, stash: 3 })), /参数漂移/, '世界供给变了没被抓到 ⇒ 配给差异能冒充人格差异');
  } finally {
    PARAMS.effortWeight = prev;
    assertFrozen.seen.delete('闸门测试');
  }
});

// —— S3：secret 对象、传话与⑨ 告知通道 ——
const flatTrace = (x) => Object.values(x.agents).flatMap((a) => a.trace);
const codesOf = (log) => log.reduce((s, r) => ((s[r.code] = (s[r.code] ?? 0) + 1), s), {});

test('⑨ 告知通道可切断：关掉后"传过话"必须与"没传话"逐动作相同', async () => {
  const told = await simulate({ seed: 7, ticks: 300, condition: 'C2', channelMask: { gossip: 0 }, gossipAt: [150] });
  const clean = await simulate({ seed: 7, ticks: 300, condition: 'C2', channelMask: { gossip: 0 } });
  assert.equal(sigOf(told.agents), sigOf(clean.agents), '⑨ 已关，告知却改变了行为 ⇒ 切断是嘴上说的');
  // 痕迹必须留下：登记与"没得讲"是认知事实，不该被行为开关抹掉
  assert.ok(flatTrace(told).some((r) => r.layer === 'informed'), '⑨ 关着时连"被告知过"的痕迹都没留下 ⇒ 消融读数无法解释');
  assert.ok(flatTrace(told).filter((r) => r.layer === 'informed').every((r) => r.dropped), 'informed 记录没标 dropped ⇒ 分不清是切断还是没发生');
});

test('通道开着时，告知必须真的改变选择（用序列分歧，不用 KL）', async () => {
  const base = await simulate({ seed: 7, ticks: 300, condition: 'C2' });
  const told = await simulate({ seed: 7, ticks: 300, condition: 'C2', gossipAt: [150] });
  assert.ok(told.world.gossipLog.filter((r) => r.ok).length >= 2, `实际告知少于 2 条（${JSON.stringify(codesOf(told.world.gossipLog))}）⇒ 这一跑没测到干预`);
  const div = divergence(flatTrace(base), flatTrace(told), 149);
  assert.ok(div.rate > 0.3, `干预后分歧率只有 ${div.rate} ⇒ 告知没进入决策链路`);
  // 这条同时记下"为什么不能用 KL 当效应量"：边际分布会重新重合，实测 KL 甚至随轮数下降
  assert.ok(div.ticks > 300, `参与比对的刻数只有 ${div.ticks} ⇒ 分歧率是拿极小样本算的`);
});

test('套利空间会耗尽：后面的轮次必须出现 NOTHING_TO_TELL', async () => {
  const r = await simulate({ seed: 7, ticks: 400, condition: 'C2', gossipAt: [100, 150, 200, 250, 300, 350] });
  const log = r.world.gossipLog;
  const first = codesOf(log.slice(0, 3));
  const later = codesOf(log.slice(3));
  assert.ok((later.NOTHING_TO_TELL ?? 0) > (first.NOTHING_TO_TELL ?? 0), `前几轮 NOTHING_TO_TELL ${first.NOTHING_TO_TELL ?? 0}，后面 ${later.NOTHING_TO_TELL ?? 0} ⇒ 没有耗尽迹象，"秘密有限"这条前提没被读数支持`);
  assert.ok(Object.keys(r.world.secrets).length > 0 && r.world.secrets.length <= 12, `秘密总数 ${r.world.secrets.length} 不合理`);
});

test('规则层四种驳回都要真的驳回（传话不是想说说就行）', async () => {
  const { makeWorld, spawn, addSecret } = await import('./body.mjs');
  const { canTell } = await import('./rules.mjs');
  const world = makeWorld({ pantries: 3, stash: 5 });
  world.agents.a1 = { id: 'a1', name: '岑' };
  world.agents.a2 = { id: 'a2', name: '绛' };
  world.agents.a3 = { id: 'a3', name: '蓑' };
  world.agents.p1 = { id: 'p1', name: '你', isPlayer: true };
  spawn(world, 'a1', 'home');
  spawn(world, 'a2', 'hall');
  spawn(world, 'a3', 'hall');
  spawn(world, 'p1', 'hall');
  const s = addSecret(world, { kind: 'theft', about: 'a1', holder: 'a3', valence: -0.6, violates: 'order', detail: '蓑拿了岑的' });
  assert.equal(canTell(world, 'p1', 'a2', 'nope').code, 'NO_SECRET');
  assert.equal(canTell(world, 'p1', 'a1', s.id).code, 'NOT_TOGETHER', '岑在居所，玩家在场就该驳回');
  // 幂等要经过"真的说过一次"才知道：canTell 只判合法性，登记 known 是 tell() 的事
  const { tell, pickSecret } = await import('./gossip.mjs');
  assert.equal(tell(world, 'p1', 'a2', s.id, { presence: false }).ok, true);
  assert.equal(canTell(world, 'p1', 'a2', s.id).code, 'REDUNDANT', '刚告诉过还能再告诉 ⇒ 幂等没守住');
  assert.equal(canTell(world, 'a2', 'a3', s.id).code, 'REDUNDANT', '蓑本来就是当事人（holder），他早该知道');
  // 二级传播：绛知道之后可以转述给还不知道的人；转述之后那条就不该再能被"首次告知"
  assert.equal(pickSecret(world, 'a3'), null, '蓑作为当事人还能被挑成"有待告知"的对象 ⇒ 候选集把已知的人算进来了');
  assert.equal(tell(world, 'a2', 'a1', s.id, { presence: false }).ok, true, '绛在居所告诉岑（同处一室）应当合法');
  // 局外人不能凭空传话：另造一个既不是当事人也不是知晓者的角色
  const { makeWorld: mw2, spawn: sp2 } = await import('./body.mjs');
  const w2 = mw2({ pantries: 3, stash: 5 });
  w2.agents.a1 = { id: 'a1', name: '岑' };
  w2.agents.a2 = { id: 'a2', name: '绛' };
  w2.agents.a4 = { id: 'a4', name: '丁' };
  sp2(w2, 'a1', 'home');
  sp2(w2, 'a2', 'home');
  sp2(w2, 'a4', 'home');
  const s2 = addSecret(w2, { kind: 'theft', about: 'a1', holder: 'a2', valence: -0.6, violates: 'order', detail: '绛拿了岑的' });
  assert.equal(canTell(w2, 'a4', 'a1', s2.id).code, 'IGNORANT', '丁根本不知道，却能把话传出去 ⇒ 信息可以凭空出现');
});

test('被告知是第六类事件：那一刻必须问到模型，且理由记为「被告知秘密」', async () => {
  const seen = [];
  const d = async (ctx) => (seen.push(ctx.trigger), null);
  const r = await simulate({ seed: 7, ticks: 260, condition: 'C2', events: false, deliberator: d, gossipAt: [200] });
  assert.ok(seen.includes('被告知秘密'), `告知那刻没问到模型（实际理由：${JSON.stringify([...new Set(seen)])}）`);
  const informed = flatTrace(r).filter((x) => x.layer === 'informed');
  assert.ok(informed.length >= 2, `只有 ${informed.length} 条告知记录`);
  assert.ok(informed.every((x) => typeof x.secret === 'string' && x.about), '告知记录必须写清是哪条秘密、关于谁');
});

test('告知扣的是当事人（作案者）的信任，不是受害者的', async () => {
  const { makeWorld, spawn, addSecret } = await import('./body.mjs');
  const world = makeWorld({ pantries: 3, stash: 5 });
  const a1 = new Organism({ id: 'a1', name: '岑', archetype: '谨慎', seed: 3, condition: 'C2' }); // 受害者
  const a2 = new Organism({ id: 'a2', name: '绛', archetype: '冲动', seed: 4, condition: 'C2' }); // 作案者
  world.agents.a1 = a1;
  world.agents.a2 = a2;
  spawn(world, 'a1', 'hall');
  spawn(world, 'a2', 'hall');
  const s = addSecret(world, { kind: 'theft', about: 'a1', holder: 'a2', valence: -0.6, violates: 'order', detail: '绛 从 岑 门口拿走一份' });
  const trustOf = (a, id) => a.relations.get(id).trust;
  const selfBefore = trustOf(a1, 'a1');
  const culpritBefore = trustOf(a1, 'a2');
  a1.receive(world, s, 'p1');
  assert.ok(trustOf(a1, 'a2') < culpritBefore, `被告知后对作案者的信任没降（${culpritBefore} → ${trustOf(a1, 'a2')}）⇒ 这条消息没打进评价`);
  assert.equal(trustOf(a1, 'a1'), selfBefore, `受害者的自我关系被改了（${selfBefore} → ${trustOf(a1, 'a1')}）⇒ about 指错了人，和上一版同一类错误`);
});
// 用户 2026-11-07 批准修订 D8：旧分层/样本内覆盖结论作为历史保留于 PLAN，
// 新闸门分别检验两档真实传话、时间留出与相同 mask 切断；不预设准确率变化方向。
test('D8 两档收益：传话有记录，事前特征可时间留出，切断后行为一致', async (t) => {
  const bin = v => v < .35 ? 'low' : v < .6 ? 'mid' : 'high';
  for (const riskyPortion of [.45, 1.1]) {
    const base = await simulate({ seed: 7, ticks: 400, condition: 'C2', riskyPortion });
    const told = await simulate({ seed: 7, ticks: 400, condition: 'C2', riskyPortion, gossipAt: [200] });
    const cutBase = await simulate({ seed: 7, ticks: 400, condition: 'C2', riskyPortion, channelMask: { gossip: 0 } });
    const cutTold = await simulate({ seed: 7, ticks: 400, condition: 'C2', riskyPortion, channelMask: { gossip: 0 }, gossipAt: [200] });
    assert.ok(told.world.gossipLog.filter(x => x.ok).length >= 2, `份量 ${riskyPortion} 未发生足够告知`);
    assert.equal(sigOf(cutBase.agents), sigOf(cutTold.agents), `份量 ${riskyPortion} 切断告知后仍改变行动`);
    for (const run of [base, told]) for (const agent of Object.values(run.agents)) {
      const rows = agent.trace.filter(r => r.action && r.t > 200).map(r => {
        assert.ok(r.tickStart && r.tickStart.t === r.t, `缺少 ${agent.id}/${r.t} 事前快照`);
        return { t: r.t, x: { energy: bin(r.tickStart.drives.energy), social: bin(r.tickStart.drives.social), loc: r.tickStart.loc }, y: r.action };
      });
      const r = evaluateTemporal(rows, { after: 200, split: 300, until: 400 });
      assert.ok(r.train.n > 0 && r.test.n > 0 && Number.isFinite(r.test.accuracy));
      t.diagnostic(`份量 ${riskyPortion} ${run === told ? '告知' : '基线'} ${agent.id} 留出准确率 ${r.test.accuracy.toFixed(3)}，多数类 ${r.baseline.accuracy.toFixed(3)}`);
    }
  }
});

test('O17 收益侧：越轨拿整份，份量高于正餐半碗', () => {
  const w = makeWorld({ pantries: 6, stash: 3 });
  spawn(w, 'a1', 'hall');
  spawn(w, 'a2', 'home');
  w.agents.a1 = { id: 'a1', name: '岑' };
  w.agents.a2 = { id: 'a2', name: '绛' };
  w.stash.a2 = 3;
  const r = actuate(w, 'a1', { kind: 'take_shared', target: 'a2' });
  assert.ok(r.ok, '越轨动作没执行成功 ⇒ 后面谈不上定价');
  assert.equal(r.amount, PARAMS.risky.portion, '份量没走冻结参数 ⇒ 拨回旧值的等价性闸门失效');
  assert.ok(r.amount > 0.5, `越轨份量 ${r.amount} 不高于正餐 0.5 ⇒ 收益侧没定价，没人会理性选它`);
});

test('O17 规范代价进比较：同种子下 order 高者越轨更少', async () => {
  const goals = (order) => ({ goals: { order, safety: 0.7, novelty: 0.6, social: 0.4 } });
  const hi = await simulate({ seed: 11, ticks: 600, traitsOverride: { a2: goals(0.95) } });
  const lo = await simulate({ seed: 11, ticks: 600, traitsOverride: { a2: goals(0.05) } });
  const nHi = hi.agents.a2.counters.normbreak;
  const nLo = lo.agents.a2.counters.normbreak;
  assert.ok(nLo > nHi, `order 0.05 越轨 ${nLo} 次应多于 order 0.95 的 ${nHi} 次 ⇒ 规范代价没进比较，O17 只是加了饭`);
});

test('O10 切断干净：权重为 0 时所有动作的日程标注恒为 0', async () => {
  const r = await simulate({ seed: 7, ticks: 60, scheduleWeight: 0 });
  const acts = affordancesFor(r.world, 'a1');
  assert.ok(acts.length > 0, '没有可用动作 ⇒ 这道闸门没被检验到');
  assert.ok(acts.every((x) => (x.schedBonus ?? 0) === 0), '权重 0 仍有非零标注 ⇒ 切断不干净，等价性核对会假绿');
});

test('O10 日程进比较：开权重后走动目的地更贴节律表，且行动序列真的改变', async () => {
  const on = await simulate({ seed: 7, ticks: 600, scheduleWeight: 0.06 });
  const off = await simulate({ seed: 7, ticks: 600, scheduleWeight: 0 });
  // 测行为而非单点快照：整段轨迹里 move_to 的目的地命中该刻节律表位置的比例（trace.action 是 "kind:对象" 字符串）
  const match = (x) => {
    let hit = 0, total = 0;
    for (const a of Object.values(x.agents)) {
      for (const r of a.trace) {
        if (r.kind !== 'move_to') continue;
        const s = scheduledLoc(a.traits.archetype, r.t);
        if (!s) continue;
        total++;
        if (String(r.action).split(':')[1] === s) hit++;
      }
    }
    return total ? hit / total : 0;
  };
  const seq = (x) => Object.values(x.agents).map((a) => a.trace.filter((r) => r.kind).map((r) => r.kind).join('')).join('|');
  assert.ok(match(on) > match(off), `开权重走动命中 ${(match(on) * 100).toFixed(0)}% 不高于关权重 ${(match(off) * 100).toFixed(0)}% ⇒ 节律没进比较，O10 只是画了张表`);
  assert.notEqual(seq(on), seq(off), '开关节律的行动序列逐位相同 ⇒ 日程是装饰，不进后果');
});
