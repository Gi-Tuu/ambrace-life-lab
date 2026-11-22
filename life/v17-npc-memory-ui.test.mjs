// 1.7 C：玩家可感知的统一记忆面板（静态源码契约，不需要浏览器）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('MEM-UI-01 对话面板有独立“旧事”列表；居民面板显示记忆条数与已故标记', () => {
  const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="talkRecall"/, 'index.html 要有“他记得的旧事”列表 #talkRecall');
  assert.match(app, /renderTalkRecall/, 'app.js 要渲染检索到的旧事');
  assert.match(app, /第\$\{item\.day/, '旧事必须显示第几天');
  assert.match(app, /MEMORY_SOURCE_TEXT/, '旧事必须显示来源（玩家/亲历/听说）');
  assert.match(app, /memory\.total/, '居民面板要显示长期记忆条数');
  assert.match(app, /已故/, '死者记忆要被标成已故');
  // 旧的兼容投影仍在：SOUL-09 的 #talkMemory / “他还记得” 不能被替换掉。
  assert.match(html, /id="talkMemory"/);
  assert.match(app, /他还记得/);
});
