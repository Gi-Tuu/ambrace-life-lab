// 1.1 正式钟生存的调度闸门（本轮回溯出的两个根因，先写红再修）：
//   BAL-01 同一世界按 1 分/步 与 60 分/步 推进必须逐位相同（批量不得改写世界）。
//   BAL-02 本地替身决策必须同步结算（tick 不返回 Promise），否则分钟循环只还一个微任务/分钟，
//          10 分 think 会被拖成 ~38 分/次，批量 60 分时更久。
//   BAL-03 正式连续世界里移动候选按旧刻（60 游戏分/次）发放；研究态/旧路径无此门。
// 这些是时间语义闸门，不改任何生存阈值。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSurvPlay, dumpSurv, tickSurvPlay } from './survplay.mjs';
import { createSimClock } from './sim-clock.mjs';
import { affordancesFor, actuate, move } from './body.mjs';
import { GAME_OPTIONS } from './long-run.mjs';
import { FORMAL_OPTIONS } from './balance-probe.mjs';
import { CURRENT_EVENT_RULES } from './rng.mjs';

const manualClock = () => createSimClock({ now: () => 0, tickMs: 3600000, manual: true });
const formal = (clock, extra = {}) => createSurvPlay(7, {
  ...FORMAL_OPTIONS, eventRulesVersion: CURRENT_EVENT_RULES, simTime: true, simClock: clock, minuteMetab: true, ...extra,
});

test('BAL-01 连续世界 1 分/步 与 60 分/步 推进 2 天后 dumpSurv 逐位相同', async () => {
  const a = formal(manualClock());
  const b = formal(manualClock());
  for (let hour = 0; hour < 48; hour += 1) {
    for (let m = 0; m < 60; m += 1) await tickSurvPlay(a, { minutes: 1 });
    await tickSurvPlay(b, { minutes: 60 });
  }
  assert.equal(a.world.t, 48);
  assert.equal(b.world.t, 48);
  assert.equal(JSON.stringify(dumpSurv(a)), JSON.stringify(dumpSurv(b)), '批量步长改变了世界：分钟循环里仍有逐分钟以外的批次依赖');
});

test('BAL-02 本地替身 tick 同步返回（不欠微任务）', async () => {
  const sp = formal(manualClock());
  const a = sp.world.agents.a1;
  const ret = a.tick(sp.world);
  assert.equal(typeof ret?.then, 'undefined', 'tick 仍返回 Promise：分钟调度会把决策拖成多个微任务');
  // 真模型路径仍必须是 Promise：换一个 async deliberator，确认 choose 返回 thenable。
  const sp2 = formal(manualClock());
  const a2 = sp2.world.agents.a1;
  a2.deliberator = async () => ({ kind: 'rest' });
  const scored = [{ id: 'rest', kind: 'rest', act: { kind: 'rest' }, u: 0.5 }];
  const asyncRet = a2.choose({ scored, temp: 0.1, ch: a2.ch, world: sp2.world, paths: [], reason: '关键事件' });
  assert.equal(typeof asyncRet?.then, 'function', '真模型等待必须保持异步，不能阻塞世界分钟');
  assert.equal((await asyncRet).kind, 'rest');
});

test('BAL-03 移动候选按旧刻发放：正式连续世界一次移动后 60 分内不再给 move_to', () => {
  const clock = manualClock();
  const sp = formal(clock);
  const w = sp.world;
  move(w, 'a1', 'home');
  const before = affordancesFor(w, 'a1').filter((x) => x.kind === 'move_to');
  assert.ok(before.length > 0, '初始应有移动候选');
  const r = actuate(w, 'a1', { kind: 'move_to', to: 'hall' });
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(w.agents.a1.nextMovePlanMin, 60, '移动后应登记下一次移动规划分钟 = 旧刻');
  clock.setGameMinutes(59); // 同一刻内（world.t 仍是 0；它是派生只读值，不能再赋值）
  // 合作任务派生的移动（cooperation:true）是目标驱动，不属"随手重选"的漫游门；这里只看普通移动候选。
  const after = affordancesFor(w, 'a1').filter((x) => x.kind === 'move_to' && !x.goal);
  assert.equal(after.length, 0, '同一刻内不应再发移动候选（否则 10 分 think 会把需求缺口重复兑现 6 次）');
  clock.setGameMinutes(120); // 满 60 分后恢复
  const resumed = affordancesFor(w, 'a1').filter((x) => x.kind === 'move_to' && !x.goal);
  assert.ok(resumed.length > 0, '满旧刻后移动候选应恢复');
});

test('BAL-03b 研究态/旧路径不受移动规划门影响（逐位基线前提）', () => {
  const sp = createSurvPlay(7, { ...GAME_OPTIONS });
  const w = sp.world;
  assert.equal(w.simClock, undefined);
  move(w, 'a1', 'home');
  const r = actuate(w, 'a1', { kind: 'move_to', to: 'hall' });
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(w.agents.a1.nextMovePlanMin, undefined, '研究态不得写调度字段');
  assert.ok(affordancesFor(w, 'a1').some((x) => x.kind === 'move_to'), '研究态移动候选不减');
});


