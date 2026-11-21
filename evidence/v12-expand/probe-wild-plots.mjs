// 荒野宅基地生成探针（证据用）：确定性、数量、可站、路线、耗时。
import { generateWildPlots, wildPlotDoor, wildPlotPad } from '../../shared/wild-plots.mjs';
import { wildLandscape, inCamp } from '../../shared/wild-landscape.mjs';
import { generateCampLayout } from '../../shared/camp-layout.mjs';
import { worldRoute } from '../../shared/asset-collision.mjs';

const rows = [];
for (const seed of [0, 7, 13, 29, 41, 72, 123456]) {
  const t0 = performance.now();
  const first = generateWildPlots(seed, 2);
  const ms = performance.now() - t0;
  const second = generateWildPlots(seed, 2);
  const same = JSON.stringify(first) === JSON.stringify(second);
  const terrain = wildLandscape(seed, 2, { joined: true });
  const layout = generateCampLayout(seed, 2);
  const crossing = layout.crossZ;
  const plots = first.plots.map((p) => {
    const pad = wildPlotPad(p.at);
    const samples = [];
    for (let z = pad.z + .4; z < pad.z + pad.d - .3; z += 1) for (let x = pad.x + .4; x < pad.x + pad.w - .3; x += 1) samples.push([x, z]);
    const walkable = samples.every(([x, z]) => terrain.walkable(x, z, crossing));
    const door = wildPlotDoor(p);
    const anchor = layout.sites[p.roadSite];
    const route = worldRoute(door, [anchor[0] + .5, anchor[1] + .5], (x, z) => terrain.walkable(x, z, crossing), { margins: [14, 60, 135] });
    return {
      id: p.id, at: p.at, outside: !inCamp(...p.at), samples: samples.length, walkable,
      minBankGap: Math.min(...samples.map(([x, z]) => terrain.bankGap(x, z))),
      road: p.road.length, roadSite: p.roadSite, liveRoute: Boolean(route),
      roadWalkable: p.road.every(([x, z]) => terrain.walkable(x, z, crossing)),
    };
  });
  rows.push({ seed, ms: Math.round(ms), count: first.plots.length, deterministic: same, plots });
}
console.log(JSON.stringify(rows, null, 2));
