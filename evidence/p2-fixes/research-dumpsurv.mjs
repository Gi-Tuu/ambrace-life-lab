// P2-4 行为保持证据：四组研究态 dumpSurv A–D 的字节数/md5 与 1.1 基线逐位比较。
// 基线来源：life/v11-research-legacy.test.mjs 的 BASELINES（HEAD e65105f 的探针）。
// 运行：node evidence/p2-fixes/research-dumpsurv.mjs
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSurvPlay, dumpSurv, tickSurvPlay } from '../../life/survplay.mjs';
import { FORMAL_OPTIONS } from '../../life/balance-probe.mjs';
import { GAME_OPTIONS } from '../../life/long-run.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const md5 = (s) => createHash('md5').update(s).digest('hex');
const BASELINES = {
  A: { label: 'research-base', seed: 7, options: {}, ticks: 12, bytes: 40405, md5: '62ccc1af1b9d45d34d145aedc468b539' },
  B: { label: 'research-gameopts', seed: 13, options: GAME_OPTIONS, ticks: 24, bytes: 54778, md5: '052b65f18591b7308bc9f20dbf6684da' },
  C: { label: 'legacy-formal', seed: 7, options: { ...FORMAL_OPTIONS, simTime: false }, ticks: 24, bytes: 54953, md5: '8622d4070400cfbc6a76a86f04c0ae46' },
  D: { label: 'research-independent', seed: 7, options: { independentWorld: true, actTimeModel: true, residentialDecisions: true, unifiedCooperation: true, gameRules: false }, ticks: 24, bytes: 58875, md5: '41f75f8e5cd3c9472274584a608e3842' },
};

const rows = {};
let allMatch = true;
for (const [key, base] of Object.entries(BASELINES)) {
  const sp = createSurvPlay(base.seed, base.options);
  for (let i = 0; i < base.ticks; i += 1) await tickSurvPlay(sp);
  const raw = JSON.stringify(dumpSurv(sp));
  const actual = { label: base.label, seed: base.seed, ticks: base.ticks, bytes: raw.length, md5: md5(raw), expectedBytes: base.bytes, expectedMd5: base.md5 };
  actual.match = actual.bytes === base.bytes && actual.md5 === base.md5;
  if (!actual.match) allMatch = false;
  rows[key] = actual;
  console.log(`${key} ${actual.label}: ${actual.bytes}B ${actual.md5} · expected ${base.bytes}B ${base.md5} · ${actual.match ? 'match' : 'MISMATCH'}`);
}
const out = { generatedAt: new Date().toISOString(), allMatch, faces: rows };
writeFileSync(join(HERE, 'research-dumpsurv.json'), JSON.stringify(out, null, 2) + '\n');
console.log(`四组 dumpSurv 逐位相同：${allMatch}`);
if (!allMatch) process.exitCode = 1;
