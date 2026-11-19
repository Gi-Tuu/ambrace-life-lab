// 主路径可读性的边界闸门：行数目标 + 模块职责 + 旧导出兼容。
// 这些断言先于拆分成文（当时红），拆分后必须保持绿；行为等价由原有 976 条闸门另行保证。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = (name) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');
const lineCount = (name) => src(name).split('\n').length;

test('SPLIT-01 host.mjs 只保留 facade：行数 < 900', () => {
  const n = lineCount('host.mjs');
  assert.ok(n < 900, `host.mjs 仍有 ${n} 行（目标 < 900）：拆分未完成或职责回流`);
});

test('SPLIT-02 survplay.mjs 只保留世界/推进/视图：行数 < 900', () => {
  const n = lineCount('survplay.mjs');
  assert.ok(n < 900, `survplay.mjs 仍有 ${n} 行（目标 < 900）：拆分未完成或职责回流`);
});

test('SPLIT-03 host 三个域模块存在，且只暴露工厂而不是第二份单例', async () => {
  const world = await import('./host-world.mjs');
  const model = await import('./host-model.mjs');
  const replay = await import('./host-replay.mjs');
  assert.equal(typeof world.createHostWorld, 'function');
  assert.equal(typeof model.createModelDomain, 'function');
  assert.equal(typeof replay.createReplayDomain, 'function');
  // 域模块不得反向 import host.mjs（否则又回到循环依赖）
  for (const name of ['host-world.mjs', 'host-model.mjs', 'host-replay.mjs']) {
    assert.ok(!/from ['"]\.\/host\.mjs['"]/.test(src(name)), `${name} 不得 import host.mjs`);
  }
});

test('SPLIT-04 survplay 三个域模块存在，且依赖方向单向', async () => {
  const camp = await import('./survplay-camp.mjs');
  const actions = await import('./survplay-actions.mjs');
  const save = await import('./survplay-save.mjs');
  assert.equal(typeof camp.survActInner, 'function');
  assert.equal(typeof camp.playerReach, 'function');
  assert.equal(typeof actions.createActionDomain, 'function');
  assert.equal(typeof save.createSaveDomain, 'function');
  for (const name of ['survplay-camp.mjs', 'survplay-actions.mjs', 'survplay-save.mjs']) {
    assert.ok(!/from ['"]\.\/survplay\.mjs['"]/.test(src(name)), `${name} 不得反向 import survplay.mjs`);
  }
  // camp 是最底层：actions 可以依赖它，它不能依赖 actions。
  assert.ok(!/from ['"]\.\/survplay-actions\.mjs['"]/.test(src('survplay-camp.mjs')), 'camp 不得 import actions');
});

test('SPLIT-05 host 原导出全部保留（facade re-export）', async () => {
  const host = await import('./host.mjs');
  for (const name of [
    'host', 'configure', 'sweepCamps', 'validCampKey', 'campViewerKeys', 'campSurv',
    'listCamps', 'campOwnerHash', 'claimCamp', 'openCamp', 'backToMainCamp',
    'survivalOptions', 'buildDeliberationPrompt', 'deliberationPrompt', 'flushWrites',
    'observerActive', 'isFreeProvider', 'modelLaneFor', 'modelGate', 'modelRelease',
    'modelChargeLane', 'modelCharged', 'modelChannel', 'breakerOpenAt', 'budgetTick',
    'pickProviderKey', 'DIMS_LIST',
  ]) assert.ok(name in host, `host.mjs 丢失导出 ${name}`);
});

test('SPLIT-06 survplay 原导出全部保留（facade re-export）', async () => {
  const surv = await import('./survplay.mjs');
  for (const name of [
    'createSurvPlay', 'setSurvivalDeliberator', 'settleSurvival', 'cancelPlayerBusy',
    'tickSurvPlay', 'PLAYER_TIME', 'playerTimeLeft', 'playerTimeMax', 'playerReach',
    'survAct', 'survView', 'DEATHS_CAP', 'trimDeaths', 'dumpSurv', 'loadSurv', 'sexOf',
  ]) assert.ok(name in surv, `survplay.mjs 丢失导出 ${name}`);
});
