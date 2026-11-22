// 1.6 C：玩家可感知的前端契约（气泡/记忆行/居民面板）。只读源码，不需要浏览器。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('SOUL-09 前端：可点击气泡、记忆行、居民面板上次聊天，且与 toast 区分', () => {
  const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../web/app.css', import.meta.url), 'utf8');
  assert.match(html, /id="playerCall"/, 'index.html 要有独立气泡元素 #playerCall');
  assert.match(html, /id="talkMemory"/, 'index.html 要有“他还记得”行 #talkMemory');
  assert.match(app, /playerSpeech/, 'app.js 要读 /world 的 playerSpeech');
  assert.match(app, /fromSpeech/, 'app.js 点击气泡要带 fromSpeech');
  assert.match(app, /他还记得/, '对话面板要显示“他还记得：…”');
  assert.match(app, /lastTalk/, '居民面板/悬停要显示上次聊天');
  assert.match(css, /#playerCall/, '主动气泡要有独立样式（不能复用普通 toast）');
  const callBlock = app.slice(Math.max(0, app.indexOf('playerCall') - 400), app.indexOf('playerCall') + 400);
  assert.ok(callBlock.length > 0);
});

