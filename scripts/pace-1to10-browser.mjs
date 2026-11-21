#!/usr/bin/env node
// 时间节奏 1:10 的真实浏览器闸门与证据采集。
//
// 口径：GAME_MS_PER_MINUTE=6000、TICK_MS=360000（部署同值）。
//   · 现实 60s 内服务端世界分钟必须推进 10 分（1:10）；
//   · HUD 锚点读同一个 clock.msPerGameMinute，6s 插值≈1 分；
//   · 暂停冻结、rate=2 按倍速走；
//   · 截图落 evidence/pace-1to10/。
// 只读观测：不改世界规则、不 push、不部署。
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCdpHarness } from './lib/cdp-harness.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'evidence', 'pace-1to10');
mkdirSync(OUT, { recursive: true });
const log = [];
const note = (kind, data = {}) => log.push({ at: new Date().toISOString(), kind, ...data });
const h = createCdpHarness({
  root: ROOT,
  port: 8900 + (process.pid % 300),
  dataPrefix: 'pace-1to10-data-',
  profilePrefix: 'pace-1to10-chrome-',
  chrome: 'fixed',
  serverEnv: {
    GAME_MODE: 'game', GAME_RULES: '1', SIM_TIME: '1',
    GAME_MS_PER_MINUTE: '6000', TICK_MS: '360000',
    BRAIN: 'local', MODEL_UNATTENDED: '0', V73_TEST: '1',
  },
  waitMs: 20000,
});
const assert = (cond, message) => { if (!cond) throw new Error(message); };
const post = (path, body) => h.post(path, { confirm: true, ...body });
const num = (v) => Number(Number(v).toFixed(3));

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
  assert(await h.waitFor(async () => await h.evaluate(`!!document.querySelector('#playerHud [data-hud="dayleft"]')`, sid), 15000, sid), 'HUD 时钟未出现');
  await h.evaluate(`document.querySelector('#firstRun [data-firstrun="skip"]')?.click()`, sid);
  await h.wait(400);

  const sample = async (label) => {
    const row = JSON.parse(await h.evaluate(`JSON.stringify({
      perfNow: performance.now(), wall: Date.now(),
      clock: window.__lifeDebug.clockHud(),
      hud: document.querySelector('#playerHud')?.textContent ?? '',
      weather: document.querySelector('#seasonWeather')?.textContent ?? '',
      pageErrors: window.__pageErrors
    })`, sid));
    note('hud', { label, ...row });
    return row;
  };
  const health = async () => {
    const j = await (await fetch(`${h.origin}/healthz`)).json();
    return j.world.clock;
  };

  const ms = (await sample('A')).clock?.anchor?.msPerGameMinute;
  assert(ms === 6000, `HUD 锚点 msPerGameMinute 必须是 6000，实测 ${ms}`);
  const a = await sample('A');
  await h.screenshot(sid, join(OUT, 'hud-a.png'));

  // ① 现实 60s = 10 游戏分：服务端权威钟（不受 HUD 5s 外推封顶影响）。
  const h0 = await health();
  const t0 = Date.now();
  // HUD 在 6s 处也取一帧，作为 1 游戏分插值的可见证据。
  await h.wait(6000);
  const mid = await sample('6s');
  const hMid = await health();
  const midDelta = mid.clock.minutes - a.clock.minutes;
  assert(midDelta > 0.6 && midDelta < 1.4, `6s HUD 增量应≈1 游戏分，实测 ${midDelta}`);
  await h.wait(54000);
  const b = await sample('60s');
  await h.screenshot(sid, join(OUT, 'hud-b.png'));
  const h1 = await health();
  const realMin = (Date.now() - t0) / 60000;
  const gameMin = h1.gameMinutes - h0.gameMinutes;
  const ratio = gameMin / realMin;
  assert(Math.abs(ratio - 10) < 0.5, `现实 60s 必须推进 ~10 游戏分（实测 ${realMin.toFixed(2)} 真实分 → ${gameMin.toFixed(2)} 游戏分，比 1:${ratio.toFixed(2)}）`);
  assert(b.clock.minutes - a.clock.minutes > 9, `60s HUD 世界分钟应≈10：${a.clock.minutes} -> ${b.clock.minutes}`);

  // ② 暂停：HUD 与服务端同时冻结。
  assert((await post('/ctl', { action: 'pause' })).body?.ok !== false, '暂停失败');
  await h.wait(1200);
  const p1 = await sample('paused-A');
  const hp1 = await health();
  await h.wait(1500);
  const p2 = await sample('paused-B');
  const hp2 = await health();
  assert(p1.clock.anchor?.paused === true, '前端 anchor 未收到 paused:true');
  assert(p2.clock.minutes === p1.clock.minutes, `暂停后 HUD 漂移：${p1.clock.minutes} -> ${p2.clock.minutes}`);
  assert(hp2.gameMinutes === hp1.gameMinutes, `暂停后服务端钟漂移：${hp1.gameMinutes} -> ${hp2.gameMinutes}`);
  await h.screenshot(sid, join(OUT, 'hud-paused.png'));

  // ③ 倍速：rate=2 时 6s 应走 2 游戏分。
  assert((await post('/ctl', { action: 'rate', rate: 2 })).body?.ok !== false, '倍速失败');
  assert((await post('/ctl', { action: 'resume' })).body?.ok !== false, '恢复失败');
  await h.wait(1200);
  const r1 = await sample('rate2-A');
  const hr0 = await health();
  await h.wait(6000);
  const r2 = await sample('rate2-B');
  const hr1 = await health();
  const fastGame = hr1.gameMinutes - hr0.gameMinutes;
  assert(r1.clock.anchor?.rate === 2, '前端 anchor 未收到 rate=2');
  assert(fastGame > 1.5 && fastGame < 2.6, `rate=2 下 6s 应≈2 游戏分，实测 ${fastGame}`);
  await h.screenshot(sid, join(OUT, 'hud-rate2.png'));

  const summary = {
    ok: true,
    pace: '1 real min = 10 game min; 1 game min = 6000ms; 1 day = 144 real min',
    serverEnv: { GAME_MS_PER_MINUTE: 6000, TICK_MS: 360000 },
    sixtySeconds: { realMinutes: num(realMin), gameMinutes: num(gameMin), ratio: num(ratio) },
    hudSixSeconds: { from: a.clock.minutes, mid: mid.clock.minutes, delta: num(midDelta) },
    hudSixtySeconds: { from: a.clock.minutes, to: b.clock.minutes, delta: num(b.clock.minutes - a.clock.minutes) },
    paused: { hudA: p1.clock.minutes, hudB: p2.clock.minutes, serverA: hp1.gameMinutes, serverB: hp2.gameMinutes },
    rate2SixSeconds: { serverDelta: num(fastGame), hudDelta: num(r2.clock.minutes - r1.clock.minutes) },
    hudAnchorMsPerGameMinute: ms,
    pageErrors: b.pageErrors,
  };
  note('summary', summary);
  writeFileSync(join(OUT, 'pace.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
  console.log('[pace-1to10] PASS', JSON.stringify(summary));
} catch (error) {
  note('error', { message: String(error?.message ?? error), stack: String(error?.stack ?? '') });
  writeFileSync(join(OUT, 'pace.json'), JSON.stringify({ ok: false, error: String(error?.message ?? error) }, null, 2) + '\n', 'utf8');
  console.error('[pace-1to10] FAIL', error?.message ?? error);
  process.exitCode = 1;
} finally {
  await h.close({ settleMs: 400, removeTemp: true });
  writeFileSync(join(OUT, 'pace.log'), log.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
  console.log(`[pace-1to10] wrote ${join(OUT, 'pace.log')}`);
}
