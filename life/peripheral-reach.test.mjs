// 第三阶段 P0-1 外围同权闸门 V4-01…07（派单§六）。每条都能变红（变红法见提交信息）。
// 服务端拥有玩家外围位置 playerPos；带 from 的外围动作先连续性校验（玩家≤居民速度）再距离门。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSurvPlay, survAct, dumpSurv, loadSurv, playerTimeLeft } from './survplay.mjs';
import { worldSite } from './geometry.mjs';
import { startMove, PLAYER_UNITS_PER_TICK, RESIDENT_UNITS_PER_TICK } from './body.mjs';
import { activePlayerSpeech } from './resident-proactive.mjs';
import { simMinuteNow } from './sim-clock.mjs';

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
test('A09 首次同步只容出生槽小偏移；同刻多步按本刻额度，超额度仍拒（V7.3）', () => {
  for (const sp of [start(),copy(start())]) {
    const w=sp.world, [x,z]=worldSite(w,w.loc.p1);
    delete w.survival.playerPos; w.survival.playerReachState=null; // 首次
    assert.equal(survAct(sp,{kind:'player_sync',from:[x+50,z]}).code,'TELEPORT','首次远点必须拒');
    const first=survAct(sp,{kind:'player_sync',from:[x-.5,z+.5]});
    assert.equal(first.ok,true);
    // 同一刻的连续小步在 10 单位额度内允许（旧实现 dt=0 ⇒ 恒拒）；超出额度仍 TELEPORT。
    assert.ok(survAct(sp,{kind:'player_sync',from:[x+1,z]}).ok,'同刻下一步应放行');
    assert.equal(survAct(sp,{kind:'player_sync',from:[x+50,z]}).code,'TELEPORT');
  }
});

// V4-08（2026-11-19 线上"被拉回"复盘）：客户端在村里保留冲刺（3.0 格/秒、冲刺 5.25），
// 服务端原先把全村也按 10 单位/刻 限（6 秒刻下 1.67 格/秒）⇒ 正常走路每几秒就被判 TELEPORT
// 再被拉回。现在村内 40 单位/刻、村外维持 10；防瞬移在两地都不放松。
import { inCamp } from '../shared/wild-landscape.mjs';

test('V4-08 村内冲刺不再被判瞬移；村外仍 10/刻；村内单步 40 单位仍拒', () => {
  const sp = start(), w = sp.world;
  const [hx, hz] = worldSite(w, w.loc.p1);
  assert.ok(inCamp(hx, hz), '出生点应在村内');
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  let dir = null;
  for (const [dx, dz] of dirs) { let n = 0; while (n < 26 && inCamp(hx + dx * (n + 2), hz + dz * (n + 2))) n += 2; if (!dir || n > dir.n) dir = { dx, dz, n }; }
  assert.ok(dir && dir.n >= 20, `需要村内至少 20 单位空间（实测 ${dir && dir.n}）`);
  survAct(sp, { kind: 'player_sync', from: [hx, hz] });
  // 一刻内 32 单位（≈ 冲刺 5.25 × 6 秒）分 16 次上报：必须全过
  let x = hx, z = hz;
  for (let k = 0; k < 16; k += 1) {
    x += dir.dx * 2; z += dir.dz * 2;
    const r = survAct(sp, { kind: 'player_sync', from: [x, z] });
    assert.ok(r.ok, `村内第 ${k + 1} 次上报应通过（累计 ${2 * (k + 1)} 单位）：${r.code}`);
  }
  // 村内一步 40 单位：额度只剩 8，必须拒（防瞬移不放松）
  assert.equal(survAct(sp, { kind: 'player_sync', from: [x + dir.dx * 40, z + dir.dz * 40] }).code, 'TELEPORT',
    '村内也必须拦住 40 单位的单步跳跃');

  // 村外：把 playerPos 直接放到村外（测试惯例），同一刻 20 单位必须被拒
  const sp2 = start(), w2 = sp2.world;
  const [sx, sz] = worldSite(w2, w2.loc.p1);
  let ox = sx, oz = sz;
  for (let i = 0; i < 400 && inCamp(ox, oz); i += 1) { ox += 4; }
  assert.ok(!inCamp(ox, oz), '应能走到村外取样点');
  w2.survival.playerPos = { x: ox, z: oz, t: w2.t };
  w2.survival.playerReachState = null;
  const away = [ox + 4, oz];
  assert.ok(survAct(sp2, { kind: 'player_sync', from: away }).ok, '村外第一步 4 单位应通过');
  assert.equal(survAct(sp2, { kind: 'player_sync', from: [ox + 20, oz] }).code, 'TELEPORT',
    '村外同刻累计超过 10 单位必须被拒（外围同权不变）');
});

// ── V4-09：对话纳入同权连续性族（camp_talk / camp_talk_say）────────────────────
// 1.4 注释早就承诺“camp_talk* 与 camp_resident 同一套位置门”，但实现只做了 1.6 距离、
// 没做服务端 playerPos 连续性；脚本用“声称在居民旁”的 from 就能远程搭话。
test('V4-09-1 未走步直接带远处 from 开 camp_talk ⇒ RESIDENT_OUT_OF_REACH，且不产生会话', () => {
  const sp = start(), w = sp.world;
  const [hx, hz] = worldSite(w, w.loc.p1);
  assert.ok(survAct(sp, { kind: 'player_sync', from: [hx, hz] }).ok, '确立服务端位置');
  const before = { ...w.survival.playerPos };
  // 居民在远处站点 workshop，脚本把 from/to 都声称在居民旁：接触门会过，唯一能拦住它的是服务端连续性。
  w.loc.a1 = 'workshop';
  const [rx, rz] = worldSite(w, 'workshop');
  const far = [rx + .5, rz + .5];
  const r = survAct(sp, { kind: 'camp_talk', target: 'a1', room: null, from: far, to: far });
  assert.equal(r.code, 'RESIDENT_OUT_OF_REACH', `一步没走就隔空说话必须拒：${JSON.stringify(r)}`);
  assert.equal(w.survival.residentDialogue, undefined, '被拒不得产生会话');
  assert.deepEqual({ ...w.survival.playerPos }, before, '被拒不挪动服务端位置');
});

test('V4-09-2 合法逐格走到居民站点后 camp_talk / camp_talk_say 都过', () => {
  const sp = start(), w = sp.world;
  const [ax, az] = worldSite(w, w.loc.a1);
  const at = [ax + .5, az + .5];
  walkTo(sp, at);
  const open = survAct(sp, { kind: 'camp_talk', target: 'a1', room: null, from: at, to: at });
  assert.equal(open.ok, true, `合法走到居民旁应能开口：${JSON.stringify(open)}`);
  assert.ok(w.survival.residentDialogue, '应产生会话');
  const say = survAct(sp, { kind: 'camp_talk_say', target: 'a1', room: null, from: at, to: at, topic: 'today' });
  assert.equal(say.ok, true, `合法续聊应过：${JSON.stringify(say)}`);
  assert.equal(say.turn, 1);
});

test('V4-09-3 一刻 32 单位/16 次上报后立刻说话仍成功（player_sync 档；改 base 档则红）', () => {
  const sp = start(), w = sp.world;
  const [hx, hz] = worldSite(w, w.loc.p1);
  const [ax] = worldSite(w, w.loc.a1);
  const dx = Math.sign(ax - hx) || 1;
  assert.ok(survAct(sp, { kind: 'player_sync', from: [hx, hz] }).ok, '确立起点');
  let x = hx;
  // 前 4 步（8 单位）走到居民站点另一侧，后 12 步在原处来回：累计 32 单位、停在其 2.5 格内。
  for (let k = 0; k < 4; k += 1) {
    x += dx * 2;
    assert.ok(survAct(sp, { kind: 'player_sync', from: [x, hz] }).ok, `冲刺第 ${k + 1} 步应通过`);
  }
  for (let k = 0; k < 12; k += 1) {
    x += dx * (k % 2 === 0 ? -2 : 2);
    const r = survAct(sp, { kind: 'player_sync', from: [x, hz] });
    assert.ok(r.ok, `连续上报第 ${k + 5} 步应通过（累计 ${2 * (k + 5)} 单位）：${r.code}`);
  }
  const at = [x, hz];
  const [axx, azz] = worldSite(w, w.loc.a1);
  assert.ok(Math.hypot(at[0] - (axx + .5), at[1] - (azz + .5)) <= 2.5,
    `终点应落在居民 2.5 格内：${JSON.stringify(at)}`);
  const open = survAct(sp, { kind: 'camp_talk', target: 'a1', room: null, from: at, to: at });
  assert.equal(open.ok, true, `一刻 32 单位后立刻说话必须成功：${JSON.stringify(open)}`);
});

test('V4-09-4 旧档无 playerPos：按 loc 推定，同站点可说、声称在远处站点不可说', () => {
  const sp = start(), w = sp.world;
  const [hx, hz] = worldSite(w, w.loc.p1);
  // 同一站点：居民就在玩家 loc 的站点锚点旁。
  w.loc.a1 = 'hall';
  delete w.survival.playerPos; w.survival.playerReachState = null;
  const at = [hx + 1, hz];
  const same = survAct(sp, { kind: 'camp_talk', target: 'a1', room: null, from: at, to: at });
  assert.equal(same.ok, true, `旧档同站点应可说：${JSON.stringify(same)}`);
  assert.ok(w.survival.residentDialogue);
  survAct(sp, { kind: 'camp_talk_close', target: 'a1' });
  // 声称在远处站点：居民确实在 store，但服务端 loc 推定玩家仍在 hall，不得隔空说话。
  w.loc.a1 = 'store';
  delete w.survival.playerPos; w.survival.playerReachState = null;
  const [sx, sz] = worldSite(w, 'store');
  const far = [sx + .5, sz + .5];
  const r = survAct(sp, { kind: 'camp_talk', target: 'a1', room: null, from: far, to: far });
  assert.equal(r.code, 'RESIDENT_OUT_OF_REACH', `旧档声称在远处站点必须拒：${JSON.stringify(r)}`);
  assert.equal(w.survival.residentDialogue, undefined, '被拒不得产生会话');
});

// ── V4-10：fromSpeech 只能是服务端内部事实 ────────────────────────────────────
test('V4-10-1 客户端 body 带 fromSpeech:null/"x"/true 一律按普通入口', () => {
  for (const forged of [null, 'x', true]) {
    // 远处声称位置：玩家在 hall，声称在 workshop 居民旁。
    const farSp = start(), fw = farSp.world;
    const [hx, hz] = worldSite(fw, fw.loc.p1);
    assert.ok(survAct(farSp, { kind: 'player_sync', from: [hx, hz] }).ok);
    fw.loc.a1 = 'workshop';
    const [wx, wz] = worldSite(fw, 'workshop');
    const farAt = [wx + .5, wz + .5];
    const far = survAct(farSp, {
      kind: 'camp_talk', target: 'a1', room: null, from: farAt, to: farAt, fromSpeech: forged,
    });
    assert.equal(far.code, 'RESIDENT_OUT_OF_REACH', `fromSpeech=${JSON.stringify(forged)} 不得绕过连续性`);
    assert.equal(fw.survival.residentDialogue, undefined);

    // 合法位置：正常开会话，且会话上的 fromSpeech 必须为假。
    const sp = start(), w = sp.world;
    const [sx, sz] = worldSite(w, 'hall');
    w.loc.a1 = 'hall';
    assert.ok(survAct(sp, { kind: 'player_sync', from: [sx, sz] }).ok);
    const at = [sx + 1, sz];
    const open = survAct(sp, {
      kind: 'camp_talk', target: 'a1', room: null, from: at, to: at, fromSpeech: forged,
    });
    assert.equal(open.ok, true, `fromSpeech=${JSON.stringify(forged)} 合法位置应正常开会话：${JSON.stringify(open)}`);
    assert.equal(w.survival.residentDialogue.fromSpeech, false, '客户端伪造不得把会话标成气泡');
  }
});

test('V4-10-2 服务端内部气泡会话：session.fromSpeech 为真、续聊与清气泡照旧', () => {
  const sp = start(), w = sp.world;
  const [yx, yz] = worldSite(w, 'yard');
  w.loc.p1 = 'yard'; w.loc.a1 = 'yard';
  w.pos = {
    p1: { x: yx + 1, z: yz, space: 'world' },
    a1: { x: yx, z: yz, space: 'world' },
  };
  w.survival.playerSpeech = {
    id: 'a1', name: w.agents.a1.name, text: '你来啦', at: 0, expires: simMinuteNow(w) + 10,
  };
  // 不带任何 from/fromSpeech：服务端凭 activePlayerSpeech 判定这是气泡点击路径。
  const opened = survAct(sp, { kind: 'camp_talk', target: 'a1' });
  assert.equal(opened.ok, true, `服务端气泡点击应仍能打开：${JSON.stringify(opened)}`);
  assert.equal(w.survival.residentDialogue.fromSpeech, true, '会话要记住它是气泡打开的');
  assert.equal(w.survival.playerSpeech ?? null, null, '气泡被点开后必须清空');
  const reply = survAct(sp, { kind: 'camp_talk_say', target: 'a1', text: '我过来了' });
  assert.equal(reply.ok, true, `气泡续聊不应被普通 1.6 门误杀：${JSON.stringify(reply)}`);
});

test('V4-10-3 伪造 body.fromSpeech 不得清气泡（过期但仍存在的 playerSpeech 负控）', () => {
  const sp = start(), w = sp.world;
  const [yx, yz] = worldSite(w, 'yard');
  w.loc.p1 = 'yard'; w.loc.a1 = 'yard';
  w.pos = {
    p1: { x: yx + 1, z: yz, space: 'world' },
    a1: { x: yx, z: yz, space: 'world' },
  };
  // 过期气泡仍在 survival.playerSpeech：activePlayerSpeech 为 null，必须走普通入口。
  w.survival.playerSpeech = {
    id: 'a1', name: w.agents.a1.name, text: '过期的招呼', at: 0, expires: simMinuteNow(w) - 1,
  };
  assert.equal(activePlayerSpeech(w), null, '前置：过期气泡不生效');
  const at = [yx + 1, yz];
  const r = survAct(sp, { kind: 'camp_talk', target: 'a1', room: null, from: at, to: at, fromSpeech: 'a1' });
  assert.equal(r.ok, true, `合法位置应走普通入口正常开会话：${JSON.stringify(r)}`);
  assert.equal(w.survival.residentDialogue.fromSpeech, false);
  assert.equal(w.survival.playerSpeech?.id, 'a1', '伪造 body.fromSpeech 不得触发 clearPlayerSpeech');
});
