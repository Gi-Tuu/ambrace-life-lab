// M4 耦合调制权（预登记 §16）。规矩：
//  1) 三个耦合变量只改"外部能不能进到我这里 / 别人能不能对我发起动作"，
//     不改"进来之后值多少"（那是 ①②的领地），也不做永久损伤（那是 ⑥/D1 的领地）。
//  2) 每个变量都必须有真实消费者，否则就是"改了个没人读的数"（停止条件 S2）。
//  3) 触发来源是内部状态与已发生的事件，禁止任何外部时钟（停止条件 S4）。
//  4) 全部可逆：τ 到期回初值。永久损伤一律走 ⑥，不许从这里发生。
import { PARAMS } from './params.mjs';

export const COUPLING_VARS = Object.freeze(['input', 'available', 'refuse']);
// 三条动作的 kind 名（M3 规划器按决策②(a) 把它们排除在两步搜索之外；见 PLAN §16.4）
export const COUPLING_KINDS = Object.freeze(['deafen', 'seclude', 'refuse']);
// 初值：听得进、找得到、不预设拒绝
export const COUPLING_DEFAULT = Object.freeze({ input: 1, available: 1, refuse: 0 });

// 每条动作声明它断开哪一路、断到什么程度，以及**它声称缓解多少刺激**（`relief` = 标价的刺激贡献，负值=降火）。
// deafen 用 minInput（借 ⑥ 侵蚀因子的同一量级，是"调低增益"而不是"关掉感官"）；
// seclude 直接 available=0——这才是论文意义上的"终止耦合"，也是停止条件 S3 要看的极端实例。
// relief 是唯一的缓解量表：affordance 的 `serves.stimulation` 与评价层的 arousal 目标都从这里导出，
// 这样"评分里按减刺激计价"和"执行后真的降火"不可能各写一份、各自漂移（§17.2）。
export const COUPLING_EFFECTS = Object.freeze({
  deafen: { variable: 'input', to: () => PARAMS.coupling.minInput, relief: -0.5 },
  seclude: { variable: 'available', to: () => 0, relief: -0.6 },
  refuse: { variable: 'refuse', to: () => 1, relief: -0.1 },
});

export class Coupling {
  constructor({ tau = PARAMS.coupling.tau } = {}) {
    this.tau = tau;
    this.v = { ...COUPLING_DEFAULT };
    this.hold = { input: 0, available: 0, refuse: 0 };
  }

  // 每刻：τ 到期就回到初值（P6c 验的就是这条）
  tick(dt = 1) {
    for (const k of COUPLING_VARS) {
      if (this.hold[k] > 0) {
        this.hold[k] = Math.max(0, this.hold[k] - dt);
        if (this.hold[k] === 0) this.v[k] = COUPLING_DEFAULT[k];
      }
    }
  }

  apply(kind) {
    const eff = COUPLING_EFFECTS[kind];
    if (!eff) return null;
    const key = eff.variable;
    this.v[key] = eff.to();
    this.hold[key] = this.tau;
    return { variable: key, value: this.v[key], hold: this.hold[key] };
  }

  // 消费者 ③④：别人能不能对我发起动作
  reachable() {
    return this.v.available > 0;
  }

  // 消费者 ⑤：别人来找我时，我应不应。拒绝是确定性的"下一次不应"，不靠随机数。
  refuses() {
    return this.v.refuse >= 1;
  }

  // 消费者 ①②：外部事件能进到我这里多少
  get input() {
    return this.v.input;
  }

  dump() {
    return { v: { ...this.v }, hold: { ...this.hold }, tau: this.tau };
  }

  restore(d) {
    if (!d) return;
    this.v = { ...COUPLING_DEFAULT, ...(d.v ?? {}) };
    this.hold = { input: 0, available: 0, refuse: 0, ...(d.hold ?? {}) };
    if (typeof d.tau === 'number') this.tau = d.tau;
  }
}

// 防御式读取：世界里的 agent 槽位有时只是 {id,name} 占位（单测与离线消融都这样），
// 没有 coupling 对象时必须退回"听得进、找得到"，否则旧路径会凭空变聋。
export const inputGainOf = (agent) => agent?.coupling?.input ?? 1;
export const reachableOf = (agent) => (agent?.coupling ? agent.coupling.reachable() : true);
