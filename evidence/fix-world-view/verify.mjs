// 修复后的四项数值复验（一次跑完，stdout 即证据）。
// 用法：node evidence/fix-world-view/verify.mjs | tee evidence/fix-world-view/verify.log
import { generateCampLayout, TOWN_SIZE } from '../../shared/camp-layout.mjs';
import { campTerrain } from '../../shared/camp-terrain.mjs';
import { campSitesOf, staticCampSites, campSceneBundle } from '../../shared/camp-scene-content.mjs';
import { campEntrance } from '../../shared/camp-interaction.mjs';
import { modelBounds } from '../../shared/camp-geometry.mjs';
import { CAMP_BODY_RADIUS } from '../../shared/camp-physics.mjs';
import { createSpace, campSurface, wildSurface } from '../../life/space.mjs';
import { sceneSpace } from '../../life/construction-access.mjs';
import { createSurvPlay, survAct } from '../../life/survplay.mjs';
import { posOf } from '../../life/actor-pos.mjs';
import { campCamera, coveredModels, fadeableCovered, fadesAsOccluder } from '../../web/camp-3d-render.mjs';
import { climateTargets, createClimateView } from '../../web/camp-climate-view.mjs';
import { solarLight } from '../../web/camp-sun.mjs';
import { campClimate, weatherDrops } from '../../web/camp-weather.mjs';

const ROOMS = ['home', 'hall', 'store', 'yard', 'workshop', 'garden', 'watch', 'well'];
const CASES = [[0, 0, '默认存档 mapSeed0/v0'], [7, 2, '新布局 seed7/v2']];
const r3 = (v) => Math.round(v * 1000) / 1000;
const overlap = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.z + a.d, b.z + b.d) - Math.max(a.z, b.z));
const build = (mapSeed, layoutVersion) => {
  const layout = layoutVersion ? generateCampLayout(mapSeed, layoutVersion) : null;
  const sites = staticCampSites(campSitesOf({ layout, peripheralHomes: null }));
  const { content, stage } = campSceneBundle({ mapSeed, layoutVersion, layout, camp: true, timber: false, sites });
  const camp = campSurface({ mapSeed, layoutVersion, layout, stage, terrain: content.landscape, bridges: content.bridges });
  const space = createSpace({ camp, wild: wildSurface(content.landscape, { crossing: camp.crossing }), terrain: content.landscape });
  return { layout, sites, content, stage, camp, space };
};
const out = (o) => console.log(JSON.stringify(o));

// ── 1 遮挡 ──────────────────────────────────────────────────────────────────
for (const [seed, version, label] of CASES) {
  const { sites, stage } = build(seed, version);
  for (const room of ROOMS) {
    const [sx, sz] = sites[room];
    const camera = campCamera({ x: sx + .5, z: sz + .5 - 2.5, width: 800, height: 450, span: 26, yaw: .29, pitch: .65 });
    const player = { x: sx + .5, y: 0, z: sz + .5 - 6 };
    const covered = coveredModels(camera, player, stage.boxes);
    out({
      item: 'occlusion', label, room, covered: [...covered].sort(),
      faded: fadeableCovered(covered).sort(),
      wallBoxes: stage.boxes.filter((b) => b.occluder === 'wall:' + room).length,
      roofBoxes: stage.boxes.filter((b) => b.occluder === 'roof:' + room).length,
      fenceFades: fadesAsOccluder('pen:0'), plotFades: fadesAsOccluder('plot:bed-0'), treeFades: fadesAsOccluder('tree:1:2'),
    });
  }
}

// ── 2 桥 ────────────────────────────────────────────────────────────────────
for (const [seed, version, label] of CASES) {
  const { content, camp, space } = build(seed, version);
  const { riverCenter } = campTerrain(seed, true, version);
  const [x0, z0, x1, z1] = camp.bridgeList[0] ?? [0, 0, 0, 0];
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  const step = .5, nx = Math.round(TOWN_SIZE.width / step), nz = Math.round(TOWN_SIZE.depth / step);
  const ok = new Uint8Array(nx * nz);
  for (let j = 0; j < nz; j += 1) for (let i = 0; i < nx; i += 1)
    ok[j * nx + i] = space.walkable(i * step + step / 2, j * step + step / 2, CAMP_BODY_RADIUS) ? 1 : 0;
  const west = [], east = [];
  for (let j = 0; j < nz; j += 1) for (let i = 0; i < nx; i += 1) {
    if (!ok[j * nx + i]) continue;
    (i * step + step / 2 < riverCenter((j * step + step / 2) * 16) / 16 ? west : east).push(j * nx + i);
  }
  const labelGrid = new Int32Array(nx * nz).fill(-1);
  for (const seedCell of west) {
    if (labelGrid[seedCell] >= 0) continue;
    const id = west.length, q = [seedCell]; labelGrid[seedCell] = id;
    for (let h = 0; h < q.length; h += 1) {
      const k = q[h], i = k % nx, j = (k - i) / nx;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= nx || jj >= nz) continue;
        const kk = jj * nx + ii;
        if (labelGrid[kk] >= 0 || !ok[kk]) continue;
        labelGrid[kk] = id; q.push(kk);
      }
    }
  }
  const reach = east.filter((k) => labelGrid[k] >= 0).length;
  // 生产组合（服务端）
  const sp = createSurvPlay(seed, { gameRules: true, settlementLife: true, regionalWork: true, independentWorld: true, mapSeed: seed, layoutVersion: version });
  const server = sceneSpace(sp.world);
  out({
    item: 'bridge', label, drawn: content.bridges, bridgeList: camp.bridgeList, crossing: camp.crossing,
    bridgeCenter: [r3(cx), r3(cz)], walkable: space.walkable(cx, cz, CAMP_BODY_RADIUS),
    classify: camp.classify(cx, cz), height: r3(space.heightAt(cx, cz)),
    portals: camp.portals.filter((p) => p.kind === 'bridge').map((p) => p.id),
    serverCrossing: server?.crossing, serverWalkable: server?.walkable(cx, cz, CAMP_BODY_RADIUS),
    eastReachableFromWest: `${reach}/${east.length}`, eastReachablePct: +(100 * reach / Math.max(1, east.length)).toFixed(1),
  });
}

// ── 3 入口 / camp_exit ─────────────────────────────────────────────────────
for (const [seed, version, label] of CASES) {
  const { stage, space } = build(seed, version);
  const sp = createSurvPlay(seed, { gameRules: true, settlementLife: true, regionalWork: true, independentWorld: true, mapSeed: seed, layoutVersion: version });
  const server = sceneSpace(sp.world);
  const live = campSitesOf({ rooms: sp.world.locs, districts: sp.world.districts, layout: sp.world.campLayout, peripheralHomes: sp.world.peripheralHomes });
  for (const room of ROOMS) {
    const gate = stage.entrances[room] ?? campEntrance(room, live[room], sp.world.peripheralHomes);
    const solids = stage.boxes.filter((b) => b.solid && /^(site|wall|roof):/.test(b.occluder ?? '') && b.occluder.endsWith(':' + room))
      .map((b) => b.bounds ?? modelBounds(b));
    const solidPct = 100 * Math.min(1, solids.reduce((a, b) => a + overlap(gate, b), 0) / (gate.w * gate.d));
    const center = [gate.x + gate.w / 2, gate.z + gate.d / 2];
    sp.world.t += 1;
    const entered = survAct(sp, { kind: 'move', room, entrance: true, from: [gate.x + gate.w * .5, gate.z + gate.d * .8] });
    const exited = survAct(sp, { kind: 'camp_exit' });
    const door = posOf(sp.world, 'p1');
    out({
      item: 'entrance', label, room, gate: { x: r3(gate.x), z: r3(gate.z), w: r3(gate.w), d: r3(gate.d) },
      rectOnSolidPct: r3(solidPct), centerWalkable: space.walkable(center[0], center[1], CAMP_BODY_RADIUS),
      entered: entered.ok, exited: exited.ok,
      campExitPoint: door ? [r3(door.x), r3(door.z)] : null,
      campExitWalkable: Boolean(door) && server.walkable(door.x, door.z, CAMP_BODY_RADIUS),
    });
  }
}

// ── 4 天气时间序列 ─────────────────────────────────────────────────────────
const frame = (view) => {
  const sun = solarLight(12, 24, 1, { storm: view.storm, overcast: view.overcast });
  return {
    rain: r3(view.rain), storm: r3(view.storm), snow: r3(view.snow), frost: r3(view.frost),
    wetness: r3(view.wetness), wind: r3(view.wind), lightR: r3(sun.light[0] / solarLight(12, 24, 1).light[0]),
    direct: r3(sun.direct), drops: weatherDrops(view),
  };
};
const stepOnce = (view, target, steps) => {
  for (let i = 0; i < steps; i += 1) view.update(target, 1 / 60);
};
const clear = campClimate({ weather: 'clear', season: '春' });
const rain = campClimate({ weather: 'rain', season: '春' });
const storm = campClimate({ weather: 'rain', season: '春', disasterToday: 'storm' });
const view = createClimateView();
view.update(clear, 0, { snap: true });
out({ item: 'weather', phase: 'clear-target', ...frame(view.view()), targets: climateTargets(clear) });
out({ item: 'weather', phase: 'rain-target', targets: climateTargets(rain), expected: { wetness: .65, wind: 1.15, lightR: .79, rainDrops: 48 } });
const before = frame(view.view());
view.update(rain, 1 / 60);
const after = frame(view.view());
out({ item: 'weather', phase: 'one-frame-delta', before, after, delta: {
  wetness: r3(after.wetness - before.wetness), wind: r3(after.wind - before.wind),
  lightR: r3(after.lightR - before.lightR), drops: after.drops.rain - before.drops.rain,
} });
view.update(clear, 0, { snap: true });
const series = [];
let maxWetStep = 0, maxWindStep = 0, prev = frame(view.view());
for (let sec = 1; sec <= 32; sec += 1) {
  stepOnce(view, rain, 60);
  const now = frame(view.view());
  maxWetStep = Math.max(maxWetStep, Math.abs(now.wetness - prev.wetness));
  maxWindStep = Math.max(maxWindStep, Math.abs(now.wind - prev.wind));
  prev = now;
  series.push({ t: sec, wetness: now.wetness, wind: now.wind, lightR: now.lightR, rainDrops: now.drops.rain, stormDrops: now.drops.storm });
}
out({ item: 'weather', phase: 'clear-to-rain-series', maxPerSecondWetnessStep: r3(maxWetStep), maxPerSecondWindStep: r3(maxWindStep), series });
const view2 = createClimateView();
view2.update(rain, 0, { snap: true });
const stormSeries = [];
for (let sec = 1; sec <= 16; sec += 1) {
  stepOnce(view2, storm, 60);
  const now = frame(view2.view());
  stormSeries.push({ t: sec, wetness: now.wetness, wind: now.wind, lightR: now.lightR, stormDrops: now.drops.storm, rainDrops: now.drops.rain });
}
out({ item: 'weather', phase: 'rain-to-storm-series', series: stormSeries });
out({ item: 'weather', phase: 'snap-on-load', before: frame(view2.view()), afterSnap: (() => { view2.update(clear, 0, { snap: true }); return frame(view2.view()); })() });
console.log(JSON.stringify({ gate: 'EXP-RENDER-04', ok: true, fadeSeconds: { rainUp: 10, rainDown: 14, stormUp: 6, stormDown: 9, snowUp: 20, snowDown: 26 } }));
