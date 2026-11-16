// V7.1 §5.10 闸门：居民之间的木料请求——同屋、信任、过期、真实转移。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CURRENT_EVENT_RULES } from './rng.mjs';
import { createSurvPlay } from './survplay.mjs';
import { maybePeerRequest, stepPeerRequests, PEER_REQUEST_TTL } from './resident-requests.mjs';

const GAME = { eventRulesVersion: CURRENT_EVENT_RULES, independentWorld: true, gameRules: true, residentialDecisions: true, unifiedCooperation: true, settlementLife: true, autonomousGoals: true, farmLife: true, regionalWork: true, ecosystem: true, wildFood: true, playerRation: true };

function fixture() {
  const sp = createSurvPlay(7, GAME);
  const w = sp.world;
  w.loc.p1 = 'hall';
  w.loc.a1 = 'home'; w.loc.a2 = 'home';
  if (w.agents.a3) w.loc.a3 = 'yard';
  w.pinv.a1 = { wood: 0, stone: 0 };
  w.pinv.a2 = { wood: 2, stone: 0 };
  w.agents.a1.relations.meet('a2', w.t, { delta: { trust: 45, familiarity: 0.5 } });
  w.agents.a2.relations.meet('a1', w.t, { delta: { trust: 40, familiarity: 0.5 } });
  return { sp, w };
}

test('PEER-01 同屋 + 信任够：居民之间可以借到木料，且双方关系变化', () => {
  const { w } = fixture();
  const req = maybePeerRequest(w);
  assert.ok(req, '应产生居民间请求');
  assert.equal(req.from, 'a1');
  assert.equal(req.to, 'a2');
  stepPeerRequests(w);
  assert.equal(w.pinv.a2.wood, 1, '出借方少一根');
  assert.equal(w.pinv.a1.wood, 1, '借用方多一根');
  assert.equal(w.survival.peerRequestsGranted, 1);
});

test('PEER-02 信任不足：拒绝，不转移，并轻微扣信任', () => {
  const { w } = fixture();
  w.agents.a2.relations.get('a1').trust = 10; // 直接压到拒绝线以下
  const req = maybePeerRequest(w);
  assert.ok(req);
  const before = w.agents.a1.relations.get('a2').trust;
  stepPeerRequests(w);
  assert.equal(w.pinv.a2.wood, 2, '拒绝不得转移');
  assert.equal(w.survival.peerRequestsRefused, 1);
  assert.ok(w.agents.a1.relations.get('a2').trust < before, '拒绝应扣一点信任');
});

test('PEER-03 过期：隔空不交付，过期后清掉', () => {
  const { w } = fixture();
  const req = maybePeerRequest(w);
  w.loc.a1 = 'yard'; // 走散
  w.t += PEER_REQUEST_TTL + 1;
  stepPeerRequests(w);
  assert.equal(w.pinv.a2.wood, 2, '过期不得补交付');
  assert.equal(w.survival.peerRequests.length, 0, '过期应清掉');
  assert.equal(w.survival.peerRequestsExpired, 1);
});
