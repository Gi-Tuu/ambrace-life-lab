#!/usr/bin/env node
// 1.6 B/C 浏览器验收：/world 的 playerSpeech → 独立可点击气泡（#playerCall），
// 点击后走 fromSpeech 请求；服务端没有这条气泡时必须静默拒绝（NO_SPEECH），不能误开面板。
// 只读页面与 /world；不写世界、不改存档。fake speech 只注入页面内存用于渲染验收。
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCdpHarness } from './lib/cdp-harness.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'evidence', 'npc-soul');
mkdirSync(OUT, { recursive: true });
const log = [];
const note = (kind, data = {}) => { log.push({ at: new Date().toISOString(), kind, ...data }); console.log(JSON.stringify({ kind, ...data })); };

const h = createCdpHarness({
  root: ROOT,
  port: 9400 + (process.pid % 200),
  dataPrefix: 'npc-soul-data-',
  profilePrefix: 'npc-soul-chrome-',
  serverEnv: {
    GAME_MODE: 'game', GAME_RULES: '1', SIM_TIME: '1', BRAIN: 'local',
    GAME_MS_PER_MINUTE: '100', THINK_EVERY_MIN: '5', TICK_MS: '1000000',
    MODEL_UNATTENDED: '0', V73_TEST: '1',
  },
  waitMs: 30000,
});
let sid;
try {
  await h.startServer();
  h.startChrome();
  sid = await h.openPage({ url: `${h.origin}/` });
  await h.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, sid);
  await h.waitFor(async () => Boolean(await h.evaluate('!!window.__lifeDebug?.S', sid)));
  await h.waitFor(async () => !(await h.evaluate(`document.querySelector('#startSurvival').disabled`, sid)));
  await h.evaluate(`document.querySelector('#startSurvival').click()`, sid);
  await h.waitFor(async () => await h.evaluate('window.__lifeDebug.S.playing === true', sid));
  await h.waitFor(async () => Boolean(await h.evaluate('!!window.__lifeDebug.S.view', sid)));
  // 冻结 /world 轮询：否则 900ms 的下一帧会把注入的验收气泡覆盖掉（真实运行时服务端每帧都会下发）。
  await h.evaluate(`(()=>{const real=window.fetch; window.fetch=(...a)=>{const u=String(a[0]??''); if(u.includes('/world')) return new Promise(()=>{}); return real(...a);};})()`, sid);
  await h.wait(1100);

  const injected = await h.evaluate(`(()=>{
    const S=window.__lifeDebug.S, world=S.view;
    const agents=Object.values(world.agents||{});
    const sameSpace=agents.find(a=>!a.isPlayer && a.pos && world.agents.p1?.pos && a.pos.space===world.agents.p1.pos.space);
    const outdoor=agents.find(a=>!a.isPlayer && a.pos && a.pos.space==='world');
    const target=outdoor || sameSpace || world.agents.p1;
    if (!target) return { ok:false, why:'no-resident' };
    const now=Number.isFinite(world.gameMinutes) ? world.gameMinutes : (world.t||0)*60;
    const speech={ id:target.id, name:target.name, text:'下雨呢，路滑，你慢点走。', at:now, expires:now+30 };
    window.__npcSoulKeep=setInterval(()=>{
      const cur=window.__lifeDebug.S;
      if (!cur.view) return;
      cur.view.playerSpeech=speech;
      window.__lifeDebug.playerCall(cur.view);
    }, 80);
    world.playerSpeech=speech;
    const shown=window.__lifeDebug.playerCall(world);
    const el=document.querySelector('#playerCall');
    return { ok:true, shown, target:target.id, space:target.pos?.space ?? null,
      hidden:el.hidden, text:el.textContent, buttons:el.tagName,
      visibility:getComputedStyle(el).visibility, rect:el.getBoundingClientRect().toJSON() };
  })()`, sid);
  note('inject', injected);
  await h.waitFor(async () => {
    const v = await h.evaluate(`getComputedStyle(document.querySelector('#playerCall')).visibility`, sid);
    return v === 'visible';
  }, 5000);
  await h.evaluate(`document.querySelector('#playerCall').scrollIntoView({block:'center',inline:'center'})`, sid);
  await h.wait(200);
  const painted = await h.evaluate(`(()=>{
    const el=document.querySelector('#playerCall');
    return { hidden:el.hidden, visibility:getComputedStyle(el).visibility,
      text:el.textContent, rect:el.getBoundingClientRect().toJSON(),
      viewport:{w:innerWidth,h:innerHeight},
      hit:(()=>{const r=el.getBoundingClientRect();const n=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return n?{tag:n.tagName,id:n.id}:null})(),
      toast:document.querySelector('#campToast')?.textContent ?? '' };
  })()`, sid);
  note('painted', painted);
  await h.screenshot(sid, join(OUT, 'bubble.png'));

  let toast = '';
  // 真鼠标点击（不是 el.click()）：#gameHud 有 pointer-events:none，#playerCall 必须自己收回事件。
  const cx = Math.round(painted.rect.x + painted.rect.width / 2);
  const cy = Math.round(painted.rect.y + painted.rect.height / 2);
  note('clickPoint', { cx, cy });
  await h.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy }, sid);
  await h.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 }, sid);
  await h.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 }, sid);
  await h.waitFor(async () => {
    toast = await h.evaluate(`document.querySelector('#campToast')?.textContent ?? ''`, sid);
    return /过去了|走近|回应|没法/.test(toast);
  }, 5000);
  note('click', { toast, hidden: await h.evaluate('document.querySelector("#playerCall").hidden', sid) });
  const srvRejected = /过去了|没法/.test(toast);
  const ok = injected.ok && injected.hidden === false && /下雨|路滑/.test(injected.text)
    && painted.hidden === false && srvRejected;
  note('result', { ok, visibility: painted.visibility, anchored: painted.visibility === 'visible' });
  note('result', { ok });
  if (!ok) process.exitCode = 1;
} finally {
  try { await h.close({ settleMs: 300 }); } catch { /* 已关 */ }
  writeFileSync(join(OUT, 'browser.json'), JSON.stringify({ ok: process.exitCode !== 1, log }, null, 2));
  writeFileSync(join(OUT, 'browser.log'), log.map((x) => JSON.stringify(x)).join('\n') + '\n');
}
