// 只读审计脚本：找出默认存档下河流在哪些 z 行被判定为"可走"（东西岸连通的真实原因）。
import { campSitesOf, staticCampSites, campSceneBundle } from '../../shared/camp-scene-content.mjs';
import { createSpace, campSurface, wildSurface } from '../../life/space.mjs';
import { CAMP_BODY_RADIUS } from '../../shared/camp-physics.mjs';
import { campTerrain } from '../../shared/camp-terrain.mjs';
import { inCamp } from '../../shared/wild-landscape.mjs';

const mapSeed = Number(process.argv[2] ?? 0), layoutVersion = Number(process.argv[3] ?? 0);
const sites = staticCampSites(campSitesOf({ layout: null, peripheralHomes: null }));
const { content, stage } = campSceneBundle({ mapSeed, layoutVersion, layout: null, camp: true, timber: false, sites });
const space = createSpace({
  camp: campSurface({ mapSeed, layoutVersion, layout: null, stage, terrain: content.landscape }),
  wild: wildSurface(content.landscape, { crossing: 24 }),
  terrain: content.landscape,
});
const { riverCenter } = campTerrain(mapSeed, true, layoutVersion);
const rows = [];
for (let z = 0.5; z < 80; z += 1) {
  const c = riverCenter(z * 16) / 16;
  const dry = [];
  for (let x = c - 4; x <= c + 4; x += .25)
    if (space.walkable(x, z, CAMP_BODY_RADIUS)) dry.push(+x.toFixed(2));
  if (dry.length) rows.push({ z: +z.toFixed(1), riverX: +c.toFixed(2), count: dry.length,
    min: dry[0], max: dry.at(-1), reachesCenter: dry.some(x => Math.abs(x - c) < .4), inCamp: inCamp(c, z) });
}
console.log(JSON.stringify({ mapSeed, layoutVersion, rowCount: rows.length, rows: rows.slice(0, 25) }, null, 1));
