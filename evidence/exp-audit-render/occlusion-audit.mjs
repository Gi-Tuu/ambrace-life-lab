// 只读审计脚本：遮挡判定集合 vs 渲染器真正淡出的集合。
// 用法: node evidence/exp-audit-render/occlusion-audit.mjs [mapSeed] [layoutVersion]
import { campCamera, coveredModels } from '../../web/camp-3d-render.mjs';
import { generateCampLayout } from '../../shared/camp-layout.mjs';
import { campSitesOf, staticCampSites, campSceneBundle } from '../../shared/camp-scene-content.mjs';
import { modelBounds } from '../../shared/camp-geometry.mjs';

const mapSeed = Number(process.argv[2] ?? 7);
const layoutVersion = Number(process.argv[3] ?? 2);
const layout = layoutVersion ? generateCampLayout(mapSeed, layoutVersion) : null;
const sites = staticCampSites(campSitesOf({ layout, peripheralHomes: null }));
const { content, stage } = campSceneBundle({ mapSeed, layoutVersion, layout, camp: true, timber: false, sites });

const ROOF = /^(roof|room-roof):/;
// paintStage 的真实判据（camp-3d-render.mjs:832 / 841）：
//   isRoof = /^(roof|room-roof):/.test(id)
//   if (isRoof && cutout) -> 走 cutout 分支（不淡出）
//   if (!covered.has(id) || !isRoof) continue -> 非屋顶永远不淡出
const wouldFade = (covered, cutout) => [...covered].filter(id => ROOF.test(id) && !cutout);
const neverFade = covered => [...covered].filter(id => !ROOF.test(id));

// 1) occluder 清单：谁能被 coveredModels 收集，谁会淡出
const ids = new Map();
for (const b of stage.boxes) {
  const key = b.occluder ?? '(无 occluder)';
  const e = ids.get(key) ?? { id: key, boxes: 0, fx: 0, solid: 0, minY: Infinity, maxY: -Infinity };
  const r = b.bounds ?? modelBounds(b) ?? b;
  e.boxes += 1;
  if (b.fx) e.fx += 1;
  if (b.solid) e.solid += 1;
  e.minY = Math.min(e.minY, r.y); e.maxY = Math.max(e.maxY, r.y + r.h);
  ids.set(key, e);
}
const list = [...ids.values()].sort((a, b) => String(a.id).localeCompare(String(b.id)));
console.log(`# occluder 清单 mapSeed=${mapSeed} layoutVersion=${layoutVersion}（stage.boxes=${stage.boxes.length}）`);
// 按前缀聚合，避免上百行 rock:/tree: 噪声
const byPrefix = new Map();
for (const e of list) {
  const prefix = e.id.replace(/:[^:]*$/, '') + (/:\d+$/.test(e.id) ? '' : '');
  const key = /^(rock|tree|wildtree|landmark|pen|timber)/.test(e.id) ? e.id.split(':')[0] + ':*' : e.id;
  const a = byPrefix.get(key) ?? { prefix: key, groups: 0, boxes: 0, solid: 0, fadeable: ROOF.test(e.id) };
  a.groups += 1; a.boxes += e.boxes; a.solid += e.solid;
  byPrefix.set(key, a);
}
for (const a of [...byPrefix.values()].sort((x, y) => String(x.prefix).localeCompare(String(y.prefix))))
  console.log(JSON.stringify({ occluderPrefix: a.prefix, groups: a.groups, boxes: a.boxes, solid: a.solid, fadesWhenCovered: a.fadeable }));

// 2) 玩家躲在建筑/结构后面：covered 里有多少真正淡出
const W = 800, H = 450, span = Math.min(29, Math.max(18, W / 28));
const rowFor = (label, px, pz, py = 0) => {
  const camera = campCamera({ x: px, z: pz - 2.5, width: W, height: H, span, yaw: .29, pitch: .65, targetY: py + .55 });
  const player = { x: px, y: py, z: pz };
  const covered = coveredModels(camera, player, stage.boxes);
  return { label, player: [px, pz], covered: [...covered].sort(),
    fadeWithCutoutNull: wouldFade(covered, null).sort(),
    fadeWithCutoutSet: wouldFade(covered, true).sort(),
    neverFades: neverFade(covered).sort() };
};

const spots = [];
for (const [room, [sx, sy]] of Object.entries(sites)) {
  const cx = sx + .5, cz = sy + .5;
  // 站在建筑北侧（相机在南侧）：建筑体应在视线里
  spots.push(rowFor(room + ' 北侧(建筑背后)', cx, cz - 6.0));
  spots.push(rowFor(room + ' 屋内中心', cx, cz - 3.0));
  spots.push(rowFor(room + ' 建筑南侧(门口)', cx, cz + 0.6));
}
for (const r of spots) console.log(JSON.stringify(r));

// 3) 汇总：这张场景里"能被判定遮挡、但永远不会淡出"的 occluder
const all = new Set();
for (const r of spots) for (const id of r.neverFades) all.add(id);
console.log('\n# 汇总：会被 collected 但绝不会淡出的 occluder');
console.log(JSON.stringify([...all].sort()));
const fadeable = [...ids.keys()].filter(id => ROOF.test(id));
console.log('# 唯一可能淡出的 occluder（前缀 roof:/room-roof:）:', JSON.stringify(fadeable.sort()));
console.log('# stage 里 "site:*" 组的屋顶与墙体共用同一 occluder（house() 的 roofStage 继承当前 group）:',
  JSON.stringify([...new Set(stage.boxes.filter(b => (b.occluder ?? '').startsWith('site:')).map(b => b.occluder))].sort()));
