// 只读审计脚本：天气切换时客户端每一帧用到的量，是否在同一 tick 内硬切（无插值）。
// 用法: node evidence/exp-audit-render/weather-step.mjs
import { campClimate } from '../../web/camp-weather.mjs';
import { solarLight } from '../../web/camp-sun.mjs';

// 复刻 web/app.js:1447-1516 / 1540 的推导（纯函数部分）
const DAY_TICKS = 24;              // app.js: w.dayTicks ?? 24
const TICK_MS = 7500;              // 默认每刻 7.5s（life/space.mjs unitsForRealMs 同口径）
function frameView(w, t, elapsed = 0) {
  const climate = campClimate(w);
  const tNow = t + Math.min(.98, elapsed / TICK_MS);
  const daylightDirect = solarLight(tNow, w.dayTicks ?? DAY_TICKS, climate.season,
    { storm: climate.storm, overcast: climate.rain || climate.snow, indoor: false }).direct;
  const sun = solarLight(tNow, w.dayTicks ?? DAY_TICKS, climate.season,
    { storm: climate.storm, overcast: climate.rain || climate.snow, indoor: false });
  const wetness = climate.rain ? (climate.storm ? .95 : .65) : 0;           // app.js:1516
  const weather = [0, climate.storm ? 2.7 : climate.rain ? 1.15 : .55,      // app.js:1456
    Number(climate.frost), sun.glow];
  return {
    rain: climate.rain, snow: climate.snow, storm: climate.storm,
    'uWetness': wetness,
    'uWeather[1] 风力': weather[1],
    'uWeather[2] 积雪': weather[2],
    'uLight 平均': +(sun.light.reduce((a, b) => a + b, 0) / 3).toFixed(3),
    'sun.direct': +sun.direct.toFixed(3),
    '曝光用 daylightDirect': +daylightDirect.toFixed(3),
    '雨滴条数 paintWeather': climate.rain || climate.snow ? (climate.storm ? 86 : climate.snow && !climate.storm ? 44 : 48) : 0,
    'stormEffects 水花': climate.storm ? '全屏生成' : '无',
  };
}
const noon = 12; // 正午附近，避免昼夜本身的变化混进来
const cases = [
  ['晴 → 雨', { weather: 'clear', season: '春', dayTicks: DAY_TICKS }, { weather: 'rain', season: '春', dayTicks: DAY_TICKS }],
  ['雨 → 暴风', { weather: 'rain', season: '春', dayTicks: DAY_TICKS }, { weather: 'rain', season: '春', dayTicks: DAY_TICKS, disasterToday: 'storm' }],
  ['雨 → 晴', { weather: 'rain', season: '春', dayTicks: DAY_TICKS }, { weather: 'clear', season: '春', dayTicks: DAY_TICKS }],
  ['秋 → 冬（uSeason 硬切）', { weather: 'clear', season: '秋', dayTicks: DAY_TICKS }, { weather: 'clear', season: '冬', dayTicks: DAY_TICKS }],
];
for (const [label, a, b] of cases) {
  const A = frameView(a, noon, 0), B = frameView(b, noon, 0);
  console.log('\n## ' + label + '（同一时刻 t 的相邻两次轮询，中间没有任何过渡帧）');
  for (const k of Object.keys(A)) {
    const same = JSON.stringify(A[k]) === JSON.stringify(B[k]);
    console.log(`  ${k}: ${JSON.stringify(A[k])} -> ${JSON.stringify(B[k])}${same ? '  (不变)' : '   ← 一帧内跳变'}`);
  }
}
// 一天之内的天气状态本身是 (seed, day) 的阶跃函数
console.log('\n## 服务端状态粒度');
console.log('  w.weather = weatherFor(seed, dayOf(t))：只在跨日那一刻变（life/host-world.mjs:306）');
console.log('  survival.disasterToday：每日结算时重算（life/worldstate.mjs:119-140）');
console.log('  survival.drought：clearStreak >= 3 时置位（life/worldstate.mjs:103）');
console.log('  season：SEASON_BOUNDS 日界切换（life/clock.mjs:25）');
console.log('  客户端对以上四项不做任何记忆/插值：每帧从 w 重新求值（web/camp-weather.mjs:31-36 为纯函数）。');
