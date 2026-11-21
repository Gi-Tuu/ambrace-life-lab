// 森林（场景树）砍伐的唯一 id 口径：服务端裁决、存档 key、客户端拾取、渲染 occluder 共用一份。
//
// 命名空间（与 grove 的 `grove1..` 明确区分，二者共用 survival.campTrees 但 key 前缀不同）：
//   · 森林树动作/存档 id：`forest:tx:tz`   ← 玩家动作 target、campTrees key、survView.camp.forest key
//   · 渲染 occluder id   ：`tree:tx:tz`     ← camp-scene.outdoorStage 既有分组（树冠/树干都在里面）
// 两者由本模块互相换算，没有第二套坐标：tx/tz 就是 camp-scene-content 里 `trees.push([tx, ty])` 的 tile。
//
// `world.trees` 仍是 [tx,tz] 数组（形状不改；golden 的 trees hash 依赖它）。
// 本模块零 DOM、零世界状态，浏览器/Node 同构。
export const FOREST_TREE_ID = /^forest:(\d+):(\d+)$/;

export const forestTreeId = ([tx, tz]) => `forest:${tx}:${tz}`;

export const isForestTreeId = (id) => typeof id === 'string' && FOREST_TREE_ID.test(id);

/** forest:tx:tz → tree:tx:tz（渲染/碰撞分组 id）；非法返回 null。 */
export const forestOccluderId = (id) => {
  const at = parseForestTreeId(id);
  return at ? `tree:${at.tx}:${at.tz}` : null;
};

/** id → {tx,tz,x,z}（x/z 是树中心的世界单位；非法 id 返回 null）。 */
export function parseForestTreeId(id) {
  if (typeof id !== 'string') return null;
  const match = FOREST_TREE_ID.exec(id);
  if (!match) return null;
  const tx = Number(match[1]), tz = Number(match[2]);
  if (!Number.isSafeInteger(tx) || !Number.isSafeInteger(tz)) return null;
  return { tx, tz, x: tx + .5, z: tz + .5 };
}

/**
 * 仍在树桩期（regrowAt > 当前刻）的森林 id，按 id 排序。
 * 服务端 space/collision 与客户端视图都只认这份“还挡路/还隐形”的集合，避免两处各写一遍。
 */
export function activeForestCuts(campTrees, t) {
  const out = [];
  if (!campTrees || typeof campTrees !== 'object') return out;
  for (const [id, at] of Object.entries(campTrees)) {
    if (!isForestTreeId(id)) continue;
    if (Number(at) > t) out.push(id);
  }
  out.sort();
  return out;
}

/** 视图里的森林砍伐条目（只认 forest: id），按 id 排序后返回 [{id,tx,tz,x,z,regrowAt}]。 */
export function forestCutsOf(forest) {
  if (!forest || typeof forest !== 'object') return [];
  const out = [];
  for (const [id, row] of Object.entries(forest)) {
    const at = parseForestTreeId(id);
    if (!at) continue;
    out.push({ id, ...at, regrowAt: Number(row?.regrowAt) || 0 });
  }
  out.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return out;
}
