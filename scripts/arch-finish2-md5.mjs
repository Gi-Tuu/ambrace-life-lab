#!/usr/bin/env node
// arch-finish2：研究五面 md5 台账审计 + P3 更正台账（只算实际 log，不改历史日志）。
//
// 用法：
//   node scripts/arch-finish2-md5.mjs          # 重算并写 evidence/arch-finish2/research-md5-audit.json
//                                              # 与 evidence/redo-p3/research-md5.corrected.json
//   node scripts/arch-finish2-md5.mjs --check  # 只校验更正台账与磁盘 log 一致；不一致退出 1
//
// 口径：
//   · md5 用 Node crypto，按字节算，不做换行/编码归一化；
//   · 只读 evidence/**/research/*.log 与既有台账，不写回旧台账；
//   · 旧值原样保留在 audit 里，用于证明“原来记的是什么”。
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'evidence', 'arch-finish2');
const P3_CORRECTED = join(ROOT, 'evidence', 'redo-p3', 'research-md5.corrected.json');
const FACES = ['report', 'sweep', 'viab', 'recover', 'metab'];
const CHECK = process.argv.includes('--check');

const md5 = (path) => createHash('md5').update(readFileSync(path)).digest('hex');
const bytes = (path) => readFileSync(path).length;
const rel = (path) => relative(ROOT, path).split('\\').join('/');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

// 每个台账：logFor 给某张脸的日志路径；parse 把不同历史格式统一成 [{face,label,md5,bytes}]。
const SPECS = [
  {
    stage: 'P0', ledger: 'evidence/redo-p0/baseline-md5.json', format: 'array-name',
    logFor: (face) => `evidence/redo-p0/baseline-${face}.log`,
  },
  {
    stage: 'P0', ledger: 'evidence/redo-p0/main-research-md5.json', format: 'p0-main',
    logFor: (face) => `evidence/redo-p0/main-after-${face}.log`,
    beforeLogFor: (face) => `evidence/redo-p0/main-baseline-${face}.log`,
  },
  { stage: 'P1', ledger: 'evidence/redo-p1/research-md5.json', format: 'array-name',
    logFor: (face) => `evidence/redo-p1/research/${face}.log` },
  { stage: 'P1b', ledger: 'evidence/redo-p1b/research-md5.json', format: 'array-name',
    logFor: (face) => `evidence/redo-p1b/research/${face}.log` },
  { stage: 'P2', ledger: 'evidence/redo-p2/research-md5.json', format: 'object-md5',
    logFor: (face) => `evidence/redo-p2/research/${face}.log` },
  { stage: 'P2b', ledger: 'evidence/redo-p2b/research-md5.json', format: 'object-string',
    logFor: (face) => `evidence/redo-p2b/research/${face}.log` },
  { stage: 'P2c', ledger: 'evidence/redo-p2c/research-md5.json', format: 'object-md5',
    logFor: (face) => `evidence/redo-p2c/research/${face}.log` },
  { stage: 'P3', ledger: 'evidence/redo-p3/research-md5.json', format: 'object-md5',
    logFor: (face) => `evidence/redo-p3/research/${face}.log` },
  { stage: 'arch-gates', ledger: 'evidence/arch-gates/research-md5.json', format: 'object-md5',
    logFor: (face) => `evidence/arch-gates/research/${face}.log` },
];

function parseLedger(spec) {
  const path = join(ROOT, spec.ledger);
  const data = readJson(path);
  if (spec.format === 'array-name') {
    return data.map((row) => ({
      face: String(row.name ?? '').replace(/\.log$/, ''),
      label: 'current', md5: row.md5, bytes: row.bytes,
    }));
  }
  if (spec.format === 'object-md5') {
    return Object.entries(data).map(([face, row]) => ({
      face, label: 'current', md5: typeof row === 'string' ? row : row.md5, bytes: row.bytes,
    }));
  }
  if (spec.format === 'object-string') {
    return Object.entries(data).map(([face, value]) => ({
      face, label: 'current', md5: value,
    }));
  }
  if (spec.format === 'p0-main') {
    return data.flatMap((row) => [
      { face: row.face, label: 'before', md5: row.before },
      { face: row.face, label: 'after', md5: row.after },
    ]);
  }
  throw new Error('未知台账格式：' + spec.format);
}

function actualFor(spec, face, label) {
  const logRel = spec.format === 'p0-main' && label === 'before'
    ? spec.beforeLogFor(face)
    : spec.logFor(face);
  const abs = join(ROOT, logRel);
  if (!existsSync(abs)) return { log: logRel, missing: true };
  return { log: logRel, bytes: bytes(abs), md5: md5(abs) };
}

function buildAudit() {
  const ledgers = SPECS.map((spec) => {
    const entries = parseLedger(spec).map((row) => {
      const actual = actualFor(spec, row.face, row.label);
      const match = !actual.missing && actual.md5 === row.md5;
      const bytesMatch = actual.missing || row.bytes == null || row.bytes === actual.bytes;
      return {
        face: row.face, label: row.label,
        recorded: { md5: row.md5, ...(row.bytes == null ? {} : { bytes: row.bytes }) },
        actual,
        match, bytesMatch,
      };
    });
    return {
      stage: spec.stage,
      ledger: spec.ledger,
      entries,
      mismatches: entries.filter((e) => !e.match).length,
      missingLogs: entries.filter((e) => e.actual.missing).length,
    };
  });

  // 实际 log 的跨阶段一致性：同一张脸在所有 checked-in 研究 log 里是否逐位相同。
  const actualHashesByFace = {};
  for (const face of FACES) {
    const seen = new Map();
    for (const spec of SPECS) {
      const labels = spec.format === 'p0-main' ? ['before', 'after'] : ['current'];
      for (const label of labels) {
        const actual = actualFor(spec, face, label);
        if (actual.missing) continue;
        const key = actual.md5;
        if (!seen.has(key)) seen.set(key, []);
        seen.get(key).push(`${spec.stage}/${actual.log}`);
      }
    }
    actualHashesByFace[face] = [...seen.entries()].map(([hash, logs]) => ({ md5: hash, logs }));
  }
  const actualAcrossStagesIdentical = FACES.every((face) => actualHashesByFace[face].length === 1);

  const allMismatchEntries = ledgers.flatMap((l) => l.entries.filter((e) => !e.match)
    .map((e) => ({ stage: l.stage, ledger: l.ledger, ...e })));
  const staleHashes = [...new Set(allMismatchEntries.map((e) => e.recorded.md5))].sort();

  // 旧值是否还能在仓库里找到一份真实 log 佐证（扫 evidence 下所有 .log 文件；只读）。
  const evidenceLogs = [];
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.endsWith('.log')) evidenceLogs.push(p);
    }
  };
  walk(join(ROOT, 'evidence'));
  const staleAttested = [];
  for (const hash of staleHashes) {
    const hits = evidenceLogs.filter((p) => md5(p) === hash).map(rel);
    staleAttested.push({ md5: hash, logHits: hits });
  }

  const ledgersAllMatch = ledgers.filter((l) => l.mismatches === 0).map((l) => l.ledger);
  const ledgersWithMismatch = ledgers.filter((l) => l.mismatches > 0).map((l) => l.ledger);
  return {
    _说明: '研究五面 md5：既有台账记录值 vs evidence 下实际 log 重算值。只读旧台账，不改历史日志。',
    generatedAt: new Date().toISOString(),
    algorithm: 'md5',
    faces: FACES,
    ledgers,
    summary: {
      ledgerCount: ledgers.length,
      entryCount: ledgers.reduce((n, l) => n + l.entries.length, 0),
      mismatchEntryCount: allMismatchEntries.length,
      ledgersAllMatch,
      ledgersWithMismatch,
      stagesWithMismatch: [...new Set(ledgers.filter((l) => l.mismatches > 0).map((l) => l.stage))],
      actualAcrossStagesIdentical,
      actualHashesByFace,
      staleHashes,
      staleHashesAttestedByAnyCheckedInLog: staleAttested.filter((s) => s.logHits.length > 0),
      checkedLogCount: evidenceLogs.length,
    },
    findings: [
      'P3 原 research-md5.json 的 5 个 md5 与同目录 research/*.log 全部不符；同目录真实值是 de7644…/aadd48…/b92378…/fe1981…/5ea0ae…。',
      'P1、P1b、P2、P2b、P2c、P3 的 research-md5.json 记录的是同一组旧值，与各自 research/*.log 全部不符；共 6 个台账、30 条记录不一致。',
      'P0 有两份：baseline-md5.json 记旧值、与 baseline-*.log 不符；main-research-md5.json 记 de7644… 等真实值、与 main-baseline/main-after log 相符。',
      '所有 checked-in 研究 log（P0 的 baseline/main、P1…P3、arch-gates）在当前磁盘上五面逐位相同；“没有漂移”的结论仍成立，错的只是台账抄的数值。',
      '旧值在仓库内没有任何一份 .log 能佐证；它们只出现在台账/baseline-md5.json 自身，属于被复制转抄的历史数字。',
      '不批量改历史台账；只新增 P3 更正台账 evidence/redo-p3/research-md5.corrected.json，并在 docs/回报-P3-2026-11-20.md 追加“更正”段。',
    ],
  };
}

function buildP3Corrected(audit) {
  const p3 = audit.ledgers.find((l) => l.stage === 'P3');
  const arch = audit.ledgers.find((l) => l.stage === 'arch-gates');
  const faces = {};
  for (const face of FACES) {
    const row = p3.entries.find((e) => e.face === face);
    const archRow = arch.entries.find((e) => e.face === face);
    faces[face] = {
      log: row.actual.log,
      bytes: row.actual.bytes,
      md5: row.actual.md5,
      recordedInOriginal: row.recorded.md5,
      recordedMatch: row.match,
      archGatesMd5: archRow.actual.md5,
      archGatesMatch: archRow.actual.md5 === row.actual.md5,
    };
  }
  const values = Object.values(faces);
  return {
    _说明: 'P3 研究五面 md5 更正台账：用 evidence/redo-p3/research/*.log 实际字节重算。原 research-md5.json 保留不改，作为“当时记错”的证据。',
    supersedes: 'evidence/redo-p3/research-md5.json（只更正数值与 same 的依据，不删原文件）',
    generatedAt: audit.generatedAt,
    algorithm: 'md5',
    logDir: 'evidence/redo-p3/research',
    faces,
    allFiveCorrected: values.every((v) => v.recordedMatch === false && v.archGatesMatch === true),
    note: '原台账 md5 是旧 P0/P2b 值（19a280…/22f76c…/86da5c…/feac23…/e0a23d…），且 same:true 是旧值之间自比；真实值见 faces.*.md5。',
  };
}

function check() {
  if (!existsSync(P3_CORRECTED)) {
    console.error('缺更正台账：' + rel(P3_CORRECTED));
    process.exit(1);
  }
  const corrected = readJson(P3_CORRECTED);
  let bad = 0;
  for (const face of FACES) {
    const want = corrected.faces?.[face];
    const abs = join(ROOT, 'evidence', 'redo-p3', 'research', `${face}.log`);
    const got = existsSync(abs) ? md5(abs) : null;
    if (!want || want.md5 !== got || want.bytes !== bytes(abs)) {
      bad += 1;
      console.error(`[FAIL] ${face}:台账 ${want?.md5}/${want?.bytes}，实际 ${got}/${existsSync(abs) ? bytes(abs) : 'missing'}`);
    } else {
      console.log(`[ok] ${face} ${got}`);
    }
  }
  if (bad) {
    console.error(`更正台账与实际 log 不一致：${bad}/5`);
    process.exit(1);
  }
  console.log('更正台账 5/5 与真实 log 一致');
}

if (CHECK) {
  check();
} else {
  mkdirSync(OUT, { recursive: true });
  const audit = buildAudit();
  const corrected = buildP3Corrected(audit);
  writeFileSync(join(OUT, 'research-md5-audit.json'), JSON.stringify(audit, null, 2) + '\n');
  writeFileSync(P3_CORRECTED, JSON.stringify(corrected, null, 2) + '\n');
  console.log(`台账 ${audit.summary.ledgerCount} 份 / 记录 ${audit.summary.entryCount} 条；不一致 ${audit.summary.mismatchEntryCount} 条`);
  for (const l of audit.ledgers) {
    console.log(`[${l.stage}] ${l.ledger}  match ${l.entries.length - l.mismatches}/${l.entries.length}  mismatches ${l.mismatches}`);
  }
  console.log(`实际 log 跨阶段五面逐位相同：${audit.summary.actualAcrossStagesIdentical}`);
  console.log(`旧值被仓库内任何 log 佐证：${audit.summary.staleHashesAttestedByAnyCheckedInLog.length > 0}`);
  console.log('已写：' + rel(join(OUT, 'research-md5-audit.json')) + ' / ' + rel(P3_CORRECTED));
}
