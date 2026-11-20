// 1.1 第 3 项证据：研究五面 md5 复算（与 P3 更正台账逐位比较）。
// 研究日志由 PowerShell 重定向写成 LF；P3 台账是 CRLF 字节口径，这里按 CRLF 归一后取 md5。
// 运行：node evidence/v11-compare/run-research-md5.mjs
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(ROOT, 'evidence', 'v11-compare');
const FACES = ['report', 'sweep', 'viab', 'recover', 'metab'];
const md5 = (buffer) => createHash('md5').update(buffer).digest('hex');
const expected = JSON.parse(readFileSync(join(ROOT, 'evidence', 'redo-p3', 'research-md5.corrected.json'), 'utf8'));

const faces = {};
let bad = 0;
for (const face of FACES) {
  const raw = readFileSync(join(OUT, 'research', `${face}.log`));
  const crlf = Buffer.from(raw.toString('utf8').replace(/\r\n/g, '\n').replace(/\n/g, '\r\n'), 'utf8');
  const want = expected.faces[face];
  const actual = { rawBytes: raw.length, rawMd5: md5(raw), crlfBytes: crlf.length, crlfMd5: md5(crlf) };
  const match = actual.crlfMd5 === want.md5 && actual.crlfBytes === want.bytes;
  if (!match) bad += 1;
  faces[face] = { ...actual, expectedMd5: want.md5, expectedBytes: want.bytes, match };
}
const result = { algorithm: 'md5', generatedAt: new Date().toISOString(), faces, allMatch: bad === 0 };
writeFileSync(join(OUT, 'research-md5.json'), JSON.stringify(result, null, 2) + '\n');
for (const face of FACES) {
  const row = faces[face];
  console.log(`[${face}] ${row.crlfMd5} ${row.crlfBytes}B · expected ${row.expectedMd5} · ${row.match ? 'match' : 'MISMATCH'}`);
}
console.log(`研究五面 md5 与 P3 台账逐位相同：${result.allMatch}`);
if (!result.allMatch) process.exitCode = 1;
