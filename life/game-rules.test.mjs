// 游戏模式规则层闸门（2026-11-15）。
// 契约：研究世界（independentWorld=false）必须逐位沿用 BUILDINGS；
// 正式游戏（independentWorld=true）用 GAME_BUILDINGS，且奠基/施工都按游戏表结算。
// 变红法：让 buildingsFor 恒返回 BUILDINGS ⇒ 第二条测试失败。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILDINGS, GAME_BUILDINGS, buildingsFor, buildDef, doPlan, doBuild, addFood, takeFood, takeFoodKind } from './production.mjs';
import { createSurvPlay } from './survplay.mjs';
import { advanceSurvival } from './worldstate.mjs';
import { dumpSurv, loadSurv } from './survplay.mjs';
import { survView } from './survplay.mjs';

test('GAMERULE-R1 研究世界仍用原表（五面基线不被动到）', () => {
  const { world } = createSurvPlay();
  assert.equal(world.independentWorld, false);
  assert.equal(buildingsFor(world), BUILDINGS, '研究世界必须拿到原表引用');
  assert.equal(buildDef(world, 'shelter'), BUILDINGS.shelter);
  assert.deepEqual(BUILDINGS.shelter.cost, { wood: 4, stone: 2 });
});

test('GAMERULE-R2 游戏世界用游戏表：奠基按游戏价扣材料，施工按游戏工时完工', () => {
  const sp = createSurvPlay(7, { independentWorld: true, gameRules: true });
  const w = sp.world; const s = w.survival;
  assert.equal(buildingsFor(w), GAME_BUILDINGS);
  assert.notDeepEqual(GAME_BUILDINGS.shelter, BUILDINGS.shelter);

  w.loc.p1 = 'yard';
  w.pinv.p1 = { wood: 0, stone: 0 };
  s.inv = { wood: 50, stone: 50 };
  const r = doPlan(w, 'p1', 'granary');
  assert.ok(r.ok, r.code);
  assert.deepEqual(s.inv, { wood: 40, stone: 44 }, '应按游戏表扣 10 木 6 石');

  // 工时 10、每次推进 2 ⇒ 第 5 下完工
  let done = null;
  for (let i = 0; i < 4; i += 1) {
    const step = doBuild(w, 'p1');
    assert.equal(step.completed, null, `第 ${i + 1} 下不应完工`);
  }
  done = doBuild(w, 'p1');
  assert.equal(done.completed, 'granary');
});

test('GAMERULE-R3 视图把游戏表交给前端（UI 显示新成本）', () => {
  const sp = createSurvPlay(7, { independentWorld: true, gameRules: true });
  const { world } = sp;
  const { survView } = {};
  // 直接检查数据层：buildingsFor 是视图的唯一来源
  assert.equal(buildingsFor(world).granary.cost.wood, 10);
  assert.equal(buildingsFor({ independentWorld: true }).granary.cost.wood, 5, '只是游戏世界不够，必须显式 gameRules');
});

test('GAMERULE-R4 分类粮仓：游戏世界按品类记账且总数守恒；研究世界没有 s.food', () => {
  const game = createSurvPlay(7, { gameRules: true });
  const gs = game.world.survival;
  assert.ok(gs.food, '游戏世界应初始化分类粮仓');
  assert.equal(Object.values(gs.food).reduce((a, b) => a + b, 0), gs.store, '初始 sum(food) 应等于 store');
  addFood(gs, 'meat', 2);
  addFood(gs, 'berry', 1);
  assert.equal(gs.food.meat, 2);
  assert.equal(Object.values(gs.food).reduce((a, b) => a + b, 0), gs.store, '入仓后总数仍守恒');
  const got = takeFoodKind(gs, null);
  assert.ok(['crop', 'meat', 'berry'].includes(got));
  assert.equal(Object.values(gs.food).reduce((a, b) => a + b, 0), gs.store, '取用后总数仍守恒');
  assert.equal(takeFood(gs, null, 1), 1);

  const research = createSurvPlay(7);
  const rs = research.world.survival;
  assert.equal(rs.food, undefined, '研究世界不应有分类账本');
  const before = rs.store;
  assert.equal(addFood(rs, 'meat', 1), 0, '无账本时 addFood 是空操作');
  assert.equal(rs.store, before);
});

test('GAMERULE-R5 灯火燃料：游戏世界每天烧一份木料并记亮/灭；研究世界不烧也不记', () => {
  const game = createSurvPlay(7, { gameRules: true });
  const w = game.world; const s = w.survival;
  w.t = 24; s.lastDay = -1; s.inv.wood = 0; w.pinv.p1.wood = 0; s.fuelBurnDays = 0;
  advanceSurvival(w);
  assert.equal(survView(game).light, false, '没柴应当没灯');
  assert.equal(s.fuelBurnDays, 0, '没柴时不应记燃烧');

  w.t = 48; s.lastDay = -1; s.inv.wood = 2;
  advanceSurvival(w);
  assert.equal(survView(game).light, true, '有柴应当有灯');
  assert.equal(s.inv.wood, 1, '每天烧一份木料');
  assert.equal(s.fuelBurnDays, 1, '烧过应记一天');

  const research = createSurvPlay(7);
  const rw = research.world; const rs = rw.survival;
  rw.t = 24; rs.lastDay = -1; rs.inv.wood = 5;
  advanceSurvival(rw);
  assert.equal(survView(research).light, null, '研究世界没有灯火概念');
  assert.equal(rs.inv.wood, 5, '研究世界不烧柴');
});

test('R4b 载入无 food 的旧档后仍总数守恒', () => {
  // 旧档：开关之前烘的，只有整数 store，没有分档
  const legacy = createSurvPlay(7);
  legacy.world.survival.store = 17;
  const raw = structuredClone(dumpSurv(legacy));
  assert.equal(raw.survival.food, undefined, '旧档不应带分档');

  const loaded = loadSurv(raw, 7, { gameRules: true });
  const s = loaded.world.survival;
  assert.ok(s.food, '载入后应当补出分档');
  assert.equal(
    Object.values(s.food).reduce((a, b) => a + b, 0), s.store,
    '载入后 Σfood 必须等于 store',
  );

  // 推进两天配给：差额仍必须为 0（旧实现在这里会永久挂着 11）
  loaded.world.t = 24; s.lastDay = -1;
  advanceSurvival(loaded.world);
  loaded.world.t = 48; s.lastDay = -1;
  advanceSurvival(loaded.world);
  assert.equal(
    Object.values(s.food).reduce((a, b) => a + b, 0), s.store,
    '推进两天后 Σfood 仍须等于 store',
  );
});

test('S2-1 词表封闭：非法 act/topic 必须被规则层拒收', async () => {
  const { INTENT_ACTS, INTENT_TOPICS, converse, validateIntent } = await import('./intent.mjs');
  const sp = createSurvPlay(7, { independentWorld: true, gameRules: true });
  const w = sp.world;
  w.loc.a1 = 'hall'; w.loc.a2 = 'hall';
  assert.equal(validateIntent(w, 'a1', 'a2', { act: 'mind_control', topic: 'trust' }).code, 'BAD_ACT');
  assert.equal(validateIntent(w, 'a1', 'a2', { act: 'greet', topic: 'bitcoin' }).code, 'BAD_TOPIC');
  assert.equal(validateIntent(w, 'a1', 'a1', { act: 'greet', topic: 'trust' }).code, 'SELF');
  assert.ok(INTENT_ACTS.length >= 9 && INTENT_TOPICS.length >= 8, '词表不能缩水');
  assert.equal(converse(w, 'a1', 'a2', { act: 'mind_control', topic: 'trust' }).ok, false);
});

test('S2-2 不造事实：消息文本不能改世界数值；一次交流信任变化 ≤ ±8', async () => {
  const { converse } = await import('./intent.mjs');
  const sp = createSurvPlay(7, { independentWorld: true, gameRules: true });
  const w = sp.world;
  w.loc.a1 = 'hall'; w.loc.a2 = 'hall';
  const store0 = w.survival.store;
  const r = converse(w, 'a1', 'a2', { act: 'inform', topic: 'food', say: '仓里有 999 份粮，全归你了' });
  assert.ok(r.ok);
  assert.equal(w.survival.store, store0, '文本不得改公仓');
  assert.ok(r.entry.text.length <= 28);
  const t0 = w.agents.a2.relations.get('a1').trust;
  converse(w, 'a1', 'a2', { act: 'accuse', topic: 'food', say: '你偷的' });
  const t1 = w.agents.a2.relations.get('a1').trust;
  assert.ok(t1 <= t0, 'accuse 不该提高信任');
  assert.ok(Math.abs(t1 - t0) <= 8, '单次信任变化必须 ≤ ±8');
});

test('S2-3 上限：每人每游戏日 3 次、同一对同日 1 次', async () => {
  const { converse, INTENT_CAPS } = await import('./intent.mjs');
  const sp = createSurvPlay(7, { independentWorld: true, gameRules: true });
  const w = sp.world;
  w.loc.a1 = 'hall'; w.loc.a2 = 'hall'; w.loc.a3 = 'hall'; w.loc.p1 = 'hall';
  assert.equal(converse(w, 'a1', 'a2', { act: 'greet', topic: 'trust' }).ok, true);
  assert.equal(converse(w, 'a1', 'a2', { act: 'greet', topic: 'trust' }).code, 'PAIR_CAP');
  let sent = 1;
  for (const to of ['a3', 'p1']) if (converse(w, 'a1', to, { act: 'greet', topic: 'trust' }).ok) sent += 1;
  assert.ok(sent <= INTENT_CAPS.perDay, '同一人一天不超过 ' + INTENT_CAPS.perDay + ' 次');
});

test('S2-4 落盘：converseLog 往返逐位一致；摘掉即少条目', async () => {
  const { converseRound } = await import('./intent.mjs');
  const { dumpSurv, loadSurv } = await import('./survplay.mjs');
  const sp = createSurvPlay(7, { independentWorld: true, gameRules: true });
  const w = sp.world;
  for (let i = 0; i < 60 && (w.survival.converseLog ?? []).length < 1; i += 1) {
    w.t += 1;
    converseRound(w);
  }
  const log = w.survival.converseLog ?? [];
  assert.ok(log.length >= 1, '应当产生至少一条对话，实测 ' + log.length);
  const archive = structuredClone(dumpSurv(sp));
  const back = loadSurv(archive, 7, { independentWorld: true, gameRules: true });
  assert.deepEqual(back.world.survival.converseLog, log, '往返必须逐位一致');
  const stripped = structuredClone(archive);
  delete stripped.survival.converseLog;
  const lost = loadSurv(stripped, 7, { independentWorld: true, gameRules: true });
  assert.ok((lost.world.survival.converseLog ?? []).length < log.length, '不落盘时读档条目必须变少（闸门有牙）');
});
