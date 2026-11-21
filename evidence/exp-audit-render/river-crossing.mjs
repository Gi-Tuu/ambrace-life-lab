// 只读审计脚本：默认存档（mapSeed 0 / layoutVersion 0）整图 BFS —— 东西两岸是否连通。
// 用法: node evidence/exp-audit-render/river-crossing.mjs [mapSeed] [layoutVersion]
import { generateCampLayout, TOWN_SIZE } from '../../shared/camp-layout.mjs';
import { campSitesOf, staticCampSites, campSceneBundle } from '../../shared/camp-scene-content.mjs';
import { createSpace, campSurface, wildSurface } from '../../life/space.mjs';
import { CAMP_BODY_RADIUS } from '../../shared/camp-physics.mjs';
import { campTerrain } from '../../shared/camp-terrain.mjs';

const mapSeed = Number(process.argv[2] ?? 0);
const layoutVersion = Number(process.argv[3] ?? 0);
const layout = layoutVersion ? generateCampLayout(mapSeed, layoutVersion) : null;
const sites = staticCampSites(campSitesOf({ layout, peripheralHomes: null }));
const { content, stage } = campSceneBundle({ mapSeed, layoutVersion, layout, camp: true, timber: false, sites });
const space = createSpace({
  camp: campSurface({ mapSeed, layoutVersion, layout, stage, terrain: content.landscape }),
  wild: wildSurface(content.landscape, { crossing: layout?.crossZ ?? 24 }),
  terrain: content.landscape,
});
const { riverCenter } = campTerrain(mapSeed, true, layoutVersion);

const step = .5, W = TOWN_SIZE.width, D = TOWN_SIZE.depth;
const nx = Math.round(W / step), nz = Math.round(D / step);
const ok = new Uint8Array(nx * nz);
let t0 = Date.now();
for (let j = 0; j < nz; j += 1) for (let i = 0; i < nx; i += 1)
  ok[j * nx + i] = space.walkable(i * step + step / 2, j * step + step / 2, CAMP_BODY_RADIUS) ? 1 : 0;
const buildMs = Date.now() - t0;
const west = [], east = [];
for (let j = 0; j < nz; j += 1) {
  for (let i = 0; i < nx; i += 1) {
    if (!ok[j * nx + i]) continue;
    const x = i * step + step / 2;
    (x < riverCenter((j * step + step / 2) * 16) / 16 ? west : east).push(j * nx + i);
  }
}
const label = new Int32Array(nx * nz).fill(-1);
const comp = [];
for (const seed of west) {
  if (label[seed] >= 0) continue;
  const id = comp.length, q = [seed]; label[seed] = id; let n = 0;
  for (let h = 0; h < q.length; h += 1) {
    const k = q[h], i = k % nx, j = (k - i) / nx; n += 1;
    for (const [di, dj] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const ii = i + di, jj = j + dj;
      if (ii < 0 || jj < 0 || ii >= nx || jj >= nz) continue;
      const kk = jj * nx + ii;
      if (label[kk] >= 0 || !ok[kk]) continue;
      label[kk] = id; q.push(kk);
    }
  }
  comp.push(n);
}
const eastComponents = new Set();
for (const k of east) if (label[k] >= 0) eastComponents.add(label[k]);
const reachEast = east.filter(k => label[k] >= 0).length;
console.log(JSON.stringify({
  mapSeed, layoutVersion, step, grids: [nx, nz], walkableCells: ok.reduce((a, v) => a + v, 0),
  buildMs,
  westWalkable: west.length, eastWalkable: east.length,
  eastReachableFromWest: `${reachEast}/${east.length}`,
  eastReachablePct: +(100 * reachEast / Math.max(1, east.length)).toFixed(1),
  componentsTouchingEast: [...eastComponents].length,
  bridgeBounds: content.bridges,
  spaceHasBridgePortal: space.camp.portals.some(p => p.kind === 'bridge'),
}, null, 1));
