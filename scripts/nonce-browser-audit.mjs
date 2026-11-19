// 真 Chrome（remote-debugging-pipe）nonce 端到端：匿名 ctl 403、带 nonce 成功。
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const ROOT = process.cwd();
const PORT = 8811 + (process.pid % 100);
const DATA = mkdtempSync(join(tmpdir(), 'nonce-data-'));
const PROFILE = mkdtempSync(join(tmpdir(), 'nonce-chrome-'));
const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const log = [];
let server, chrome;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  server = spawn(process.execPath, ['serve.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: DATA, SEED_FILE: join(ROOT, 'seed/world.json'), GAME_MODE: 'game', GAME_RULES: '1', BRAIN: 'local', TICK_MS: '1000000' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; server.stdout.on('data', (d) => { out += d; }); server.stderr.on('data', (d) => { out += d; });
  for (let i = 0; i < 100 && !out.includes('就绪'); i += 1) await wait(150);
  if (!out.includes('就绪')) throw new Error('server not ready');
  chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-pipe', `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  const wfd = chrome.stdio[3], rfd = chrome.stdio[4]; let buf = ''; const pending = new Map();
  rfd.on('data', (c) => { buf += c.toString('utf8'); for (;;) { const i = buf.indexOf('\u0000'); if (i < 0) break; const raw = buf.slice(0, i); buf = buf.slice(i + 1); if (!raw.trim()) continue; const m = JSON.parse(raw); const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } } });
  let seq = 0; const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); wfd.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\u0000'); });
  const target = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  await send('Page.enable', {}, sessionId); await send('Runtime.enable', {}, sessionId);
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?room=hall` }, sessionId);
  await wait(2500);
  const r = await send('Runtime.evaluate', { expression: `(async()=>{
    const open=await fetch('/saves/open',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'nonce-e2e'})}).then(x=>x.json());
    const nonce=(document.cookie.split(';').map(x=>x.trim()).find(x=>x.startsWith('ctl_nonce='))??'').slice(10);
    const body={action:'catchup',minutes:1};
    const anon=await fetch('/ctl?camp='+open.key,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}).then(async x=>({status:x.status,json:await x.json()}));
    const authed=await fetch('/ctl?camp='+open.key,{method:'POST',headers:{'content-type':'application/json','x-ctl-nonce':nonce},body:JSON.stringify(body)}).then(async x=>({status:x.status,json:await x.json()}));
    return {openOk:open.ok,key:open.key,noncePresent:Boolean(nonce),cookie:document.cookie,anon,authed};
  })()`, returnByValue: true, awaitPromise: true, userGesture: true }, sessionId);
  const val = r.result?.value;
  log.push({ at: new Date().toISOString(), kind: 'nonce-e2e', result: val });
  mkdirSync('evidence/audit-fix', { recursive: true });
  writeFileSync('evidence/audit-fix/nonce-browser.log', log.map((x) => JSON.stringify(x)).join('\n') + '\n');
  console.log(JSON.stringify({ status: val?.anon?.status, authed: val?.authed?.status, nonce: val?.noncePresent, key: val?.key }));
} catch (e) {
  log.push({ at: new Date().toISOString(), error: String(e?.message ?? e) });
  mkdirSync('evidence/audit-fix', { recursive: true });
  writeFileSync('evidence/audit-fix/nonce-browser.log', log.map((x) => JSON.stringify(x)).join('\n') + '\n');
  console.error(e); process.exitCode = 1;
} finally { chrome?.kill(); server?.kill(); }
