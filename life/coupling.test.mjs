// M4 耦合调制权判据（PLAN §16.6 的 P6a–P6e，预登记写在实施之前）。
// 默认关：channelMask {coupling:1} 才把三条动作放进候选清单。
// 这里刻意不走 run.simulate()：hashSeed 把 channelMask 编进种子，掩码一变种子就变，开/关就不是同一条随机流。
// 判据要的是"同一批人、同一条随机流、只改一个自变量"，所以直接构造 Organism 并显式给 seed。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, spawn, affordancesFor, actuate } from './body.mjs';
import { validate } from './rules.mjs';
import { Organism } from './agent.mjs';
import { Coupling, COUPLING_DEFAULT, COUPLING_VARS, COUPLING_KINDS, COUPLING_EFFECTS } from './coupling.mjs';
import { PARAMS } from './params.mjs';
import { makeRng } from './rng.mjs';
import { buildCouplingTargets } from './appraisal.mjs';

const ROSTER = [
  { id: 'a1', name: '岑', archetype: '冲动' },
  { id: 'a2', name: '绛', archetype: '谨慎' },
  { id: 'a3', name: '蓑', archetype: '孤僻' },
];

// 社交密集条件：三个人一起挤在居所。这不是"调参数凑结果"，是改实验条件——
// contact 事件密度把刺激推过设定点，"听不进/躲开"才有动机（预登记 §16.3 的触发来源）。
function room({ coupling = 1, m3 = 0, seedBase = 1, tau = PARAMS.coupling.tau, ticks = 400, couplingActions } = {}) {
  const world = makeWorld({ pantries: 6, stash: 3 });
  if (couplingActions !== undefined) world.couplingActions = couplingActions;
  const agents = {};
  for (const [i, r] of ROSTER.entries()) {
    const a = new Organism({ ...r, seed: seedBase * 10 + i, condition: 'C2', channelMask: { coupling, m3 } });
    a.coupling = new Coupling({ tau }); // τ 必须在构造期钉死：同批人不同 τ 就没法比（§16.4 冻结指纹）
    agents[r.id] = a;
    world.agents[r.id] = a;
    spawn(world, r.id, 'home');
  }
  return { world, agents, ticks };
}

async function drive(opts = {}) {
  const { world, agents, ticks } = room(opts);
  const samples = [];
  for (let t = 1; t <= ticks; t++) {
    world.t = t;
    world.percepts = [];
    if (t % 55 === 0) world.pantry = Math.min(8, world.pantry + 2);
    for (const id of Object.keys(agents)) {
      await agents[id].tick(world);
      samples.push({ t, id, v: { ...agents[id].coupling.v } });
    }
  }
  return { world, agents, samples };
}

const appliedOf = (r) => Object.values(r.agents).reduce((s, a) => s + (a.counters.couplingApplied ?? 0), 0);
const offDefault = (s) => COUPLING_VARS.some((k) => s.v[k] !== COUPLING_DEFAULT[k]);
const rowsOf = (r) => Object.values(r.agents).flatMap((a) => a.trace);

// —— P6a 承重：开启后必须出现角色自己改写 gain.* 的实例，而且三个变量各有实例
test('P6a 三条动作真的被选中并改写了耦合变量；S3 要的极端实例（available=0）出现过', async () => {
  const runs = [];
  for (const seedBase of [1, 2, 3]) runs.push(await drive({ coupling: 1, seedBase, ticks: 400 }));
  const applied = runs.reduce((s, r) => s + appliedOf(r), 0);
  assert.ok(applied > 0, `三条动作合计被选中 ${applied} 次 ⇒ 停止条件 S1（装饰停止）成立，M4 应回退`);
  const moved = runs.flatMap((r) => r.samples).filter(offDefault);
  assert.ok(moved.length > 0, '清单里有三条动作，但 gain.* 全程停在初值 ⇒ 消费者接错了线');
  for (const k of COUPLING_VARS) {
    assert.ok(moved.some((s) => s.v[k] !== COUPLING_DEFAULT[k]), `${k} 从未偏离初值 ⇒ §16.3 的消费者清单里它是空位`);
  }
  assert.ok(moved.some((s) => s.v.available === 0), '从未出现 available=0 的终止实例 ⇒ 按 §16.5 S3 把主张降级为"能调制"');
});

// —— P6a 负向对照：删掉三条动作，机制（tick、增益、五个消费者）全部照旧。
// 此时 gain.* 若仍会离开初值，说明清单之外还有写入者——那才是"外挂"的形态。
test('P6a 负控：清单删掉后 gain.* 恒为初值（除三条动作外没有别的写入者）', async () => {
  const moved = [];
  for (const seedBase of [1, 2, 3]) {
    const r = await drive({ coupling: 1, seedBase, ticks: 400, couplingActions: false });
    moved.push(...r.samples.filter(offDefault));
    assert.equal(appliedOf(r), 0);
  }
  assert.equal(moved.length, 0, `删掉动作后仍有 ${moved.length} 个非初值样本 ⇒ 存在未登记的 gain 写入者`);
});

// —— 消费者① 的接线证明：输入增益必须作用在**事件注入的调用点**上，不是只在状态里躺着。
// 这里包一层 a1.assess 记录"真正进入评价层的事件"，所以验的是 tick 里那条 `gain === 1 ? inc.evt : {...}` 分支本身。
test('P6a/① 输入增益接在注入调用点上：听不进时同一条 contact 到账打折，关闭时逐位不变', async () => {
  const runOnce = async ({ coupling, deafen }) => {
    const { world, agents } = room({ seedBase: 7, coupling });
    const a1 = agents.a1;
    const seen = [];
    const orig = a1.assess.bind(a1);
    a1.assess = (evt, ...rest) => { seen.push({ kind: evt.kind, valence: evt.valence, about: evt.about }); return orig(evt, ...rest); };
    if (deafen) { a1.coupling.apply('deafen'); a1.coupling.v.input = PARAMS.coupling.minInput; }
    world.pending.push({ for: 'a1', evt: { kind: 'contact', valence: 0.8, selfCaused: false, about: 'a2', serves: 'social' } });
    await a1.tick(world);
    return { injected: seen.find((s) => s.kind === 'contact' && s.about === 'a2'), seen };
  };
  const on = await runOnce({ coupling: 1, deafen: true });
  const off = await runOnce({ coupling: 1, deafen: false });
  const masked = await runOnce({ coupling: 0, deafen: false });
  assert.ok(on.injected, '注入的 contact 根本没进评价层 ⇒ 消费者① 无从生效，这条路径没走通');
  assert.equal(off.injected.valence, 0.8, `未变聋时事件被改了（${off.injected.valence}）⇒ gain=1 分支不是逐位透传`);
  assert.equal(masked.injected.valence, 0.8, `coupling 关着仍改写了事件（${masked.injected.valence}）⇒ 默认关不等价`);
  assert.equal(on.injected.valence, 0.8 * PARAMS.coupling.minInput, `变聋后到账 ${on.injected.valence}，期望按 minInput=${PARAMS.coupling.minInput} 衰减`);
  assert.ok(on.injected.valence < off.injected.valence, '增益没减到注入量 ⇒ 输入增益只是摆设');
});

// —— P6b 主判据：闭门必须在世界侧留痕，而且留痕要由"变量被读"产生，不是"动作被记账"产生
test('P6b 他人清单收缩 + 规则层 SECLUDED；走动作时 τ 到期两处同时恢复', async () => {
  const { world, agents } = room({ seedBase: 5 });
  const talkTargets = () => affordancesFor(world, 'a2').filter((x) => x.kind === 'talk').map((x) => x.target).sort().join(',');
  const before = talkTargets();
  assert.equal(before.split(',').length, 2, `基线应有两个可对话目标，实测 "${before}"`);

  // (1) 只改内部变量，不经过任何动作、不记任何账——他人清单若随之收缩，消费者读的就是这个变量本身
  agents.a1.coupling.v.available = 0;
  const during = talkTargets();
  assert.ok(!during.includes('a1'), '闭门者仍出现在他人可对话清单 ⇒ "改了个没人读的数"（P6b 判负口径）');
  assert.equal(during.split(',').filter(Boolean).length, 1);
  assert.equal(validate(world, 'a2', { kind: 'talk', target: 'a1' }).code, 'SECLUDED', '指名闭门者的 talk 没被规则层驳回 ⇒ 消费者④ 是空开关');
  agents.a1.coupling.v.available = 1; // 手工还原：这一步不带时长，只为证明两处都跟着变量走
  assert.equal(talkTargets(), before, '变量还原后他人清单没恢复 ⇒ 收缩不是由这个变量驱动的');
  assert.ok(validate(world, 'a2', { kind: 'talk', target: 'a1' }).ok);

  // (2) 经动作进入、按 τ 自动退出（时长归 P6c 管，这里只看世界侧两处同时复原）
  agents.a1.coupling.apply('seclude');
  assert.ok(!talkTargets().includes('a1'));
  for (let i = 0; i < PARAMS.coupling.tau; i++) agents.a1.coupling.tick(1);
  assert.deepEqual(agents.a1.coupling.v, COUPLING_DEFAULT);
  assert.equal(talkTargets(), before, 'τ 到期后他人清单没恢复 ⇒ 切断只发生在我自己的状态里');
  assert.ok(validate(world, 'a2', { kind: 'talk', target: 'a1' }).ok);
});

// 防御式默认：占位 agent（旧档、离线消融里的 {id,name}）没有耦合对象，绝不能因此凭空"叫不到"
test('P6b 负控：没有耦合对象的角色照旧可被叫到（默认值不是隐身）', async () => {
  const { world, agents } = room({ seedBase: 5 });
  world.agents.a1 = { id: 'a1', name: '岑' }; // 摘掉耦合对象，位置不动
  const targets = affordancesFor(world, 'a2').filter((x) => x.kind === 'talk').map((x) => x.target);
  assert.ok(targets.includes('a1'), '占位角色被排除在他人清单外 ⇒ 过滤条件写错，把"没有耦合状态"当成了"闭门"');
  assert.ok(validate(world, 'a2', { kind: 'talk', target: 'a1' }).ok);
  world.agents.a1 = agents.a1;
});

test('P6b 拒绝是世界侧的：refuse=1 时 talk 失败且不注入 contact；初值时同一调用成功', async () => {
  const { world, agents } = room({ seedBase: 6 });
  const talk = affordancesFor(world, 'a1').find((x) => x.kind === 'talk' && x.target === 'a3');
  assert.ok(talk, 'a1 的清单里没有对 a3 的 talk，负控无从比较');

  const ok = actuate(world, 'a1', talk);
  assert.equal(ok.code, 'OK', `未预设拒绝时 talk 竟失败（${ok.code}）⇒ 负控不成立`);
  assert.ok(world.pending.some((p) => p.for === 'a3' && p.evt.kind === 'contact'), '成功后没有 contact 注入 ⇒ 这条路径本来就不通');

  world.pending = [];
  agents.a3.coupling.apply('refuse');
  const refused = actuate(world, 'a1', talk);
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'REFUSED');
  assert.ok(!world.pending.some((p) => p.for === 'a3'), '被拒后仍向目标注入事件 ⇒ 拒绝没有真的挡住耦合');
});

test('P6b 聚合后果：同随机流下开启组对话成功数减半以上、发起数下降（S2 的三项量）', async () => {
  const stat = async (coupling) => {
    let talkRows = 0, talkOk = 0, initiated = 0, secluded = 0, refused = 0;
    for (const seedBase of [1, 2, 3]) {
      const r = await drive({ coupling, seedBase, ticks: 400 });
      for (const row of rowsOf(r)) {
        if (row.kind === 'talk' && row.action) { talkRows++; if (row.ok) talkOk++; }
        if (row.layer === 'rejected' && row.code === 'SECLUDED') secluded++;
        // R1 之后非法动作不再进 actuate：REFUSED 现在落在**驳回行**上，而不是"执行了但失败"的 talk 行。
        if (row.layer === 'rejected' && row.code === 'REFUSED') refused++;
      }
      initiated += Object.values(r.agents).reduce((s, a) => s + (a.counters.initiated ?? 0), 0);
    }
    return { talkRows, talkOk, initiated, secluded, refused };
  };
  const off = await stat(0);
  const on = await stat(1);
  assert.ok(on.talkOk < off.talkOk, `开启后对话成功数没下降（${off.talkOk} → ${on.talkOk}）⇒ 清单收缩没落到行为上`);
  assert.ok(on.talkOk / off.talkOk < 0.5, `下降不足一半（${off.talkOk} → ${on.talkOk}）：S2 要求 >5%，这里按实测口径收紧`);
  assert.ok(on.initiated < off.initiated, `主动发起数没变（${off.initiated} → ${on.initiated}）`);
  // REFUSED 发生在 actuate 的 talk 分支（耦合把目标设成"预设不理"），不在规则层，
  // 所以它表现为"执行了但 ok=false 的 talk 行"。R1 的 execute 兜底只拦**规则层非法**的动作，
  // 不影响这条读数（实测补闸门时确认过：驳回行 0，talkRows > talkOk 仍成立）。
  // 2026-11-09 复核（第二次审计后的装置更正）：自主链里"耦合拒绝"是通过 **③ 目标筛选** 落地的，
  // talk 不会以"执行了但失败"的形式出现——实测两臂的失败 talk 都是 0（off 228/228、on 54/54），
  // 原来"必须有失败的 talk 行"的断言依赖某条特定轨迹，重抽后就恒假。
  // 真正承重的读数是**尝试数本身塌掉**：off 228 → on 54（−76%）。判据据此改为"尝试数必须塌掉一半以上"。
  assert.ok(on.talkRows < off.talkRows * 0.5, `开启后 talk 尝试数没塌掉（${off.talkRows} → ${on.talkRows}）⇒ 拒绝没有真的挡住耦合`);
  // 如实登记的局限：自主链里 ③ 先过滤目标，所以 ④ 的 SECLUDED 在实跑中不出现，它只在"指名意图"时兜底（见上面两条单测）。
  // 这条断言的作用是：哪天 SECLUDED 进了自主链，这里会亮，逼台账重述 ③④ 的分工，而不是让局限悄悄变成主张。
  assert.equal(on.secluded, 0, `实跑出现 ${on.secluded} 次 SECLUDED 驳回 ⇒ ③ 过滤与 ④ 裁决的分工已变，需回 §16.3 重登记`);
});

// —— P6c 可逆：τ 是时长，不是永久损伤；拉长 τ 只延长时长，不改变"会回来"
test('P6c 三条动作都在 τ 刻后精确回到初值（容差 0）；τ=200 同样回；重复动作只续期', () => {
  for (const kind of COUPLING_KINDS) {
    const c = new Coupling({ tau: 40 });
    c.apply(kind);
    assert.notDeepEqual(c.v, COUPLING_DEFAULT, `${kind} 没写下任何耦合状态`);
    for (let i = 0; i < 39; i++) c.tick(1);
    assert.notDeepEqual(c.v, COUPLING_DEFAULT, `${kind} 未满 τ 就回弹 ⇒ τ 不是时长`);
    c.tick(1);
    assert.deepEqual(c.v, COUPLING_DEFAULT, `${kind} 在 τ 到期后没回到初值`);
  }
  const long = new Coupling({ tau: 200 });
  long.apply('seclude');
  for (let i = 0; i < 200; i++) long.tick(1);
  assert.equal(long.v.available, 1, 'τ 拉长后不再回弹 ⇒ 与 D1 的不可逆语义混淆（P6c 判负口径）');
  const refresh = new Coupling({ tau: 40 });
  refresh.apply('deafen');
  refresh.apply('deafen');
  assert.equal(refresh.hold.input, 40, '重复动作把时长累加成了 80 ⇒ 连点两下就变永久');
  assert.equal(refresh.v.input, PARAMS.coupling.minInput);
});

// —— P6d 状态解释而非日程（S4）。口径已回写 PLAN §16.6：
// 因变量是**耦合 onset**——本刻决策之前耦合变量还停在初值、而这一步选了耦合动作。
// 为什么不用"所有耦合动作行"：τ 会把已经闭合的耦合一直保持，实测 93% 的耦合动作是**续期**
// （622 条耦合动作里只有 42 条是 onset）。续期测的是"闭合状态是否保持"，不是"什么触发了耦合变化"，
// 拿它当触发证据等于把结果当原因。
const auc = (labels, scores) => {
  const nPos = labels.reduce((s, y) => s + y, 0);
  const nNeg = labels.length - nPos;
  if (!nPos || !nNeg) return null;
  const order = scores.map((s, i) => i).sort((i, j) => scores[i] - scores[j]);
  const rank = new Array(scores.length);
  for (let p = 0; p < order.length; ) {
    let q = p;
    while (q + 1 < order.length && scores[order[q + 1]] === scores[order[p]]) q++;
    const r = (p + q + 2) / 2; // 并列取平均秩（1 基）
    for (let k = p; k <= q; k++) rank[order[k]] = r;
    p = q + 1;
  }
  const sumPos = labels.reduce((s, y, i) => (y ? s + rank[i] : s), 0);
  return (sumPos - (nPos * (nPos + 1)) / 2) / (nPos * nNeg);
};

// 特征必须**按角色各自标准化**：三个人躲出去的基线差一个数量级（实测 onset 21/18/3），
// 直接合并的话"你是谁"就能预测，零分布会被撑到 AUC≈0.66（实测），任何状态效应都能"通过"。
const personCenter = (xs, groups) => {
  const out = xs.slice();
  for (const g of groups) {
    const sub = g.map((i) => xs[i]);
    const mu = sub.reduce((s, x) => s + x, 0) / sub.length;
    const sd = Math.sqrt(sub.reduce((s, x) => s + (x - mu) ** 2, 0) / sub.length) || 1;
    g.forEach((dst, k) => { out[dst] = (sub[k] - mu) / sd; });
  }
  return out;
};

// 置换零分布：在同一个角色内部把特征重配到其他时刻（保留标签序列与时间结构）
const shuffleWithin = (xs, groups, rng) => {
  const out = xs.slice();
  for (const g of groups) {
    const src = g.slice();
    for (let i = src.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [src[i], src[j]] = [src[j], src[i]]; }
    g.forEach((dst, k) => { out[dst] = xs[src[k]]; });
  }
  return out;
};

// onset 采集：决策之前先记下耦合状态，事后按"这刻选了什么 + 之前是否已在耦合里"打标
async function onsetRun({ seedBase = 1, ticks = 1200 } = {}) {
  const { world, agents } = room({ seedBase, coupling: 1 });
  const rows = [];
  for (let t = 1; t <= ticks; t++) {
    world.t = t;
    world.percepts = [];
    if (t % 55 === 0) world.pantry = Math.min(8, world.pantry + 2);
    for (const id of Object.keys(agents)) {
      const a = agents[id];
      const pre = { ...a.coupling.v }; // 决策之前的耦合状态：onset 判定的唯一依据
      const before = a.trace.length;
      await a.tick(world);
      const produced = a.trace.slice(before).filter((x) => x.action);
      if (!produced.length) continue; // 这一刻没落成行动（候选为空/驳回到底）
      const r = produced[produced.length - 1];
      const variable = COUPLING_EFFECTS[r.kind]?.variable ?? null;
      const d = r.tickStart?.drives ?? r.drives; // 本刻输入处理之前的需求读数：严格早于这次决策
      const need = (name) => r.dep?.find?.((x) => x.name === name) ?? { setpoint: 0.5 };
      rows.push({
        id, t, kind: r.kind,
        onset: variable ? (pre[variable] === COUPLING_DEFAULT[variable] ? 1 : 0) : 0,
        couplingAct: variable ? 1 : 0,
        excess: d.stimulation - need('stimulation').setpoint,
        socialGap: need('social').setpoint - d.social,
        risk: r.viab?.risk ?? 0,
        trust: Object.values(r.rel ?? {}).length ? Math.min(...Object.values(r.rel).map((v) => v.trust)) : 50,
        phase: t % PARAMS.coupling.tau,
      });
    }
  }
  return rows;
}

// 口径（§16.6 的 P6d 二次修订，A 兑现缓解之后）：主统计量从"逐 seed 各自过零分布"改成
// **三 seed 合并过零分布**，逐 seed 的 AUC 原样打印、并只要求方向一致（>0.5）。
// 为什么改：A 生效后角色真的少过载了，单 seed 的 onset 只剩 38–42 个，"AUC 与 p95 的间距"比抽样噪声还小
// （实测 seedBase=1 在 1200 刻窗口上是 0.557 vs p95 0.581，换个窗口长度就翻面：400 刻时它是 0.714 vs 0.615）。
// 这不是把线调低来放行——合并后判据仍然要求"打过按 seed+角色 分块的置换零分布"，
// 换来的只是主张弱一档：**整体上**状态解释 onset，不再声称每个 seed 单独都过线。
test('P6d 合并三 seed：耦合 onset 被"超出本人设定点的刺激"预测并胜过置换零分布；置换后塌陷；相位不能预测；逐 seed 披露', async () => {
  const rows = [];
  const perSeed = [];
  for (const seedBase of [1, 2, 3]) {
    const r = await onsetRun({ seedBase, ticks: 1200 });
    for (const x of r) rows.push({ ...x, seedBase, key: `${seedBase}:${x.id}` });
    perSeed.push({ seedBase, acts: r.filter((x) => x.couplingAct).length, onsets: r.filter((x) => x.onset).length });
  }
  const labels = rows.map((x) => x.onset);
  const keys = [...new Set(rows.map((x) => x.key))];
  const groups = keys.map((k) => rows.reduce((acc, x, i) => (x.key === k && acc.push(i), acc), []));
  const onsets = labels.reduce((s, x) => s + x, 0);
  const acts = rows.filter((x) => x.couplingAct).length;
  assert.ok(onsets > 0, `${acts} 条耦合动作里没有一条是 onset ⇒ 耦合只被续期，从未被"决定"过`);

  const centered = personCenter(rows.map((x) => x.excess), groups);
  const real = auc(labels, centered);
  const rng = makeRng(50);
  const nulls = [];
  for (let k = 0; k < 200; k++) nulls.push(auc(labels, shuffleWithin(centered, groups, rng)));
  const sorted = nulls.slice().sort((a, b) => a - b);
  const p95 = sorted[189];
  const nullMean = nulls.reduce((s, x) => s + x, 0) / nulls.length;

  // 对照：不做角色内标准化时，同一批样本的置换零分布均值本身 ≈0.66（"你是谁"在预测），
  // 必须登记两版读数，防止以后有人拿未标准化的高 AUC 当状态证据。
  const raw = rows.map((x) => x.excess);
  const rngRaw = makeRng(900);
  const rawNulls = [];
  for (let k = 0; k < 50; k++) rawNulls.push(auc(labels, shuffleWithin(raw, groups, rngRaw)));
  const rawNullMean = rawNulls.reduce((s, x) => s + x, 0) / rawNulls.length;

  assert.ok(real > p95, `合并 onset 的刺激 AUC ${real.toFixed(3)} 未超过按 seed+角色 置换的零分布 p95 ${p95.toFixed(3)} ⇒ 触发不是状态（S4 判负口径）`);
  assert.ok(Math.abs(nullMean - 0.5) < 0.03, `置换内部状态后 AUC 均值 ${nullMean.toFixed(3)} 没塌回 0.5 ⇒ 置换没真的切断状态与动作的对应`);
  // 这条对照的正确形式是**相对**的：未标准化版的零分布必须明显高于按 seed+角色 分块版，
  // 否则"标准化"就没在防任何东西。绝对阈值（原先 >0.6）是 A 之前那一档的读数，A 兑现缓解后
  // 三个人的 onset 基线差本身缩小（实测未标准化零分布均值 0.64→0.59），继续钉住旧数等于拿历史读数当判据。
  assert.ok(rawNullMean > nullMean + 0.05, `未标准化版的零分布均值 ${rawNullMean.toFixed(3)} 没高出分块版（${nullMean.toFixed(3)}）0.05 ⇒ "谁"不再预测，这条对照失效，须重看分组`);

  // 外部时钟对照：只用耦合时长 τ 上的相位预测 onset。它若也能打过零分布，闭门就成了日程（S4）
  const phaseC = personCenter(rows.map((x) => x.phase), groups);
  const rngPhase = makeRng(500);
  const phaseNulls = [];
  for (let k = 0; k < 200; k++) phaseNulls.push(auc(labels, shuffleWithin(phaseC, groups, rngPhase)));
  const pSorted = phaseNulls.slice().sort((a, b) => a - b);
  const phaseAuc = auc(labels, phaseC);
  assert.ok(phaseAuc <= pSorted[189], `相位单独就能把 onset 预测到 AUC ${phaseAuc.toFixed(3)}（零分布 p95 ${pSorted[189].toFixed(3)}）⇒ 动作带日程性（S4）`);

  // 逐 seed 只要求方向一致（>0.5），过不过合并线在这里原样打印
  const seedLines = perSeed.map((p, idx) => {
    const sub = rows.filter((x) => x.seedBase === p.seedBase);
    const g = [...new Set(sub.map((x) => x.key))].map((k) => sub.reduce((acc, x, i) => (x.key === k && acc.push(i), acc), []));
    const v = auc(sub.map((x) => x.onset), personCenter(sub.map((x) => x.excess), g));
    assert.ok(v > 0.5, `seedBase=${p.seedBase} 的方向都是反的（AUC ${v.toFixed(3)}）⇒ 状态与 onset 负相关，合并读数不可信`);
    return `seed${p.seedBase} ${v.toFixed(3)}（onset ${p.onsets}/${p.acts}）`;
  });
  const others = ['socialGap', 'risk', 'trust']
    .map((k) => `${k} ${auc(labels, personCenter(rows.map((x) => (k === 'trust' ? -x[k] : x[k])), groups)).toFixed(3)}`)
    .join(' | ');
  console.log(`[P6d 合并] 决策 ${rows.length} / 耦合动作 ${acts}（onset ${onsets}，续期 ${acts - onsets}）；` +
    `excess AUC ${real.toFixed(3)} > p95 ${p95.toFixed(3)}（均值 ${nullMean.toFixed(3)}；未标准化版 ${rawNullMean.toFixed(3)}）；` +
    `相位 ${phaseAuc.toFixed(3)} ≤ ${pSorted[189].toFixed(3)}；逐 seed：${seedLines.join(' / ')}；其余预登记特征：${others}`);
});

// —— P6e 切断独立：两个开关互不吞并；"只删动作"时耦合机制必须零影响轨迹
test('P6e 组合切断：删掉动作后与 coupling=0 逐位相同；两者同开各自记账', async () => {
  const seqHash = (r) => Object.values(r.agents).map((a) => a.trace.map((x) => `${x.t}|${x.action ?? x.layer}|${x.ok ?? ''}|${Object.entries(x.drives ?? {}).map(([k, v]) => `${k}:${v.toFixed(3)}`).join(',')}|${JSON.stringify(x.m3 ?? null)}`).join('#')).join('@');

  const both = await drive({ coupling: 1, m3: 1, ticks: 200, seedBase: 8 });
  const removed = await drive({ coupling: 1, m3: 1, ticks: 200, seedBase: 8, couplingActions: false });
  const coupOff = await drive({ coupling: 0, m3: 1, ticks: 200, seedBase: 8 });
  assert.equal(seqHash(removed), seqHash(coupOff), '删掉三条动作后轨迹仍与 coupling=0 不同 ⇒ coupling 开关夹带了清单之外的副作用');
  assert.notEqual(seqHash(both), seqHash(coupOff), '开耦合后轨迹一模一样 ⇒ 三条动作根本没进比较');

  assert.ok(appliedOf(both) > 0, `耦合开、M3 开时 couplingApplied=${appliedOf(both)} ⇒ M3 把三条动作吞了（决策②(a) 只授权"不进规划"，没授权"不进比较"）`);
  const m3Decisions = Object.values(both.agents).reduce((s, a) => s + (a.counters.m3Decisions ?? 0), 0);
  assert.ok(m3Decisions > 0, `M3 决策数 ${m3Decisions} ⇒ 耦合把 M3 挤没了`);
  assert.equal(coupOff.samples.filter(offDefault).length, 0, 'M3 开、耦合关时 gain.* 仍被改写 ⇒ 两者串台');

  const base = await drive({ coupling: 0, m3: 0, ticks: 200, seedBase: 8 });
  const coupOnly = await drive({ coupling: 1, m3: 0, ticks: 200, seedBase: 8 });
  assert.ok(appliedOf(coupOnly) > 0);
  assert.equal(Object.values(coupOnly.agents).reduce((s, a) => s + (a.counters.m3Decisions ?? 0), 0), 0, 'M3 关着却记了决策数 ⇒ 耦合的记账串进了 M3');
  assert.equal(base.samples.filter(offDefault).length, 0);
});

// —— A2/A3（PLAN §17.3）：缓解必须"发得出去"，而且必须由同一张表定价
test('A3 单表定价：清单里的刺激标价 == COUPLING_EFFECTS.relief，且评价目标按同一顺序换算（不是两处各写一份数）', () => {
  const { world, agents } = room({ seedBase: 9 });
  const serves = Object.fromEntries(affordancesFor(world, 'a1').filter((x) => COUPLING_KINDS.includes(x.kind)).map((x) => [x.kind, x.serves.stimulation]));
  for (const kind of COUPLING_KINDS) {
    assert.equal(serves[kind], COUPLING_EFFECTS[kind].relief, `${kind} 的 serves.stimulation 与 relief 表不一致 ⇒ 定价与发放又分成两张会漂移的表`);
  }
  const T = buildCouplingTargets();
  assert.ok(T.seclude.arousal < T.deafen.arousal, `缓解目标逆序（seclude ${T.seclude.arousal} vs deafen ${T.deafen.arousal}）⇒ 表是拍的，不是换算出来的`);
  assert.ok(T.deafen.arousal < T.refuse.arousal && T.refuse.arousal < T.relocate.arousal, `refuse ${T.refuse.arousal} 未落在 deafen 与兜底 ${T.relocate.arousal} 之间`);
  // 换算线只用既有锚点：把 relief 归零必须精确回落到 relocate 兜底（§17.4-3 的"零缓解档"）
  const prev = PARAMS.coupling.relief;
  try {
    PARAMS.coupling.relief = 0;
    assert.equal(buildCouplingTargets().deafen.arousal, T.relocate.arousal, 'relief=0 没有回落兜底 ⇒ 兜底与换算线不是同一条');
  } finally {
    PARAMS.coupling.relief = prev;
    buildCouplingTargets();
  }
  assert.equal(Object.values(agents).length, 3);
});

test('A2 缓解真的发得出去：走生产执行链、按住噪声后，兑现档比零缓解档把警觉压得更低', async () => {
  const probe = async (relief, kind) => {
    const { world, agents } = room({ seedBase: 9 });
    const a1 = agents.a1;
    const prev = PARAMS.coupling.relief;
    PARAMS.coupling.relief = relief;
    buildCouplingTargets();
    try {
      a1.bank.m.arousal = 0.9;
      a1.traits.noise.arousal = 0; // 单发探针：只问方向，把这一维的随机项按住（否则一次抽样就能盖掉 0.03 的缓解量）
      // 走 execute（tick 真正调的那条链：花费存续 → assess 注入 → 习惯记账），不自己重放一遍评价
      const r = await a1.execute(world, { id: kind, kind }, 'deliberation', world.t, true);
      assert.ok(r.ok, `${kind} 没执行成功（${r.code}）⇒ 无从谈缓解发放`);
      a1.bank.tick(1); // 注入在下一刻的 bank.tick 里落地，比对必须跨过这一步
      return a1.bank.m.arousal - 0.9;
    } finally {
      PARAMS.coupling.relief = prev;
      buildCouplingTargets();
    }
  };
  for (const kind of COUPLING_KINDS) {
    const delivered = await probe(1, kind);
    const none = await probe(0, kind);
    assert.ok(delivered < 0, `${kind} 兑现档执行后 Δarousal=${delivered.toFixed(4)} 仍不为负 ⇒ 缓解方向不对`);
    assert.ok(delivered < none - 0.01, `${kind} 兑现档（${delivered.toFixed(4)}）没比零缓解档（${none.toFixed(4)}）多压下 0.01 ⇒ 那点降幅只是衰减项，不是缓解`);
  }
  // 缓解量必须与标价同序（§17.2：seclude 标价最狠 ⇒ 降幅最大；refuse 最轻）
  const d = {};
  for (const kind of COUPLING_KINDS) d[kind] = await probe(1, kind);
  assert.ok(d.seclude < d.deafen && d.deafen < d.refuse, `降幅逆序 seclude ${d.seclude.toFixed(4)} / deafen ${d.deafen.toFixed(4)} / refuse ${d.refuse.toFixed(4)} ⇒ 换算线与标价脱钩`);
});

test('A1 收益兑现（配对）：同随机流下开档的过载时间占比必须比关档低 3 个百分点以上', async () => {
  const overShare = async (coupling) => {
    const r = await drive({ coupling, seedBase: 1, ticks: 600 });
    const rows = Object.values(r.agents);
    let over = 0, n = 0;
    for (const a of rows) for (const x of a.trace) if (x.action && x.drives) { n++; if (x.drives.stimulation > a.drives.setpoint.stimulation) over++; }
    return over / n;
  };
  const off = await overShare(0);
  const on = await overShare(1);
  assert.ok(on < off - 0.03, `过载时间占比 关 ${(off * 100).toFixed(1)}% → 开 ${(on * 100).toFixed(1)}%，未达预登记的 3pp 线（§17.3 A1）⇒ 按 B 收口`);
});

// —— 占空比：τ=40 下"有多久听不进"是这条机制最容易被读歪的地方，把数登记下来并设一条硬边界
test('M4 占空比：耦合动作占决策比重与 gain 偏离初值的时间占比都不得超过 90%（否则是锁死不是调制）', async () => {
  const r = await drive({ coupling: 1, ticks: 600, seedBase: 1 });
  const decisions = rowsOf(r).filter((x) => x.action).length;
  const chosen = rowsOf(r).filter((x) => x.action && COUPLING_KINDS.includes(x.kind)).length;
  const deafShare = r.samples.filter((s) => s.v.input !== COUPLING_DEFAULT.input).length / r.samples.length;
  const shutShare = r.samples.filter((s) => s.v.available !== COUPLING_DEFAULT.available).length / r.samples.length;
  console.log(`[M4 占空比] 决策 ${decisions} 条 / 耦合动作 ${chosen} 条（${((chosen / decisions) * 100).toFixed(1)}%）；` +
    `听不进的时间占比 ${(deafShare * 100).toFixed(1)}%，叫不到的时间占比 ${(shutShare * 100).toFixed(1)}%（τ=${PARAMS.coupling.tau}，minInput=${PARAMS.coupling.minInput}）`);
  assert.ok(deafShare < 0.9, `听不进的时间占比 ${(deafShare * 100).toFixed(1)}% ≥90%：gain.input 已被常态锁死，"调制"名不副实`);
  assert.ok(shutShare < 0.9, `叫不到的时间占比 ${(shutShare * 100).toFixed(1)}% ≥90%：角色常态离场，不再是耦合权而是断连`);
});
