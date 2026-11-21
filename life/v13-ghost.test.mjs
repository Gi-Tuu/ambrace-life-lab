// 1.3 幽魂观察：死亡不是终局，只有聚落灭绝才是。
// 覆盖：幽灵状态/动作全拒/世界继续/存档往返/灭绝持久/研究态不变。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSurvPlay, survAct, survView, tickSurvPlay, dumpSurv, loadSurv, settleSurvival } from './survplay.mjs';
import { advanceSurvival } from './worldstate.mjs';
import { createSimClock } from './sim-clock.mjs';
import { CURRENT_EVENT_RULES } from './rng.mjs';
import { ghostView } from './ghost.mjs';
import { playerReach } from './survplay-camp.mjs';
import { dayOf } from './clock.mjs';

const FORMAL = {
  independentWorld: true, gameRules: true, residentialDecisions: true, unifiedCooperation: true,
  settlementLife: true, autonomousGoals: true, farmLife: true, regionalWork: true, ecosystem: true,
  wildFood: true, playerRation: true, wildExpansion: true, eventRulesVersion: CURRENT_EVENT_RULES,
  simTime: true, minuteMetab: true,
};
const LOAD = { ...FORMAL };
delete LOAD.simClock;

function formal(seed = 7, extra = {}) {
  const clock = extra.simClock ?? createSimClock({ startMinutes: extra.startMinutes ?? 0 });
  const options = { ...FORMAL, ...extra };
  delete options.startMinutes;
  return createSurvPlay(seed, { ...options, simClock: clock });
}
function killPlayer(sp) {
  sp.world.agents.p1.viab.v = 0;
  return settleSurvival(sp);
}
const roundtrip = (sp, options = LOAD) => loadSurv(JSON.parse(JSON.stringify(dumpSurv(sp))), 7, options);

test('GHOST-01 玩家死亡 → 幽魂观察，不是终局；镜头锚点/占位/忙碌动作都被收口', () => {
  const sp = formal(7, { startMinutes: 240 });
  const w = sp.world, s = w.survival;
  const before = survView(sp);
  assert.equal(before.player.dead, false);
  assert.equal(before.ghost.active, false);
  assert.equal(s.ended, false);

  s.actClock.p1.busy = { id: 'p1:house_work:x', kind: 'house_work', remainMin: 12, totalMin: 15, status: 'running' };
  const at0 = { ...w.pos.p1 };
  killPlayer(sp);

  assert.equal(w.agents.p1.dead, true, '玩家应被标记死亡');
  assert.equal(s.playerDead, true);
  assert.equal(s.ghost.active, true, '正式世界死亡应进入幽魂状态');
  assert.ok(Number.isFinite(s.ghost.at?.x) && Number.isFinite(s.ghost.at?.z), `幽魂镜头锚点应是世界坐标：${JSON.stringify(s.ghost.at)}`);
  assert.ok(Math.abs(s.ghost.at.x - at0.x) < 1e-9 && Math.abs(s.ghost.at.z - at0.z) < 1e-9, '锚点应取死时脚点');
  assert.equal(s.failed, false, '玩家死亡不得再置 failed');
  assert.equal(s.endReason, null, '玩家死亡不得再写 endReason=player');
  assert.equal(s.ended, false, '玩家死亡不得结束游戏');
  assert.equal(s.actClock.p1.busy, null, '死前排进时间轴的长动作必须当刻取消');

  const view = survView(sp);
  assert.equal(view.player.dead, true);
  assert.equal(view.player.result, 'dead');
  assert.equal(view.player.ghost, true);
  assert.equal(view.ghost.active, true);
  assert.equal(view.ghost.observing, true);
  assert.equal(view.settlement, 'active', '聚落未灭绝时应仍是 active');
  assert.ok(!(w.occupancy[w.loc.p1] ?? []).includes('p1'), '玩家应移出占位（不再被感知/交谈）');
});

test('GHOST-02 幽魂动作全被拒：采集/建造/吃/睡/交易/移动实体/player_sync 都不写世界', () => {
  const sp = formal(7, { startMinutes: 240 });
  const w = sp.world, s = w.survival;
  killPlayer(sp);
  const state0 = JSON.stringify({ pos: w.pos.p1, playerPos: s.playerPos, store: s.store, inv: s.inv, pinv: w.pinv.p1, sites: s.sites, buildings: s.buildings, clock: s.actClock?.p1 });
  const kinds = ['move', 'gather', 'plant', 'harvest', 'build', 'repair', 'plan', 'camp_eat', 'camp_sleep',
    'camp_store', 'camp_take', 'facility_use', 'animal_feed', 'animal_slaughter', 'exchange', 'expand',
    'house_work', 'home_claim', 'family_marry', 'player_sync'];
  for (const kind of kinds) {
    const r = survAct(sp, { kind, room: 'yard', type: 'shelter', target: 'a1', from: [80, 40] });
    assert.equal(r.ok, false, `${kind} 在幽魂态必须被拒：${JSON.stringify(r)}`);
    assert.equal(r.code, 'PLAYER_DEAD', `${kind} 的拒绝码应为 PLAYER_DEAD，实测 ${r.code}`);
  }
  assert.equal(JSON.stringify({ pos: w.pos.p1, playerPos: s.playerPos, store: s.store, inv: s.inv, pinv: w.pinv.p1, sites: s.sites, buildings: s.buildings, clock: s.actClock?.p1 }), state0, '幽魂动作不得写世界状态');
  assert.equal(s.actClock.p1.busy, null, '幽魂不得开始新的长动作');

  // 第二道闸门：即便调用方绕过 survAct，位置写入口也拒绝。
  const reach = playerReach(w, [90, 45], 'player_sync');
  assert.equal(reach.ok, false);
  assert.equal(reach.code, 'PLAYER_DEAD');
  assert.deepEqual(w.pos.p1, JSON.parse(state0).pos, 'playerReach 不得写 w.pos.p1');
});

test('GHOST-03 死亡后 10 游戏分世界仍推进，居民仍行动（含跨整点世界重结算）', async () => {
  const sp = formal(7, { startMinutes: 55 });
  const w = sp.world, s = w.survival;
  killPlayer(sp);
  const view0 = survView(sp);
  const beforeActions = JSON.stringify(Object.fromEntries(Object.entries(w.agents).filter(([id]) => id !== 'p1').map(([id, a]) => [id, a.counters?.actions ?? 0])));
  const startMin = view0.gameMinutes;
  assert.ok(startMin >= 55 && startMin < 56, `起点应在第 55 游戏分附近：${startMin}`);
  assert.equal(w.survival.lastDay, -1, '整点重结算还没跑过');

  await tickSurvPlay(sp, { minutes: 10 });
  const view1 = survView(sp);
  assert.ok(Math.abs(view1.gameMinutes - (startMin + 10)) < 0.01, `死亡后 10 游戏分世界时钟必须继续走：${startMin} → ${view1.gameMinutes}`);
  assert.equal(w.t, 1, '跨过整点后 w.t 应派生为 1');
  assert.equal(s.lastDay, dayOf(w.t), '整点世界重结算应真的跑过（日界账）');
  assert.notEqual(w.weather, null, '世界应继续推进天气');
  const afterActions = JSON.stringify(Object.fromEntries(Object.entries(w.agents).filter(([id]) => id !== 'p1').map(([id, a]) => [id, a.counters?.actions ?? 0])));
  assert.notEqual(afterActions, beforeActions, `死亡后居民仍应继续行动（动作计数未变：${afterActions}）`);
  assert.equal(view1.ghost.active, true, '幽魂状态应跨 tick 保持');
});

test('GHOST-04 幽魂与灭绝都随存档往返；旧档缺 ghost 字段可按死亡事实补齐', () => {
  const sp = formal(7, { startMinutes: 240 });
  killPlayer(sp);
  const at = { ...sp.world.survival.ghost.at };
  const back = roundtrip(sp);
  const bv = survView(back);
  assert.equal(back.world.survival.playerDead, true);
  assert.equal(back.world.survival.ghost.active, true, '读档后仍是幽魂');
  assert.equal(bv.player.dead, true);
  assert.equal(bv.ghost.active, true);
  assert.equal(bv.ghost.observing, true);
  assert.equal(bv.ended, false, '未灭绝的幽魂档不得被读成终局');
  assert.ok(Math.abs(bv.ghost.at.x - at.x) < 1e-9 && Math.abs(bv.ghost.at.z - at.z) < 1e-9, '镜头锚点应随档恢复');
  assert.equal(survAct(back, { kind: 'gather' }).code, 'PLAYER_DEAD', '读档后仍是幽魂，动作仍被拒');

  // 旧档（1.2）只有 minds.p1.dead / playerDead，没有 ghost 字段。
  const raw = JSON.parse(JSON.stringify(dumpSurv(sp)));
  delete raw.survival.ghost;
  const legacy = loadSurv(raw, 7, LOAD);
  assert.equal(legacy.world.survival.ghost.active, true, '旧档死亡事实应补齐 ghost');
  assert.ok(Number.isFinite(legacy.world.survival.ghost.at?.x), '旧档补齐时应给出可用锚点');
});

test('GHOST-05 只有聚落灭绝才 ended/extinct；灭绝终局读档持久', () => {
  const sp = formal(7, { startMinutes: 240 });
  const w = sp.world, s = w.survival;
  killPlayer(sp);
  assert.equal(s.ended, false, '玩家死亡不是终局');
  for (const a of Object.values(w.agents)) if (!a.isPlayer) a.viab.v = 0;
  settleSurvival(sp);
  s.lastDay = -1; // 强制走一次日界裁决（真实路径由 dayOf 变化触发）
  advanceSurvival(w);
  assert.equal(s.ended, true, '无存活居民 ⇒ 聚落灭绝');
  assert.equal(s.endReason, 'extinct', '正式世界终局原因只能是 extinct');
  const view = survView(sp);
  assert.equal(view.settlement, 'extinct');
  assert.equal(view.ended, true);
  assert.equal(view.ghost.observing, false, '灭绝后不再称“观察中”');

  const back = roundtrip(sp);
  assert.equal(back.world.survival.ended, true, '灭绝终局必须持久');
  assert.equal(back.world.survival.endReason, 'extinct');
  assert.equal(survView(back).settlement, 'extinct');
});

test('GHOST-06 玩家活着时聚落灭绝仍可正常行动（幽魂不是“灭绝后才能动”的反向门）', () => {
  const sp = formal(7, { startMinutes: 240 });
  const w = sp.world, s = w.survival;
  for (const a of Object.values(w.agents)) if (!a.isPlayer) a.viab.v = 0;
  settleSurvival(sp);
  s.lastDay = -1;
  advanceSurvival(w);
  assert.equal(s.ended, true);
  assert.ok(!s.playerDead, '玩家没死，不应被标成幽魂');
  const view = survView(sp);
  assert.equal(view.player.dead, false);
  assert.equal(view.ghost.active, false);
  assert.equal(view.settlement, 'extinct');
  // 玩家活着时聚落灭绝：终点由客户端结束界面表达；1.2 服务端契约仍允许玩家动作
  // （world-continuity T21 的历史闸门），但拒绝原因绝不能是幽魂闸门。
  const r = survAct(sp, { kind: 'move', room: 'yard' });
  assert.notEqual(r.code, 'PLAYER_DEAD', '玩家没死，不得被幽魂闸门拒绝');
});

test('GHOST-07 研究/对照态保持 1.2 原语义：玩家死亡＝failed/endReason player，不写 ghost 字段', () => {
  const sp = createSurvPlay(7);
  const w = sp.world, s = w.survival;
  w.agents.p1.viab.v = 0;
  settleSurvival(sp);
  assert.equal(s.playerDead, true);
  assert.equal(s.failed, true, '研究态玩家死亡仍判失败（基线不变）');
  assert.equal(s.endReason, 'player');
  assert.equal(s.ghost, undefined, '研究态不得写 ghost 字段（dump 逐位不变）');
  const view = survView(sp);
  assert.equal(view.ghost, undefined, '研究态视图不下发 ghost');
  assert.equal(survAct(sp, { kind: 'move', room: 'hall' }).code, 'CAMP_ENDED', '研究态死后拒绝码保持 CAMP_ENDED');
  assert.equal(JSON.parse(JSON.stringify(dumpSurv(sp))).survival.ghost, undefined);
});

test('GHOST-08 ghostView 只读：不消费 RNG、不改世界状态', () => {
  const sp = formal(7, { startMinutes: 240 });
  const w = sp.world;
  killPlayer(sp);
  const snap = JSON.stringify({ pos: w.pos, store: w.survival.store, t: w.t, ended: w.survival.ended, rng: w.agents.a1.rng?.state?.() ?? null });
  const g1 = ghostView(w), g2 = ghostView(w);
  assert.deepEqual(g1, g2, 'ghostView 必须是纯读');
  assert.equal(JSON.stringify({ pos: w.pos, store: w.survival.store, t: w.t, ended: w.survival.ended, rng: w.agents.a1.rng?.state?.() ?? null }), snap, 'ghostView 不得写世界或消费 RNG');
  assert.equal(g1.since, w.survival.ghost.since);
});
