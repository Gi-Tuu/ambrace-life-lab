// P4 收口闸门：space 是唯一空间/高度权威。
//   01 正式路径 0 处旧开关/包装/房间像素行走；
//   02 客户端 buildWorld 与服务端 construction-access 同一输入、同一结果（含高度）；
//   03 村内地面/桥/野外由同一条 campTerrain/wild-landscape 高度链派生，stage.floors 只是可站表面；
//   04 室内只走 roomSurface（16×12 + portal）；
//   05 旧实现只在研究夹具里（legacy* 命名），正式模块不 import；
//   06 旧档位置连续（读档后仍可站、仍可继续走）；
//   07 研究态 dumpSurv 逐位不变（space 不进存档）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createSurvPlay, dumpSurv, loadSurv, survView } from './survplay.mjs';
import { constructionSpace, sceneSpace, roomSpaceOf } from './construction-access.mjs';
import { campSurface, createSpace, roomSurface, wildSurface } from './space.mjs';
import { campSceneBundle, campSitesOf, staticCampSites } from '../shared/camp-scene-content.mjs';
import { campTerrain, floorSurface } from '../shared/camp-terrain.mjs';
import { campBridgeBounds, generateCampLayout } from '../shared/camp-layout.mjs';
import { CAMP_BODY_RADIUS } from '../shared/camp-physics.mjs';
import { playerReach } from './survplay-camp.mjs';
import {
  legacyCampBodyWorld, legacyGroundQuery, legacyMoveRoomFeet, legacyRoomAllows,
} from './research-space.mjs';

const FORMAL = {
  gameRules: true, mapSeed: 13, layoutVersion: 2, settlementLife: true, regionalWork: true,
  independentWorld: true, residentialDecisions: true, unifiedCooperation: true, actTimeModel: true,
};
const start = (seed = 13, extra = {}) => createSurvPlay(seed, { ...FORMAL, mapSeed: seed, ...extra });
const LIFE = fileURLToPath(new URL('.', import.meta.url));
const WEB = fileURLToPath(new URL('../web/', import.meta.url));
const read = (dir, name) => readFileSync(dir + name, 'utf8');

// 客户端 buildWorld 的 Node 复刻：与 buildWorld 用同一份 campSceneBundle 输入、同一个 createSpace 组合。
function clientWorldFromView(v) {
  const liveSites = campSitesOf({
    rooms: v.rooms, districts: v.districts, layout: v.layout, peripheralHomes: v.peripheralHomes,
  });
  const sites = staticCampSites(liveSites, v.districts, v.peripheralHomes);
  const { content, stage } = campSceneBundle({
    mapSeed: v.mapSeed, layoutVersion: v.layoutVersion ?? 0, layout: v.layout ?? null,
    camp: v.camp, timber: Boolean(v.camp?.timber), sites,
    districts: v.districts, peripheralHomes: v.peripheralHomes,
    households: v.households, homeRoads: v.homeRoads, ecoSources: v.ecoSources,
  });
  const crossing = v.layout?.crossZ ?? 24;
  const space = createSpace({
    camp: campSurface({ mapSeed: v.mapSeed, layoutVersion: v.layoutVersion ?? 0, layout: v.layout ?? null, stage, terrain: content.landscape }),
    wild: wildSurface(content.landscape, { crossing }),
    terrain: content.landscape,
  });
  return { content, stage, space, sites };
}

const lcg = (seed) => { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; };
function samplesFor(seed, version) {
  const rnd = lcg(20261120 + seed * 31 + version);
  const points = [];
  for (let i = 0; i < 3000; i += 1) points.push([rnd() * 200 - 40, rnd() * 160 - 40]);
  const { riverCenter, riverHalfWidth } = campTerrain(seed, true, version);
  const layout = version ? generateCampLayout(seed, version) : null;
  if (layout) {
    const bounds = campBridgeBounds(layout.crossZ - 1, layout.crossZ + 1, riverCenter, riverHalfWidth);
    for (let i = 0; i < 1000; i += 1) {
      points.push([bounds[0] + rnd() * (bounds[2] - bounds[0]), bounds[1] + rnd() * (bounds[3] - bounds[1])]);
    }
  } else {
    for (let i = 0; i < 1000; i += 1) points.push([rnd() * 120, rnd() * 80]);
  }
  for (let i = 0; i < 1000; i += 1) {
    const z = rnd() * 80;
    const center = riverCenter(z * 16) / 16;
    const half = riverHalfWidth(z * 16) / 16;
    points.push([center + (rnd() * 2 - 1) * (half + .35), z]);
  }
  return points;
}

test('P4-01 正式路径 0 处旧空间开关/包装/房间像素行走', () => {
  const BANNED = [
    /\bSPACE_V1\b/, /\bspaceQueriesEnabled\b/, /\b__SPACE_LEGACY__\b/, /space=legacy/,
    /\bcampBodyWorld\b/, /\broomPixelWalk\b/, /\broomBodyFits\b/, /\bmoveRoomFeet\b/, /\broomAllows\b/,
    /\bperipheralStepCap\b/,
  ];
  const formal = [
    ...readdirSync(LIFE).filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs') && f !== 'research-space.mjs').map((f) => `life/${f}`),
    ...readdirSync(WEB).filter((f) => f.endsWith('.mjs') || f.endsWith('.js')).map((f) => `web/${f}`),
    'shared/camp-scene.mjs', 'shared/camp-scene-content.mjs', 'shared/wild-landscape.mjs', 'shared/camp-terrain.mjs',
  ];
  const root = fileURLToPath(new URL('../', import.meta.url));
  const hits = [];
  for (const rel of formal) {
    const lines = readFileSync(root + rel, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      for (const re of BANNED) if (re.test(lines[i])) hits.push(`${rel}:${i + 1}: ${lines[i].trim()}`);
    }
  }
  assert.deepEqual(hits, [], `正式路径仍有旧分支：\n${hits.join('\n')}`);
});

test('P4-02 客户端/服务端同一输入、同一结果：walkable/heightAt/collidersNear/portalAt 0 差异', () => {
  for (const [seed, version] of [[0, 0], [13, 2]]) {
    const sp = start(seed, { layoutVersion: version });
    const viewer = clientWorldFromView(survView(sp));
    const server = constructionSpace(sp.world) ?? sceneSpace(sp.world);
    assert.ok(viewer.space && server, `${seed}/${version} 缺空间`);
    const serverStage = sceneStageOf(sp.world);
    // 同一输入 ⇒ 同一 stage（floors/boxes 逐位相同）。
    assert.deepEqual(viewer.stage.floors, serverStage.floors, 'stages 的 floors 必须逐位一致');
    assert.deepEqual(viewer.stage.boxes.length, serverStage.boxes.length, 'stages 的实体数必须一致');
    const points = samplesFor(seed, version);
    let walk = 0, height = 0, portal = 0, colliders = 0, first = null;
    for (const [x, z] of points) {
      if (viewer.space.walkable(x, z, CAMP_BODY_RADIUS) !== server.walkable(x, z, CAMP_BODY_RADIUS)) {
        walk += 1; first ??= { kind: 'walk', x, z };
      }
      if (!Object.is(viewer.space.heightAt(x, z), server.heightAt(x, z))) {
        height += 1; first ??= { kind: 'height', x, z, a: viewer.space.heightAt(x, z), b: server.heightAt(x, z) };
      }
      const pa = viewer.space.portalAt(x, z, .3)?.id ?? null, pb = server.portalAt(x, z, .3)?.id ?? null;
      if (pa !== pb) { portal += 1; first ??= { kind: 'portal', x, z, pa, pb }; }
      const ca = viewer.space.collidersNear(x, z, CAMP_BODY_RADIUS).map((c) => c.kind).join('|');
      const cb = server.collidersNear(x, z, CAMP_BODY_RADIUS).map((c) => c.kind).join('|');
      if (ca !== cb) { colliders += 1; first ??= { kind: 'colliders', x, z, ca, cb }; }
    }
    assert.equal(points.length, 5000);
    assert.deepEqual({ walk, height, portal, colliders }, { walk: 0, height: 0, portal: 0, colliders: 0 },
      `${seed}/${version} 首个差异 ${JSON.stringify(first)}`);
  }
});

// 服务端 stage 不对外导出：用同一条 campSceneBundle 重放（与 construction-access 的 sceneGeometry 同一输入）。
function sceneStageOf(w) {
  const layout = w.campLayout ?? null;
  const liveSites = campSitesOf({ rooms: w.locs, districts: w.districts, layout, peripheralHomes: w.peripheralHomes });
  const sites = staticCampSites(liveSites, w.districts, w.peripheralHomes);
  return campSceneBundle({
    mapSeed: w.mapSeed, layoutVersion: w.layoutVersion ?? 0, layout, camp: true, timber: true, sites,
    districts: w.districts, peripheralHomes: w.peripheralHomes,
    households: w.survival?.households, homeRoads: w.survival?.homeRoads,
  }).stage;
}

test('P4-03 高度只有一个组合：max(0, 地形链, 已注册可站表面)，桥面/村内/野外同链', () => {
  const sp = start(), w = sp.world;
  const viewer = clientWorldFromView(survView(sp));
  const space = constructionSpace(w);
  assert.ok(space.terrain, 'space 必须挂上地形链');
  // 同一输入 ⇒ 同一条链的数值（服务端/客户端各自构建，但逐点相同）。
  for (const [x, z] of samplesFor(w.mapSeed, 0).slice(0, 200)) {
    assert.ok(Object.is(space.terrain.height(x, z), viewer.content.landscape.height(x, z)),
      `地形链 (${x},${z}) 客户端/服务端不一致`);
  }
  const points = samplesFor(w.mapSeed, w.layoutVersion);
  let terrainWins = 0, surfaceWins = 0, clamped = 0;
  for (const [x, z] of points) {
    const base = viewer.content.landscape.height(x, z);
    const surface = floorSurface(viewer.stage.floors, x, z);
    // 唯一公式：max(0, 地形链, 已注册表面)。0 是地面基准面，村内/野外同一口径。
    const expected = Math.max(0, base, surface ?? 0);
    assert.ok(Object.is(space.heightAt(x, z), expected),
      `(${x},${z}) space ${space.heightAt(x, z)} ≠ max(0, 地形 ${base}, 表面 ${surface ?? '无'})`);
    const lift = Math.max(0, base, surface ?? 0);
    if (surface !== null && surface > Math.max(0, base) + 1e-9) surfaceWins += 1;
    else if (lift > 0) terrainWins += 1;
    else clamped += 1;
  }
  assert.ok(terrainWins > 100, `地形链必须真的在起作用（实测 ${terrainWins}）`);
  assert.ok(surfaceWins > 0, `可站表面必须真的抬高脚底（实测 ${surfaceWins}）`);
  // 桥：水面之下是地形链，走上去是注册表面（桥面），两者不是同一套数据。
  const { riverCenter, riverHalfWidth } = campTerrain(w.mapSeed, true, w.layoutVersion);
  const bridge = campBridgeBounds(w.campLayout.crossZ - 1, w.campLayout.crossZ + 1, riverCenter, riverHalfWidth);
  const bx = (bridge[0] + bridge[2]) / 2, bz = (bridge[1] + bridge[3]) / 2;
  assert.ok(space.heightAt(bx, bz) >= .3, `桥面高度应来自注册表面（实测 ${space.heightAt(bx, bz)}）`);
  assert.ok(viewer.content.landscape.height(bx, bz) < space.heightAt(bx, bz), '桥下地形链应低于桥面');
  // 野外与营地同一公式：只有地形链时取 max(0, 地形链)，没有第二套高度。
  let wild = 0;
  for (const [x, z] of points) {
    if (x < 0 || x >= 120 || z < 0 || z >= 80) {
      assert.ok(Object.is(space.heightAt(x, z), Math.max(0, viewer.content.landscape.height(x, z))),
        `野外 (${x},${z}) 必须是 max(0, 地形链)`);
      wild += 1;
    }
  }
  assert.ok(wild > 100, `野外样本太少：${wild}`);
});

test('P4-04 室内只走 roomSurface：16×12 + portal，家具/墙/越界同一套判定', () => {
  const sp = start(), w = sp.world;
  const hall = roomSpaceOf(w, 'hall');
  assert.ok(hall);
  assert.equal(hall.heightAt(8, 6), 0, '房间地板高度显式 0');
  assert.equal(hall.walkable(8, 11.5, CAMP_BODY_RADIUS), true, '门口可站');
  assert.equal(hall.walkable(4, 4, CAMP_BODY_RADIUS), false, 'hall 长凳是实体');
  assert.equal(hall.walkable(15.5, 6, CAMP_BODY_RADIUS), false, '右墙');
  assert.equal(hall.walkable(8, 12.4, CAMP_BODY_RADIUS), false, '不得走出 12 高');
  assert.equal(hall.portalAt(8, 11.9, .2)?.kind, 'door');
  // 室内位置校验只问同一个房间空间。
  w.campPlayerRoom = 'hall';
  w.survival.playerPos = { x: 8, z: 11.5, t: w.t };
  w.survival.playerReachState = null;
  w.pos.p1 = { x: 8, z: 11.5, space: 'room:hall' };
  assert.equal(playerReach(w, [8.2, 11.4], 'player_sync').ok, true);
  assert.equal(playerReach(w, [4, 4], 'player_sync').code, 'OUT_OF_REACH');
  // 正式客户端只有一条室内推进路径。
  const app = read(WEB, 'app.js');
  assert.match(app, /moveRoomSurface\(space,/);
  assert.match(app, /roomSpaceFor\(/);
  assert.equal(/moveRoomFeet|roomBodyFits|roomPixelWalk/.test(app), false);
});

test('P4-05 旧实现只在研究夹具里：legacy* 语义保留，正式模块不 import 它', () => {
  // 正式模块不得 import 研究夹具（注释里提到文件名不算 import；只认 from/import() 的模块说明符）。
  const root = fileURLToPath(new URL('../', import.meta.url));
  const files = [
    ...readdirSync(LIFE).filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs') && f !== 'research-space.mjs').map((f) => `life/${f}`),
    ...readdirSync(WEB).filter((f) => f.endsWith('.mjs') || f.endsWith('.js')).map((f) => `web/${f}`),
    'serve.mjs',
  ];
  const importSpec = /(?:from\s*|import\s*\(\s*)['"][^'"]*research-space\.mjs['"]/;
  const importers = files.filter((rel) => importSpec.test(readFileSync(root + rel, 'utf8')));
  assert.deepEqual(importers, [], `正式模块 import 了研究夹具：${importers.join(',')}`);

  // 旧地面谓词：岸带放行（正式 space 拒）。
  const sp = start(), w = sp.world;
  const legacy = legacyGroundQuery({ mapSeed: w.mapSeed, layoutVersion: w.layoutVersion, layout: w.campLayout, districts: w.districts });
  const { riverCenter, riverHalfWidth } = campTerrain(w.mapSeed, true, w.layoutVersion);
  const z = 10, bankX = (riverCenter(z * 16) + riverHalfWidth(z * 16) + 1.5) / 16;
  assert.equal(legacy(bankX, z), true, '旧谓词只看河面');
  assert.equal(constructionSpace(w).walkable(bankX, z, 0), false, '正式 space 不看岸带');

  // 旧体半径包装：仍返回新栅格，不改写输入。
  const grid = { tw: 8, th: 8, walk: new Uint8Array(64).fill(1) };
  const wrapped = legacyCampBodyWorld({ tw: 8, th: 8, collisionGrid: grid });
  assert.notEqual(wrapped.collisionGrid, grid);
  assert.equal(wrapped.collisionGrid.walk[0], 0, '贴边格按身体半径挖掉');

  // 旧房间像素行走：像素掩码挡住即不可走（研究夹具保留旧口径）。
  const cells = new Map(), pixels = new Uint8Array(ROOM_PX.width * ROOM_PX.height).fill(1);
  const bounds = { left: 32, right: 224, top: 50, bottom: 192 };
  pixels[(120) * ROOM_PX.width + 128] = 0; // 在 (128,120) 放一个像素障碍
  assert.equal(legacyRoomAllows(cells, 128, 120, pixels, bounds), false);
  const [fx, fz] = legacyMoveRoomFeet(cells, 128, 100, 0, 40, pixels, null, bounds);
  assert.ok(fz < 120, `旧像素推进必须被挡在障碍前（实测 ${fz}）`);
  assert.ok(fx === 128);
});

test('P4-06 旧档位置连续：没有 pos 的旧档读回后仍可站、仍能继续走', () => {
  const sp = start(), w = sp.world;
  // 一个真实可走的室外点：大厅门前。
  const space = constructionSpace(w);
  const site = w.campLayout.sites.hall;
  const outdoor = [site[0] + .5, site[1] + 2.5];
  assert.equal(space.walkable(outdoor[0], outdoor[1], CAMP_BODY_RADIUS), true, '前置：门外应可站');
  w.survival.playerPos = { x: outdoor[0], z: outdoor[1], t: w.t };
  w.survival.playerReachState = null;
  const raw = JSON.parse(JSON.stringify(dumpSurv(sp)));
  delete raw.pos; // P2b 及以前的旧档
  const back = loadSurv(raw, 13, FORMAL);
  assert.deepEqual(back.world.pos.p1, { x: outdoor[0], z: outdoor[1], space: 'world' }, '旧档按 playerPos 补齐 pos');
  assert.deepEqual(back.world.survival.playerPos, w.survival.playerPos);
  assert.equal(playerReach(back.world, [outdoor[0] + .5, outdoor[1]], 'player_sync').ok, true, '读档后继续走一小步必须放行');
  assert.equal(back.world.pos.p1.space, 'world');
  // 室内旧档同理：坐标不乘 16，进门后的门口点仍可站。
  const indoor = JSON.parse(JSON.stringify(dumpSurv(sp)));
  delete indoor.pos;
  indoor.campPlayerRoom = 'hall';
  indoor.loc.p1 = 'hall';
  indoor.survival.playerPos = { x: 8, z: 11.5, t: w.t };
  const inBack = loadSurv(indoor, 13, FORMAL).world;
  assert.deepEqual(inBack.pos.p1, { x: 8, z: 11.5, space: 'room:hall' });
  assert.equal(playerReach(inBack, [8.2, 11.4], 'player_sync').ok, true);
});

test('P4-07 研究态 dumpSurv 逐位不变：space/高度不进存档，夹具导入不影响研究轨迹', () => {
  const a = createSurvPlay(7), b = createSurvPlay(7);
  const da = JSON.stringify(dumpSurv(a)), db = JSON.stringify(dumpSurv(b));
  assert.equal(da, db, '同种子两次研究 dump 必须逐位相同');
  assert.equal(da.includes('"space"'), false, 'space 不得进研究存档');
  assert.equal(da.includes('"terrain"'), false, '地形链不得进研究存档');
  // 研究世界没有 space 也不建 pos（正式空间不会“漏”进研究态）。
  assert.equal(a.world.pos, undefined);
  assert.equal(createSurvPlay(7, { gameRules: false }).world.pos, undefined);
});

// 房间像素网格只在研究夹具里用；这里显式写出来，避免从正式模块借常量。
const ROOM_PX = Object.freeze({ width: 256, height: 192 });
