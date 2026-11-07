// L5 认知评价层。事件造成的状态变化必须由「当前目标 + 既有经历 + 人格」共同决定。
// 修订（关键）：注入改成**牵引式** —— 评价决定「把这条调制维往哪个目标值推、推多快」，而不是无条件加分。
// 上一版 u.arousal = k·相关性·意外性 恒为正 ⇒ 任何事件都在推高警觉、没有任何事件能降低它
// ⇒ t3 就饱和在 arousal=1/inhibit=1，stimulation 误差翻向后「能降火」的 rest 成唯一正分 ⇒ 第二个吸收态。
import { DIMS, EVENT_GOAL } from './traits.mjs';
import { COUPLING_EFFECTS } from './coupling.mjs';
import { PARAMS } from './params.mjs';

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const pull = (cur, target, rate) => target - cur; // 方向由差值给出，幅度在下面统一夹紧

// 每个事件类型自带「评价之后状态该去哪儿」，而不是「该加多少」
const TARGETS = {
  consume: { arousal: 0.35, approach: 0.6, quiescence: 0.35 },
  shortfall: { arousal: 0.85, approach: 0.25, quiescence: 0.15 },
  contact: { arousal: 0.55, approach: 0.8, quiescence: 0.2 },
  observed: { arousal: 0.7, approach: 0.75, quiescence: 0.25 },
  relocate: { arousal: 0.5, approach: 0.55, quiescence: 0.4 },
  rest: { arousal: 0.28, approach: 0.35, quiescence: 0.9 },
  thwarted: { arousal: 0.8, approach: 0.2, quiescence: 0.3 },
  witnessed: { arousal: 0.8, approach: 0.3, quiescence: 0.25 },
  normbreak: { arousal: 0.75, approach: 0.65, quiescence: 0.3 },
};

// M4-A（§17.2）：三条耦合动作的"减刺激"必须落到**评价目标**上才发得出去。
// `drives.reward()` 显式拒绝 stimulation（它是被调量，直接推会掉进 §L4 修订① 记过的吸收不动点），
// 而这三个 kind 原本不在 TARGETS 里 ⇒ 走 relocate 兜底（arousal 0.5）再被 relevance 往上加，
// 于是"降火"的动作自己把警觉拉高，过载时间占比实测不降（§45 的负结果）。
// 换算线只用引擎里已有的两个锚点，不新设常数：
//   锚① TARGETS.rest     =（`serves.stimulation` −0.35 ⇒ arousal 0.28）
//   锚② TARGETS.relocate =（move_to 的刺激标价中值 +0.25 ⇒ arousal 0.50）
// relief=0 时三条全部回落至 relocate 兜底 ⇒ §17.4 的"零缓解档"是一个参数，不用改代码。
const RELIEF_ANCHORS = { low: { s: -0.35, a: 0.28 }, high: { s: 0.25, a: 0.5 } };
const arousalTargetFromRelief = (relief) => {
  const { low, high } = RELIEF_ANCHORS;
  const linear = low.a + ((high.a - low.a) * (relief - low.s)) / (high.s - low.s);
  const blended = high.a + PARAMS.coupling.relief * (linear - high.a);
  return Math.max(0, Math.min(1, blended));
};
// 参数是活的（§17.4 要在同一进程里跑"零缓解档"），所以这里做缓存重建，而不是模块加载时定死一次
let reliefBuilt = null;
export function buildCouplingTargets() {
  if (reliefBuilt === PARAMS.coupling.relief) return TARGETS;
  reliefBuilt = PARAMS.coupling.relief;
  for (const [kind, eff] of Object.entries(COUPLING_EFFECTS)) {
    TARGETS[kind] = { ...TARGETS.relocate, arousal: Number(arousalTargetFromRelief(eff.relief).toFixed(6)) };
  }
  return TARGETS;
}

export function appraise(evt, ctx) {
  buildCouplingTargets();
  const { traits, drives, memory, relations, t, m } = ctx;

  // ① 目标相关性：事件挂在哪条目标轴上 × 该个体在这条轴上的目标强度 × 当前主导需求误差
  const axis = EVENT_GOAL[evt.kind] ?? 'safety';
  const goalW = traits.goals[axis] ?? 0.3;
  const dom = drives.dominant();
  const serves = evt.serves && dom.name === evt.serves ? dom.e : 0;
  const relevance = clamp01(Math.abs(evt.valence) * (0.35 + goalW) + 0.5 * serves);

  // ② 意外性：由既有经历估计（同类事件在窗口内的频率）
  const expected = memory && memory.rows.length ? memory.frequency(evt.kind, t, 120) : 0;
  const unexpectedness = 1 - expected;

  // ③ 可控性 / 自我归因
  const controllability = evt.selfCaused ? 1 : 0.35;

  // ④ 规范性评价
  const normHit = evt.violates ? traits.normStrength : 0;

  const rel = evt.about && relations ? relations.get(evt.about) : null;
  const trustMod = rel ? 0.35 + 0.65 * (rel.trust / 100) : 1;

  const base = TARGETS[evt.kind] ?? TARGETS.relocate;
  // 相关性/意外性/人格决定目标值偏移：越相关越意外 ⇒ 越该被唤起；秩序目标越强 ⇒ 见到越轨更往高自制推
  const tgt = {
    arousal: clamp01(base.arousal + 0.35 * relevance * (0.25 + 0.75 * unexpectedness) - 0.15 * expected),
    approach: clamp01(base.approach + (evt.valence >= 0 ? 0.3 : -0.3) * relevance * controllability * trustMod),
    inhibit: evt.violates ? clamp01(0.55 + 0.45 * traits.normStrength * (0.3 + 0.7 * unexpectedness)) : traits.baseline.inhibit,
    quiescence: clamp01(base.quiescence - 0.4 * relevance * (0.3 + 0.7 * unexpectedness)),
  };

  // 牵引速率必须小：激素不该一句话就改完状态，那是神经反射的量级（见 traits 修订③）
  const rate = { arousal: 0.12, approach: 0.1, inhibit: 0.09 * (0.4 + traits.goals.order), quiescence: 0.1 };
  const u = {};
  for (const d of DIMS) {
    const raw = rate[d] * pull(m[d], tgt[d], rate[d]);
    u[d] = Number(Math.max(-traits.U_max, Math.min(traits.U_max, raw)).toFixed(4));
  }
  // 内疚：自己造成且违反规范 ⇒ 趋近被压（人格差异最容易体现的一处）
  if (evt.violates && evt.selfCaused) u.approach = Number((u.approach - 0.4 * traits.normStrength * (1 - tgt.approach)).toFixed(4));

  const importance = clamp01(relevance * (0.5 + 0.5 * unexpectedness) + 0.4 * Math.abs(evt.valence) + 0.3 * normHit);
  return {
    u,
    targets: Object.fromEntries(Object.entries(tgt).map(([k, v]) => [k, Number(v.toFixed(3))])),
    parts: { axis, relevance: Number(relevance.toFixed(3)), unexpectedness: Number(unexpectedness.toFixed(3)), controllability, norm: Number(normHit.toFixed(2)), trustMod: Number(trustMod.toFixed(2)) },
    importance,
  };
}
