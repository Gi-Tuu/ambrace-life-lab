// 前端闸门（第二次审计 G7：web/app.js 22.7 KB + index.html 零测试）。
// 分两层：
//   · 结构层（零依赖、永远跑）：把"必须成立"的前端契约钉在源码上；
//   · 冒烟层（有 Chrome 才跑，没有就 skip）：真起服务 + 真 headless 浏览器渲染一次，
//     断言渲染出来的 DOM 里有该有的中文标签、且没有 undefined/NaN 漏到页面上。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const APP = readFileSync('web/app.js', 'utf8');
const HTML = readFileSync('web/index.html', 'utf8');

test('F1 轮询必须串行且后台停轮询（否则请求叠加、且替世界打 touch 烧额度）', () => {
  assert.match(APP, /document\.hidden/, '没有 document.hidden 判断 ⇒ 后台标签页会一直轮询');
  assert.match(APP, /let refreshing = false;/, '没有在途标志 ⇒ setInterval 不等上一请求，慢网下会叠加');
  assert.match(APP, /setInterval\(poll, 900\)/, 'setInterval 没接到带守卫的 poll()');
});

test('F2 重置必须带 confirm（服务端要求，缺了就 400）', () => {
  assert.match(APP, /action: 'reset', confirm: true/, 'btnReset 没有带 confirm:true ⇒ 点了必然 400');
});

test('F3 存档失败与决策异常必须出现在页面上', () => {
  assert.match(APP, /j\.saveError/, '前端从不读 saveError ⇒ 存不上盘时页面无感');
  assert.match(APP, /j\.tickError/, '前端从不读 tickError ⇒ 世界静默冻结时页面无感');
  assert.match(HTML, /\.backend\.bad/, '没有故障样式类');
});

test('F4 服务端字符串进 innerHTML 前必须过 esc（抽查所有插值点）', () => {
  // 只做"形状"检查：这些字段是服务端可控的，出现时必须包在 esc(...) 里。
  const mustEscape = ['x.text', 'x.who', 's.detail', 'e.of', 'e.victim', 's.id', 'a.name', 'e.message'];
  const bad = [];
  for (const f of mustEscape) {
    const re = new RegExp(`(\\$\\{[^}]*${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^}]*\\})`, 'g');
    for (const m of APP.matchAll(re)) {
      if (!m[1].includes('esc(')) bad.push(f);
    }
  }
  assert.deepEqual([...new Set(bad)], [], `这些字段有未转义的插值点：${[...new Set(bad)].join(', ')}`);
});

test('F5 页面结构：A/B 双世界栏与关键面板都在', () => {
  for (const id of ['cvA', 'cvB', 'rowsA', 'rowsB', 'statA', 'statB', 'secrets', 'hail', 'social', 'tbl', 'log', 'backend']) {
    assert.ok(HTML.includes(`id="${id}"`), `index.html 缺 #${id}`);
  }
});

test('F7 生存重开按钮必须带 confirm（H-02c 同族：缺 confirm 服务端 400，按钮会静默失效）', () => {
  const line = APP.split('\n').find((l) => l.includes('btnSurvReset') && l.includes('ctl('));
  assert.ok(line, 'app.js 缺 btnSurvReset 处理');
  assert.ok(line.includes('confirm: true'), '生存重开未带 confirm ⇒ 400 静默失效');
});

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find((p) => existsSync(p));

test('F6 真浏览器冒烟：页面能渲染出世界，且没有 undefined/NaN 漏出来', { skip: CHROME ? false : '本机没有 Chrome，跳过冒烟层' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ambrace-fe-'));
  const port = 18900 + Math.floor(Math.random() * 80);
  const child = spawn(process.execPath, ['serve.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir, SEED_FILE: join(dir, 'none.json'), BRAIN: 'local', MODEL_PROVIDERS: '', MODEL_KEYS: '', MODEL_NAME: '', CHAT_TOKEN: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error('server boot timeout')), 15000);
      child.stdout.on('data', (d) => { if (String(d).includes('就绪')) { clearTimeout(to); res(); } });
      child.on('exit', (c) => rej(new Error('server exited ' + c)));
    });
    // 注意：不用 --virtual-time-budget —— 页面有常驻 /world 轮询 + rAF 循环，虚拟时间会被
    // 持续的网络请求挂起导致 headless 永不退出（实测 ETIMEDOUT）。改为 load 时 dump-dom。
    const dom = execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', `--user-data-dir=${join(dir, 'prof')}`, '--dump-dom', `http://127.0.0.1:${port}/`], { encoding: 'utf8', timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
    assert.ok(dom.includes('通道开'), '渲染结果里没有 A 侧标题 ⇒ 页面没起来');
    assert.ok(dom.includes('通道切断'), '渲染结果里没有 B 侧标题');
    assert.ok(!/undefined|NaN/.test(dom), '页面里漏出了 undefined/NaN');
    assert.ok(dom.length > 2000, `DOM 太小（${dom.length}）⇒ 可能只渲染了骨架`);
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 400));
  }
});
