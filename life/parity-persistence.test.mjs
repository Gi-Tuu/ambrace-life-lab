// V7 阶段 C 闸门：存档规则一致性（SAV-02/03）与资源对等（RES-01/03）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSurvPlay, dumpSurv, loadSurv, survAct } from './survplay.mjs';
import { validate } from './rules.mjs';
import { advanceSurvival } from './worldstate.mjs';
import { CURRENT_EVENT_RULES, LEGACY_EVENT_RULES } from './rng.mjs';

const GAME = { independentWorld: true, gameRules: true, residentialDecisions: true, unifiedCooperation: true, settlementLife: true, autonomousGoals: true, farmLife: true, regionalWork: true, ecosystem: true, wildFood: true };

test('SAV-02 规则开关入档：读档以档内规则为准，不被当前 env 静默改写', () => {
  const d = dumpSurv(createSurvPlay(7, GAME));
  assert.equal(d.rules?.gameRules, true, 'dump 必须带规则开关');
  assert.equal(d.rules?.independentWorld, true);
  const back = loadSurv(structuredClone(d), 7, { ...GAME, gameRules: false, independentWorld: false, adoptArchivedRules: true });
  assert.equal(back.world.gameRules, true, '档内规则优先于 options');
  assert.equal(back.world.independentWorld, true);
  // 旧档没有 rules：退回 options（兼容）
  const legacy = structuredClone(d); delete legacy.rules;
  const old = loadSurv(legacy, 7, { ...GAME, gameRules: false });
  assert.equal(old.world.gameRules, false, '旧档按调用方配置载入');
});

test('SAV-03 旧档缺 eventRulesVersion：用调用方 CURRENT，不静默回落 LEGACY', () => {
  const d = dumpSurv(createSurvPlay(7, GAME));
  const legacy = structuredClone(d);
  delete legacy.eventRulesVersion;
  const back = loadSurv(legacy, 7, { ...GAME, eventRulesVersion: CURRENT_EVENT_RULES, adoptArchivedRules: true, upgradeLegacyEventRules: true });
  assert.equal(back.world.eventRulesVersion, CURRENT_EVENT_RULES, '不得回落 LEGACY');
  assert.notEqual(back.world.eventRulesVersion, LEGACY_EVENT_RULES);
  // 档内显式版本仍然优先
  const pinned = structuredClone(d);
  pinned.eventRulesVersion = LEGACY_EVENT_RULES;
  const b2 = loadSurv(pinned, 7, { ...GAME, eventRulesVersion: CURRENT_EVENT_RULES, adoptArchivedRules: true, upgradeLegacyEventRules: true });
  assert.equal(b2.world.eventRulesVersion, LEGACY_EVENT_RULES, '档内显式版本优先');
});

test('RES-03 玩家有开垦入口：进入规则层并真的开出一块田', async () => {
  const { nextFarmBed } = await import('./farmland.mjs');
  const sp = createSurvPlay(7, GAME);
  const w = sp.world;
  w.loc.p1 = 'garden';
  w.pinv.p1 = { ...(w.pinv.p1 ?? {}), wood: 5 };
  const s = w.survival;
  s.soil = 1; s.water = 1; s.drought = false; s.disasterToday = false; s.lastTilledDay = -1; w.weather = 'clear';
  const bed = nextFarmBed(w);
  assert.ok(bed, '夹具前提：应有一块可开垦的空地');
  const before = Object.keys(w.survival.plots ?? {}).length;
  const r = survAct(sp, { kind: 'till', plot: bed.id });
  assert.notEqual(r.code ?? r.error, 'UNKNOWN_KIND', 'till 必须进入规则层');
  assert.equal(r.ok, true, '玩家应能真的开垦，实测 ' + JSON.stringify(r));
  assert.equal(Object.keys(w.survival.plots ?? {}).length, before + 1);
});

test('RES-01 游戏态玩家也吃日界配给；研究态保持只给居民', () => {
  for (const gameRules of [true, false]) {
    const sp = createSurvPlay(7, { ...GAME, gameRules, independentWorld: gameRules });
    const w = sp.world;
    w.survival.playerRation = gameRules; // RES-01 显式开关（默认关，生产由 survivalOptions 打开）
    w.agents.p1.viab.v = 0.5;
    w.agents.a1.viab.v = 0.5;
    w.t = 24;
    advanceSurvival(w);
    assert.ok(w.agents.a1.viab.v > 0.5, '居民每日回补');
    if (gameRules) assert.ok(w.agents.p1.viab.v > 0.5, '游戏态玩家应同样回补');
    else assert.equal(w.agents.p1.viab.v, 0.5, '研究态玩家不回补（基线）');
  }
});
