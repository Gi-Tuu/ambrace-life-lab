// 只读审计脚本：默认存档（seed/world.json: mapSeed 0 / layoutVersion 0，无 layout）的桥复现。
// 对照：layoutVersion 2 有桥。用法: node evidence/exp-audit-render/bridge-default-save.mjs
import { campSitesOf, staticCampSites, campSceneBundle } from '../../shared/camp-scene-content.mjs';
import { createSpace, campSurface, wildSurface } from '../../life/space.mjs';
import { CAMP_BODY_RADIUS } from '../../shared/camp-physics.mjs';
import { campBridgeBounds, generateCampLayout } from '../../shared/camp-layout.mjs';
import { campTerrain } from '../../shared/camp-terrain.mjs';

function build(mapSeed, layoutVersion) {
  const layout = layoutVersion ? generateCampLayout(mapSeed, layoutVersion) : null;
  const sites = staticCampSites(campSitesOf({ layout, peripheralHomes: null }));
  const { content, stage } = campSceneBundle({
    mapSeed, layoutVersion, layout, camp: true, timber: false, sites,
    households: false, homeRoads: {}, ecoSources: null,
  });
  const landscape = content.landscape;
  const crossing = layout?.crossZ ?? 24;
  const space = createSpace({
    camp: campSurface({ mapSeed, layoutVersion, layout, stage, terrain: landscape }),
    wild: wildSurface(landscape, { crossing }),
    terrain: landscape,
  });
  return { layout, sites, content, stage, space, crossing, landscape };
}

const r = CAMP_BODY_RADIUS;
for (const [mapSeed, layoutVersion, label] of [[0, 0, '默认存档 world.json'], [7, 2, '新版布局 v2']]) {
  const { layout, content, stage, space, crossing } = build(mapSeed, layoutVersion);
  const { riverCenter, riverHalfWidth } = campTerrain(mapSeed, true, layoutVersion);
  const drawn = content.bridges; // 真正画出来的桥（outdoorStage 用的同一份）
  const portals = space.camp.portals;
  const bridgePortals = portals.filter(p => p.kind === 'bridge');
  const floorBridge = (stage.floors ?? []).filter(f => f.y === .32 || (f.end === .32 && f.y === 0));
  console.log('\n==== ' + label + ` (mapSeed=${mapSeed}, layoutVersion=${layoutVersion}) ====`);
  console.log('  layout.crossZ =', layout?.crossZ ?? null, '| space.crossing =', crossing);
  console.log('  画出来的桥 bounds =', JSON.stringify(drawn));
  console.log('  space 里的 bridge portal =', JSON.stringify(bridgePortals));
  console.log('  桥面 floor 数 =', floorBridge.length, floorBridge.slice(0, 3).map(f => ({ x: f.x, z: f.z, w: f.w, d: f.d, y: f.y, end: f.end })));
  for (const [x0, z0, x1, z1] of drawn) {
    const zc = (z0 + z1) / 2, xc = (x0 + x1) / 2;
    const rc = riverCenter(zc * 16 + 8) / 16, rh = riverHalfWidth(zc * 16 + 8) / 16;
    const probe = [];
    for (let x = x0 - 4; x <= x1 + 4; x += 0.5)
      probe.push([Number(x.toFixed(2)), space.walkable(x, zc, r) ? 1 : 0]);
    // 沿桥中轴做细网格 BFS：西岸 -> 东岸
    const step = .125, BZ0 = z0 - 3, BZ1 = z1 + 3, BX0 = x0 - 6, BX1 = x1 + 6;
    const nx = Math.round((BX1 - BX0) / step), nz = Math.round((BZ1 - BZ0) / step);
    const ok = new Uint8Array(nx * nz);
    for (let j = 0; j < nz; j += 1) for (let i = 0; i < nx; i += 1)
      ok[j * nx + i] = space.walkable(BX0 + i * step, BZ0 + j * step, r) ? 1 : 0;
    const prev = new Int32Array(nx * nz).fill(-1), seen = new Uint8Array(nx * nz), q = [];
    for (let j = 0; j < nz; j += 1) { const k = j * nx; if (ok[k]) { seen[k] = 1; q.push(k); } }
    let reach = -1;
    for (let h = 0; h < q.length && reach < 0; h += 1) {
      const k = q[h], i = k % nx, j = (k - i) / nx;
      if (i === nx - 1) { reach = k; break; }
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= nx || jj >= nz) continue;
        const kk = jj * nx + ii;
        if (seen[kk] || !ok[kk]) continue;
        seen[kk] = 1; prev[kk] = k; q.push(kk);
      }
    }
    console.log('  --- 桥 z 中轴 ' + zc.toFixed(2) + ` | 河心 x=${rc.toFixed(2)} 半宽=${rh.toFixed(2)} ---`);
    console.log('  walkable(x) 从西到东:', probe.map(([x, w]) => `${x}:${w ? '✓' : '✗'}`).join(' '));
    console.log('  桥中心 walkable =', space.walkable(xc, zc, r), '| 桥面高度 =', space.heightAt(xc, zc).toFixed(3),
      '| 是否 water =', space.camp.classify(xc, zc));
    // 寻路栅格（world.walk）里同一格是否被当成可走：bridgeCells 命中 ⇔ 画了桥
    const key = `${Math.floor(xc)},${Math.floor(zc)}`;
    console.log('  寻路栅格 world.walk 是否通行（bridgeCells.has）=', content.bridgeCells.has(key),
      '| 该 tile 在 terrain 分类里的 bridge =', space.camp.classify(Math.floor(xc) + .5, Math.floor(zc) + .5));
    console.log('  细网格 BFS 西岸->东岸 =', reach >= 0 ? '可通' : '不可通',
      '| 桥中心附近可走格 =', ok.reduce((a, v) => a + v, 0) + '/' + ok.length);
  }
}
