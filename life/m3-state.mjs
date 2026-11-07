// M3 候选：四种功能状态竞争，且承诺期只按调用 step 的非反射决策机会计数。
// 不调用随机数；状态的实际行动影响由调用方显式接入 scoreAll。
export const BEHAVIOR_STATES = Object.freeze(['recover', 'connect', 'explore', 'guard']);
const unit = x => Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0));
const squash = x => Math.max(0, x) / (1 + Math.max(0, x));

export class BehaviorState {
  constructor() { this.state = null; this.remaining = 0; }

  step({ drives, bank, risk = 0, commitment = 1 }) {
    if (!Number.isInteger(commitment) || commitment < 1) throw new RangeError('承诺期必须为正整数');
    const errs = Object.fromEntries(drives.errors(risk).map(x => [x.name, x]));
    const urgency = name => squash(errs[name]?.urgency ?? 0);
    const m = bank.m;
    const signals = {
      recover: urgency('energy') + .25 * unit(risk),
      connect: urgency('social') + .15 * unit(m.approach),
      explore: urgency('stimulation') * (errs.stimulation?.dir ?? 1) + .2 * unit(m.quiescence),
      guard: .35 * unit(m.inhibit) + .25 * unit(m.arousal) + .15 * unit(risk),
    };
    const previous = this.state;
    if (this.state === null || this.remaining === 0) {
      // 平分时采用固定顺序，防止排序随机数干扰关断等价性。
      this.state = BEHAVIOR_STATES.reduce((best, name) => signals[name] > signals[best] ? name : best);
      this.remaining = commitment - 1;
    } else {
      this.remaining -= 1;
    }
    return { state: this.state, remaining: this.remaining, transitioned: previous !== this.state, signals };
  }

  // 根据当前状态改变动作间比较，不直接改需求、内部状态或记忆。
  bonus(action, weight = 0.08) {
    if (!Number.isFinite(weight) || weight < 0) throw new RangeError('状态权重必须非负');
    if (!this.state) return 0;
    const s = action.serves ?? {};
    const affinity = this.state === 'recover' ? unit(s.energy)
      : this.state === 'connect' ? unit(s.social)
      : this.state === 'explore' ? unit(s.stimulation)
      : 1 - unit(action.impulse);
    return weight * affinity;
  }

  dump() { return { state: this.state, remaining: this.remaining }; }
  load(data) {
    // 旧存档无字段时安全初始化；不接收未知状态及负数承诺。
    this.state = BEHAVIOR_STATES.includes(data?.state) ? data.state : null;
    this.remaining = this.state && Number.isSafeInteger(data?.remaining) && data.remaining >= 0 ? data.remaining : 0;
  }
}
