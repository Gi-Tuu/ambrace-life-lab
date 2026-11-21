// 审计5 集成测试夹具：起真 serve.mjs（临时 DATA_DIR、loopback、无模型），只做 HTTP。
// 测试进程各自带 pid 段 + 序号，避免 `node --test` 并行文件抢同一端口。
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
let seq = 0;

export async function bootAudit5(env = {}, { waitMs = 30000 } = {}) {
  seq += 1;
  const dataDir = mkdtempSync(join(tmpdir(), 'audit5-'));
  const port = 19000 + (process.pid % 900) + seq * 7;
  const child = spawn(process.execPath, ['serve.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port), HOST: '127.0.0.1', BRAIN: 'local',
      DATA_DIR: dataDir, SEED_FILE: join(ROOT, 'seed', 'world.json'),
      TICK_MS: '10000000', GAME_MS_PER_MINUTE: '10000000', GAME_MODE: 'game', GAME_RULES: '1',
      MODEL_UNATTENDED: '0', ACT_SAVE_COALESCE_MS: '0',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += String(d); });
  child.stderr.on('data', (d) => { out += String(d); });
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline && !out.includes('就绪')) {
    await new Promise((r) => setTimeout(r, 100));
    if (child.exitCode != null) break;
  }
  if (!out.includes('就绪')) {
    child.kill();
    throw new Error(`server boot timeout (${port}): ${out.slice(-600)}`);
  }
  return { child, base: `http://127.0.0.1:${port}`, dir: dataDir, out: () => out };
}

export async function stopAudit5(handle) {
  if (!handle?.child || handle.child.exitCode != null) return;
  handle.child.kill();
  await new Promise((r) => {
    const to = setTimeout(r, 3000);
    handle.child.once('exit', () => { clearTimeout(to); r(); });
  });
}

export function cookiesOf(res) {
  const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  return raw.map((line) => String(line).split(';')[0]).filter((pair) => pair.includes('='));
}

export function cookieJar(res, jar = {}) {
  for (const pair of cookiesOf(res)) {
    const i = pair.indexOf('=');
    jar[pair.slice(0, i)] = pair.slice(i + 1);
  }
  return jar;
}

export function cookieHeader(jar = {}) {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}

export function jsonPost(base, path, body, { jar = {}, headers = {} } = {}) {
  return fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(Object.keys(jar).length ? { cookie: cookieHeader(jar) } : {}), ...headers },
    body: JSON.stringify(body),
  });
}

export function jsonGet(base, path, { jar = {}, headers = {} } = {}) {
  return fetch(base + path, {
    headers: { ...(Object.keys(jar).length ? { cookie: cookieHeader(jar) } : {}), ...headers },
  });
}

// 取一页（GET /）并收集服务端签发的会话 cookie；返回 jar 与页面响应。
export async function openSession(base, jar = {}) {
  const res = await jsonGet(base, '/', { jar });
  cookieJar(res, jar);
  return { res, jar };
}
