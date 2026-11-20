#!/usr/bin/env node
// 1.1 第 4 项证据：真实浏览器里两次 /world 轮询之间 HUD 世界分钟是否在走，
// 暂停是否冻结、倍速是否按 rate、busy 是否按分钟递减，以及两张间隔 1–2s 的 HUD 截图。
//
// 只读观测：脚本不改世界规则，不 push；所有数值来自页面 __lifeDebug.clockHud() 与 HUD DOM。
// 一条命令：node scripts/v11-time-ui.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCdpHarness } from './lib/cdp-harness.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'evidence', 'v11-time-ui');
mkdirSync(OUT, { recursive: true });
const log = [];
const note = (kind, data = {}) => { log.push({ at: new Date().toISOString(), kind, ...data }); };
const h = createCdpHarness({
  root: ROOT,
  port: 8600 + (process.pid % 300),
  dataPrefix: 'v11-time-data-',
  profilePrefix: 'v11-time-chrome-',
  chrome: 'fixed',
  serverEnv: {
    GAME_MODE: 'game', GAME_RULES: '1', SIM_TIME: '1', TICK_MS: '7500',
    BRAIN: 'local', MODEL_UNATTENDED: '0', V73_TEST: '1',
  },
  waitMs: 20000,
});
const assert = (cond, message) => { if (!cond) throw new Error(message); };
const post = (path, body) => h.post(path, body);
const ctl = (body) => post('/ctl', { confirm: true, ...body });
const sum = (value) => Number(Number(value).toFixed(3));

try {
  await h.startServer();
  h.startChrome();
  const probe = `window.__pageErrors=[];
    addEventListener('error', e => window.__pageErrors.push({kind:'error',m:e.message,f:e.filename,l:e.lineno}));
    addEventListener('unhandledrejection', e => window.__pageErrors.push({kind:'rejection',m:String(e.reason&&e.reason.message||e.reason)}));`;
  const sid = await h.openPage({ url: `${h.origin}/`, probe });
  await h.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, sid);
  assert(await h.waitFor(async () => Boolean(await h.evaluate('!!window.__lifeDebug?.S', sid)), 20000, sid), '页面未就绪');
  // 从标题页进入生存（与 quickstart 同一条真实 UI 路径）。
  assert(await h.waitFor(async () => !(await h.evaluate(`document.querySelector('#startSurvival')?.disabled`, sid)), 20000, sid), '继续生存按钮一直禁用');
  await h.evaluate(`document.querySelector('#startSurvival').click()`, sid);
  assert(await h.waitFor(async () => await h.evaluate('window.__lifeDebug.S.playing === true', sid), 15000, sid), '未进入游戏');
  assert(await h.waitFor(async () => await h.evaluate(`!!document.querySelector('#playerHud [data-hud="dayleft"]')`, sid), 15000, sid), 'HUD 时钟未出现');
  // 收掉第一次进入的三步引导，避免它遮住右上角时刻；这只是本地 UI 状态，不写世界。
  await h.evaluate(`document.querySelector('#firstRun [data-firstrun="skip"]')?.click()`, sid);
  await h.wait(300);
  await h.wait(600);
  note('ready', { port: h.port, href: await h.evaluate('location.href', sid) });

  const sample = async (label) => {
    const raw = await h.evaluate(`JSON.stringify({
      perfNow: performance.now(), wall: Date.now(),
      clock: window.__lifeDebug.clockHud(),
      date: document.querySelector('#seasonDate')?.textContent ?? '',
      weather: document.querySelector('#seasonWeather')?.textContent ?? '',
      player: document.querySelector('#playerHud')?.textContent ?? '',
      busy: document.querySelector('#playerHud [data-hud="busy"]')?.textContent ?? null,
      pageErrors: window.__pageErrors
    })`, sid);
    const row = JSON.parse(raw);
    note('hud', { label, ...row });
    return row;
  };

  // ① 两次轮询之间（相隔 1.2s）HUD 必须在走，并截两张图。
  const a = await sample('A');
  await h.screenshot(sid, join(OUT, 'hud-a.png'));
  await h.wait(1200);
  const b = await sample('B');
  await h.screenshot(sid, join(OUT, 'hud-b.png'));
  assert(a.clock?.minutes != null && b.clock?.minutes != null, 'clockHud 没有世界分钟');
  const delta1 = b.clock.minutes - a.clock.minutes;
  assert(delta1 > 5, `1.2s 内 HUD 世界分钟没有明显前进：${a.clock.minutes} -> ${b.clock.minutes}`);
  assert(b.clock.leftToday < a.clock.leftToday, `今日剩余没有递减：${a.clock.leftToday} -> ${b.clock.leftToday}`);
  assert(a.weather !== b.weather || a.clock.clock !== b.clock.clock, 'HUD 时刻/天气文本没有变化');
  assert(a.clock.anchor?.rate === 1 && a.clock.anchor?.paused === false, '正常态 anchor 不是 rate=1 未暂停');

  // ② 暂停：两帧之间显示分钟不得漂移。
  assert((await ctl({ action: 'pause' })).body?.ok !== false, '暂停失败');
  await h.wait(1200); // 等下一次 /world 把 paused 带到前端
  const p1 = await sample('paused-A');
  await h.screenshot(sid, join(OUT, 'hud-paused-a.png'));
  assert(p1.clock?.anchor?.paused === true, '前端 anchor 未收到 paused:true');
  await h.wait(1200);
  const p2 = await sample('paused-B');
  assert(p2.clock.minutes === p1.clock.minutes, `暂停后世界分钟漂移：${p1.clock.minutes} -> ${p2.clock.minutes}`);
  assert(p2.clock.leftToday === p1.clock.leftToday, `暂停后今日剩余漂移：${p1.clock.leftToday} -> ${p2.clock.leftToday}`);

  // ③ 倍速：先在 1× 取一个 4s 窗口，再切 rate=2 取同样长度窗口，增量应明显翻倍。
  assert((await ctl({ action: 'resume' })).body?.ok !== false, '恢复失败');
  await h.wait(1200); // 等 rate=1 进入 anchor
  const l1 = await sample('rate1-A');
  await h.wait(4000);
  const l2 = await sample('rate1-B');
  const delta1x = l2.clock.minutes - l1.clock.minutes;
  assert(delta1x > 5, `1× 窗口 HUD 世界分钟没有前进：${l1.clock.minutes} -> ${l2.clock.minutes}`);

  assert((await ctl({ action: 'rate', rate: 2 })).body?.ok !== false, '倍速设置失败');
  await h.wait(1200); // 等 rate=2 进入 anchor
  const r1 = await sample('rate2-A');
  await h.wait(4000);
  const r2 = await sample('rate2-B');
  await h.screenshot(sid, join(OUT, 'hud-rate2.png'));
  const delta2x = r2.clock.minutes - r1.clock.minutes;
  assert(r1.clock?.anchor?.rate === 2, '前端 anchor 未收到 rate=2');
  assert(delta2x > 14, `rate=2 时 4s 增量过小：${delta2x}`);
  const ratio = delta2x / delta1x;
  assert(ratio > 1.5 && ratio < 2.3, `倍速增量比应接近 2，实测 ${ratio.toFixed(2)}（${delta1x} vs ${delta2x}）`);

  // ④ busy：回到 1×，注入工地夹具，起一个 30 分钟长动作；HUD 的剩余分钟应按世界分钟递减。
  assert((await ctl({ action: 'rate', rate: 1 })).body?.ok !== false, '恢复 1× 失败');
  const fixture = await ctl({ action: 'v73_fixture' });
  assert(fixture.body?.ok, '工地夹具注入失败：' + JSON.stringify(fixture.body));
  const setup = JSON.parse(await h.evaluate(`(async()=>{
    const rooms=['yard','hall','yard','hall','yard','hall','yard'];
    const moves=[];
    for (const room of rooms) moves.push(await fetch('/act',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mode:'survival',kind:'move',room})}).then(r=>r.json()));
    const build=await fetch('/act',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mode:'survival',kind:'build'})}).then(r=>r.json());
    return JSON.stringify({moves:moves.map(m=>[m.ok,m.code??'OK']),build});
  })()`, sid));
  note('busy.setup', setup);
  assert(setup.build?.code === 'BUSY_START', '未进入 busy：' + JSON.stringify(setup));
  assert(await h.waitFor(async () => await h.evaluate(`!!document.querySelector('#playerHud [data-hud="busy"]')`, sid), 10000, sid), 'HUD 未出现 busy 进度');
  const busy1 = await sample('busy-A');
  await h.wait(1000);
  const busy2 = await sample('busy-B');
  await h.screenshot(sid, join(OUT, 'hud-busy.png'));
  const remain1 = Number.parseFloat(String(busy1.busy).replace(/[^\d.]/g, ''));
  const remain2 = Number.parseFloat(String(busy2.busy).replace(/[^\d.]/g, ''));
  assert(Number.isFinite(remain1) && Number.isFinite(remain2), `busy 进度不可读：${busy1.busy} / ${busy2.busy}`);
  assert(remain2 < remain1, `busy 剩余没有按分钟递减：${remain1} -> ${remain2}`);
  assert(remain2 > 0, 'busy 已被前端提前置完成（剩余应为正，完成只能等 /world）');

  // ⑤ 服务端权威：取消后 HUD 以 /world 为准（脚本只验证 busy 消失，不写世界）。
  assert((await post('/act', { mode: 'survival', kind: 'busy_cancel' })).body?.ok, '取消失败');
  assert(await h.waitFor(async () => !(await h.evaluate(`!!document.querySelector('#playerHud [data-hud="busy"]')`, sid)), 10000, sid), '取消后 HUD busy 未消失');

  const summary = {
    ok: true,
    hudBefore: { clock: a.clock.clock, leftToday: a.clock.leftToday, weather: a.weather },
    hudAfter: { clock: b.clock.clock, leftToday: b.clock.leftToday, weather: b.weather },
    deltaMinutes1x: sum(delta1),
    paused: { minutesA: p1.clock.minutes, minutesB: p2.clock.minutes, leftToday: p1.clock.leftToday, paused: p1.clock.anchor.paused },
    rateWindows: { oneX4s: sum(delta1x), twoX4s: sum(delta2x), ratio: sum(ratio), anchorRate: r1.clock.anchor.rate },
    busy: { remainA: remain1, remainB: remain2 },
    notes: 'times are page performance.now()/Date.now(); screenshots hud-a/hud-b are 1.2s apart',
  };
  note('summary', summary);
  console.log('[v11-time-ui] PASS', JSON.stringify(summary));
} catch (error) {
  note('error', { message: String(error?.message ?? error), stack: String(error?.stack ?? '') });
  console.error('[v11-time-ui] FAIL', error?.message ?? error);
  process.exitCode = 1;
} finally {
  await h.close({ settleMs: 400, removeTemp: true });
  writeFileSync(join(OUT, 'hud-samples.log'), log.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
  console.log(`[v11-time-ui] wrote ${join(OUT, 'hud-samples.log')}`);
}
