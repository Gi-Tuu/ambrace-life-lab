// V7.3 第三批：玩家 busy 主动取消（只取消、不结算成果、时间不重复扣、事件幂等）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSurvPlay, dumpSurv, loadSurv, survAct, tickSurvPlay, survView } from './survplay.mjs';
import { move } from './body.mjs';
import { clockOf } from './resident-time.mjs';
import { CURRENT_EVENT_RULES } from './rng.mjs';

const GAME = {
  eventRulesVersion: CURRENT_EVENT_RULES, independentWorld: true, gameRules: true,
  residentialDecisions: true, unifiedCooperation: true, settlementLife: true,
  autonomousGoals: true, farmLife: true, regionalWork: true, ecosystem: true, wildFood: true,
};
const makeBusy = () => {
  const sp = createSurvPlay(7, GAME), w = sp.world;
  w.t = 10; move(w, 'p1', 'hall');
  w.survival.lastDay = Math.floor(w.t / 24);
  for (const room of ['yard', 'hall', 'yard', 'hall', 'yard', 'hall', 'yard']) {
    assert.ok(survAct(sp, { kind: 'move', room }).ok, '预热移动应成功');
  }
  w.survival.sites = [{ type: 'shelter', loc: 'yard', progress: 0 }];
  w.pinv.p1 = { wood: 5, stone: 5 };
  const start = survAct(sp, { kind: 'build' });
  assert.equal(start.code, 'BUSY_START', JSON.stringify(start));
  return { sp, w };
};

test('V73-08 busy 取消按钮后端：ok、busy 清空、cancelled 记账、事件只一次、时间不重复扣', () => {
  const { sp, w } = makeBusy();
  const clock = clockOf(w, 'p1');
  assert.equal(clock.tick.usedMin, 60, '本刻池应被前序动作 + 起手用满');
  const energy = w.agents.p1.drives.v.energy;
  assert.equal(survView(sp).player.busy?.remainMin, 5);
  const before = (w.survival.eventJournal?.rows ?? []).filter((e) => e.kind === 'player_action').length;
  const r = survAct(sp, { kind: 'busy_cancel' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.code, 'OK');
  assert.equal(clock.busy, null, '取消后 busy 必须释放');
  assert.equal(survView(sp).player.busy, null);
  assert.equal(clock.tick.usedMin, 60, '取消不得退还或重复扣本刻分钟');
  assert.equal(w.agents.p1.drives.v.energy, energy, '取消不结算体力');
  assert.equal(w.survival.sites[0].progress, 0, '取消不结算成果');
  assert.equal(w.survival.actionLedger.player.cancelled.build, 1, '账本写 cancelled');
  const events = (w.survival.eventJournal?.rows ?? []).filter((e) => e.kind === 'player_action');
  assert.equal(events.length, before + 1, '取消写一条 player_action');
  assert.equal(events.at(-1).status, 'cancelled');
  assert.equal(w.survival.lastPlayerAbort.code, 'CANCELLED');
});

test('V73-09 取消幂等：再取消返回 NO_BUSY，事件不再增加；tick 后也不会补结算', async () => {
  const { sp, w } = makeBusy();
  assert.equal(survAct(sp, { kind: 'busy_cancel' }).ok, true);
  const n = (w.survival.eventJournal?.rows ?? []).filter((e) => e.kind === 'player_action').length;
  const again = survAct(sp, { kind: 'busy_cancel' });
  assert.equal(again.ok, false);
  assert.equal(again.code, 'NO_BUSY');
  await tickSurvPlay(sp);
  assert.equal(w.survival.sites[0].progress, 0, '取消后下一拍不得补结算成果');
  assert.equal((w.survival.eventJournal?.rows ?? []).filter((e) => e.kind === 'player_action').length, n);
});

test('V73-10 没有 busy 时取消：NO_BUSY；研究态同样 NO_BUSY', () => {
  const sp = createSurvPlay(7, GAME), w = sp.world;
  w.t = 10;
  assert.equal(survAct(sp, { kind: 'busy_cancel' }).code, 'NO_BUSY');
  const research = createSurvPlay(7, { unifiedCooperation: true });
  research.world.t = 10;
  assert.equal(survAct(research, { kind: 'busy_cancel' }).code, 'NO_BUSY');
});

test('V73-11 取消不退还本刻分钟：随后动作仍 TIME_WAIT，体力不变', () => {
  const { sp, w } = makeBusy();
  const energy = w.agents.p1.drives.v.energy;
  assert.equal(survAct(sp, { kind: 'busy_cancel' }).ok, true);
  const r = survAct(sp, { kind: 'move', room: 'hall' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'TIME_WAIT', '取消不退分钟，本刻池仍是 60');
  assert.equal(w.agents.p1.drives.v.energy, energy, '取消不改变体力');
});

test('V73-12 旧档 busy 恢复后可取消，且只结算一次', async () => {
  const { sp, w } = makeBusy();
  const back = loadSurv(structuredClone(dumpSurv(sp)), 7, GAME);
  assert.ok(back.world.survival.actClock.p1.busy, 'busy 随档恢复');
  assert.equal(survAct(back, { kind: 'busy_cancel' }).ok, true);
  const evs = (back.world.survival.eventJournal?.rows ?? []).filter((e) => e.kind === 'player_action' && e.status === 'cancelled');
  assert.equal(evs.length, 1);
  await tickSurvPlay(back);
  assert.equal((back.world.survival.eventJournal?.rows ?? []).filter((e) => e.kind === 'player_action').length, 1);
});

