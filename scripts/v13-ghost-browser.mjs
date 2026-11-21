#!/usr/bin/env node
// 1.3 幽魂观察真实浏览器验收（CDP）：
//   A 睡梦中饿死 → 幽魂：横幅/HUD/动作被拒/镜头平移缩放跟随/居民继续行动/刷新后仍在观察；
//   B 聚落灭绝 → 唯一终局：ended/extinct 持久，刷新后仍是终局。
// 只读 + 通过既有 /act、/ctl 与真实 DOM 事件驱动；证据写 evidence/v13-ghost/。
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCdpHarness } from './lib/cdp-harness.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'evidence', 'v13-ghost');
mkdirSync(OUT, { recursive: true });
const log = [];
const note = (kind, data = {}) => log.push({ at: new Date().toISOString(), kind, ...data });
const h = createCdpHarness({
  root: ROOT,
  port: 9300 + (process.pid % 60),
  dataPrefix: 'v13-ghost-data-',
  profilePrefix: 'v13-ghost-chrome-',
  serverEnv: {
    GAME_MODE: 'game', GAME_RULES: '1', BRAIN: 'local',
    GAME_MS_PER_MINUTE: '6000', TICK_MS: '360000',
    MODEL_UNATTENDED: '0', V73_TEST: '1',
  },
  waitMs: 20000,
});
const assert = (cond, message) => { if (!cond) throw new Error(message); };
const body = async (path, payload) => (await h.post(path, payload)).body;
const ctl = (payload) => body('/ctl', { confirm: true, ...payload });
const act = (payload) => body('/act', { mode: 'survival', ...payload });
const state = () => ctl({ action: 'v13_state' });
const sumActions = (st) => Object.values(st.residentActions ?? {}).reduce((a, b) => a + b, 0);
const press = async (sid, code, key, ms = 500) => {
  await h.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{code:${JSON.stringify(code)},key:${JSON.stringify(key)},bubbles:true}))`, sid);
  await h.wait(ms);
  await h.evaluate(`window.dispatchEvent(new KeyboardEvent('keyup',{code:${JSON.stringify(code)},key:${JSON.stringify(key)},bubbles:true}))`, sid);
};

try {
  await h.startServer();
  note('server.started', { port: h.port });
  h.startChrome();
  const sid = await h.openPage({ url: `${h.origin}/` });
  assert(await h.waitFor(async () => Boolean(await h.evaluate('!!window.__lifeDebug?.S', sid))), '页面未就绪');
  await h.wait(900);
  await h.evaluate(`document.querySelector('#startSurvival').click()`, sid);
  assert(await h.waitFor(async () => await h.evaluate('window.__lifeDebug.S.playing === true', sid)), '没有进入生存');
  await h.wait(800);

  // ── A：睡梦中饿死 → 幽魂 ────────────────────────────────────────────────
  const home = await act({ kind: 'move', room: 'home' });
  assert(home.ok, `走回家失败：${JSON.stringify(home)}`);
  await ctl({ action: 'step' }); // 让日界账先结算，睡梦中才会真的饿死
  const normal = await state();
  assert(normal.player.dead === false && normal.ghost.active === false, `起点不应是幽魂：${JSON.stringify(normal)}`);
  const starve = await ctl({ action: 'v13_fixture', op: 'starve', v: 0.0015 });
  assert(starve.ok, `饿死夹具失败：${JSON.stringify(starve)}`);
  const sleep = await act({ kind: 'camp_sleep' });
  note('sleep.death', { starve, sleep });
  assert(sleep.ok && sleep.ghost === true, `睡梦中没有转幽魂：${JSON.stringify(sleep)}`);
  const ghost = await state();
  assert(ghost.player.dead && ghost.ghost.active, `服务端不是幽魂态：${JSON.stringify(ghost)}`);
  assert(ghost.ended === false && ghost.endReason == null, `玩家死亡不得终局：${JSON.stringify(ghost)}`);
  assert(ghost.ghost.at && Number.isFinite(ghost.ghost.at.x), '幽魂镜头锚点缺失');

  const ghostBanner = await h.waitFor(async () => {
    const text = await h.evaluate(`document.querySelector('.survbanner')?.textContent ?? ''`, sid);
    return /你已化为幽魂/.test(text);
  }, 10000, sid);
  const hud = await h.evaluate(`(()=>({banner:document.querySelector('.survbanner')?.textContent??'',player:document.querySelector('#playerHud')?.textContent??'',panel:document.querySelector('#survPanel')?.textContent??'',body:document.body.classList.contains('ghost-mode'),hotbar:getComputedStyle(document.querySelector('#hotbar')).display}))()`, sid);
  note('ghost.hud', hud);
  assert(ghostBanner, `幽魂横幅没出现：${JSON.stringify(hud)}`);
  assert(!/你倒下了/.test(hud.banner), '旧终局横幅还在');
  assert(hud.body, 'body 没有 ghost-mode');
  assert(/幽魂观察/.test(hud.player) || /幽魂观察/.test(hud.panel), `HUD 没有幽魂观察：${JSON.stringify(hud)}`);
  assert(!/体力/.test(hud.player), `幽魂 HUD 仍显示体力：${hud.player}`);
  assert(hud.hotbar === 'none', `幽魂态工具栏应收起：${hud.hotbar}`);

  const denied = [];
  for (const payload of [
    { kind: 'gather', tool: 'pick' },
    { kind: 'camp_eat' }, { kind: 'camp_sleep' }, { kind: 'exchange', type: 'berry' },
    { kind: 'build', type: 'shelter' }, { kind: 'move', room: 'yard' },
    { kind: 'player_sync', from: [ghost.player.pos?.x ?? 60, ghost.player.pos?.z ?? 40] },
  ]) {
    const r = await act(payload);
    denied.push({ kind: payload.kind, ok: r?.ok, code: r?.code });
  }
  note('ghost.actions', denied);
  assert(denied.every((r) => r.ok === false && r.code === 'PLAYER_DEAD'), `幽魂动作没有被全部拒绝：${JSON.stringify(denied)}`);

  // 镜头：WASD 平移 / 滚轮缩放 / 跟随居民。
  const g0 = await h.evaluate(`(()=>{const g=window.__lifeDebug.ghost();const d=document.querySelector('#cvA')._debug;return {g,focus:d?.focus??null}})()`, sid);
  await press(sid, 'KeyD', 'd', 600);
  await h.evaluate(`(()=>{const cv=document.querySelector('#cvA');cv.dispatchEvent(new WheelEvent('wheel',{deltaY:-260,clientX:220,clientY:150,bubbles:true,cancelable:true}));return true})()`, sid);
  await h.wait(220);
  const g1 = await h.evaluate(`(()=>{const g=window.__lifeDebug.ghost();const d=document.querySelector('#cvA')._debug;return {g,focus:d?.focus??null}})()`, sid);
  const panned = Math.hypot(g1.g.cam.x - g0.g.cam.x, g1.g.cam.z - g0.g.cam.z);
  note('ghost.camera.panzoom', { before: g0, after: g1, panned });
  assert(g1.g.active && panned > 1, `WASD 没平移幽魂镜头（${panned}）`);
  assert(g1.g.span !== g0.g.span, `滚轮没缩放幽魂镜头（${g0.g.span} → ${g1.g.span}）`);

  await h.evaluate(`document.querySelector('#survPanel [data-ghost="follow"]')?.click()`, sid);
  await h.wait(700);
  const g2 = await h.evaluate(`window.__lifeDebug.ghost()`, sid);
  note('ghost.camera.follow', g2);
  assert(g2.cam?.follow, `“跟随居民”没有选中居民：${JSON.stringify(g2)}`);
  // 真点画布：先点空地取消跟随，再（按当前镜头）点居民重新跟随。
  const followWho = g2.cam?.follow;
  await h.evaluate(`(()=>{const cv=document.querySelector('#cvA'),r=cv.getBoundingClientRect();
    cv.dispatchEvent(new MouseEvent('click',{clientX:r.left+r.width*0.08,clientY:r.top+r.height*0.08,bubbles:true}));return true})()`, sid);
  await h.wait(250);
  const gEmpty = await h.evaluate(`window.__lifeDebug.ghost()`, sid);
  const residentAt = await h.evaluate(`(()=>{
    const cv=document.querySelector('#cvA'), cam=cv._cam, who=${JSON.stringify(followWho)};
    const p=(cam?.people??[]).find(q=>q.who===who);
    if(!p) return {missing:true,people:(cam?.people??[]).map(q=>q.who)};
    const [sx,sy]=cam.project3d.project(p.x,p.y+1.2,p.z), r=cv.getBoundingClientRect();
    return {who,x:r.left+sx/cv.width*r.width,y:r.top+sy/cv.height*r.height,sx,sy,cvw:cv.width,cvh:cv.height,cssw:cv.clientWidth,cssh:cv.clientHeight,rect:{x:r.x,y:r.y,w:r.width,h:r.height},people:(cam?.people??[]).map(q=>({who:q.who,x:q.x,y:q.y,z:q.z}))};
  })()`, sid);
  assert(residentAt, '无法把跟随居民投影到画布');
  await h.evaluate(`(()=>{const cv=document.querySelector('#cvA');
    cv.dispatchEvent(new MouseEvent('click',{clientX:${residentAt.x},clientY:${residentAt.y},bubbles:true}));return true})()`, sid);
  await h.wait(250);
  const g3 = await h.evaluate(`window.__lifeDebug.ghost()`, sid);
  note('ghost.camera.clickResident', { residentAt, afterEmpty: gEmpty, after: g3 });
  assert(!gEmpty.cam?.follow, `点空地没有取消跟随：${JSON.stringify(gEmpty.cam)}`);
  assert(g3.cam?.follow === residentAt.who, `点居民没有跟随：期望 ${residentAt.who}，实测 ${JSON.stringify(g3.cam)}`);

  const posBefore = JSON.stringify(ghost.player.pos);
  const beforeActions = sumActions(ghost);
  const beforeMinutes = ghost.clockMinutes;
  await ctl({ action: 'step' });
  await ctl({ action: 'step' });
  const after = await state();
  note('ghost.world', { beforeMinutes, afterMinutes: after.clockMinutes, beforeActions, afterActions: sumActions(after), t: after.t });
  assert(after.t > ghost.t, '幽魂态世界刻没有推进');
  assert(after.clockMinutes >= beforeMinutes + 10, `幽魂态 10 游戏分没有推进：${beforeMinutes} → ${after.clockMinutes}`);
  assert(sumActions(after) > beforeActions, `幽魂态居民没有继续行动：${beforeActions} → ${sumActions(after)}`);
  assert(JSON.stringify(after.player.pos) === posBefore, '镜头/步骤不得移动玩家实体');

  await h.screenshot(sid, join(OUT, 'ghost-observe.png'));
  // 刷新（整页导航）后仍在观察：用 ?mode=survival 直连生存入口，等价于刷新后点「继续生存」。
  await h.navigate(sid, `${h.origin}/?mode=survival`);
  assert(await h.waitFor(async () => Boolean(await h.evaluate('window.__lifeDebug?.S?.view?.player?.dead === true', sid)), 15000, sid), '刷新后没有恢复幽灵视图');
  const reloadBanner = await h.waitFor(async () => /你已化为幽魂/.test(await h.evaluate(`document.querySelector('.survbanner')?.textContent ?? ''`, sid)), 10000, sid);
  const reloaded = await state();
  note('ghost.reload', { reloaded, reloadBanner });
  assert(reloadBanner, '刷新后幽魂横幅没回来');
  assert(reloaded.ghost.active === true && reloaded.ended === false, `刷新后幽魂状态丢失：${JSON.stringify(reloaded)}`);
  await h.screenshot(sid, join(OUT, 'ghost-reload.png'));

  // ── B：聚落灭绝 → 唯一终局（且持久）────────────────────────────────────
  const kill = await ctl({ action: 'v13_fixture', op: 'kill_residents' });
  assert(kill.ok && kill.population === 0, `灭绝夹具失败：${JSON.stringify(kill)}`);
  let extinct = await state();
  for (let i = 0; i < 30 && !extinct.ended; i += 1) {
    await ctl({ action: 'step' });
    extinct = await state();
  }
  note('extinct', { t: extinct.t, ended: extinct.ended, endReason: extinct.endReason, settlement: extinct.settlement, population: extinct.population });
  assert(extinct.ended === true && extinct.endReason === 'extinct', `聚落灭绝没有触发唯一终局：${JSON.stringify(extinct)}`);
  assert(extinct.settlement === 'extinct', `settlement 不是 extinct：${extinct.settlement}`);
  const endBanner = await h.waitFor(async () => /终局/.test(await h.evaluate(`document.querySelector('.survbanner')?.textContent ?? ''`, sid)), 10000, sid);
  assert(endBanner, '灭绝后没有出现终局横幅');
  await h.screenshot(sid, join(OUT, 'extinct.png'));

  await h.navigate(sid, `${h.origin}/?mode=survival`);
  assert(await h.waitFor(async () => Boolean(await h.evaluate('window.__lifeDebug?.S?.view?.ended === true', sid)), 15000, sid), '刷新后终局没有恢复');
  const persisted = await state();
  note('extinct.reload', persisted);
  assert(persisted.ended === true && persisted.endReason === 'extinct', `灭绝终局没有持久：${JSON.stringify(persisted)}`);

  const summary = {
    ok: true, result: '睡梦中死→幽魂（世界继续/动作全拒/镜头平移缩放跟随/刷新仍在观察）→ 聚落灭绝唯一终局（持久）',
    ghost: { banner: hud.banner, hud: { player: hud.player, hotbar: hud.hotbar }, actions: denied, camera: { panned: Number(panned.toFixed(3)), zoomed: g1.g.span !== g0.g.span, follow: g3.cam?.follow }, world: { beforeMinutes, afterMinutes: after.clockMinutes, beforeActions, afterActions: sumActions(after) } },
    reloadGhost: { active: reloaded.ghost.active, ended: reloaded.ended },
    extinction: { ended: extinct.ended, endReason: extinct.endReason, settlement: extinct.settlement, t: extinct.t, persisted: { ended: persisted.ended, endReason: persisted.endReason } },
  };
  note('summary', summary);
  writeFileSync(join(OUT, 'browser.json'), JSON.stringify({ generatedAt: new Date().toISOString(), ...summary }, null, 2) + '\n');
  console.log('[v13-ghost] PASS', JSON.stringify(summary));
} catch (error) {
  note('error', { message: String(error?.stack ?? error) });
  console.error('[v13-ghost] FAIL', error);
  process.exitCode = 1;
} finally {
  await h.close({ settleMs: 0, removeTemp: true });
  writeFileSync(join(OUT, 'browser.log'), log.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
  console.log(`[v13-ghost] wrote ${OUT}`);
}
