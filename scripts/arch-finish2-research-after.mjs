#!/usr/bin/env node
// arch-finish2：重跑五面研究后，用新 log 的字节 md5 对照 P3 更正台账（不覆盖历史 log）。
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'evidence', 'arch-finish2');
const FRESH = join(OUT, 'research');
const FACES = ['report', 'sweep', 'viab', 'recover', 'metab'];
const md5 = (p) => createHash('md5').update(readFileSync(p)).digest('hex');
const bytes = (p) => readFileSync(p).length;

const corrected = JSON.parse(readFileSync(join(ROOT, 'evidence', 'redo-p3', 'research-md5.corrected.json'), 'utf8'));
const faces = {};
let bad = 0;
for (const face of FACES) {
  const freshLog = join(FRESH, `${face}.log`);
  const p3Log = join(ROOT, 'evidence', 'redo-p3', 'research', `${face}.log`);
  const freshMd5 = md5(freshLog);
  const p3Md5 = md5(p3Log);
  const recorded = corrected.faces[face].md5;
  const matchP3 = freshMd5 === p3Md5;
  const matchCorrected = freshMd5 === recorded;
  if (!matchP3 || !matchCorrected) bad += 1;
  faces[face] = {
    freshLog: `evidence/arch-finish2/research/${face}.log`,
    freshBytes: bytes(freshLog),
    freshMd5,
    p3Log: `evidence/redo-p3/research/${face}.log`,
    p3Md5,
    correctedMd5: recorded,
    matchP3,
    matchCorrected,
  };
}
const result = {
  _说明: 'B 提交后重跑五份研究，用新 log 字节 md5 对照 P3 真实 log 与更正台账；历史 log 未覆盖。',
  generatedAt: new Date().toISOString(),
  algorithm: 'md5',
  faces,
  allMatch: bad === 0,
};
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'research-md5-after.json'), JSON.stringify(result, null, 2) + '\n');
for (const face of FACES) {
  const f = faces[face];
  console.log(`[${face}] fresh ${f.freshMd5} · p3 ${f.p3Md5} · matchP3 ${f.matchP3} · matchCorrected ${f.matchCorrected}`);
}
console.log(`五面与 P3 真实 log / 更正台账逐位相同：${result.allMatch}`);
if (!result.allMatch) process.exitCode = 1;
