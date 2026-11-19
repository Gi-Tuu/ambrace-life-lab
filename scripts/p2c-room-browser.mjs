#!/usr/bin/env node
// P2c 室内空间真实浏览器验收：用页面里的正式房间路径函数（roomSurface + moveRoomSurface）
// 验证门 portal、墙/家具/越界拒绝，以及 animate 里 IPOS 的真实按键位移（不是 Node 复刻）。
// 输出 evidence/redo-p2c/room-browser.log；不写真实存档。
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromeGate } from '../life/chrome-gate.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'evidence', 'redo-p2c', 'room-browser.log');
mkdirSync(dirname(OUT), { recursive: true });
const gate = chromeGate({ requireChrome: true });
if (gate.fail || !gate.path) throw new Error(gate.reason ?? '找不到 Chrome');
const CHROME = process.env.CHROME_PATH ?? gate.path;
const PORT = 9100 + (process.pid % 90);
const DATA = mkdtempSync(join(tmpdir(), 'p2c-room-data-'));
const PROFILE = mkdtempSync(join(tmpdir(), 'p2c-room-chrome-'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let server, chrome, cdp;
const lines = [];
const note = (kind, data) => { lines.push({ at: new Date().toISOString(), kind, ...data }); };

function startServer() {
  server = spawn(process.execPath, ['serve.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: DATA,
      SEED_FILE: join(ROOT, 'seed', 'world.json'), GAME_MODE: 'game', GAME_RULES: '1',
      BRAIN: 'local', TICK_MS: '10000000', MODEL_UNATTENDED: '0', V73_TEST: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  server.stdout.on('data', (d) => { out += String(d); });
  server.stderr.on('data', (d) => { out += String(d); });
  return { ready: async () => {
    for (let i = 0; i < 120 && !out.includes('就绪'); i += 1) await wait(150);
    if (!out.includes('就绪')) throw new Error('服务未就绪：' + out.slice(0, 300));
  } };
}

function startChrome() {
  chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-pipe', `--user-data-dir=${PROFILE}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  const writeFd = chrome.stdio[3], readFd = chrome.stdio[4];
  let buf = '';
  cdp = { pending: new Map() };
  cdp.send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const id = (cdp.seq = (cdp.seq ?? 0) + 1);
    cdp.pending.set(id, { res, rej });
    writeFd.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\u0000');
  });
  readFd.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    for (;;) {
      const end = buf.indexOf('\u0000');
      if (end < 0) return;
      const raw = buf.slice(0, end); buf = buf.slice(end + 1);
      if (!raw.trim()) continue;
      const msg = JSON.parse(raw);
      const p = cdp.pending.get(msg.id);
      if (p) { cdp.pending.delete(msg.id); msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result); }
    }
  });
}

async function evaluate(expression, sessionId) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true }, sessionId);
  if (r.exceptionDetails) throw new Error('JS 异常：' + r.exceptionDetails.text + ' ' + (r.result?.description ?? ''));
  return r.result.value;
}
async function waitFor(fn, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await wait(200); }
  return false;
}
const assert = (cond, message) => { if (!cond) throw new Error(message); };

try {
  const srv = startServer();
  await srv.ready();
  startChrome();
  const target = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const attached = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  const sid = attached.sessionId;
  await cdp.send('Page.enable', {}, sid);
  await cdp.send('Runtime.enable', {}, sid);
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` }, sid);
  assert(await waitFor(async () => Boolean(await evaluate('!!window.__lifeDebug', sid))), '页面未就绪');
  await wait(1200);
  assert(await waitFor(async () => !(await evaluate(`document.querySelector('#startSurvival')?.disabled ?? true`, sid))), '继续生存按钮一直禁用');
  await evaluate(`document.querySelector('#startSurvival').click()`, sid);
  assert(await waitFor(async () => await evaluate('window.__lifeDebug.S.playing === true', sid), 30000), '未进入游戏');
  await wait(800);

  const probe = await evaluate(`(()=>{
    const d=window.__lifeDebug, s=d.roomSpaceFor('hall'), R=d.roomDoorWorld();
    const px=x=>x*16, py=z=>z*16;
    const wall=d.moveRoomSurface('hall', px(8), py(6), -px(8), 0);
    const door=d.moveRoomSurface('hall', px(8), py(10), 0, py(4));
    return {
      door:R,
      doorWalk:s.walkable(8,11.5,.33),
      wallBlocked:s.walkable(.5,6,.33),
      furnitureBlocked:s.walkable(4,4,.33),
      outsideBlocked:s.walkable(2,13,.33),
      portalKind:s.portalAt(8,11.9,.2)?.kind ?? null,
      portalRoom:s.portalAt(8,11.9,.2)?.room ?? null,
      wallMove:{x:wall.moved[0],z:wall.moved[1]},
      doorMove:{x:door.moved[0],z:door.moved[1]},
    };
  })()`, sid);
  note('roomSpace', probe);
  assert(probe.doorWalk === true, '门口必须可站');
  assert(probe.wallBlocked === false, '左墙必须拒');
  assert(probe.furnitureBlocked === false, 'hall 长凳必须拒');
  assert(probe.outsideBlocked === false, '越出 16×12 必须拒');
  assert(probe.portalKind === 'door' && probe.portalRoom === 'hall', '门 portal 必须命中');
  assert(probe.wallMove.x > 2 * 16, `向左走必须被墙挡住，实测 x=${probe.wallMove.x}`);
  assert(probe.doorMove.z >= 11.6 * 16 && probe.doorMove.z <= 12 * 16 + .5, `门口必须可到且不得越过 12×16，实测 z=${probe.doorMove.z}`);

  // 真实 animate 路径：把 ui.interior 设成 hall，按 A 向右（左）走，看 IPOS 真的动且不穿墙。
  const before = await evaluate(`(()=>{const d=window.__lifeDebug;d.ui.interior='hall';d.ui.room='hall';d.IPOS.x=8*16-8;d.IPOS.y=8*16-16;return {x:d.IPOS.x,y:d.IPOS.y}})()`, sid);
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyA',key:'a',bubbles:true}))`, sid);
  await wait(700);
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keyup',{code:'KeyA',key:'a',bubbles:true}))`, sid);
  await wait(200);
  const after = await evaluate(`(()=>{const d=window.__lifeDebug,s=d.roomSpaceFor('hall');const fx=(d.IPOS.x+8)/16,fz=(d.IPOS.y+16)/16;return {x:d.IPOS.x,y:d.IPOS.y,walkable:s.walkable(fx,fz,.33)}})()`, sid);
  note('keyboardWalk', { before, after });
  assert(after.x < before.x - 2, `按 A 后 IPOS.x 必须真实左移，实测 ${before.x}→${after.x}`);
  assert(after.walkable === true, '键盘走完的脚点必须仍在房间可走面上');

  const text = JSON.stringify({ ok: true, lines }, null, 2) + '\n';
  writeFileSync(OUT, text);
  console.log(`[p2c-room] PASS door=(${probe.door.x},${probe.door.z},${probe.door.w},${probe.door.d}) wallMoveX=${probe.wallMove.x.toFixed(1)} ipos ${before.x.toFixed(1)}→${after.x.toFixed(1)}`);
  console.log(`[p2c-room] evidence: ${OUT}`);
} catch (error) {
  const text = JSON.stringify({ ok: false, error: String(error?.stack ?? error), lines }, null, 2) + '\n';
  writeFileSync(OUT, text);
  console.error('[p2c-room] FAIL ' + String(error?.message ?? error));
  console.error(`[p2c-room] evidence: ${OUT}`);
  process.exitCode = 1;
} finally {
  try { chrome?.kill(); } catch { /* ignore */ }
  try { server?.kill(); } catch { /* ignore */ }
  await wait(300);
}
