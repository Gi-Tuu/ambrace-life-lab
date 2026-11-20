#!/usr/bin/env node
// V7.3 第三批浏览器夹具：真实服务 + Chrome（CDP pipe），验证 busy HUD/取消按钮/幂等/账本。
// 一条命令：node scripts/v73-busy-cancel-browser.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCdpHarness } from './lib/cdp-harness.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs');
mkdirSync(OUT, { recursive: true });
const log = [];
const note = (kind, data) => { log.push({ at: new Date().toISOString(), kind, ...data }); };
const h = createCdpHarness({
  root: ROOT,
  port: 8500 + (process.pid % 300),
  dataPrefix: 'v73-cancel-data-',
  profilePrefix: 'v73-cancel-chrome-',
  chrome: 'fixed',
  serverEnv: {
    GAME_MODE: 'game', GAME_RULES: '1', BRAIN: 'local', TICK_MS: '10000000',
    MODEL_UNATTENDED: '0', V73_TEST: '1',
  },
  waitMs: 15000,
});
const wait = h.wait;
const post = (path, body) => h.post(path, body);

try {
  await h.startServer();
  h.startChrome();
  const sid = await h.openPage({ url: `${h.origin}/?room=hall` });
  if (!(await h.waitFor(async () => Boolean(await h.evaluate('!!window.__lifeDebug', sid))))) throw new Error('页面未就绪');
  await wait(1200);
  note('ready', { port: h.port, href: await h.evaluate('location.href', sid) });

  // 受控夹具：院子工地 + 木石（V73_TEST=1）
  const fixture = await post('/ctl', { action: 'v73_fixture', confirm: true });
  note('fixture', fixture);
  if (!fixture.body?.ok) throw new Error('夹具注入失败');

  // 真实动作消耗 35 分钟，再发起 30 分钟施工 ⇒ busy（剩 5 分钟）
  const setup = await h.evaluate(`(async()=>{
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
  const hud = await h.evaluate(`(()=>{const p=window.__lifeDebug.S.view?.player;return JSON.stringify({busy:p?.busy??null,hud:document.getElementById('playerHud')?.textContent??'',btn:!!document.getElementById('btnBusyCancel')})})()`, sid);
  note('hud', JSON.parse(hud));
  const hudState = JSON.parse(hud);
  if (!hudState.busy || !hudState.btn) throw new Error('HUD 未出现忙态/取消按钮：' + hud);
  if (!hudState.hud.includes('⏳ 动作') || !hudState.hud.includes('剩 5 分')) throw new Error('HUD 文案不对：' + hudState.hud);

  // 点击取消按钮
  await h.evaluate(`document.getElementById('btnBusyCancel').click()`, sid);
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

  const btnGone = await h.evaluate(`!document.getElementById('btnBusyCancel')`, sid);
  note('uiAfter', { btnGone });
  writeFileSync(join(OUT, 'v73-busy-cancel-browser.log'), log.map((x) => JSON.stringify(x)).join('\n') + '\n');
  console.log(JSON.stringify({ ok: true, hud: hudState.hud, after: st, again: again.body, final: finalState.body }, null, 2));
} catch (error) {
  note('error', { message: String(error?.message ?? error) });
  writeFileSync(join(OUT, 'v73-busy-cancel-browser.log'), log.map((x) => JSON.stringify(x)).join('\n') + '\n');
  console.error('FAILED:', error?.message ?? error);
  process.exitCode = 1;
} finally {
  await h.close({ settleMs: 400, removeTemp: true });
}
