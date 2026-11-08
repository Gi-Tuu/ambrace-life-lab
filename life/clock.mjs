// L0 时钟：昼夜相位与"一天"的定义。
// 之前"夜里瞭台封禁"是 rules.mjs 里的一句 `world.t % 24 >= 20` —— 那是个魔法数，不是时钟。
// 换成显式相位之后：昼夜成为可查询的世界事实，日落才成了反思回合的触发器。
// 周期保持 24 刻、夜段保持第 20–23 刻，**与旧条件逐位等价**（有闸门验这条），
// 否则这次"只是把魔法数改名"的改动会顺带把所有已发表轨迹换掉（§27 的浮点顺序教训）。
export const DAY_TICKS = Number(process.env.DAY_TICKS ?? 24);
export const PHASES = ['晨', '昼', '暮', '夜'];

export function phaseOf(t) {
  const h = ((t % DAY_TICKS) + DAY_TICKS) % DAY_TICKS;
  return h < 4 ? '晨' : h < 12 ? '昼' : h < 20 ? '暮' : '夜';
}

export const dayOf = (t) => Math.floor(t / DAY_TICKS);
export const isNight = (t) => phaseOf(t) === '夜';

// 日落 = 进入夜的第一刻。反思回合挂在这里，而不是挂在一个没人能解释的 tick 数上
export const isSunset = (t) => t > 0 && isNight(t) && !isNight(t - 1);

export function clockSummary(t) {
  return `第 ${dayOf(t) + 1} 天 · ${phaseOf(t)}`;
}

// PLAN §28：天气是 (seed, day) 的确定性哈希，**不用 Math.random**——同种子同一天永远同一种天气。
// lab 预设不启用；town 启用。坏天气只经感知→评价管线影响行为（body.perceptsAt），另在户外加一点能耗。
export const WEATHERS = Object.freeze(['clear', 'rain', 'cold']);
export function weatherFor(seed, day) {
  let x = ((seed >>> 0) * 2654435761 ^ ((day + 1) >>> 0) * 40503) >>> 0;
  x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
  const r = x / 4294967296;
  return WEATHERS[r < 0.55 ? 0 : r < 0.8 ? 1 : 2];
}

// O10 日程：谁何时在哪。这是世界侧的节律表，不是决策层——它只提供"该在哪"这一事实，
// 权重进不进比较由 body/model 决定，所以关掉权重能精确退回旧行为。
export const SCHEDULE = {
  谨慎: { 晨: 'home', 昼: 'store', 暮: 'home', 夜: 'home' },
  冲动: { 晨: 'hall', 昼: 'watch', 暮: 'hall', 夜: 'watch' },
  孤僻: { 晨: 'watch', 昼: 'watch', 暮: 'hall', 夜: 'home' },
};

export const scheduledLoc = (archetype, t) => SCHEDULE[archetype]?.[phaseOf(t)] ?? null;
