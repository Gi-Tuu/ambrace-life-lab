import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSurvPlay, tickSurvPlay, dumpSurv, loadSurv } from './survplay.mjs';
import { affordancesFor, move, scanSecrets, SURV_COST } from './body.mjs';
import { PARAMS } from './params.mjs';

function fixture(unifiedCooperation = true) {
  const p = createSurvPlay(7, { unifiedCooperation });
  const w = p.world;
  move(w, 'a1', 'yard');
  w.survival.sites.push({ type: 'shelter', loc: 'yard', progress: 0 });
  w.survival.coop.task = { type: 'shelter', loc: 'yard', workers: ['a1'],
    phase: 'build', severity: .9, commit: { a1: 'assist' } };
  return p;
}
const buildFor = w => affordancesFor(w, 'a1').find(a => a.id === 'build');

test('T17/T18 合作调度不做工，每人每刻只有一次行动，普通和合作施工同价', () => {
  const w = fixture().world;
  w.t = 1;
  scanSecrets(w);
  assert.equal(w.survival.sites[0].progress, 0);
  const a = w.agents.a1, before = a.viab.v;
  const build = buildFor(w);
  assert.equal(build.cooperation, true);
  assert.ok(a.execute(w, build, 'deliberation', w.t, false).ok);
  assert.equal(a.execute(w, { ...build, cooperation: false }, 'deliberation', w.t, false), null);
  assert.equal(w.survival.sites[0].progress, 2);
  assert.ok(Math.abs(before - a.viab.v - SURV_COST.build * PARAMS.viab.costScale) < 1e-12);
  const fresh = fixture().world;
  fresh.survival.coop.enabled = false;
  assert.ok(fresh.agents.a1.execute(fresh, buildFor(fresh), 'deliberation', 0, false).ok);
  assert.equal(fresh.agents.a1.viab.v, a.viab.v);
});

test('T19 合作经过正常决策、记账与习惯学习，读档同一刻仍不能重复施工', async () => {
  const p = fixture(), w = p.world;
  let learned;
  for (let i = 0; i < 60 && !learned; i += 1) {
    await tickSurvPlay(p);
    learned = w.survival.actionAudit?.a1?.cooperation?.build;
  }
  assert.ok(learned, '常规自主循环应选中过合作施工');
  assert.ok(w.agents.a1.habit.count('build') >= learned);
  const last = w.agents.a1.trace.findLast(row => row.kind === 'build' && row.ok);
  assert.ok(last.parts?.合作收益 > 0);
  const loaded = loadSurv(structuredClone(dumpSurv(p)), 7, { unifiedCooperation: true }).world;
  assert.equal(loaded.agents.a1.habit.count('build'), w.agents.a1.habit.count('build'));
  const a = loaded.agents.a1;
  assert.equal(a.execute(loaded, { kind: 'rest' }, 'deliberation', loaded.t, false), null);
});

test('T20 接受过协助的居民过度疲劳也退出，仍能正常自主行动', async () => {
  const p = fixture(), w = p.world;
  const a = w.agents.a1;
  w.survival.lastDay = 0;
  a.drives.v.energy = .1;
  w.survival.coop.task.requester = 'p1';
  await tickSurvPlay(p);
  assert.equal(w.survival.coop.exits, 1);
  assert.ok(!w.survival.coop.task?.workers.includes('a1'));
  assert.equal(a.counters.actions, 1);
  assert.equal(w.survival.actionAudit?.a1?.cooperation.build, undefined);
});
