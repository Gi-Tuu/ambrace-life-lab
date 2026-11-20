// 只读审查探针：正式连续世界（minuteMetab on/off）玩家 p1 的每游戏小时能量/存续。
// 目的：证明 worldTick 的 p1 结算与 minuteMetab 的 60 个分钟步叠加（每游戏小时 2 次）。
// 用法：node evidence/final-review/player-metab-probe.mjs
import { createSurvPlay, tickSurvPlay } from '../../life/survplay.mjs';
import { createSimClock } from '../../life/sim-clock.mjs';
import { FORMAL_OPTIONS } from '../../life/balance-probe.mjs';

const rows = [];
for (const mode of ['on', 'off']) {
  const clock = createSimClock({ now: () => 0, tickMs: 3600000, manual: true });
  const sp = createSurvPlay(7, { ...FORMAL_OPTIONS, eventRulesVersion: 2, simTime: true, simClock: clock, minuteMetab: mode === 'on' });
  const w = sp.world;
  const p1 = w.agents.p1, a1 = w.agents.a1;
  const trace = [];
  for (let h = 1; h <= 6; h++) {
    await tickSurvPlay(sp, { minutes: 60 });
    trace.push({ hour: h, p1Energy: +p1.drives.v.energy.toFixed(4), p1Metab: p1.metabCount, a1Energy: +a1.drives.v.energy.toFixed(4), a1Metab: a1.metabCount });
  }
  const perHour = trace[5].p1Energy - trace[4].p1Energy;
  rows.push({ mode, perHourP1EnergyDelta: +perHour.toFixed(4), trace });
}
console.log(JSON.stringify({ at: new Date().toISOString(), rows,
  note: 'p1 每游戏小时能量下降：on 应为 -0.024（0.012 分钟积分 + 0.012 worldTick 再 tick 一次），off 为 -0.012。居民 a1 的 metabCount=60（只走分钟步）。' }, null, 2));
