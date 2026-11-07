// L11 情景记忆 + 四路检索。state_similarity 是通道④，也是最容易证明「状态承重」的一条（§6.2）。
import { DIMS } from './traits.mjs';

const ALPHA_RECENCY = 0.3;
const BETA_IMPORTANCE = 0.25;
const GAMMA_RELEVANCE = 0.3;
const DELTA_STATE = 0.5;

const stateDistance = (a, b, precision) => {
  let s = 0;
  for (const d of DIMS) s += Math.pow((a?.[d] ?? 0) - (b?.[d] ?? 0), 2) * (precision?.[d] ?? 1);
  return Math.sqrt(s / DIMS.length);
};

export class EpisodicMemory {
  constructor() {
    this.rows = [];
    this.failures = new Map();
    this.kCap = 6; // L13 的可侵蚀量：能同时想起多少件事。存着的事没被删，是**取不到**
  }

  // 完整度读数：0~1。L13 用它决定"下一个削谁"，也写进账本做 before/after
  availability() {
    return Number((this.kCap / 6).toFixed(4));
  }

  // 不可逆：只降上限，没有任何路径把它调回去
  erode(k) {
    const before = { kCap: this.kCap, available: this.availability() };
    this.kCap = Math.max(1, Math.floor(this.kCap * k));
    return { before, after: { kCap: this.kCap, available: this.availability() } };
  }

  add(t, { kind, actionKind = null, actionSucceeded = null, payload, mSnapshot, importance }) {
    this.rows.push({ id: this.rows.length, t, kind, actionKind, actionSucceeded, payload, m: mSnapshot, importance: Math.min(1, importance) });
    if (this.rows.length > 400) this.rows.shift();
  }

  // L13 要求账本与受损状态必须持久：进程重启后"已经想不起来的事"不能因为重启就回来了。
  dump() {
    return { rows: this.rows.slice(-120), kCap: this.kCap, failures: [...this.failures].filter(([, f]) => f > 0) };
  }

  load(d) {
    if (!d) return;
    this.rows = d.rows ?? [];
    this.kCap = d.kCap ?? 6;
    this.failures = new Map(d.failures ?? []);
  }

  // 遗忘：检索长期失败 → 计数上升 → 参与衰减。不是删除，是取不到。
  // 意外性的经验估计：同类事件在窗口内出现的频率。频率高 ⇒ 不意外 ⇒ 评价分量低。
  // 没有这个方法，L5 就只能是一张固定表。
  frequency(kind, t, window = 120) {
    const win = this.rows.filter((r) => t - r.t <= window);
    if (!win.length) return 0;
    const hits = win.filter((r) => r.kind === kind).length;
    return hits / win.length;
  }

  touchHit(id) {
    this.failures.set(id, 0);
  }

  score(row, m, candidates, t, precision = null) {
    const recency = Math.exp(-(t - row.t) / 120);
    const relevance = candidates.some((c) => row.actionKind != null && c.kind === row.actionKind) ? 0.9 : 0.25;
    const sim = 1 - stateDistance(row.m, m, precision);
    const fail = this.failures.get(row.id) ?? 0;
    return { total: ALPHA_RECENCY * recency + BETA_IMPORTANCE * row.importance + GAMMA_RELEVANCE * relevance + DELTA_STATE * sim - 0.02 * fail, recency, relevance, sim };
  }

  retrieve(m, candidates, t, k = 3, opts = {}) {
    const useState = opts.stateChannel !== false;
    const scored = this.rows.map((r) => {
      const s = this.score(r, m, candidates, t, opts.precision);
      if (!useState) s.total = ALPHA_RECENCY * s.recency + BETA_IMPORTANCE * r.importance + GAMMA_RELEVANCE * s.relevance;
      return { r, s };
    });
    scored.sort((a, b) => b.s.total - a.s.total);
    const top = scored.slice(0, Math.min(k, this.kCap)); // 侵蚀过的部分在这里生效：不是删记忆，是想不起来
    if (!top.length) this.rows.forEach((r) => this.failures.set(r.id, (this.failures.get(r.id) ?? 0) + 1));
    top.forEach((x) => this.touchHit(x.r.id));
    return top;
  }

  // 通道④ 的加成必须用「状态相似度的差值」，不能用检索总分。
  // 上一版用 recency+importance+relevance 的总分直接加到效用里，而 relevance 定义是
  // 「候选里有这个 kind 就给 0.9」⇒ 做得越多 ⇒ 记忆里越多 ⇒ 加分越大 ⇒ 更做。
  // 那是频率冒充相关性，实测把个体锁死在 rest（+0.5 vs 其余为负）。
  stateBonus(m, candidates, t, opts) {
    const top = this.retrieve(m, candidates, t, 6, opts);
    if (!top.length) return { bonus: {}, retrieved: [] };
    const byKind = new Map();
    for (const { r, s } of top) {
      // 外部与旧记录来源不明，失败经历仍可检索，但不能当作成功经验加分。
      const actionKind = r.actionKind;
      if (!actionKind || r.actionSucceeded !== true) continue;
      if (!candidates.some((c) => c.kind === actionKind)) continue;
      const arr = byKind.get(actionKind) ?? [];
      arr.push(opts.stateChannel === false ? 0.5 : s.sim);
      byKind.set(actionKind, arr);
    }
    const means = new Map([...byKind].map(([k, v]) => [k, v.reduce((a, b) => a + b, 0) / v.length]));
    const overall = [...means.values()].reduce((a, b) => a + b, 0) / (means.size || 1);
    const bonus = {};
    for (const [k, mu] of means) bonus[k] = Number(Math.max(0, Math.min(0.12, 0.3 * (mu - overall))).toFixed(4));
    return { bonus, retrieved: [...means].map(([k, mu]) => ({ kind: k, sim: Number(mu.toFixed(2)) })).slice(0, 3) };
  }
}
