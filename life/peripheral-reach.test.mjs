// 第三阶段 P0-1 外围同权闸门 V4-01…07（派单§六）。每条都能变红（变红法见提交信息）。
// 服务端拥有玩家外围位置 playerPos；带 from 的外围动作先连续性校验（玩家≤居民速度）再距离门。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSurvPlay, survAct, dumpSurv, loadSurv, playerTimeLeft } from './survplay.mjs';
import { worldSite } from './geometry.mjs';
import { startMove, PLAYER_UNITS_PER_TICK, RESIDENT_UNITS_PER_TICK } from './body.mjs';

const OPT = { mapSeed:13, layoutVersion:2, settlementLife:true, regionalWork:true, independentWorld:true,
  wildFood:true, residentialDecisions:true, unifiedCooperation:true, autonomousGoals:true };
const start = () => createSurvPlay(13, OPT);
const copy = sp => loadSurv(JSON.parse(JSON.stringify(dumpSurv(sp))), 13, OPT);

// 合法逐格步行：先把 playerPos 确立在当前位置，再按 ≤PLAYER_UNITS_PER_TICK/刻 推进 w.t 与位置。
function walkTo(sp, target) {
  const w = sp.world;
  const at = worldSite(w, w.loc.p1);
  assert.ok(survAct(sp, { kind:'player_sync', from:[at[0],at[1]] }).ok, '确立起点位置');
  const cur = w.survival.playerPos;
  const dist = Math.hypot(target[0]-cur.x, target[1]-cur.z);
  const ticks = Math.max(1, Math.ceil(dist / PLAYER_UNITS_PER_TICK));
  for (let i=1; i<=ticks; i++) {
    w.t += 1;
    const f = i/ticks;
    const pos = [cur.x+(target[0]-cur.x)*f, cur.z+(target[1]-cur.z)*f];
    const r = survAct(sp, { kind:'player_sync', from:pos });
    assert.ok(r.ok, `合法步行第${i}步应通过：${r.code}`);
  }
  return ticks;
}

test('V4-01 伪造 from 到远处必须被拒（TELEPORT），不扣预算/存续', () => {
  const sp=start(), w=sp.world;
  const loc=Object.keys(w.districts).find(k=>w.districts[k].resource==='stone') ?? Object.keys(w.districts)[0];
  const d=w.districts[loc];
  const at=worldSite(w,w.loc.p1);
  survAct(sp,{kind:'player_sync',from:[at[0],at[1]]}); // playerPos 确立在 hall，t=w.t
  const budget=playerTimeLeft(w), viab=w.agents.p1.viab.v;
  const r=survAct(sp,{kind:'gather',target:loc,tool:d.resource==='wood'?'axe':'pick',from:d.source});
  assert.equal(r.code,'TELEPORT', '一步没走就采远处⇒TELEPORT');
  assert.equal(playerTimeLeft(w),budget,'被拒不扣行动预算');
  assert.equal(w.agents.p1.viab.v,viab,'被拒不扣存续');
  assert.equal(w.pinv.p1.wood+w.pinv.p1.stone,0,'被拒不得产出');
});

test('V4-02 合法逐格步行最终可采到（速度上限设 0 则红）', () => {
  const sp=start(), w=sp.world;
  const loc=Object.keys(w.districts).find(k=>w.districts[k].resource==='wood') ?? Object.keys(w.districts)[0];
  const d=w.districts[loc];
  walkTo(sp, d.source);
  const r=survAct(sp,{kind:'gather',target:loc,tool:d.resource==='wood'?'axe':'pick',from:d.source});
  assert.equal(r.ok,true,`合法步行后应采到：${r.code}`);
  assert.ok((w.pinv.p1.wood+w.pinv.p1.stone)>=1,'应有产出');
});

test('V4-03 玩家同程刻数 ≥ 居民 startMove ticks（玩家速度翻倍则红）', () => {
  const sp=start(), w=sp.world;
  const loc=Object.keys(w.districts)[0], d=w.districts[loc];
  const from=w.loc.p1, startPt=worldSite(w,from), endPt=d.at;
  const dist=Math.hypot(endPt[0]-startPt[0],endPt[1]-startPt[1]);
  // 居民行程刻数（真走 startMove）
  w.agents.a1.loc ??= from; w.loc.a1=from;
  startMove(w,'a1',loc);
  const residentTicks=w.survival.districtTravel.a1.arrive - w.t;
  const playerMinTicks=Math.ceil(dist/PLAYER_UNITS_PER_TICK);
  assert.ok(playerMinTicks>=residentTicks, `玩家${playerMinTicks}刻应≥居民${residentTicks}刻（dist=${dist.toFixed(1)}）`);
  assert.ok(PLAYER_UNITS_PER_TICK<=RESIDENT_UNITS_PER_TICK,'玩家速度上限不得超居民');
});

test('V4-04 旧档无 playerPos ⇒ 按 loc 推定，不崩、不默认在外围（推定改直接允许则红）', () => {
  const sp=start(), w=sp.world;
  const loc=Object.keys(w.districts)[0], d=w.districts[loc];
  delete w.survival.playerPos; // 模拟旧档
  const raw=JSON.parse(JSON.stringify(dumpSurv(sp)));
  delete raw.survival.playerPos;
  const back=loadSurv(raw,13,OPT);
  const bw=back.world;
  assert.equal(bw.loc.p1, w.loc.p1, '读档不崩');
  const r=survAct(back,{kind:'gather',target:loc,tool:d.resource==='wood'?'axe':'pick',from:d.source});
  assert.equal(r.code,'TELEPORT','旧档玩家仍在 loc，不得默认在外围任意点采');
});

test('V4-05 playerPos 随档：保存→重启→继续，不瞬移（不进 dump 则红）', () => {
  const sp=start(), w=sp.world;
  const loc=Object.keys(w.districts).find(k=>w.districts[k].resource==='wood') ?? Object.keys(w.districts)[0];
  const d=w.districts[loc];
  walkTo(sp, d.source);
  const pos={...w.survival.playerPos};
  const back=copy(sp);
  assert.deepEqual(back.world.survival.playerPos,pos,'playerPos 随档恢复');
  // 读档后试图瞬移到另一远处⇒拒
  const other=Object.keys(back.world.districts).find(k=>k!==loc);
  const od=back.world.districts[other];
  const r=survAct(back,{kind:'gather',target:other,tool:od.resource==='wood'?'axe':'pick',from:od.source});
  assert.equal(r.code,'TELEPORT','读档后不得瞬移');
  // 原地继续采集仍可用
  const ok=survAct(back,{kind:'gather',target:loc,tool:d.resource==='wood'?'axe':'pick',from:d.source});
  assert.equal(ok.ok,true,'读档后原地继续合法');
});

test('V4-06 被拒动作退还行动预算与存续（去掉退还则红）', () => {
  const sp=start(), w=sp.world;
  const loc=Object.keys(w.districts)[0], d=w.districts[loc];
  const at=worldSite(w,w.loc.p1);
  survAct(sp,{kind:'player_sync',from:[at[0],at[1]]});
  const b0=playerTimeLeft(w), v0=w.agents.p1.viab.v;
  for (let i=0;i<3;i++) survAct(sp,{kind:'gather',target:loc,tool:'pick',from:d.source}); // 三次瞬移被拒
  assert.equal(playerTimeLeft(w),b0,'多次被拒预算全退');
  assert.equal(w.agents.p1.viab.v,v0,'多次被拒存续不退扣');
});

test('V4-07 lab/town 不受影响：无 districts 的世界外围校验不生效', () => {
  const lab=createSurvPlay(7); // 默认无 settlementLife/regionalWork ⇒ 无 districts
  assert.equal(lab.world.districts,undefined,'默认研究世界无外围');
  // 核心营地动作（无 districts）仍按现行为：hall 移动合法
  const r=survAct(lab,{kind:'move',room:'yard'});
  assert.ok(r.ok,'核心移动不受外围校验影响');
});