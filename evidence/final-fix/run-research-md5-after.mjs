// 修复后：真正重跑研究五面（不是对已落盘 log 取 md5），CRLF 归一后与 P3 更正台账逐位比较。
// 运行：node evidence/final-fix/run-research-md5-after.mjs
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(ROOT, 'evidence', 'final-fix');
const FACES = ['report', 'sweep', 'viab', 'recover', 'metab'];
const md5 = (buffer) => createHash('md5').update(buffer).digest('hex');
const expected = JSON.parse(readFileSync(join(ROOT, 'evidence', 'redo-p3', 'research-md5.corrected.json'), 'utf8'));

const faces = {};
let bad = 0;
for (const face of FACES) {
  const r = spawnSync(process.execPath, ['life/run.mjs', `--${face}`], { cwd: ROOT, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${face} 重跑失败：${String(r.stderr).slice(0, 400)}`);
  const raw = r.stdout;
  const crlf = Buffer.from(raw.toString('utf8').replace(/\r\n/g, '\n').replace(/\n/g, '\r\n'), 'utf8');
  const want = expected.faces[face];
  const actual = { rawBytes: raw.length, rawMd5: md5(raw), crlfBytes: crlf.length, crlfMd5: md5(crlf) };
  const match = actual.crlfMd5 === want.md5 && actual.crlfBytes === want.bytes;
  if (!match) bad += 1;
  faces[face] = { ...actual, expectedMd5: want.md5, expectedBytes: want.bytes, match };
  writeFileSync(join(OUT, `research-${face}-after.log`), raw);
  console.log(`[${face}] ${actual.crlfMd5} ${actual.crlfBytes}B · expected ${want.md5} · ${match ? 'match' : 'MISMATCH'}`);
}
const result = { method: '修复后重跑 node life/run.mjs --<face>，CRLF 归一后与 evidence/redo-p3/research-md5.corrected.json 逐位比较', at: new Date().toISOString(), faces, allMatch: bad === 0 };
writeFileSync(join(OUT, 'research-md5-after.json'), JSON.stringify(result, null, 2) + '\n');
console.log(`研究五面 md5 与 P3 台账逐位相同：${result.allMatch}`);
if (!result.allMatch) process.exitCode = 1;
