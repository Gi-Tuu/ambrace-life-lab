// 1.2 B 冒烟：居民在室内每分钟移动的位置是否可站、是否避让、loc/占用是否不变。
import { createSurvPlay } from '../../life/survplay.mjs';
import { stepRoomWalk, roomPois } from '../../life/room-walk.mjs';
import { roomSpaceOf } from '../../life/construction-access.mjs';
import { CAMP_BODY_RADIUS } from '../../shared/camp-physics.mjs';

const OPT = {
  gameRules: true, mapSeed: 13, layoutVersion: 2, settlementLife: true, regionalWork: true,
  independentWorld: true, residentialDecisions: true, unifiedCooperation: true, actTimeModel: true, wildExpansion: true,
};
const sp = createSurvPlay(13, OPT);
const w = sp.world;
w.survival.districtTravel = {};
const home = 'home';
const slots = [[6, 9], [9.6, 9], [5.65, 5.4]];
['a1', 'a2', 'a3'].forEach((id, i) => { w.loc[id] = home; w.pos[id] = { x: slots[i][0], z: slots[i][1], space: 'room:home' }; });
w.occupancy[home] = ['a1', 'a2', 'a3'];
const space = roomSpaceOf(w, home);
console.log('pois', roomPois(w, home).map((p) => [p.kind, +p.x.toFixed(2), +p.z.toFixed(2)]));
const start = Object.fromEntries(Object.entries(w.pos).map(([id, p]) => [id, { ...p }]));
const loc = JSON.stringify(w.loc), occ = JSON.stringify(w.occupancy);
let bad = 0, minSep = Infinity;
for (let m = 1; m <= 40; m += 1) {
  stepRoomWalk(w, m);
  for (const id of ['a1', 'a2', 'a3']) {
    const p = w.pos[id];
    if (!space.walkable(p.x, p.z, CAMP_BODY_RADIUS)) { bad += 1; console.log('BAD', m, id, p); }
  }
  for (const [a, b] of [['a1', 'a2'], ['a1', 'a3'], ['a2', 'a3']]) {
    minSep = Math.min(minSep, Math.hypot(w.pos[a].x - w.pos[b].x, w.pos[a].z - w.pos[b].z));
  }
  if (m % 10 === 0) console.log('m', m, ['a1', 'a2', 'a3'].map((id) => [id, +w.pos[id].x.toFixed(2), +w.pos[id].z.toFixed(2)]));
}
console.log('moved', ['a1', 'a2', 'a3'].map((id) => +Math.hypot(w.pos[id].x - start[id].x, w.pos[id].z - start[id].z).toFixed(3)));
console.log('bad', bad, 'minSep', +minSep.toFixed(3), 'loc same', loc === JSON.stringify(w.loc), 'occ same', occ === JSON.stringify(w.occupancy));
// 10 秒等价：1:10 下 10 现实秒 ≈ 1.67 游戏分
