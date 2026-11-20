// 研究五面 md5 台账闸门：12 份 artifact / 65 条记录必须逐字节等于 checked-in log。
// 这里直接复用 scripts/research-md5-ledgers.mjs 的审计函数，避免测试与脚本各写一套映射。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { auditLedgers, CORRECTIONS, FACES, ROOT, SPECS } from '../scripts/research-md5-ledgers.mjs';

const canonical = {
  report: 'de764430c8bc88cd8dbbc24512621e4f',
  sweep: 'aadd4895e84ae657d5a1e22c132228b1',
  viab: 'b923787830eb26c3853ecf959987cf9d',
  recover: 'fe198109386d048356f2fa69312e5183',
  metab: '5ea0ae6473c4f0ff46f47b7a2463b409',
};
const stale = new Set([
  '19a2803182a5a63ae944120dd0a528bc',
  '22f76c48897713ddcee9bae8f767e31b',
  '86da5c0a4a0e26b082fbfb54fd6c1736',
  'feac239b364b8a771042d3996529181e',
  'e0a23df93d8fa7c9e5db7d2ccc9a76cf',
]);

test('RESEARCH-MD5 全部台账与 checked-in log 一致，五面跨 artifact 逐位相同', () => {
  const audit = auditLedgers();
  assert.equal(audit.ok, true, JSON.stringify(audit.reports.map((r) => [r.ledger, r.mismatches])));
  assert.equal(audit.summary.artifactCount, SPECS.length);
  assert.equal(audit.summary.entryCount, 65);
  assert.equal(audit.summary.mismatchEntryCount, 0);
  assert.equal(audit.summary.missingLogCount, 0);
  assert.equal(audit.summary.actualAcrossArtifactsIdentical, true);
  for (const face of FACES) {
    assert.deepEqual(audit.summary.hashesByFace[face], [canonical[face]], `${face} 的 log 哈希不唯一`);
  }
});

test('旧值→新值 sidecar 完整：40 条转抄错误全部留痕，旧值不再被当新值', () => {
  const corrections = JSON.parse(readFileSync(join(ROOT, CORRECTIONS), 'utf8'));
  assert.equal(corrections.summary.artifactCount, SPECS.length);
  assert.equal(corrections.summary.entryCount, 65);
  assert.equal(corrections.summary.changedEntryCount, 40);
  const changed = corrections.ledgers.flatMap((ledger) => ledger.entries.filter((entry) => entry.changed));
  assert.equal(changed.length, 40);
  for (const entry of changed) {
    assert.notEqual(entry.old.md5, entry.new.md5, `${entry.face} 的 old/new 不应相同`);
    assert.ok(stale.has(entry.old.md5), `${entry.face} 旧值不在历史旧值集合：${entry.old.md5}`);
    assert.equal(entry.new.md5, canonical[entry.face], `${entry.face} 新值不是真实 log 值`);
  }
  // 未被更正的记录（main、arch-gates、debt-time、debt-map）也不能夹带旧值。
  const unchanged = corrections.ledgers.flatMap((ledger) => ledger.entries.filter((entry) => !entry.changed));
  assert.equal(unchanged.length, 25);
  for (const entry of unchanged) assert.equal(entry.old.md5, canonical[entry.face]);
});

test('score md5 清单也在闸门内（不再是被漏掉的第 10 份台账）', () => {
  const spec = SPECS.find((item) => item.stage === 'score');
  assert.ok(spec, 'score 清单必须列入 SPECS');
  assert.ok(SPECS.some((item) => item.stage === 'debt-time'));
  assert.ok(SPECS.some((item) => item.stage === 'debt-map'));
  const audit = auditLedgers();
  const score = audit.reports.find((report) => report.ledger === 'evidence/score/research-md5.txt');
  assert.equal(score.mismatches, 0);
});
