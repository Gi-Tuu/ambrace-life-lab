// 只读审计脚本：入口矩形 vs 建筑 footprint vs 可达性。
// 用法: node evidence/exp-audit-render/entrance-audit.mjs [mapSeed] [layoutVersion]
import { CAMP_SITES, campEntrance, campSite } from '../../shared/camp-interaction.mjs';
import { generateCampLayout } from '../../shared/camp-layout.mjs';
import { campSitesOf, staticCampSites, campSceneBundle } from '../../shared/camp-scene-content.mjs';
import { createSpace, campSurface, wildSurface } from '../../life/space.mjs';
import { roomStage, homeStyle } from '../../shared/camp-scene.mjs';
import { hallFrontGeometry, roomPropsPx, ROOM_DOOR_WORLD } from '../../shared/room-layout.mjs';
import { CAMP_BODY_RADIUS } from '../../shared/camp-physics.mjs';
import { modelBounds } from '../../shared/camp-geometry.mjs';

const mapSeed = Number(process.argv[2] ?? 7);
const layoutVersion = Number(process.argv[3] ?? 2);
const layout = layoutVersion ? generateCampLayout(mapSeed, layoutVersion) : null;
const sites = staticCampSites(campSitesOf({ layout, peripheralHomes: null }));
const { content, stage } = campSceneBundle({ mapSeed, layoutVersion, layout, camp: true, timber: false, sites });
const space = createSpace({
  camp: campSurface({ mapSeed, layoutVersion, layout, stage, terrain: content.landscape }),
  wild: wildSurface(content.landscape, { crossing: layout?.crossZ ?? 24 }),
  terrain: content.landscape,
});

const area = r => r &&
  Math.max(0, Math.min(r.x + r.w, ...[] ) ) ; // unused
function overlapArea(a, b) {
  const w = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const d = Math.max(0, Math.min(a.z + a.d, b.z + b.d) - Math.max(a.z, b.z));
  return w * d;
}
const boundsOf = boxes => {
  if (!boxes.length) return null;
  let x = Infinity, z = Infinity, X = -Infinity, Z = -Infinity, y = Infinity, Y = -Infinity;
  for (const b of boxes) {
    const r = b.bounds ?? modelBounds(b) ?? b;
    x = Math.min(x, r.x); z = Math.min(z, r.z);
    X = Math.max(X, r.x + r.w); Z = Math.max(Z, r.z + r.d);
    y = Math.min(y, r.y); Y = Math.max(Y, r.y + r.h);
  }
  return { x, z, w: X - x, d: Z - z, y, h: Y - y };
};
const r2 = v => Math.round(v * 100) / 100;
const fmt = b => b ? `[${r2(b.x)},${r2(b.x + b.w)}] x [${r2(b.z)},${r2(b.z + b.d)}] (${r2(b.w)}x${r2(b.d)})` : 'null';

console.log(`# 入口审计 mapSeed=${mapSeed} layoutVersion=${layoutVersion}  (1 单位 = 1 tile = 16px, 玩家半径 ${CAMP_BODY_RADIUS})`);

const rooms = Object.keys(sites);
const rows = [];
for (const room of rooms) {
  const gate = stage.entrances?.[room] ?? campEntrance(room, sites[room]);
  const group = stage.boxes.filter(b => b.occluder === `site:${room}` || b.occluder === `roof:${room}`);
  const solids = group.filter(b => b.solid);
  const foot = boundsOf(group), footSolid = boundsOf(solids);
  const solidBoxes = solids.map(b => b.bounds ?? modelBounds(b) ?? b);
  // 入口矩形与 footprint 的关系
  const inFoot = foot && overlapArea(gate, foot) / (gate.w * gate.d);
  const c = [gate.x + gate.w / 2, gate.z + gate.d / 2];
  const at = [gate.x + gate.w / 2, gate.z + gate.d * .72];
  // 矩形里有多少面积落在 solid AABB 内
  let solidOverlap = 0;
  for (const b of solidBoxes) solidOverlap += overlapArea(gate, b);
  rows.push({
    room, gate: { x: r2(gate.x), z: r2(gate.z), w: r2(gate.w), d: r2(gate.d) },
    footprint: foot && { x: r2(foot.x), z: r2(foot.z), w: r2(foot.w), d: r2(foot.d) },
    gateCenter: c.map(r2), gateAt: at.map(r2),
    rectInFootprintPct: r2((inFoot ?? 0) * 100),
    rectOnSolidPct: r2(Math.min(1, solidOverlap / (gate.w * gate.d)) * 100),
    centerInsideFootprint: Boolean(foot && c[0] >= foot.x && c[0] <= foot.x + foot.w && c[1] >= foot.z && c[1] <= foot.z + foot.d),
    centerInsideSolid: solidBoxes.some(b => c[0] >= b.x && c[0] <= b.x + b.w && c[1] >= b.z && c[1] <= b.z + b.d),
    centerWalkable: space.walkable(c[0], c[1], 0),
    centerWalkableR: space.walkable(c[0], c[1], CAMP_BODY_RADIUS),
    centerColliders: space.collidersNear(c[0], c[1], CAMP_BODY_RADIUS).length,
    atWalkableR: space.walkable(at[0], at[1], CAMP_BODY_RADIUS),
    // 站在矩形外 0.1 处能否交互（客户端 reach=.1 用的是 distanceToRect(rect)）
    outsideReachable: (() => {
      for (const [px, pz] of [[c[0], gate.z - .1], [c[0], gate.z + gate.d + .1],
        [gate.x - .1, c[1]], [gate.x + gate.w + .1, c[1]]]) {
        if (space.walkable(px, pz, CAMP_BODY_RADIUS)) return true;
      }
      return false;
    })(),
    blockers: space.collidersNear(c[0], c[1], .9).map(b => b.kind + '@' + r2(b.x) + ',' + r2(b.z) + ' ' + r2(b.w) + 'x' + r2(b.d)),
  });
}
for (const row of rows) console.log(JSON.stringify(row));

// 室内房间：门 vs 房间几何（16×12）
console.log('\n# 室内房间门（ROOM_DOOR_WORLD = ' + JSON.stringify(ROOM_DOOR_WORLD) + '）与房间结构');
for (const room of rooms) {
  const personal = false;
  const props = roomPropsPx(room, { personal });
  const st = roomStage(room, props, hallFrontGeometry(), 16, 12, homeStyle(room, mapSeed));
  const door = ROOM_DOOR_WORLD;
  const roof = boundsOf(st.boxes.filter(b => b.occluder === `room-roof:${room}` || b.occluder === `wall:0` || b.occluder === `wall:14`));
  const solids = st.boxes.filter(b => b.solid);
  const solidInDoor = solids.filter(b => (b.bounds ?? modelBounds(b) ?? b) &&
    overlapArea(door, b.bounds ?? modelBounds(b) ?? b) > 0).map(b => b.occluder);
  console.log(JSON.stringify({ room, walkBounds: st.walkBounds, doorInWalkBounds:
    door.x >= st.walkBounds.left && door.x + door.w <= st.walkBounds.right && door.z + door.d <= st.walkBounds.bottom,
    structuralOccluders: [...new Set(st.boxes.filter(b => b.occluder).map(b => b.occluder))],
    roofBounds: roof && { x: r2(roof.x), z: r2(roof.z), w: r2(roof.w), d: r2(roof.d) },
    doorOverlapsSolids: [...new Set(solidInDoor)] }));
}
