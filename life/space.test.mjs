// P2 第一刀：space 纯模块闸门（先红后绿：实现前 import 失败）。
// 关注 4 件事：统一坐标、河/岸/桥判定、实体 AABB、高度/门户/房间区域。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TILE, PIXELS_PER_UNIT, GAME_MINUTES_PER_TICK, WALK_UNITS_PER_GAME_MINUTE,
  SPRINT_FACTOR, GAME_BASE_UNITS_PER_TICK, GAME_PLAYER_UNITS_PER_TICK,
  unitsForGameMinutes, unitsForTick, unitsForRealMs,
  ROOM_UNITS, roomContains, roomToWorld, worldToRoom,
  campSurface, wildSurface, createSpace,
} from './space.mjs';
import { campTerrain, hash2 } from '../shared/camp-terrain.mjs';
import { campBridgeBounds, generateCampLayout } from '../shared/camp-layout.mjs';
import { pointIn } from '../shared/camp-interaction.mjs';

const SEED = 13, VERSION = 2;
const layout = generateCampLayout(SEED, VERSION);
const { riverCenter, riverHalfWidth } = campTerrain(SEED, true, VERSION);

// 与 web/app.js terrainKinds 同一条公式的参考实现（逐点版）。
function referenceGround(x, z) {
  const px = x * PIXELS_PER_UNIT, pz = z * PIXELS_PER_UNIT;
  const wet = riverHalfWidth(pz) - Math.abs(px - riverCenter(pz));
  const noise = (a, b) => {
    const s = 11 + SEED;
    const fx = a / 24, fy = b / 24, ix = Math.floor(fx), iy = Math.floor(fy);
    const u = (fx - ix) ** 2 * (3 - 2 * (fx - ix));
    const v = (fy - iy) ** 2 * (3 - 2 * (fy - iy));
    const A = hash2(ix, iy, s), B = hash2(ix + 1, iy, s);
    const C = hash2(ix, iy + 1, s), D = hash2(ix + 1, iy + 1, s);
    return (A + (B - A) * u) * (1 - v) + (C + (D - C) * u) * v;
  };
  return wet <= -3 - (noise(px, pz) * 2 - 1);
}

test('P2-S01 坐标：1 世界单位=16px；房间 16×12 显式换算可逆', () => {
  assert.equal(TILE, 16);
  assert.equal(PIXELS_PER_UNIT, 16);
  const room = roomToWorld([128, 96]);
  assert.deepEqual(room, { x: 8, z: 6 });
  assert.deepEqual(worldToRoom(room), { x: 128, z: 96 });
  assert.deepEqual(ROOM_UNITS, { width: 16, height: 12 });
  assert.equal(roomContains(8, 6), true);
});

test('P2-S02 房间区域与旧 pointIn(16.01,12.01) 在 10k 边界点逐位一致', () => {
  let n = 0, diff = 0;
  for (let i = 0; i < 10000; i += 1) {
    const x = hash2(i, 1, 71) * 20 - 2;
    const z = hash2(i, 2, 72) * 16 - 2;
    n += 1;
    if (roomContains(x, z) !== pointIn([x, z], 16.01, 12.01)) diff += 1;
  }
  assert.equal(n, 10000);
  assert.equal(diff, 0);
});

test('P2-S03 营地地面：10k 点与 terrainKinds 公式 0 差异（岸带包含在内）', () => {
  const ground = campSurface({ mapSeed: SEED, layoutVersion: VERSION, layout });
  let n = 0, diff = 0, diffAt = null, bank = 0, bridges = 0;
  for (let i = 0; i < 10000; i += 1) {
    const x = hash2(i, 3, 73) * 122 - 1;
    const z = hash2(i, 4, 74) * 82 - 1;
    n += 1;
    const kind = ground.classify(x, z);
    if (kind === 'bank') bank += 1;
    if (kind === 'bridge') bridges += 1;
    const expected = kind === 'bridge' ? true : referenceGround(x, z);
    const actual = ground.terrainAllows(x, z);
    if (expected !== actual) { diff += 1; diffAt ??= [x, z, expected, actual, kind]; }
  }
  assert.equal(n, 10000);
  assert.ok(bank > 20, `样本应覆盖岸带（实测 ${bank}）`);
  assert.equal(diff, 0, `首个差异 ${JSON.stringify(diffAt)}`);
  assert.ok(bridges > 0, `样本应覆盖桥面（实测 ${bridges}）`);
});

test('P2-S04 桥：campBridgeBounds 内可走且高度=桥面；紧邻水岸不可走', () => {
  const bounds = campBridgeBounds(layout.crossZ - 1, layout.crossZ + 1, riverCenter, riverHalfWidth);
  const [x0, z0, x1, z1] = bounds;
  const bridgeX = (x0 + x1) / 2, bridgeZ = (z0 + z1) / 2;
  const stage = {
    boxes: [], floors: [{
      x: x0, z: z0, w: x1 - x0, d: z1 - z0, y: .32, color: 'wood', axis: undefined, end: .32,
    }],
    entrances: { hall: { x: 30, z: 24, w: 2, d: 1.5 } },
  };
  const ground = campSurface({ mapSeed: SEED, layoutVersion: VERSION, layout, stage });
  assert.equal(ground.classify(bridgeX, bridgeZ), 'bridge');
  assert.equal(ground.terrainAllows(bridgeX, bridgeZ), true);
  assert.equal(ground.heightAt(bridgeX, bridgeZ), .32);
  // 河道中心（无桥行）不可走
  const z = 5;
  const center = riverCenter(z * PIXELS_PER_UNIT) / PIXELS_PER_UNIT;
  assert.equal(ground.classify(center, z), 'water');
  assert.equal(ground.terrainAllows(center, z), false);
  // 岸带：水面外 1.5px（旧服务端只看河，会误判可走）
  const bankX = (riverCenter(z * PIXELS_PER_UNIT) + riverHalfWidth(z * PIXELS_PER_UNIT) + 1.5) / PIXELS_PER_UNIT;
  assert.equal(ground.classify(bankX, z), 'bank');
  assert.equal(ground.terrainAllows(bankX, z), false);
});

test('P2-S05 实体：solid AABB 阻挡、collidersNear 只回附近、高度取 floors', () => {
  const ground = campSurface({
    mapSeed: SEED, layoutVersion: VERSION, layout,
    stage: {
      boxes: [{ x: 10, y: 0, z: 10, w: 2, h: 2, d: 2, solid: true, occluder: 'site:shed' }],
      floors: [{ x: 40, z: 40, w: 2, d: 2, y: .48, axis: undefined, end: .48 }],
      entrances: {},
    },
  });
  assert.equal(ground.collidersNear(11, 11, 0).length, 1);
  assert.equal(ground.collidersNear(11, 11, 0)[0].kind, 'site:shed');
  assert.equal(ground.collidersNear(30, 30, 0).length, 0);
  assert.equal(ground.heightAt(40.5, 40.5), .48);
  const space = createSpace({ camp: ground, wild: null });
  assert.equal(space.walkable(11, 11, .33), false, 'solid 内不可走');
  assert.equal(space.surface(40.5, 40.5).y, .48);
});

test('P2-S06 门户：门/桥 portalAt 命中；房间门与入口来自同一份 stage.entrances', () => {
  const bounds = campBridgeBounds(layout.crossZ - 1, layout.crossZ + 1, riverCenter, riverHalfWidth);
  const gate = { x: 30, z: 24, w: 2, d: 1.5 };
  const ground = campSurface({
    mapSeed: SEED, layoutVersion: VERSION, layout,
    stage: { boxes: [], floors: [], entrances: { hall: gate } },
  });
  const door = ground.portalAt(gate.x + gate.w / 2, gate.z + gate.d / 2, 0);
  assert.equal(door?.kind, 'door');
  assert.equal(door?.room, 'hall');
  assert.equal(door?.a, 'room:hall');
  const bridge = ground.portalAt((bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2, 0);
  assert.equal(bridge?.kind, 'bridge');
});

test('P2-S07 野外适配器：只有传入的 wildLandscape 谓词回答村外', () => {
  const wild = wildSurface({ walkable: (x, z) => x > 0, height: () => 2 }, { crossing: 31 });
  const space = createSpace({ camp: null, wild });
  assert.equal(space.walkable(5, 5), true);
  assert.equal(space.walkable(-5, 5), false);
  assert.equal(space.heightAt(5, 5), 2);
  assert.equal(space.surface(-5, 5).region, 'wild');
});

test('P2-S09 房间地板/门：显式 room 上下文拿到高度 0 与门 portal', () => {
  const gate = { x: 30, z: 24, w: 2, d: 1.5 };
  const ground = campSurface({
    mapSeed: SEED, layoutVersion: VERSION, layout,
    stage: { boxes: [], floors: [], entrances: { hall: gate } },
  });
  const space = createSpace({ camp: ground, wild: null });
  assert.equal(space.roomHeightAt(8, 6, 'hall'), 0);
  assert.equal(space.roomHeightAt(8, 6, null), space.heightAt(8, 6));
  assert.equal(space.roomPortal('hall')?.kind, 'door');
  assert.equal(space.roomPortal('nope'), null);
});

test('P2-S08 速度：正式游戏单位/游戏分钟单一口径', () => {
  assert.equal(GAME_MINUTES_PER_TICK, 60);
  assert.equal(WALK_UNITS_PER_GAME_MINUTE, 3 / 8);
  assert.equal(unitsForGameMinutes(60), GAME_BASE_UNITS_PER_TICK);
  assert.equal(GAME_BASE_UNITS_PER_TICK, 22.5);
  assert.equal(GAME_PLAYER_UNITS_PER_TICK, 39.375);
  assert.equal(unitsForTick(false), 22.5);
  assert.equal(unitsForTick(true), 39.375);
  // 默认 7.5s 刻：正常 3 单位/秒、冲刺 5.25 单位/秒；6s 刻按游戏分钟换算到 3.75/6.5625。
  assert.equal(unitsForRealMs(1000, 7500, false), 3);
  assert.equal(unitsForRealMs(1000, 7500, true), 5.25);
  assert.equal(unitsForRealMs(1000, 6000, false), 3.75);
  assert.equal(unitsForRealMs(1000, 6000, true), 6.5625);
  assert.equal(SPRINT_FACTOR, 1.75);
});
