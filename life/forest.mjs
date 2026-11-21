// 场景森林（world.trees）的砍伐规则：id 权威、可达性、隔挡、再生。
//
// 与 grove（TIMBER_GROVE 固定木材树）的关系：
//   · grove 仍走旧路径（campTrees[groveId] + doGather 扣 resStock），一行未改；
//   · 本模块只服务 camp-scene 生成的森林树，state key 用 `forest:tx:tz` 命名空间，
//     与 grove 的 `grove1..grove6` 明确区分；二者共用 survival.campTrees 这个已存在字段
//     （不新增 survival 顶层字段 ⇒ 研究态/旧档形状不变，旧档无该字段 = 全树在）。
//
// 服务端 ID 权威 = sceneGeometry(w).content.trees（与客户端 buildWorld 同一份 campSceneBundle
// 输入；life/p4-space-single.test.mjs 已钉死两边 stage 逐位一致），所以客户端拾取用的
// `forest:tx:tz` 对应的 `tree:tx:tz` occluder 就是服务端认的树，没有第二套坐标表。
import { DAY_TICKS } from './clock.mjs';
import { REACH, distanceTo } from '../shared/camp-interaction.mjs';
import { forestOccluderId, isForestTreeId, parseForestTreeId } from '../shared/camp-forest.mjs';
import { constructionSpace, sceneSpace, sceneTrees } from './construction-access.mjs';

/** 默认再生天数（游戏日）。可用 world.survival.forestRegrowDays 覆盖（非正/非数字回落默认）。 */
export const FOREST_REGROW_DAYS = 30;
/** 一棵场景树砍倒的木材产出（与 doGather 的居民 2 木对齐）。 */
export const FOREST_CHOP_WOOD = 2;
/** 挡斧头的实体前缀：高体积遮挡（墙/屋/岩/别的树/资源/地标）。栅栏/田地/作物不挡。 */
const CHOP_BLOCKERS = /^(wall|roof|room-roof|site|work|rock|tree|wildtree|timber|resource|landmark):/;
const SAMPLE_STEP = .2;
const TRUNK_CLEAR = .42;

export const forestRegrowDays = (world) => {
  const raw = Number(world?.survival?.forestRegrowDays ?? world?.forestRegrowDays);
  return Number.isFinite(raw) && raw > 0 ? raw : FOREST_REGROW_DAYS;
};
export const forestRegrowTicks = (world) =>
  Math.max(1, Math.round(forestRegrowDays(world) * DAY_TICKS));

/** 当前世界是否真有这棵树：id 合法且出现在 scene content 的 world.trees 里。 */
export function forestTree(world, id) {
  if (!isForestTreeId(id)) return null;
  const trees = sceneTrees(world);
  if (!trees) return null;
  const at = parseForestTreeId(id);
  if (!trees.has(`${at.tx}:${at.tz}`)) return null;
  return { id, tx: at.tx, tz: at.tz, x: at.x, z: at.z, occluder: forestOccluderId(id) };
}

/** 砍伐记录里的 regrowAt（未砍/已再生 = 0）。 */
export const forestCutAt = (world, id) => Number(world?.survival?.campTrees?.[id] ?? 0);

/**
 * 斧头能不能从 from 够到这棵树：水/岸、以及高体积实体都会挡。
 * 返回 null = 通；否则返回拒绝码。目标树干自身不算遮挡（砍的就是它）。
 * space 参数只给单测注入假空间用（生产路径不传 = constructionSpace/sceneSpace 同一来源）。
 */
export function chopBlocked(world, from, tree, space = null) {
  if (!Array.isArray(from) || from.length !== 2) return 'OUT_OF_REACH';
  const to = [tree.x, tree.z];
  const distance = distanceTo(from, to);
  if (distance > REACH.timber) return 'OUT_OF_REACH';
  const field = space ?? constructionSpace(world) ?? sceneSpace(world);
  if (!field) return null; // 没有 space 的旧路径/研究夹具：距离已判，别凭空造出第二套几何
  const steps = Math.max(1, Math.ceil(distance / SAMPLE_STEP));
  for (let i = 1; i < steps; i += 1) {
    const t = i / steps;
    const x = from[0] + (to[0] - from[0]) * t;
    const z = from[1] + (to[1] - from[1]) * t;
    if (distanceTo([x, z], to) <= TRUNK_CLEAR) break; // 已经贴到目标树干
    if (!field.terrainWalkable(x, z)) return 'BLOCKED'; // 河/岸/界外水面
    const solid = field.collidersNear(x, z, 0)
      .some(c => c.occluder !== tree.occluder && CHOP_BLOCKERS.test(c.occluder ?? c.kind ?? ''));
    if (solid) return 'BLOCKED'; // 墙/屋/岩/别的树挡在斧头路径上
  }
  return null;
}

/** 日界再生：到期的森林树记录直接删除 ⇒ 客户端/服务端看到“条目消失”= 树回来了。 */
export function regrowForestCuts(world) {
  const cut = world?.survival?.campTrees;
  if (!cut) return 0;
  let back = 0;
  for (const [id, at] of Object.entries(cut)) {
    if (!isForestTreeId(id)) continue;
    if (Number(at) > 0 && Number(at) <= world.t) {
      delete cut[id];
      back += 1;
    }
  }
  return back;
}
