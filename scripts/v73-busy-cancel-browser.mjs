#!/usr/bin/env node
// V7.3 第三批浏览器夹具：真实服务 + Chrome（CDP pipe），验证 busy HUD/取消按钮/幂等/账本。
// 一条命令：node scripts/v73-busy-cancel-browser.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs');
mkdirSync(OUT, { recursive: true });
const log = [];
const note = (kind, data) => { log.push({ at: new Date().toISOString(), kind, ...data }); };
const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 8500 + (process.pid % 300);
const DATA = mkdtempSync(join(tmpdir(), 'v73-cancel-data-'));
const PROFILE = mkdtempSync(join(tmpdir(), 'v73-cancel-chrome-'));
let server, chrome, cdp;

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function startServer() {
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
  for (let i = 0; i < 120 && !out.includes('就绪'); i += 1) await wait(150);
  if (!out.includes('就绪')) throw new Error('服务未就绪：' + out.slice(0, 300));
}

function startChrome() {
  chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-pipe', `--user-data-dir=${PROFILE}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  const writeFd = chrome.stdio[3];
  const readFd = chrome.stdio[4];
  let buf = '';

  function write(obj) {
    // Chrome pipe 协议：每条 JSON 消息以 NUL 结尾。
    writeFd.write(JSON.stringify(obj) + '\u0000');
  }
  function send(method, params = {}, sessionId) {
    return new Promise((resolvePromise, reject) => {
      const id = (send.seq = (send.seq ?? 0) + 1);
      cdp.pending.set(id, { resolvePromise, reject });
      write({ id, method, params, ...(sessionId ? { sessionId } : {}) });
    });
  }
  cdp = { pending: new Map(), send };
  readFd.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    for (;;) {
      const end = buf.indexOf('\u0000');
      if (end < 0) return;
      const raw = buf.slice(0, end);
      buf = buf.slice(end + 1);
      if (!raw.trim()) continue;
      const msg = JSON.parse(raw);
      const p = cdp.pending.get(msg.id);
      if (p) { cdp.pending.delete(msg.id); msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolvePromise(msg.result); }
    }
  });
}

async function evaluate(expression, sessionId) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true }, sessionId);
  if (r.exceptionDetails) throw new Error('JS 异常：' + r.exceptionDetails.text + ' ' + (r.result?.description ?? ''));
  return r.result.value;
}

async function post(path, body) {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
}

async function waitFor(fn, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await wait(200);
  }
  return false;
}

try {
  await startServer();
  startChrome();
  const target = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const attached = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  const sid = attached.sessionId;
  await cdp.send('Page.enable', {}, sid);
  await cdp.send('Runtime.enable', {}, sid);
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?room=hall` }, sid);
  if (!(await waitFor(async () => Boolean(await evaluate('!!window.__lifeDebug', sid))))) throw new Error('页面未就绪');
  await wait(1200);
  note('ready', { port: PORT, href: await evaluate('location.href', sid) });

  // 受控夹具：院子工地 + 木石（V73_TEST=1）
  const fixture = await post('/ctl', { action: 'v73_fixture', confirm: true });
  note('fixture', fixture);
  if (!fixture.body?.ok) throw new Error('夹具注入失败');

  // 真实动作消耗 35 分钟，再发起 30 分钟施工 ⇒ busy（剩 5 分钟）
  const setup = await evaluate(`(async()=>{
    const rooms=['yard','hall','yard','hall','yard','hall','yard'];
    const moves=[];
    for (const room of rooms) moves.push(await fetch('/act',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mode:'survival',kind:'move',room})}).then(r=>r.json()));
    const build=await fetch('/act',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mode:'survival',kind:'build'})}).then(r=>r.json());
    return JSON.stringify({moves:moves.map(m=>[m.ok,m.code??'OK']),build});
  })()`, sid);
  note('setup', JSON.parse(setup));
  if (JSON.parse(setup).build.code !== 'BUSY_START') throw new Error('未进入 busy：' + setup);

  // 等页面刷新出 busy HUD（TICK_MS 很大，服务端状态稳定）
  await wait(1200);
  const hud = await evaluate(`(()=>{const p=window.__lifeDebug.S.view?.player;return JSON.stringify({busy:p?.busy??null,hud:document.getElementById('playerHud')?.textContent??'',btn:!!document.getElementById('btnBusyCancel')})})()`, sid);
  note('hud', JSON.parse(hud));
  const h = JSON.parse(hud);
  if (!h.busy || !h.btn) throw new Error('HUD 未出现忙态/取消按钮：' + hud);
  if (!h.hud.includes('⏳ 动作') || !h.hud.includes('剩 5 分')) throw new Error('HUD 文案不对：' + h.hud);

  // 点击取消按钮
  await evaluate(`document.getElementById('btnBusyCancel').click()`, sid);
  await wait(800);
  const after = await post('/ctl', { action: 'v73_state', confirm: true });
  note('afterCancel', after.body);
  const st = after.body;
  const cancelledEvents = (st.events ?? []).filter((e) => e.status === 'cancelled');
  if (st.busy) throw new Error('取消后仍 busy');
  if (st.usedMin !== 60) throw new Error('取消后本刻分钟被改动：' + st.usedMin);
  if ((st.cancelled?.build ?? 0) !== 1) throw new Error('账本未写 cancelled');
  if (cancelledEvents.length !== 1) throw new Error('cancelled 事件数量不对：' + cancelledEvents.length);
  if (st.progress !== 0) throw new Error('取消后成果被结算：progress=' + st.progress);

  // 幂等：再取消得到 NO_BUSY；再推进一拍也不补结算
  const again = await post('/act', { mode: 'survival', kind: 'busy_cancel' });
  note('again', again.body);
  if (again.body?.code !== 'NO_BUSY') throw new Error('二次取消应 NO_BUSY：' + JSON.stringify(again.body));
  await post('/ctl', { action: 'step' });
  await wait(500);
  const finalState = await post('/ctl', { action: 'v73_state', confirm: true });
  note('final', finalState.body);
  if ((finalState.body?.events ?? []).filter((e) => e.status === 'cancelled').length !== 1) throw new Error('事件重复结算');
  if (finalState.body?.progress !== 0) throw new Error('推进后补结算了成果');

  const btnGone = await evaluate(`!document.getElementById('btnBusyCancel')`, sid);
  note('uiAfter', { btnGone });
  writeFileSync(join(OUT, 'v73-busy-cancel-browser.log'), log.map((x) => JSON.stringify(x)).join('\n') + '\n');
  console.log(JSON.stringify({ ok: true, hud: h.hud, after: st, again: again.body, final: finalState.body }, null, 2));
} catch (error) {
  note('error', { message: String(error?.message ?? error) });
  writeFileSync(join(OUT, 'v73-busy-cancel-browser.log'), log.map((x) => JSON.stringify(x)).join('\n') + '\n');
  console.error('FAILED:', error?.message ?? error);
  process.exitCode = 1;
} finally {
  try { chrome?.kill(); } catch {}
  try { server?.kill(); } catch {}
  await wait(400);
  try { rmSync(DATA, { recursive: true, force: true }); } catch {}
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch {}
}



