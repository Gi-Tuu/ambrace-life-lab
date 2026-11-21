// 只读审计脚本：默认存档下河流横截面（# 可走 / . 不可走），看东西岸是否真有缺口。
import { campSitesOf, staticCampSites, campSceneBundle } from '../../shared/camp-scene-content.mjs';
import { createSpace, campSurface, wildSurface } from '../../life/space.mjs';
import { CAMP_BODY_RADIUS } from '../../shared/camp-physics.mjs';
import { campTerrain } from '../../shared/camp-terrain.mjs';

const mapSeed = Number(process.argv[2] ?? 0), layoutVersion = Number(process.argv[3] ?? 0);
const sites = staticCampSites(campSitesOf({ layout: null, peripheralHomes: null }));
const { content, stage } = campSceneBundle({ mapSeed, layoutVersion, layout: null, camp: true, timber: false, sites });
const space = createSpace({
  camp: campSurface({ mapSeed, layoutVersion, layout: null, stage, terrain: content.landscape }),
  wild: wildSurface(content.landscape, { crossing: 24 }),
  terrain: content.landscape,
});
const { riverCenter, riverHalfWidth } = campTerrain(mapSeed, true, layoutVersion);
for (const z of [0.5, 5.5, 20.5, 33.5, 34.5, 35.5, 40.5, 60.5, 79.5]) {
  const c = riverCenter(z * 16) / 16, hw = riverHalfWidth(z * 16) / 16;
  let row = '';
  const marks = [];
  for (let x = c - 6; x <= c + 6; x += .25) {
    const w = space.walkable(x, z, CAMP_BODY_RADIUS);
    row += w ? '#' : '.';
    if (Math.abs(x - c) < .13 || Math.abs(Math.abs(x - c) - hw) < .13) marks.push(x.toFixed(2));
  }
  console.log(`z=${z} 河心x=${c.toFixed(2)} 半宽=${hw.toFixed(2)} 断面(x=${(c - 6).toFixed(1)}..${(c + 6).toFixed(1)}): ${row}  河心/岸边=${marks.join(' ')}`);
}
