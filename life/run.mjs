// 最小原型跑动与判据报告。默认离线（确定性替身，不联网）；--live 时插真模型审议层。
import { makeWorld, spawn, BASE_KINDS, scanSecrets } from './body.mjs';
import { gossipRound } from './gossip.mjs';
import { socialRound } from './social.mjs';
import { Organism } from './agent.mjs';
import { hashSeed, makeRng } from './rng.mjs';
import { dist, kl, ruleCoverage, spontaneous, mutualInfo, miNull, deliberationRate, actionEntropy, driverDist, recoveryStats } from './metrics.mjs';
import { DIMS, sampleTraits } from './traits.mjs';
import { BASE_SETPOINT, NEED_META } from './drives.mjs';
import { PARAMS, assertFrozen, paramsFingerprint } from './params.mjs';
import { SelfMaintain } from './viability.mjs';
// 与 s4-p2-intervention 互相依赖（它要 simulate，我要 p2Intervention），所以两边都只能用静态 import：
// 换成动态 import 会在 run.mjs 求值未完成时等自己 ⇒ 顶层 await 永不 settle。两边引用的都是函数声明，链接期已就绪。
import { p2Intervention, assertCutNegative } from './s4-p2-intervention.mjs';

const ROSTER = [
  { id: 'a1', name: '岑', archetype: '谨慎', loc: 'home' },
  { id: 'a2', name: '绛', archetype: '冲动', loc: 'hall' },
  { id: 'a3', name: '蓑', archetype: '孤僻', loc: 'watch' },
];

export async function simulate({ seed = 7, ticks = 400, condition = 'C2', mInit = null, events = true, deliberator = null, pin = null, traitsOverride = null, pantry = 6, stash = 3, channelMask = null, group = null, gossipAt = [], riskyPortion = null, scheduleWeight = null, socialGossip = null } = {}) {
  // V2 §6 修补①：只有显式标了组的运行才记账。组标签是「同一次比较的同一批人」，
  // 决策量纲（努力折扣/紧迫度指数/需求表/动作表/世界供给）必须整组一致，自变量（condition、通道掩码、钳制、人格）才允许不一致。
  if (group) assertFrozen(group, paramsFingerprint({ setpoint: BASE_SETPOINT, needs: NEED_META, kinds: BASE_KINDS, pantry, stash, risky: riskyPortion ?? PARAMS.risky.portion, schedule: scheduleWeight ?? PARAMS.schedule.weight, social: socialGossip ?? PARAMS.socialGossip }));
  const world = makeWorld({ pantries: pantry, stash, riskyPortion: riskyPortion ?? PARAMS.risky.portion, scheduleWeight: scheduleWeight ?? PARAMS.schedule.weight, socialGossip: socialGossip ?? PARAMS.socialGossip });
  const agents = {};
  for (const r of ROSTER) {
    const a = new Organism({ ...r, seed: hashSeed(seed, `${r.id}:${condition}:${JSON.stringify(channelMask ?? '')}`), condition, mInit: mInit?.[r.id], deliberator, traitsOverride: traitsOverride?.[r.id], channelMask });
    agents[r.id] = a;
    world.agents[r.id] = a;
    spawn(world, r.id, r.loc);
  }
  for (let t = 1; t <= ticks; t++) {
    world.t = t;
    world.percepts = [];
    if (events && t % 97 === 0) world.percepts.push({ for: 'all', kind: 'alarm', subject: '墙外', salience: 0.9 });
    if (t % 55 === 0) world.pantry = Math.min(8, world.pantry + 2);
    scanSecrets(world);
    if (gossipAt.includes(t)) {
      // 离线世界没有玩家实体 ⇒ presence:false（在场性由 host 路径与单测覆盖，见 gossip.mjs 注释）
      world.gossipLog = (world.gossipLog ?? []).concat(gossipRound(world, { presence: false }));
    }
    for (const id of Object.keys(agents)) {
      await agents[id].tick(world);
      if (pin?.[id]) for (const [d, v] of Object.entries(pin[id])) agents[id].bank.m[d] = v; // 持续钳制：像光遗传按住
    }
  }
  // M7：离线世界没有玩家实体 ⇒ presence:false（与 gossipRound 的离线口径一致）
  if (world.socialGossip > 0) socialRound(world, { presence: false });
  return { world, agents };
}

const actionsOf = (a) => a.trace.filter((r) => r.action).map((r) => r.action);

// P1a 通道通电：持续钳制某个调制维，看行为分布变不变（自变量是「当下状态」）
export async function p1a({ seed = 7, ticks = 320, condition = 'C2', target = 'a1', deliberator = null, channelMask = null, group = null } = {}) {
  const baseRun = await simulate({ seed, ticks, condition, deliberator, channelMask, group });
  const baseDist = dist(actionsOf(baseRun.agents[target]));
  const rows = [];
  for (const d of DIMS) {
    for (const v of [0.9, 0.1]) {
      const run = await simulate({ seed, ticks, condition, pin: { [target]: { [d]: v } }, deliberator, channelMask, group });
      rows.push({ 钳制维: d, 值: v, KL: Number(kl(dist(actionsOf(run.agents[target])), baseDist).toFixed(4)) });
    }
  }
  const meanKl = Number((rows.reduce((s, r) => s + r.KL, 0) / rows.length).toFixed(4));
  return { kind: 'P1a 钳制m', condition, meanKl, rows, baseDist: Object.fromEntries(baseDist), n: actionsOf(baseRun.agents[target]).length, counters: baseRun.agents[target].counters };
}

// P1b 人格承重：完全不动 m，只改慢参数，同一事件序列看分岔（自变量是「人格参数」）
export async function p1b({ seed = 7, ticks = 320, condition = 'C2', target = 'a1', deliberator = null } = {}) {
  const baseRun = await simulate({ seed, ticks, condition, deliberator });
  const baseDist = dist(actionsOf(baseRun.agents[target]));
  const OV = {
    'gain.inhibit×2': { gain: { ...sampleTraits(makeRng(1), '谨慎').gain, inhibit: 2.6 } },
    'normStrength→0.1': { normStrength: 0.1 },
    'social_setpoint→0.75': { social_setpoint: 0.75 },
    'goals.order→0.1': { goals: { order: 0.1, safety: 0.7, novelty: 0.6, social: 0.4 } },
    'τ×6（更黏）': { tau: { arousal: 480, approach: 960, inhibit: 1440, quiescence: 1200 } },
  };
  const rows = [];
  for (const [label, ov] of Object.entries(OV)) {
    const run = await simulate({ seed, ticks, condition, traitsOverride: { [target]: ov }, deliberator });
    rows.push({ 参数改动: label, KL: Number(kl(dist(actionsOf(run.agents[target])), baseDist).toFixed(4)) });
  }
  const meanKl = Number((rows.reduce((s, r) => s + r.KL, 0) / rows.length).toFixed(4));
  return { kind: 'P1b 改人格参数', condition, meanKl, rows };
}

export const p1 = p1a;

export async function p2({ seed = 7, ticks = 400, condition = 'C2', deliberator = null, channelMask = null, group = null } = {}) {
  const { agents } = await simulate({ seed, ticks, condition, events: false, deliberator, channelMask, group });
  return Object.fromEntries(
    Object.values(agents).map((a) => [
      a.name,
      { 自发率: Number(spontaneous(a.trace, a.counters).rate.toFixed(3)), 静默熵: actionEntropy(a.trace), 互信息: mutualInfo(a.trace), 噪声门槛: miNull(a.trace), 耦合: mutualInfo(a.trace) > miNull(a.trace) ? '是' : '否', 主动发起: a.counters.initiated, 审议率: deliberationRate(a.counters), 动作数: a.counters.actions, 外部事件: a.counters.externalEvents },
    ]),
  );
}

export async function p3({ seed = 7, ticks = 400, condition = 'C2', deliberator = null, channelMask = null, group = null } = {}) {
  const { world, agents } = await simulate({ seed, ticks, condition, deliberator, channelMask, group });
  return Object.fromEntries(Object.values(agents).map((a) => [a.name, ruleCoverage(a.trace, world, 20)]));
}

// §24 要求的逐通道消融：在「全开」基础上单独关掉某一个通道，看净效应由谁贡献、方向是谁拧的
export async function ablationChannels({ seed = 7, ticks = 400 } = {}) {
  const CONFIGS = [
    { 配置: '全开 C2', condition: 'C2', mask: null },
    { 配置: '全关 C2-neg', condition: 'C2-neg', mask: null },
    { 配置: '单关①可见性', condition: 'C2', mask: { vis: 0 } },
    { 配置: '单关②效用', condition: 'C2', mask: { util: 0 } },
    { 配置: '单关③采样', condition: 'C2', mask: { temp: 0 } },
    { 配置: '单关④检索', condition: 'C2', mask: { mem: 0 } },
  ];
  const rows = [];
  for (const c of CONFIGS) {
    const { agents } = await simulate({ seed, ticks, condition: c.condition, channelMask: c.mask, group: c.配置 });
    const ids = Object.values(agents).flatMap((a) => a.trace.filter((r) => r.action).map((r) => r.action));
    const counters = Object.values(agents).reduce((s, a) => {
      for (const k of Object.keys(a.counters)) s[k] = (s[k] ?? 0) + a.counters[k];
      return s;
    }, {});
    const one = await p1a({ seed, ticks: 320, condition: c.condition, channelMask: c.mask, group: c.配置 });
    rows.push({
      配置: c.配置,
      决策: ids.length,
      '高冲动率': Number((ids.filter((x) => x === 'look_out' || x.startsWith('take_shared')).length / Math.max(1, ids.length)).toFixed(3)),
      审议率: Number((counters.deliberation / Math.max(1, counters.actions)).toFixed(3)),
      'P1a KL': one.meanKl,
      驳回: counters.rejected,
      越轨: counters.normbreak,
      主动发起: counters.initiated,
      行动来源: driverDist(Object.values(agents).flatMap((a) => a.trace)),
    });
  }
  return rows;
}

export async function ablation({ seed = 7, ticks = 400 } = {}) {
  const rows = [];
  for (const condition of ['C0', 'C1', 'C2', 'C2-neg']) {
    const group = `消融-${condition}`;
    const one = await p1a({ seed, ticks, condition, group });
    const two = await p2({ seed, ticks, condition });
    const three = await p3({ seed, ticks, condition });
    const four = await p1b({ seed, ticks, condition });
    const vals = Object.values(two);
    const avg = (f) => Number((vals.reduce((s, v) => s + f(v), 0) / vals.length).toFixed(3));
    rows.push({
      条件: condition,
      'P1a 钳制m KL': one.meanKl,
      'P1b 改人格 KL': four.meanKl,
      静默熵: avg((v) => v.静默熵),
      互信息: avg((v) => v.互信息),
      主动发起: vals.reduce((s, v) => s + v.主动发起, 0),
      审议率: avg((v) => v.审议率),
      'P3 覆盖': Number((Object.values(three).reduce((s, v) => s + v.coverage, 0) / Object.keys(three).length).toFixed(3)),
      驳回: Object.values((await simulate({ seed, ticks, condition })).agents).reduce((s, a) => s + a.counters.rejected, 0),
    });
  }
  return rows;
}

// 多 seed 稳健性扫描：§28 的每一条主张都只给了 seed 7，而可比性纪律写的是「多 seed」。
// 这里只扫 headline 量（主导来源占比、P1a、驳回、静默熵、P2 受控干预、P3 余量），不扫全表——全表 × seed 太贵且读不动。
export async function sweep({ seeds = [7, 11, 13, 23, 42], ticks = 400 } = {}) {
  // P2 的判据按 D6 换成受控需求干预后，旧的「耦合C2 / 耦合C0」（MI 高出置换零分布的人数）两栏实测均值同为 0.8，
  // 继续留在表里会被读成"C2 与 C0 一样耦合"⇒ 换成现在真正在用的判据列，并与 s4-p2-intervention 共用同一段实现。
  const av = (o, f) => Number((Object.values(o).reduce((s, v) => s + f(v), 0) / Object.keys(o).length).toFixed(3));
  // 覆盖率两次各自 toFixed 再相减会在 seed 7 上给出 −0.018，与 §35 的 −0.017 差在双重舍入 ⇒ 差值用原值算，只在最后舍一次
  const cov = (o) => Object.values(o).reduce((s, v) => s + v.coverage, 0) / Object.keys(o).length;
  const rows = [];
  for (const seed of seeds) {
    const { agents } = await simulate({ seed, ticks, condition: 'C2', group: '扫描' });
    const d = driverDist(Object.values(agents).flatMap((a) => a.trace));
    const one = await p1a({ seed, ticks: 320, condition: 'C2', group: '扫描' });
    const neg = await p1a({ seed, ticks: 320, condition: 'C2-neg', group: '扫描' });
    const c2 = await p2({ seed, ticks, condition: 'C2' });
    const iv = await p2Intervention({ seeds: [seed], ticks });
    assertCutNegative(iv.rows);
    // 没有快照时均值会算成 0，读起来像"干预无效应"⇒ 空读数必须先报错，不能进表
    if (!iv.snapshots) throw Error(`seed ${seed} 没取到任何可比较快照 ⇒ P2 干预列是空读数`);
    const r2 = cov(await p3({ seed, ticks, condition: 'C2' }));
    const r0 = cov(await p3({ seed, ticks, condition: 'C0' }));
    rows.push({
      seed,
      需求主导: Number(['energy', 'social', 'stimulation'].reduce((s, k) => s + (d[k] ?? 0), 0).toFixed(3)),
      努力折扣主导: d['努力折扣'] ?? 0,
      调制主导: d['调制'] ?? 0,
      'P1a C2': one.meanKl,
      'P1a neg': neg.meanKl,
      驳回: Object.values(agents).reduce((s, a) => s + a.counters.rejected, 0),
      静默熵: av(c2, (v) => v.静默熵),
      'P2干预TV': Number(iv.bySeed[0].meanTv.toFixed(4)),
      'P2切断TV': Number(iv.bySeed[0].maxCutTv.toFixed(4)),
      'P3余量C2-C0': Number((r2 - r0).toFixed(3)),
    });
  }
  const agg = (k) => {
    const v = rows.map((r) => r[k]);
    return { mean: Number((v.reduce((s, x) => s + x, 0) / v.length).toFixed(3)), min: Math.min(...v), max: Math.max(...v) };
  };
  // 汇总必须把实际跑过的 seed 带出来：曾经有一次 seed 解析出错，只跑了 seed=0 一档，表格看起来仍像"扫过了"
  return { rows, seeds: rows.map((r) => r.seed), mean: Object.fromEntries(Object.keys(rows[0]).filter((k) => k !== 'seed').map((k) => [k, agg(k)])) };
}

// S1 / O2：受损速度读数。存续的主张不是"会不会掉"，而是"**多快掉、由什么决定、能不能被行为改变**"。
// 轨迹从 trace 里取（每条动作记录都带 viab），所以不需要给引擎加采样钩子。
export async function viabilityProfile({ seed = 7, ticks = 1200 } = {}) {
  const CONFIGS = [
    { 配置: '常态 · ⑤⑥全开', pantry: 6, stash: 3, mask: null, condition: 'C2' },
    { 配置: '常态 · ⑤⑥全关', pantry: 6, stash: 3, mask: { viab: 0, erosion: 0 }, condition: 'C2' },
    { 配置: '饥馑 · ⑤⑥全开', pantry: 0, stash: 0, mask: null, condition: 'C2' },
    { 配置: '饥馑 · ⑤⑥全关', pantry: 0, stash: 0, mask: { viab: 0, erosion: 0 }, condition: 'C2' },
    { 配置: '宽裕 · ⑤⑥全开', pantry: 8, stash: 5, mask: null, condition: 'C2' },
  ];
  const rows = [];
  for (const c of CONFIGS) {
    const { agents, world } = await simulate({ seed, ticks, condition: c.condition, channelMask: c.mask, pantry: c.pantry, stash: c.stash, group: `存续-${c.配置}` });
    for (const a of Object.values(agents)) {
      const recs = a.trace.filter((r) => r.viab);
      const first1 = recs.find((r) => r.viab.ledger >= 1)?.t ?? null;
      const first2 = recs.find((r) => r.viab.ledger >= 2)?.t ?? null;
      const meals = recs.filter((r) => r.ok && (r.kind === 'eat' || r.kind === 'take_shared')).length;
      rows.push({
        配置: c.配置,
        角色: a.name,
        末存续: Number(a.viab.v.toFixed(3)),
        末储能: Number(a.viab.reserve.toFixed(3)),
        掉档: a.viab.stage,
        '到第1档(t)': first1,
        '到第2档(t)': first2,
        '受损速率(档/百刻)': Number(((a.viab.stage / ticks) * 100).toFixed(2)),
        成功取食: meals,
        部件: a.viab.ledger.map((l) => l.key).join('/') || '—',
      });
    }
    void world;
  }
  return rows;
}

// O2 恢复动力学·机械侧：不含行为，只让账本自己走。回答的是"机制上能不能恢复、上限在哪里"，
// 不是"角色实际有没有恢复"——后者由 recoveryProfile 从真实轨迹量。⑥ 在这里是关着的（damage:false），
// 因为要隔离的是收支结构本身；部件侵蚀对恢复的影响在观察侧与 §31 的表里。
export function recoveryMechanics({ ticks = 600 } = {}) {
  const P = PARAMS.viab;
  const organ = () => ({ rows: [], availability: () => 1, erode: () => ({ before: 1, after: 1 }), closeness: () => 1 });
  const run = (v0, r0, feed, work = 0, n = ticks) => {
    const s = new SelfMaintain({ organs: { habit: organ(), memory: organ(), social: organ() }, agent: { counters: { actions: 1, habit: 0 } }, damage: false, v: v0 });
    s.reserve = r0;
    const series = [{ t: 0, v: s.v, reserve: s.reserve }];
    for (let t = 1; t <= n; t++) {
      s.tick(1);
      if (work) s.spend(work); // 每刻做一个普通动作的代谢：costScale 0.01 × cost 0.06 = 0.0006/刻
      if (feed && t % feed.every === 0) s.regen(feed.amount);
      series.push({ t, v: s.v, reserve: s.reserve });
    }
    return series;
  };
  // 储能抽干为止能爬到的位置：每刻净升 refill−upkeep，而抽出的量里只有 (1−upkeep/refill) 留在 v 上
  const cap = (v0, r0) => v0 + (1 - P.upkeep / P.refill) * r0;
  const CASES = [
    { 场景: '储能救济（垮后有一整仓，此后不吃）', 起始: '0.20 + 储能满', v0: 0.2, r0: P.reserveMax, feed: null },
    { 场景: '只靠吃饭·不干活（每 50 刻一顿）', 起始: '0.20 + 储能空', v0: 0.2, r0: 0, feed: { every: 50, amount: 0.5 } },
    { 场景: '只靠吃饭·每刻一个普通动作', 起始: '0.20 + 储能空', v0: 0.2, r0: 0, feed: { every: 50, amount: 0.5 }, work: 0.06 },
    { 场景: '高位断供（满存续满储能，此后不吃）', 起始: '1.00 + 储能满', v0: 1, r0: P.reserveMax, feed: null },
    { 场景: '彻底断供（v=0.20 且无储能）', 起始: '0.20 + 储能空', v0: 0.2, r0: 0, feed: null },
  ];
  return CASES.map((c) => {
    const series = run(c.v0, c.r0, c.feed, c.work ?? 0);
    const peak = series.reduce((b, r) => (r.v > b.v ? r : b), series[0]);
    const last = series.at(-1);
    const upIdx = series.findIndex((r) => r.v >= P.crit);
    // 储能耗尽 = 第一次从"还有"变成"没有"的时刻；null 表示整个窗口都没放完（高位钉住时按 upkeep 速率慢慢漏）
    const dryIdx = series.findIndex((r, i) => i > 0 && r.reserve <= 1e-9 && series[i - 1].reserve > 1e-9);
    return {
      场景: c.场景,
      起始: c.起始,
      干预: `${c.feed ? `每 ${c.feed.every} 刻一顿 ${c.feed.amount}` : '不进食'}${c.work ? ` + 每刻动作代谢 ${c.work}` : ''}`,
      峰值v: Number(peak.v.toFixed(4)),
      峰值时刻: peak.t,
      // 解析上限只对"不再进食"的场景有意义；有进食时峰值由饭决定，套这个式子会算出比实测还低的数
      储能上限: c.feed ? '—' : Number(cap(c.v0, c.r0).toFixed(4)),
      '首次站上操作点(t)': upIdx < 0 ? null : series[upIdx].t,
      '站上后跌破(t)': upIdx < 0 ? null : series.slice(upIdx).find((r) => r.v < P.crit)?.t ?? null,
      '储能耗尽(t)': dryIdx < 0 ? null : series[dryIdx].t,
      末v: Number(last.v.toFixed(4)),
      储能时长占比: Number((series.filter((r) => r.reserve > 1e-9).length / series.length).toFixed(3)),
    };
  });
}

// O2 恢复动力学·观察侧：真实轨迹里"垮过的人后来怎么样了"。
// 回升事件、能否重回操作点、末段斜率、储能到底有没有建立起来过——四个量都是对同一条 v 序列做的。
export async function recoveryProfile({ seeds = [7, 11, 13], ticks = 1200 } = {}) {
  const CONFIGS = [
    { 配置: '常态', pantry: 6, stash: 3 },
    { 配置: '低补给', pantry: 0, stash: 0 },
    { 配置: '宽裕', pantry: 8, stash: 5 },
  ];
  const rows = [];
  for (const seed of seeds) {
    for (const c of CONFIGS) {
      const { agents } = await simulate({ seed, ticks, condition: 'C2', pantry: c.pantry, stash: c.stash, group: `恢复-${c.配置}` });
      for (const a of Object.values(agents)) {
        const series = a.trace
          .filter((r) => r.viab)
          .map((r) => ({ t: r.t, v: r.viab.v, reserve: r.viab.reserve ?? 0, ledger: r.viab.ledger, ate: Boolean(r.ok) && (r.kind === 'eat' || r.kind === 'take_shared') }));
        const st = recoveryStats(series, { crit: PARAMS.viab.crit });
        if (!st || !st.samples) continue;
        rows.push({
          seed,
          配置: c.配置,
          角色: a.name,
          末存续: Number(st.endV.toFixed(3)),
          末储能: Number(st.endReserve.toFixed(3)),
          掉档: st.drops,
          垮后回升: st.reboundAfterDrop,
          垮后最大回升: Number(st.maxReboundAfterDrop.toFixed(3)),
          重回操作点: st.crossedCritAfterDrop ? '是' : '否',
          回升伴随进食: st.ateCoupledShare === null ? '—' : Number(st.ateCoupledShare.toFixed(2)),
          进食每百刻: Number(st.mealsPer100.toFixed(2)),
          末百刻斜率: Number(st.tailSlopePer100.toFixed(4)),
          储能时长占比: Number(st.reserveShare.toFixed(3)),
        });
      }
    }
  }
  // 打平线：每刻花 upkeep + 一个普通动作的代谢（costScale×0.06），每顿补 mealYield×0.5 ⇒ 每百刻要几顿才不掉
  const breakEven = ((PARAMS.viab.upkeep + PARAMS.viab.costScale * 0.06) / (PARAMS.viab.mealYield * 0.5)) * 100;
  const dropped = rows.filter((r) => r.掉档 > 0);
  const verdict = {
    样本: rows.length,
    垮过的样本: dropped.length,
    垮后有回升: dropped.filter((r) => r.垮后回升 > 0).length,
    重回操作点: dropped.filter((r) => r.重回操作点 === '是').length,
    末段仍在跌: dropped.filter((r) => r.末百刻斜率 < 0).length,
    低于打平线: dropped.filter((r) => r.进食每百刻 < breakEven).length,
    打平线每百刻顿数: Number(breakEven.toFixed(2)),
    储能建立过的样本: rows.filter((r) => r.储能时长占比 > 0).length,
  };
  return { rows, verdict };
}

// A（O16 第一步）：把"每刻一个普通动作 cost 0.06、每顿 0.5"这两个代表值换成**实测值**。
// 每一笔都从 trace 里读实际发生的 cost 与进食量（agent.execute 记的账），不再用假设。
// 打平线 = (upkeep + costScale×每刻行动代谢) / (mealYield×平均每顿实际吃下的量)，单位顿/百刻。
export async function metabolismAudit({ seeds = [7, 11, 13], ticks = 1200 } = {}) {
  const P = PARAMS.viab;
  const CONFIGS = [
    { 配置: '常态', pantry: 6, stash: 3 },
    { 配置: '低补给', pantry: 0, stash: 0 },
    { 配置: '宽裕', pantry: 8, stash: 5 },
  ];
  const r2 = (x) => Number(x.toFixed(2));
  const r3 = (x) => Number(x.toFixed(3));
  const r4 = (x) => Number(x.toFixed(4));
  const rows = [];
  for (const seed of seeds) {
    for (const c of CONFIGS) {
      const { agents } = await simulate({ seed, ticks, condition: 'C2', pantry: c.pantry, stash: c.stash, group: `代谢-${c.配置}` });
      for (const a of Object.values(agents)) {
        const recs = a.trace.filter((r) => r.viab);
        if (recs.length < 2) continue;
        const span = ticks; // 审计整个模拟窗口，即使最后一刻没有执行动作
        const aged = a.viab.age; // 账本自己老化了多少刻：反射提前 return 的那些刻没走 viab.tick()，基础代谢免付
        const sumCost = recs.reduce((s, r) => s + (r.viab.cost ?? 0), 0);
        // regen 自己有一道 mealMin 闸门（"歇一会儿"不算吃到东西），所以只有 ≥mealMin 的口才进收支
        const credited = recs.filter((r) => (r.viab.ate ?? 0) >= P.mealMin);
        const rejected = recs.filter((r) => (r.viab.ate ?? 0) > 0 && r.viab.ate < P.mealMin);
        const sumAmount = credited.reduce((s, r) => s + r.viab.ate, 0);
        const perMeal = credited.length ? sumAmount / credited.length : 0;
        // 名义量（动作表的价、口的大小）与实付/实收分开记：两个账户都满时这一口会被丢掉，v 归零时这一笔付不满
        const nominalIn = P.mealYield * sumAmount;
        const nominalOut = P.costScale * sumCost;
        const income = recs.reduce((s, r) => s + (r.viab.fed ?? 0), 0);
        const actionPaid = recs.reduce((s, r) => s + (r.viab.paid ?? 0), 0);
        const nominalUpkeep = P.upkeep * aged;
        const actualUpkeep = a.viab.upkeepPaid;
        const outflow = actualUpkeep + actionPaid;
        const eEnd = a.viab.v + a.viab.reserve; // 用模拟终点的真实余额，不假设末 tick 一定产生行动
        rows.push({
          seed,
          配置: c.配置,
          角色: a.name,
          越轨次数: a.counters.normbreak ?? 0,
          动作数: recs.length,
          平均每次cost: r3(sumCost / recs.length),
          账本老化刻数: r3(aged),
          反射免付刻数: r3(span - aged),
          每刻总支出: r4(outflow / aged),
          进食次数: credited.length,
          小口被拒: rejected.length,
          平均每顿量: r3(perMeal),
          实测顿每百刻: r2((credited.length / span) * 100),
          实收到账: r3(income),
          顶满丢弃: r3(nominalIn - income),
          归零少付: r3(nominalOut - actionPaid),
          基础代谢实付: r3(actualUpkeep),
          基础代谢少付: r3(nominalUpkeep - actualUpkeep),
          支出: r3(outflow),
          收支差: r3(income - outflow),
          // crit=0.6 是"风险开始起作用"的操作点。若这个角色大部分时间都在 0.6 以下，⑤ 就不是"状态通道"而是常开偏置
          风险开启时长占比: r2(recs.filter((x) => (x.viab.risk ?? 0) > 0).length / recs.length),
          归零时长占比: r2(recs.filter((x) => x.viab.v <= 0.001).length / recs.length),
          // 总收入与动作、基础代谢实付全部记账；残差仅含 trace 数值舍入。
          账面残差: r3(eEnd - 1 - (income - outflow)),
          打平需顿每百刻: perMeal ? r2(((P.upkeep + actionPaid / aged) / (P.mealYield * perMeal)) * 100) : null,
        });
      }
    }
  }
  const mean = (k) => r3(rows.reduce((s, r) => s + (r[k] ?? 0), 0) / rows.length);
  const summary = { 样本: rows.length, 平均每次cost: mean('平均每次cost'), 每刻总支出: mean('每刻总支出'), 进食次数: mean('进食次数'), 小口被拒: mean('小口被拒'), 平均每顿量: mean('平均每顿量'), 实测顿每百刻: mean('实测顿每百刻'), 打平需顿每百刻: mean('打平需顿每百刻'), 收支差: mean('收支差'), 账面残差: mean('账面残差') };
  return { rows, summary };
}

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > -1 ? process.argv[i + 1] : d;
};
const has = (k) => process.argv.includes(`--${k}`);

const ap0 = (v) => (typeof v === 'number' ? v.toFixed(2) : String(v));

if (process.argv[1]?.endsWith('run.mjs')) {
  const seed = Number(arg('seed', 7));
  const ticks = Number(arg('ticks', 400));
  const cond = arg('cond', 'C2');
  if (has('report') || has('sweep') || has('p3') || !process.argv.slice(2).length) console.log('注意：旧 P3 覆盖使用终局位置与事后需求，且是样本内标签择优，仅供历史对照，不能当作留出预测率；新测量运行 node life/o18-heldout.mjs。');
  if (has('report') || !process.argv.slice(2).length) {
    console.log(`\n== 消融矩阵 seed=${seed} ticks=${ticks} ==`);
    console.table(await ablation({ seed, ticks }));
  }
  if (has('trace')) {
    const { agents } = await simulate({ seed, ticks, condition: cond });
    const a = Object.values(agents)[0];
    const n = Number(arg('trace', 25)) || 25;
    for (const r of a.trace.slice(0, n)) {
      if (r.layer === 'discovery') {
        console.log(`t${r.t} ${r.name} 发现自己门口少了 ${r.lost} 份 ⇒ 评价后 m={ar:${r.m.arousal.toFixed(2)},in:${r.m.inhibit.toFixed(2)}}`);
        continue;
      }
      if (r.layer === 'rejected') {
        console.log(`t${r.t} ${r.name} 被驳回 ${r.from}→${r.to} [${r.code}] ${r.why}`);
        continue;
      }
      if (!r.action) continue;
      const ap = r.appraisal ? ` 评价[相关${ap0(r.appraisal.relevance)} 意外${ap0(r.appraisal.unexpectedness)} 可控${ap0(r.appraisal.controllability)} 规范${ap0(r.appraisal.norm)}]` : '';
      console.log(`t${r.t} ${r.name} [${r.layer}] ${r.action}${r.target ? '→' + r.target : ''} m={ar:${r.m.arousal.toFixed(2)},ap:${r.m.approach.toFixed(2)},in:${r.m.inhibit.toFixed(2)},qu:${r.m.quiescence.toFixed(2)}}${ap} → ${r.obs}`);
    }
    console.log(`\n计数 ${JSON.stringify(a.counters)}`);
    console.log(`关系 ${JSON.stringify(a.relations.dump(ticks))}`);
    console.log(`习惯表 ${JSON.stringify(a.habit.dump())}`);
  }
  if (has('p1')) console.table([(await p1({ seed, ticks, condition: cond }))]);
  if (has('viab')) {
    const rows = await viabilityProfile({ seed, ticks: Number(arg('viab', 1200)) || 1200 });
    console.table(rows);
    const by = (cfg) => rows.filter((r) => r.配置 === cfg);
    const t1 = (cfg) => {
      const v = by(cfg).map((r) => r['到第1档(t)']).filter((x) => x !== null);
      return v.length ? Math.min(...v) : null;
    };
    console.log(`到第一档最早时刻：常态 ${t1('常态 · ⑤⑥全开')} · 饥馑 ${t1('饥馑 · ⑤⑥全开')} · 宽裕 ${t1('宽裕 · ⑤⑥全开')}`);
  }
  if (has('metab')) {
    const { rows, summary } = await metabolismAudit({ ticks: Number(arg('metab', 1200)) || 1200 });
    console.log('== 代谢与进食的实测账（seed 7/11/13 × 常态/低补给/宽裕，1200 刻）==');
    console.table(rows);
    console.log('汇总', JSON.stringify(summary));
  }
  if (has('recover')) {
    const rt = Number(arg('recover', 1200)) || 1200;
    console.log('== 恢复动力学·机械侧（纯账本，不含行为；600 刻）==');
    console.table(recoveryMechanics());
    console.log(`== 恢复动力学·观察侧（真实轨迹，seed 7/11/13 × 常态/低补给/宽裕，${rt} 刻）==`);
    const { rows, verdict } = await recoveryProfile({ ticks: rt });
    console.table(rows);
    console.log('判定', JSON.stringify(verdict));
  }
  if (has('sweep')) {
    const raw = arg('sweep', '');
    const list = typeof raw === 'string' && raw ? raw.split(',').map(Number).filter(Number.isFinite) : [];
    const r = await sweep({ seeds: list.length ? list : undefined, ticks });
    console.log(`== 多 seed 扫描 ticks=${ticks} 实际跑到 ${r.seeds.length} 档：${r.seeds.join(',')} ==`);
    console.table(r.rows);
    console.log('汇总', JSON.stringify(r.mean));
  }
  if (has('p2')) console.table(await p2({ seed, ticks, condition: cond }));
  if (has('p3')) {
    const r = await p3({ seed, ticks, condition: cond });
    for (const [k, v] of Object.entries(r)) console.log(`${k}: 覆盖 ${(v.coverage * 100).toFixed(1)}% 规则数 ${v.rules.length}\n  ${v.rules.join('\n  ')}`);
  }
}
