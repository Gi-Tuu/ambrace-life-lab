#!/usr/bin/env node
// 5 分钟真实路径的浏览器验收：起服 → 进游戏 → 走 → 采集 → 吃 → 睡 → 看 HUD → 死亡后世界继续。
// 输出既写 stdout，也写 evidence/score/quickstart-browser.log，供 QUICKSTART.md 逐条对照。
//
// 边界：这是本机 Chrome（CDP pipe）冒烟，不是跨浏览器兼容性测试；动作通过页面同源 /act 触发，
// UI 菜单/按钮/HUD 是真实 DOM 点击与读数。QUICKSTART 里写的按钮必须与本脚本断言的一致。
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromeGate } from '../life/chrome-gate.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'evidence', 'score', 'quickstart-browser.log');
mkdirSync(dirname(OUT), { recursive: true });
const log = [];
const note = (kind, data = {}) => { log.push({ at: new Date().toISOString(), kind, ...data }); };
const gate = chromeGate({ requireChrome: true });
if (gate.fail || !gate.path) throw new Error(gate.reason ?? '找不到 Chrome');
const CHROME = process.env.CHROME_PATH ?? gate.path;
const PORT = 8900 + (process.pid % 90);
const DATA = mkdtempSync(join(tmpdir(), 'quickstart-data-'));
const PROFILE = mkdtempSync(join(tmpdir(), 'quickstart-chrome-'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let server, chrome, cdp;

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

async function post(path, body) {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const act = async (body) => (await post('/act', { mode: 'survival', ...body })).body;
const ctl = async (body) => (await post('/ctl', { confirm: true, ...body })).body;
async function waitFor(fn, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await wait(200); }
  return false;
}
const assert = (cond, message) => { if (!cond) throw new Error(message); };

try {
  const srv = startServer();
  await srv.ready();
  note('server.started', { port: PORT, dataDir: DATA, gameMode: 'game', gameRules: 1 });
  startChrome();
  const target = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const attached = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  const sid = attached.sessionId;
  await cdp.send('Page.enable', {}, sid);
  await cdp.send('Runtime.enable', {}, sid);
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` }, sid);
  assert(await waitFor(async () => Boolean(await evaluate('!!window.__lifeDebug', sid))), '页面未就绪');
  await wait(1000);

  const menu = await evaluate(`(()=>({survival:document.querySelector('#startSurvival')?.textContent,newGame:document.querySelector('#startNew')?.textContent,camp:document.querySelector('#campEnter')?.textContent,compare:document.querySelector('#startCompare')?.textContent}))()`, sid);
  note('ui.menu', menu);
  assert(menu.survival === '继续生存', `菜单按钮文案变了：${menu.survival}`);
  assert(menu.newGame === '新开一局', `菜单按钮文案变了：${menu.newGame}`);
  assert(menu.camp === '进入 / 开新营地', `营地按钮文案变了：${menu.camp}`);

  assert(await waitFor(async () => !(await evaluate(`document.querySelector('#startSurvival').disabled`, sid))), '继续生存按钮一直禁用');
  await evaluate(`document.querySelector('#startSurvival').click()`, sid);
  assert(await waitFor(async () => await evaluate('window.__lifeDebug.S.playing === true', sid)), '点击继续生存后没有进入游戏');
  await wait(800);
  const hud = await evaluate(`(()=>({date:document.querySelector('#seasonDate')?.textContent,weather:document.querySelector('#seasonWeather')?.textContent,player:document.querySelector('#playerHud')?.textContent,place:document.querySelector('#placeHud')?.textContent}))()`, sid);
  note('ui.hud.initial', hud);
  assert(/第\s*\d+\s*天|第\s*\d+\s*日/.test(hud.date ?? '') && /体力/.test(hud.player ?? ''), `HUD 没显示天数/体力：${JSON.stringify(hud)}`);

  // 走：真实键盘事件驱动场景里的玩家 walker（WALK 里还有居民；必须取 p1）。
  const before = await evaluate(`(()=>{const W=window.__lifeDebug.WALK;const k=Object.keys(W).find(k=>k.endsWith(':p1'))??Object.keys(W)[0];return {key:k,x:W[k].x,y:W[k].y,menu:window.__lifeDebug.ui.menu}})()`, sid);
  note('walk.before', before);
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyD',key:'d',bubbles:true}))`, sid);
  await wait(700);
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keyup',{code:'KeyD',key:'d',bubbles:true}))`, sid);
  const after = await evaluate(`(()=>{const W=window.__lifeDebug.WALK;const k=${JSON.stringify(before.key)};return {x:W[k].x,y:W[k].y}})()`, sid);
  const moved = Math.hypot(after.x - before.x, after.y - before.y);
  note('walk', { before, after, moved: Number(moved.toFixed(3)) });
  assert(moved > 0.05, `按 D 后角色没有移动（${moved}）`);

  // 采集：种子档里院子木料已采空；走到瞭台采石（UI 提示「镐（3）：采石（瞭台/井台）」）。
  const mv = await act({ kind: 'move', room: 'watch' });
  note('act.move.watch', mv);
  assert(mv?.ok, `走到瞭台失败：${JSON.stringify(mv)}`);
  const stone0 = (await ctl({ action: 'v73_state' })).bag?.stone ?? 0;
  const gather = await act({ kind: 'gather', tool: 'pick' });
  const stone1 = (await ctl({ action: 'v73_state' })).bag?.stone ?? 0;
  note('act.gather', { result: gather, stone0, stone1 });
  assert(gather?.ok, `采集失败：${JSON.stringify(gather)}`);
  assert(stone1 > stone0, `采集成功但石料没有增加：${stone0} → ${stone1}`);

  // 吃：到公仓，等到真的饿了（能量 ≤0.6）再走 camp_eat；与 UI「在公仓吃一份」同一条服务端入口。
  const ms = await act({ kind: 'move', room: 'store' });
  note('act.move.store', ms);
  assert(ms?.ok, `走到公仓失败：${JSON.stringify(ms)}`);
  let energy = (await ctl({ action: 'v73_state' })).energy ?? 1;
  let steps = 0;
  while (energy > 0.6 && steps < 30) { await ctl({ action: 'step' }); energy = (await ctl({ action: 'v73_state' })).energy ?? 1; steps += 1; }
  const store0 = (await ctl({ action: 'v73_state' })).store ?? null;
  const eat = await act({ kind: 'camp_eat' });
  const stAfterEat = await ctl({ action: 'v73_state' });
  const store1 = stAfterEat.store ?? null;
  note('act.eat', { energy, steps, result: eat, store0, store1, energyAfter: stAfterEat.energy });
  assert(eat?.ok, `在公仓吃一份失败：${JSON.stringify(eat)}（energy=${energy}）`);
  assert(store0 !== null && store1 !== null && store1 === store0 - 1, `吃饭没有扣一份公仓粮：${store0} → ${store1}`);

  // 睡：回家点床的后端同一条 camp_sleep；返回推进刻数。
  const mh = await act({ kind: 'move', room: 'home' });
  note('act.move.home', mh);
  assert(mh?.ok, `走回家失败：${JSON.stringify(mh)}`);
  const t0 = (await ctl({ action: 'v73_state' })).t;
  const sleep = await act({ kind: 'camp_sleep' });
  const t1 = (await ctl({ action: 'v73_state' })).t;
  note('act.sleep', { before: t0, after: t1, result: sleep });
  assert(sleep?.ok && (sleep.ticks ?? 0) > 0, `睡觉没有推进刻：${JSON.stringify(sleep)}`);
  assert(t1 > t0, `睡觉后世界刻没有前进：${t0} → ${t1}`);

  // 死亡：仅 V73_TEST 夹具把存续归零；页面横幅必须出现，且世界刻继续前进。
  const beforeDeathT = t1;
  const death = await ctl({ action: 'quickstart_death' });
  note('death.fixture', death);
  assert(death?.ok && death.dead, `死亡夹具没有生效：${JSON.stringify(death)}`);
  await ctl({ action: 'step' });
  await ctl({ action: 'step' });
  await wait(1200);
  const tAfterDeath = (await ctl({ action: 'v73_state' })).t;
  const banner = await evaluate(`document.querySelector('.survbanner.bad')?.textContent ?? ''`, sid);
  note('death.after', { beforeDeathT, tAfterDeath, banner });
  assert(tAfterDeath > beforeDeathT, `玩家死亡后世界没有继续：${beforeDeathT} → ${tAfterDeath}`);
  assert(/你倒下了/.test(banner), `死亡后页面没有出现“你倒下了”横幅：${banner}`);

  const summary = {
    ok: true,
    result: '起服→继续生存→走→采集→吃→睡→HUD→死亡后世界继续',
    hud,
    walkMoved: Number(moved.toFixed(3)),
    gather: { stone0, stone1 },
    eat: { energy: Number(energy.toFixed(3)), store0, store1 },
    sleep: { ticks: sleep.ticks, t0, t1 },
    death: { beforeDeathT, tAfterDeath, banner },
  };
  note('summary', summary);
  console.log('[quickstart] PASS', JSON.stringify(summary));
} catch (error) {
  note('error', { message: String(error?.stack ?? error) });
  console.error('[quickstart] FAIL', error);
  process.exitCode = 1;
} finally {
  try { chrome?.kill(); } catch {}
  try { server?.kill(); } catch {}
  writeFileSync(OUT, log.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
  console.log(`[quickstart] wrote ${OUT}`);
}
