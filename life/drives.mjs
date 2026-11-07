// L4 内稳态需求：偏差 → drive → 目标。误差方向不可逆性参与紧迫度。
// 修订①：新增 stimulation（唤醒最优值），把调制维 arousal 当被调量。原实现「低警觉⇒罚高冲动」方向反了，
//         实测得到吸收不动点（rest → 警觉塌零 → 更不敢动）。按 optimal arousal 理论纠正。
// 修订②（本轮）：社交 setpoint 与衰减速率由人格供给 ⇒ 同处一室，孤僻者不觉得缺，冲动者很快缺。
import { PARAMS } from './params.mjs';

export const BASE_SETPOINT = { energy: 0.55, social: 0.42, stimulation: 0.5 };

export const NEED_META = {
  energy: { floor: 0.18, decay: 0.012, label: '能量', sided: 'below', viabilityLinked: 1 },
  social: { floor: 0.12, decay: 0.008, label: '社交', sided: 'below' },
  stimulation: { floor: 0.05, decay: 0, label: '刺激', sided: 'both' },
};

// 每种动作对各需求的贡献系数（负值=该动作会恶化这个需求）
const MAP = {
  eat: { energy: 1, stimulation: -0.15 },
  talk: { social: 1, stimulation: 0.6 },
  rest: { energy: 0.15, stimulation: -0.35 },
  wander: { social: 0.1, stimulation: 0.5 },
  look_out: { social: 0.35, stimulation: 1 },
};

export class Drives {
  constructor(rng, traits = null) {
    this.traits = traits;
    this.setpoint = { ...BASE_SETPOINT, social: traits?.social_setpoint ?? BASE_SETPOINT.social };
    this.v = { energy: 0.7, social: Math.min(0.6, this.setpoint.social + 0.18), stimulation: 0.5 };
    this.aloneTicks = 0;
    this.rng = rng;
  }

  regulate(m) {
    this.v.stimulation = m.arousal;
  }

  tick(dt = 1, hadContact) {
    this.v.energy = Math.max(0, this.v.energy - NEED_META.energy.decay * dt);
    this.aloneTicks = hadContact ? 0 : this.aloneTicks + dt;
    const extra = this.aloneTicks > 60 ? 0.002 * (this.aloneTicks - 60) : 0;
    const comfort = this.traits ? 1.3 - this.traits.comfortAlone : 1; // 孤僻 ⇒ 衰减慢
    this.v.social = Math.max(0, this.v.social - (NEED_META.social.decay * comfort + extra) * dt);
  }

  reward(name, amount) {
    if (!(name in this.v) || name === 'stimulation') return;
    this.v[name] = Math.max(0, Math.min(1, this.v[name] + amount));
  }

  // 存续风险走**两条**路，缺一不可（§30 实测出来的）：
  //   ① 移动操作点：储备不足 ⇒ "吃饱"的标准本身被抬高（viabilityLinked 的需求才动）。
  //      只放大增益是不够的：能量饱和时误差 = 0，而 0 乘任何系数还是 0 ⇒ 存续下滑发不出任何需求，
  //      个体一路掉到归零也不去多吃一口——那测到的是开环，不是自我维持。
  //   ② 放大增益：亏空已经存在时，同样的误差更紧迫。
  // 两条都只作用于亏空型需求，所以会进入动作之间的**比较**（§26 的常数偏移教训）。
  errors(risk = 0) {
    const amp = 1 + (risk > 0 ? PARAMS.viab.riskGain * risk : 0);
    return Object.entries(NEED_META).map(([name, n]) => {
      const v = this.v[name];
      const sp = Math.min(0.95, this.setpoint[name] + (n.viabilityLinked ? PARAMS.viab.setpointShift * risk : 0));
      const below = Math.max(0, sp - v);
      const above = n.sided === 'both' ? Math.max(0, v - sp) : 0;
      const e = name === 'stimulation' ? Math.max(below, above) : below;
      const dir = name === 'stimulation' && above > below ? -1 : 1;
      const urg = Math.pow(e, PARAMS.urgencyExponent) / (1 - Math.min(0.999, e)) + (v < n.floor ? 0.6 : 0);
      return { name, e, dir, label: n.label, setpoint: Number(sp.toFixed(3)), urgency: n.sided === 'below' ? urg * amp : urg, viabilityAmp: n.sided === 'below' ? Number(amp.toFixed(3)) : 1, floor: n.floor, risk: Number(risk.toFixed(3)), irreversible: name !== 'stimulation' && v < n.floor };
    });
  }

  // 评价层要用「当前主导目标」，所以这里必须能报出来，而不只是给一堆数
  dominant(risk = 0) {
    return this.errors(risk).reduce((a, b) => (b.urgency > a.urgency ? b : a));
  }

  // 贡献系数现在由**路径**自带（affordance.serves），MAP 只作为裸 kind 的兜底。
  // 同需求多路径的意义就在这里：走到有人的地方和走到瞭台，满足的是不同的需求。
  utilityContribution(action, risk = 0) {
    return Object.values(this.breakdown(action, risk)).reduce((a, b) => a + b, 0);
  }

  // 行动来源归因需要「哪个需求贡献了多少」，不能只给一个和。
  // 这是 §六 要求记录的「行动来源」的最小实现：不加新机制，只把已有的分解暴露出来。
  breakdown(action, risk = 0) {
    const serves = (typeof action === 'string' ? MAP[action] : action.serves) ?? MAP[action.kind] ?? {};
    const out = {};
    for (const err of this.errors(risk)) {
      const k = serves[err.name];
      if (!k) continue;
      out[err.name] = Number((k * err.urgency * err.dir).toFixed(4));
    }
    return out;
  }

  describe() {
    return Object.fromEntries(this.errors().map((e) => [e.name, Number(e.e.toFixed(2))]));
  }
}
