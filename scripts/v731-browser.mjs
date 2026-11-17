#!/usr/bin/env node
// V7.3.1 §8 浏览器实测：连续行走/同刻同步/采集/连续劳动/busy/进度/取消/重开/重启/居民继续生活。
// 干净服务 + 临时 DATA_DIR + Chrome --remote-debugging-pipe（NUL 帧）。
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs'); mkdirSync(OUT, { recursive: true });
const log = [];
const note = (kind, data) => log.push({ at: new Date().toISOString(), kind, ...data });
const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 8700 + (process.pid % 200);
const DATA = mkdtempSync(join(tmpdir(), 'v731-data-'));
const PROFILE = mkdtempSync(join(tmpdir(), 'v731-chrome-'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let server, chrome, cdp;

function serverEnv() {
  return { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: DATA,
    SEED_FILE: join(ROOT, 'seed', 'world.json'), GAME_MODE: 'game', GAME_RULES: '1',
    BRAIN: 'local', TICK_MS: '2000', MODEL_UNATTENDED: '0', V73_TEST: '1' };
}
async function startServer() {
  server = spawn(process.execPath, ['serve.mjs'], { cwd: ROOT, env: serverEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  server.stdout.on('data', (d) => { out += String(d); });
  server.stderr.on('data', (d) => { out += String(d); });
  for (let i = 0; i < 100 && !out.includes('就绪'); i += 1) await wait(150);
  if (!out.includes('就绪')) throw new Error('服务未就绪：' + out.slice(0, 200));
}
async function stopServer() {
  if (!server) return;
  server.kill();
  await wait(600);
}
function startChrome() {
  chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run',
    '--remote-debugging-pipe', `--user-data-dir=${PROFILE}`, 'about:blank'],
  { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  const wfd = chrome.stdio[3], rfd = chrome.stdio[4];
  let buf = '';
  cdp = { pending: new Map() };
  cdp.send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const id = (cdp.seq = (cdp.seq ?? 0) + 1);
    cdp.pending.set(id, { res, rej });
    wfd.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\u0000');
  });
  rfd.on('data', (chunk) => {
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
async function evaluate(expression, sid) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true }, sid);
  if (r.exceptionDetails) throw new Error('JS: ' + r.exceptionDetails.text + ' ' + (r.result?.description ?? ''));
  return r.result.value;
}
async function post(path, body) {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return r.json().catch(() => null);
}
const act = (sid, body) => evaluate(`fetch('/act',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(${JSON.stringify({ mode: 'survival', ...body })})}).then(r=>r.json())`, sid);
const state = () => post('/ctl', { action: 'v73_state', confirm: true });
async function waitFor(fn, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await wait(200); }
  return false;
}

try {
  await startServer();
  startChrome();
  const target = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: sid } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  await cdp.send('Page.enable', {}, sid);
  await cdp.send('Runtime.enable', {}, sid);
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?room=hall` }, sid);
  if (!(await waitFor(async () => Boolean(await evaluate('!!window.__lifeDebug', sid))))) throw new Error('页面未就绪');
  await wait(800);
  note('ready', { port: PORT });
  const fix = await post('/ctl', { action: 'v73_fixture', confirm: true });
  note('fixture', fix);
  if (!fix?.ok) throw new Error('fixture 失败');
  await post('/ctl', { action: 'pause' }); // 夹具阶段暂停世界，避免 60 分池在请求间被 tick 重置
  let st = await state();
  const anchor = st.playerPos ?? st.anchor ?? st.hallSite ?? [22, 24];
  // 1) 连续行走 / 同刻多次同步（3 步共 3 单位，≤10/刻）
  const syncs = [];
  for (let i = 1; i <= 3; i += 1) syncs.push(await act(sid, { kind: 'player_sync', from: [anchor[0] + i, anchor[1]] }));
  note('sync', syncs);
  if (!syncs.every((r) => r?.ok)) throw new Error('同刻多次同步被拒: ' + JSON.stringify(syncs));
  // 2) 正常采集 ×3
  const move = await act(sid, { kind: 'move', room: 'yard' });
  const gathers = [];
  for (let i = 0; i < 3; i += 1) gathers.push(await act(sid, { kind: 'gather' }));
  st = await state();
  note('gather', { move, gathers, bag: st.bag, usedMin: st.usedMin });
  if (!move?.ok || !gathers.every((r) => r?.ok) || st.bag.wood < 6) throw new Error('采集失败: ' + JSON.stringify({ move, gathers, bag: st.bag }));
  // 3) 连续劳动到 35–59 分钟：逐次采集并按状态判断，留 <30 分给 build ⇒ busy
  for (let i = 0; i < 4 && (st.usedMin ?? 0) < 35; i += 1) { await act(sid, { kind: 'gather' }); st = await state(); }
  note('labor', { usedMin: st.usedMin, bag: st.bag });
  if ((st.usedMin ?? 0) < 35) throw new Error('未能消耗到 35 分钟: ' + JSON.stringify(st));
  const busyStart = await act(sid, { kind: 'build' });
  st = await state();
  note('busy', { busyStart, state: st });
  if (busyStart?.code !== 'BUSY_START') throw new Error('未进入 busy: ' + JSON.stringify(busyStart));
  let hud = '';
  for (let i = 0; i < 15; i += 1) {
    hud = await evaluate(`(()=>{const p=document.getElementById('playerHud');return JSON.stringify({text:p?.textContent??'',btn:!!document.getElementById('btnBusyCancel')})})()`, sid);
    if (JSON.parse(hud).btn) break;
    await wait(300);
  }
  note('hud', { ...JSON.parse(hud), state: await state() });
  const h = JSON.parse(hud);
  if (!h.btn || !h.text.includes('⏳ 动作')) throw new Error('HUD 未显示忙态/取消: ' + hud);
  // 4) 主动取消
  await evaluate(`document.getElementById('btnBusyCancel').click()`, sid);
  await wait(600);
  st = await state();
  note('cancel1', st);
  if (st.busy || st.cancelled.build !== 1 || st.progress !== 0 || st.usedMin !== 60) throw new Error('取消1异常: ' + JSON.stringify(st));
  // 5) 取消后重开：恢复一拍重置分钟，再暂停，耗 40 分 + build ⇒ busy，再次取消
  await post('/ctl', { action: 'resume' }); await wait(2200); await post('/ctl', { action: 'pause' });
  for (let i = 0; i < 4; i += 1) await act(sid, { kind: 'gather' });
  const reopen = await act(sid, { kind: 'build' });
  st = await state();
  note('reopen', { reopen, state: st });
  if (reopen?.code !== 'BUSY_START') throw new Error('重开未进 busy: ' + JSON.stringify(reopen));
  await wait(800);
  const canCancel2 = await evaluate("!!document.getElementById('btnBusyCancel')", sid);
  note('reopenHud', { canCancel2 });
  if (!canCancel2) throw new Error('重开 HUD 无取消按钮: ' + JSON.stringify(await state()));
  await evaluate("document.getElementById('btnBusyCancel').click()", sid);
  await wait(600);
  st = await state();
  note('cancel2', st);
  if (st.busy || st.cancelled.build !== 2) throw new Error('取消2异常: ' + JSON.stringify(st));
  // V7.3.2：30 次重复坐标同步仍不扣时间、不占额度（技术同步）
  const pos = st.playerPos ?? st.anchor;
  const usedBefore = st.usedMin;
  const sync30 = [];
  for (let i = 0; i < 30; i += 1) sync30.push(await act(sid, { kind: 'player_sync', from: [pos.x, pos.z] }));
  const syncState = await state();
  note('sync30', { ok: sync30.filter((r) => r?.ok).length, usedBefore, usedAfter: syncState.usedMin });
  if (!sync30.every((r) => r?.ok)) throw new Error('30 次重复同步被拒');
  if (syncState.usedMin !== usedBefore) throw new Error('同步改变了本刻分钟');
  // 6) 重启恢复：恢复一拍重置分钟并暂停，再留 busy；step 保存后重启
  await post('/ctl', { action: 'resume' }); await wait(2200); await post('/ctl', { action: 'pause' });
  for (let i = 0; i < 4; i += 1) await act(sid, { kind: 'gather' });
  const beforeRestart = await act(sid, { kind: 'build' });
  await post('/ctl', { action: 'step' });
  await wait(1500); // 等 act flush 落盘
  const pre = await state();
  note('preRestart', { beforeRestart, state: pre });
  await stopServer();
  await startServer();
  await wait(1200);
  const afterRestart = await state();
  note('restart', { before: pre, after: afterRestart });
  if (!afterRestart?.ok) throw new Error('重启后状态不可读');
  if (afterRestart.t < pre.t - 1) throw new Error('重启回退世界刻 ' + afterRestart.t + ' < ' + pre.t);
  if (afterRestart.bag.wood < pre.bag.wood - 2) throw new Error('重启丢失背包木料');
  // 7) 居民继续生活：恢复世界，抓两拍居民位置/动作差异
  await post('/ctl', { action: 'resume' });
  const r0 = await state();
  await wait(4200);
  const r1 = await state();
  const changed = JSON.stringify(r0.residents) !== JSON.stringify(r1.residents) || r1.t > r0.t;
  note('residents', { before: r0.residents, after: r1.residents, t0: r0.t, t1: r1.t, changed });
  if (!changed) throw new Error('居民在玩家劳动时没有继续生活');
  // 8) HUD 收尾
  const finalHud = await evaluate(`document.getElementById('playerHud')?.textContent ?? ''`, sid);
  note('finalHud', { text: finalHud });
  writeFileSync(join(OUT, 'v731-browser.log'), log.map((x) => JSON.stringify(x)).join('\n') + '\n');
  console.log(JSON.stringify({ ok: true, syncs: syncs.map((r) => r?.ok), gathers: gathers.map((r) => r?.ok),
    hud: h.text, cancel1: { usedMin: 60, cancelled: st.cancelled }, restarted: afterRestart.t >= pre.t,
    residentsChanged: changed }, null, 2));
} catch (error) {
  note('error', { message: String(error?.message ?? error) });
  writeFileSync(join(OUT, 'v731-browser.log'), log.map((x) => JSON.stringify(x)).join('\n') + '\n');
  console.error('FAILED:', error?.message ?? error); console.error(error?.stack ?? '');
  process.exitCode = 1;
} finally {
  try { chrome?.kill(); } catch {}
  try { server?.kill(); } catch {}
  await wait(400);
  try { rmSync(DATA, { recursive: true, force: true }); } catch {}
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch {}
}








