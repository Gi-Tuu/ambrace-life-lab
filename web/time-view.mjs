// 1.1 第 4 项：世界分钟的只读显示投影。
//
// 这里**没有第二套时间**：输入就是 /world 的 `survival.gameMinutes` + `survival.clock`
// （服务端 world.simClock 的唯一读数），本模块只负责两次轮询之间的外推与格式化。
// 纯函数、零 DOM、零 fetch、零随机：可以在 Node 里单测，也可以在浏览器里逐帧调用。
//
// 口径（与服务端 simClock 一致）：
//   游戏分钟增量 = 真实毫秒 × rate / msPerGameMinute
//   暂停（paused）或 rate<=0 ⇒ 停在锚点，不欠不补。
//   掉轮询时最多外推 5s，之后冻结；下一次 /world 到达即重锚，服务端永远是真值。

export const GAME_MINUTES_PER_DAY = 1440;
export const MAX_EXTRAPOLATION_MS = 5000;

const finite = (value, fallback = NaN) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

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
