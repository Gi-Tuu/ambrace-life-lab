#!/usr/bin/env node
// P2 金样对比：只比较“与位置无关/必须逐位相同”的稳定字段。
// 用法：node scripts/p2-golden-compare.mjs <baselineLabel> <label...>
//   node scripts/p2-golden-compare.mjs main-after p2 p2b
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'evidence', 'redo-p2');
mkdirSync(OUT, { recursive: true });
const [baselineLabel, ...labels] = process.argv.slice(2);
if (!baselineLabel || !labels.length) throw new Error('用法：node scripts/p2-golden-compare.mjs main-after p2 p2b');
const load = (label) => JSON.parse(readFileSync(join(ROOT, 'evidence', 'redo-p0', label + '.json'), 'utf8'));

function stable(g) {
  const out = {};
  const worlds = g.scenarios?.survival?.worlds?.runs ?? [];
  for (const run of worlds) {
    for (const k of ['walk', 'movementWalk', 'terrainWalk3d', 'assetWalk', 'trees', 'bridges', 'blockers', 'scene3d', 'counts']) {
      out[`survival.${run.mapSeed}.${k}`] = JSON.stringify(run[k]);
    }
  }
  const add = (key, value) => { out[key] = value == null ? null : JSON.stringify(value); };
  add('survival.rendererA', g.scenarios?.survival?.rendererA);
  add('survival.canvasSha', g.scenarios?.survival?.canvasSha);
  add('compare.rendererA', g.scenarios?.compare?.rendererA);
  add('compare.rendererB', g.scenarios?.compare?.rendererB);
  add('compare.canvasShaA', g.scenarios?.compare?.canvasShaA);
  add('compare.canvasShaB', g.scenarios?.compare?.canvasShaB);
  add('title.rendererTitle', g.scenarios?.title?.rendererTitle);
  add('title.canvasSha', g.scenarios?.title?.canvasSha);
  add('title.menuDisabled', g.scenarios?.title?.menuDisabled);
  return out;
}

const base = stable(load(baselineLabel));
const results = [];
for (const label of labels) {
  const cur = stable(load(label));
  const diffs = [];
  for (const key of Object.keys(base)) {
    if (base[key] !== cur[key]) diffs.push({ key, baseline: base[key], current: cur[key] });
  }
  const result = { against: `evidence/redo-p0/${baselineLabel}.json`, label, same: Object.keys(base).length - diffs.length, total: Object.keys(base).length, diffs };
  results.push(result);
  console.log(JSON.stringify(result));
}
writeFileSync(join(OUT, 'golden-compare.json'), JSON.stringify(results, null, 2) + '\n');
process.exitCode = results.some((r) => r.diffs.length) ? 1 : 0;
