#!/usr/bin/env node
// 研究五面 md5 台账：12 份 artifact / 65 条记录的唯一复验与更正入口。
//
// 用法：
//   node scripts/research-md5-ledgers.mjs --check   # 只读：所有台账/记录必须与 checked-in log 逐字节一致
//   node scripts/research-md5-ledgers.mjs --write   # 按真实 log 更正原台账，并写 old→new 对照 sidecar
//
// 口径：
//   · md5 用 Node crypto 对文件字节直接算，不做换行/编码归一化；
//   · 原 log 一字不改；只改台账里抄错的数值/引用字段；
//   · “旧值→新值”完整保存在 evidence/debt-evidence/research-md5-ledger-corrections.json，
//     原台账被直接更正，但以后仍能审计“曾经错在哪”；
//   · 覆盖 9 份历史台账（50 条）+ debt-time/debt-map 两份新台账（10 条）+ score md5 清单（5 条）。
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const FACES = ['report', 'sweep', 'viab', 'recover', 'metab'];
export const CORRECTIONS = 'evidence/debt-evidence/research-md5-ledger-corrections.json';
const REPORT = 'evidence/debt-evidence/research-md5-ledger-report.json';
const CHECK = process.argv.includes('--check');
const WRITE = process.argv.includes('--write');

const md5 = (path) => createHash('md5').update(readFileSync(path)).digest('hex');
const bytes = (path) => readFileSync(path).length;
const rel = (path) => relative(ROOT, path).split('\\').join('/');
const abs = (path) => join(ROOT, path);
const readJson = (path) => JSON.parse(readFileSync(abs(path), 'utf8'));
const readText = (path) => readFileSync(abs(path), 'utf8');

// 每个 artifact 一行：logFor(face,label) 给出该记录对应的 checked-in log。
export const SPECS = [
  {
    stage: 'P0', ledger: 'evidence/redo-p0/baseline-md5.json', format: 'array-name',
    logFor: (face) => `evidence/redo-p0/baseline-${face}.log`,
  },
  {
    stage: 'P0', ledger: 'evidence/redo-p0/main-research-md5.json', format: 'p0-main',
    logFor: (face, label) => `evidence/redo-p0/main-${label === 'before' ? 'baseline' : 'after'}-${face}.log`,
  },
  {
    stage: 'P1', ledger: 'evidence/redo-p1/research-md5.json', format: 'array-name',
    logFor: (face) => `evidence/redo-p1/research/${face}.log`,
  },
  {
    stage: 'P1b', ledger: 'evidence/redo-p1b/research-md5.json', format: 'array-name',
    logFor: (face) => `evidence/redo-p1b/research/${face}.log`,
  },
  {
    stage: 'P2', ledger: 'evidence/redo-p2/research-md5.json', format: 'object-md5',
    logFor: (face) => `evidence/redo-p2/research/${face}.log`,
  },
  {
    stage: 'P2b', ledger: 'evidence/redo-p2b/research-md5.json', format: 'object-string',
    logFor: (face) => `evidence/redo-p2b/research/${face}.log`,
  },
  {
    stage: 'P2c', ledger: 'evidence/redo-p2c/research-md5.json', format: 'object-md5',
    logFor: (face) => `evidence/redo-p2c/research/${face}.log`,
  },
  {
    stage: 'P3', ledger: 'evidence/redo-p3/research-md5.json', format: 'object-md5',
    logFor: (face) => `evidence/redo-p3/research/${face}.log`,
  },
  {
    stage: 'arch-gates', ledger: 'evidence/arch-gates/research-md5.json', format: 'object-md5',
    logFor: (face) => `evidence/arch-gates/research/${face}.log`,
  },
  {
    stage: 'debt-time', ledger: 'evidence/debt-time/research-md5.json', format: 'debt-faces',
    logFor: (face) => `evidence/debt-time/research/${face}.log`,
  },
  {
    stage: 'debt-map', ledger: 'evidence/debt-map/research-md5.json', format: 'debt-faces',
    logFor: (face) => `evidence/debt-map/research/${face}.log`,
  },
  {
    stage: 'score', ledger: 'evidence/score/research-md5.txt', format: 'score-txt',
    logFor: (face) => `evidence/score/baseline-surfaces/${face}.log`,
  },
];

const isMeta = (key) => key.startsWith('_');

function actualFor(spec, face, label) {
  const log = spec.logFor(face, label);
  const path = abs(log);
  if (!existsSync(path)) return { log, missing: true };
  return { log, md5: md5(path), bytes: bytes(path) };
}

// 把不同历史格式统一成 [{face,label,md5,bytes,refMd5,refBytes,same}]。
function entriesFor(spec, data) {
  if (spec.format === 'score-txt') {
    return String(data).split(/\r?\n/).filter(Boolean).map((line) => {
      const m = /^([0-9a-f]{32})\s+(.+)$/.exec(line);
      if (!m) throw new Error(`${spec.ledger} 行格式无法解析：${line}`);
      const log = m[2].trim();
      return { face: basename(log).replace(/\.log$/, ''), label: 'current', md5: m[1], bytes: null,
        refMd5: {}, refBytes: {}, same: undefined, line, log };
    });
  }
  if (spec.format === 'array-name') {
    return data.map((row) => {
      const face = String(row.name ?? '').replace(/\.log$/, '');
      return {
        face, label: 'current', md5: row.md5, bytes: row.bytes,
        refMd5: Object.hasOwn(row, 'expected') ? { expected: row.expected } : {},
        refBytes: {}, same: row.same,
      };
    });
  }
  if (spec.format === 'p0-main') {
    return data.flatMap((row) => ['before', 'after'].map((label) => ({
      face: row.face, label, md5: row[label],
      bytes: null, refMd5: {}, refBytes: {}, same: row.same,
    })));
  }
  if (spec.format === 'object-string') {
    return Object.entries(data).filter(([face]) => !isMeta(face))
      .map(([face, value]) => ({ face, label: 'current', md5: value, bytes: null, refMd5: {}, refBytes: {}, same: undefined }));
  }
  if (spec.format === 'object-md5') {
    return Object.entries(data).filter(([face]) => !isMeta(face)).map(([face, row]) => ({
      face, label: 'current',
      md5: typeof row === 'string' ? row : row.md5,
      bytes: typeof row === 'string' ? null : row.bytes,
      refMd5: Object.fromEntries(['baseline', 'p2b', 'p2c', 'p3_log']
        .filter((key) => typeof row !== 'string' && Object.hasOwn(row, key)).map((key) => [key, row[key]])),
      refBytes: {}, same: typeof row === 'string' ? undefined : row.same,
    }));
  }
  if (spec.format === 'debt-faces') {
    return Object.entries(data.faces ?? {}).filter(([face]) => !isMeta(face)).map(([face, row]) => ({
      face, label: 'current', md5: row.md5, bytes: row.bytes,
      refMd5: Object.hasOwn(row, 'expectedMd5') ? { expectedMd5: row.expectedMd5 } : {},
      refBytes: Object.hasOwn(row, 'expectedBytes') ? { expectedBytes: row.expectedBytes } : {},
      same: row.match,
    }));
  }
  throw new Error('未知台账格式：' + spec.format);
}

function actualByKey(spec, entries) {
  const out = new Map();
  for (const e of entries) out.set(`${e.face}|${e.label}`, actualFor(spec, e.face, e.label));
  return out;
}

function auditEntry(entry, actual) {
  const refMd5 = Object.entries(entry.refMd5).filter(([, value]) => value !== actual.md5).map(([key]) => key);
  const refBytes = Object.entries(entry.refBytes).filter(([, value]) => value !== actual.bytes).map(([key]) => key);
  const bytesMatch = entry.bytes == null || entry.bytes === actual.bytes;
  const sameMatch = entry.same === undefined || entry.same === true;
  return {
    face: entry.face, label: entry.label, log: actual.log,
    recorded: {
      md5: entry.md5,
      ...(entry.bytes == null ? {} : { bytes: entry.bytes }),
      ...(Object.keys(entry.refMd5).length ? { refMd5: entry.refMd5 } : {}),
      ...(Object.keys(entry.refBytes).length ? { refBytes: entry.refBytes } : {}),
      ...(entry.same === undefined ? {} : { same: entry.same }),
    },
    actual: { md5: actual.md5, bytes: actual.bytes },
    md5Match: entry.md5 === actual.md5,
    bytesMatch,
    refMd5Match: refMd5.length === 0,
    refBytesMatch: refBytes.length === 0,
    sameMatch,
    match: entry.md5 === actual.md5 && bytesMatch && refMd5.length === 0 && refBytes.length === 0 && sameMatch,
    mismatchedRefs: [...refMd5, ...refBytes],
  };
}

function correctedEntry(spec, entry, actual) {
  // 返回该行更正后的对象；数组/对象各自的 schema 保持不变，只改数值与引用。
  if (spec.format === 'score-txt') return { line: `${actual.md5}  ${entry.log}` };
  const { md5: actualMd5, bytes: actualBytes } = actual;
  if (spec.format === 'array-name') {
    const row = { name: entry.face + '.log', bytes: actualBytes, md5: actualMd5 };
    if (entry.refMd5.expected !== undefined) row.expected = actualMd5;
    if (entry.same !== undefined) row.same = true;
    return row;
  }
  if (spec.format === 'p0-main') return entry.label === 'before' ? { before: actualMd5 } : { after: actualMd5 };
  if (spec.format === 'object-string') return actualMd5;
  if (spec.format === 'debt-faces') return {
    ...(entry.bytes == null ? {} : { bytes: actualBytes }),
    ...(entry.refBytes.expectedBytes !== undefined ? { expectedBytes: actualBytes } : {}),
    md5: actualMd5,
    ...(entry.refMd5.expectedMd5 !== undefined ? { expectedMd5: actualMd5 } : {}),
    ...(entry.same !== undefined ? { match: true } : {}),
  };
  if (spec.format === 'object-md5') return {
    md5: actualMd5,
    ...(entry.bytes == null ? {} : { bytes: actualBytes }),
    ...Object.fromEntries(Object.keys(entry.refMd5).map((key) => [key, actualMd5])),
    ...(entry.same !== undefined ? { same: true } : {}),
  };
  throw new Error('未知台账格式：' + spec.format);
}

function mergeEntry(spec, data, index, entry, corrected) {
  // score 在写回阶段单独处理；这里只做 JSON schema 的定点替换，尽量保持字段顺序。
  if (spec.format === 'array-name') {
    const row = data[index];
    row.md5 = corrected.md5; row.bytes = corrected.bytes;
    if (Object.hasOwn(corrected, 'expected')) row.expected = corrected.expected;
    if (Object.hasOwn(corrected, 'same')) row.same = corrected.same;
    return;
  }
  if (spec.format === 'p0-main') {
    data[index][entry.label] = corrected[entry.label];
    if (entry.same !== undefined) data[index].same = true;
    return;
  }
  if (spec.format === 'object-string') { data[entry.face] = corrected; return; }
  if (spec.format === 'object-md5') {
    const row = data[entry.face];
    if (typeof row === 'string') { data[entry.face] = corrected.md5; return; }
    row.md5 = corrected.md5;
    if (Object.hasOwn(corrected, 'bytes')) row.bytes = corrected.bytes;
    for (const key of Object.keys(entry.refMd5)) row[key] = corrected[key];
    if (Object.hasOwn(corrected, 'same')) row.same = corrected.same;
    return;
  }
  if (spec.format === 'debt-faces') {
    const row = data.faces[entry.face];
    row.md5 = corrected.md5;
    if (Object.hasOwn(corrected, 'bytes')) row.bytes = corrected.bytes;
    if (Object.hasOwn(corrected, 'expectedMd5')) row.expectedMd5 = corrected.expectedMd5;
    if (Object.hasOwn(corrected, 'expectedBytes')) row.expectedBytes = corrected.expectedBytes;
    if (Object.hasOwn(corrected, 'match')) row.match = corrected.match;
    return;
  }
  throw new Error('未知台账格式：' + spec.format);
}

function writeLedger(spec, data) {
  if (spec.format === 'score-txt') {
    writeFileSync(abs(spec.ledger), data.map((line) => line + '\n').join(''));
  } else {
    writeFileSync(abs(spec.ledger), JSON.stringify(data, null, 2) + '\n');
  }
}

export function auditLedgers() {
  const reports = SPECS.map((spec) => {
    const data = spec.format === 'score-txt' ? readText(spec.ledger) : readJson(spec.ledger);
    const entries = entriesFor(spec, data);
    const actuals = actualByKey(spec, entries);
    const rows = entries.map((entry) => {
      const actual = actuals.get(`${entry.face}|${entry.label}`);
      return actual.missing
        ? { face: entry.face, label: entry.label, log: actual.log, missing: true, match: false }
        : auditEntry(entry, actual);
    });
    return {
      stage: spec.stage,
      ledger: spec.ledger,
      format: spec.format,
      entries: rows,
      mismatches: rows.filter((row) => !row.match).length,
      missingLogs: rows.filter((row) => row.missing).length,
    };
  });

  const allRows = reports.flatMap((report) => report.entries.map((entry) => ({ ...entry, ledger: report.ledger, stage: report.stage })));
  const hashesByFace = Object.fromEntries(FACES.map((face) => {
    const hashes = [...new Set(allRows.filter((row) => row.face === face && !row.missing).map((row) => row.actual.md5))];
    return [face, hashes];
  }));
  const actualAcrossArtifactsIdentical = FACES.every((face) => hashesByFace[face].length === 1);
  const mismatchEntryCount = allRows.filter((row) => !row.match).length;
  return {
    ok: mismatchEntryCount === 0 && actualAcrossArtifactsIdentical,
    reports,
    summary: {
      artifactCount: reports.length,
      entryCount: allRows.length,
      mismatchEntryCount,
      missingLogCount: allRows.filter((row) => row.missing).length,
      actualAcrossArtifactsIdentical,
      hashesByFace,
      changedEntryCount: allRows.filter((row) => !row.missing && row.recorded.md5 !== row.actual.md5).length,
    },
    rows: allRows,
  };
}

function fullActual(entry) {
  const actual = { md5: entry.actual.md5, bytes: entry.actual.bytes };
  for (const key of Object.keys(entry.recorded.refMd5 ?? {})) actual[key] = entry.actual.md5;
  for (const key of Object.keys(entry.recorded.refBytes ?? {})) actual[key] = entry.actual.bytes;
  if (entry.recorded.same !== undefined) actual.same = true;
  return actual;
}

function correctionsOf(audit) {
  // 若已有对照 sidecar：保留它的 old（真正的更正前值），只刷新 new/核对结果。
  // 这样重复跑 --write 不会把“曾经错在哪”覆盖成 0 条。
  let prior = new Map();
  const priorPath = abs(CORRECTIONS);
  if (existsSync(priorPath)) {
    try {
      const old = JSON.parse(readFileSync(priorPath, 'utf8'));
      for (const ledger of old.ledgers ?? []) {
        for (const entry of ledger.entries ?? []) {
          prior.set(`${ledger.ledger}|${entry.face}|${entry.label}`, entry);
        }
      }
    } catch { prior = new Map(); }
  }
  const ledgers = audit.reports.map((report) => ({
    stage: report.stage,
    ledger: report.ledger,
    entries: report.entries.map((entry) => {
      const key = `${report.ledger}|${entry.face}|${entry.label}`;
      const before = prior.get(key);
      const old = before?.old && typeof before.old === 'object' ? before.old : entry.recorded;
      const changed = !entry.missing && old.md5 !== entry.actual.md5;
      return {
        face: entry.face,
        label: entry.label,
        log: entry.log,
        changed,
        old: entry.missing ? null : old,
        new: entry.missing ? null : fullActual(entry),
      };
    }),
  }));
  const entries = ledgers.flatMap((ledger) => ledger.entries);
  return {
    _说明: '研究五面 md5 台账更正对照（旧值→真实 log 字节值）。原 log 未改；原台账已按本表直接更正。重复运行 --write 会保留本表 old。',
    generatedAt: new Date().toISOString(),
    algorithm: 'md5 (raw file bytes)',
    ledgers,
    summary: {
      artifactCount: audit.summary.artifactCount,
      entryCount: audit.summary.entryCount,
      changedEntryCount: entries.filter((entry) => entry.changed).length,
      mismatchEntryCountBeforeCorrection: entries.filter((entry) => entry.changed).length,
    },
  };
}

function writeCorrections(audit) {
  const path = abs(CORRECTIONS);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(correctionsOf(audit), null, 2) + '\n');
}

function applyCorrections(audit) {
  // 逐份文件重新读取、按 audit 的真实值定点替换；写完再整体复验。
  for (const spec of SPECS) {
    const report = audit.reports.find((item) => item.ledger === spec.ledger);
    if (!report || report.mismatches === 0) continue;
    if (spec.format === 'score-txt') {
      const lines = readText(spec.ledger).split(/\r?\n/).filter(Boolean);
      const fixed = lines.map((line) => {
        const old = /^([0-9a-f]{32})\s+(.+)$/.exec(line);
        if (!old) throw new Error(`${spec.ledger} 行格式无法解析：${line}`);
        const face = basename(old[2].trim()).replace(/\.log$/, '');
        const actual = actualFor(spec, face, 'current');
        return `${actual.md5}  ${old[2].trim()}`;
      });
      writeFileSync(abs(spec.ledger), fixed.map((line) => line + '\n').join(''));
      continue;
    }
    const data = readJson(spec.ledger);
    const entries = entriesFor(spec, data);
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      const actual = actualFor(spec, entry.face, entry.label);
      if (actual.missing) continue;
      if (entry.md5 === actual.md5 &&
          (entry.bytes == null || entry.bytes === actual.bytes) &&
          Object.values(entry.refMd5).every((value) => value === actual.md5) &&
          Object.values(entry.refBytes).every((value) => value === actual.bytes) &&
          (entry.same === undefined || entry.same === true)) continue;
      const corrected = correctedEntry(spec, entry, actual);
      if (spec.format === 'p0-main') {
        // p0-main 一行含 before/after 两条记录：先全部算完再合并，避免 index/字段错位。
        continue;
      }
      mergeEntry(spec, data, i, entry, corrected);
    }
    if (spec.format === 'p0-main') {
      for (const row of data) {
        const before = actualFor(spec, row.face, 'before');
        const after = actualFor(spec, row.face, 'after');
        if (!before.missing) row.before = before.md5;
        if (!after.missing) row.after = after.md5;
        if (Object.hasOwn(row, 'same')) row.same = true;
      }
    }
    writeLedger(spec, data);
  }
  const after = auditLedgers();
  const path = abs(REPORT);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(after, null, 2) + '\n');
  return after;
}

function printAudit(audit, label) {
  console.log(`${label}：${audit.summary.artifactCount} 份 artifact / ${audit.summary.entryCount} 条记录；不一致 ${audit.summary.mismatchEntryCount} 条；真实 log 跨 artifact 逐位相同 ${audit.summary.actualAcrossArtifactsIdentical}`);
  for (const report of audit.reports) {
    console.log(`[${report.stage}] ${report.ledger}  match ${report.entries.length - report.mismatches}/${report.entries.length}  mismatches ${report.mismatches}`);
  }
  for (const [face, hashes] of Object.entries(audit.summary.hashesByFace)) {
    console.log(`  ${face}: ${hashes.join(' / ') || 'missing'}`);
  }
}

function main() {
  if (!CHECK && !WRITE) {
    console.error('用法：node scripts/research-md5-ledgers.mjs --check | --write');
    process.exit(2);
  }
  if (CHECK) {
    const audit = auditLedgers();
    printAudit(audit, '台账复验');
    if (!audit.ok) {
      console.error('台账与真实 log 不一致：先跑 --write 更正，不要手改 log。');
      process.exit(1);
    }
    console.log('台账 --check 全绿：所有记录与 checked-in log 一致，原 log 未改动。');
    return;
  }
  const before = auditLedgers();
  printAudit(before, '更正前');
  writeCorrections(before);
  const after = applyCorrections(before);
  printAudit(after, '更正后');
  console.log(`已写：${CORRECTIONS} / ${REPORT}`);
  if (!after.ok) {
    console.error('更正后仍不一致，拒绝声明成功。');
    process.exit(1);
  }
  const corrected = JSON.parse(readFileSync(abs(CORRECTIONS), 'utf8'));
  console.log(`更正完成：${corrected.summary.changedEntryCount} 条旧值→真实值（sidecar 保留）；原 log 未改动。`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
