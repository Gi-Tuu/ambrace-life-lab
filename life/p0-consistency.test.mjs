// 派单 P0 第一批针对性实验（T01–T06 + P0-5 流程）。每条配反向条件，可复现 seed。
// 覆盖：T01 信任→合作 / T02 独建vs协作 / T03 死亡一致性 / T04 玩家AI成本同权 /
//       T05 无资源地点采集 / T06 资源采集与再生 / P0-5 玩家工地请求·采纳·中途退出·目标消失。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSurvPlay, survAct, tickSurvPlay, dumpSurv, loadSurv } from './survplay.mjs';
import { isAlive, livingResidents, SURV_COST, move } from './body.mjs';
import { willingness, stepCooperation, assignWorkers, runConstruction } from './cooperation.mjs';
import { doGather, doPlan, doBuild, regenResources, RES_STOCK } from './production.mjs';
import { validate } from './rules.mjs';
import { makeWorld, spawn } from './body.mjs';
import { PARAMS } from './params.mjs';

// ── T01 信任真的影响合作（P0-4）：固定天气/资源/任务，只改 a1 对 p1 的信任 ──
test('T01 合作意愿读真实关系：高信任→协助、低信任→替代/拒绝，分数随信任单调', () => {
  const sp = createSurvPlay(7); const w = sp.world;
  w.weather = 'clear';
  const a1 = w.agents.a1;
  a1.viab.v = 1;
  const task = { type: 'granary', severity: 0.5, requester: 'p1' };
  a1.relations.get('p1').trust = 0;
  const low = willingness(w, 'a1', task);
  a1.relations.get('p1').trust = 100;
  const high = willingness(w, 'a1', task);
  assert.ok(high.score > low.score, `信任升高分数应升：low=${low.score} high=${high.score}`);
  assert.equal(high.decision, 'assist', '高信任应协助');
  assert.notEqual(low.decision, 'assist', '零信任不应协助');
  // 读关系不得重置已有历史
  a1.relations.get('p1').familiarity = 0.8;
  willingness(w, 'a1', task);
  assert.equal(a1.relations.get('p1').familiarity, 0.8, '读意愿不应抹掉熟悉度历史');
  // 反向：死者不被组队（即使信任满）
  a1.dead = true;
  assert.ok(!assignWorkers(w, task).includes('a1'), '死者不应进合作队伍');
});

// ── T02 独建 vs 协作效率（P0-5 基础）：同 seed 协作完工更快 ──
test('T02 同 seed 独建 vs 协作：协作完工更快且多人', () => {
  const solo = runConstruction({ seed: 7, type: 'granary', coop: false, makeWorld, spawn });
  const coop = runConstruction({ seed: 7, type: 'granary', coop: true, makeWorld, spawn });
  assert.ok(solo.completed && coop.completed, '两者都应完工');
  assert.ok(coop.workers > 1, '协作应多人');
  assert.ok(coop.ticks < solo.ticks, `协作(${coop.ticks})应快于独建(${solo.ticks})`);
});

// ── T03 居民死亡后的世界一致性（P0-1）──
test('T03 死亡一致：死者退出决策/配给/占位，不可进食复活，存档恢复一致', async () => {
  const sp = createSurvPlay(7); const w = sp.world;
  const a1 = w.agents.a1;
  a1.viab.v = 0; // 致死
  await tickSurvPlay(sp);
  assert.equal(a1.dead, true, '存续归零应标记死亡');
  assert.ok(w.survival.deaths.some((d) => d.id === 'a1' && d.cause), '应记录死亡原因/时间');
  assert.equal(livingResidents(w).length, 2, '存活居民应剩 2');
  assert.ok(!(w.occupancy[w.loc.a1] ?? []).includes('a1'), '死者应移出占位');
  // 不可逆：进食回补存续也不算复活
  a1.viab.regen(1);
  assert.equal(isAlive(a1), false, '死者进食不应复活');
  // 死者不再行动：记死亡后 aiActions 不再增长
  const before = JSON.stringify(w.survival.aiActions ?? {});
  for (let i = 0; i < 10; i++) await tickSurvPlay(sp);
  const a1Acts = (w.agents.a1.trace ?? []).filter((r) => r.t > w.t - 10 && r.ok).length;
  assert.equal(a1Acts, 0, '死者死后不应再有成功动作');
  // 存档恢复一致
  const back = loadSurv(JSON.parse(JSON.stringify(dumpSurv(sp))), 7);
  assert.equal(back.world.agents.a1.dead, true, '读档后死亡状态保持');
  assert.ok(back.world.survival.deaths.some((d) => d.id === 'a1'), '死亡历史随档恢复');
  assert.ok(!(back.world.occupancy[back.world.loc.a1] ?? []).includes('a1'), '读档后死者仍不在占位');
});

test('T03b 玩家死亡＝独立终局（与聚落饿垮分开）', async () => {
  const sp = createSurvPlay(7); const w = sp.world;
  w.agents.p1.viab.v = 0;
  await tickSurvPlay(sp);
  assert.equal(w.survival.playerDead, true);
  assert.equal(w.survival.failed, true);
  assert.equal(w.survival.endReason, 'player');
  assert.equal(w.agents.p1.dead, true);
  assert.equal(survAct(sp, { kind: 'gather' }).code, 'CAMP_ENDED', '死后不能行动');
});

// ── T04 玩家与 AI 同动作同成本（P0-2）──
test('T04 同基础动作玩家/AI 存续成本逐位相同，且玩家不再免费', () => {
  const sp = createSurvPlay(7); const w = sp.world;
  move(w, 'p1', 'yard'); move(w, 'a1', 'yard');
  w.survival.resStock.yard = RES_STOCK.yard;
  const cost = PARAMS.viab.costScale * SURV_COST.gather;
  // 玩家
  w.agents.p1.viab.v = 1; w.agents.p1.viab.reserve = 0;
  assert.equal(survAct(sp, { kind: 'gather' }).ok, true);
  const pDrop = 1 - w.agents.p1.viab.v;
  // AI（走真实 execute 路径）
  const a1 = w.agents.a1; a1.world = w; a1.viab.v = 1; a1.viab.reserve = 0;
  a1.execute(w, { id: 'gather', kind: 'gather', cost: SURV_COST.gather }, 'deliberation', w.t, true);
  const aDrop = 1 - a1.viab.v;
  assert.ok(pDrop > 0, '玩家动作不再免费');
  assert.ok(Math.abs(pDrop - aDrop) < 1e-9, `玩家(${pDrop})与AI(${aDrop})同动作成本应相同`);
  assert.ok(Math.abs(pDrop - cost) < 1e-9, `成本应＝costScale×SURV_COST.gather=${cost}`);
});

// ── T05 无资源地点不能采集（P0-3）──
test('T05 采集地点门控：室内/无资源地点被规则层拒绝，资源地点才可采', () => {
  const sp = createSurvPlay(7); const w = sp.world;
  for (const room of ['hall', 'home', 'store']) {
    move(w, 'p1', room);
    assert.equal(validate(w, 'p1', { kind: 'gather' }).ok, false, `${room} 不应可采集`);
    assert.equal(survAct(sp, { kind: 'gather' }).ok, false, `${room} survAct 应被拒`);
  }
  move(w, 'p1', 'yard');
  assert.equal(validate(w, 'p1', { kind: 'gather' }).ok, true, 'yard 应可采集');
  assert.equal(survAct(sp, { kind: 'gather' }).ok, true);
});

// ── T06 资源采集扣减与时间再生（P0-3）──
test('T06 有限储量：采集扣减、采空拒绝、随游戏日再生封顶', () => {
  const sp = createSurvPlay(7); const w = sp.world; const s = w.survival;
  move(w, 'p1', 'yard');
  s.resStock.yard = 4;
  assert.equal(doGather(w, 'p1').amount, 2);
  assert.equal(s.resStock.yard, 2, '采集应扣储量');
  assert.equal(doGather(w, 'p1').amount, 2);
  assert.equal(s.resStock.yard, 0);
  assert.equal(doGather(w, 'p1').ok, false, '采空应拒绝');
  assert.equal(doGather(w, 'p1').code, 'NO_RESOURCE');
  // 再生：日界 +1，封顶初始储量
  regenResources(w);
  assert.equal(s.resStock.yard, 1, '日界应再生 1');
  for (let i = 0; i < 20; i++) regenResources(w);
  assert.equal(s.resStock.yard, RES_STOCK.yard, '再生应封顶初始储量');
});

test('T06b 树木砍伐与资源账同步：砍树扣账、再生回补', () => {
  const sp = createSurvPlay(7, { mapSeed: 7, layoutVersion: 1 }); const w = sp.world; const s = w.survival;
  const tree = (w.campLayout.grove ?? [])[0];
  assert.ok(tree, '布局应有树');
  move(w, 'p1', tree.site);
  s.resStock[tree.site] = 6;
  const r = survAct(sp, { kind: 'camp_chop', target: tree.id, tool: 'axe' });
  assert.equal(r.ok, true, '砍树应成功');
  assert.equal(s.resStock[tree.site], 4, '砍树应扣同一份木料账');
  assert.ok(s.campTrees[tree.id] > w.t, '树应进入再生期');
  // 推进到再生到期 ⇒ 日界 ambient +1 与树再生 +2 同时回补（4+1+2=7，封顶 12）
  w.t = s.campTrees[tree.id];
  regenResources(w);
  assert.equal(s.resStock[tree.site], 7, '树再生应回补木料账（含日界 ambient）');
  assert.equal(s.campTrees[tree.id], 0, '再生后计时清零');
});

// ── P0-5 玩家工地合作流程 ──
function siteWorld(type = 'shelter') {
  const sp = createSurvPlay(7); const w = sp.world;
  move(w, 'p1', 'yard');
  w.pinv.p1 = { wood: 10, stone: 10 };
  assert.equal(doPlan(w, 'p1', type).ok, true, '玩家应能奠基');
  return sp;
}

test('P0-5a 玩家工地被自动采纳为合作任务（无需请求）', () => {
  const sp = siteWorld('workshop'); const w = sp.world; // 工坊工时 8＞3 工人×2，单拍不完工 ⇒ 任务留存可断言
  w.agents.a1.relations.get('p1').trust = 90;
  stepCooperation(w);
  assert.ok(w.survival.coop.task, '既有工地应被采纳');
  assert.equal(w.survival.coop.task.phase, 'build', '已奠基应直接施工');
  assert.equal(w.survival.coop.task.loc, 'yard');
  assert.equal(w.survival.coop.task.adopted, true);
});

test('P0-5b 请求协助：高信任接受、低信任+匮乏+恶劣天气拒绝、无工地拒绝', () => {
  const sp = siteWorld(); const w = sp.world;
  const a1 = w.agents.a1;
  a1.relations.get('p1').trust = 90; a1.viab.v = 1; w.weather = 'clear';
  const yes = survAct(sp, { kind: 'coop_request', target: 'a1' });
  assert.equal(yes.ok, true);
  assert.equal(yes.decision, 'assist');
  assert.ok(w.survival.coop.task.workers.includes('a1'), '接受后应入队');
  // 拒绝：低信任＋自身匮乏＋寒潮＋低价值
  const sp2 = siteWorld(); const w2 = sp2.world;
  const b1 = w2.agents.a1;
  b1.relations.get('p1').trust = 0; b1.viab.v = 0.05; w2.weather = 'cold';
  const no = survAct(sp2, { kind: 'coop_request', target: 'a1' });
  assert.equal(no.ok, false);
  assert.equal(no.decision, 'refuse');
  assert.ok(w2.survival.coop.refusals >= 1, '拒绝应计数');
  // 无工地
  const sp3 = createSurvPlay(7);
  assert.equal(survAct(sp3, { kind: 'coop_request', target: 'a1' }).code, 'NO_SITE');
});

test('P0-5c 中途退出：替代承诺者意愿转拒即退队并计数', () => {
  const sp = siteWorld(); const w = sp.world; const s = w.survival;
  const a1 = w.agents.a1;
  a1.relations.get('p1').trust = 0; a1.viab.v = 0.5; w.weather = 'clear'; // 匮乏+低信任 ⇒ 替代（score≈0.47）
  const r = survAct(sp, { kind: 'coop_request', target: 'a1' });
  assert.ok(r.ok, '中等意愿应接受（替代）');
  assert.equal(r.decision, 'alternative');
  assert.equal(s.coop.task.commit.a1, 'alternative');
  // 条件恶化 ⇒ 下一拍重评退出
  a1.viab.v = 0.02; w.weather = 'cold'; a1.relations.get('p1').trust = 0;
  stepCooperation(w);
  assert.ok(!s.coop.task || !s.coop.task.workers.includes('a1'), '替代者条件恶化应退队');
  assert.ok(s.coop.exits >= 1, '退出应计数');
});

test('P0-5d 目标消失正常结束：玩家建成记完工，工地凭空消失记放弃', () => {
  const sp = siteWorld(); const w = sp.world; const s = w.survival;
  w.agents.a1.relations.get('p1').trust = 90;
  survAct(sp, { kind: 'coop_request', target: 'a1' });
  // 玩家自己建成
  const site = s.sites.find((x) => x.loc === 'yard');
  s.sites = s.sites.filter((x) => x !== site);
  s.buildings.push({ type: 'shelter', loc: 'yard', integrity: 1 });
  stepCooperation(w);
  assert.ok(s.coop.completions.some((c) => c.type === 'shelter'), '玩家建成应记完工');
  assert.equal(s.coop.task, null, '完工后任务清空');
  // 工地凭空消失（无建筑）⇒ 放弃
  const sp2 = siteWorld(); const w2 = sp2.world; const s2 = w2.survival;
  w2.agents.a1.relations.get('p1').trust = 90;
  survAct(sp2, { kind: 'coop_request', target: 'a1' });
  s2.sites = [];
  stepCooperation(w2);
  assert.equal(s2.coop.task, null, '工地消失应结束任务');
});