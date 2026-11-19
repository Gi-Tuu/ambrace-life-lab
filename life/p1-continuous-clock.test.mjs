// P1 第一刀闸门：连续时钟 + 去每刻配额 + 跨刻动作 + busy 思考 trace + 读档连续 + 研究态逐位不变。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSurvPlay, dumpSurv, loadSurv, playerTimeLeft, playerTimeMax, survAct, tickSurvPlay } from './survplay.mjs';
import { createSimClock } from './sim-clock.mjs';
import { move } from './body.mjs';
import { clockOf } from './resident-time.mjs';
import { CURRENT_EVENT_RULES } from './rng.mjs';

const GAME = {
  eventRulesVersion: CURRENT_EVENT_RULES, independentWorld: true, gameRules: true,
  residentialDecisions: true, unifiedCooperation: true, settlementLife: true,
  autonomousGoals: true, farmLife: true, regionalWork: true, ecosystem: true, wildFood: true,
  playerRation: true,
};

function makeGame(seed = 7) {
  let nowMs = 0;
  const clock = createSimClock({ now: () => nowMs, tickMs: 7500, manual: true });
  const sp = createSurvPlay(seed, { ...GAME, simTime: true, simClock: clock });
  return {
    sp, clock,
    at(minutes) {
      clock.setGameMinutes(minutes);
      sp.world.t = Math.floor(minutes / 60);
      return sp.world;
    },
    advance(minutes) { clock.advanceMinutes(minutes); },
  };
}

test('P1-01 正式游戏同刻连续 8 个短动作全成，没有 TIME_WAIT 或 60 分池', () => {
  const { sp, at } = makeGame();
  const w = at(600); // 第 10 刻
  move(w, 'p1', 'yard');
  w.survival.resStock.yard = 500;
  w.survival.lastDay = 10;
  const results = [];
  for (let i = 0; i < 8; i += 1) results.push(survAct(sp, { kind: 'gather' }));
  assert.ok(results.every((r) => r.ok), JSON.stringify(results));
  assert.ok(!results.some((r) => r.code === 'TIME_WAIT'), '连续路径不得再出现 TIME_WAIT');
  assert.equal(w.t, 10, '短动作不推进世界刻');
  const clock = clockOf(w, 'p1');
  assert.equal(clock.usedMin, 80, '日统计保留（8 × 10 分钟）');
  assert.equal(clock.tick.usedMin, 80, 'tick 统计仅作调度读数，不再作为拒绝条件');
  assert.equal(playerTimeMax(w), 1440, 'HUD 从本刻池改为今日时间');
  assert.equal(playerTimeLeft(w), 1360, '日剩余 1440-80');
});

test('P1-02 30 分钟施工按 endMin 跨刻完成，开始/完成不对齐 tick 边界', async () => {
  const { sp, clock, at, advance } = makeGame();
  const w = at(600);
  move(w, 'p1', 'yard');
  w.survival.sites = [{ type: 'shelter', loc: 'yard', progress: 0 }];
  w.pinv.p1 = { wood: 5, stone: 5 };
  w.survival.lastDay = 10;
  const start = survAct(sp, { kind: 'build' });
  assert.equal(start.code, 'BUSY_START', JSON.stringify(start));
  assert.equal(start.endMin, 630);
  assert.equal(w.survival.sites[0].progress, 0, '未到 endMin 前不得先结算效果');
  assert.equal(w.survival.actClock.p1.busy.remainMin, 30);

  advance(10); // 610，仍在同一刻 t=10
  await tickSurvPlay(sp);
  assert.equal(w.t, 10);
  assert.equal(w.survival.actClock.p1.busy?.remainMin, 20, '按游戏分钟推进，而不是按下一拍补 60');
  assert.equal(w.survival.sites[0].progress, 0);

  advance(20); // 630，仍是 t=10；完成点落在刻内
  await tickSurvPlay(sp);
  assert.equal(w.survival.actClock.p1.busy, null);
  assert.ok(w.survival.sites[0].progress > 0, '到 endMin 后应结算施工');
  const book = w.survival.actionLedger.player;
  assert.ok(Math.abs(book.minutes.build - 30) < 1e-9, `账本分钟应为 30，实测 ${book.minutes.build}`);
  assert.ok(Math.abs(book.energy.build - 0.10) < 1e-9, `体力应为 0.10，实测 ${book.energy.build}`);
  const events = (w.survival.eventJournal?.rows ?? []).filter((e) => e.kind === 'player_action' && e.action === 'build');
  assert.equal(events.length, 1, '完成只写一条聚落事件');
  assert.equal(events[0].status, 'completed');
});

test('P1-03 busy 居民仍会思考，行动被拒留下 BUSY trace（不再关掉大脑）', async () => {
  const { sp, clock, at, advance } = makeGame(13);
  const w = at(600);
  const a = w.agents.a1;
  move(w, 'a1', 'yard');
  w.survival.lastDay = 10;
  w.survival.sites = [{ type: 'shelter', loc: 'yard', progress: 0 }];
  w.pinv.a1 = { wood: 5, stone: 5 };
  a.drives.v.energy = 0.8;
  const started = a.execute(w, { id: 'build', kind: 'build' }, 'deliberation', w.t, true);
  assert.equal(started.code, 'BUSY_START', JSON.stringify(started));
  const before = a.trace.length;
  a.nextThinkMin = clock.nowMinutes();
  advance(10);
  await tickSurvPlay(sp);
  const fresh = a.trace.slice(before);
  assert.ok(fresh.length > 0, 'busy 期间必须有决策/感知 trace');
  assert.ok(fresh.some((r) => r.code === 'BUSY'), `应有 BUSY 拒绝 trace，实测 ${JSON.stringify(fresh)}`);
});

test('P1-04 读档连续：t/时钟/busy 重锚；旧 busy 字段自动补成绝对 start/end', () => {
  const { sp, at } = makeGame();
  const w = at(600);
  move(w, 'p1', 'yard');
  w.survival.sites = [{ type: 'shelter', loc: 'yard', progress: 0 }];
  w.pinv.p1 = { wood: 5, stone: 5 };
  w.survival.lastDay = 10;
  assert.equal(survAct(sp, { kind: 'build' }).code, 'BUSY_START');
  const raw = structuredClone(dumpSurv(sp));
  assert.ok(raw.clock && raw.clock.gameMinutes >= 600, '连续时钟状态应入档');
  const back = loadSurv(raw, 7, { ...GAME, simTime: true });
  assert.equal(back.world.t, w.t, '读档后世界刻连续');
  assert.ok(back.world.simClock, '读档后仍走连续时钟');
  assert.ok(back.world.survival.actClock.p1.busy, 'busy 随档恢复');
  assert.ok(Math.abs(back.world.simClock.nowMinutes() - raw.clock.gameMinutes) < 1e-6);

  // 旧档形状：只有 startTick/remainMin/progressMin，没有 endMin。
  const legacy = structuredClone(raw);
  delete legacy.clock;
  legacy.survival.actClock.p1.busy = {
    id: 'old', kind: 'build', body: { kind: 'build' }, startTick: 10,
    totalMin: 30, remainMin: 20, progressMin: 10, energyTotal: 0.1, energyPaid: 0, status: 'running',
  };
  const old = loadSurv(legacy, 7, { ...GAME, simTime: true });
  assert.equal(old.world.t, 10, '旧档缺 clock 时按 t 接上');
  const c = clockOf(old.world, 'p1');
  assert.ok(Number.isFinite(c.busy.endMin), '旧 busy 必须迁移成绝对结束时间');
  assert.equal(c.busy.endMin - c.busy.startMin, 30);
  assert.equal(c.busy.remainMin, 20);
});

test('P1-05 研究态逐位不变：simTime 选项不创建时钟、dumpSurv 哈希一致', async () => {
  const base = createSurvPlay(7, { unifiedCooperation: true });
  const ignored = createSurvPlay(7, { unifiedCooperation: true, simTime: true });
  assert.equal(base.world.simClock, undefined);
  assert.equal(ignored.world.simClock, undefined, 'gameRules:false 时 simTime 必须被忽略');
  for (let i = 0; i < 6; i += 1) {
    await tickSurvPlay(base);
    await tickSurvPlay(ignored);
  }
  assert.equal(JSON.stringify(dumpSurv(ignored)), JSON.stringify(dumpSurv(base)), '研究态 dumpSurv 必须逐位相同');
});
