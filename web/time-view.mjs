// 1.1 第 4 项：世界分钟的只读显示投影。
//
// 这里**没有第二套时间**：输入就是 /world 的 `survival.gameMinutes` + `survival.clock`
// （服务端 world.simClock 的唯一读数），本模块只负责两次轮询之间的外推与格式化。
// 纯函数、零 DOM、零 fetch、零随机：可以在 Node 里单测，也可以在浏览器里逐帧调用。
//
// 口径（与服务端 simClock 一致）：
//   游戏分钟增量 = 真实毫秒 × rate / msPerGameMinute
//   正式默认 msPerGameMinute=6000 ⇒ 现实 1 分钟 = 10 游戏分，1 天 1440 分 = 144 现实分钟。
//   暂停（paused）或 rate<=0 ⇒ 停在锚点，不欠不补。
//   掉轮询时最多外推 5s，之后冻结；下一次 /world 到达即重锚，服务端永远是真值。

export const GAME_MINUTES_PER_DAY = 1440;
export const MAX_EXTRAPOLATION_MS = 5000;
// 只有视图完全没有 clock 时才用的标称值；服务端给了 msPerGameMinute 就绝不估算。
// 6000 与 life/sim-clock.mjs 的 DEFAULT_MS_PER_GAME_MINUTE 同值，前端不 import 服务端模块。
export const FALLBACK_MS_PER_GAME_MINUTE = 6000;
// 名义一刻 = 60 游戏分 × 6000ms = 6 现实分钟。只在没有连续 clock 的表现层换算里用。
export const FALLBACK_TICK_MS = FALLBACK_MS_PER_GAME_MINUTE * 60;

const finite = (value, fallback = NaN) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

// /world → HUD 锚点：只读服务端 clock 的 msPerGameMinute/rate/paused。
// 不从相邻两次轮询的 serverNow/gameMinutes 差分估速（那会形成第二套时间读数）。
export function clockAnchorFromView(view, at = 0) {
  if (view?.timeMode !== 'continuous') return null;
  const gameMinutes = finite(view?.gameMinutes);
  if (!Number.isFinite(gameMinutes)) return null;
  const clock = view.clock ?? {};
  const msPerGameMinute = finite(clock.msPerGameMinute);
  const rate = finite(clock.rate);
  return {
    gameMinutes,
    at: Number.isFinite(at) ? Number(at) : 0,
    // rate=0 是冻结语义：保留 0，让 interpolateGameMinutes 停在锚点，不回退到标称 6000ms 继续走。
    rate: Number.isFinite(rate) ? Math.max(0, rate) : 1,
    msPerGameMinute: Number.isFinite(msPerGameMinute) && msPerGameMinute > 0
      ? msPerGameMinute
      : FALLBACK_MS_PER_GAME_MINUTE,
    paused: clock.paused === true,
  };
}

// 表现层用的「一刻多少真实毫秒」：正式连续世界以服务端 clock 为唯一来源（60 游戏分/刻），
// 不再假设 TICK_MS=7500 就是正式节奏。非连续/研究态回落到 view.tickMs（保留其真实值，
// 不用 7500 覆盖冻世界测试的读数）；只做「缺字段时的兜底」。
export function tickMsFromView(view, fallback = 7500) {
  const per = finite(view?.clock?.msPerGameMinute);
  if (view?.timeMode === 'continuous' && Number.isFinite(per) && per > 0) {
    return per * 60;
  }
  const raw = finite(view?.tickMs, fallback);
  if (!Number.isFinite(raw) || raw <= 0) return Number.isFinite(fallback) && fallback > 0 ? fallback : 7500;
  return raw;
}

// anchor: { gameMinutes, rate, msPerGameMinute, paused, at? }
// elapsedMs: 现在 - anchor.at（调用方用 performance.now() 算，避免受系统时钟回拨影响）
export function interpolateGameMinutes(anchor, elapsedMs) {
  const base = finite(anchor?.gameMinutes);
  if (!Number.isFinite(base)) return null;
  if (anchor?.paused === true) return base;
  const rate = finite(anchor?.rate, 0);
  const msPerGameMinute = finite(anchor?.msPerGameMinute, 0);
  if (!(rate > 0) || !(msPerGameMinute > 0)) return base;
  const elapsed = Math.min(Math.max(0, finite(elapsedMs, 0)), MAX_EXTRAPOLATION_MS);
  return base + (elapsed * rate) / msPerGameMinute;
}

export function gameMinuteOfDay(minutes) {
  const n = finite(minutes, 0);
  return ((n % GAME_MINUTES_PER_DAY) + GAME_MINUTES_PER_DAY) % GAME_MINUTES_PER_DAY;
}

export function formatGameClock(minutes) {
  const minuteOfDay = gameMinuteOfDay(Math.floor(finite(minutes, 0)));
  const hh = String(Math.floor(minuteOfDay / 60)).padStart(2, '0');
  const mm = String(minuteOfDay % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

// 今日剩余游戏分钟：跨日回到 1440，不出现 0 / 负数，也不会在 23:59 之后继续扣。
export function gameMinutesLeftToday(minutes) {
  const minuteOfDay = gameMinuteOfDay(minutes);
  return Math.max(0, Math.floor(GAME_MINUTES_PER_DAY - minuteOfDay));
}

// busy 进度：连续路径用服务端 endMin 精确算；旧路径没有 endMin 时按"锚点世界分钟"差外推。
// 只用于显示，返回 0 也不代表动作已完成 —— 完成仍以 /world 的 busy 消失为准。
export function busyRemainMinutes(busy, nowMinutes, anchorMinutes) {
  if (!busy) return null;
  const now = finite(nowMinutes, finite(anchorMinutes, 0));
  const end = finite(busy.endMin);
  if (Number.isFinite(end)) return Math.max(0, end - now);
  const remain = finite(busy.remainMin);
  if (!Number.isFinite(remain)) return null;
  const from = finite(anchorMinutes, now);
  return Math.max(0, remain - Math.max(0, now - from));
}

export function clockReadout(anchor, elapsedMs) {
  const minutes = interpolateGameMinutes(anchor, elapsedMs);
  if (!Number.isFinite(minutes)) return null;
  return {
    minutes,
    minuteOfDay: gameMinuteOfDay(minutes),
    clock: formatGameClock(minutes),
    leftToday: gameMinutesLeftToday(minutes),
  };
}
