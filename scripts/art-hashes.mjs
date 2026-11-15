// 美术资产指纹（art regression gate）。
//
// 为什么需要它：研究面早就有"五份面 md5"钉死（`evidence/`），但 95 张美术素材没有任何指纹。
// 于是"改图"这件事只能靠肉眼发现——重新生成、跑一次覆盖稿、或者别人提交一张图，都可能在无人察觉时改变游戏外观。
// 同时 `scripts/pack-assets.mjs` 会把素材打进 atlas，atlas 一改，内存与帧数据都会变。
//
// 做法：对每张 PNG 取 sha256，存成根目录的 `art-hashes.json`（与既有的 `m3-imported-hashes.json` 同一种做法）。
//   node scripts/art-hashes.mjs           # 重新钉死（改图后必须显式跑这一步，等于"承认外观变了"）
//   node scripts/art-hashes.mjs --check   # 校验；任何一张不一致就 exit 1
//
// 注意：哈希是对 **PNG 文件字节** 取的，而 PNG 由 `zlib.deflateSync` 生成。
// Node 大版本升级可能改变压缩输出（像素完全一样、字节不同）⇒ 那时 `--check` 会红。
// 这是有意的：它逼你显式重钉一次，并在 CHANGELOG 里写清"只是压缩器变了"。不要静默忽略。
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ASSETS = join(ROOT, 'web', 'assets');
const MANIFEST = join(ROOT, 'art-hashes.json');

function listAssets() {
  const out = [];
  for (const name of readdirSync(ASSETS)) {
    if (name.endsWith('.png')) out.push(name);
  }
  const actions = join(ASSETS, 'actions');
  if (existsSync(actions)) {
    for (const name of readdirSync(actions)) {
      if (name.endsWith('.png')) out.push(`actions/${name}`);
    }
  }
  return out.sort();
}

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const current = {};
for (const name of listAssets()) current[name] = sha256(join(ASSETS, name));

const check = process.argv.includes('--check');

if (!check) {
  const doc = {
    note: '美术资产指纹：改图/改生成器后必须显式重跑 `node scripts/art-hashes.mjs`，并在 CHANGELOG 说明外观变化。',
    node: process.version,
    count: Object.keys(current).length,
    files: current,
  };
  writeFileSync(MANIFEST, JSON.stringify(doc, null, 2) + '\n');
  console.log(`✔ 已钉死 ${doc.count} 张素材 → art-hashes.json（node ${doc.node}）`);
  process.exit(0);
}

if (!existsSync(MANIFEST)) {
  console.error('✖ 没有 art-hashes.json：先跑 `node scripts/art-hashes.mjs` 建立基线');
  process.exit(1);
}
const base = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const baseFiles = base.files ?? {};
const added = Object.keys(current).filter((k) => !(k in baseFiles));
const removed = Object.keys(baseFiles).filter((k) => !(k in current));
const changed = Object.keys(current).filter((k) => k in baseFiles && baseFiles[k] !== current[k]);

if (!added.length && !removed.length && !changed.length) {
  console.log(`✔ 美术指纹一致：${Object.keys(current).length} 张素材未变（基线 node ${base.node}）`);
  process.exit(0);
}

console.error('✖ 美术素材与基线不一致 —— 这代表游戏外观变了，必须显式确认：');
for (const k of changed.slice(0, 10)) console.error(`  改了  ${k}`);
for (const k of added.slice(0, 10)) console.error(`  新增  ${k}`);
for (const k of removed.slice(0, 10)) console.error(`  删除  ${k}`);
if (Math.max(changed.length, added.length, removed.length) > 10) console.error('  …（只列前 10 条）');
if (base.node !== process.version) {
  console.error(`\n提示：基线是 ${base.node}，当前是 ${process.version}。`);
  console.error('若像素没变而字节变了，多半是 zlib 压缩器差异：核对生成器 diff 后重钉一次，并在 CHANGELOG 写明原因。');
}
console.error('\n如果外观变化是故意的：node scripts/art-hashes.mjs 重新钉死，并更新 CHANGELOG。');
process.exit(1);
