#!/usr/bin/env node
// 5 分钟真实路径的浏览器验收：起服 → 进游戏 → 走 → 采集 → 吃 → 睡 → 看 HUD → 死亡后世界继续。
// 输出既写 stdout，也写 evidence/score/quickstart-browser.log，供 QUICKSTART.md 逐条对照。
//
// 边界：这是本机 Chrome（CDP pipe）冒烟，不是跨浏览器兼容性测试；动作通过页面同源 /act 触发，
// UI 菜单/按钮/HUD 是真实 DOM 点击与读数。QUICKSTART 里写的按钮必须与本脚本断言的一致。
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCdpHarness } from './lib/cdp-harness.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'evidence', 'score', 'quickstart-browser.log');
mkdirSync(dirname(OUT), { recursive: true });
const log = [];
const note = (kind, data = {}) => { log.push({ at: new Date().toISOString(), kind, ...data }); };
const h = createCdpHarness({
  root: ROOT,
  port: 8900 + (process.pid % 90),
  dataPrefix: 'quickstart-data-',
  profilePrefix: 'quickstart-chrome-',
  serverEnv: {
    GAME_MODE: 'game', GAME_RULES: '1', BRAIN: 'local', TICK_MS: '10000000',
    MODEL_UNATTENDED: '0', V73_TEST: '1',
  },
});
const assert = (cond, message) => { if (!cond) throw new Error(message); };
const post = (path, body) => h.post(path, body);
const act = async (body) => (await post('/act', { mode: 'survival', ...body })).body;
const ctl = async (body) => (await post('/ctl', { confirm: true, ...body })).body;

try {
  await h.startServer();
  note('server.started', { port: h.port, dataDir: h.dataDir, gameMode: 'game', gameRules: 1 });
  h.startChrome();
  const sid = await h.openPage({ url: `${h.origin}/` });
  // 与 v73/v731 同口径：__lifeDebug 在模块前段就存在，等 S 才能发现模块求值中断的假绿。
  assert(await h.waitFor(async () => Boolean(await h.evaluate('!!window.__lifeDebug?.S', sid))), '页面未就绪');
  await h.wait(1000);

  const menu = await h.evaluate(`(()=>({survival:document.querySelector('#startSurvival')?.textContent,newGame:document.querySelector('#startNew')?.textContent,camp:document.querySelector('#campEnter')?.textContent,compare:document.querySelector('#startCompare')?.textContent}))()`, sid);
  note('ui.menu', menu);
  assert(menu.survival === '继续生存', `菜单按钮文案变了：${menu.survival}`);
  assert(menu.newGame === '新开一局', `菜单按钮文案变了：${menu.newGame}`);
  assert(menu.camp === '进入 / 开新营地', `营地按钮文案变了：${menu.camp}`);

  assert(await h.waitFor(async () => !(await h.evaluate(`document.querySelector('#startSurvival').disabled`, sid))), '继续生存按钮一直禁用');
  await h.evaluate(`document.querySelector('#startSurvival').click()`, sid);
  assert(await h.waitFor(async () => await h.evaluate('window.__lifeDebug.S.playing === true', sid)), '点击继续生存后没有进入游戏');
  await h.wait(800);
  const hud = await h.evaluate(`(()=>({date:document.querySelector('#seasonDate')?.textContent,weather:document.querySelector('#seasonWeather')?.textContent,player:document.querySelector('#playerHud')?.textContent,place:document.querySelector('#placeHud')?.textContent}))()`, sid);
  note('ui.hud.initial', hud);
  assert(/第\s*\d+\s*天|第\s*\d+\s*日/.test(hud.date ?? '') && /体力/.test(hud.player ?? ''), `HUD 没显示天数/体力：${JSON.stringify(hud)}`);

  // 走：真实键盘事件驱动场景里的玩家 walker（WALK 里还有居民；必须取 p1）。
  const before = await h.evaluate(`(()=>{const W=window.__lifeDebug.WALK;const k=Object.keys(W).find(k=>k.endsWith(':p1'))??Object.keys(W)[0];return {key:k,x:W[k].x,y:W[k].y,menu:window.__lifeDebug.ui.menu}})()`, sid);
  note('walk.before', before);
  await h.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyD',key:'d',bubbles:true}))`, sid);
  await h.wait(700);
  await h.evaluate(`window.dispatchEvent(new KeyboardEvent('keyup',{code:'KeyD',key:'d',bubbles:true}))`, sid);
  const after = await h.evaluate(`(()=>{const W=window.__lifeDebug.WALK;const k=${JSON.stringify(before.key)};return {x:W[k].x,y:W[k].y}})()`, sid);
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
  const tAfterDeath = (await ctl({ action: 'v73_state' })).t;
  // 轮询是 900ms 一次；固定等 1200ms 在并行负载下会偶发“服务端已死、页面还没刷新”。
  // 这里等真实 DOM 条件，最多 10s，仍然要求横幅真的出现，不放宽产品语义。
  let banner = '';
  const bannerShown = await h.waitFor(async () => {
    banner = await h.evaluate(`document.querySelector('.survbanner.bad')?.textContent ?? ''`, sid);
    return /你倒下了/.test(banner);
  }, 10000, sid);
  note('death.after', { beforeDeathT, tAfterDeath, banner, bannerShown });
  assert(tAfterDeath > beforeDeathT, `玩家死亡后世界没有继续：${beforeDeathT} → ${tAfterDeath}`);
  assert(bannerShown, `死亡后页面没有出现“你倒下了”横幅：${banner}`);

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
  await h.close({ settleMs: 0 });
  writeFileSync(OUT, log.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
  console.log(`[quickstart] wrote ${OUT}`);
}
