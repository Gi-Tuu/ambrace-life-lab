#!/usr/bin/env node
// P3 部署前静态检查（不改部署）：起一个临时 serve，逐项量 HTTP 头与静态白名单。
// 输出 evidence/redo-p3/static-check.json + static-check.log。
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'evidence', 'redo-p3');
mkdirSync(OUT, { recursive: true });
const PORT = 9600 + (process.pid % 200);
const DATA = mkdtempSync(join(tmpdir(), 'p3-static-data-'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = [];
const note = (kind, data = {}) => rows.push({ at: new Date().toISOString(), kind, ...data });

const server = spawn(process.execPath, ['serve.mjs'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: DATA, SEED_FILE: join(ROOT, 'seed', 'world.json'), GAME_MODE: 'game', GAME_RULES: '1', BRAIN: 'local', TICK_MS: '10000000', MODEL_UNATTENDED: '0' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
server.stdout.on('data', (d) => { out += String(d); });
server.stderr.on('data', (d) => { out += String(d); });
const base = `http://127.0.0.1:${PORT}`;
const get = (p, headers) => fetch(base + p, { headers });

const checks = {};
try {
  for (let i = 0; i < 150 && !out.includes('就绪'); i += 1) await wait(150);
  if (!out.includes('就绪')) throw new Error('服务未就绪：' + out.slice(0, 300));

  // 1) CSP / XFO / 缓存 / ETag
  {
    const r = await get('/');
    const csp = r.headers.get('content-security-policy') ?? '';
    const directive = (csp.match(/frame-ancestors([^;]*)/) ?? [])[1]?.trim() ?? '';
    const sources = directive.split(/\s+/).filter(Boolean);
    const etag = r.headers.get('etag');
    const revalidate = etag ? await get('/', { 'if-none-match': etag }) : null;
    checks.headers = {
      status: r.status,
      csp,
      frameAncestors: directive,
      frameAncestorsSources: sources,
      bareWildcard: sources.includes('*'),
      xFrameOptions: r.headers.get('x-frame-options'),
      cacheControl: r.headers.get('cache-control'),
      etag,
      revalidateStatus: revalidate?.status ?? null,
      revalidateBytes: revalidate ? (await revalidate.arrayBuffer()).byteLength : null,
    };
    note('headers', checks.headers);
  }
  {
    const r = await get('/web/assets/terrain_grass0.png?v=0123456789ab');
    checks.immutable = { status: r.status, cacheControl: r.headers.get('cache-control'), etag: r.headers.get('etag'), bytes: (await r.arrayBuffer()).byteLength };
    const mod = await get('/web/app.js');
    const etag = mod.headers.get('etag');
    const re = etag ? await get('/web/app.js', { 'if-none-match': etag }) : null;
    checks.moduleCache = { status: mod.status, cacheControl: mod.headers.get('cache-control'), etag, revalidateStatus: re?.status ?? null, revalidateBytes: re ? (await re.arrayBuffer()).byteLength : null };
    note('immutable', checks.immutable);
    note('moduleCache', checks.moduleCache);
  }

  // 2) 静态白名单：life/ 只有 space.mjs；仓库内部文件不得可达
  {
    const probes = [
      ['/life/space.mjs', 200], ['/life/host.mjs', 404], ['/life/survplay.mjs', 404],
      ['/life/', 404], ['/docs/', 404], ['/Dockerfile', 404], ['/.env', 404], ['/.env.example', 404],
      ['/README.md', 404], ['/art-hashes.json', 404], ['/package.json', 404], ['/ambrace-life-lab/web/app.js', 404],
      ['/web/assets/../life/host.mjs', 404], ['/web/%2e%2e/life/host.mjs', 404],
    ];
    const got = [];
    for (const [p, want] of probes) {
      const r = await get(p);
      got.push({ path: p, status: r.status, want, ok: r.status === want });
    }
    checks.whitelist = { ok: got.every((g) => g.ok), rows: got };
    note('whitelist', checks.whitelist);
  }

  // 3) 资产/镜像面（文件系统，不 build）
  {
    const pngs = [];
    for (const name of readdirSync(join(ROOT, 'web', 'assets'))) if (name.endsWith('.png')) pngs.push(name);
    for (const name of readdirSync(join(ROOT, 'web', 'assets', 'actions'))) if (name.endsWith('.png')) pngs.push('actions/' + name);
    const manifest = JSON.parse(readFileSync(join(ROOT, 'web', 'assets', 'manifest.json'), 'utf8'));
    checks.assets = {
      pngCount: pngs.length,
      terrainPng: pngs.filter((p) => p.startsWith('terrain_')).length,
      portraitPng: pngs.filter((p) => p.startsWith('actions/')).length,
      manifestScenes: Object.keys(manifest.scenes ?? {}).length,
      paletteExists: existsSync(join(ROOT, 'web', 'assets', 'palette.json')),
    };
    const docker = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');
    const ignore = readFileSync(join(ROOT, '.dockerignore'), 'utf8');
    checks.image = {
      copyLines: docker.split('\n').filter((l) => /^COPY\s/.test(l)).map((l) => l.trim()),
      copyWholeRepo: /^COPY\s+\.\s/m.test(docker),
      ignoresEnv: /^\.env$/m.test(ignore) && /^\.env\.\*$/m.test(ignore),
      ignoresDocsData: /^docs\/$/m.test(ignore) && /^data\/$/m.test(ignore),
      dead2DGenerators: ['gen-pixel-assets.mjs', 'pack-assets.mjs'].filter((f) => existsSync(join(ROOT, 'scripts', f))),
      assetsPackageScript: JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts.assets ?? null,
    };
    note('assets', checks.assets);
    note('image', checks.image);
  }

  checks.ok = Boolean(
    checks.headers.frameAncestorsSources.includes("'self'")
    && checks.headers.frameAncestorsSources.includes('https://*.ms.show')
    && checks.headers.frameAncestorsSources.includes('https://modelscope.cn')
    && checks.headers.frameAncestorsSources.includes('https://www.modelscope.cn')
    && !checks.headers.bareWildcard
    && checks.headers.xFrameOptions === null
    && /no-cache/.test(checks.headers.cacheControl ?? '')
    && checks.headers.revalidateStatus === 304
    && checks.headers.revalidateBytes === 0
    && /immutable/.test(checks.immutable.cacheControl ?? '')
    && checks.moduleCache.revalidateStatus === 304
    && checks.whitelist.ok
    && checks.assets.pngCount === 20
    && checks.assets.terrainPng === 16
    && checks.assets.portraitPng === 4
    && checks.assets.manifestScenes === 16
    && !checks.image.copyWholeRepo
    && checks.image.ignoresEnv
    && checks.image.dead2DGenerators.length === 0
    && checks.image.assetsPackageScript === null
  );
  console.log('[p3-static]', checks.ok ? 'PASS' : 'FAIL', JSON.stringify({
    frameAncestors: checks.headers.frameAncestors,
    xFrameOptions: checks.headers.xFrameOptions,
    etag304: checks.headers.revalidateStatus,
    immutable: checks.immutable.cacheControl,
    whitelist: checks.whitelist.rows,
    assets: checks.assets,
    image: checks.image,
  }));
} catch (error) {
  checks.ok = false;
  checks.error = String(error?.stack ?? error);
  console.error('[p3-static] FAIL', error);
  process.exitCode = 1;
} finally {
  try { server.kill(); } catch {}
  writeFileSync(join(OUT, 'static-check.json'), JSON.stringify(checks, null, 2) + '\n');
  writeFileSync(join(OUT, 'static-check.log'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}
