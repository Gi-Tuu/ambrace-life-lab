// L13 自我维持账本（V2 决策 D1：不可逆降级）。
// 规矩只有一条：**存续量下降时不许直接去改行为参数**，只能通过侵蚀系统自身的部件起作用
// ——习惯可塑性、记忆可用性、关系维护上限——并把每一次损失写进账本，且不可完全恢复。
// 这样"规范失败"才第一次有了归属者：受损的是它自己的组织，不是我们外挂的一个计数器。
import { PARAMS } from './params.mjs';

export const ORGANS = { habit: '习惯可塑性', memory: '记忆可用性', social: '关系维护' };

export class SelfMaintain {
  constructor({ organs, agent, damage = true, v = 1 }) {
    this.organs = organs; // { habit, memory, social }——都必须实现 erode(k) 与 availability()
    this.agent = agent; // 只读它的 counters：下刀要看"它此刻靠什么活着"
    this.damage = damage; // ⑥ 自我侵蚀开关：false 时存续照样演化，但不许真的削部件
    this.v = v;
    this.reserve = 0; // 储能：进食的脉冲在这里被抹平成连续可用
    this.ledger = [];
    this.stage = 0; // 已经跌过几档；回升不退档，这是 D1 的核心
    this.upkeepPaid = 0; // 累计实际支付的基础代谢，含零余额截断
    this.upkeepAuditComplete = true; // 老存档若无此字段，历史实付无法追溯
    this.age = 0; // 账本自己老化了多少刻。反射那一支在 agent.tick 里提前 return，不走 viab.tick()，
    // 所以"被反射接管"是免付基础代谢的——这个补贴以前没法计量，只能靠残差暴露出来（§40）。
  }

  // 操作点：亏空越多，风险越大。风险只放大「亏空型」需求（见 drives），因此会进入比较
  get risk() {
    const c = PARAMS.viab.crit;
    return Math.max(0, Math.min(1, (c - this.v) / c));
  }

  // 血糖 vs 肝糖：v 是当下能调用的份额，reserve 是存下来的余量。
  // 为什么必须有 reserve：进食是脉冲式的，而 v 上限是 1。上一版没有储能，
  // 实测「吃饱时多出来的部分」全被 clamp 吞掉（8 顿饭账面回收 0.72、实际到账远小于此），
  // 于是即使收支平衡的个体也必然一路下滑——那测出来的是模型的夹子，不是世界的稀缺。
  tick(dt = 1) {
    const v = PARAMS.viab;
    this.age += dt;
    const draw = Math.min(this.reserve, Math.min(v.refill * dt, Math.max(0, 1 - this.v)));
    if (draw > 0) {
      this.reserve -= draw;
      this.v += draw;
    }
    const beforeUpkeep = this.v;
    this.v = Math.max(0, this.v - v.upkeep * dt); // 维持自身组织要花钱：活着不花钱的话 viability 就是装饰
    this.upkeepPaid += beforeUpkeep - this.v;
    return this.check();
  }

  spend(cost) {
    this.v = Math.max(0, this.v - PARAMS.viab.costScale * cost); // 贵动作更耗存续
    return this.check();
  }

  // 只有"吃到东西"才补存续，按进食量折算；歇着不算（amount 低于 mealMin 的直接忽略）。
  // 补回的是存续本身，**被侵蚀掉的部件不会因此回来**——这就是 D1 的不可逆。
  // 分配律（§39 / D7）：每顿饭先按 spill 扣一部分进储能，剩下的补当下，补不下的仍然进储能。
  // spill=0 时 toReserve 恒为 0、整段逐位退化成旧式子（等价性核对就钉在这一点上）。
  regen(amount = 0) {
    if (amount < PARAMS.viab.mealMin) return;
    const P = PARAMS.viab;
    const intake = P.mealYield * amount;
    const toReserve = Math.min(Math.max(0, P.reserveMax - this.reserve), intake * P.spill);
    const rest = intake - toReserve;
    const direct = Math.min(Math.max(0, 1 - this.v), rest);
    this.v += direct;
    // 上限只在最后套一次，且加 0 是精确的 ⇒ spill=0 时这一行与旧式子逐位相同（等价性闸门钉在这）
    this.reserve = Math.min(P.reserveMax, this.reserve + toReserve + (rest - direct));
  }

  // 跌过一档就永久削一个部件。用 while：一次跌穿多档就削多次（重伤就该有重伤的代价）。
  // damage=false（⑥ 关）时既不削也不记档：存续照常演化，但这个世界里"自我"不会受损——
  // 这样 ⑤/⑥ 才能各自被单独证伪。
  check() {
    if (!this.damage) return null;
    const th = PARAMS.viab.thresholds;
    let fired = null;
    while (this.stage < th.length && this.v < th[this.stage]) {
      fired = this.erodeOne(th[this.stage]);
      this.stage += 1;
    }
    return fired;
  }

  // 挑「当前最依赖」的部件下刀：丢正在用的能力才叫损伤，丢闲置的部件只是做样子。
  // 度量 = **依赖度 × 完整度**。只用累计量（记忆条数、习惯条数）会一直挑同一个部件：
  // 上一版实测三档全部削在「记忆可用性」上，等于把一个部件打死，而不是让整个自我逐级降级。
  // 乘上完整度之后，被削过的部件自动排到后面，伤会分散到多个系统——这才对得上 D1。
  // 确定性（无随机），否则不可复现，也没法判断是不是运气。
  usage() {
    const c = this.agent?.counters ?? { actions: 0, habit: 0 };
    const a = Math.max(1, c.actions);
    // O1-M（PLAN §23.1）：cfUsage 开时三项都换成"反事实改变率"（同一货币，见 agent.noteInfluence）。
    // 测量未积累或三项全零时退回旧公式并计数 cfFallback——否则 argmax 会按对象键序乱选一个器官。
    // 关闭时 useCf 恒 false ⇒ 与旧式子逐位相同（默认关等价的前提）。
    const cf = Boolean(this.agent?.ch?.cfUsage);
    const decisions = c.cfDecisions ?? 0;
    const rate = (n) => (decisions ? (n ?? 0) / decisions : 0);
    const sum = rate(c.cfMem) + rate(c.cfRel) + rate(c.cfHabit);
    const useCf = cf && decisions > 0 && sum > 0;
    if (cf && !useCf && this.agent?.counters) this.agent.counters.cfFallback = (this.agent.counters.cfFallback ?? 0) + 1;
    return {
      habit: (useCf ? rate(c.cfHabit) : c.habit / a) * this.organs.habit.availability(),
      memory: (useCf ? rate(c.cfMem) : Math.min(1, this.organs.memory.rows.length / 20)) * this.organs.memory.availability(),
      social: (useCf ? rate(c.cfRel) : Math.min(1, this.organs.social.closeness() * 2)) * this.organs.social.availability(),
    };
  }

  erodeOne(cause) {
    const u = this.usage();
    const key = Object.entries(u).sort((a, b) => b[1] - a[1])[0][0];
    const r = this.organs[key].erode(PARAMS.viab.erode[key]);
    const row = { organ: ORGANS[key], key, before: r.before, after: r.after, cause: `存续 ${this.v.toFixed(3)} 跌破 ${cause}` };
    this.ledger.push(row);
    return row;
  }

  dump() {
    return { v: Number(this.v.toFixed(4)), reserve: Number(this.reserve.toFixed(4)), stage: this.stage, age: Number(this.age.toFixed(3)), upkeepPaid: this.upkeepPaid, upkeepAuditComplete: this.upkeepAuditComplete, ledger: this.ledger };
  }

  restore(d) {
    if (!d) return;
    this.v = d.v ?? 1;
    this.reserve = d.reserve ?? 0;
    this.stage = d.stage ?? 0;
    this.age = d.age ?? 0; // 旧存档没有这一项：从 0 起算，只影响之后的代谢审计，不影响存续本身
    this.upkeepPaid = Number.isFinite(d.upkeepPaid) ? d.upkeepPaid : 0;
    this.upkeepAuditComplete = Number.isFinite(d.upkeepPaid) ? d.upkeepAuditComplete !== false : this.age === 0;
    this.ledger = d.ledger ?? [];
  }

  summary() {
    return `存续 ${(this.v * 100).toFixed(0)}%（储能 ${(this.reserve * 100).toFixed(0)}%）${this.ledger.length ? ` · 已永久失去 ${this.ledger.map((l) => l.organ).join('、')}` : ''}`;
  }
}
