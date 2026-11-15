// 公开演示起点闸门：创空间镜像里没有持久卷，`seed/world.json` 就是每个访客看到的第一个世界。
// 2026-11-15 实测过一次事故：档案里只有 A/B 研究世界，没有 survival 块 ⇒ 每次重新部署，
// 玩家能看见的营地都回到第 1 天 3 个人，而手记写的是"世界在你来之前就在运转"。这一条打红就不要再上线。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { loadSurv } from './survplay.mjs';
import { CURRENT_EVENT_RULES } from './rng.mjs';

const SEED_URL = new URL('../seed/world.json', import.meta.url);
const raw = JSON.parse(readFileSync(SEED_URL, 'utf8'));
// 与 host.survivalOptions() 同集合：种子档要能在正式游戏配置下装回来，不是只在测试里能装。
const OPTIONS = {
  residentialDecisions: true, eventRulesVersion: CURRENT_EVENT_RULES, ecosystem: true,
  unifiedCooperation: true, independentWorld: true, wildFood: true, autonomousGoals: true,
  farmLife: true, settlementLife: true, regionalWork: true, discussions: true
};

// 营地"活过一段时间"的最低读数。阈值取保守值：将来重跑种子只要还达标就不必改闸门。
// playerAlive 是 2026-11-15 实抓的事故：无玩家操作的轨迹会让化身同权饿死，
// 烘出来的起点若不带这条，公开实例一进去就是"你已倒下"。
const campFacts = (a) => {
  const s = a?.survival;
  const minds = s?.minds ?? {};
  const living = Object.entries(minds).filter(([id, m]) => id !== 'p1' && m && !m.dead).length;
  const p1 = minds.p1;
  return {
    hasCamp: Boolean(s) && Number.isSafeInteger(s.t) && s.t > 0,
    notEnded: s?.survival?.ended !== true,
    population: living >= 3,
    food: Number(s?.survival?.store) > 0,
    built: Object.keys(s?.survival?.buildings ?? {}).length >= 3,
    researchStart: a?.A?.world?.t === 600 && a?.B?.world?.t === 600,
    playerAlive: Boolean(p1) && !p1.dead && Number(p1.viab?.v) >= 0.9 && s?.survival?.playerDead !== true,
    playerPlaced: Boolean(s?.loc?.p1) && (s?.occupancy?.[s.loc.p1] ?? []).includes('p1')
  };
};

test('种子档带营地世界，且能在正式配置下装回同一个世界', () => {
  const facts = campFacts(raw);
  for (const [name, ok] of Object.entries(facts)) assert.ok(ok, `种子档不合格：${name}`);
  const sp = loadSurv(structuredClone(raw.survival), raw.seed ?? 7, OPTIONS);
  const w = sp.world;
  assert.equal(w.t, raw.survival.t, '装回后的刻数必须与档案一致');
  assert.equal(w.survival.store, raw.survival.survival.store, '公仓必须逐位往返');
  assert.equal(Object.keys(w.agents).length, Object.keys(raw.survival.minds).length, '在世与已故居民都要装回来');
  assert.notEqual(w.survival.ended, true);
  const p1 = w.agents.p1;
  assert.ok(p1 && !p1.dead && p1.viab.v >= 0.9, '装回来的玩家必须是活着的新到者');
  assert.equal(w.survival.playerDead, false);
});

test('负向对照：缺 survival 块、营地已终局或玩家一进场就死，同一谓词必须判红', () => {
  assert.equal(campFacts({ ...raw, survival: undefined }).hasCamp, false, '删掉营地世界必须红');
  const dead = structuredClone(raw);
  dead.survival.survival.ended = true;
  assert.equal(campFacts(dead).notEnded, false, '终局营地必须红');
  const starved = structuredClone(raw);
  starved.survival.survival.store = 0;
  assert.equal(campFacts(starved).food, false, '空仓起点必须红');
  const deadPlayer = structuredClone(raw);
  deadPlayer.survival.minds.p1.dead = true;
  deadPlayer.survival.minds.p1.viab.v = 0;
  assert.equal(campFacts(deadPlayer).playerAlive, false, '化身已死的起点必须红');
  const misplaced = structuredClone(raw);
  misplaced.survival.occupancy[misplaced.survival.loc.p1] = [];
  assert.equal(campFacts(misplaced).playerPlaced, false, '玩家不在任何占用表里必须红');
});
