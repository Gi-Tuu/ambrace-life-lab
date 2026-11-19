#!/usr/bin/env node
// 阶段 4 分析：开发组先冻结规则与门槛（prereg），再揭晓留出组（holdout）。
// 只统计尺寸（字符/UTF-8 字节 + token 代理 = bytes/4），不做真实模型评估（无授权通道）。
// 用法：
//   node scripts/stage4-analyze.mjs prereg  <outDir>
//   node scripts/stage4-analyze.mjs holdout <outDir>
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const stage = process.argv[2] ?? 'prereg';
const outDir = process.argv[3] ?? new URL('../output-stage4/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const rows = readFileSync(join(outDir, 'freeze.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((x) => JSON.parse(x));

// —— 分组规则（开发期冻结，holdout 前不得再改）——
const SPLIT = Object.freeze({
  rule: 'dev = seed 7,13 全部 tick + seed 29 tick<240；holdout = seed 41,53 全部 tick + seed 29 tick>=240',
  dev: (r) => [7, 13].includes(r.seed) || (r.seed === 29 && r.t < 240),
  holdout: (r) => [41, 53].includes(r.seed) || (r.seed === 29 && r.t >= 240),
});
// —— 预登记门槛（工单建议值）——
const THRESHOLD = Object.freeze({
  medianTokenDrop: 0.15, // 中位 token 代理至少降 15%
  p95NotUp: true,        // P95 不上升
  quality: 'pending',    // 没有授权的真实模型通道 ⇒ 质量逐项待评估
});

const bytes = (s) => Buffer.byteLength(s, 'utf8');
const pct = (xs, p) => {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor((a.length - 1) * p))];
};
const summarize = (group) => {
  const o = group.map((r) => r.promptOriginal), c = group.map((r) => r.promptCompact);
  const m = (xs, f) => ({ median: pct(xs.map(f), 0.5), p95: pct(xs.map(f), 0.95) });
  const charsO = m(o, (s) => s.length), charsC = m(c, (s) => s.length);
  const bytesO = m(o, bytes), bytesC = m(c, bytes);
  const tokO = m(o, (s) => bytes(s) / 4), tokC = m(c, (s) => bytes(s) / 4);
  const drop = (a, b) => (a > 0 ? Number((1 - b / a).toFixed(4)) : null);
  return {
    n: group.length,
    chars: { original: charsO, compact: charsC, medianDrop: drop(charsO.median, charsC.median), p95Drop: drop(charsO.p95, charsC.p95) },
    bytes: { original: bytesO, compact: bytesC, medianDrop: drop(bytesO.median, bytesC.median), p95Drop: drop(bytesO.p95, bytesC.p95) },
    tokenProxy: { original: { median: Number(tokO.median.toFixed(2)), p95: Number(tokO.p95.toFixed(2)) }, compact: { median: Number(tokC.median.toFixed(2)), p95: Number(tokC.p95.toFixed(2)) }, medianDrop: drop(tokO.median, tokC.median), p95Drop: drop(tokO.p95, tokC.p95) },
  };
};
const coverage = (group) => ({
  seeds: [...new Set(group.map((r) => r.seed))].sort((a, b) => a - b),
  tickWindow: [Math.min(...group.map((r) => r.t)), Math.max(...group.map((r) => r.t))],
  triggers: group.reduce((acc, r) => { acc[r.trigger] = (acc[r.trigger] ?? 0) + 1; return acc; }, {}),
  rejected: group.filter((r) => r.rejected).length,
  noMemory: group.filter((r) => !r.memories.length).length,
  shortfall: group.filter((r) => (r.projection.survival?.store ?? 99) <= 3).length,
  repairCandidates: group.filter((r) => r.candidateIds.some((id) => id.startsWith('repair'))).length,
  housingCandidates: group.filter((r) => r.candidateIds.some((id) => /house|home|build/.test(id))).length,
  requestCandidates: group.filter((r) => r.candidateIds.some((id) => /request|coop|talk/.test(id))).length,
});
const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

const dev = rows.filter(SPLIT.dev), holdout = rows.filter(SPLIT.holdout);

if (stage === 'prereg') {
  const prereg = {
    createdAt: new Date().toISOString(), split: SPLIT.rule, threshold: THRESHOLD,
    dev: { coverage: coverage(dev), stats: summarize(dev) },
    holdoutSize: holdout.length,
    data: { freezeSha256: hash(join(outDir, 'freeze.jsonl')), rows: rows.length },
    note: '门槛与分组在揭开留出组之前写死；quality 字段必须等授权通道的配对评估，不得用尺寸结果代替。',
  };
  writeFileSync(join(outDir, 'prereg.json'), JSON.stringify(prereg, null, 2));
  console.log(JSON.stringify({ stage, devN: dev.length, holdoutN: holdout.length, devTokenDrop: prereg.dev.stats.tokenProxy.medianDrop }, null, 2));
} else {
  const prereg = JSON.parse(readFileSync(join(outDir, 'prereg.json'), 'utf8'));
  const stats = summarize(holdout);
  const medianOk = stats.tokenProxy.medianDrop !== null && stats.tokenProxy.medianDrop >= prereg.threshold.medianTokenDrop;
  const p95Ok = !prereg.threshold.p95NotUp || (stats.tokenProxy.p95Drop !== null && stats.tokenProxy.p95Drop >= 0);
  const enough = holdout.length >= 30;
  const decision = !enough ? 'insufficient-data-keep-closed' : (!medianOk || !p95Ok ? 'offline-threshold-not-met-keep-closed' : 'offline-size-ok-quality-pending-keep-closed');
  const out = {
    createdAt: new Date().toISOString(), split: prereg.split, threshold: prereg.threshold,
    dev: prereg.dev, holdout: { coverage: coverage(holdout), stats },
    verdict: { enoughData: enough, medianOk, p95Ok, sizePass: medianOk && p95Ok, quality: 'pending(no authorized model channel)', decision },
    hashes: { freezeSha256: hash(join(outDir, 'freeze.jsonl')), preregSha256: hash(join(outDir, 'prereg.json')) },
    note: '尺寸只证明压缩幅度；有效行动率/规则通过率/回退率必须在授权通道的配对评估里测。候选保持关闭。',
  };
  writeFileSync(join(outDir, 'stats.json'), JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ stage, n: holdout.length, medianDrop: stats.tokenProxy.medianDrop, p95Drop: stats.tokenProxy.p95Drop, decision }, null, 2));
}
