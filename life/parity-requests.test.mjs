// SOC-01 闸门：居民主动请求 + 玩家接受/拒绝的真实后果；每居民每日最多一次。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSurvPlay, survAct } from './survplay.mjs';
import { maybeResidentRequest } from './resident-requests.mjs';

const GAME = { independentWorld: true, gameRules: true, residentialDecisions: true, unifiedCooperation: true, settlementLife: true, autonomousGoals: true, farmLife: true, regionalWork: true, ecosystem: true, wildFood: true };

function fixture() {
  const sp = createSurvPlay(7, GAME);
  const w = sp.world;
  w.loc.p1 = 'home';
  w.loc.a1 = 'home';
  w.occupancy.home = ['p1', 'a1'];
  w.campPlayerRoom = 'home';
  w.pinv.p1 = { ...(w.pinv.p1 ?? {}), tray: 1, wood: 1 };
  w.survival.campContainers = { 'home:meal': { crop: 2 } };
  for (const id of ['a2', 'a3']) if (w.agents[id]) w.loc[id] = 'yard'; // 只有 a1 与玩家同屋
  w.agents.a1.drives.v.energy = 0.3;
  w.agents.a1.viab.v = 0.5; // 否则 regen 会被上限吃掉，测不出回补
  w.agents.a1.pinv = w.pinv.a1 = { wood: 0, stone: 0 };
  return { sp, w };
}

test('SOC-01 居民请求食物：玩家接受 ⇒ 扣餐台食物、居民回补、信任+3', () => {
  const { sp, w } = fixture();
  const req = maybeResidentRequest(w);
  assert.ok(req, '居民应主动请求');
  assert.equal(req.kind, 'food');
  assert.equal(w.survival.requests.length, 1);
  assert.equal(maybeResidentRequest(w), null, '同一居民每日最多一次');

  const before = { food: w.survival.campContainers['home:meal'].crop, viab: w.agents.a1.viab.v, trust: w.agents.a1.relations.get('p1').trust };
  const r = survAct(sp, { kind: 'respond_request', id: req.id, accept: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.code, 'ACCEPTED');
  assert.equal(w.survival.campContainers['home:meal'].crop, before.food - 1, '必须真的扣一份食物');
  assert.ok(w.agents.a1.viab.v > before.viab, '居民必须真的回补');
  assert.ok(w.agents.a1.relations.get('p1').trust > before.trust, '接受应加信任');
  assert.equal(w.survival.requests.length, 0, '回应后请求应清掉');
});

test('SOC-01-WOOD-REJECT 居民请求木料被拒：扣信任、请求清掉、资源不动', () => {
  const { sp, w } = fixture();
  w.agents.a1.drives.v.energy = 0.9;
  w.agents.a1.pinv.wood = 0;
  const req = maybeResidentRequest(w);
  assert.ok(req, '不饿但没有木料也应开口');
  assert.equal(req.kind, 'material');
  const before = { wood: w.pinv.p1.wood, trust: w.agents.a1.relations.get('p1').trust };
  const r = survAct(sp, { kind: 'respond_request', id: req.id, accept: false });
  assert.equal(r.code, 'DECLINED');
  assert.equal(w.pinv.p1.wood, before.wood, '拒绝不得转走木料');
  assert.ok(w.agents.a1.relations.get('p1').trust < before.trust, '拒绝应扣信任');
  assert.equal(w.survival.requests.length, 0);
});

test('SOC-01-WOOD-ACCEPT 接受木料请求：玩家背包少 1、居民背包多 1', () => {
  const { sp, w } = fixture();
  w.agents.a1.drives.v.energy = 0.9;
  w.agents.a1.pinv.wood = 0;
  const req = maybeResidentRequest(w);
  const r = survAct(sp, { kind: 'respond_request', id: req.id, accept: true });
  assert.equal(r.code, 'ACCEPTED');
  assert.equal(w.pinv.p1.wood, 0);
  assert.equal(w.pinv.a1.wood, 1);
});

test('SOC-01-TABLE-REQUIRED 分食需要实际在可使用的居所餐台，失败保留请求和食物', () => {
  const { sp, w } = fixture();
  const req = maybeResidentRequest(w);
  const accept = () => survAct(sp, { kind: 'respond_request', id: req.id, accept: true });
  assert.equal(survAct(sp, { kind: 'camp_exit' }).ok, true);
  assert.equal(w.loc.p1, 'home', '退出后逻辑地点保留，室内状态已清空');
  assert.equal(accept().code, 'NOT_HOME');
  assert.equal(w.survival.campContainers['home:meal'].crop, 2);
  assert.equal(w.survival.requests.length, 1);

  const guestRoom = w.housing.a1;
  w.loc.p1 = w.campPlayerRoom = guestRoom;
  w.survival.campContainers[guestRoom + ':meal'] = { crop: 2 };
  assert.equal(accept().code, 'NOT_HOME');
  assert.equal(w.survival.campContainers[guestRoom + ':meal'].crop, 2);
  assert.equal(w.survival.requests.length, 1);
});
