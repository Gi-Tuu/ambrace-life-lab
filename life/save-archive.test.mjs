// C4 闸门：归档/恢复端到端（真跑脚本），以及"正在被观看的营地不删"的接线已有 SA4 覆盖。
// 负向对照：把归档里复制 saves/ 那一行拆掉 ⇒ 恢复后文件缺失、本闸门变红。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const SCRIPT = join(ROOT, 'scripts', 'archive-saves.mjs');

function makeData() {
  const base = mkdtempSync(join(tmpdir(), 'arch-gate-'));
  const data = join(base, 'data');
  mkdirSync(join(data, 'saves'), { recursive: true });
  writeFileSync(join(data, 'world.json'), '{"A":"main"}');
  writeFileSync(join(data, 'saves', 'index.json'), '{"entries":[{"key":"k1","name":"阿禾"}]}');
  writeFileSync(join(data, 'saves', 'k1.json.gz'), 'gzip-bytes');
  return { base, data, out: join(base, 'out') };
}

test('A1 归档后清空再恢复：文件与内容逐字节一致', () => {
  const { data, out } = makeData();
  execFileSync(process.execPath, [SCRIPT, '--data', data, '--out', out], { encoding: 'utf8' });
  const before = {
    world: readFileSync(join(data, 'world.json'), 'utf8'),
    idx: readFileSync(join(data, 'saves', 'index.json'), 'utf8'),
    camp: readFileSync(join(data, 'saves', 'k1.json.gz'), 'utf8'),
  };
  rmSync(data, { recursive: true, force: true });
  execFileSync(process.execPath, [SCRIPT, 'restore', '--data', data, '--out', out], { encoding: 'utf8' });
  assert.equal(readFileSync(join(data, 'world.json'), 'utf8'), before.world);
  assert.equal(readFileSync(join(data, 'saves', 'index.json'), 'utf8'), before.idx);
  assert.equal(readFileSync(join(data, 'saves', 'k1.json.gz'), 'utf8'), before.camp, '营地档必须恢复（拆掉 saves 复制这行即红）');
});

test('A2 没有数据目录时归档必须明确失败，而不是生成空归档', () => {
  const base = mkdtempSync(join(tmpdir(), 'arch-empty-'));
  let code = 0;
  try {
    execFileSync(process.execPath, [SCRIPT, '--data', join(base, 'nope'), '--out', join(base, 'out')], { encoding: 'utf8', stdio: 'pipe' });
  } catch (e) { code = e.status ?? 1; }
  assert.equal(code, 2);
  assert.equal(existsSync(join(base, 'out')), false, '失败时不该留下归档目录');
});
