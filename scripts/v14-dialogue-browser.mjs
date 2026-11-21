#!/usr/bin/env node
// 1.4 主动对话 + 居民注意力真实浏览器验收（CDP）：
//   · 点击/打开居民 → 名字气泡 + talk 姿势 + 面向 p1（1.5–2.5s），随后话题面板出现；
//   · 4 个话题、多轮、关闭；对话期间世界钟继续走（不停世界）；
//   · 面板不接模型：只发 camp_talk/camp_talk_say/camp_talk_close。
// 证据写 evidence/v14-dialogue/。
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCdpHarness } from './lib/cdp-harness.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'evidence', 'v14-dialogue');
mkdirSync(OUT, { recursive: true });
const log = [];
const note = (kind, data = {}) => { const row = { at: new Date().toISOString(), kind, ...data }; log.push(row); return row; };
const h = createCdpHarness({
  root: ROOT,
  port: 9340 + (process.pid % 40),
  dataPrefix: 'v14-dialogue-data-',
  profilePrefix: 'v14-dialogue-chrome-',
  serverEnv: {
    GAME_MODE: 'game', GAME_RULES: '1', BRAIN: 'local',
    GAME_MS_PER_MINUTE: '6000', TICK_MS: '360000',
    MODEL_UNATTENDED: '0', V73_TEST: '1',
  },
  waitMs: 20000,
});
const assert = (cond, message) => { if (!cond) throw new Error(message); };
const frame = (sid) => h.evaluate(`(()=>{const d=document.querySelector('#cvA')?._debug||{};return {t:d.tick,acts:d.acts??[],attention:d.attention??[],focus:d.focus??null}})()`, sid);
let sid = null;

try {
  await h.startServer();
  note('server.started', { port: h.port });
  h.startChrome();
  sid = await h.openPage({ url: `${h.origin}/` });
  assert(await h.waitFor(async () => Boolean(await h.evaluate('!!window.__lifeDebug?.S', sid))), '页面未就绪');
  await h.wait(700);
  await h.evaluate(`document.querySelector('#startSurvival').click()`, sid);
  assert(await h.waitFor(async () => await h.evaluate('window.__lifeDebug.S.playing === true', sid)), '没有进入生存');
  await h.wait(900);

  const placed = await h.evaluate(`(()=>{
    const W=window.__lifeDebug.WALK, p=W['cvA:p1'], a=W['cvA:a1'];
    const v=window.__lifeDebug.S.view, npc=v?.agents?.a1;
    if(!p) return {ok:false,why:'no p1 walker'};
    const target=a?{x:a.x,y:a.y,src:'walker'}:npc?.pos?{x:npc.pos.x,z:npc.pos.z,src:'server-pos'}:null;
    if(!target) return {ok:false,why:'no a1 position',keys:Object.keys(W)};
    p.x=target.x+.45; p.y=target.y;
    if('z' in target) p.y=target.z;
    return {ok:true,p:{x:p.x,y:p.y},target,loc:npc?.loc??null};
  })()`, sid);
  note('resident.place', placed);
  assert(placed.ok, `无法靠近居民：${JSON.stringify(placed)}`);

  const t0 = await h.evaluate(`window.__lifeDebug.clockHud().minutes`, sid);
  await h.evaluate(`window.__lifeDebug.openDialogue('a1')`, sid);
  await h.wait(180);

  const bubble = await h.evaluate(`(()=>{const b=document.querySelector('#residentSpeech'),n=document.querySelector('#residentSpeechName');return {hidden:b?.hidden??null,visibility:b?getComputedStyle(b).visibility:null,name:n?.textContent??'',line:document.querySelector('#residentSpeechText')?.textContent??'',box:b?(()=>{const r=b.getBoundingClientRect();return {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)}})():null}})()`, sid);
  const f0 = await frame(sid);
  note('dialogue.bubble', { bubble, frame: f0, t0 });
  assert(bubble.hidden === false && bubble.visibility === 'visible' && bubble.name && bubble.line, `没有名字气泡：${JSON.stringify(bubble)}`);
  assert(f0.attention.some((row) => row.startsWith('a1:')), `居民没有注意姿势：${JSON.stringify(f0.attention)}`);
  assert(f0.acts.includes('a1:talk'), `居民 act 不是 talk：${JSON.stringify(f0.acts)}`);
  const dir = f0.attention.find((row) => row.startsWith('a1:')).split(':')[1];
  const expected = await h.evaluate(`(()=>{const c=document.querySelector('#cvA')._cam,p=c?.people?.find(q=>q.who==='p1'),a=c?.people?.find(q=>q.who==='a1');if(!p||!a)return null;const dx=p.x-a.x,dz=p.z-a.z;return Math.abs(dx)>Math.abs(dz)?(dx>0?'right':'left'):(dz>0?'down':'up')})()`, sid);
  note('dialogue.facing', { dir, expected });
  assert(expected && dir === expected, `朝向不对：${dir} != ${expected}`);
  await h.screenshot(sid, join(OUT, 'dialogue-bubble.png'));

  await h.wait(2100);
  const panel = await h.evaluate(`(()=>{const d=document.querySelector('#talkDlg');return {open:!!d?.open,title:document.querySelector('#talkTitle')?.textContent??'',topics:[...document.querySelectorAll('#talkTopics button')].map(b=>b.textContent),rowHidden:document.querySelector('#talkRow')?.hidden??null,log:document.querySelector('#talkLog')?.textContent??''}})()`, sid);
  note('dialogue.panel', panel);
  assert(panel.open, '话题面板没有打开');
  assert(panel.topics.length === 4, `话题数不是 4：${JSON.stringify(panel.topics)}`);
  assert(panel.rowHidden === true, '轻量面板仍显示自由输入框');
  assert(panel.log.length > 0, '面板没有开场白');
  await h.screenshot(sid, join(OUT, 'dialogue-panel.png'));

  const t1 = await h.evaluate(`window.__lifeDebug.clockHud().minutes`, sid);
  const turns = [];
  for (let i = 0; i < 2; i += 1) {
    await h.evaluate(`document.querySelectorAll('#talkTopics button')[${i}].click()`, sid);
    await h.wait(260);
    turns.push(await h.evaluate(`(()=>{const rows=[...document.querySelectorAll('#talkLog > div')];return {n:rows.length,my:rows.at(-2)?.textContent??'',npc:rows.at(-1)?.textContent??'',open:!!document.querySelector('#talkDlg')?.open}})()`, sid));
  }
  const t2 = await h.evaluate(`window.__lifeDebug.clockHud().minutes`, sid);
  const round = await h.evaluate(`window.__lifeDebug.dialogue()`, sid);
  note('dialogue.rounds', { turns, round: round ? { local: round.local, turns: round.topics?.length ?? null } : null, t1, t2 });
  assert(turns.every((row) => row.open && row.my.startsWith('你：') && row.npc), `多轮对话失败：${JSON.stringify(turns)}`);
  assert(turns[1].n > turns[0].n, '第二轮没有追加日志');
  assert(t2 > t1, `打开面板期间世界钟停住了：${t1} → ${t2}`);

  await h.evaluate(`document.querySelector('#talkClose').click()`, sid);
  await h.wait(260);
  const closed = await h.evaluate(`(()=>({open:!!document.querySelector('#talkDlg')?.open,talk:window.__lifeDebug.dialogue(),running:window.__lifeDebug.S.running}))()`, sid);
  note('dialogue.closed', closed);
  assert(!closed.open && !closed.talk, `面板没有关闭：${JSON.stringify(closed)}`);
  assert(closed.running === true, '关闭对话后世界不应停');

  writeFileSync(join(OUT, 'browser.json'), JSON.stringify({ ok: true, log }, null, 2) + '\n');
  writeFileSync(join(OUT, 'browser.log'), log.map((row) => `${row.at} ${row.kind} ${JSON.stringify(row)}`).join('\n') + '\n');
  console.log('PASS v14-dialogue-browser', JSON.stringify({ bubble: bubble.name, topics: panel.topics, clock: [t0, t1, t2] }));
} catch (error) {
  note('fail', { message: String(error?.stack ?? error) });
  try { if (sid) await h.screenshot(sid, join(OUT, 'dialogue-fail.png')); } catch {}
  writeFileSync(join(OUT, 'browser.json'), JSON.stringify({ ok: false, log }, null, 2) + '\n');
  writeFileSync(join(OUT, 'browser.log'), log.map((row) => `${row.at} ${row.kind} ${JSON.stringify(row)}`).join('\n') + '\n');
  console.error('FAIL', error?.stack ?? error);
  process.exitCode = 1;
} finally {
  await h.close();
}
