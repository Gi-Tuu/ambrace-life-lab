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
import { spawn } from 'node:child_process';

const APP = readFileSync('web/app.js', 'utf8');
const HTML = readFileSync('web/index.html', 'utf8');

test('F1 轮询必须串行且后台停轮询（否则请求叠加、且替世界打 touch 烧额度）', () => {
  assert.match(APP, /document\.hidden/, '没有 document.hidden 判断 ⇒ 后台标签页会一直轮询');
  assert.match(APP, /let refreshing = false;/, '没有在途标志 ⇒ setInterval 不等上一请求，慢网下会叠加');
  assert.match(APP, /setInterval\(poll, 900\)/, 'setInterval 没接到带守卫的 poll()');
});

test('F2 重置必须带 confirm（服务端要求，缺了就 400）', () => {
  assert.match(APP, /action: 'compare_reset', confirm: true/, 'btnReset 没有带 confirm:true ⇒ 点了必然 400');
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

test('F7 菜单与终局重开共用确认后的生存重置', () => {
  assert.match(APP, /startNew.*onclick=newSurvival/);
  assert.match(APP, /btnSurvReset.*newSurvival/);
  assert.match(APP, /confirm\('新开一局/);
  assert.match(APP, /action:'survival_reset',confirm:true/);
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
  let browser, socket;
  try {
    await new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error('server boot timeout')), 15000);
      child.stdout.on('data', (d) => { if (String(d).includes('就绪')) { clearTimeout(to); res(); } });
      child.on('exit', (c) => rej(new Error('server exited ' + c)));
    });
    const profile=join(dir,'prof');
    browser=spawn(CHROME,['--headless=new','--disable-gpu','--no-sandbox',
      '--remote-debugging-port=0',`--user-data-dir=${profile}`,`http://127.0.0.1:${port}/?mode=compare`],
    {stdio:'ignore',windowsHide:true});
    const until=async probe=>{
      const deadline=Date.now()+18000;
      while (Date.now()<deadline) {
        const value=await probe();
        if (value) return value;
        await new Promise(resolve=>setTimeout(resolve,80));
      }
      throw new Error('等待浏览器完成页面加载超时');
    };
    const debuggingPort=await until(()=>{
      try { return Number(readFileSync(join(profile,'DevToolsActivePort'),'utf8').split('\n')[0]); }
      catch { return 0; }
    });
    const endpoint=await until(async()=>{
      const pages=await (await fetch(`http://127.0.0.1:${debuggingPort}/json`)).json();
      return pages.find(page=>page.type==='page')?.webSocketDebuggerUrl;
    });
    socket=new WebSocket(endpoint);
    await new Promise((resolve,reject)=>{
      socket.addEventListener('open',resolve,{once:true});
      socket.addEventListener('error',reject,{once:true});
    });
    let seq=0;
    const dom=await until(()=>new Promise(resolve=>{
      const id=++seq;
      function response(event) {
        const msg=JSON.parse(event.data);
        if (msg.id!==id) return;
        socket.removeEventListener('message',response);
        resolve(msg.result?.result?.value);
      }
      socket.addEventListener('message',response);
      socket.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression:
        "document.getElementById('cvB')?.dataset.renderer && document.documentElement.outerHTML",returnByValue:true}}));
    }));
    assert.ok(dom.includes('通道开'), '渲染结果里没有 A 侧标题 ⇒ 页面没起来');
    assert.ok(dom.includes('通道切断'), '渲染结果里没有 B 侧标题');
    assert.match(dom, /id="backend"[^>]*>后端：本地替身/, '后端 chip 仍是读取中 ⇒ refresh 没跑（模块抛错/TDZ）');
    assert.ok(!/undefined|NaN/.test(dom), '页面里漏出了 undefined/NaN');
    assert.ok(dom.length > 2000, `DOM 太小（${dom.length}）⇒ 可能只渲染了骨架`);
  } finally {
    socket?.close();
    browser?.kill();
    child.kill();
    await new Promise((r) => setTimeout(r, 400));
  }
});
