// 只读审计脚本：roomDoorPoint（camp_exit 的落点）在各房间是否可站。
import { createSurvPlay } from '../../life/survplay.mjs';
import { roomDoorPoint, sceneSpace } from '../../life/construction-access.mjs';
import { CAMP_BODY_RADIUS } from '../../shared/camp-physics.mjs';

const seed = Number(process.argv[2] ?? 7);
const opts = { mapSeed: Number(process.argv[3] ?? 0), layoutVersion: Number(process.argv[4] ?? 0) };
const sp = createSurvPlay(seed, { gameRules: true, settlementLife: true, regionalWork: true, independentWorld: true, ...opts });
const w = sp.world;
const space = sceneSpace(w);
const rooms = ['home', 'hall', 'store', 'yard', 'workshop', 'garden', 'watch', 'well'];
const rows = [];
for (const room of rooms) {
  const d = roomDoorPoint(w, room);
  const near = space.collidersNear(d[0], d[1], CAMP_BODY_RADIUS);
  rows.push({ room, doorPoint: d.map(v => Math.round(v * 100) / 100),
    walkableR: space.walkable(d[0], d[1], CAMP_BODY_RADIUS),
    walkable0: space.walkable(d[0], d[1], 0),
    colliders: near.map(c => c.kind) });
}
console.log(JSON.stringify({ mapSeed: w.mapSeed, layoutVersion: w.layoutVersion, rows }, null, 1));
