// 只读审计脚本：住宅（house1..N）入口矩形 vs 自宅 footprint / 可站性。
// 住宅走 campEntrance 的 residentialSite 分支（shared/camp-interaction.mjs:22），和 home/store/workshop 的兜底分支不同。
import { createSurvPlay } from '../../life/survplay.mjs';
import { homeAppearance, outdoorHomes } from '../../shared/camp-scene.mjs';
import { sceneSpace } from '../../life/construction-access.mjs';
import { CAMP_BODY_RADIUS } from '../../shared/camp-physics.mjs';
import { modelBounds } from '../../shared/camp-geometry.mjs';
import { residentialSite, homeLot } from '../../shared/camp-layout.mjs';

const mapSeed = Number(process.argv[2] ?? 7), layoutVersion = Number(process.argv[3] ?? 2);
const sp = createSurvPlay(7, { gameRules: true, settlementLife: true, regionalWork: true, independentWorld: true,
  gameRulesOn: true, households: true, mapSeed, layoutVersion });
const w = sp.world;
// 客户端 world 里布局在 world.layout（web/app.js 从 view 拷过来）；服务端叫 campLayout。
w.layout = w.campLayout;
// 强制一栋已入住的住宅，走和正式路径相同的 outdoorHomes 分支
w.households = { deeds: { house1: { owner: 'p1', resident: true } } };
const appearance = [['house1', true, 0]];
const homes = outdoorHomes(w, appearance);
const space = sceneSpace(w);
const r2 = v => Math.round(v * 100) / 100;
for (const [room, rect] of Object.entries(homes.entrances)) {
  const lot = homeLot(room, w.campLayout, w.peripheralHomes);
  const group = homes.boxes.filter(b => b.occluder === `work:${room}:house`);
  const solids = group.filter(b => b.solid).map(b => b.bounds ?? modelBounds(b) ?? b);
  const boxes = group.map(b => b.bounds ?? modelBounds(b) ?? b);
  const bd = boxes.length ? {
    x: Math.min(...boxes.map(b => b.x)), z: Math.min(...boxes.map(b => b.z)),
    X: Math.max(...boxes.map(b => b.x + b.w)), Z: Math.max(...boxes.map(b => b.z + b.d)),
  } : null;
  const c = [rect.x + rect.w / 2, rect.z + rect.d / 2];
  const overlap = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.z + a.d, b.z + b.d) - Math.max(a.z, b.z));
  console.log(JSON.stringify({
    room, lot, gate: { x: r2(rect.x), z: r2(rect.z), w: r2(rect.w), d: r2(rect.d) },
    meshZ: bd && [r2(bd.z), r2(bd.Z)], homeFront: r2(lot.z + lot.d - .25),
    gateOnMeshPct: bd ? r2(100 * overlap(rect, { x: bd.x, z: bd.z, w: bd.X - bd.x, d: bd.Z - bd.z }) / (rect.w * rect.d)) : null,
    gateOnSolidPct: r2(100 * Math.min(1, solids.reduce((s, b) => s + overlap(rect, b), 0) / (rect.w * rect.d))),
    center: c.map(r2), centerWalkableR: space.walkable(c[0], c[1], CAMP_BODY_RADIUS),
    centerColliders: space.collidersNear(c[0], c[1], CAMP_BODY_RADIUS).map(b => b.kind),
    outsideReachable: [[c[0], rect.z - .1], [c[0], rect.z + rect.d + .1], [rect.x - .1, c[1]], [rect.x + rect.w + .1, c[1]]]
      .some(([x, z]) => space.walkable(x, z, CAMP_BODY_RADIUS)),
  }));
}
