#!/usr/bin/env node
// 1.1 正式钟生存：把 before/after/对照与研究 md5 汇总成一份 evidence JSON。
//   node scripts/v11-balance-summary.mjs
// 只读证据文件；不推进世界、不改规则。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = join(ROOT, 'evidence', 'v11-balance');
const read = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);
const modeName = { on: '1.1 分钟身体（正式默认）', off: 'M5_MINUTE_METAB=0 回退', 'legacy-formal': '同 FORMAL_OPTIONS、无 simClock（旧每刻路径）', p3: 'P3 GAME_OPTIONS（gameRules=false、eventRules=1，life/long-run.mjs v1 口径）' };
const FILE = { on: 'long-run-on.json', off: 'long-run-off.json', 'legacy-formal': 'long-run-legacy-formal.json', p3: 'long-run-p3-legacy-rules.json' };
const modes = ['on', 'off', 'legacy-formal', 'p3'];
const runs = {};
for (const m of modes) runs[m] = read(join(OUT, `long-run-${m}.json`));
const before = read(join(ROOT, 'evidence', 'v11-metab', 'long-run-on.json'));
const offBefore = read(join(ROOT, 'evidence', 'v11-metab', 'long-run-off.json'));

const dist = (r) => r ? ({
  population30: r.summary.population30,
  population100: r.summary.population100,
  population200: r.summary.population200,
  avg30: r.summary.avg30, avg100: r.summary.avg100, avg200: r.summary.avg200,
  births100: r.summary.births100, deaths100: r.summary.deaths100,
  extinct100: r.summary.extinct100, extinct200: r.summary.extinct200,
  deathCauses200: r.summary.deathCauses200,
}) : null;

// 研究五面：磁盘 log 是 LF（shell 重定向）；按 P3 的 CRLF 字节口径归一后取 md5。
const CANON = {
  report: 'de764430c8bc88cd8dbbc24512621e4f',
  sweep: 'aadd4895e84ae657d5a1e22c132228b1',
  viab: 'b923787830eb26c3853ecf959987cf9d',
  recover: 'fe198109386d048356f2fa69312e5183',
  metab: '5ea0ae6473c4f0ff46f47b7a2463b409',
};
const md5 = (buf) => createHash('md5').update(buf).digest('hex');
const research = {};
for (const face of Object.keys(CANON)) {
  const path = join(OUT, 'research', `${face}.log`);
  if (!existsSync(path)) { research[face] = { missing: true, match: false }; continue; }
  const raw = readFileSync(path);
  const lfToCrlf = Buffer.from(raw.toString('utf8').replace(/\r\n/g, '\n').replace(/\n/g, '\r\n'), 'utf8');
  const rawMd5 = md5(raw), crlfMd5 = md5(lfToCrlf);
  research[face] = {
    rawMd5, rawBytes: raw.length,
    crlfMd5, crlfBytes: lfToCrlf.length,
    expectedMd5: CANON[face], match: crlfMd5 === CANON[face],
  };
}

const summary = {
  _说明: '1.1 正式钟生存：before/after/对照 + 研究五面 md5。before 取自 evidence/v11-metab（本轮修复前的同一 harness）。',
  at: new Date().toISOString(),
  fix: [
    'life/agent.mjs：本地替身决策同步落地（tick 不再返回 Promise；只有真问模型才返回 Promise），消除“分钟循环一次只还一个微任务”造成的 think 拖欠。',
    'life/body.mjs：正式连续世界移动候选按旧刻 60 游戏分/角色发放（movePlanDue），一次移动登记 nextMovePlanMin；研究态/旧路径无门。',
    'life/survplay.mjs：startResidentThink 识别同步结算并立即 afterResidentThink，不再经 Promise.resolve().then().catch().finally() 拖欠微任务。',
    'life/long-run.mjs：只在直接执行本文件时跑实验（*-long-run.mjs 探针不再被 endsWith 误触发）。',
  ],
  distributions: {
    before_on: dist(before),
    before_off: dist(offBefore),
    ...Object.fromEntries(modes.map((m) => [m, dist(runs[m])])),
  },
  afterRows: Object.fromEntries(modes.map((m) => [m, runs[m]?.rows.map((r) => ({
    seed: r.seed, population: r.population, births: r.births, deaths: r.deaths,
    deathCauses: r.deathCauses, ended: r.ended, energy: r.energy, viability: r.viability, store: r.store,
  })) ?? null])),
  research: { note: 'P3 台账按 CRLF 字节；本轮 log 由 PowerShell 重定向写成 LF，故同时列 raw 与归一后 md5。', faces: research, allMatch: Object.values(research).every((f) => f.match) },
};
writeFileSync(join(OUT, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
writeFileSync(join(OUT, 'research-md5.json'), JSON.stringify({ algorithm: 'md5', note: summary.research.note, faces: research, allMatch: summary.research.allMatch }, null, 2) + '\n');
console.log(JSON.stringify({ distributions: summary.distributions, researchAllMatch: summary.research.allMatch }, null, 2));

