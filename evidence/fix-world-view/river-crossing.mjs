// 修复后复验：默认存档（mapSeed 0 / layoutVersion 0）东西两岸连通性。
// 与审计脚本 evidence/exp-audit-render/river-crossing.mjs 同一套 0.5 格 BFS，但空间组合按
// 生产路径（web/app.js buildWorld / life/construction-access sceneSpace）：
//   campSurface({ ..., bridges: content.bridges })  →  wildSurface({ crossing: camp.crossing })
// 同一次运行里同时打印“旧组合”（不传 bridges、crossing 兜底 24）作为改前对照。
// 用法：node evidence/fix-world-view/river-crossing.mjs [mapSeed] [layoutVersion]
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
const { riverCenter } = campTerrain(mapSeed, true, layoutVersion);

function connect(tag, space) {
  const step = .5, W = TOWN_SIZE.width, D = TOWN_SIZE.depth;
  const nx = Math.round(W / step), nz = Math.round(D / step);
  const ok = new Uint8Array(nx * nz);
  const t0 = Date.now();
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
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
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
  const reachEast = east.filter((k) => label[k] >= 0).length;
  return {
    tag, mapSeed, layoutVersion, step, grids: [nx, nz],
    walkableCells: ok.reduce((a, v) => a + v, 0), buildMs,
    westWalkable: west.length, eastWalkable: east.length,
    eastReachableFromWest: `${reachEast}/${east.length}`,
    eastReachablePct: +(100 * reachEast / Math.max(1, east.length)).toFixed(1),
    componentsTouchingEast: [...eastComponents].length,
    crossing: space.camp?.crossing ?? space.crossing,
    bridgeBounds: content.bridges,
    spaceHasBridgePortal: Boolean(space.camp?.portals.some((p) => p.kind === 'bridge')),
  };
}

// 旧组合：调用方不传 bridges（默认存档 layout=null ⇒ bridgeList=[]、crossing 兜底 24）。
const legacy = connect('before', createSpace({
  camp: campSurface({ mapSeed, layoutVersion, layout, stage, terrain: content.landscape }),
  wild: wildSurface(content.landscape, { crossing: layout?.crossZ ?? 24 }),
  terrain: content.landscape,
}));
// 生产组合（web/app.js / life/construction-access.mjs 同一条）：桥带=content.bridges，crossing 由桥带反推。
const camp = campSurface({ mapSeed, layoutVersion, layout, stage, terrain: content.landscape, bridges: content.bridges });
const fixed = connect('after', createSpace({
  camp, wild: wildSurface(content.landscape, { crossing: camp.crossing }), terrain: content.landscape,
}));
for (const row of [legacy, fixed]) console.log(JSON.stringify(row));
const ok = fixed.eastReachablePct >= 99;
console.log(JSON.stringify({ gate: 'RIVER-EAST-REACHABLE', ok, before: legacy.eastReachablePct, after: fixed.eastReachablePct, threshold: 99 }));
process.exitCode = ok ? 0 : 1;
