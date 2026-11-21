// P1 连续时钟：世界时间的唯一真相。
//
// 旧结构里 `world.t` 是计数器：tick 同时是 60 游戏分钟、CPU 帧、决策机会与 60 分额度桶。
// 这里只做一件事——把"真实时间 → 游戏分钟"的换算收进一个对象：
//   nowMinutes = (nowMs - anchorMs) * rate / msPerGameMinute
// `world.t` 降级为派生整数 floor(nowMinutes / 60)，旧结算点仍可继续按刻取整。
//
// 口径：
//   · 默认 1 游戏分钟 = TICK_MS/60 毫秒；TICK_MS=7500 ⇒ 125ms，和现有 7.5s/60min 观感一致。
//   · rate 是倍速（游戏分钟/真实分钟），默认 1；只影响世界时间，不影响 CPU 预算。
//   · pause 记录 pausedAt，恢复时把 anchor 往后推同样时长 ⇒ 暂停期间世界不欠不补。
//   · advance(ms) 显式推进世界（测试/离线补时/床），与真实时间无关。
//
// 研究态/旧档默认不创建这个对象，所有旧字段与哈希保持原样。

export const GAME_MINUTES_PER_HOUR = 60;
export const GAME_MINUTES_PER_DAY = 1440;

const finite = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

export function createSimClock({
  now = Date.now,
  tickMs = process.env.TICK_MS ?? 7500,
  msPerGameMinute = process.env.GAME_MS_PER_MINUTE,
  rate = process.env.GAME_SPEED ?? 1,
  paused = false,
  startMinutes = 0,
  manual = false,
} = {}) {
  const clockNow = () => (typeof now === 'function' ? Number(now()) : Number(now));
  const safeTickMs = Math.max(1, finite(tickMs, 7500));
  const safeMsPerMinute = Math.max(1e-6, finite(msPerGameMinute, safeTickMs / GAME_MINUTES_PER_HOUR));
  let safeRate = Math.max(0, finite(rate, 1));
  // rate=0 是冻结语义，不是“公式乘 0 把世界归零”：世界停在 startMinutes（或最近一次
  // setGameMinutes/换挡时的分钟），既不除零也不产生 NaN。
  let frozenMinutes = Math.max(0, finite(startMinutes, 0));
  let anchorMs = clockNow() - (frozenMinutes * safeMsPerMinute) / (safeRate || 1);
  let pausedAtMs = paused ? clockNow() : null;

  const gameMinutesAt = (atMs) => {
    if (safeRate === 0) return frozenMinutes;
    const base = pausedAtMs ?? atMs;
    return ((base - anchorMs) * safeRate) / safeMsPerMinute;
  };

  const clock = {
    manual: manual === true,
    get rate() { return safeRate; },
    get msPerGameMinute() { return safeMsPerMinute; },
    get paused() { return pausedAtMs !== null; },
    get anchorMs() { return anchorMs; },
    nowMs: clockNow,
    nowMinutes(atMs = clockNow()) { return gameMinutesAt(atMs); },
    // 派生刻：保留旧整数量纲，供日历/旧 RNG 键/存档对账使用；不驱动新结算。
    // +1e-6 只吸收浮点回算误差（如 60*16666.666… 反算成 59.99999999999999），
    // 不改变“跨过整分钟才进位”的语义；否则同一分钟步在不同真实时刻会随机落 t-1/t。
    nowTick(atMs = clockNow()) { return Math.floor((gameMinutesAt(atMs) + 1e-6) / GAME_MINUTES_PER_HOUR); },
    // 显式推进世界时间（真实毫秒）。暂停时推进暂停点，恢复后时间仍然只向前。
    advance(deltaMs) {
      const delta = finite(deltaMs, 0);
      if (delta === 0) return clock.nowMinutes();
      // rate=0 与暂停同属冻结：真实时间流逝不推世界分钟。
      if (safeRate === 0) return frozenMinutes;
      if (pausedAtMs !== null) pausedAtMs += delta;
      else anchorMs -= delta;
      return clock.nowMinutes();
    },
    advanceMinutes(minutes) {
      const m = finite(minutes, 0);
      if (m === 0) return clock.nowMinutes();
      // 显式推进在 rate=0 下同样不改变冻结分钟（与 pause 语义一致）。
      if (safeRate === 0) return frozenMinutes;
      return clock.advance((m * safeMsPerMinute) / safeRate);
    },
    // 读档/迁移：把"当前世界分钟"钉到指定值，不产生时间跳跃记录。
    setGameMinutes(minutes, atMs = clockNow()) {
      const m = Math.max(0, finite(minutes, 0));
      if (safeRate === 0) {
        frozenMinutes = m;
        return m;
      }
      if (pausedAtMs !== null) {
        anchorMs = pausedAtMs - (m * safeMsPerMinute) / safeRate;
      } else {
        anchorMs = atMs - (m * safeMsPerMinute) / safeRate;
      }
      return m;
    },
    pause(atMs = clockNow()) {
      if (pausedAtMs === null) pausedAtMs = atMs;
      return clock.nowMinutes();
    },
    resume(atMs = clockNow()) {
      if (pausedAtMs !== null) {
        anchorMs += atMs - pausedAtMs;
        pausedAtMs = null;
      }
      return clock.nowMinutes();
    },
    setRate(nextRate, atMs = clockNow()) {
      const next = Math.max(0, finite(nextRate, safeRate));
      // 换挡不能改变此刻的世界分钟：先把 anchor 平移到新 rate 下等价的点。
      const current = gameMinutesAt(atMs);
      safeRate = next;
      if (safeRate === 0) {
        // 冻结在当前分钟；从 0 换回正速率时以 frozenMinutes 为锚继续走。
        frozenMinutes = current;
        anchorMs = pausedAtMs ?? atMs;
      } else {
        const base = pausedAtMs ?? atMs;
        anchorMs = base - (current * safeMsPerMinute) / safeRate;
      }
      return current;
    },
    state(atMs = clockNow()) {
      const minutes = gameMinutesAt(atMs);
      return {
        anchorMs,
        rate: safeRate,
        paused: pausedAtMs !== null,
        pausedAtMs,
        msPerGameMinute: safeMsPerMinute,
        gameMinutes: minutes,
        // 复用 nowTick 的 +1e-6 浮点吸收；state().t 与 world.t getter 永远同源。
        t: Math.floor((minutes + 1e-6) / GAME_MINUTES_PER_HOUR),
      };
    },
  };
  return clock;
}

// 把 `world.t` 从"世界事实"降级为派生整数：正式世界（有 simClock）读到的是
// floor(nowMinutes/60)，写入只用于存档/旧档迁移/测试夹具重锚（把时钟钉到 value*60）。
// 新代码请优先用 worldMinutes()/worldTick()；`w.t` 只作为兼容读法保留。
// 研究态没有 simClock ⇒ 不改变 makeWorld 的普通数据属性，dumpSurv 逐位不变。
export function bindDerivedTick(world) {
  const clock = world?.simClock;
  if (!clock) return world;
  const existing = Object.getOwnPropertyDescriptor(world, 't');
  if (existing?.get) return world;
  Object.defineProperty(world, 't', {
    configurable: true,
    enumerable: true,
    get() { return Math.floor((clock.nowMinutes() + 1e-6) / GAME_MINUTES_PER_HOUR); },
    set(value) {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) clock.setGameMinutes(n * GAME_MINUTES_PER_HOUR);
    },
  });
  return world;
}

export function worldMinutes(world) {
  if (world?.simClock?.nowMinutes) return Number(world.simClock.nowMinutes());
  const t = Number(world?.t ?? 0);
  return Number.isFinite(t) ? Math.max(0, t) * GAME_MINUTES_PER_HOUR : 0;
}

// 动作/忙碌区间的“当前游戏分钟”：取整，不把真实毫秒的小数带进 endMin/存档/完成边界。
// 正式世界的 1 分钟微步本来就在整分钟上结算；用小数会让同一输入在不同负载下晚/早 1 分完成。
export function simMinuteNow(world) {
  if (world?.simClock?.nowMinutes) return Math.max(0, Math.floor(Number(world.simClock.nowMinutes()) + 1e-6));
  const t = Number(world?.t ?? 0);
  return Number.isFinite(t) ? Math.max(0, Math.floor(t)) * GAME_MINUTES_PER_HOUR : 0;
}

export function worldTick(world) {
  if (world?.simClock?.nowMinutes) return Math.floor((world.simClock.nowMinutes() + 1e-6) / GAME_MINUTES_PER_HOUR);
  const t = Number(world?.t ?? 0);
  return Number.isFinite(t) ? Math.max(0, Math.floor(t)) : 0;
}

// 真实毫秒令牌桶：算力限流用，单位不是游戏分钟。
// 容量 capacity，每 refillMs 补 1 个；`take()` 返回是否拿到令牌。
export function createTokenBucket({ capacity = 4, refillMs = 60_000, tokens = capacity, now = Date.now } = {}) {
  const clockNow = () => (typeof now === 'function' ? Number(now()) : Number(now));
  const cap = Math.max(1, Math.floor(finite(capacity, 4)));
  const interval = Math.max(1, finite(refillMs, 60_000));
  let value = Math.max(0, Math.min(cap, finite(tokens, cap)));
  let lastMs = clockNow();
  return {
    get capacity() { return cap; },
    get tokens() { return value; },
    refill(atMs = clockNow()) {
      const elapsed = Math.max(0, atMs - lastMs);
      if (elapsed <= 1) return value;
      const gained = Math.floor(elapsed / interval);
      if (gained > 0) {
        value = Math.min(cap, value + gained);
        lastMs += gained * interval;
      }
      return value;
    },
    take(atMs = clockNow()) {
      this.refill(atMs);
      if (value < 1) return false;
      value -= 1;
      return true;
    },
    state() { return { capacity: cap, tokens: value, refillMs: interval }; },
  };
}
