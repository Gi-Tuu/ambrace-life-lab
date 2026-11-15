#!/usr/bin/env node
// 名字存档归档（交接单 §4.7 纪律档）：重新部署会清空 /data ⇒ 必须先手工归档、部署后恢复。
// 用法：
//   node scripts/archive-saves.mjs                      # 归档（默认 data/ → ~/.ambrace-archives/<时间戳>/）
//   node scripts/archive-saves.mjs restore              # 恢复最近一份
//   node scripts/archive-saves.mjs restore <时间戳>      # 恢复指定一份
//   --data <dir> / --out <dir> 覆盖默认路径
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

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

function hashTree(dir) {
  const out = {};
  const walk = (d, base = '') => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const rel = base ? `${base}/${name}` : name;
      const st = statSync(p);
      if (st.isDirectory()) walk(p, rel);
      else out[rel] = createHash('sha256').update(readFileSync(p)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

function archive() {
  if (!existsSync(DATA)) { console.error(`[archive-saves] 数据目录不存在：${DATA}`); process.exit(2); }
  const dest = join(OUT, stamp());
  mkdirSync(dest, { recursive: true });
  let files = 0;
  if (existsSync(join(DATA, 'world.json'))) { cpSync(join(DATA, 'world.json'), join(dest, 'world.json')); files += 1; }
  const saves = join(DATA, 'saves');
  if (existsSync(saves)) {
    cpSync(saves, join(dest, 'saves'), { recursive: true });
    files += Object.keys(hashTree(saves)).length;
  }
  writeFileSync(join(dest, 'manifest.json'), JSON.stringify({ dataDir: DATA, at: new Date().toISOString(), files: hashTree(dest) }, null, 2));
  console.log(`[archive-saves] 已归档 ${files} 个文件 → ${dest}`);
  console.log(`[archive-saves] 部署前把这一行记进 checklist；部署后跑：node scripts/archive-saves.mjs restore`);
}

function restore() {
  if (!existsSync(OUT)) { console.error(`[archive-saves] 没有归档目录：${OUT}`); process.exit(2); }
  const wanted = cmd === 'restore' && positionals[1] ? positionals[1] : null;
  const dirs = readdirSync(OUT).filter((n) => statSync(join(OUT, n)).isDirectory()).sort();
  const pick = wanted ?? dirs[dirs.length - 1];
  if (!pick || !dirs.includes(pick)) { console.error(`[archive-saves] 找不到归档：${wanted ?? '(空)'}`); process.exit(2); }
  const src = join(OUT, pick);
  mkdirSync(DATA, { recursive: true });
  if (existsSync(join(src, 'world.json'))) cpSync(join(src, 'world.json'), join(DATA, 'world.json'));
  if (existsSync(join(src, 'saves'))) {
    rmSync(join(DATA, 'saves'), { recursive: true, force: true });
    cpSync(join(src, 'saves'), join(DATA, 'saves'), { recursive: true });
  }
  // 校验：恢复后的哈希必须与 manifest 一致（少一个文件就叫出来，不静默）
  const manifest = join(src, 'manifest.json');
  if (existsSync(manifest)) {
    const want = JSON.parse(readFileSync(manifest, 'utf8')).files ?? {};
    const got = hashTree(src);
    const missing = Object.keys(want).filter((k) => !(k in got));
    if (missing.length) { console.error(`[archive-saves] 归档自身缺文件：${missing.join(',')}`); process.exit(1); }
  }
  console.log(`[archive-saves] 已从 ${src} 恢复到 ${DATA}`);
}

if (cmd === 'archive') archive(); else restore();
