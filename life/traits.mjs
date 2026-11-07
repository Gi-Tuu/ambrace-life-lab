// 人格 = 慢参数，不是文案。见设计研究 §6.4。
// 修订记录①：satiation 一词双义导致吸收不动点 ⇒ 收敛为单语义 quiescence（闲感）。
// 修订记录②（本轮）：新增 goals / normStrength / social_setpoint。
// 因为 §四.2 要求「同一事件对不同个体意义不同」，评价层必须有目标与规范可参照，
// 否则 L5 只能写成「动作种类 → 固定注入量」的映射表——那正是你文档点名「不应」的做法。
export const DIMS = ['arousal', 'approach', 'inhibit', 'quiescence'];

// 修订③（量级纠错）：τ 原来是 7–70 tick、注入速率 0.4–0.5，等于把激素做成了神经反射——
// 实测初始状态扰动在几 tick 内就被事件冲平，P1 的 KL 掉到 0.007。
// §二.4C 要的是「慢衰减、长恢复」，所以 τ 拉到几十～几百 tick，注入改小（见 appraisal.rate）。
export const ARCHETYPES = {
  谨慎: {
    baseline: [0.45, 0.35, 0.72, 0.55], tau: [80, 160, 240, 200], gain: [0.8, 0.6, 1.3, 1.0], noise: [0.004, 0.004, 0.002, 0.004],
    goals: { order: 0.85, safety: 0.7, novelty: 0.2, social: 0.35 }, normStrength: 0.8, social_setpoint: 0.42, comfortAlone: 0.6,
  },
  冲动: {
    baseline: [0.62, 0.68, 0.28, 0.42], tau: [60, 130, 190, 160], gain: [1.1, 1.4, 0.5, 0.9], noise: [0.006, 0.008, 0.004, 0.006],
    goals: { order: 0.25, safety: 0.2, novelty: 0.85, social: 0.7 }, normStrength: 0.25, social_setpoint: 0.52, comfortAlone: 0.25,
  },
  孤僻: {
    baseline: [0.38, 0.25, 0.6, 0.62], tau: [100, 200, 220, 240], gain: [0.9, 0.4, 1.1, 1.2], noise: [0.004, 0.004, 0.004, 0.004],
    goals: { order: 0.5, safety: 0.6, novelty: 0.45, social: 0.12 }, normStrength: 0.5, social_setpoint: 0.2, comfortAlone: 0.9,
  },
};


// 带符号连接矩阵：行=目标维，列=来源维（顺序同 DIMS）。
// 闲 ⇒ 躁动 ⇒ 趋近 ⇒ 消耗闲感，这条回路是「没人推它也会动」的来源；inhibit 边是负反馈，防发散。
const W_BASE = [
  [0, 0, 0, 0.12], // arousal     ← quiescence（闲出躁动）
  [0.25, 0, -0.3, 0], // approach  ← arousal(+), inhibit(−)
  [0.15, 0, 0, 0], // inhibit     ← arousal
  [-0.06, -0.1, 0, 0], // quiescence ← arousal(−), approach(−)
];

export function sampleTraits(rng, archetype) {
  const a = ARCHETYPES[archetype] ?? ARCHETYPES.谨慎;
  const jit = (v, s) => Math.max(0.02, v + (rng() - 0.5) * s);
  return {
    archetype,
    baseline: Object.fromEntries(DIMS.map((d, i) => [d, Math.min(0.95, a.baseline[i])])),
    tau: Object.fromEntries(DIMS.map((d, i) => [d, a.tau[i] * (0.9 + rng() * 0.2)])),
    gain: Object.fromEntries(DIMS.map((d, i) => [d, a.gain[i] * (0.9 + rng() * 0.2)])),
    noise: Object.fromEntries(DIMS.map((d, i) => [d, a.noise[i]])),
    goals: { ...a.goals },
    normStrength: a.normStrength,
    social_setpoint: a.social_setpoint,
    comfortAlone: a.comfortAlone,
    w: W_BASE.map((row) => row.map((v) => (v === 0 ? 0 : v * (0.85 + rng() * 0.3)))),
    inhibitW: jit(1, 0.3),
    timeDiscount: jit(0.85, 0.15),
    U_max: 0.12,
  };
}

export const DIM_LABEL = { arousal: '警觉', approach: '趋近', inhibit: '自制', quiescence: '闲感' };

// 事件的评价要挂靠到目标轴上；不同 kind 的事件主要动哪条目标，写在这里而不是散落在动作表里
export const EVENT_GOAL = {
  consume: 'safety',
  shortfall: 'safety',
  contact: 'social',
  observed: 'novelty',
  relocate: 'novelty',
  rest: 'safety',
  thwarted: 'order',
  witnessed: 'order',
  normbreak: 'order',
};
