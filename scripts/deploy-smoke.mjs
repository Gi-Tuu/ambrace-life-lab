#!/usr/bin/env node
// 部署冒烟（Docker 不可用时的等价物化）+ HTTP/安全头/路径矩阵。
//
// 这台机器没有可用的 Docker daemon，所以这里做的是**等价文件级检查**，不是 docker build：
//   1) 解析 Dockerfile 的 COPY 集合与 .dockerignore，断言只带 serve/life/web/shared/seed；
//   2) 按 COPY 集合把"镜像内 /app"物化到 evidence/deploy-smoke/image-root（不是镜像）；
//   3) 审计这棵树：不得含 .env / 密钥 / 旧数据 / .git / docs / Dockerfile / package.json；
//   4) 直接在这棵树上以 production-like 环境起 serve.mjs，跑 HTTP 矩阵。
// 明确不声称：镜像大小、层数、容器内文件系统隔离、线上 iframe/CSP 已通过。见报告。
//
// 用法：
//   node scripts/deploy-smoke.mjs build
//   node scripts/deploy-smoke.mjs http
//   node scripts/deploy-smoke.mjs all
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { request } from 'node:http';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'evidence', 'deploy-smoke');
const IMAGE = resolve(OUT, 'image-root');
const RUNTIME_DATA = resolve(OUT, 'runtime-data');
const PORT = Number(process.env.DEPLOY_SMOKE_PORT ?? 7860);
const COPY_SOURCES = ['serve.mjs', 'life/', 'web/', 'shared/', 'seed/'];
const FRAME_SOURCES = ["'self'", 'https://*.ms.show', 'https://modelscope.cn', 'https://www.modelscope.cn'];
const REQUIRED_FRAME_ANCESTORS = 'frame-ancestors ' + FRAME_SOURCES.join(' ');
const FAKE_KEY = 'sk-smoke-FAKE-0000-not-a-real-key';
const FAKE_PROVIDER = 'https://model-endpoint.invalid/v1';
const FAKE_MODEL = 'smoke/fake-model';

mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log('[deploy-smoke]', ...a);
const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};
const posix = (p) => p.split(sep).join('/');

// ───────────────────────── Dockerfile / .dockerignore 解析 ─────────────────────────
function readDockerfileAudit() {
  const text = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');
  const lines = text.split(/\r?\n/);
  const copies = [];
  const adds = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (/^#/.test(line) || !line) continue;
    const m = /^(COPY|ADD)\s+(.+)$/i.exec(line);
    if (!m) continue;
    const args = m[2].split(/\s+/).filter((x) => !x.startsWith('--') && x !== './');
    if (m[1].toUpperCase() === 'ADD') adds.push(args);
    else copies.push(args);
  }
  const normalize = (p) => (p === './' ? '' : p.replace(/^\.\//, '').replace(/\/$/, '/'));
  const sources = copies.map((args) => normalize(args[0]));
  const expected = COPY_SOURCES.map(normalize);
  const onlyExpected = sources.length === expected.length && expected.every((e) => sources.includes(e));
  check('Dockerfile 只 COPY 五个入口（serve/life/web/shared/seed）', onlyExpected, 'COPY 源=' + JSON.stringify(sources));
  check('Dockerfile 无 ADD', adds.length === 0, adds.length ? JSON.stringify(adds) : '');
  check('Dockerfile 基础镜像 node:22-alpine', /^FROM\s+node:22-alpine/mi.test(text));
  check('Dockerfile ENV 含 PORT=7860 / HOST=0.0.0.0 / GAME_MODE=game / GAME_RULES=1 / DATA_DIR=/data',
    /PORT=7860/.test(text) && /HOST=0\.0\.0\.0/.test(text) && /GAME_MODE=game/.test(text)
    && /GAME_RULES=1/.test(text) && /DATA_DIR=\/data/.test(text));
  check('Dockerfile EXPOSE 7860', /^EXPOSE\s+7860/m.test(text));
  check('Dockerfile 有 HEALTHCHECK 打 /healthz', /HEALTHCHECK[\s\S]{0,400}\/healthz/.test(text));
  check('Dockerfile 没有把密钥写进 ENV/ARG', !/^\s*(?:ENV|ARG)\s+.*(?:MODEL_KEY|MODEL_KEYS|CTL_TOKEN|CHAT_TOKEN|RELAY_TOKEN)\s*=/mi.test(text));
  check('Dockerfile 没有 --env-file / COPY . .', !/--env-file|^COPY\s+\.\s+\.?\/?$/mi.test(text));

  const ignoreLines = readFileSync(join(ROOT, '.dockerignore'), 'utf8')
    .split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
  const hasPattern = (p) => ignoreLines.includes(p);
  check('.dockerignore 排除 .env', hasPattern('.env'));
  check('.dockerignore 排除 .env.*', hasPattern('.env.*'));
  check('.dockerignore 排除 data/', hasPattern('data/'));
  check('.dockerignore 排除 docs/', hasPattern('docs/'));
  check('.dockerignore 排除 .git/', hasPattern('.git/'));
  check('.dockerignore 排除 *.log', hasPattern('*.log'));
  return { copies, sources, ignoreLines, text };
}

function makeIgnoreMatcher(patterns) {
  const norm = (p) => p.replace(/^\.\//, '');
  return (relPosix) => {
    const p = norm(relPosix);
    for (const pat of patterns) {
      const q = norm(pat);
      if (q.endsWith('/')) {
        const seg = q.slice(0, -1);
        if (p === seg || p.split('/').includes(seg)) return true;
      } else if (q === '.env.*') {
        if (/^\.env\./.test(p) || /\/(?:^|\/)\.env\./.test(p)) return true;
      } else if (q.startsWith('/*.')) {
        const ext = q.slice(2);
        if (!p.includes('/') && p.endsWith(ext)) return true;
      } else if (q.startsWith('*.')) {
        if (p.endsWith(q.slice(1))) return true;
      } else if (q === p || p.endsWith('/' + q)) {
        return true;
      }
    }
    return false;
  };
}

function walk(dir, ignored, base = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const rel = posix(relative(base, full));
    if (ignored(rel)) continue;
    if (entry.isDirectory()) walk(full, ignored, base, out);
    else if (entry.isFile()) out.push({ full, rel, size: statSync(full).size });
  }
  return out;
}

// 构建上下文体积：Docker 会按 .dockerignore 把整个上下文发给 daemon（即使只 COPY 五个入口）。
function contextSize() {
  const ignoreLines = readFileSync(join(ROOT, '.dockerignore'), 'utf8').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
  const ignored = makeIgnoreMatcher(ignoreLines);
  let files = 0; let bytes = 0; const byTop = new Map();
  const stack = [ROOT];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const rel = posix(relative(ROOT, full));
      // 本次冒烟自己生成的产物不参与"构建上下文"估算，避免自膨胀
      if (rel === 'evidence/deploy-smoke') continue;
      if (ignored(rel)) continue;
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) {
        const size = statSync(full).size;
        files += 1; bytes += size;
        const top = rel.includes('/') ? rel.split('/')[0] : '(root)';
        const acc = byTop.get(top) ?? { files: 0, bytes: 0 };
        acc.files += 1; acc.bytes += size; byTop.set(top, acc);
      }
    }
  }
  return { files, bytes, byTop: [...byTop.entries()].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.bytes - a.bytes) };
}

// ───────────────────────── build：物化 + 审计 ─────────────────────────
function build() {
  const df = readDockerfileAudit();
  const ignored = makeIgnoreMatcher(df.ignoreLines);

  rmSync(IMAGE, { recursive: true, force: true });
  mkdirSync(IMAGE, { recursive: true });
  for (const src of COPY_SOURCES) {
    const from = join(ROOT, src);
    const to = join(IMAGE, src);
    cpSync(from, to, { recursive: true, filter: (s) => !ignored(posix(relative(ROOT, s))) });
  }

  const files = walk(IMAGE, () => false);
  const totalBytes = files.reduce((a, f) => a + f.size, 0);
  const tops = readdirSync(IMAGE).sort();
  check('物化树顶层恰好是 serve.mjs/life/web/shared/seed（无 Dockerfile/package.json/docs/data）',
    JSON.stringify(tops) === JSON.stringify(['life', 'seed', 'serve.mjs', 'shared', 'web']), JSON.stringify(tops));

  const byTop = {};
  for (const f of files) {
    const top = f.rel.split('/')[0];
    byTop[top] ??= { files: 0, bytes: 0 };
    byTop[top].files += 1; byTop[top].bytes += f.size;
  }
  const layerBytes = {
    'serve.mjs': statSync(join(IMAGE, 'serve.mjs')).size,
    'life/': byTop.life?.bytes ?? 0,
    'web/': byTop.web?.bytes ?? 0,
    'shared/': byTop.shared?.bytes ?? 0,
    'seed/': byTop.seed?.bytes ?? 0,
  };

  const forbiddenNames = [
    /(^|\/)\.env($|\.)/i,
    /\.(pem|key|p12|pfx|jks|crt)$/i,
    /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.|$)/i,
    /(^|\/)(secrets?|credentials?)(\.|$)/i,
    /(^|\/)(node_modules|\.git|docs|data)(\/|$)/i,
    /\.log$/i,
  ];
  const badNames = files.filter((f) => forbiddenNames.some((re) => re.test(f.rel)));
  check('物化树无 .env / 私钥 / 旧数据 / .git / docs / 日志', badNames.length === 0,
    badNames.slice(0, 8).map((f) => f.rel).join(', ') || '0 命中');

  const contentPatterns = [
    { name: 'ENV 赋值 MODEL_KEY(S)=<value>', re: /MODEL_KEYS?\s*=\s*[^\s'"#]+/ },
    { name: 'PEM 私钥块', re: /BEGIN [A-Z ]*PRIVATE KEY/ },
  ];
  const textExt = new Set(['.mjs', '.js', '.json', '.html', '.css', '.md', '.txt', '.yml', '.yaml']);
  const contentHits = [];
  for (const f of files) {
    if (!textExt.has(extname(f.full).toLowerCase()) || f.size > 2 * 1024 * 1024) continue;
    const text = readFileSync(f.full, 'utf8');
    for (const p of contentPatterns) {
      if (p.re.test(text)) contentHits.push({ file: f.rel, pattern: p.name });
    }
  }
  check('物化树文本无密钥赋值 / 私钥块', contentHits.length === 0,
    contentHits.slice(0, 8).map((h) => `${h.file} (${h.pattern})`).join(', ') || '0 命中');

  const tests = files.filter((f) => /\.test\.mjs$/.test(f.rel));
  const ctx = contextSize();
  const git = (args) => {
    const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
    return r.status === 0 ? r.stdout.trim() : '';
  };
  const gitStatus = git(['status', '--porcelain']).split(/\r?\n/).filter(Boolean);
  const hashOf = (rel) => createHash('sha256').update(readFileSync(join(ROOT, rel))).digest('hex');

  const result = {
    at: new Date().toISOString(),
    mode: 'no-docker-equivalent-materialization',
    repo: { head: git(['rev-parse', 'HEAD']), branch: git(['branch', '--show-current']), status: gitStatus },
    hashes: {
      Dockerfile: hashOf('Dockerfile'), dockerignore: hashOf('.dockerignore'), 'serve.mjs': hashOf('serve.mjs'),
      'web/app.js': hashOf('web/app.js'), 'seed/world.json': hashOf('seed/world.json'),
    },
    dockerfile: { copySources: df.sources, ignoreLines: df.ignoreLines },
    imageTree: {
      path: IMAGE,
      topLevel: tops,
      files: files.length,
      bytes: totalBytes,
      layerBytes,
      testFiles: tests.length,
      largest: [...files].sort((a, b) => b.size - a.size).slice(0, 10).map((f) => ({ rel: f.rel, bytes: f.size })),
    },
    buildContext: { files: ctx.files, bytes: ctx.bytes, byTop: ctx.byTop.slice(0, 12) },
    findings: {
      testFilesInImage: tests.length,
      testBytesInImage: tests.reduce((a, f) => a + f.size, 0),
      note: 'Dockerfile 的 COPY life/ 会把 399 个文件（其中 201 个测试/探针，~1.10 MiB）一起带进镜像；不含密钥与旧数据，仅体积与暴露面。',
    },
    checks,
  };
  writeFileSync(join(OUT, 'build-audit.json'), JSON.stringify(result, null, 2) + '\n');
  const lines = [
    '# 构建/物化审计（Docker daemon 不可用，等价文件级检查）',
    `时间: ${result.at}`,
    `仓库: ${result.repo.branch} @ ${result.repo.head}`,
    `工作区改动: ${result.repo.status.length ? result.repo.status.join('; ') : '干净'}`,
    `模式: ${result.mode}`,
    `物化树: ${IMAGE}`,
    `顶层: ${tops.join(', ')}`,
    `文件数/体积: ${files.length} / ${totalBytes} B (${(totalBytes / 1024 / 1024).toFixed(2)} MiB)`,
    '',
    '## COPY 集合（Dockerfile）',
    ...df.sources.map((s) => `- ${s}`),
    '',
    '## 物化树分层体积（仅作参考，不是镜像层实测）',
    ...Object.entries(layerBytes).map(([k, v]) => `- ${k}: ${v} B (${(v / 1024 / 1024).toFixed(2)} MiB)`),
    '',
    '## 构建上下文（按 .dockerignore 估算，Docker 会整包发送）',
    `- ${ctx.files} 文件 / ${(ctx.bytes / 1024 / 1024).toFixed(2)} MiB`,
    ...ctx.byTop.slice(0, 12).map((t) => `- ${t.name}: ${(t.bytes / 1024 / 1024).toFixed(2)} MiB`),
    '',
    '## 审计检查',
    ...checks.map((c) => `${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.detail ? ' — ' + c.detail : ''}`),
    '',
    '## 边界',
    '- 未运行 docker build：镜像大小/层数未实测；上表只是物化树体积。',
    '- 未验证容器隔离、VOLUME、HEALTHCHECK 在容器运行时行为。',
    '- 唯一排除的真实构建风险：Dockerfile 语法/COPY 源缺失只能由 build 发现，本检查无法代替。',
    '',
  ];
  writeFileSync(join(OUT, 'build-audit.txt'), lines.join('\n'));
  log(`物化树 ${files.length} 文件 / ${(totalBytes / 1024 / 1024).toFixed(2)} MiB → ${IMAGE}`);
  log('构建上下文（估算）', ctx.files, '文件', (ctx.bytes / 1024 / 1024).toFixed(2), 'MiB');
  return result;
}

// ───────────────────────── HTTP 矩阵 ─────────────────────────
function requestOnce(path, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolvePromise) => {
    const started = Date.now();
    let req;
    try {
      req = request({
        host: '127.0.0.1', port: PORT, path, method,
        headers: { connection: 'close', 'user-agent': 'deploy-smoke/1.0', ...headers },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          const pairs = [];
          for (let i = 0; i < res.rawHeaders.length; i += 2) pairs.push([res.rawHeaders[i], res.rawHeaders[i + 1]]);
          resolvePromise({
            path, method, status: res.statusCode, statusMessage: res.statusMessage ?? '',
            headers: res.headers, rawHeaders: pairs, body: buf, ms: Date.now() - started, error: null,
          });
        });
      });
    } catch (error) {
      resolvePromise({ path, method, status: 0, headers: {}, rawHeaders: [], body: Buffer.alloc(0), ms: Date.now() - started, error: String(error?.code ?? error) });
      return;
    }
    req.on('error', (error) => {
      resolvePromise({ path, method, status: 0, headers: {}, rawHeaders: [], body: Buffer.alloc(0), ms: Date.now() - started, error: String(error?.code ?? error) });
    });
    req.setTimeout(15000, () => req.destroy(new Error('TIMEOUT')));
    if (body != null) req.write(body);
    req.end();
  });
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const textOf = (res) => res.body.toString('utf8');
const decodeText = (res) => {
  if (String(res.headers['content-encoding'] ?? '').includes('gzip')) {
    try { return gunzipSync(res.body).toString('utf8'); } catch { return ''; }
  }
  return res.body.toString('utf8');
};
const hasHeader = (res, name) => res.rawHeaders.some(([k]) => k.toLowerCase() === name);

function startServer() {
  rmSync(RUNTIME_DATA, { recursive: true, force: true });
  mkdirSync(RUNTIME_DATA, { recursive: true });
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    HOST: '0.0.0.0',
    PORT: String(PORT),
    DATA_DIR: RUNTIME_DATA,
    SEED_FILE: join(IMAGE, 'seed', 'world.json'),
    GAME_MODE: 'game',
    GAME_RULES: '1',
    BRAIN: 'model',
    MODEL_PROVIDERS: FAKE_PROVIDER,
    MODEL_KEYS: FAKE_KEY,
    MODEL_NAME: FAKE_MODEL,
    MODEL_NAMES: '',
    PRESENCE_MS: '60000',
    TICK_MS: '1200',
  };
  delete env.MODEL_BASE_URL; delete env.MODEL_KEY; delete env.MODEL_UNATTENDED;
  delete env.CHAT_TOKEN; delete env.CTL_TOKEN; delete env.BRAIN_RELAY_TOKEN;
  const child = spawn(process.execPath, ['serve.mjs'], { cwd: IMAGE, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (d) => { output += String(d); });
  child.stderr.on('data', (d) => { output += String(d); });
  return { child, log: () => output, env };
}

async function waitReady(server, ms = 45000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (server.log().includes('就绪')) return true;
    if (server.child.exitCode != null) return false;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

async function httpMatrix() {
  if (!existsSync(join(IMAGE, 'serve.mjs'))) throw new Error('物化树不存在，先跑 build');
  const server = startServer();
  const ready = await waitReady(server);
  check('production-like 服务就绪（物化树 + 假 key 注入）', ready, ready ? '' : server.log().slice(0, 500));
  if (!ready) {
    server.child.kill();
    writeFileSync(join(OUT, 'server.log'), server.log());
    throw new Error('服务未就绪');
  }

  const GZIP = { 'accept-encoding': 'gzip' };
  const results = [];
  const record = (res, note = '') => {
    res.note = note;
    res.bodyBytes = res.body.length;
    res.bodySha256 = sha256(res.body);
    res.bodyText = decodeText(res);
    results.push(res);
    return res;
  };

  // 1) 健康检查
  const health = record(await requestOnce('/healthz', { headers: GZIP }), 'healthz');
  check('/healthz 200', health.status === 200, `HTTP ${health.status}`);
  let healthJson = null;
  try { healthJson = JSON.parse(textOf(health)); } catch { /* 下面判 */ }
  check('/healthz 是合法 JSON 且 ok:true', Boolean(healthJson?.ok), JSON.stringify(healthJson?.ok));
  check('/healthz 报 BRAIN=model 且供应商已配置',
    healthJson?.model === FAKE_MODEL && healthJson?.providers?.[0]?.configured === true,
    `model=${healthJson?.model} configured=${healthJson?.providers?.[0]?.configured}`);
  check('/healthz 不回显密钥/端点/数据目录',
    !decodeText(health).includes(FAKE_KEY) && !decodeText(health).includes('model-endpoint.invalid') && !decodeText(health).includes(RUNTIME_DATA.replace(/\\/g, '\\\\')) && !decodeText(health).includes(RUNTIME_DATA));
  check('/healthz 走 gzip（>1KB 时）', health.headers['content-encoding'] === 'gzip' || health.body.length < 1024,
    `encoding=${health.headers['content-encoding'] ?? 'identity'} bytes=${health.body.length}`);
  checks.push(...headerChecks(health, '/healthz'));

  const headHealth = await requestOnce('/healthz', { method: 'HEAD' });
  check('HEAD /healthz 200 且无 body', headHealth.status === 200 && headHealth.body.length === 0, `HTTP ${headHealth.status} body=${headHealth.body.length}`);

  // 2) 首页 / 静态 / gzip / ETag / 304
  const index = record(await requestOnce('/', { headers: GZIP }), 'index gzip');
  check('/ 200', index.status === 200, `HTTP ${index.status}`);
  check('/ 含 3D 画布 cvA 与 app.js 入口', /id="cvA"/.test(decodeText(index)) && /\/web\/app\.js/.test(decodeText(index)));
  check('/ gzip 生效', index.headers['content-encoding'] === 'gzip', `encoding=${index.headers['content-encoding'] ?? 'identity'}`);
  checks.push(...headerChecks(index, '/'));
  const gz = (res) => {
    try { return gunzipSync(res.body); } catch { return null; }
  };
  const indexIdentity = record(await requestOnce('/'), '/ identity');
  check('/ gzip 解压与 identity 字节一致', gz(index)?.equals(indexIdentity.body) === true,
    `gzip=${index.body.length} identity=${indexIdentity.body.length}`);

  const app = record(await requestOnce('/web/app.js', { headers: GZIP }), 'app.js gzip');
  check('/web/app.js 200 + gzip + ETag', app.status === 200 && app.headers['content-encoding'] === 'gzip' && Boolean(app.headers.etag),
    `HTTP ${app.status} encoding=${app.headers['content-encoding'] ?? 'identity'} etag=${app.headers.etag}`);
  checks.push(...headerChecks(app, '/web/app.js'));
  const appIdentity = record(await requestOnce('/web/app.js'), 'app.js identity');
  const appRaw = appIdentity.body;
  const appGz = gz(app);
  check('/web/app.js 解压后与源文件逐字节一致（sha256）', appGz ? sha256(appGz) === sha256(appRaw) : false,
    `decoded=${appGz?.length} src=${appRaw.length}`);
  check('/web/app.js gzip 体积 < 原始（压缩生效）', app.body.length < appRaw.length,
    `${appRaw.length} → ${app.body.length} B（debt-perf 记录 265,891 → 98,896）`);

  const app304 = record(await requestOnce('/web/app.js', { headers: { ...GZIP, 'if-none-match': String(app.headers.etag) } }), 'app.js 304');
  check('/web/app.js 条件请求 304 且空 body', app304.status === 304 && app304.body.length === 0, `HTTP ${app304.status} body=${app304.body.length}`);
  check('304 保留 ETag', app304.headers.etag === app.headers.etag, String(app304.headers.etag));
  checks.push(...headerChecks(app304, '/web/app.js 304'));

  const appImmutable = record(await requestOnce('/web/app.js?v=abc123456', { headers: GZIP }), 'app.js immutable');
  check('?v= 指纹请求返回 immutable 长缓存', String(appImmutable.headers['cache-control'] ?? '').includes('immutable'),
    String(appImmutable.headers['cache-control'] ?? ''));

  const css = record(await requestOnce('/web/app.css', { headers: GZIP }), 'app.css');
  check('/web/app.css 200 + gzip', css.status === 200 && css.headers['content-encoding'] === 'gzip',
    `HTTP ${css.status} encoding=${css.headers['content-encoding'] ?? 'identity'} bytes=${css.body.length}`);

  const font = record(await requestOnce('/web/assets/fonts/fusion-pixel-12px-monospaced-zh_hans.woff2', { headers: GZIP }), 'woff2');
  check('woff2 200 且不做二次 gzip', font.status === 200 && !font.headers['content-encoding'],
    `HTTP ${font.status} encoding=${font.headers['content-encoding'] ?? 'identity'}`);

  // 3) 世界快照
  const world = record(await requestOnce('/world', { headers: GZIP }), 'world gzip');
  check('/world 200 + gzip', world.status === 200 && world.headers['content-encoding'] === 'gzip',
    `HTTP ${world.status} encoding=${world.headers['content-encoding'] ?? 'identity'} bytes=${world.body.length}`);
  let worldJson = null;
  try { worldJson = JSON.parse(gz(world)?.toString('utf8') ?? textOf(world)); } catch { /* 判据 */ }
  check('/world 是合法 JSON，含 survival 与 B', Boolean(worldJson?.survival && worldJson?.B),
    `survival.t=${worldJson?.survival?.t} mode=${worldJson?.mode} brain=${worldJson?.brain}`);
  check('/world 报 BRAIN=model 且 watching=true', worldJson?.brain === 'model', `brain=${worldJson?.brain} watching=${worldJson?.model?.watching}`);
  check('/world 无 saveError/tickError', !worldJson?.saveError && !worldJson?.tickError,
    `saveError=${worldJson?.saveError ?? 'null'} tickError=${worldJson?.tickError ?? 'null'}`);
  check('/world gzip 体积 与 debt-perf 19,851 B 同量级/一致（内容随世界推进变化）', world.body.length > 0,
    `${world.body.length} B（debt-perf 146,473 → 19,851）`);

  const diag = record(await requestOnce('/diag'), '/diag');
  check('/diag 200 且不回显地址/令牌', diag.status === 200 && !textOf(diag).includes(FAKE_KEY) && !textOf(diag).includes('model-endpoint.invalid'),
    `HTTP ${diag.status}`);

  const saves = record(await requestOnce('/saves'), '/saves');
  let savesJson = null;
  try { savesJson = JSON.parse(textOf(saves)); } catch { /* 判据 */ }
  check('/saves 200 只读', saves.status === 200 && Array.isArray(savesJson?.entries), `HTTP ${saves.status}`);

  // 4) 静态白名单：只放行 web/shared + life/space.mjs
  const space = record(await requestOnce('/life/space.mjs'), 'life/space.mjs');
  check('/life/space.mjs 200（唯一放行的 life 文件）', space.status === 200 && /javascript/.test(String(space.headers['content-type'])), `HTTP ${space.status} type=${space.headers['content-type']}`);
  checks.push(...headerChecks(space, '/life/space.mjs'));
  const shared = record(await requestOnce('/shared/wild-landscape.mjs'), 'shared');
  check('/shared/wild-landscape.mjs 200', shared.status === 200, `HTTP ${shared.status}`);
  const hostMjs = record(await requestOnce('/life/host.mjs'), 'life/host.mjs');
  check('/life/host.mjs 404（服务端宿主不得暴露）', hostMjs.status === 404, `HTTP ${hostMjs.status} body=${textOf(hostMjs).slice(0, 80)}`);
  checks.push(...headerChecks(hostMjs, '/life/host.mjs 404'));
  const agentMjs = record(await requestOnce('/life/agent.mjs'), 'life/agent.mjs');
  check('/life/agent.mjs 404', agentMjs.status === 404, `HTTP ${agentMjs.status}`);

  // 5) 路径穿越 / 越界文件
  const negative = [
    ['/life/../.env', 404],
    ['/web/../.env', 404],
    ['/web/../../.env', 404],
    ['/life/../../.env', 404],
    ['/.env', 404],
    ['/.env.example', 404],
    ['/%2e%2e%2f.env', 404],
    ['/..%2f.env', 404],
    ['/web/%2e%2e/%2e%2e/.env', 404],
    ['/life/%2e%2e%2f%2e%2e%2f.env', 404],
    ['/..%5c.env', 404],
    ['/web/..\\..\\.env', 404],
    ['/%2e%2e/%2e%2e/%2e%2e/%2e%2e/.env', 404],
    ['/package.json', 404],
    ['/Dockerfile', 404],
    ['/.dockerignore', 404],
    ['/docs/', 404],
    ['/docs/%E5%9B%9E%E6%8A%A5-%E5%80%BA%E5%8A%A1-%E6%80%A7%E8%83%BD-2026-11-20.md', 404],
    ['/.git/HEAD', 404],
    ['/seed/world.json', 404],
    ['/data/world.json', 404],
    ['/scripts/smoke-online.mjs', 404],
    ['/serve.mjs', 404],
    ['/life/space.mjs/../host.mjs', 404],
    ['/%zz', 400],
    ['/%00', 404],
  ];
  for (const [path, expected] of negative) {
    const res = record(await requestOnce(path), 'negative');
    const ok = expected === 0 ? res.status >= 400 : res.status === expected;
    check(`路径越界/未放行 ${path} → ${expected}`, ok, `HTTP ${res.status}${res.error ? ' err=' + res.error : ''} body=${textOf(res).slice(0, 60)}`);
    check(`路径越界 ${path} 不回显仓库绝对路径`, !textOf(res).includes(ROOT) && !textOf(res).includes(RUNTIME_DATA), textOf(res).slice(0, 80));
    checks.push(...headerChecks(res, path));
  }

  // 6) 写路由错误响应不泄露内部路径 / 密钥
  const badAct = record(await requestOnce('/act', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' }), 'bad act');
  check('POST /act 坏 JSON → 400 且不回显密钥/路径', badAct.status === 400 && !textOf(badAct).includes(FAKE_KEY) && !textOf(badAct).includes(ROOT), `HTTP ${badAct.status} body=${textOf(badAct).slice(0, 80)}`);

  const postSpace = record(await requestOnce('/act', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' }), 'act content-type');
  check('POST /act 非 JSON content-type 不 500（拒绝或 415/400）', postSpace.status !== 500 && postSpace.status < 500, `HTTP ${postSpace.status}`);

  // 7) 密钥/端点回显全局扫描
  const allBodies = results.map((r) => r.bodyText ?? '').join('\n');
  check('所有响应体不含假密钥', !allBodies.includes(FAKE_KEY));
  check('所有响应体不含模型端点 URL', !allBodies.includes('model-endpoint.invalid'));
  check('所有响应体不含仓库/数据目录绝对路径', !allBodies.includes(ROOT) && !allBodies.includes(RUNTIME_DATA));

  // 8) 服务日志不泄露
  const slog = server.log();
  writeFileSync(join(OUT, 'server.log'), slog);
  check('服务启动日志不含假密钥', !slog.includes(FAKE_KEY));
  check('服务启动日志不含模型端点 URL', !slog.includes('model-endpoint.invalid'), slog.split(/\r?\n/).filter((l) => /model-endpoint|invalid/i.test(l)).join(' | ').slice(0, 200));
  check('服务日志无 uncaught/unhandled 崩溃', !/uncaughtException|unhandledRejection/.test(slog), (slog.match(/uncaughtException|unhandledRejection/g) ?? []).length + ' 条');

  // 证据落盘
  const headerDump = [];
  for (const name of ['/', '/web/app.js', '/world', '/healthz', '/life/space.mjs', '/life/host.mjs', '/life/../.env', '/.env']) {
    const entry = results.find((r) => r.path === name && r.rawHeaders.length);
    if (!entry) continue;
    headerDump.push(`=== ${entry.method} ${name}（accept-encoding: gzip）===`);
    headerDump.push(`HTTP/1.1 ${entry.status} ${entry.statusMessage}`);
    for (const [k, v] of entry.rawHeaders) headerDump.push(`${k}: ${v}`);
    headerDump.push(`[body ${entry.bodyBytes} B sha256=${entry.bodySha256.slice(0, 16)}]`, '');
  }
  writeFileSync(join(OUT, 'http-headers.txt'), headerDump.join('\n'));
  writeFileSync(join(OUT, 'http-matrix.json'), JSON.stringify({
    at: new Date().toISOString(), base: `http://127.0.0.1:${PORT}`, env: {
      NODE_ENV: 'production', HOST: '0.0.0.0', PORT, DATA_DIR: RUNTIME_DATA, GAME_MODE: 'game', GAME_RULES: '1',
      BRAIN: 'model', MODEL_PROVIDERS: FAKE_PROVIDER, MODEL_KEYS: '<redacted-fake>', MODEL_NAME: FAKE_MODEL,
      PRESENCE_MS: 60000, TICK_MS: 1200, seed: 'seed/world.json',
    }, results: results.map((r) => ({
      method: r.method, path: r.path, status: r.status, ms: r.ms, note: r.note,
      headers: Object.fromEntries(Object.entries(r.headers).filter(([k]) => /^(content-type|content-length|content-encoding|etag|cache-control|vary|content-security-policy|x-frame-options|x-content-type-options|referrer-policy|location)$/.test(k))),
      bodyBytes: r.bodyBytes, bodySha256: r.bodySha256,
    })), checks,
  }, null, 2) + '\n');

  server.child.kill();
  await new Promise((r) => setTimeout(r, 500));
  return results;
}

function headerChecks(res, label) {
  const csp = String(res.headers['content-security-policy'] ?? '');
  const directives = new Map();
  for (const part of csp.split(';')) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) directives.set(name, values);
  }
  const frameAncestors = (directives.get('frame-ancestors') ?? []).join(' ');
  return [
    { name: `${label}: CSP frame-ancestors 精确匹配`, ok: frameAncestors === FRAME_SOURCES.join(' '), detail: frameAncestors || '(缺失)' },
    { name: `${label}: 无 X-Frame-Options`, ok: !hasHeader(res, 'x-frame-options'), detail: res.headers['x-frame-options'] ?? '' },
    { name: `${label}: X-Content-Type-Options: nosniff`, ok: String(res.headers['x-content-type-options'] ?? '').toLowerCase() === 'nosniff' },
  ];
}

// ───────────────────────── 入口 ─────────────────────────
const step = process.argv[2] ?? 'all';
try {
  if (step === 'build') build();
  else if (step === 'http') await httpMatrix();
  else if (step === 'all') { build(); await httpMatrix(); }
  else { console.error('用法: node scripts/deploy-smoke.mjs [build|http|all]'); process.exitCode = 2; }
  const failed = checks.filter((c) => !c.ok);
  log(`checks: ${checks.length - failed.length}/${checks.length} pass`);
  if (failed.length) {
    console.error('[deploy-smoke] FAILED:', failed.map((f) => f.name).join(' | '));
    process.exitCode = 1;
  }
} catch (error) {
  console.error('[deploy-smoke] ERROR', error?.stack ?? error);
  process.exitCode = 1;
}
