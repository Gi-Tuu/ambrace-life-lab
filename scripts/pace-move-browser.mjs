#!/usr/bin/env node
// 2026-11-21 时间节奏 × 移动修复的真实浏览器闸门与证据采集。
//
// 事故：1:10 把位移按“游戏分钟”换算，玩家现实 1 秒只走 0.0625 tile（慢 48×），
// quickstart 固定按键 0.074。本脚本只读观测真实按键/真实轮询，不做任何世界规则改写：
//   A. 户外步行：按住 1s ≥2.5 tile（目标 3），冲刺 ≥4.5（目标 5.25）；
//   B. 室内 WASD：同一 1s 尺度 ≥2.5 tile（室内外同一手感）；
//   C. 居民：服务端真实 startMove 出发后 10s，/world 的居民位置明显变化、客户端居民也在走；
//   D. 断线重连：整页重载后从服务端位置接续，1s 仍走 ≥2.5 且不被 TELEPORT 拉回。
// 60s=10 游戏分由 scripts/pace-1to10-browser.mjs 单独采集（同一部署 env）。
// 截图/日志落 evidence/pace-move-fix/。不改世界规则、不 push、不部署。
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCdpHarness } from './lib/cdp-harness.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'evidence', 'pace-move-fix');
mkdirSync(OUT, { recursive: true });
const log = [];
const note = (kind, data = {}) => log.push({ at: new Date().toISOString(), kind, ...data });
const h = createCdpHarness({
  root: ROOT,
  port: 9000 + (process.pid % 400),
  dataPrefix: 'pace-move-data-',
  profilePrefix: 'pace-move-chrome-',
  chrome: 'fixed',
  serverEnv: {
    GAME_MODE: 'game', GAME_RULES: '1', SIM_TIME: '1',
    GAME_MS_PER_MINUTE: '6000', TICK_MS: '360000',
    BRAIN: 'local', MODEL_UNATTENDED: '0', V73_TEST: '1',
  },
  waitMs: 20000,
});
const assert = (cond, message) => { if (!cond) throw new Error(message); };
const num = (v) => Number(Number(v).toFixed(3));
const post = (path, body) => h.post(path, { confirm: true, ...body });
const ctl = async (body) => (await post('/ctl', body)).body;
const KEY = { forward: ['KeyD', 'd'], back: ['KeyA', 'a'], up: ['KeyW', 'w'], down: ['KeyS', 's'] };

try {
  await h.startServer();
  h.startChrome();
  const probe = `window.__pageErrors=[];
    addEventListener('error', e => window.__pageErrors.push({kind:'error',m:e.message,f:e.filename,l:e.lineno}));
    addEventListener('unhandledrejection', e => window.__pageErrors.push({kind:'rejection',m:String(e.reason&&e.reason.message||e.reason)}));`;
  const sid = await h.openPage({ url: `${h.origin}/`, probe });
  await h.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, sid);
  assert(await h.waitFor(async () => Boolean(await h.evaluate('!!window.__lifeDebug?.S', sid)), 20000, sid), '页面未就绪');
  assert(await h.waitFor(async () => !(await h.evaluate(`document.querySelector('#startSurvival')?.disabled`, sid)), 20000, sid), '继续生存按钮一直禁用');
  await h.evaluate(`document.querySelector('#startSurvival').click()`, sid);
  assert(await h.waitFor(async () => await h.evaluate('window.__lifeDebug.S.playing === true', sid), 15000, sid), '未进入游戏');
  await h.evaluate(`document.querySelector('#firstRun [data-firstrun="skip"]')?.click()`, sid);
  await h.wait(400);

  // ── 通用：按住一个按键 ms 毫秒，返回玩家 walker 的位移/真实耗时/速度 ──────────────
  const playerPos = `(()=>{const w=window.__lifeDebug.WALK['cvA:p1'];return w?{x:w.x,y:w.y}:null})()`;
  const hold = async (keyName, ms, { sprint = false } = {}) => {
    const [code, key] = KEY[keyName];
    const before = JSON.parse(await h.evaluate(`JSON.stringify(${playerPos})`, sid));
    assert(before, '没有玩家 walker');
    await h.evaluate(`window.__paceT0=performance.now();window.dispatchEvent(new KeyboardEvent('keydown',{code:'${code}',key:'${key}',bubbles:true}))`, sid);
    if (sprint) await h.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{code:'ShiftLeft',key:'Shift',bubbles:true}))`, sid);
    await h.wait(ms);
    const elapsedMs = Number(await h.evaluate(`performance.now()-window.__paceT0`, sid));
    await h.evaluate(`window.dispatchEvent(new KeyboardEvent('keyup',{code:'${code}',key:'${key}',bubbles:true}))`, sid);
    if (sprint) await h.evaluate(`window.dispatchEvent(new KeyboardEvent('keyup',{code:'ShiftLeft',key:'Shift',bubbles:true}))`, sid);
    await h.wait(100);
    const after = JSON.parse(await h.evaluate(`JSON.stringify(${playerPos})`, sid));
    const moved = Math.hypot(after.x - before.x, after.y - before.y);
    return { key: keyName, sprint, heldMs: num(elapsedMs), moved: num(moved), tilesPerSecond: num(moved / (elapsedMs / 1000)), before, after };
  };
  const bestOf = async (runner) => {
    const rows = [];
    for (const direction of ['forward', 'down', 'up', 'back']) {
      const row = await runner(direction);
      note('move.sample', row);
      rows.push(row);
      if (row.sprint && row.tilesPerSecond >= 5.0) break;
      if (!row.sprint && row.tilesPerSecond >= 2.9) break;
    }
    return rows.sort((a, b) => b.moved - a.moved)[0];
  };

  // ── A1：真实 1 秒步行 ─────────────────────────────────────────────────────────
  const walk = await bestOf((direction) => hold(direction, 1000));
  await h.screenshot(sid, join(OUT, 'walk-1s.png'));
  // 步行阈值：服务端真实速度 3 tile/s；≥2.5 是发布闸门（允许首帧/轻微碰撞）。
  assert(walk.moved >= 2.5, `真实 1 秒步行必须 ≥2.5 tile（实测 ${walk.moved} @ ${walk.tilesPerSecond} tile/s，方向 ${walk.key}）`);
  assert(walk.tilesPerSecond >= 2.4 && walk.tilesPerSecond <= 3.8,
    `步行速度必须≈3 tile/s（实测 ${walk.tilesPerSecond}）`);

  // ── A2：真实 1 秒冲刺 ─────────────────────────────────────────────────────────
  const sprint = await bestOf((direction) => hold(direction, 1000, { sprint: true }));
  await h.screenshot(sid, join(OUT, 'sprint-1s.png'));
  assert(sprint.moved >= 4.5, `真实 1 秒冲刺必须 ≥4.5 tile（实测 ${sprint.moved} @ ${sprint.tilesPerSecond} tile/s）`);
  assert(sprint.tilesPerSecond >= 4.2 && sprint.tilesPerSecond <= 6.2,
    `冲刺速度必须≈5.25 tile/s（实测 ${sprint.tilesPerSecond}）`);
  assert(sprint.tilesPerSecond > walk.tilesPerSecond, '冲刺必须快于步行');

  // ── B：室内 WASD（独立页面深链进 hall；室内外同一 1s 尺度）─────────────────────
  const roomSid = await h.openPage({ url: `${h.origin}/?room=hall`, probe });
  assert(await h.waitFor(async () => Boolean(await h.evaluate('!!window.__lifeDebug?.S', roomSid)), 20000, roomSid), '室内页面未就绪');
  assert(await h.waitFor(async () => !(await h.evaluate(`document.querySelector('#startSurvival')?.disabled`, roomSid)), 20000, roomSid), '室内页继续按钮禁用');
  await h.evaluate(`document.querySelector('#startSurvival').click()`, roomSid);
  assert(await h.waitFor(async () => await h.evaluate('window.__lifeDebug.S.playing === true', roomSid), 15000, roomSid), '室内未进入游戏');
  await h.evaluate(`(()=>{const d=window.__lifeDebug;d.S.view.campPlayerRoom='hall';d.S.view.loc.p1='hall';d.ui.interior='hall';d.ui.room='hall';})()`, roomSid);
  await h.evaluate(`document.querySelector('#firstRun [data-firstrun="skip"]')?.click()`, roomSid);
  await h.wait(500);
  const indoor = await (async () => {
    const before = JSON.parse(await h.evaluate(`JSON.stringify((()=>{const p=window.__lifeDebug.IPOS;return {x:p.x,y:p.y,room:window.__lifeDebug.ui.interior}})())`, roomSid));
    assert(before.room, '深链未进入室内（ui.interior 为空）');
    await h.evaluate(`window.__paceT0=performance.now();window.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyD',key:'d',bubbles:true}))`, roomSid);
    await h.wait(1000);
    const elapsedMs = Number(await h.evaluate(`performance.now()-window.__paceT0`, roomSid));
    await h.evaluate(`window.dispatchEvent(new KeyboardEvent('keyup',{code:'KeyD',key:'d',bubbles:true}))`, roomSid);
    await h.wait(100);
    const after = JSON.parse(await h.evaluate(`JSON.stringify((()=>{const p=window.__lifeDebug.IPOS;return {x:p.x,y:p.y}})())`, roomSid));
    const mstep = Math.hypot(after.x - before.x, after.y - before.y) / 16;
    return { room: before.room, heldMs: num(elapsedMs), movedTiles: num(mstep), tilesPerSecond: num(mstep / (elapsedMs / 1000)) };
  })();
  note('indoor.walk', indoor);
  await h.screenshot(roomSid, join(OUT, 'indoor-1s.png'));
  assert(indoor.movedTiles >= 2.5, `室内真实 1 秒必须 ≥2.5 tile（实测 ${indoor.movedTiles}，房间 ${indoor.room}）`);

  // 第二页在前台时第一页会被浏览器停轮询/停绘；居民 10s 观测必须切回第一页。
  await h.send('Page.bringToFront', {}, sid);
  await h.wait(700);
  const pageVisibility = JSON.parse(await h.evaluate('JSON.stringify({hidden:document.hidden})', sid));
  note('page.visibility', pageVisibility);
  assert(pageVisibility.hidden === false, '第一页必须回到前台（否则客户端不轮询）');

  // ── C：居民真实旅行 10 秒（服务端 startMove 夹具 + /world 位置）────────────────
  const fixture = await ctl({ action: 'pace_move_fixture', resident: 'a1' });
  note('resident.fixture', fixture);
  assert(fixture?.ok, `居民旅行夹具失败：${JSON.stringify(fixture)}`);
  const residentState = `(()=>{const S=window.__lifeDebug.S;const a=S.view?.agents?.[${JSON.stringify(fixture.id)}];const w=window.__lifeDebug.WALK[${JSON.stringify('cvA:' + fixture.id)}];return {pos:a?.pos??null,loc:a?.loc??null,walker:w?{x:w.x,y:w.y}:null}})()`;
  const worldState = async () => {
    const json = await (await fetch(`${h.origin}/world`)).json();
    return { a1: json.survival?.agents?.a1 ?? null, travel: json.survival?.districtTravel?.[fixture.id] ?? null,
      tickError: json.tickError ?? null, t: json.survival?.t ?? null };
  };
  const r0 = JSON.parse(await h.evaluate(`JSON.stringify(${residentState})`, sid));
  const w0 = await worldState();
  assert(r0.pos || r0.walker, '取不到居民位置');
  await h.wait(10000);
  const r1 = JSON.parse(await h.evaluate(`JSON.stringify(${residentState})`, sid));
  const w1 = await worldState();
  const serverMoved = w0.a1?.pos && w1.a1?.pos
    ? Math.hypot(w1.a1.pos.x - w0.a1.pos.x, w1.a1.pos.z - w0.a1.pos.z) : null;
  const walkerMoved = r0.walker && r1.walker
    ? Math.hypot(r1.walker.x - r0.walker.x, r1.walker.y - r0.walker.y) : null;
  note('resident.10s', { id: fixture.id, from: fixture.from, to: fixture.to, length: fixture.length, fixture,
    r0, r1, w0, w1, serverMoved: num(serverMoved ?? 0), walkerMoved: num(walkerMoved ?? 0) });
  await h.screenshot(sid, join(OUT, 'resident-10s.png'));
  assert(serverMoved !== null && serverMoved >= 10,
    `居民 10 秒服务端位置必须明显变化（实测 ${serverMoved}，路径长 ${fixture.length}）`);
  assert(walkerMoved !== null && walkerMoved >= 15,
    `居民 10 秒客户端行走必须≈30 tile（实测 ${walkerMoved}）`);

  // ── D：断线重连（整页重载）后从服务端位置接续，且不被 TELEPORT 拉回 ────────────
  await h.send('Page.reload', {}, sid);
  assert(await h.waitFor(async () => Boolean(await h.evaluate('!!window.__lifeDebug?.S', sid)), 20000, sid), '重载后页面未就绪');
  assert(await h.waitFor(async () => !(await h.evaluate(`document.querySelector('#startSurvival')?.disabled`, sid)), 20000, sid), '重载后继续按钮禁用');
  await h.evaluate(`document.querySelector('#startSurvival').click()`, sid);
  assert(await h.waitFor(async () => await h.evaluate('window.__lifeDebug.S.playing === true', sid), 15000, sid), '重载后未进入游戏');
  await h.wait(700);
  const reconnectBefore = JSON.parse(await h.evaluate(`JSON.stringify((()=>{const w=window.__lifeDebug.WALK['cvA:p1'];const S=window.__lifeDebug.S;return {walker:{x:w.x,y:w.y},playerPos:S.view?.playerPos??null}})())`, sid));
  const reconnect = await bestOf((direction) => hold(direction, 1000));
  await h.wait(1500); // 让 /world 轮询到最新权威位置
  const reconnectAfter = JSON.parse(await h.evaluate(`JSON.stringify((()=>{const w=window.__lifeDebug.WALK['cvA:p1'];const S=window.__lifeDebug.S;return {walker:{x:w.x,y:w.y},playerPos:S.view?.playerPos??null}})())`, sid));
  const reconnectGap = reconnectAfter.playerPos
    ? Math.hypot(reconnectAfter.walker.x + .5 - reconnectAfter.playerPos.x, reconnectAfter.walker.y + .5 - reconnectAfter.playerPos.z) : null;
  note('reconnect', { before: reconnectBefore, move: reconnect, after: reconnectAfter, gapToServer: num(reconnectGap ?? 0) });
  assert(reconnect.moved >= 2.5, `重连后真实 1 秒仍须 ≥2.5 tile（实测 ${reconnect.moved}）`);
  assert(reconnectGap !== null && reconnectGap <= 3.5,
    `重连后客户端位置必须与服务端权威位置连续（实测差 ${reconnectGap}）`);
  assert(reconnectAfter.walker.x !== reconnectBefore.walker.x || reconnectAfter.walker.y !== reconnectBefore.walker.y,
    '重连后不得被服务端位置覆盖回原点');

  const summary = {
    ok: true,
    pace: '1 real min = 10 game min; 1 game min = 6000ms（本脚本只验位移，时间由 pace-1to10 采）',
    walk: { movedTiles: walk.moved, tilesPerSecond: walk.tilesPerSecond, direction: walk.key, heldMs: walk.heldMs },
    sprint: { movedTiles: sprint.moved, tilesPerSecond: sprint.tilesPerSecond, direction: sprint.key, heldMs: sprint.heldMs },
    indoor: { room: indoor.room, movedTiles: indoor.movedTiles, tilesPerSecond: indoor.tilesPerSecond },
    resident: { id: fixture.id, from: fixture.from, to: fixture.to, length: num(fixture.length), serverMoved10s: num(serverMoved ?? 0), walkerMoved10s: num(walkerMoved ?? 0) },
    reconnect: { movedTiles: reconnect.moved, tilesPerSecond: reconnect.tilesPerSecond, gapToServer: num(reconnectGap ?? 0) },
    pageErrors: JSON.parse(await h.evaluate('JSON.stringify(window.__pageErrors)', sid)),
  };
  note('summary', summary);
  writeFileSync(join(OUT, 'browser.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
  console.log('[pace-move] PASS', JSON.stringify(summary));
} catch (error) {
  note('error', { message: String(error?.message ?? error), stack: String(error?.stack ?? '') });
  writeFileSync(join(OUT, 'browser.json'), JSON.stringify({ ok: false, error: String(error?.message ?? error) }, null, 2) + '\n', 'utf8');
  console.error('[pace-move] FAIL', error?.message ?? error);
  process.exitCode = 1;
} finally {
  await h.close({ settleMs: 400, removeTemp: true });
  writeFileSync(join(OUT, 'browser.log'), log.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
  console.log(`[pace-move] wrote ${join(OUT, 'browser.log')}`);
}
