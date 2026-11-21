// 客户端天气过渡层（纯表现）：把服务端按日阶跃的天气布尔变成 10–30s 的连续量。
//
// 边界（2026-11-21 体验审计 P1）：
//   · 服务端 w.weather / disasterToday / drought / season 不动 —— 生长、取水、风险仍读它们；
//   · 本模块只被渲染读（uWetness / uWeather[1..2] / solarLight 倍率 / 雨滴条数 / 水花强度），
//     绝不回写世界状态，也绝不进 playAct；
//   · 读档、切世界、回放跳时间这类"目标本来就该是新的"场合用 snap（直接到目标），
//     避免读档后还要重播一段雨；回放里时间轴是跳的，所以也不复用平滑态。
//
// 速率以"0→1 / 1→0 需要多少秒"表述；每帧按真实 dt 夹住步长，跨日那一刻只是目标变了，
// 画面在 up/down 秒内到位 —— 端点与旧的硬切完全一致（湿 .65 / 暴风 .95、风 .55/1.15/2.7）。
export const CLIMATE_FADE = Object.freeze({
  rain: Object.freeze({ up: 10, down: 14 }),
  storm: Object.freeze({ up: 6, down: 9 }),
  snow: Object.freeze({ up: 20, down: 26 }),
  frost: Object.freeze({ up: 14, down: 20 }),
  wet: Object.freeze({ up: 14, down: 28 }),
});

export const CLIMATE_LIMITS = Object.freeze({ rain: .65, storm: .95 });

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const unit = (v) => clamp(Number.isFinite(v) ? v : (v ? 1 : 0), 0, 1);

/** 服务端 → 目标值（0..1）。湿地面是"雨 .65 + 暴风追加 .30"，端点 .65/.95 与旧硬切一致。 */
export function climateTargets(climate) {
  const rain = climate?.rain ? 1 : 0;
  const storm = climate?.storm ? 1 : 0;
  const snow = climate?.snow ? 1 : 0;
  const frost = climate?.frost ? 1 : 0;
  return { rain, storm, snow, frost, wet: rain * CLIMATE_LIMITS.rain + storm * (CLIMATE_LIMITS.storm - CLIMATE_LIMITS.rain) };
}

function approach(value, target, dt, rate) {
  const step = target > value ? dt / rate.up : dt / rate.down;
  return value + clamp(target - value, -step, step);
}

/**
 * 有状态的天气视图。每帧 update(climate, dtSeconds)，渲染读 view()。
 * @returns {{update:Function, view:Function, targets:Function, snap:Function, state:Function}}
 */
export function createClimateView() {
  const state = { rain: 0, storm: 0, snow: 0, frost: 0, wet: 0, primed: false };
  let lastTarget = null;

  function snap(climate) {
    const target = climateTargets(climate);
    state.rain = target.rain; state.storm = target.storm; state.snow = target.snow;
    state.frost = target.frost; state.wet = target.wet;
    state.primed = true;
    lastTarget = target;
    return state;
  }

  function update(climate, dtSeconds = 0, { snap: forceSnap = false } = {}) {
    const target = climateTargets(climate);
    lastTarget = target;
    if (forceSnap || !state.primed) return snap(climate);
    // dt 夹到 0.5s：标签页恢复/长帧不应该一帧走完 10s 的过渡（那又变成硬切）。
    const dt = clamp(Number.isFinite(dtSeconds) ? dtSeconds : 0, 0, .5);
    if (dt <= 0) return state;
    for (const key of ['rain', 'storm', 'snow', 'frost', 'wet']) {
      state[key] = approach(state[key], target[key], dt, CLIMATE_FADE[key]);
    }
    return state;
  }

  /** 渲染用的连续量：风力 .55/.1.15/2.7 三个端点与旧实现逐位一致。 */
  function view() {
    return {
      rain: unit(state.rain), storm: unit(state.storm), snow: unit(state.snow), frost: unit(state.frost),
      wetness: unit(state.wet),
      wind: .55 + .60 * unit(state.rain) + 1.55 * unit(state.storm),
      overcast: Math.max(unit(state.rain), unit(state.snow)),
    };
  }

  return {
    update,
    snap,
    view,
    state: () => ({ ...state }),
    targets: () => (lastTarget ? { ...lastTarget } : null),
  };
}
