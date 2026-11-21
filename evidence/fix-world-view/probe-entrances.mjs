// 只读探针：入口矩形候选 vs 实体 footprint vs 可站性（默认存档 mapSeed0/layout0 与 v2 对照）。
// 用法：node evidence/fix-world-view/probe-entrances.mjs [mapSeed] [layoutVersion]
import { campEntrance } from '../../shared/camp-interaction.mjs';
import { generateCampLayout } from '../../shared/camp-layout.mjs';
import { campSitesOf, staticCampSites, campSceneBundle } from '../../shared/camp-scene-content.mjs';
import { createSpace, campSurface, wildSurface } from '../../life/space.mjs';
import { CAMP_BODY_RADIUS } from '../../shared/camp-physics.mjs';
import { modelBounds } from '../../shared/camp-geometry.mjs';

const mapSeed = Number(process.argv[2] ?? 0);
const layoutVersion = Number(process.argv[3] ?? 0);
const layout = layoutVersion ? generateCampLayout(mapSeed, layoutVersion) : null;
const sites = staticCampSites(campSitesOf({ layout, peripheralHomes: null }));
const { content, stage } = campSceneBundle({ mapSeed, layoutVersion, layout, camp: true, timber: false, sites });
const camp = campSurface({ mapSeed, layoutVersion, layout, stage, terrain: content.landscape, bridges: content.bridges });
const space = createSpace({ camp, wild: wildSurface(content.landscape, { crossing: camp.crossing }), terrain: content.landscape });

const overlap = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.z + a.d, b.z + b.d) - Math.max(a.z, b.z));
const boundsOf = (boxes) => {
  const r = boxes.map((b) => b.bounds ?? modelBounds(b) ?? b);
  return { x: Math.min(...r.map((b) => b.x)), z: Math.min(...r.map((b) => b.z)),
    w: Math.max(...r.map((b) => b.x + b.w)) - Math.min(...r.map((b) => b.x)),
    d: Math.max(...r.map((b) => b.z + b.d)) - Math.min(...r.map((b) => b.z)) };
};
const r2 = (v) => Math.round(v * 100) / 100;
function report(room, gate) {
  const group = stage.boxes.filter((b) => /^(site|wall|roof):/.test(b.occluder ?? '') && b.occluder.endsWith(':' + room));
  const foot = boundsOf(group);
  const solids = group.filter((b) => b.solid).map((b) => b.bounds ?? modelBounds(b) ?? b);
  const solidArea = solids.reduce((a, b) => a + overlap(gate, b), 0);
  const c = [gate.x + gate.w / 2, gate.z + gate.d / 2];
  const at = [gate.x + gate.w / 2, gate.z + gate.d * .72];
  const probes = [[c[0], gate.z - .1], [c[0], gate.z + gate.d + .1], [gate.x - .1, c[1]], [gate.x + gate.w + .1, c[1]]];
  return {
    room,
    gate: { x: r2(gate.x), z: r2(gate.z), w: r2(gate.w), d: r2(gate.d) },
    footprint: { x: r2(foot.x), z: r2(foot.z), w: r2(foot.w), d: r2(foot.d) },
    rectInFootprintPct: r2(100 * overlap(gate, foot) / (gate.w * gate.d)),
    rectOnSolidPct: r2(100 * Math.min(1, solidArea / (gate.w * gate.d))),
    centerWalkableR: space.walkable(c[0], c[1], CAMP_BODY_RADIUS),
    atWalkableR: space.walkable(at[0], at[1], CAMP_BODY_RADIUS),
    outsideReachable: probes.some((p) => space.walkable(p[0], p[1], CAMP_BODY_RADIUS)),
    centerColliders: space.collidersNear(c[0], c[1], CAMP_BODY_RADIUS).map((b) => b.kind),
  };
}
const rooms = Object.keys(sites);
for (const room of rooms) console.log(JSON.stringify(report(room, stage.entrances[room] ?? campEntrance(room, sites[room]))));

// 候选：house 前脸外沿 / 瞭台台阶脚下。只打印，不改源码。
const HOUSE = (room) => {
  const [sx, sy] = sites[room];
  return { x: sx - 1.15, z: sy - 1.2 + .06, w: 2.3, d: 1.2 };
};
const WATCH = (room) => {
  const [sx, sy] = sites[room];
  return { x: sx - .45, z: sy - 1.25 + .10, w: 1.9, d: 1.35 };
};
const HALL = (room) => { const [sx, sy] = sites[room]; const x = sx + .5, z = sy + .5; return { x: x - 1, z: z - 1.35, w: 2, d: 2.25 }; };
console.log('# 候选');
for (const room of ['home', 'store', 'workshop']) console.log(JSON.stringify(report(room, HOUSE(room))));
console.log(JSON.stringify(report('watch', WATCH('watch'))));
console.log(JSON.stringify(report('hall', HALL('hall'))));

// 瞭台附近岩石：落在塔身/入口候选里的
const rocks = stage.boxes.filter((b) => (b.occluder ?? '').startsWith('rock:'));
const [wx, wz] = sites.watch;
const near = rocks.filter((b) => {
  const r = b.bounds ?? modelBounds(b);
  return Math.hypot(r.x + r.w / 2 - (wx + .5), r.z + r.d / 2 - (wz + .5)) < 8;
});
console.log('# 瞭台 8 格内岩石 occluder', JSON.stringify([...new Set(near.map((b) => b.occluder))]));
const entry = WATCH('watch');
console.log('# 入口候选压到的岩石', JSON.stringify([...new Set(near.filter((b) => overlap(entry, b.bounds ?? modelBounds(b)) > 0).map((b) => b.occluder))]));
console.log('# 入口候选四邻压到的岩石', JSON.stringify([...new Set(near.filter((b) => {
  const c = [entry.x + entry.w / 2, entry.z + entry.d / 2];
  return [[c[0], entry.z - .4], [c[0], entry.z + entry.d + .4], [entry.x - .4, c[1]], [entry.x + entry.w + .4, c[1]]]
    .some(([px, pz]) => Math.hypot(px - (b.bounds ?? modelBounds(b)).x, pz - (b.bounds ?? modelBounds(b)).z) < 2);
}).map((b) => b.occluder))]));
