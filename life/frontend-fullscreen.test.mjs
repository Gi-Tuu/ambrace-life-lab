// 全屏与交互反馈闸门（所有者 2026-11-16 实机反馈两条）：
//   ①「全屏模式下没做好适配」——旧写法把 #hotbar/#itemBar 留在页面流里，全屏时它们以
//     「普通布局的位置」浮在场景上并被拉成整条宽，引导卡还压住时钟；纯静态断言看不出来，
//     所以这里用真 Chrome + CDP 在三种视口下量矩形。
//   ②「按 F 时建筑进不去没有任何提示」——防连点可以静默，状态失败与走不过去不行。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

import { chromeGate } from './chrome-gate.mjs';

const APP = readFileSync('web/app.js', 'utf8');
const GATE = chromeGate();

// 全屏里 HUD 与场景的相对位置：只量"看得见且占面积"的元素对，重叠 >2px 就算红。
const PROBE = `(() => {
  const ids = ['hotbar','itemBar','seasonHud','playerHud','placeHud','firstRun','fullHud','cvFull','gameHud'];
  const els = {};
  for (const id of ids) {
    const e = document.getElementById(id);
    if (!e) continue;
    const b = e.getBoundingClientRect(), cs = getComputedStyle(e);
    els[id] = { x:b.x, y:b.y, w:b.width, h:b.height, pos:cs.position,
      vis: cs.display !== 'none' && !e.hidden && b.width > 0 && b.height > 0 };
  }
  const pairs = [['hotbar','seasonHud'],['hotbar','playerHud'],['hotbar','firstRun'],['hotbar','placeHud'],
    ['itemBar','hotbar'],['itemBar','firstRun'],['itemBar','placeHud'],
    ['seasonHud','firstRun'],['playerHud','firstRun'],['placeHud','firstRun'],
    ['fullHud','seasonHud'],['fullHud','playerHud']];
  const hits = [];
  for (const [a,b] of pairs) {
    const x = els[a], y = els[b];
    if (!x || !y || !x.vis || !y.vis) continue;
    const ix = Math.min(x.x+x.w, y.x+y.w) - Math.max(x.x, y.x);
    const iy = Math.min(x.y+x.h, y.y+y.h) - Math.max(x.y, y.y);
    if (ix > 2 && iy > 2) hits.push(a + '×' + b);
  }
  const oob = Object.entries(els)
    .filter(([,e]) => e.vis && (e.x < -2 || e.y < -2 || e.x+e.w > innerWidth+2 || e.y+e.h > innerHeight+2))
    .map(([k]) => k);
  const hb = els.hotbar, vp = els.cvFull;
  const anchor = hb && vp && hb.vis ? {
    pos: hb.pos,
    nearBottom: Math.abs((innerHeight - (hb.y + hb.h)) - 14) < 26,          // 贴在画面下沿，不是留在页面流的位置
    centered: Math.abs((hb.x + hb.w / 2) - innerWidth / 2) < 24,            // 水平居中
    notStretched: hb.w < innerWidth * 0.72,                                 // 不被拉成整条宽
    insideCanvas: hb.y >= vp.y && hb.y + hb.h <= vp.y + vp.h + 2,           // 落在画面范围内
  } : null;
  return { hits, oob, anchor, hotbarPos: els.hotbar ? els.hotbar.pos : null,
    hudParent: document.getElementById('gameHud').parentElement.id };
})()`;

test('F15 全屏 HUD：三种视口下不重叠不越界，退出全屏回到页面流', { skip: GATE.skip ? GATE.reason : false }, async () => {
  if (GATE.fail) assert.fail(GATE.reason);
  const CHROME = GATE.path;
  const dir = mkdtempSync(join(tmpdir(), 'ambrace-fs-'));
  const port = 18980 + (process.pid % 15);
  const child = spawn(process.execPath, ['serve.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir, SEED_FILE: join(dir, 'none.json'),
      BRAIN: 'local', GAME_MODE: 'game', GAME_RULES: '1', TICK_MS: '60000', GAME_MS_PER_MINUTE: '60000', MODEL_PROVIDERS: '', MODEL_KEYS: '', CHAT_TOKEN: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let socket, browser;
  try {
    await new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error('server boot timeout')), 15000);
      child.stdout.on('data', (d) => { if (String(d).includes('就绪')) { clearTimeout(to); res(); } });
      child.on('exit', (c) => rej(new Error('server exited ' + c)));
    });
    const profile = join(dir, 'prof');
    browser = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--remote-debugging-port=0',
      `--user-data-dir=${profile}`, `http://127.0.0.1:${port}/?mode=survival`], { stdio: 'ignore', windowsHide: true });
    const until = async (probe, ms = 25000) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) { const v = await probe(); if (v) return v; await new Promise((r) => setTimeout(r, 120)); }
      throw new Error('浏览器层超时');
    };
    const dp = await until(() => { try { return Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { return 0; } });
    const wsUrl = await until(async () => {
      try { const p = await (await fetch(`http://127.0.0.1:${dp}/json`)).json(); return p.find((x) => x.type === 'page')?.webSocketDebuggerUrl; } catch { return null; }
    });
    socket = new WebSocket(wsUrl);
    await new Promise((res, rej) => { socket.addEventListener('open', res, { once: true }); socket.addEventListener('error', rej, { once: true }); });
    let seq = 0;
    const send = (method, params = {}) => new Promise((res, rej) => {
      const id = ++seq;
      const onMsg = (ev) => { const m = JSON.parse(ev.data); if (m.id !== id) return; socket.removeEventListener('message', onMsg); if (m.error) rej(new Error(`${method}: ${m.error.message}`)); else res(m.result); };
      socket.addEventListener('message', onMsg);
      socket.send(JSON.stringify({ id, method, params }));
    });
    const js = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.value;

    // 先进游戏再进全屏：菜单态里这些元素都不在最终位置，量了也不算
    await until(() => js(`Boolean(document.querySelector('#hotbar .slot'))`));
    await until(() => js(`!document.getElementById('startSurvival').disabled`));
    await js(`document.getElementById('startSurvival').click(); true`);
    await until(() => js(`!document.body.classList.contains('menu-mode') && !document.getElementById('worldMain').hidden`));
    await js(`document.getElementById('btnFull').click(); true`);
    await new Promise((r) => setTimeout(r, 400));

    for (const [w, h] of [[1280, 720], [1920, 1080], [2560, 1080]]) {
      await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
      await js(`window.dispatchEvent(new Event('resize')); true`);
      await new Promise((r) => setTimeout(r, 350));
      const m = await js(PROBE);
      assert.equal(m.hudParent, 'fullViewport', `${w}×${h}：全屏没把 HUD 搬进 #fullViewport`);
      assert.deepEqual(m.hits, [], `${w}×${h} 全屏 HUD 相互重叠：${m.hits.join(' , ')}`);
      assert.deepEqual(m.oob, [], `${w}×${h} 全屏 HUD 越出视口：${m.oob.join(' , ')}`);
      assert.equal(m.hotbarPos, 'fixed', `${w}×${h} 全屏下热键栏没有重新锚定（仍留在页面流里）`);
      // 所有者截图上的病灶就在这里：热键栏停在页面流的位置、被拉成整条宽，压着场景上沿。
      // 只断言 pos==='fixed' 不够——去掉 bottom 锚定后它仍是 fixed 却位置错。
      assert.ok(m.anchor, `${w}×${h}：量不到热键栏矩形`);
      assert.ok(m.anchor.nearBottom, `${w}×${h}：热键栏没有贴在画面下沿（全屏锚定失效）`);
      assert.ok(m.anchor.centered, `${w}×${h}：热键栏没有水平居中`);
      assert.ok(m.anchor.notStretched, `${w}×${h}：热键栏被拉成整条宽（应随内容收拢）`);
    }

    // 退出全屏：锚定必须撤销，否则窗口模式的布局会被全屏规则倒着改掉
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
    await js(`document.getElementById('btnFullExit').click(); true`);
    await new Promise((r) => setTimeout(r, 400));
    const back = await js(`({ pos:getComputedStyle(document.getElementById('hotbar')).position, parent:document.getElementById('gameHud').parentElement.id, on:document.body.classList.contains('full-on') })`);
    assert.equal(back.on, false, '退出全屏后 body 仍带 full-on');
    assert.equal(back.parent, 'gameViewport', '退出全屏后 HUD 没搬回页面视口');
    assert.equal(back.pos, 'static', '退出全屏后热键栏仍是 fixed（全屏锚定没撤销）');
  } finally {
    socket?.close();
    browser?.kill();
    child.kill();
    await new Promise((r) => setTimeout(r, 400));
  }
});

test('F16 交互失败必须有可见反馈，只有防连点允许静默', () => {
  assert.match(APP, /if \(!S\.campReady\) \{ toast\(/, '世界未就绪时静默 return ⇒ 玩家只看到"按了没反应"');
  assert.match(APP, /if \(!moved\.ok\) \{ toast\(/, '走不过去必须说原因：旧实现是静默 return moved');
  assert.match(APP, /if \(!S\.playing\) \{ toast\(/, '未进入世界时静默 return');
  assert.doesNotMatch(APP, /if \(campBusy \|\| !S\.campReady\) return null;/, '仍把防连点与未就绪合并成一条静默 return');
  assert.doesNotMatch(APP, /if \(campBusy \|\| !S\.playing\) return;/, '仍把防连点与未进游戏合并成一条静默 return');
});
