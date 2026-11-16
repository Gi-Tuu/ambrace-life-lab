// 本地实机：种子营地跑到有儿童+老年，截图核对生命阶段外观。
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = 'E:/Competition/AMBRACElife/.agents/worktrees/v7-1-lifecycle';
const dir = mkdtempSync(join(tmpdir(), 'stages-'));
const port = 8211;
const server = spawn(process.execPath, ['serve.mjs'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', BRAIN: 'local', DATA_DIR: dir, SEED_FILE: join(ROOT, 'seed', 'world.json'), TICK_MS: '10000000', GAME_RULES: '1', GAME_MODE: 'game', MODEL_UNATTENDED: '0' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let boot = '';
server.stdout.on('data', (d) => { boot += String(d); });
for (let i = 0; i < 120 && !boot.includes('就绪'); i += 1) await new Promise((r) => setTimeout(r, 150));
const base = `http://127.0.0.1:${port}`;
const getWorld = async () => (await fetch(base + '/world')).json();

let stages = {};
for (let i = 0; i < 220; i += 1) {
  await fetch(base + '/ctl', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'step' }) });
  if (i % 24 === 0 || i === 219) {
    const w = await getWorld();
    stages = {};
    for (const a of Object.values(w.survival?.agents ?? {})) stages[a.stage] = (stages[a.stage] ?? 0) + 1;
    if (stages.child && stages.elder) break;
  }
}
const world = await getWorld();
console.log('t', world.survival.t, 'stages', JSON.stringify(stages), 'agents', Object.values(world.survival?.agents ?? {}).map((a) => `${a.name}:${a.stage}@${a.loc}`).join(' '));

const cdp = 9995 + Math.floor(Math.random() * 4);
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--user-data-dir=${join(tmpdir(), 'crstages-' + Date.now())}`,
  `--remote-debugging-port=${cdp}`, '--remote-allow-origins=*', '--window-size=1440,900',
  `${base}/?mode=survival`,
], { stdio: 'ignore' });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let wsUrl = null;
for (let i = 0; i < 80 && !wsUrl; i += 1) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${cdp}/json/list`)).json();
    const page = list.find((t) => t.type === 'page' && t.url.includes(`:${port}/`));
    if (page) wsUrl = page.webSocketDebuggerUrl;
  } catch { /* wait */ }
  await wait(250);
}
const ws = new WebSocket(wsUrl);
await new Promise((r) => { ws.onopen = r; });
let id = 0; const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evalj = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true }))?.result?.value;
await send('Page.enable');
await send('Runtime.enable');
await wait(9000);
// 室内/室外都可能；先把镜头切到能看到营地的状态
await evalj(`(function(){ const b=document.querySelector('#btnView'); if(b) b.click(); })()`);
await wait(2500);
const info = await evalj(`JSON.stringify({day: document.querySelector('#seasonDate')?.textContent, renderer: document.querySelector('#cvA')?.dataset.renderer ?? null, hud: Boolean(document.querySelector('#playerHud')?.textContent)})`);
console.log('页面:', info);
const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(join(tmpdir(), 'stages.png'), Buffer.from(shot.data, 'base64'));
console.log('截图:', join(tmpdir(), 'stages.png'));
ws.close(); chrome.kill(); server.kill();
await wait(300);
process.exit(0);
