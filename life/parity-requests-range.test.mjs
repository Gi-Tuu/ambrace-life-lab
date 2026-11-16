// V7.1 P1 闸门：请求的过期、距离、资源转移与存档保持。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CURRENT_EVENT_RULES } from './rng.mjs';
import { createSurvPlay, dumpSurv, loadSurv } from './survplay.mjs';
import { maybeResidentRequest, respondRequest, REQUEST_TTL } from './resident-requests.mjs';

const GAME = { eventRulesVersion: CURRENT_EVENT_RULES, independentWorld: true, gameRules: true, residentialDecisions: true, unifiedCooperation: true, settlementLife: true, autonomousGoals: true, farmLife: true, regionalWork: true, ecosystem: true, wildFood: true, playerRation: true };

function fixture() {
  const sp = createSurvPlay(7, GAME);
  const w = sp.world;
  w.loc.p1 = 'home'; w.loc.a1 = 'home';
  for (const id of ['a2', 'a3']) if (w.agents[id]) w.loc[id] = 'yard';
  w.pinv.p1 = { ...(w.pinv.p1 ?? {}), tray: 1, wood: 2 };
  w.survival.campContainers = { 'home:meal': { crop: 2 } };
  w.agents.a1.drives.v.energy = 0.2;
  w.agents.a1.viab.v = 0.5;
  return { sp, w };
}

test('REQ-01 过期请求不可兑现，且被清掉', () => {
  const { w } = fixture();
  const req = maybeResidentRequest(w);
  assert.ok(req);
  w.t += REQUEST_TTL + 1;
  const r = respondRequest(w, { id: req.id, accept: true });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'REQUEST_EXPIRED');
  assert.equal(w.survival.requests.length, 0);
});

test('REQ-02 远距离只能传话：不能交付资源，请求保留', () => {
  const { w } = fixture();
  const req = maybeResidentRequest(w);
  w.loc.p1 = 'yard';
  const r = respondRequest(w, { id: req.id, accept: true });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'TOO_FAR');
  assert.equal(w.survival.campContainers['home:meal'].crop, 2, '远距离不得扣资源');
  assert.equal(w.survival.requests.length, 1, '请求应保留，走回去还能回应');
  w.loc.p1 = 'home';
  const ok = respondRequest(w, { id: req.id, accept: true });
  assert.equal(ok.ok, true);
  assert.equal(w.survival.campContainers['home:meal'].crop, 1, '当面才交付');
});

test('REQ-03 存档恢复后请求仍在，并可正常回应', () => {
  const { w } = fixture();
  const req = maybeResidentRequest(w);
  const raw = structuredClone(dumpSurv({ world: w, log: [] }));
  const sp2 = loadSurv(raw, 7, GAME);
  const w2 = sp2.world;
  w2.loc.p1 = 'home'; w2.loc.a1 = 'home';
  assert.ok((w2.survival.requests ?? []).some((r) => r.id === req.id), '请求应随档恢复');
  const r = respondRequest(w2, { id: req.id, accept: false });
  assert.equal(r.code, 'DECLINED');
  assert.equal(w2.survival.requests.length, 0);
});

test('REQ-04 未回应请求：每人只留一条，过期自动清理（请求条不堆重复）', () => {
  const { w } = fixture();
  // 让 a1/a2/a3 都需要木料且同屋，连续 3 天各问一次
  for (const id of ['a2', 'a3']) if (w.agents[id]) { w.loc[id] = 'home'; w.pinv[id] = { wood: 0, stone: 0 }; w.pinv.p1.wood = 0; }
  for (let d = 0; d < 3; d += 1) {
    maybeResidentRequest(w);
    w.t += 24;
  }
  const froms = w.survival.requests.map((r) => r.from);
  assert.equal(new Set(froms).size, froms.length, '同一居民只应有一条未回应请求，实测 ' + JSON.stringify(froms));
  // 再过 49 刻（> TTL）：旧请求应被自动清掉
  w.t += 49;
  maybeResidentRequest(w);
  assert.ok(w.survival.requests.every((r) => w.t - r.t <= REQUEST_TTL), '过期请求必须被清理');
});