// 1.2 A 端到端冒烟（只读探针，可反复跑）：生成 → 可站/可达 → 认领 → 施工 → 完工 → 存档往返。
import { createSurvPlay, survView, dumpSurv, loadSurv } from '../../life/survplay.mjs';
import { sceneSpace, roomSpaceOf, roomDoorPoint } from '../../life/construction-access.mjs';
import { survAct } from '../../life/survplay.mjs';
import { claimWildPlot, playerHouseWork } from '../../life/households.mjs';
import { homeEntry } from '../../life/home-access.mjs';
import { wildPlotDoor } from '../../shared/wild-plots.mjs';
import { worldRoute } from '../../shared/asset-collision.mjs';
import { CAMP_BODY_RADIUS } from '../../shared/camp-physics.mjs';

const OPT = {
  gameRules: true, mapSeed: 13, layoutVersion: 2, settlementLife: true, regionalWork: true,
  independentWorld: true, residentialDecisions: true, unifiedCooperation: true, actTimeModel: true,
  wildExpansion: true, simTime: true,
};
const sp = createSurvPlay(13, { ...OPT, simClock: null });
const w = sp.world;
const view = survView(sp);
console.log('plots', view.wildPlots?.plots?.map((p) => [p.id, p.at, p.claimed, p.road?.length]) ?? null);
const space = sceneSpace(w);
const plot = view.wildPlots.plots[0];
const door = wildPlotDoor(plot);
console.log('door', door, 'walkable', space.walkable(door[0], door[1], CAMP_BODY_RADIUS));
const anchor = w.campLayout.sites.hall;
const route = worldRoute(door, [anchor[0] + .5, anchor[1] + .5], (x, z) => space.walkable(x, z, CAMP_BODY_RADIUS), { margins: [14, 60, 135] });
console.log('route to hall', route?.length ?? null);
// 玩家站在地块门口
w.survival.playerPos = { x: door[0], z: door[1], t: w.t };
w.pos.p1 = { x: door[0], z: door[1], space: 'world' };
w.survival.playerReachState = null;
w.pinv.p1 = { wood: 8, stone: 6 };
console.log('claim', claimWildPlot(w, 'p1', plot.id, {}));
console.log('claim again', claimWildPlot(w, 'p1', plot.id, {}));
console.log('peripheral', w.peripheralHomes[plot.id], 'project', w.survival.households.projects[plot.id]);
console.log('solid lot walkable?', space.walkable(plot.at[0], plot.at[1] - 4, 0));
// 施工 3 次
for (let i = 0; i < 3; i += 1) {
  w.t += 1;
  const r = playerHouseWork(w, 'p1', {});
  console.log('work', i, r.ok, r.code, r.progress, r.complete);
}
console.log('deed', w.survival.households.deeds[plot.id], 'housing', w.housing.p1, 'loc', w.locs[plot.id]);
const room = roomSpaceOf(w, plot.id);
console.log('room space', Boolean(room), 'doorInside', room?.walkable(8, 11.65, CAMP_BODY_RADIUS));
console.log('homeEntry', homeEntry(w, 'p1', plot.id));
const raw = JSON.parse(JSON.stringify(dumpSurv(sp)));
const back = loadSurv(raw, 13, OPT);
console.log('loaded claims', Object.keys(back.world.survival.wildExpansion.claims), 'peripheral', back.world.peripheralHomes[plot.id], 'deed', back.world.survival.households.deeds[plot.id], 'housing', back.world.housing.p1);
