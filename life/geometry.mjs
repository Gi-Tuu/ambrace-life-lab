// 服务端几何权威（Phase A / 设计 Q2）。room→tile 映射此前只在前端 app.js 硬编码，
// 这里把它收进服务端共享模块：建筑占地、blockers、角色 tile 位置都以这里为准，前端只读 /world。
// Phase A 先提供地点几何与地块锚点；建筑/blockers 骨架留空，Phase B 填充。
export const TILE = 16;
export const WORLD_TW = 96, WORLD_TH = 64;
export const WORLD_W = WORLD_TW * TILE, WORLD_H = WORLD_TH * TILE;

// 与前端 SITES 同口径（避难聚落沿河两岸）；服务端为权威来源。
export const SITES = Object.freeze({
  home: [22, 24], hall: [29, 24], store: [36, 24], yard: [20, 34],
  workshop: [61, 29], garden: [31, 39], watch: [67, 13], well: [50, 34],
});

export function siteOf(room) { return SITES[room] ?? null; }

// 建筑占地与阻挡骨架（Phase B 填充）。当前返回空，保证不改变现有寻路。
export function buildingsOf(world) { return world.buildings ?? []; }
export function blockersOf(world) {
  // 现有自然阻挡仍由前端 buildWorld 派生；服务端建筑阻挡在此叠加（Phase A 为空）。
  return buildingsOf(world).map((b) => b.footprint).filter(Boolean);
}