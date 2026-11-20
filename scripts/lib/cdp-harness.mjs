// CDP 浏览器验收公共骨架（零依赖）。
//
// 浏览器脚本（quickstart / p2c-room / redo-p0-golden / p3-perf / v73 / v731）原先各抄一份
// “起 serve.mjs → 起 Chrome(--remote-debugging-pipe) → NUL 分帧收发 → evaluate/waitFor →
// 截图/收尾”。这里收成一份，脚本只保留各自的场景断言与证据格式。
//
// 用法：
//   const h = createCdpHarness({ port: 8900 + (process.pid % 90), serverEnv: {...} });
//   await h.startServer();
//   h.startChrome();
//   const sid = await h.openPage({ url: `${h.origin}/` });
//   await h.evaluate('...', sid);
//   await h.waitFor(async () => ..., 20000, sid);
//   ...
//   await h.close({ settleMs: 300 });
//
// 行为口径与原脚本一致：端口/环境变量由调用方传（不在这里改写），
// Chrome 路径分 gate（chromeGate + CHROME_PATH）与 fixed（v73/v731 的写死路径）两种。
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromeGate } from '../../life/chrome-gate.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function resolveChrome(kind) {
  if (kind === 'fixed') {
    return process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  }
  const gate = chromeGate({ requireChrome: true });
  if (gate.fail || !gate.path) throw new Error(gate.reason ?? '找不到 Chrome');
  return process.env.CHROME_PATH ?? gate.path;
}

/**
 * @param {object} [options]
 * @param {string} [options.root]            仓库根（默认从 scripts/lib/ 上两级）
 * @param {number} [options.port]            端口（调用方保留原脚本的取端口公式）
 * @param {string} [options.dataPrefix]      临时 DATA_DIR 前缀
 * @param {string} [options.profilePrefix]   临时 Chrome profile 前缀
 * @param {'gate'|'fixed'} [options.chrome]  Chrome 路径来源
 * @param {string[]} [options.chromeArgs]    Chrome 启动参数（不含 user-data-dir/about:blank）
 * @param {object} [options.serverEnv]       传给 serve.mjs 的额外环境变量
 * @param {number} [options.readyAttempts]   等“就绪”的轮数（每轮 readyIntervalMs）
 * @param {number} [options.readyIntervalMs]
 * @param {string} [options.readyText]
 * @param {number} [options.readyErrorChars] 服务未就绪时截取的日志长度
 * @param {number} [options.waitMs]          waitFor 默认超时
 * @param {number} [options.waitIntervalMs]  waitFor 默认轮询间隔
 * @param {string} [options.evaluateErrorPrefix]
 */
export function createCdpHarness({
  root = ROOT,
  port = 9000 + (process.pid % 300),
  dataPrefix = 'cdp-data-',
  profilePrefix = 'cdp-chrome-',
  chrome = 'gate',
  chromeArgs = ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-pipe'],
  serverEnv = {},
  readyAttempts = 120,
  readyIntervalMs = 150,
  readyText = '就绪',
  readyErrorChars = 300,
  waitMs = 20000,
  waitIntervalMs = 200,
  evaluateErrorPrefix = 'JS 异常：',
} = {}) {
  const origin = `http://127.0.0.1:${port}`;
  const dataDir = mkdtempSync(join(tmpdir(), dataPrefix));
  const profileDirs = [];
  const targets = [];
  const chromeBinary = resolveChrome(chrome);

  let server = null;
  let serverLog = '';
  let chromeProcess = null;
  let cdp = null;
  let profileDir = null;

  async function startServer(extraEnv = {}) {
    serverLog = '';
    server = spawn(process.execPath, ['serve.mjs'], {
      cwd: root,
      env: {
        ...process.env,
        PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir,
        SEED_FILE: join(root, 'seed', 'world.json'),
        ...serverEnv,
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout.on('data', (d) => { serverLog += String(d); });
    server.stderr.on('data', (d) => { serverLog += String(d); });
    for (let i = 0; i < readyAttempts && !serverLog.includes(readyText); i += 1) await wait(readyIntervalMs);
    if (!serverLog.includes(readyText)) throw new Error('服务未就绪：' + serverLog.slice(0, readyErrorChars));
    return { log: () => serverLog };
  }

  async function stopServer({ settleMs = 600 } = {}) {
    if (!server) return;
    server.kill();
    server = null;
    await wait(settleMs);
  }

  function startChrome({ args = chromeArgs } = {}) {
    // 每次 startChrome 都用全新 profile：p3 的 cold/warm/cold 多轮冷启动依赖这一点。
    profileDir = mkdtempSync(join(tmpdir(), profilePrefix));
    profileDirs.push(profileDir);
    chromeProcess = spawn(chromeBinary, [...args, `--user-data-dir=${profileDir}`, 'about:blank'], {
      stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
    });
    const writeFd = chromeProcess.stdio[3];
    const readFd = chromeProcess.stdio[4];
    let buf = '';
    cdp = { pending: new Map(), seq: 0, targets };
    cdp.send = (method, params = {}, sessionId) => new Promise((res, rej) => {
      const id = (cdp.seq += 1);
      cdp.pending.set(id, { res, rej });
      writeFd.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\u0000');
    });
    readFd.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      for (;;) {
        const end = buf.indexOf('\u0000');
        if (end < 0) return;
        const raw = buf.slice(0, end); buf = buf.slice(end + 1);
        if (!raw.trim()) continue;
        const msg = JSON.parse(raw);
        const p = cdp.pending.get(msg.id);
        if (p) { cdp.pending.delete(msg.id); msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result); }
      }
    });
    return cdp;
  }

  async function killChrome({ settleMs = 0 } = {}) {
    if (!chromeProcess) return;
    try { chromeProcess.kill(); } catch { /* 已退出 */ }
    chromeProcess = null;
    cdp = null;
    if (settleMs) await wait(settleMs);
  }

  // 关掉本轮所有 page，避免上一页的 rAF/动画时钟在下一场景抢 CPU（p3 的 warm 首帧口径）。
  async function closePages({ settleMs = 300 } = {}) {
    for (const targetId of targets.splice(0)) {
      try { await cdp.send('Target.closeTarget', { targetId }); } catch { /* 已关闭 */ }
    }
    if (settleMs) await wait(settleMs);
  }

  async function newPage({ probe, reducedMotion = false } = {}) {
    const target = await cdp.send('Target.createTarget', { url: 'about:blank' });
    targets.push(target.targetId);
    const attached = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    const sid = attached.sessionId;
    await cdp.send('Page.enable', {}, sid);
    await cdp.send('Runtime.enable', {}, sid);
    if (reducedMotion) {
      await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }, sid);
    }
    if (probe) await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: probe }, sid);
    return sid;
  }

  async function navigate(sessionId, url) {
    return cdp.send('Page.navigate', { url }, sessionId);
  }

  async function openPage({ url, probe, reducedMotion = false } = {}) {
    const sid = await newPage({ probe, reducedMotion });
    if (url) await navigate(sid, url);
    return sid;
  }

  async function evaluate(expression, sessionId) {
    const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true }, sessionId);
    if (r.exceptionDetails) {
      throw new Error(evaluateErrorPrefix + r.exceptionDetails.text + ' ' + (r.result?.description ?? ''));
    }
    return r.result.value;
  }

  async function waitFor(fn, ms = waitMs, sessionId) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await fn(sessionId)) return true;
      await wait(waitIntervalMs);
    }
    return false;
  }

  async function post(path, body) {
    const r = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  }

  const postJson = async (path, body) => (await post(path, body)).body;

  const send = (method, params = {}, sessionId) => cdp.send(method, params, sessionId);

  async function screenshot(sessionId, file) {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    const buffer = Buffer.from(shot.data, 'base64');
    if (file) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, buffer);
    }
    return buffer;
  }

  async function close({ settleMs = 300, removeTemp = false } = {}) {
    await killChrome();
    await stopServer({ settleMs });
    if (removeTemp) {
      for (const dir of [dataDir, ...profileDirs]) {
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 句柄未释放时忽略 */ }
      }
    }
  }

  return {
    root, port, origin, dataDir, chromeBinary,
    get profileDir() { return profileDir; },
    get serverLog() { return serverLog; },
    get cdp() { return cdp; },
    startServer, stopServer, startChrome, killChrome, closePages,
    newPage, navigate, openPage, evaluate, waitFor, post, postJson, screenshot, close, send,
    wait,
  };
}
