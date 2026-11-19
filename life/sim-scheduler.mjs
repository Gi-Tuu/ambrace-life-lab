// P1b SimScheduler：把"真实毫秒"翻译成"整游戏分钟步"，作为世界推进的唯一节拍来源。
//
// 口径（单源换算）：
//   1 游戏分钟 = clock.msPerGameMinute 真实毫秒（TICK_MS=7500 ⇒ 125ms）
//   世界分钟 = 真实毫秒 × rate / msPerGameMinute
//   ⇒ 默认 1 真实分 = 60000 / 125 = 480 游戏分；rate 只做倍率（rate=2 ⇒ 960）。
// 离线补时用同一个函数换算，不再有第二套"真实分钟 → 刻"的算法。
//
// Scheduler 不持有时钟：它只读 clock（含 paused/rate），并读一个"已消费到哪一分钟"的游标
//（正式游戏里由 survplay 的分钟游标提供）。因此暂停/倍速/读档重锚都不需要另起时钟。

const finite = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};
const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));

export const DEFAULT_STEP_MINUTES = 1;
export const DEFAULT_MAX_BACKLOG_MINUTES = 600;

// 唯一换算入口：真实毫秒 → 游戏分钟（rate 只乘一次，不再除第二个比率）。
export function gameMinutesForRealMs(realMs, clock) {
  const ms = Math.max(0, finite(realMs, 0));
  if (!clock) return 0;
  return (ms * Math.max(0, finite(clock.rate, 1))) / Math.max(1e-6, finite(clock.msPerGameMinute, 125));
}

export function gameMinutesForRealMinutes(realMinutes, clock) {
  return gameMinutesForRealMs(Math.max(0, finite(realMinutes, 0)) * 60000, clock);
}

export function createSimScheduler({
  clock,
  cursor = () => 0,
  stepMinutes = DEFAULT_STEP_MINUTES,
  maxBacklogMinutes = DEFAULT_MAX_BACKLOG_MINUTES,
  now = Date.now,
} = {}) {
  if (!clock) throw new Error('SimScheduler 需要 clock');
  const step = Math.max(1, Math.floor(finite(stepMinutes, DEFAULT_STEP_MINUTES)));
  const cap = Math.max(step, Math.floor(finite(maxBacklogMinutes, DEFAULT_MAX_BACKLOG_MINUTES)));
  const cursorOf = () => {
    let value;
    try { value = Number(cursor()); } catch { value = NaN; }
    return Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
  };

  // 还欠多少整分钟；minutes=0 表示这一拍不该推进世界。
  function peek(atMs = now()) {
    const nowMin = clock.nowMinutes(atMs);
    const current = Math.floor(nowMin + 1e-9);
    const done = cursorOf();
    const backlog = Math.max(0, current - done);
    if (backlog < step) return { minutes: 0, backlog, from: done, to: done, capped: false };
    const minutes = Math.min(cap, backlog);
    return {
      minutes: Math.floor(minutes / step) * step,
      backlog,
      from: done,
      to: done + Math.floor(minutes / step) * step,
      capped: backlog > minutes,
    };
  }

  // 距离下一个整游戏分钟还有多少真实毫秒；暂停/rate=0 时不催。
  function nextDelayMs(atMs = now()) {
    if (clock.paused || clock.rate <= 0) return 250;
    const nowMin = clock.nowMinutes(atMs);
    const current = Math.floor(nowMin + 1e-9);
    const done = cursorOf();
    if (current - done >= step) return 1;
    const nextBoundary = Math.floor(nowMin) + step;
    const remainMinutes = Math.max(1e-6, nextBoundary - nowMin);
    const perMinute = clock.msPerGameMinute / Math.max(1e-6, clock.rate);
    return clamp(Math.ceil(remainMinutes * perMinute), 1, 1000);
  }

  return {
    clock,
    stepMinutes: step,
    maxBacklogMinutes: cap,
    peek,
    due: peek,
    nextDelayMs,
    state(atMs = now()) {
      const row = peek(atMs);
      return { stepMinutes: step, maxBacklogMinutes: cap, cursor: cursorOf(), ...row, nextDelayMs: nextDelayMs(atMs) };
    },
  };
}
