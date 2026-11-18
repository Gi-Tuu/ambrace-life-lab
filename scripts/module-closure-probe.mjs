// 子进程探针：真实 import host.mjs / serve.mjs，记录模块加载闭包。
// 用法：node scripts/module-closure-probe.mjs host|serve
// 输出一行 JSON：{ target, modules: [...相对路径], webgl: [...含 WebGL 上下文的模块] }
import { registerHooks } from 'node:module';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');
const target = process.argv[2] ?? 'host';
if (!['host', 'serve'].includes(target)) {
  console.error('target must be host or serve');
  process.exit(2);
}

const loaded = new Map();
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (url.startsWith('file:')) {
      const file = fileURLToPath(url);
      if (!loaded.has(file)) loaded.set(file, String(result.source ?? ''));
    }
    return result;
  },
});

const dir = mkdtempSync(join(tmpdir(), `closure-${target}-`));
Object.assign(process.env, {
  DATA_DIR: dir,
  SEED_FILE: join(dir, 'missing-seed.json'),
  GAME_MODE: 'research',
  TICK_MS: '1000000',
  ACT_SAVE_COALESCE_MS: '0',
  PORT: '0',
  HOST: '127.0.0.1',
  BRAIN: 'local',
  MODEL_PROVIDERS: '',
  MODEL_KEYS: '',
});

try {
  await import(pathToFileURL(join(ROOT, target === 'host' ? 'life/host.mjs' : 'serve.mjs')).href);
} catch (error) {
  console.error(String(error?.stack ?? error));
  process.exit(1);
}

const modules = [...loaded.keys()].map((f) => relative(ROOT, f).split('\\').join('/')).sort();
const webgl = [...loaded.entries()]
  .filter(([file, source]) => /getContext\s*\(\s*['"`]webgl|webglcontextlost/i.test(source) && file.startsWith(ROOT))
  .map(([file]) => relative(ROOT, file).split('\\').join('/'))
  .sort();
console.log(JSON.stringify({ target, modules, webgl }));
// host.start() 会留下定时器；探针的目的只是闭包，不参与世界运行。
process.exit(0);
