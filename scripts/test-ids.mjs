// 判据 ID 扫描器：把 `test('...')` / `describe('...')` / `it('...')` 标题开头的
// 判据编号抽出来，检查全仓唯一性。`scripts/check.mjs` 把它当静态闸门用；
// 也可以单独运行看清单：
//
//   node scripts/test-ids.mjs          # 人读摘要；有重复时退出码 1
//   node scripts/test-ids.mjs --json   # 机读 JSON（报告/对比用）
//
// ── ID 口径（写死在这里，闸门与报告共用同一份）──────────────────────────────
// 1. 只认标题**开头**的编号：可选空白 + 大写字母开头、至少含一个数字（或带 `′` 的
//    族标，如 `C′`）的连续记号。
//    记号内允许字母/数字/`-`/`_`/`/`/`′`/`'`/`–`（`–` 用于 FAM-01–04 这类区间写法）。
//    例：`ARCH-ASYNC-01`、`SA15`、`V4-09-1`、`P1b-H01`、`A′-01`、`CAMP-01`、`T26/T27`。
//    不把标题中间的编号当 ID（例如“见 V4-09”），否则正文引用会被误判成判据。
// 2. `P1a` 与 `P1` 是两个 ID：小写后缀是作者刻意区分的子族（P1a/P1b、SA4b、T07b）。
//    早期扫描器把 `P1a` 截成 `P1`，制造了 13 个假重复；本口径按作者原意保留完整记号。
// 3. 标题不含编号（纯描述句）的测试不参与唯一性检查；它们没有可撞的 ID。
// 4. 同一测试文件里用 `${...}` 循环生成的多个运行时子测试算一条静态标题：
//    夹具不同、判据 ID 相同是允许的；这里查的是**源码里写了几次同一个 ID**。
// 5. `describe` 与 `test` 同等对待：层级块标题里的 ID 也占用命名空间。
// 6. 复合号按完整记号比较：`FAM-05/06` 与 `FAM-05` 不算重复；0 重复不保证拆号后无指向歧义。
//
// 为什么不用棘轮（只挡新增）：交接文档里 141 个重复 ID 已经存在，棘轮会把
// “同 ID 指不同要求”的歧义永久冻在基线里；这里要求全仓 0 重复，新增与遗留
// 走同一条红/绿线。
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// 标题字面量里出现 ${...} 时，保留表达式原文用于人读；不参与 ID 抽取（ID 必须在开头）。
const ID_AT_START = /^\s*([A-Z][A-Za-z0-9′'–]*(?:[-_/][A-Za-z0-9′'–]+)*)/;
const HAS_DIGIT = /\d/;

function readStringLiteral(src, quoteAt) {
  const quote = src[quoteAt];
  let i = quoteAt + 1;
  let value = '';
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') { value += src.slice(i, i + 2); i += 2; continue; }
    if (ch === quote) return { value, end: i + 1 };
    if (quote === '`' && ch === '$' && src[i + 1] === '{') {
      let depth = 1;
      i += 2;
      let expr = '';
      while (i < src.length && depth > 0) {
        if (src[i] === '{') depth += 1;
        if (src[i] === '}') depth -= 1;
        if (depth > 0) expr += src[i];
        i += 1;
      }
      value += `\${${expr}}`;
      continue;
    }
    value += ch;
    i += 1;
  }
  return { value, end: i };
}

export function extractTitleCalls(source, file = '<source>') {
  const out = [];
  // 排除 `obj.test(...)` / `.only(...)`：调用前一个字符不能是标识符/点号。
  const call = /(^|[^\w.$])(test|describe|it)\s*\(\s*(['"`])/gm;
  for (const m of source.matchAll(call)) {
    const quoteAt = m.index + m[0].length - 1;
    const { value, end } = readStringLiteral(source, quoteAt);
    const line = source.slice(0, m.index).split('\n').length;
    const idMatch = ID_AT_START.exec(value);
    const id = idMatch && (HAS_DIGIT.test(idMatch[1]) || idMatch[1].includes('′')) ? idMatch[1] : null;
    out.push({ file, line, kind: m[2], title: value, id, titleStart: quoteAt + 1, titleEnd: end - 1 });
  }
  return out;
}

export function scanTestIds(root = ROOT) {
  const dir = join(root, 'life');
  const files = readdirSync(dir).filter((name) => name.endsWith('.test.mjs')).sort();
  const entries = [];
  for (const name of files) {
    const file = `life/${name}`;
    const source = readFileSync(join(dir, name), 'utf8');
    entries.push(...extractTitleCalls(source, file));
  }
  const withId = entries.filter((entry) => entry.id);
  const byId = new Map();
  for (const entry of withId) {
    if (!byId.has(entry.id)) byId.set(entry.id, []);
    byId.get(entry.id).push(entry);
  }
  const duplicates = [...byId.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([id, list]) => ({ id, entries: list }))
    .sort((a, b) => b.entries.length - a.entries.length || a.id.localeCompare(b.id));
  return {
    files: files.length,
    entries,
    withId: withId.length,
    uniqueIds: byId.size,
    duplicates,
    duplicateEntries: duplicates.reduce((sum, group) => sum + group.entries.length, 0),
  };
}

function formatDuplicateLine(entry) {
  return `    ${entry.file}:${entry.line}  ${entry.title.slice(0, 100)}`;
}

export function formatReport(scan) {
  const lines = [
    `判据 ID 扫描：${scan.files} 个测试文件 · ${scan.entries.length} 条 test/describe/it 标题 · `
      + `${scan.withId} 条带 ID · ${scan.uniqueIds} 个唯一 ID`,
  ];
  if (!scan.duplicates.length) {
    lines.push('✔ 判据 ID 全仓唯一：0 个重复 ID');
    return lines.join('\n');
  }
  lines.push(`✖ 判据 ID 重复：${scan.duplicates.length} 个 ID 被 ${scan.duplicateEntries} 条测试共用`);
  for (const group of scan.duplicates) {
    lines.push(`  - ${group.id} ×${group.entries.length}`);
    for (const entry of group.entries) lines.push(formatDuplicateLine(entry));
  }
  return lines.join('\n');
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const scan = scanTestIds();
  if (process.argv.includes('--json')) {
    const payload = {
      files: scan.files,
      titles: scan.entries.length,
      withId: scan.withId,
      uniqueIds: scan.uniqueIds,
      duplicates: scan.duplicates,
    };
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(formatReport(scan));
  }
  if (scan.duplicates.length) process.exitCode = 1;
}
