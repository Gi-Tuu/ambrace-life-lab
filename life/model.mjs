// L7/L8：行为选择与「高级认知」替身。
// 离线跑的是确定性替身（不联网），它的作用是证明四个通道被接上且能切断；
// 真模型的 P1 要用 remote 模式重跑，见文件末尾。
import { hill } from './modulators.mjs';
import { actionId } from './rules.mjs';
import { PARAMS } from './params.mjs';

export const CONDITIONS = ['C0', 'C1', 'C2', 'C2-neg'];

// §24：全开/全关测到的只是四个通道的**净效应**，通道之间方向会互相抵消（离线③压过①，
// 活模型实验里温度被我固定成 0.85 等于人为摘掉③，符号就翻了）。所以拆成独立开关。
// mask 形如 { temp: 0 } 表示「在 condition 的基础上再关掉③」。
export const CHANNEL_NAMES = { vis: '①可见性', util: '②效用', temp: '③采样', mem: '④检索', viab: '⑤存续风险', erosion: '⑥自我侵蚀', reflect: '⑦反思回合', ask: '⑧事件门控', gossip: '⑨告知通道', expectedYield: '⑩预期份量' };

// viab / erosion 是 L13 的两个**独立**开关（V2 §6「独立开关」的要求）：
//   ⑤ viab    = 存续风险进不进需求紧迫度（进比较才叫承重）
//   ⑥ erosion = 跌破阈值时是否真的永久削部件
// 上一版把两者捆在一起，结果"关掉⑤做负向对照"时部件照旧被削（kCap 6→3 本身就会改行为），
// 对照组并不干净——和 §19 那次「对照组仍在用电流」是同一类错误。
// reflect / ask / gossip 是 S2、S3 加的**过程开关**（不是状态通道）：默认对所有 condition 都开，可单独关掉做消融。
// ⑨ gossip 关掉时，"被告知秘密"不注入评价、不改信任——S3 的负向对照要求：
// 关掉告知通道后，"传过话"的运行必须与"根本没传话"逐动作相同，否则切断是嘴上说的。
// 分开登记的理由与 §24 相同：捆在一起就回答不了"变化到底是哪一条带来的"。
export function channelsFor(condition, mask) {
  const proc = { reflect: 1, ask: 1, gossip: 1 };
  const on = condition === 'C2' ? { ...proc, vis: 1, util: 1, temp: 1, mem: 1, band: 1, viab: 1, erosion: 1, forwardModel: 1, forwardLearn: 1, precision: 1, expectedYield: 1, m3: 0, coupling: 0, eventFirst: 0, cfUsage: 0, plasticGate: 0, lpExplore: 0 } : { ...proc, vis: 0, util: 0, temp: 0, mem: 0, band: 0, viab: 0, erosion: 0, forwardModel: 0, forwardLearn: 0, precision: 0, expectedYield: 0, m3: 0, coupling: 0, eventFirst: 0, cfUsage: 0, plasticGate: 0, lpExplore: 0 };
  return mask ? { ...on, ...mask } : on;
}

// ②的语言化：把效用景观映射成三档倾向带，给活模型用。
// 关键设计：档位按「与最优值的差距」划，不按名次划 ⇒ 并列是常态，模型抄不出唯一 argmax；
// 而差距本身由 m 决定 ⇒ 状态变化会改变谁落在哪一档。数值一律不外泄。
export const BANDS = { more: '更想做', mid: '一般', less: '不太想做', none: '同档' };

export function preferenceBands(scored, ch) {
  if (!scored.length) return {};
  if (!ch?.band) return Object.fromEntries(scored.map((s) => [s.id, BANDS.none]));
  const max = scored[0].u;
  const min = scored[scored.length - 1].u;
  const spread = Math.max(0.0001, max - min);
  const delta = Math.max(0.08, spread * 0.28); // 下限保证：景观很平时全部并列，绝不退化成唯一第一名
  const out = {};
  for (const s of scored) out[s.id] = s.u >= max - delta ? BANDS.more : s.u >= max - 2 * delta ? BANDS.mid : BANDS.less;
  return out;
}

// 每个通道只看自己那份视图：开着才用实时 m，关着退回基线 ⇒ 偏差恒为 0，切断是结构性的
const mview = (bank, traits, on) => (on ? bank.m : { ...traits.baseline });

// 通道①：候选集可见性。阈值 0.15 保证钳制时是确定性封锁而不是闪烁。
export function visibleActions(affs, traits, ch, bank, precision = null) {
  const eff = mview(bank, traits, ch.vis);
  const dev = (d) => (eff[d] - traits.baseline[d]) * (precision?.[d] ?? 1);
  const excess = dev('inhibit') * traits.gain.inhibit + dev('arousal') * traits.gain.arousal;
  return affs.filter((a) => !(a.impulse >= 0.8 && excess > 0.15));
}

// 通道②：调制量进入效用；通道④：记忆加成（按 kind 加，路径共享）
// risk：L13 存续风险。由调用方按 ch.viab 决定传不传（通道关着传 0），切断是结构性的而非判断性的
export function scoreAll(actions, { drives, traits, bank, ch, memBonus, risk = 0, exploreGate = 0, exploreIds = null }) {
  const eff = mview(bank, traits, ch.util);
  const out = [];
  for (const act of actions) {
    // 存续贡献必须**单独立项**：它藏在需求项里就永远看不见（§27 的教训——归因不暴露就等于没承重）。
    // bd 是不含放大的基线，withV 是含放大的实际值，两者之差才是"存续这一次改了多少"。
    const bd = drives.breakdown(act, 0);
    const base = Object.values(bd).reduce((a, b) => a + b, 0);
    const withV = risk > 0 ? drives.breakdown(act, risk) : bd;
    const viabDelta = risk > 0 ? Number((Object.values(withV).reduce((a, b) => a + b, 0) - base).toFixed(4)) : 0;
    // 预期份量替换原有 energy 分量而非再加一份完整需求收益。
    // 只比较行动后可进入 [0,1] 的需求增量；不预支存续收益、不预测成功率。
    // 关开关或无已知份量时精确退回原评分。基准 .45 是旧系数对应的份量。
    let expectedDelta = 0;
    const currentEnergy = drives.v?.energy;
    if (ch.expectedYield && act.kind === 'take_shared' && Number.isFinite(act.expectedPortion) && Number.isFinite(currentEnergy)) {
      const capacity = Math.max(0, 1 - Math.max(0, Math.min(1, currentEnergy)));
      const usable = Math.min(capacity, Math.max(0, act.expectedPortion));
      const coefficient = (act.serves?.energy ?? 0) * usable / PARAMS.risky.referencePortion;
      const alternative = { ...act, serves: { ...act.serves, energy: coefficient } };
      const alt = drives.breakdown(alternative, risk);
      expectedDelta = (alt.energy ?? 0) - (withV.energy ?? 0);
    }
    let u = base + viabDelta + expectedDelta;
    let discriminatingMod = 0;
    // R3：这一项对所有动作相同、改不了名次，旧版把它加进 u 却**不进 parts** ⇒
    // parts.total 与 Σ已命名分量不闭合（实测 99.0% 的行不等，缺口均值 0.057、最大 0.398，
    // 占 total 的 26%，比所有已命名修饰项都大）。现在显式记成 `常数偏移` 让账目闭合，
    // 但它**不参与 driver**——driver 回答的是"哪个可归因通道主导"，常数对所有动作一样，不是通道。
    let utilConst = 0;
    if (ch.util) {
      utilConst = 0.4 * (hill(bank.x('approach')) * traits.gain.approach - hill(bank.x('inhibit')) * traits.gain.inhibit * traits.inhibitW);
      u += utilConst;
      discriminatingMod = 0.2 * hill(bank.x('arousal')) * act.impulse * traits.gain.arousal;
      // 语义是 optimal arousal：比平时更警觉 ⇒ 偏冒险；比平时更迟钝 ⇒ 偏守着不动
      discriminatingMod += 0.25 * hill(bank.x('arousal')) * (act.impulse - 0.3) * traits.gain.arousal;
      u += discriminatingMod;
    }
    const mem = ch.mem && memBonus?.[act.kind] ? memBonus[act.kind] : 0;
    u += mem;
    const inhibitPen = -Math.pow(act.impulse, 2) * Math.max(0, eff.inhibit - 0.3) * 0.7;
    u += inhibitPen;
    const effortPen = -PARAMS.effortWeight * act.cost; // 努力折扣显式化：可调、可关（§27 成本支配 78.5% 的修法）
    u += effortPen;
    // O10 日程项单独立项归因：藏在需求项里就看不见（§27 同一条教训）
    const schedBonus = act.schedBonus ?? 0;
    u += schedBonus;
    // M6-L（§25.6）：learning progress 重分配探索预算。只加给探索类动作（look_out / 还算新的 move_to），
    // 份额 = 在线相对进度 g × weight；单独立项 `探索`。关开关时 exploreGate=0 ⇒ 精确退回原评分。
    const exploreBonus = exploreIds && exploreIds.has(act.id) ? exploreGate * PARAMS.lp.weight : 0;
    u += exploreBonus;
    const cand = { ...bd, 常数偏移: Number(utilConst.toFixed(4)), 调制: Number(discriminatingMod.toFixed(4)), 记忆: Number(mem.toFixed(4)), 自制压制: Number(inhibitPen.toFixed(4)), 努力折扣: Number(effortPen.toFixed(4)) };
    if (schedBonus) cand.日程 = Number(schedBonus.toFixed(4));
    if (exploreBonus) cand.探索 = Number(exploreBonus.toFixed(4));
    if (expectedDelta) cand.预期份量 = Number(expectedDelta.toFixed(4));
    if (viabDelta) cand.存续风险 = Number(viabDelta.toFixed(4)); // 风险为 0 时不挂这个标签，免得归因表里出现恒零的假来源
    // R3：driver 只在**可归因**通道里取 argmax（排除常数偏移与总数），否则它会恒等于"常数偏移"
    const driver = Object.entries(cand).filter(([k]) => k !== '常数偏移').sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))[0]?.[0] ?? 'none';
    out.push({
      id: actionId(act),
      kind: act.kind,
      act,
      u,
      driver,
      parts: { ...Object.fromEntries(Object.entries(cand).map(([k, v]) => [k, Number(v.toFixed(3))])), total: Number(u.toFixed(3)) },
    });
  }
  return out.sort((a, b) => b.u - a.u);
}

// 通道③：采样增益。这条在替身上是**抽样放大器**（替身没有语言理解，温度变就直接改分布），
// 不能和「模型被内部状态说服」混为一谈。
export function temperatureOf(traits, ch, bank) {
  const eff = mview(bank, traits, ch.temp);
  const i = ch.temp ? Math.max(0, eff.inhibit - traits.baseline.inhibit) : 0;
  return Math.max(0.05, 0.06 + 0.3 * eff.arousal * traits.gain.arousal - 0.35 * i);
}

export function softmaxPick(rng, scored, temp) {
  const max = Math.max(...scored.map((s) => s.u));
  const w = scored.map((s) => Math.exp((s.u - max) / temp));
  const z = w.reduce((a, b) => a + b, 0);
  let r = rng() * z;
  for (let i = 0; i < scored.length; i++) {
    r -= w[i];
    if (r <= 0) return { picked: scored[i], probs: scored.map((s, j) => ({ kind: s.kind, p: Number((w[j] / z).toFixed(4)) })) };
  }
  return { picked: scored[0], probs: [] };
}

// 习惯层（L7 的中层）：程序记忆按**路径 id** 查表，命中则不进审议
export function makeHabit() {
  const table = new Map();
  // plasticity 是 L13 的可侵蚀量之一：存续危机不直接改行为参数，而是把"还能不能学新习惯"这件事永久削掉。
  // 它是**学习率**，不是行为增益——所以削它不会像常数偏移那样不进比较：它改变的是后续所有决策的分布。
  let plasticity = 1;
  return {
    get plasticity() {
      return plasticity;
    },
    observe(id, gain, gate = 1) {
      const cur = table.get(id) ?? { ema: 0, n: 0 };
      // M6-P（PLAN §25.2）：gate 是精度门控（最不可靠通道的相对精度），缺省 1 ⇒ 不传时逐位不变。
      // 它只缩放学习率，不进效用——π 进效用就又是常数偏移那类错误。
      const lr = 0.3 * plasticity * gate;
      cur.ema = cur.n === 0 ? gain : cur.ema * (1 - lr) + gain * lr;
      cur.n += 1;
      table.set(id, cur);
    },
    best() {
      let b = null;
      for (const [id, v] of table) if (v.n >= 3 && (!b || v.ema > b.ema)) b = { id, ema: v.ema, n: v.n };
      return b;
    },
    // M6-L（§25.6）：只读计数，给"还算新"的动作判定用；不改任何状态。
    count(id) {
      return table.get(id)?.n ?? 0;
    },
    // 不可逆：只削学习率与已固化的强度，任何恢复存续的路径都不许把它调回来
    erode(k) {
      const before = { plasticity: Number(plasticity.toFixed(3)), strength: this.strength() };
      plasticity = Math.max(0.05, plasticity * k);
      for (const v of table.values()) v.ema *= k;
      return { before, after: { plasticity: Number(plasticity.toFixed(3)), strength: this.strength() } };
    },
    strength() {
      let s = 0;
      for (const v of table.values()) s += Math.abs(v.ema);
      return Number(s.toFixed(4));
    },
    // L13 用的"完整度"读数：0~1，就是学习率本身（部件还剩多少能力，不是它干过多少活）
    availability: () => Number(plasticity.toFixed(4)),
    dump: () => ({ plasticity: Number(plasticity.toFixed(3)), rows: Object.fromEntries([...table].map(([k, v]) => [k, { ema: Number(v.ema.toFixed(3)), n: v.n }])) }),
    load(d) {
      if (!d) return;
      // 旧存档直接把行表当整个 dump 存（还没有 plasticity 的时代），认得出来就不丢习惯
      const rows = d.rows ?? (Number.isFinite(d.plasticity) ? null : d);
      plasticity = Number.isFinite(d.plasticity) ? d.plasticity : 1;
      table.clear();
      for (const [k, v] of Object.entries(rows ?? {})) table.set(k, { ema: v.ema, n: v.n });
    },
  };
}

// 真模型传输不在这个文件里：见 loop-real.mjs。
// 这里原先有 buildPrompt（把效用数字写进提示词）与 makeRemote，二者已删——
// §17 的教训是「给了 u 模型就退化成 argmax 复读机」，所以要让泄漏在结构上不可能，而不是靠自觉。
