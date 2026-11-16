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
// 样式已从 index.html 抽到 web/app.css（2026-11-15）。闸门要断言的是"页面上存在这条故障样式"，
// 不是"它写在哪个文件里"——所以两处合并后再匹配，否则搬一次样式就会让闸门变成噪音。
const CSS = readFileSync('web/app.css', 'utf8');
const STYLED = `${HTML}\n${CSS}`;

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
  assert.match(STYLED, /\.backend\.bad/, '没有故障样式类（index.html 或 app.css 里都必须能找到）');
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
  for (const id of ['cvA', 'cvB', 'rowsA', 'rowsB', 'statA', 'statB', 'compareOrigin', 'compareAction', 'tbl', 'log', 'backend']) {
    assert.ok(HTML.includes(`id="${id}"`), `index.html 缺 #${id}`);
  }
});

test('A08 位置上报随当前模式，A/B 各用自己的坐标', () => {
  assert.match(APP, /mode:'compare', revision, kind:'player_sync', from, otherContact:/);
  assert.match(APP, /applyPositionSync\(other, r\.sides\?\.B\)/);
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
    assert.match(dom, /id="backend"[^>]*>研究对照：两侧使用本地替身/, '后端 chip 仍是读取中 ⇒ refresh 没跑（模块抛错/TDZ）');
    assert.ok(!/undefined|NaN/.test(dom), '页面里漏出了 undefined/NaN');
    assert.ok(dom.length > 2000, `DOM 太小（${dom.length}）⇒ 可能只渲染了骨架`);
  } finally {
    socket?.close();
    browser?.kill();
    child.kill();
    await new Promise((r) => setTimeout(r, 400));
  }
});

test('F8 菜单主题不得被世界场景音频接管（审计 POTENTIAL #1）', () => {
  // 旧实现：syncAudioScene 无菜单守卫，而 audio.scene() 会无条件 state.menu=false
  // ⇒ 点「主菜单」后菜单曲最多活一次轮询（≤900ms）就被营地音乐顶掉。
  assert.match(APP, /function syncAudioScene\(sv\) \{[\s\S]{0,500}?if \(ui\.menu\)/, 'syncAudioScene 缺菜单守卫');
  assert.match(APP, /if \(ui\.menu\) audio\.menu\(true\)/, '首次手势解锁后没有补起菜单主题（菜单会静音）');
  assert.match(APP, /audio\.menu\(false\)/, '离开菜单时没有交还给世界场景音频');
});

test('F9 渲染连续失败必须只记一次日志、到上限停试、且提示持续可见（审计 POTENTIAL #2）', () => {
  assert.match(APP, /const GFX_FAILURE_LIMIT = \d+;/, '没有连续失败上限');
  assert.match(APP, /gfxFailureRun === 1\) console\.warn/, '日志不是只记第一次（实测旧实现 6 秒打了 26 条）');
  assert.match(APP, /gfxGaveUp = true;/, '到上限没有停试，会每帧无限重试');
  assert.match(APP, /if \(gfxFaultMessage\) \{[\s\S]{0,200}notice\.hidden = false/, '故障提示会被 renderPlayMode 每轮重置隐藏');
});

test('F10 树生成必须排除田块（田里长树是可见的常识错误）', () => {
  // 苗床坐标来自 campBeds（garden 站点南侧 12 块），而树循环原先只排除站点与车位。
  // 实测：去掉这条排除后，同一世界有 15 棵树落在田块内；加上后为 0。
  assert.match(APP, /onFarm\(tx \+ \.5, ty \+ \.5, 2\)/, '树循环缺少田块排除（树会长进田里）');
});

test('F11 首次进入三步引导：只出现一次、可跳过、动作能推进', () => {
  assert.match(APP, /ambrace\.firstRun\.v1/, '缺少一次性标记的 localStorage 键');
  assert.match(APP, /FIRST_RUN_STEPS/, '缺少三步定义');
  assert.match(HTML, /data-firstrun="skip"/, '缺少跳过入口');
  assert.match(readFileSync('web/app.css','utf8'), /#firstRun button \{[^}]*pointer-events:auto/, '关闭按钮应接收鼠标事件');
  assert.match(APP, /if \(result\.ok\) markFirstRun\(body\.kind\)/, '动作成功后没有推进步骤');
  assert.match(APP, /camp_eat'\]?\) return 1/, '吃饭这一步没接');
  assert.match(APP, /camp_sleep'\]?\) return 2/, '睡觉这一步没接');
});

test('F14 后端 chip 按两把尺子分别判：不许在节点仍答话时谎称额度用完', () => {
  assert.match(APP, /m\.moneyCalls \?\? 0\) >= \(m\.budget/, 'chip 没拿"钱"这本账（moneyCalls）与额度比较');
  assert.match(APP, /m\.nodeCalls \?\? 0\) >= \(m\.nodeBudget/, 'chip 没拿"电"这本账（nodeCalls）与节点预算比较');
  assert.doesNotMatch(APP, /\(m\.calls \?\? 0\) >= \(m\.budget/, '仍在用总量 calls 比钱的额度 ⇒ 无人模型上线后必然谎报"今日已用完"');
  assert.match(APP, /unattended === false/, '"无人观看，省额度"这句只允许在无人模型真被关掉时说');
});

test('F12 URL 的 camp 是路由主路径：localStorage 不可用时轮询仍带 camp（P2-b）', () => {
  assert.match(APP, /new URL\(location\.href\)\.searchParams\.get\('camp'\)/,'缺少 URL camp 读取');
  assert.match(APP, /\^\[0-9a-f\]\{32\}\$/, '缺少 32 位十六进制校验');
  assert.match(APP, /setCampProvider\(\(\) => campKeyNow\)/, 'provider 未绑定内存值');
  assert.match(APP, /campKeyNow = urlCampKey/, 'provider 初值没有优先取 URL');
});

test('F13 回看面板：只读 converse、全部 textContent、替身有徽章（P1）', () => {
  assert.match(HTML, /id="conversePanel"/, '缺少回看面板容器');
  assert.match(APP, /survival?.converse/, '面板没有读 converse');
  assert.match(APP, /textContent = e\.text/, '原话必须走 textContent（不能拼 innerHTML）');
  assert.match(APP, /served === 'standin' \? '本地替身'/, '替身句子必须有中文徽章');
  assert.match(APP, /loadConverse\(\)/, '开始页没有加载对话');
});

test('F15 玩家动作链失败必须有可见反馈：全局 rejection 兜底存在且只提示"没送达"类错误（SAV-06）', () => {
  assert.match(APP, /unhandledrejection/, '缺少全局 rejection 兜底');
  assert.match(APP, /操作没有送达，请重试/, '缺少可见提示文案');
  assert.match(APP, /\^HTTP \|Failed to fetch\|NetworkError\|Load failed/, '提示范围过宽（会把规则拒绝也当网络错误）');
  assert.match(APP, /lastActErrorAt < 3000/, '缺少节流，轮询失败会刷屏');
});

test('F16 失效营地有明确提示：view.camp.invalid ⇒ 提示"已回收"，且只提示一次（SAV-05）', () => {
  assert.match(APP, /camp\?\.invalid/, '前端没有处理 invalid 营地');
  assert.match(APP, /该营地已回收/, '缺少明确提示文案');
  assert.match(APP, /campInvalidNotified/, '缺少去重标记（会每次轮询刷屏）');
});