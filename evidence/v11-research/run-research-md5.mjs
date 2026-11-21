// 1.1 第 6 项（P2-6 收口）：研究五面 md5 闸门。
//
// 口径：
//   · 默认 `--check`（或不带参数）= 真跑 `life/run.mjs` 五面 → CRLF 归一 → 与 P3 更正台账逐位比较。
//     代码漂移但历史 log 没更新时，这里必须红；不能用落盘 log 冒充重跑结果。
//   · `--rerun` 同上（CI/本地闸门显式用这个模式，避免读者误以为只读台账）。
//   · `--log` 只对 checked-in `research/<face>.log` 取 md5，作为诊断/历史对照；
//     它不参与默认通过，不能作为“五面真实 md5”的证据。
//
// 用法：
//   node evidence/v11-research/run-research-md5.mjs --check   # 默认真跑
//   node evidence/v11-research/run-research-md5.mjs --rerun   # CI/闸门模式（真跑）
//   node evidence/v11-research/run-research-md5.mjs --log     # 只 hash 历史 log（诊断）
//
// 输出：evidence/v11-research/research-md5.json（mode 字段写明本次是 rerun 还是 log）。
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(ROOT, 'evidence', 'v11-research');
const FACES = ['report', 'sweep', 'viab', 'recover', 'metab'];
const md5 = (buffer) => createHash('md5').update(buffer).digest('hex');
const expected = JSON.parse(readFileSync(join(ROOT, 'evidence', 'redo-p3', 'research-md5.corrected.json'), 'utf8'));

const args = new Set(process.argv.slice(2));
const MODE = args.has('--log') ? 'log' : args.has('--rerun') ? 'rerun' : 'check';
if (args.has('--log') && args.has('--rerun')) {
  console.error('✖ --log 与 --rerun 不能同时使用：--log 只用于诊断历史 log。');
  process.exit(2);
}
// 默认 --check 也必须真跑；只有显式 --log 才读历史文件。
const RUN = MODE !== 'log';

// 历史 log 由 PowerShell 重定向写成 LF；P3 台账是 CRLF 字节口径，这里按 CRLF 归一后取 md5。
// stdout 同理：Node 在 Windows/Linux 都按 LF 输出，统一归一到 CRLF 再与台账比。
const toCrlf = (text) => text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');

function runFace(face) {
  const started = process.hrtime.bigint();
  const r = spawnSync(process.execPath, ['life/run.mjs', `--${face}`], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  });
  const durationMs = Number((process.hrtime.bigint() - started) / 1_000_000n);
  if (r.status !== 0) {
    const tail = String(r.stderr ?? '').trim().split('\n').slice(-8).join('\n');
    throw new Error(`life/run.mjs --${face} 退出码 ${r.status ?? 'null'}${tail ? `：\n${tail}` : ''}`);
  }
  if (r.error) throw new Error(`life/run.mjs --${face} 启动失败：${r.error.message}`);
  return { stdout: String(r.stdout ?? ''), durationMs };
}

const faces = {};
let bad = 0;
const startedAt = Date.now();
for (const face of FACES) {
  const want = expected.faces[face];
  let raw;
  let durationMs = null;
  let source;
  if (RUN) {
    const run = runFace(face);
    raw = Buffer.from(run.stdout, 'utf8');
    durationMs = run.durationMs;
    source = `life/run.mjs --${face}`;
  } else {
    raw = readFileSync(join(OUT, 'research', `${face}.log`));
    source = `evidence/v11-research/research/${face}.log`;
  }
  const crlf = Buffer.from(toCrlf(raw.toString('utf8')), 'utf8');
  const actual = {
    source, durationMs,
    rawBytes: raw.length, rawMd5: md5(raw),
    crlfBytes: crlf.length, crlfMd5: md5(crlf),
    expectedMd5: want.md5, expectedBytes: want.bytes,
  };
  actual.match = actual.crlfMd5 === want.md5 && actual.crlfBytes === want.bytes;
  if (!actual.match) bad += 1;
  faces[face] = actual;
  console.log(`[${face}] ${actual.crlfMd5} ${actual.crlfBytes}B · expected ${want.md5} · ${actual.match ? 'match' : 'MISMATCH'}${durationMs == null ? '' : ` · ${durationMs}ms`}`);
}
const totalMs = Date.now() - startedAt;
const result = {
  algorithm: 'md5',
  mode: RUN ? 'rerun' : 'log',
  note: RUN
    ? '默认/--rerun 模式真跑 life/run.mjs 五面；历史 log 不参与通过。'
    : '仅诊断：--log 只 hash checked-in log，不能作为五面真实 md5 的证据。',
  generatedAt: new Date().toISOString(),
  durationMs: totalMs,
  faces,
  allMatch: bad === 0,
};
writeFileSync(join(OUT, 'research-md5.json'), JSON.stringify(result, null, 2) + '\n');
console.log(`研究五面 md5（${result.mode}）与 P3 台账逐位相同：${result.allMatch} · 总耗时 ${totalMs}ms`);
if (!result.allMatch) process.exitCode = 1;
if (MODE === 'log') {
  console.error('⚠ --log 是诊断模式：CI/闸门请使用 --rerun（默认真跑也会执行 rerun，但请显式写清）。');
}
