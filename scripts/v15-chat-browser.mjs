#!/usr/bin/env node
// 1.5 玩家自由对话真实浏览器验收（CDP）：
//   · 正式世界打开对话后，自由输入框与 4 个快捷话题同时可见；
//   · 输入任意文本 → UI 立刻显示“对方正在想…”→ 模型回复；
//   · 第二轮能引用第一轮（prompt 里带上一轮玩家话与居民台词）；
//   · 快捷话题仍可用；关闭后世界钟继续走。
// 模型用本进程里的 127.0.0.1 假供应商，绝不读取 .env 的真实 key。
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCdpHarness } from './lib/cdp-harness.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'evidence', 'v15-chat');
mkdirSync(OUT, { recursive: true });
const log = [];
const note = (kind, data = {}) => { const row = { at: new Date().toISOString(), kind, ...data }; log.push(row); return row; };

const prompts = [];
const upstream = createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  let prompt = '';
  try { prompt = String(JSON.parse(body || '{}').messages?.[0]?.content ?? ''); } catch { /* 非 JSON */ }
  prompts.push(prompt);
  const send = (obj, delay = 0) => setTimeout(() => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  }, delay);
  if (prompt.includes('只回一句中文台词')) {
    const line = prompt.includes('你刚才说') ? '刚从地里回来，你不是听见了？' : '刚在地里忙完，手上还带着土。';
    send({ choices: [{ message: { content: line } }], usage: { total_tokens: 4 } }, 650);
    return;
  }
  if (prompt.includes('把这句话改写成')) {
    send({ choices: [{ message: { content: '刚从地里回来，手上还带着土。' } }], usage: { total_tokens: 3 } }, 80);
    return;
  }
  send({ choices: [{ message: { content: '{"id":"rest","reason":"夹具"}' } }], usage: { total_tokens: 1 } });
});
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
const upPort = upstream.address().port;

const h = createCdpHarness({
  root: ROOT,
  port: 9340 + (process.pid % 40),
  dataPrefix: 'v15-chat-data-',
  profilePrefix: 'v15-chat-chrome-',
  serverEnv: {
    GAME_MODE: 'game', GAME_RULES: '1', BRAIN: 'model',
    MODEL_PROVIDERS: `http://127.0.0.1:${upPort}/v1`,
    MODEL_KEYS: 'fixture-key',
    MODEL_NAMES: 'fixture',
    MODEL_TIMEOUT_MS: '4000',
    MODEL_BREAKER_FAILS: '99',
    GAME_MS_PER_MINUTE: '6000', TICK_MS: '360000',
    MODEL_UNATTENDED: '0', PRESENCE_MS: '600000', V73_TEST: '1',
  },
  waitMs: 20000,
});
const assert = (cond, message) => { if (!cond) throw new Error(message); };
let sid = null;

try {
  await h.startServer();
  note('server.started', { port: h.port, upstream: upPort });
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
    if(!target) return {ok:false,why:'no a1 position'};
    p.x=target.x+.45; p.y=target.y;
    if('z' in target) p.y=target.z;
    return {ok:true,p:{x:p.x,y:p.y},target};
  })()`, sid);
  note('resident.place', placed);
  assert(placed.ok, `无法靠近居民：${JSON.stringify(placed)}`);

  const t0 = await h.evaluate(`window.__lifeDebug.clockHud().minutes`, sid);
  await h.evaluate(`window.__lifeDebug.openDialogue('a1')`, sid);
  await h.wait(2400);

  const panel = await h.evaluate(`(()=>{const d=document.querySelector('#talkDlg');return {open:!!d?.open,title:document.querySelector('#talkTitle')?.textContent??'',topics:[...document.querySelectorAll('#talkTopics button')].map(b=>b.textContent),rowHidden:document.querySelector('#talkRow')?.hidden??null,inputHidden:document.querySelector('#talkText')?.hidden??null,pendingHidden:document.querySelector('#talkPending')?.hidden??null,note:document.querySelector('#talkNote')?.textContent??''}})()`, sid);
  note('dialogue.panel', panel);
  assert(panel.open, '对话面板没有打开');
  assert(panel.topics.length === 4, `快捷话题数不是 4：${JSON.stringify(panel.topics)}`);
  assert(panel.rowHidden === false && panel.inputHidden === false, '自由输入框没有显示');
  assert(panel.pendingHidden === true, '初始不应显示“对方正在想”');
  assert(/不占游戏时间/.test(panel.note), `提示没有说明免费：${panel.note}`);
  await h.screenshot(sid, join(OUT, 'free-input.png'));

  // 自由输入第一轮：点击后立刻应看到 thinking，再等到模型台词。
  await h.evaluate(`(()=>{const i=document.querySelector('#talkText');i.value='今天怎么样？';document.querySelector('#talkSend').click();})()`, sid);
  await h.wait(120);
  const thinking = await h.evaluate(`(()=>{const p=document.querySelector('#talkPending');return {hidden:p?.hidden??null,text:p?.textContent??'',sendDisabled:document.querySelector('#talkSend')?.disabled??null}})()`, sid);
  note('dialogue.thinking', thinking);
  assert(thinking.hidden === false, '模型等待时没有显示“对方正在想…”');
  assert(thinking.sendDisabled === true, '模型等待时发送按钮没有禁用');
  await h.screenshot(sid, join(OUT, 'thinking.png'));

  assert(await h.waitFor(async () => await h.evaluate(`(()=>{const p=document.querySelector('#talkPending');return p?.hidden===true && /刚在地里忙完/.test(document.querySelector('#talkLog')?.textContent??'')})()`, sid), 8000, sid), '没有等到第一轮模型台词');
  const firstLog = await h.evaluate(`document.querySelector('#talkLog')?.textContent??''`, sid);
  note('dialogue.first', { log: firstLog });
  assert(firstLog.includes('你：今天怎么样？'), '第一轮玩家话没有进日志');

  // 第二轮：问“你刚才说…”；本地假供应商只会在 prompt 带上上一轮时才回“你不是听见了？”。
  await h.evaluate(`(()=>{const i=document.querySelector('#talkText');i.value='你刚才说你去哪儿了？';document.querySelector('#talkSend').click();})()`, sid);
  assert(await h.waitFor(async () => await h.evaluate(`/你不是听见了/.test(document.querySelector('#talkLog')?.textContent??'')`, sid), 8000, sid), '第二轮没有接上“你刚才说…”');
  const secondLog = await h.evaluate(`document.querySelector('#talkLog')?.textContent??''`, sid);
  const secondPrompt = prompts.filter((p) => p.includes('只回一句中文台词')).at(-1) ?? '';
  note('dialogue.second', { log: secondLog, promptHasFirstLine: secondPrompt.includes('刚在地里忙完，手上还带着土。'), promptHasFirstPlayer: secondPrompt.includes('今天怎么样？') });
  assert(secondPrompt.includes('刚在地里忙完，手上还带着土。'), '第二轮 prompt 没带上一轮居民台词');
  assert(secondPrompt.includes('今天怎么样？'), '第二轮 prompt 没带上一轮玩家话');
  await h.screenshot(sid, join(OUT, 'free-multiturn.png'));

  // 快捷话题仍可用。
  const beforeTopic = (await h.evaluate(`document.querySelector('#talkLog')?.textContent??''`, sid)).length;
  await h.evaluate(`document.querySelectorAll('#talkTopics button')[2]?.click()`, sid);
  const topicGrew = await h.waitFor(async () => (await h.evaluate(`document.querySelector('#talkLog')?.textContent??''`, sid)).length > beforeTopic, 5000, sid);
  assert(topicGrew, '快捷话题没有追加日志');
  const afterTopic = await h.evaluate(`document.querySelector('#talkLog')?.textContent??''`, sid);
  const topicsNow = await h.evaluate(`document.querySelectorAll('#talkTopics button').length`, sid);
  note('dialogue.topic', { beforeTopic, after: afterTopic.length, topics: topicsNow });
  assert(afterTopic.length > beforeTopic, '快捷话题没有追加日志');
  assert(topicsNow === 4, '快捷话题在自由对话后应保留 4 个');

  const t1 = await h.evaluate(`window.__lifeDebug.clockHud().minutes`, sid);
  note('dialogue.clock', { t0, t1 });
  assert(t1 > t0, `对话期间世界钟停住了：${t0} → ${t1}`);

  await h.evaluate(`document.querySelector('#talkClose').click()`, sid);
  await h.wait(260);
  const closed = await h.evaluate(`(()=>({open:!!document.querySelector('#talkDlg')?.open,talk:window.__lifeDebug.dialogue(),running:window.__lifeDebug.S.running,pending:document.querySelector('#talkPending')?.hidden}))()`, sid);
  note('dialogue.closed', closed);
  assert(!closed.open && !closed.talk, `面板没有关闭：${JSON.stringify(closed)}`);
  assert(closed.pending === true, '关闭后 thinking 没有隐藏');
  assert(closed.running === true, '关闭对话后世界不应停');

  writeFileSync(join(OUT, 'browser.json'), JSON.stringify({ ok: true, prompts: prompts.length, log }, null, 2) + '\n');
  writeFileSync(join(OUT, 'browser.log'), log.map((row) => `${row.at} ${row.kind} ${JSON.stringify(row)}`).join('\n') + '\n');
  console.log('PASS v15-chat-browser', JSON.stringify({ topics: panel.topics, thinking: thinking.text, clock: [t0, t1], prompts: prompts.length }));
} catch (error) {
  note('fail', { message: String(error?.stack ?? error) });
  try { if (sid) await h.screenshot(sid, join(OUT, 'free-fail.png')); } catch { /* 截图失败不掩盖原错误 */ }
  writeFileSync(join(OUT, 'browser.json'), JSON.stringify({ ok: false, prompts: prompts.length, log }, null, 2) + '\n');
  writeFileSync(join(OUT, 'browser.log'), log.map((row) => `${row.at} ${row.kind} ${JSON.stringify(row)}`).join('\n') + '\n');
  console.error('FAIL', error?.stack ?? error);
  process.exitCode = 1;
} finally {
  await h.close();
  await new Promise((resolve) => upstream.close(resolve));
}
