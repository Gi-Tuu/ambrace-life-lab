#!/usr/bin/env node
// 名字存档归档（交接单 §4.7 纪律档）：重新部署会清空 /data ⇒ 必须先手工归档、部署后恢复。
// 用法：
//   node scripts/archive-saves.mjs                      # 归档（默认 data/ → ~/.ambrace-archives/<时间戳>/）
//   node scripts/archive-saves.mjs restore              # 恢复最近一份
//   node scripts/archive-saves.mjs restore <时间戳>      # 恢复指定一份
//   --data <dir> / --out <dir> 覆盖默认路径
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, mkdtempSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
// 先摘掉带值的开关，剩下的才是位置参数（否则 `restore --data x` 会把 --data 当成时间戳）。
const positionals = [];
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--data' || argv[i] === '--out') { i += 1; continue; }
  positionals.push(argv[i]);
}
const cmd = positionals[0] === 'restore' ? 'restore' : 'archive';
const DATA = resolve(argOf('--data', process.env.DATA_DIR ?? 'data'));
const OUT = resolve(argOf('--out', join(homedir(), '.ambrace-archives')));
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

const SAVE_ROOTS = ['world.json', 'world.json.bak', 'comparison.json', 'saves'];

function hashTree(dir, {ignoreManifest = false} = {}) {
  const out = Object.create(null);
  const walk = (directory, base = '') => {
    for (const entry of readdirSync(directory,{withFileTypes:true})) {
      if (!base && ignoreManifest && entry.name === 'manifest.json') continue;
      const path = join(directory, entry.name);
      const rel = base ? base + '/' + entry.name : entry.name;
      if (entry.isDirectory()) walk(path, rel);
      else if (entry.isFile()) out[rel] = createHash('sha256').update(readFileSync(path)).digest('hex');
      else throw new Error('归档含有非普通文件：' + rel);
    }
  };
  walk(dir);
  return out;
}

function entriesAt(dir) {
  return SAVE_ROOTS.filter(name => existsSync(join(dir,name)));
}

function archive() {
  const entries = entriesAt(DATA);
  if (!entries.length) { console.error('[archive-saves] 没有可归档的存档'); process.exitCode=2; return; }
  mkdirSync(OUT,{recursive:true});
  const work = mkdtempSync(join(OUT,'.staging-'));
  const dest = join(OUT,stamp());
  try {
    for (const name of entries) cpSync(join(DATA,name),join(work,name),{
      recursive:true, filter: source => !basename(source).endsWith('.tmp'),
    });
    const files = hashTree(work);
    if (!Object.keys(files).length) throw new Error('没有实际存档文件');
    writeFileSync(join(work,'manifest.json'),JSON.stringify({dataDir:DATA,at:new Date().toISOString(),files},null,2));
    renameSync(work,dest);
    console.log('[archive-saves] 已归档 ' + Object.keys(files).length + ' 个文件 → ' + dest);
  } finally { rmSync(work,{recursive:true,force:true}); }
}

function verify(dir, expected, ignoreManifest = false) {
  const actual = hashTree(dir,{ignoreManifest});
  if (Object.keys(expected).length===0 ||
      Object.keys(actual).length!==Object.keys(expected).length ||
      Object.entries(expected).some(([name, hash]) => actual[name]!==hash)) {
    throw new Error('归档清单或文件哈希不匹配');
  }
}

function restore() {
  const wanted = positionals[1] ?? null;
  const dirs = existsSync(OUT) ? readdirSync(OUT,{withFileTypes:true})
    .filter(e=>e.isDirectory() && !e.name.startsWith('.staging-'))
    .map(e=>e.name).sort() : [];
  const pick = wanted ?? dirs.at(-1);
  if (!pick || !dirs.includes(pick)) { console.error('[archive-saves] 找不到归档'); process.exitCode=2; return; }
  const src = join(OUT,pick);
  const manifest = JSON.parse(readFileSync(join(src,'manifest.json'),'utf8'));
  const expected = manifest.files;
  if (!expected || typeof expected!=='object' || Array.isArray(expected)) throw new Error('归档清单无效');
  const entries = entriesAt(src);
  if (!entries.length || readdirSync(src).some(name=>name!=='manifest.json' && !entries.includes(name))) {
    throw new Error('归档含有未知的顶层文件');
  }
  verify(src,expected,true);

  mkdirSync(DATA,{recursive:true});
  const work = mkdtempSync(join(DATA,'.restore-'));
  const stage = join(work,'incoming'), previous = join(work,'previous');
  const backups = [], installed = [];
  let rollbackFailed = false;
  try {
    mkdirSync(stage); mkdirSync(previous);
    for (const name of entries) cpSync(join(src,name),join(stage,name),{recursive:true});
    verify(stage,expected);
    for (const name of entries) {
      if (existsSync(join(DATA,name))) {
        renameSync(join(DATA,name),join(previous,name));
        backups.push(name);
      }
      renameSync(join(stage,name),join(DATA,name));
      installed.push(name);
    }
  } catch (error) {
    try {
      for (const name of installed.reverse()) renameSync(join(DATA,name),join(stage,name));
      for (const name of backups.reverse()) renameSync(join(previous,name),join(DATA,name));
    } catch (rollback) {
      rollbackFailed = true;
      throw new AggregateError([error,rollback],'恢复和回滚失败，保留工作目录：'+work);
    }
    throw error;
  } finally {
    if (!rollbackFailed) rmSync(work,{recursive:true,force:true});
  }
  console.log('[archive-saves] 已从 ' + src + ' 恢复到 ' + DATA);
}

try {
  if (cmd === 'archive') archive(); else restore();
} catch (error) {
  console.error('[archive-saves] ' + error.message);
  process.exitCode=1;
}
