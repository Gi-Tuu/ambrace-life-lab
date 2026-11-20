#!/usr/bin/env node
// 时间债务收口：五份研究面真实 md5 复算。
//   node scripts/debt-time-md5.mjs          重算并写 evidence/debt-time/research-md5.json
//   node scripts/debt-time-md5.mjs --check  只校验，不写文件
// 口径：log 按磁盘字节算 md5（本目录沿用 P3 的 CRLF 口径，与 evidence/redo-p3/research/*.log 同字节）。
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'evidence', 'debt-time');
const FACES = ['report', 'sweep', 'viab', 'recover', 'metab'];
const md5 = (p) => createHash('md5').update(readFileSync(p)).digest('hex');
const bytes = (p) => readFileSync(p).length;

const corrected = JSON.parse(readFileSync(join(ROOT, 'evidence', 'redo-p3', 'research-md5.corrected.json'), 'utf8'));
const faces = {};
let bad = 0;
for (const face of FACES) {
  const log = join(OUT, 'research', `${face}.log`);
  if (!existsSync(log)) {
    faces[face] = { log: `evidence/debt-time/research/${face}.log`, missing: true };
    bad += 1;
    continue;
  }
  const actual = { md5: md5(log), bytes: bytes(log) };
  const expected = corrected.faces[face];
  const match = actual.md5 === expected.md5 && actual.bytes === expected.bytes;
  if (!match) bad += 1;
  faces[face] = {
    log: `evidence/debt-time/research/${face}.log`,
    md5: actual.md5,
    bytes: actual.bytes,
    expectedMd5: expected.md5,
    expectedBytes: expected.bytes,
    match,
  };
}
const result = {
  _说明: '时间债务收口复跑五份研究面，用 log 字节 md5 对照 P3 更正台账（evidence/redo-p3/research-md5.corrected.json）。',
  generatedAt: new Date().toISOString(),
  algorithm: 'md5',
  logDir: 'evidence/debt-time/research',
  faces,
  allMatch: bad === 0,
};
if (!process.argv.includes('--check')) {
  writeFileSync(join(OUT, 'research-md5.json'), JSON.stringify(result, null, 2) + '\n');
}
for (const face of FACES) {
  const f = faces[face];
  console.log(`[${face}] ${f.missing ? 'MISSING' : `${f.md5} ${f.bytes}B`} · expected ${f.expectedMd5 ?? '?'} · ${f.match ? 'match' : 'MISMATCH'}`);
}
console.log(`五份研究面 md5 与 P3 更正台账逐位相同：${result.allMatch}`);
if (!result.allMatch) process.exitCode = 1;
