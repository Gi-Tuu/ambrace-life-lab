// P2b 闸门：服务端 stage 与客户端同一份树/岩/桥；居民/玩家同一速度预算；A* 唯一核心；
// playerReach 几何校验（房间空间例外）；旧档位置连续；研究态 dumpSurv 不变。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSurvPlay, survView, dumpSurv, loadSurv } from './survplay.mjs';
import { playerReach } from './survplay-camp.mjs';
import { constructionSpace, sceneSpace, roomSpaceOf } from './construction-access.mjs';
import { startMove, RESIDENT_UNITS_PER_TICK, GAME_RESIDENT_UNITS_PER_TICK } from './body.mjs';
import { worldSite } from './geometry.mjs';
import { campSurface, createSpace, travelTicks, unitsPerTick, wildSurface, GAME_PLAYER_UNITS_PER_TICK } from './space.mjs';
import { campSceneBundle, campSitesOf, staticCampSites } from '../shared/camp-scene-content.mjs';
import { CAMP_BODY_RADIUS } from '../shared/camp-physics.mjs';
import { astar } from '../web/walk.mjs';
import { pixelPath } from '../shared/asset-collision.mjs';

const FORMAL = {
  gameRules: true, mapSeed: 13, layoutVersion: 2, settlementLife: true, regionalWork: true,
  independentWorld: true, residentialDecisions: true, unifiedCooperation: true, actTimeModel: true,
};
const start = (seed = 13, extra = {}) => createSurvPlay(seed, { ...FORMAL, mapSeed: seed, ...extra });
const lcg = (seed) => { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; };

// 客户端 buildWorld 的 stage/space 语义（Node 侧复刻）：同一份 content，不得单独写第二套。
// P4：与 web/app.js 的 buildWorld 用同一个 campSceneBundle + 同一条 content.landscape 高度链。
function clientSpaceFromView(v) {
  const live = campSitesOf({ rooms: v.rooms, districts: v.districts, layout: v.layout, peripheralHomes: v.peripheralHomes });
  const sites = staticCampSites(live, v.districts, v.peripheralHomes);
  const { content, stage } = campSceneBundle({
    mapSeed: v.mapSeed, layoutVersion: v.layoutVersion ?? 0, layout: v.layout ?? null,
    camp: v.camp, timber: Boolean(v.camp?.timber), sites,
    districts: v.districts, peripheralHomes: v.peripheralHomes,
    households: v.households, homeRoads: v.homeRoads, ecoSources: v.ecoSources,
  });
  const camp = campSurface({ mapSeed: v.mapSeed, layoutVersion: v.layoutVersion ?? 0, layout: v.layout ?? null, stage, terrain: content.landscape, bridges: content.bridges });
  const space = createSpace({
    camp,
    wild: wildSurface(content.landscape, { crossing: camp.crossing }),
    terrain: content.landscape,
  });
  return { space, content, stage };
}

test('P2b-01 服务端 stage 真的带树/岩/山丘/桥（trees:[] 会红）', () => {
  for (const [seed, version] of [[0, 0], [13, 2]]) {
    const sp = start(seed, { layoutVersion: version });
    const space = sceneSpace(sp.world);
    assert.ok(space, `${seed}/${version} 应有只读空间`);
    assert.ok(space.colliders.some((c) => String(c.kind).startsWith('tree:')), '服务端 colliders 必须含树');
    assert.ok(space.colliders.some((c) => String(c.kind).startsWith('rock:')), '服务端 colliders 必须含岩');
  }
});

test('P2b-02 客户端/服务端同坐标 0 差异（每例 4000 点：walk/height）', () => {
  for (const [seed, version] of [[0, 0], [13, 2]]) {
    const sp = start(seed, { layoutVersion: version });
    const v = survView(sp);
    const client = clientSpaceFromView(v);
    const server = sceneSpace(sp.world);
    assert.ok(client.space && server);
    const rnd = lcg(20261119 + seed * 17 + version);
    let mismatch = 0;
    for (let i = 0; i < 4000; i += 1) {
      const x = rnd() * 119.99, z = rnd() * 79.99;
      if (client.space.walkable(x, z, CAMP_BODY_RADIUS) !== server.walkable(x, z, CAMP_BODY_RADIUS)) mismatch += 1;
      if (Math.abs(client.space.heightAt(x, z) - server.heightAt(x, z)) > 1e-9) mismatch += 1;
    }
    assert.equal(mismatch, 0, `${seed}/${version} 同坐标差异`);
  }
});

test('P2b-03 居民/玩家同一 speedBudget：按 space 路径长度推导；研究态仍 12/刻', () => {
  const sp = start(), w = sp.world;
  const loc = Object.keys(w.districts)[0];
  w.loc.a1 = w.loc.p1;
  w.pos.a1 = { ...(w.pos[w.loc.p1] ?? {}), space: 'room:home' };
  startMove(w, 'a1', loc);
  const trip = w.survival.districtTravel.a1;
  const from = worldSite(w, loc), startPt = worldSite(w, w.loc.p1);
  const dist = Math.hypot(from[0] - startPt[0], from[1] - startPt[1]);
  // P2c：到达刻由实际路径长度推导；路径不会短于直线距离。
  assert.ok(Array.isArray(trip.path) && trip.path.length > 0, '正式游戏应有 space 路径');
  assert.ok(trip.length >= dist - 1e-9, '路径长度不得短于直线距离');
  assert.equal(trip.arrive - w.t, Math.max(2, Math.ceil(trip.length / unitsPerTick('walk')) + 1));
  assert.equal(trip.kind, 'walk');
  assert.equal(GAME_RESIDENT_UNITS_PER_TICK, unitsPerTick('walk'));
  assert.equal(GAME_RESIDENT_UNITS_PER_TICK, 22.5, '居民按步行预算 22.5/刻');
  assert.equal(unitsPerTick('sprint'), GAME_PLAYER_UNITS_PER_TICK, '玩家移动冲刺 39.375/刻在同一张表');
  // 研究态：仍是直线距离 /12 刻。
  const old = start(13, { actTimeModel: false });
  const ow = old.world, oloc = Object.keys(ow.districts)[0];
  ow.loc.a1 = ow.loc.p1;
  startMove(ow, 'a1', oloc);
  assert.ok(ow.survival.districtTravel.a1.arrive - ow.t > 0);
  const ofrom = worldSite(ow, ow.loc.p1), oto = worldSite(ow, oloc);
  const odist = Math.hypot(oto[0] - ofrom[0], oto[1] - ofrom[1]);
  assert.equal(ow.survival.districtTravel.a1.arrive - ow.t,
    Math.max(2, Math.ceil(odist / RESIDENT_UNITS_PER_TICK) + 1));
  assert.equal(ow.survival.districtTravel.a1.path, undefined, '研究态没有连续路径');
});

test('P2b-04 A* 唯一核心：astar 结果 = pixelPath 转向点展开（含绕墙）', () => {
  const grid = (tw, th, holes = []) => {
    const walk = new Uint8Array(tw * th).fill(1);
    for (const [x, y] of holes) walk[y * tw + x] = 0;
    return { tw, th, walk };
  };
  const expand = (route, [sx, sy]) => {
    const out = []; let x = sx, y = sy;
    for (const [wx, wy] of route) {
      while (x !== wx || y !== wy) {
        if (x !== wx) x += Math.sign(wx - x); else y += Math.sign(wy - y);
        out.push([x, y]);
      }
    }
    return out;
  };
  for (const holes of [[], [[4, 3]], [[3, 2], [3, 3], [3, 4]]]) {
    const world = grid(9, 7, holes);
    const route = pixelPath(world, [1, 1], [7, 5]);
    if (route && route.length) {
      assert.deepEqual(astar(world, [1, 1], [7, 5]), expand(route, [1, 1]));
    } else {
      assert.equal(astar(world, [1, 1], [7, 5]), route);
    }
  }
  assert.deepEqual(astar(grid(5, 5), [2, 2], [2, 2]), []);
  assert.equal(astar(grid(5, 5, [[4, 4]]), [0, 0], [4, 4]), null);
});

test('P2b-05 playerReach 几何：实体/水面拒 OUT_OF_REACH，合法点放行，室内按房间空间', () => {
  const sp = start(), w = sp.world;
  const space = constructionSpace(w);
  assert.ok(space);
  const site = w.campLayout.sites[w.loc.p1];
  w.survival.playerPos = { x: site[0], z: site[1], t: w.t };
  w.survival.playerReachState = null;
  // 合法：地点中心附近可走点（不是目标点本身，避免依赖出生槽）。
  const walkable = space.collidersNear(site[0] + .5, site[1] + .5, 0).length === 0 &&
    space.terrainWalkable(site[0] + .5, site[1] + .5);
  assert.ok(walkable, '前置：hall 中心应可站');
  assert.equal(playerReach(w, [site[0] + .5, site[1] + .5], 'player_sync').ok, true);
  // 实体内部：距离很小，但不是"瞬移"，必须按几何拒。
  const solid = space.colliders.find((c) => c.w >= .6 && c.d >= .6);
  assert.ok(solid, '应有实体');
  w.survival.playerPos = { x: solid.x + solid.w / 2 - 1, z: solid.z + solid.d / 2, t: w.t };
  w.survival.playerReachState = null;
  const inside = playerReach(w, [solid.x + solid.w / 2, solid.z + solid.d / 2], 'player_sync');
  assert.equal(inside.ok, false);
  assert.equal(inside.code, 'OUT_OF_REACH');
  // 越界（WILDS 矩形外）仍是 OUT_OF_REACH。
  assert.equal(playerReach(w, [-300, -300], 'player_sync').code, 'OUT_OF_REACH');
  // 室内：房间 16×12 坐标是显式空间，门口可站；家具与墙按 roomSurface 拒。
  const room = roomSpaceOf(w, 'hall');
  assert.ok(room, 'hall 应有显式房间空间');
  assert.equal(room.walkable(8, 11.5, CAMP_BODY_RADIUS), true, '门口应可站');
  assert.equal(room.walkable(4, 4, CAMP_BODY_RADIUS), false, 'hall 长凳所在点必须拒');
  assert.equal(room.walkable(15.5, 6, CAMP_BODY_RADIUS), false, '墙边必须拒');
  assert.equal(room.walkable(2, 13, CAMP_BODY_RADIUS), false, '越出 16×12 必须拒');
  assert.equal(room.portalAt(8, 11.9, .2)?.kind, 'door');
  w.campPlayerRoom = 'hall';
  w.survival.playerPos = { x: 8, z: 11.5, t: w.t };
  w.survival.playerReachState = null;
  assert.equal(playerReach(w, [8.2, 11.4], 'player_sync').ok, true, '室内同步不得被室外几何误杀');
  assert.equal(playerReach(w, [4, 4], 'player_sync').code, 'OUT_OF_REACH', '室内家具必须拒');
  assert.equal(playerReach(w, [15.5, 6], 'player_sync').code, 'OUT_OF_REACH', '室内墙必须拒');
});

test('P2b-06 旧档位置连续：playerPos/campPlayerRoom 原样恢复且几何口径一致', () => {
  const sp = start(), w = sp.world;
  const site = w.campLayout.sites.hall;
  w.survival.playerPos = { x: 8, z: 11.5, t: w.t };
  w.campPlayerRoom = 'hall';
  w.pos.p1 = { x: 8, z: 11.5, space: 'room:hall' };
  const back = loadSurv(JSON.parse(JSON.stringify(dumpSurv(sp))), 13, FORMAL);
  assert.deepEqual(back.world.survival.playerPos, w.survival.playerPos);
  assert.equal(back.world.campPlayerRoom, 'hall');
  assert.deepEqual(back.world.pos.p1, { x: 8, z: 11.5, space: 'room:hall' });
  assert.equal(playerReach(back.world, [8.2, 11.4], 'player_sync').ok, true, '读档后室内几何仍放行');
  assert.equal(playerReach(back.world, [4, 4], 'player_sync').code, 'OUT_OF_REACH', '读档后家具仍拒');
});

test('P2b-07 研究态 dumpSurv 逐位不变（居民仍 12/刻、space 不入档）', () => {
  const a = createSurvPlay(7), b = createSurvPlay(7);
  const da = JSON.stringify(dumpSurv(a)), db = JSON.stringify(dumpSurv(b));
  assert.equal(da, db);
  assert.equal(da.includes('"space"'), false);
  const loc = Object.keys(a.world.districts ?? {})[0];
  if (loc) {
    a.world.loc.a1 = a.world.loc.p1;
    startMove(a.world, 'a1', loc);
    const pt = worldSite(a.world, loc), from = worldSite(a.world, a.world.loc.p1);
    const dist = Math.hypot(pt[0] - from[0], pt[1] - from[1]);
    assert.equal(a.world.survival.districtTravel.a1.arrive - a.world.t,
      Math.max(2, Math.ceil(dist / RESIDENT_UNITS_PER_TICK) + 1));
  }
});
