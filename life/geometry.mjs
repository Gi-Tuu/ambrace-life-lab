// 服务端几何权威（Phase A / 设计 Q2）。room→tile 映射此前只在前端 app.js 硬编码，
// 这里把它收进服务端共享模块：建筑占地、blockers、角色 tile 位置都以这里为准，前端只读 /world。
// Phase A 先提供地点几何与地块锚点；建筑/blockers 骨架留空，Phase B 填充。
import { residentialSite, TOWN_SIZE } from '../web/camp-layout.mjs';
export const TILE=16;
export const WORLD_TW=TOWN_SIZE.width, WORLD_TH=TOWN_SIZE.depth;
export const WORLD_W = WORLD_TW * TILE, WORLD_H = WORLD_TH * TILE;

// 与前端 SITES 同口径（避难聚落沿河两岸）；服务端为权威来源。
export const SITES = Object.freeze({
  home: [22, 24], hall: [29, 24], store: [36, 24], yard: [20, 34],
  workshop: [61, 29], garden: [31, 39], watch: [67, 13], well: [50, 34],
});

export function siteOf(room, layout) { return layout?.sites[room]??SITES[room]??residentialSite(room); }

// 建筑占地与阻挡（Phase B）：生存模式的建筑以 tile 锚点记在 world.survival.buildings，
// 这里派生成 3×2 占地矩形供服务端寻路/碰撞使用；无 survival 时为空，不改变现有寻路。
export const BUILDING_FOOTPRINT = Object.freeze({ w: 3, h: 2 });
export function buildingsOf(world) { return world.survival?.buildings ?? world.buildings ?? []; }
export function blockersOf(world) {
  return buildingsOf(world)
    .filter((b) => b.at)
    .map(b=>b.lot
      ? {x:b.lot.x,y:b.lot.z,w:b.lot.w,h:b.lot.d,type:b.type}
      : {x:b.at[0]-1,y:b.at[1]-1,w:BUILDING_FOOTPRINT.w,h:BUILDING_FOOTPRINT.h,type:b.type});
}