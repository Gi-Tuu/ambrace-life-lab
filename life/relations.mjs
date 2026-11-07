// 关系层：社交需求从此有了对象。
// 之前 social 是个无主标量（“陪一下就行”），所以 §11 的 M4「关系进入 drive」是空的。
export class Relations {
  constructor(self) {
    this.self = self;
    this.map = new Map();
    this.ceiling = 100; // L13 的可侵蚀量：一段关系最多能攒到多少信任（上限掉了就是掉了）
  }

  // 完整度读数 0~1（信任上限还剩多少），以及" closeness "：它实际维护着多少关系
  availability() {
    return Number((this.ceiling / 100).toFixed(4));
  }

  closeness() {
    const v = [...this.map.values()];
    if (!v.length) return 0;
    return Number((v.reduce((s, r) => s + r.familiarity, 0) / v.length).toFixed(4));
  }

  // 不可逆：削的是上限，不是当前值——所以就算后来重修关系也回不到从前的刻度
  erode(k) {
    const before = { ceiling: Math.round(this.ceiling), available: this.availability() };
    this.ceiling = Math.max(10, this.ceiling * k);
    for (const r of this.map.values()) r.trust = Math.min(r.trust, this.ceiling);
    return { before, after: { ceiling: Math.round(this.ceiling), available: this.availability() } };
  }

  get(otherId) {
    if (!this.map.has(otherId)) this.map.set(otherId, { familiarity: 0, trust: 30, debt: 0, lastAt: -999 });
    return this.map.get(otherId);
  }

  // 重复经历提升熟悉度；熟悉度决定同样一次对话值多少社交满足
  meet(otherId, t, { delta = {}, why = '' } = {}) {
    const r = this.get(otherId);
    if (delta.familiarity) r.familiarity = Math.min(1, r.familiarity + delta.familiarity);
    if (delta.trust) r.trust = Math.max(0, Math.min(this.ceiling, r.trust + delta.trust));
    if (delta.debt) r.debt = Math.max(0, Math.min(100, r.debt + delta.debt));
    r.lastAt = t;
    return { otherId, ...r, why };
  }

  freshness(otherId, t) {
    return Math.exp(-(t - this.get(otherId).lastAt) / 100);
  }

  bestKnown(ids, t) {
    let b = null;
    for (const id of ids) {
      if (id === this.self) continue;
      const r = this.get(id);
      const s = 0.6 * r.familiarity + 0.4 * r.trust / 100;
      if (!b || s > b.s) b = { id, s, r };
    }
    return b;
  }

  dump(t) {
    return Object.fromEntries([...this.map].map(([k, v]) => [k, { fam: Number(v.familiarity.toFixed(2)), trust: Math.round(v.trust), debt: Math.round(v.debt), fresh: Number(this.freshness(k, t).toFixed(2)) }]));
  }
}
