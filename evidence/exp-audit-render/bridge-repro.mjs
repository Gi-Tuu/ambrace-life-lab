// 只读审计脚本：桥面可走性复现（不改仓库代码，只 import 现有模块）。
// 用法: node evidence/exp-audit-render/bridge-repro.mjs [mapSeed] [layoutVersion]
import { generateCampLayout } from '../../shared/camp-layout.mjs';
import { campSitesOf, staticCampSites, campSceneBundle } from '../../shared/camp-scene-content.mjs';
import { createCampOutskirts } from '../../shared/camp-outskirts.mjs';
import { createSpace, campSurface, wildSurface } from '../../life/space.mjs';
import { CAMP_BODY_RADIUS } from '../../shared/camp-physics.mjs';
import { inCamp } from '../../shared/wild-landscape.mjs';
import { campBridgeBounds } from '../../shared/camp-layout.mjs';
import { campTerrain } from '../../shared/camp-terrain.mjs';

const mapSeed = Number(process.argv[2] ?? 7);
const layoutVersion = Number(process.argv[3] ?? 2);
const layout = generateCampLayout(mapSeed, layoutVersion);
const sites = staticCampSites(campSitesOf({ layout, peripheralHomes: null }));
const { content, stage } = campSceneBundle({
  mapSeed, layoutVersion, layout, camp: true, timber: false, sites,
  households: false, homeRoads: {}, ecoSources: null,
});
const landscape = content.landscape;
const crossing = layout.crossZ;
const space = createSpace({
  camp: campSurface({ mapSeed, layoutVersion, layout, stage, terrain: landscape }),
  wild: wildSurface(landscape, { crossing }),
  terrain: landscape,
});
const { riverCenter, riverHalfWidth } = campTerrain(mapSeed, true, layoutVersion);
const bounds = campBridgeBounds(crossing - 1, crossing + 1, riverCenter, riverHalfWidth);
const [x0, z0, x1, z1] = bounds;
const r = CAMP_BODY_RADIUS;

console.log(JSON.stringify({ mapSeed, layoutVersion, crossing, bridgeBounds: bounds,
  bridgeRowPx: [crossing * 16], layoutSites: layout.sites }, null, 1));

// 1) 桥带内每个 tile 中心是否可走
const rows = [];
for (let z = z0; z < z1; z += 0.25) {
  const cells = [];
  for (let x = x0 - 2; x <= x1 + 2; x += 0.25) {
    const w = space.walkable(x, z, r);
    cells.push(w ? '#' : '.');
  }
  rows.push({ z: Number(z.toFixed(2)), row: cells.join('') });
}
console.log(`\n桥带扫描（x=${(x0-2).toFixed(2)}..${(x1+2).toFixed(2)} step .25, # = walkable r=${r}）`);
for (const { z, row } of rows) console.log(String(z).padStart(6), row);

// 2) 逐点诊断中轴
const zc = (z0 + z1) / 2;
const diag = [];
for (let x = x0 - 3; x <= x1 + 3; x += 0.5) {
  const onBridgeTile = (() => {
    // 复刻 campSurface.onBridge：tile 对齐
    const tiles = new Set();
    for (let tx = Math.floor(x0); tx < Math.ceil(x1); tx += 1)
      for (let tz = Math.floor(z0); tz < Math.ceil(z1); tz += 1) tiles.add(tx + ',' + tz);
    return tiles.has(Math.floor(x) + ',' + Math.floor(zc));
  })();
  diag.push({ x: Number(x.toFixed(2)), walkable: space.walkable(x, zc, r),
    onBridgeTile, terrainAllows: space.camp?.terrainAllows?.(x, zc),
    colliders: space.collidersNear(x, zc, r).length,
    kind: space.camp?.classify?.(x, zc),
    y: Number(space.heightAt(x, zc).toFixed(3)) });
}
console.log('\n中轴诊断 z=' + zc.toFixed(2));
for (const d of diag) console.log(JSON.stringify(d));

// 3) 细网格 BFS：西岸 -> 东岸
const step = 0.125;
const BX0 = x0 - 8, BX1 = x1 + 8, BZ0 = Math.max(0, crossing - 6), BZ1 = Math.min(80, crossing + 7);
const nx = Math.round((BX1 - BX0) / step), nz = Math.round((BZ1 - BZ0) / step);
const ok = new Uint8Array(nx * nz);
let walkCount = 0;
for (let j = 0; j < nz; j += 1) for (let i = 0; i < nx; i += 1) {
  const x = BX0 + i * step, z = BZ0 + j * step;
  const w = space.walkable(x, z, r);
  ok[j * nx + i] = w ? 1 : 0; if (w) walkCount += 1;
}
const centerRiverX = riverCenter(crossing * 16 + 8) / 16;
const startI = 0, goalI = nx - 1;
const prev = new Int32Array(nx * nz).fill(-1);
const seen = new Uint8Array(nx * nz);
const q = [];
for (let j = 0; j < nz; j += 1) { const k = j * nx + startI; if (ok[k]) { seen[k] = 1; q.push(k); } }
let reach = null;
for (let h = 0; h < q.length && reach === null; h += 1) {
  const k = q[h], i = k % nx, j = (k - i) / nx;
  if (i === goalI) { reach = k; break; }
  for (const [di, dj] of [[1,0],[-1,0],[0,1],[0,-1]]) {
    const ii = i + di, jj = j + dj;
    if (ii < 0 || jj < 0 || ii >= nx || jj >= nz) continue;
    const kk = jj * nx + ii;
    if (seen[kk] || !ok[kk]) continue;
    seen[kk] = 1; prev[kk] = k; q.push(kk);
  }
}
const path = [];
if (reach !== null) for (let k = reach; k !== -1; k = prev[k]) path.push(k);
console.log(JSON.stringify({ bfs: { step, window: [BX0, BZ0, BX1, BZ1], walkableCells: walkCount,
  westToEastReachable: reach !== null, pathPoints: path.length,
  pathCrossesRiverAt: path.length ? Number((BX0 + (path[Math.floor(path.length / 2)] % nx) * step).toFixed(2)) : null,
  riverCenterX: Number(centerRiverX.toFixed(2)) } }, null, 1));

// 4) 桥中轴上的阻挡 collider 清单
const near = space.collidersNear((x0 + x1) / 2, zc, 3);
console.log('\n桥中央 3 单位内 colliders:');
for (const c of near) console.log(JSON.stringify(c));
