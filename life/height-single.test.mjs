import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { campBridgeBounds, generateCampLayout, TOWN_SIZE } from '../shared/camp-layout.mjs';
import { campTerrain, floorHeight, reliefFaces } from '../shared/camp-terrain.mjs';
import { outdoorStage } from '../shared/camp-scene.mjs';
import { campSurface } from './space.mjs';

// 2026-11-20 重构前 life/space.mjs:173 的退役实现（shared/camp-scene.mjs:55 与其逐字同义）。
// 保留逐字副本，作为“共享实现不得改语义”的对照；故意改坏 shared/camp-terrain.floorHeight
// 时，HEIGHT-02/03 必须变红。
function retiredFloorContains(f, x, z) {
  const u=(x-f.x)/f.w, v=(z-f.z)/f.d;
  return u>=0 && u<=1 && v>=0 && v<=1 &&
    (f.triangle===1 ? u>=v : f.triangle===2 ? u<=v : true);
}
function retiredFloorHeight(floors, x, z) {
  let y = 0;
  for (const f of floors) {
    if (!retiredFloorContains(f, x, z)) continue;
    if (f.triangle) {
      y = Math.max(y, f.y + f.ax * (x - f.x) + f.az * (z - f.z));
      continue;
    }
    const t = f.axis === 'x' ? (x - f.x) / f.w : f.axis === 'z' ? (z - f.z) / f.d : 0;
    y = Math.max(y, f.y + (f.end - f.y) * t);
  }
  return y;
}

const src = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('HEIGHT-01 floorHeight 只有一份：space/camp-scene 都已删除本地循环', () => {
  const space = src('./space.mjs');
  const scene = src('../shared/camp-scene.mjs');
  assert.match(space, /import \{[^}]*floorHeight[^}]*\} from '\.\.\/shared\/camp-terrain\.mjs'/,
    'life/space.mjs 必须从 shared/camp-terrain.mjs 导入 floorHeight');
  assert.doesNotMatch(space, /function floorHeight\s*\(/, 'life/space.mjs 不得再定义 floorHeight');
  assert.doesNotMatch(space, /for \(const f of floors\)/, 'life/space.mjs 不得保留高度循环');
  assert.match(scene, /import \{[^}]*floorHeight[^}]*\} from '\.\/camp-terrain\.mjs'/,
    'shared/camp-scene.mjs 必须从 camp-terrain.mjs 导入 floorHeight');
  assert.doesNotMatch(scene, /for \(const f of floors\)/, 'shared/camp-scene.mjs 不得保留高度循环');
  assert.match(scene, /heightAt\(x, z\) \{ return floorHeight\(floors, x, z\); \}/,
    'stage.heightAt 必须是 floorHeight 的薄适配');
});

test('HEIGHT-02 共享 floorHeight 与退役实现逐位相同（含三角面/坡道/重叠/边界）', () => {
  const hills = campTerrain(13, true, 2).hills.slice(0, 3);
  const floors = [
    { x: 0, z: 0, w: 6, d: 6, y: 0.4, axis: 'x', end: 0.4 },
    { x: 2, z: 1, w: 4, d: 3, y: 0.1, axis: 'x', end: 1.3 },
    { x: 8, z: 2, w: 3, d: 7, y: 0.2, axis: 'z', end: 1.1 },
    { x: 1, z: 8, w: 2, d: 2, y: 0.5, axis: 'q', end: 0.9 },
    { x: 4.5, z: 4.5, w: 3, d: 3, y: 2, axis: 'x', end: 0.6 },
    ...reliefFaces(hills),
  ];
  const samples = [];
  for (let x = -2; x <= 16; x += 0.1) for (let z = -2; z <= 16; z += 0.1) samples.push([x, z]);
  for (const f of floors) {
    for (const [x, z] of [[f.x, f.z], [f.x + f.w, f.z], [f.x, f.z + f.d], [f.x + f.w, f.z + f.d],
      [f.x + f.w / 2, f.z + f.d / 2]]) samples.push([x, z]);
  }
  assert.ok(samples.length > 20000, `样本量 ${samples.length} 应 >20k`);
  let mismatch = 0;
  for (const [x, z] of samples) {
    const a = floorHeight(floors, x, z);
    const b = retiredFloorHeight(floors, x, z);
    if (!Object.is(a, b)) {
      mismatch += 1;
      if (mismatch <= 5) assert.fail(`(${x},${z}) 共享 ${a} ≠ 退役 ${b}`);
    }
  }
  assert.equal(mismatch, 0, `${mismatch}/${samples.length} 点不一致`);
});

test('HEIGHT-03 真实 stage.heightAt 与 campSurface.heightAt 逐位相同（桥面 + 山丘三角面）', () => {
  const seed = 13, version = 2;
  const { riverCenter, riverHalfWidth } = campTerrain(seed, true, version);
  const layout = generateCampLayout(seed, version);
  const bridges = [campBridgeBounds(layout.crossZ - 1, layout.crossZ + 1, riverCenter, riverHalfWidth)];
  const hills = campTerrain(seed, true, version).hills;
  const stage = outdoorStage({
    tw: TOWN_SIZE.width, th: TOWN_SIZE.depth, sites: {},
    trees: [], grass: [], hills, height: () => 0, layoutSeed: seed,
  }, bridges, []);
  const camp = campSurface({ mapSeed: seed, layoutVersion: version, layout, stage });
  assert.ok(stage.floors.length > 0, 'stage 应有 floors');
  const points = [];
  for (let i = 0; i < 11000; i += 1) {
    // 覆盖桥带、山丘与村内：确定性网格 + 抖动，不依赖随机源。
    points.push([((i * 37) % 1200) / 10 + 0.013, ((i * 53) % 800) / 10 + 0.017]);
  }
  // 每个 floor 的中心/边界至少踩一次，保证桥面与三角面都被问到。
  for (const f of stage.floors.slice(0, 400)) {
    points.push([f.x + f.w / 2, f.z + f.d / 2], [f.x, f.z], [f.x + f.w, f.z + f.d]);
  }
  let nonzero = 0, mismatch = 0;
  for (const [x, z] of points) {
    const a = stage.heightAt(x, z);
    const b = camp.heightAt(x, z);
    if (a !== 0) nonzero += 1;
    if (!Object.is(a, b)) {
      mismatch += 1;
      if (mismatch <= 5) assert.fail(`(${x},${z}) stage ${a} ≠ surface ${b}`);
    }
  }
  assert.ok(nonzero > 100, `非零高度点 ${nonzero} 太少，样本未覆盖桥/丘`);
  assert.equal(mismatch, 0, `${mismatch}/${points.length} 点不一致`);
});
