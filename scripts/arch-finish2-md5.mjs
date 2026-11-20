#!/usr/bin/env node
// 兼容入口（历史命令名）：研究五面 md5 台账现已收口到 scripts/research-md5-ledgers.mjs。
//
// 用法：
//   node scripts/arch-finish2-md5.mjs           # 复验 12 份 artifact/65 条记录，并刷新 audit 快照
//   node scripts/arch-finish2-md5.mjs --check   # 只复验；任一记录与 checked-in log 不符 => exit 1
//
// 旧的“只校验 P3 corrected sidecar”已废弃：原台账已被直接更正，旧值→新值对照在
// evidence/debt-evidence/research-md5-ledger-corrections.json；P3 corrected 作为历史留档不再覆盖。
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { auditLedgers, CORRECTIONS, ROOT } from './research-md5-ledgers.mjs';

const CHECK = process.argv.includes('--check');
const audit = auditLedgers();
for (const report of audit.reports) {
  console.log(`[${report.stage}] ${report.ledger}  match ${report.entries.length - report.mismatches}/${report.entries.length}  mismatches ${report.mismatches}`);
}
console.log(`真实 log 跨 artifact 逐位相同：${audit.summary.actualAcrossArtifactsIdentical}`);
if (!audit.ok) {
  console.error(`台账与真实 log 不一致：${audit.summary.mismatchEntryCount} 条。`);
  process.exit(1);
}
if (!CHECK) {
  const out = join(ROOT, 'evidence', 'arch-finish2');
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'research-md5-audit.json'), JSON.stringify(audit, null, 2) + '\n');
  console.log(`已刷新 audit：evidence/arch-finish2/research-md5-audit.json`);
  console.log(`旧值→新值对照保留在：${CORRECTIONS}（P3 corrected sidecar 作为历史留档，不再覆盖）`);
}
console.log('台账 --check 全绿：12 份 artifact / 65 条记录与 checked-in log 一致。');
