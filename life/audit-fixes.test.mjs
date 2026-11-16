// 审计修复闸门（数据/请求/配给）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CURRENT_EVENT_RULES } from './rng.mjs';
import { createSurvPlay, dumpSurv, loadSurv } from './survplay.mjs';
import { CampInstances, validCampArchive, readIndex } from './camp-instances.mjs';
import { maybeResidentRequest, respondRequest } from './resident-requests.mjs';
import { advanceSurvival } from './worldstate.mjs';

const GAME = { eventRulesVersion: CURRENT_EVENT_RULES, independentWorld: true, gameRules: true, residentialDecisions: true, unifiedCooperation: true, settlementLife: true, autonomousGoals: true, farmLife: true, regionalWork: true, ecosystem: true, wildFood: true, playerRation: true };
const SEED = JSON.parse(readFileSync(new URL('../seed/world.json', import.meta.url), 'utf8')).survival;

test('DATA-01 分名字营地重载后 districts/规则不丢', () => {
  const dir = mkdtempSync(join(tmpdir(), 'camp-'));
  const opts = { ...GAME, adoptArchivedRules: true };
  const m1 = new CampInstances({ dataDir: dir, options: opts, seedSurvival: SEED, limit: 3 });
  const a = m1.open('甲');
  const before = Object.keys(a.sp.world.districts ?? {}).length;
  assert.ok(before > 0);
  m1.persist();
  const m2 = new CampInstances({ dataDir: dir, options: opts, seedSurvival: SEED, limit: 3 });
  const b = m2.open('甲');
  assert.equal(Object.keys(b.sp.world.districts ?? {}).length, before, '重载后地区数应保持');
  assert.equal(b.sp.world.survival.settlementLife, true);
});

test('DATA-01 dump 的 rules 必须反映真实开关', () => {
  const sp = createSurvPlay(7, GAME);
  const d = dumpSurv(sp);
  assert.equal(d.rules.settlementLife, true);
  assert.equal(d.rules.farmLife, true);
  assert.equal(d.rules.ecosystem, true);
  assert.equal(d.rules.regionalWork, true);
});

test('DATA-02 主档式载入也采纳档内 gameRules，不被 env 降级', () => {
  const sp = createSurvPlay(7, GAME);
  const d = dumpSurv(sp);
  const loaded = loadSurv(structuredClone(d), 7, { ...GAME, gameRules: false, adoptArchivedRules: true });
  assert.equal(loaded.world.gameRules, true, '档内规则优先');
});

test('DATA-06 形状残缺的档必须拒收', () => {
  assert.equal(validCampArchive({ t: 0, minds: { p1: {} }, survival: {} }), false);
  assert.equal(validCampArchive({ t: 0, minds: { p1: { m: {}, drives: {}, viab: {} } }, survival: {} }), false);
  assert.equal(validCampArchive(SEED), true, '真实种子档仍应通过');
});

test('DATA-04 索引损坏不抛死：坏索引被备份，服务继续', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idx-'));
  mkdirSync(join(dir, 'saves'), { recursive: true });
  writeFileSync(join(dir, 'saves', 'index.json'), '{坏索引', 'utf8');
  const idx = readIndex(dir);
  assert.deepEqual(idx.entries, []);
  assert.equal(existsSync(join(dir, 'saves', 'index.json')), false, '坏索引应被移走备份');
  assert.deepEqual(readIndex(dir).entries, []);
});

test('LIFE-07 mealDay 入档：读档后同一天不能再吃', () => {
  const sp = createSurvPlay(7, GAME);
  const w = sp.world;
  w.loc.a1 = 'store'; w.agents.a1.mealDay = 2; w.survival.store = 5;
  const d = dumpSurv(sp);
  const sp2 = loadSurv(structuredClone(d), 7, GAME);
  assert.equal(sp2.world.agents.a1.mealDay, 2);
});

test('LIFE-05 玩家配给：不占配给就不回补', () => {
  const off = createSurvPlay(7, { ...GAME, playerRation: false });
  off.world.survival.playerEats = true; // 旧字段不应在游戏态单方面生效
  off.world.agents.p1.viab.v = 0.5;
  off.world.t = 24;
  const viabOff = off.world.agents.p1.viab.v;
  advanceSurvival(off.world);
  assert.equal(off.world.agents.p1.viab.v, viabOff, '不占配给就不应回补');
});

test('LIFE-03 玩家死后不再生成请求；在途请求者不能隔空交付', () => {
  const sp = createSurvPlay(7, GAME);
  const w = sp.world;
  w.loc.p1 = 'home'; w.loc.a1 = 'home';
  w.agents.a1.drives.v.energy = 0.2;
  w.pinv.p1 = { wood: 2, tray: 0 };
  w.survival.campContainers = { 'home:meal': { crop: 1 } };
  const req = maybeResidentRequest(w);
  assert.ok(req);
  w.survival.districtTravel = { [req.from]: 'district-north' };
  const r = respondRequest(w, { id: req.id, accept: true });
  assert.equal(r.code, 'REQUESTER_AWAY');
  w.survival.districtTravel = {};
  w.agents.p1.dead = true;
  assert.equal(maybeResidentRequest(w), null);
});
