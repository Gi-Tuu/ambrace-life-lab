// 体验修复闸门（2026-11-21 渲染/空间审计的 P0/P1）：
//   01 遮挡分件 + 淡出白名单：建筑墙/屋顶/连廊会淡出，栅栏/田地/树/石永不改材质；死 cutout 已删；
//   02 桥：默认存档（layout=null）的桥带/crossing/可走性/portal 同源，东岸 BFS 可达 ≥99%；
//   03 入口：8 个房间入口矩形不压实心 AABB、中心/门口可站，camp_exit 把人放到可站位置；
//   04 天气：跨日那一刻不再一帧跳变（10–30s 平滑），30s 内到位，端点与旧硬切一致。
//
// 这些断言在 b66f88a（修复前）上会红：01 找不到 wall:/roof:<room> 分组且源码里仍有 uCutout；
// 02 默认存档桥心 walkable=false、东岸 0% 可达；03 home/store/workshop/watch 的 camp_exit 落点
// 不可站；04 新模块 web/camp-climate-view.mjs 不存在、同一 tick 的 wetness/风力/雨滴是阶跃。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { generateCampLayout, TOWN_SIZE } from '../shared/camp-layout.mjs';
import { campTerrain } from '../shared/camp-terrain.mjs';
import { campSitesOf, staticCampSites, campSceneBundle } from '../shared/camp-scene-content.mjs';
import { CAMP_BODY_RADIUS } from '../shared/camp-physics.mjs';
import { campEntrance } from '../shared/camp-interaction.mjs';
import { modelBounds } from '../shared/camp-geometry.mjs';
import { createSpace, campSurface, wildSurface } from './space.mjs';
import { coveredModels, campCamera, fadeableCovered, fadesAsOccluder } from '../web/camp-3d-render.mjs';
import { createSurvPlay, survAct } from './survplay.mjs';
import { sceneSpace } from './construction-access.mjs';
import { posOf } from './actor-pos.mjs';
import { CLIMATE_FADE, climateTargets, createClimateView } from '../web/camp-climate-view.mjs';
import { solarLight } from '../web/camp-sun.mjs';
import { campClimate, stormEffects, weatherDrops } from '../web/camp-weather.mjs';

const ROOM_WORLD = fileURLToPath(new URL('../web/', import.meta.url));
const ROOMS = ['home', 'hall', 'store', 'yard', 'workshop', 'garden', 'watch', 'well'];
const CASES = [[0, 0], [7, 2]];   // 默认存档 / 新布局 v2

const build = (mapSeed, layoutVersion) => {
  const layout = layoutVersion ? generateCampLayout(mapSeed, layoutVersion) : null;
  const sites = staticCampSites(campSitesOf({ layout, peripheralHomes: null }));
  const { content, stage } = campSceneBundle({ mapSeed, layoutVersion, layout, camp: true, timber: false, sites });
  const camp = campSurface({ mapSeed, layoutVersion, layout, stage, terrain: content.landscape, bridges: content.bridges });
  const space = createSpace({ camp, wild: wildSurface(content.landscape, { crossing: camp.crossing }), terrain: content.landscape });
  return { layout, sites, content, stage, camp, space };
};
const overlapArea = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.z + a.d, b.z + b.d) - Math.max(a.z, b.z));
const solidBoxesOf = (stage, room) => stage.boxes
  .filter((b) => b.solid && /^(site|wall|roof):/.test(b.occluder ?? '') && b.occluder.endsWith(':' + room))
  .map((b) => b.bounds ?? modelBounds(b));
const formal = (seed, extra = {}) => createSurvPlay(seed, {
  gameRules: true, settlementLife: true, regionalWork: true, independentWorld: true, ...extra,
});

// ── 01 遮挡 ─────────────────────────────────────────────────────────────────
test('EXP-RENDER-01 遮挡分件：建筑墙/屋顶/连廊各自成组，白名单只淡建筑，栅栏/田地/树/石不淡', () => {
  for (const [seed, version] of CASES) {
    const { stage } = build(seed, version);
    for (const room of ROOMS) {
      const wall = stage.boxes.filter((b) => b.occluder === 'wall:' + room);
      const roof = stage.boxes.filter((b) => b.occluder === 'roof:' + room);
      assert.ok(wall.length > 0, `${seed}/${version} ${room} 必须有 wall:${room} 分件（墙身/栏杆/塔身）`);
      assert.ok(roof.length > 0, `${seed}/${version} ${room} 必须有 roof:${room} 分件（屋盖）`);
    }
    // 玩家站在居所北侧（建筑挡在相机与人物之间）：命中的必须能真正淡出
    const site = staticCampSites(campSitesOf({ layout: version ? generateCampLayout(seed, version) : null, peripheralHomes: null })).home;
    const camera = campCamera({ x: site[0] + .5, z: site[1] + .5 - 2.5, width: 800, height: 450, span: 26, yaw: .29, pitch: .65 });
    const player = { x: site[0] + .5, y: 0, z: site[1] + .5 - 6 };
    const covered = coveredModels(camera, player, stage.boxes);
    assert.ok(covered.has('wall:home'), `玩家在居所后必须命中墙：${[...covered].join(',')}`);
    assert.ok(covered.has('roof:home'), `玩家在居所后必须命中屋顶：${[...covered].join(',')}`);
    const faded = fadeableCovered(covered);
    assert.ok(faded.includes('wall:home') && faded.includes('roof:home'), `真正淡出集合要含墙+屋顶：${faded.join(',')}`);
    // 栅栏/田地/作物/石/木料/资源/地标即使在 covered 里也不得进入淡出集合；
    // 树（tree:/wildtree:）自 2026-11-21 树可砍透明修复起必须淡出，否则玩家在树后永远看不见。
    for (const id of ['pen:0', 'pen:shelter', 'plot:bed-0', 'rock:5:6', 'timber:grove1', 'resource:yard', 'landmark:fork-cairn']) {
      assert.equal(fadesAsOccluder(id), false, `${id} 不得淡出`);
      assert.equal(fadeableCovered(new Set(['wall:home', id])).includes(id), false, `${id} 不得进入淡出集合`);
    }
    for (const id of ['tree:1:2', 'wildtree:3:4']) {
      assert.equal(fadesAsOccluder(id), true, `${id} 必须能淡出（树后玩家可见）`);
      assert.ok(fadeableCovered(new Set(['wall:home', id])).includes(id), `${id} 必须进入淡出集合`);
    }
  }
  // 死 cutout 必须删干净：shader 不再声明 uCutout，渲染器不再有抢跑分支
  const render = readFileSync(ROOM_WORLD + 'camp-3d-render.mjs', 'utf8');
  assert.equal(/uniform\s+mediump\s+vec4\s+uCutout/.test(render), false, 'web/camp-3d-render.mjs 不得再声明死 uniform uCutout');
  assert.equal(/uniform\.Cutout/.test(render), false, '不得再有 uniform.Cutout 的取址/上传');
  assert.equal(/gl\.uniform4f\(uniform\.Cutout/.test(render), false, '不得再有 cutout 分支的上传');
  // 白名单必须是显式常量并被 paintStage 复用（不是内联只认 roof 的正则）
  assert.ok(/export const FADE_OCCLUDERS\s*=\s*\/\^\(roof\|room-roof\|wall\|tree\|wildtree\)/.test(render), 'FADE_OCCLUDERS 白名单缺失（必须含 tree/wildtree）');
  assert.ok(/!fadesAsOccluder\(r\.id\)/.test(render), 'paintStage 必须复用 fadesAsOccluder 白名单');
  // 室外场景本身不再出现"整栋共用一个 site: 前缀"的屋顶：屋顶与墙必须能分开识别
  const { stage } = build(0, 0);
  const houseRoofs = stage.boxes.filter((b) => b.occluder === 'roof:home' && b.rot && b.h === .13);
  assert.equal(houseRoofs.length, 8, '居所屋顶 8 块斜板应归 roof:home');
});

// ── 02 桥 ───────────────────────────────────────────────────────────────────
test('EXP-RENDER-02 默认存档的桥可走：桥带/crossing/portal/高度同源，东岸 BFS 可达 ≥99%', () => {
  const { content, camp, space } = build(0, 0);
  assert.deepEqual(content.bridges, [[39, 33, 46, 36]], '默认存档画出来的桥带');
  assert.equal(camp.bridgeList.length, 1, 'space 必须拿到画出来的桥带');
  assert.equal(camp.crossing, 34, 'crossing 必须由桥带反推（不是兜底 24）');
  const [x0, z0, x1, z1] = camp.bridgeList[0];
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  assert.equal(space.walkable(cx, cz, CAMP_BODY_RADIUS), true, '桥心必须可站（玩家半径）');
  assert.equal(camp.classify(cx, cz), 'bridge', '桥心地面分类必须是 bridge 而不是 water');
  assert.ok(Math.abs(space.heightAt(cx, cz) - .32) < 1e-9, '桥面高度 .32');
  assert.ok(camp.portals.some((p) => p.kind === 'bridge'), 'space 里必须有 bridge portal');

  // 生产组合：服务端 sceneSpace 也必须一致（web/app.js 与 construction-access 同一条）
  const sp = formal(0, { mapSeed: 0, layoutVersion: 0 });
  const server = sceneSpace(sp.world);
  assert.ok(server, '服务端应有只读空间');
  assert.equal(server.crossing, camp.crossing);
  assert.equal(server.walkable(cx, cz, CAMP_BODY_RADIUS), true, '服务端 space 的桥心也必须可站');

  // 整图 0.5 格 BFS：西岸 -> 东岸
  const { riverCenter } = campTerrain(0, true, 0);
  const step = .5, nx = Math.round(TOWN_SIZE.width / step), nz = Math.round(TOWN_SIZE.depth / step);
  const ok = new Uint8Array(nx * nz);
  for (let j = 0; j < nz; j += 1) for (let i = 0; i < nx; i += 1)
    ok[j * nx + i] = space.walkable(i * step + step / 2, j * step + step / 2, CAMP_BODY_RADIUS) ? 1 : 0;
  const west = [], east = [];
  for (let j = 0; j < nz; j += 1) for (let i = 0; i < nx; i += 1) {
    if (!ok[j * nx + i]) continue;
    const z = j * step + step / 2;
    (i * step + step / 2 < riverCenter(z * 16) / 16 ? west : east).push(j * nx + i);
  }
  const label = new Int32Array(nx * nz).fill(-1);
  for (const seed of west) {
    if (label[seed] >= 0) continue;
    const id = west.length, q = [seed]; label[seed] = id;
    for (let h = 0; h < q.length; h += 1) {
      const k = q[h], i = k % nx, j = (k - i) / nx;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= nx || jj >= nz) continue;
        const kk = jj * nx + ii;
        if (label[kk] >= 0 || !ok[kk]) continue;
        label[kk] = id; q.push(kk);
      }
    }
  }
  const reach = east.filter((k) => label[k] >= 0).length;
  const pct = 100 * reach / Math.max(1, east.length);
  assert.ok(pct >= 99, `东岸可达 ${reach}/${east.length} = ${pct.toFixed(1)}%，应 ≥99%`);
});

// ── 03 入口 ─────────────────────────────────────────────────────────────────
test('EXP-RENDER-03 8 个房间入口不压实心、中心可站，camp_exit 落到可站位置', () => {
  for (const [seed, version] of CASES) {
    const { stage, space } = build(seed, version);
    for (const room of ROOMS) {
      const gate = stage.entrances[room];
      assert.ok(gate, `${room} 必须有入口矩形`);
      const solids = solidBoxesOf(stage, room);
      const solidOverlap = solids.reduce((sum, b) => sum + overlapArea(gate, b), 0);
      assert.ok(solidOverlap <= 1e-9, `${seed}/${version} ${room} 入口矩形不得压实心 AABB（${solidOverlap}）`);
      const center = [gate.x + gate.w / 2, gate.z + gate.d / 2];
      assert.equal(space.walkable(center[0], center[1], CAMP_BODY_RADIUS), true,
        `${seed}/${version} ${room} 入口中心必须可站（半径 ${CAMP_BODY_RADIUS}）`);
      const at = [gate.x + gate.w / 2, gate.z + gate.d * .72];
      assert.equal(space.walkable(at[0], at[1], CAMP_BODY_RADIUS), true, `${seed}/${version} ${room} 入口 at 必须可站`);
    }

    // 端到端：进每个房间再 camp_exit，玩家落点必须可站（r=.33）
    const sp = formal(seed, { mapSeed: seed, layoutVersion: version });
    const server = sceneSpace(sp.world);
    const liveSites = campSitesOf({
      rooms: sp.world.locs, districts: sp.world.districts, layout: sp.world.campLayout,
      peripheralHomes: sp.world.peripheralHomes,
    });
    for (const room of ROOMS) {
      sp.world.t += 1;   // 每个房间单独一拍，避免动作预算把后续进门判成 TIME_WAIT
      const gate = campEntrance(room, liveSites[room], sp.world.peripheralHomes);
      const from = [gate.x + gate.w * .5, gate.z + gate.d * .8];
      const entered = survAct(sp, { kind: 'move', room, entrance: true, from });
      assert.ok(entered.ok, `${seed}/${version} 从门口进 ${room} 应成功：${JSON.stringify(entered)}`);
      const exited = survAct(sp, { kind: 'camp_exit' });
      assert.ok(exited.ok, `${room} camp_exit 应成功`);
      const door = posOf(sp.world, 'p1');
      assert.ok(door, `${room} camp_exit 后应有世界位置`);
      assert.equal(server.walkable(door.x, door.z, CAMP_BODY_RADIUS), true,
        `${seed}/${version} ${room} camp_exit 落点 (${door.x.toFixed(2)},${door.z.toFixed(2)}) 必须可站`);
    }
  }
});

// ── 04 天气 ─────────────────────────────────────────────────────────────────
const frame = (view) => ({ ...view, sun: solarLight(12, 24, 1, { storm: view.storm, overcast: view.overcast }) });
test('EXP-RENDER-04 天气跨日不再一帧硬切：10–30s 平滑、30s 到位、端点与旧硬切一致', () => {
  // 端点：晴 / 雨 / 暴雨 / 雪
  const t = (w) => climateTargets(campClimate(w));
  assert.deepEqual(t({ weather: 'clear' }), { rain: 0, storm: 0, snow: 0, frost: 0, wet: 0 });
  assert.deepEqual(t({ weather: 'rain' }), { rain: 1, storm: 0, snow: 0, frost: 0, wet: .65 });
  assert.deepEqual(t({ weather: 'rain', disasterToday: 'storm' }), { rain: 1, storm: 1, snow: 0, frost: 0, wet: .95 });
  assert.deepEqual(t({ weather: 'cold', season: '冬' }), { rain: 0, storm: 0, snow: 1, frost: 0, wet: 0 });
  assert.deepEqual(t({ disasterToday: 'coldsnap' }), { rain: 0, storm: 0, snow: 1, frost: 1, wet: 0 });

  // 晴 → 雨：一帧（1/60s）的变化必须 < 0.02 / < 1 条雨滴
  const view = createClimateView();
  const clear = frame(view.update({ weather: 'clear' }, 0, { snap: true }) && view.view());
  const rain = campClimate({ weather: 'rain', season: '春' });
  view.update(rain, 1 / 60);
  const oneFrame = frame(view.view());
  const delta = (k) => Math.abs(oneFrame[k] - clear[k]);
  assert.ok(delta('wetness') < .02, `一帧湿地面跳变 ${delta('wetness')}`);
  assert.ok(delta('wind') < .02, `一帧风力跳变 ${delta('wind')}`);
  assert.ok(delta('rain') < .02, `一帧降雨强度跳变 ${delta('rain')}`);
  const lightOne = solarLight(12, 24, 1, { storm: oneFrame.storm, overcast: oneFrame.overcast }).direct;
  const lightClear = solarLight(12, 24, 1, { storm: clear.storm, overcast: clear.overcast }).direct;
  assert.ok(Math.abs(lightOne - lightClear) / Math.max(1e-9, lightClear) < .02, '一帧光照跳变必须 <2%');
  const dropsOne = weatherDrops(oneFrame), dropsClear = weatherDrops(clear);
  assert.ok(Math.abs(dropsOne.rain - dropsClear.rain) < 1, '一帧雨滴条数跳变必须 <1 条');

  // 30s 内到位（误差 < 1e-3）：雨 .65 / 风 1.15 / 光 .79 倍 / 雨滴 48
  for (let i = 0; i < 30 * 60; i += 1) view.update(rain, 1 / 60);
  const reached = view.view();
  assert.ok(Math.abs(reached.rain - 1) < 1e-3 && Math.abs(reached.wetness - .65) < 1e-3, `30s 未到位：${JSON.stringify(reached)}`);
  assert.ok(Math.abs(reached.wind - 1.15) < 1e-3, `风力端点 ${reached.wind} ≠ 1.15`);
  assert.ok(Math.abs(reached.snow) < 1e-3, '雨不应带积雪');
  assert.equal(weatherDrops(reached).rain, 48);
  const sunRain = solarLight(12, 24, 1, { storm: reached.storm, overcast: reached.overcast });
  const sunClear = solarLight(12, 24, 1, { storm: 0, overcast: 0 });
  const sunStormDay = solarLight(12, 24, 1, { storm: 1, overcast: 1 });
  assert.ok(Math.abs(sunRain.light[0] / sunClear.light[0] - .79) < 1e-9, '雨=旧 .79 倍端点');
  assert.ok(Math.abs(sunStormDay.light[0] / sunClear.light[0] - .63) < 1e-9, '暴雨=旧 .63 倍端点');

  // 雨 → 暴雨：风 0.55/1.15/2.7 三端点，雨滴 48→86 连续
  const stormTarget = campClimate({ weather: 'rain', disasterToday: 'storm' });
  const stormView = createClimateView();
  stormView.update(rain, 0, { snap: true });
  let previous = frame(stormView.view());
  let maxWindStep = 0, maxDropStep = 0;
  for (let i = 0; i < 20 * 60; i += 1) {
    stormView.update(stormTarget, 1 / 60);
    const now = frame(stormView.view());
    maxWindStep = Math.max(maxWindStep, Math.abs(now.wind - previous.wind));
    maxDropStep = Math.max(maxDropStep, Math.abs(weatherDrops(now).storm - weatherDrops(previous).storm));
    previous = now;
  }
  assert.ok(maxWindStep < .02, `暴雨过渡单帧风力跳变 ${maxWindStep}`);
  assert.ok(maxDropStep <= 1, `暴雨过渡单帧雨滴跳变 ${maxDropStep}（允许 1 条取整）`);
  assert.ok(Math.abs(previous.wind - 2.7) < 1e-3, `暴雨风力端点 ${previous.wind} ≠ 2.7`);
  assert.ok(Math.abs(previous.wetness - .95) < 1e-3, `暴雨湿度端点 ${previous.wetness} ≠ .95`);
  assert.equal(weatherDrops(previous).storm, 86);

  // 速率上限：一次 0.5s 长帧也不允许越过一帧该走的量；snap 才允许直接到位
  const slow = createClimateView();
  slow.update({ weather: 'clear' }, 0, { snap: true });
  slow.update(rain, 10);
  assert.ok(slow.view().rain <= .5 / CLIMATE_FADE.rain.up + 1e-9, '长帧必须夹住步长（上一帧不会一帧走完）');
  slow.update(rain, 0, { snap: true });
  assert.equal(slow.view().rain, 1, 'snap 必须直接到目标');

  // 水花/落叶随强度淡入：强度 0 不生成，0.05 明显少于 1.0
  const ctx = { time: .78, focus: [30, 24], bounds: { west: 0, east: 120, north: 0, south: 80 }, surface: () => ({ y: 0, water: false }) };
  assert.deepEqual(stormEffects({ ...ctx, active: false }), []);
  assert.deepEqual(stormEffects({ ...ctx, active: true, intensity: 0 }), []);
  const weak = stormEffects({ ...ctx, active: true, intensity: .05 }).length;
  const full = stormEffects({ ...ctx, active: true, intensity: 1 }).length;
  assert.ok(weak < full, `低强度水花 ${weak} 应少于满强度 ${full}`);
});
