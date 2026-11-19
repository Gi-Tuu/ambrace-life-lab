// P2c：房间是显式 16×12 世界空间，不是"256×192 像素 / 16"的隐式约定。
// 本文件是房间几何的唯一数据源：
//   · ROOM_GRID / ROOM_BOUNDS —— 室内画布与可行走像素边界（渲染与旧路径仍用像素）；
//   · ROOM_DOOR_PX / ROOM_DOOR_WORLD —— 同一扇门的两种表示（像素 = 世界 ×16，不另行取魔法数）；
//   · HALL_FRONT —— 连廊台阶/栏杆/正门，栏杆也是房间空间里的实体；
//   · ROOM_INTERIORS / PERSONAL_INTERIOR / YARD_PROPS —— 家具摆放（roomStage 的输入，像素坐标）。
// 服务端（life/space.mjs 的 roomSurface）与客户端（web/app.js 的正式室内移动）都从这里取几何，
// 不再各写一份。research 态不读本文件。
import { FACILITY_PROPS } from './camp-facility.mjs';

export const ROOM_GRID = Object.freeze({ width: 256, height: 192, cell: 1 });
export const ROOM_BOUNDS = Object.freeze({ left: 32, right: 224, top: 50, bottom: 192 });
export const ROOM_UNITS = Object.freeze({ width: ROOM_GRID.width / 16, height: ROOM_GRID.height / 16 });
export const ROOM_DOOR_PX = Object.freeze([112, 176, 32, 16]);
export const ROOM_DOOR_WORLD = Object.freeze({
  x: ROOM_DOOR_PX[0] / 16, z: ROOM_DOOR_PX[1] / 16, w: ROOM_DOOR_PX[2] / 16, d: ROOM_DOOR_PX[3] / 16,
});

export const HALL_FRONT = Object.freeze({
  centerX: 128,
  stairWidth: 52,
  stairTop: 146,
  railY: 148,
  railHeight: 3,
  doorWidth: 32,
  doorTop: 176,
});

export function hallFrontGeometry(spec = HALL_FRONT) {
  const { centerX, stairWidth, stairTop, railY, railHeight, doorWidth, doorTop } = spec;
  const { width, height } = ROOM_GRID;
  const stairX = centerX - stairWidth / 2;
  const stairRight = stairX + stairWidth;
  const doorX = centerX - doorWidth / 2;
  if (!Number.isInteger(stairX) || !Number.isInteger(doorX) || doorWidth <= 0 ||
      doorWidth > stairWidth || stairX < ROOM_BOUNDS.left || stairRight > ROOM_BOUNDS.right) {
    throw new RangeError('连廊正门和台阶必须落在可行走边界内，并与像素对齐');
  }
  return {
    centerX,
    stair: [stairX, stairTop, stairWidth, doorTop - stairTop],
    rails: [[0, railY, stairX, railHeight], [stairRight, railY, width - stairRight, railHeight]],
    door: [doorX, doorTop, doorWidth, height - doorTop],
    label: [centerX - 29, doorTop - 2, 58, 15],
    stepOut: [doorX, height - 2, doorWidth, 2],
  };
}

const contains = ([x, y, w, h], px, py) =>
  px >= x && px < x + w && py >= y && py < y + h;

export function hallExitAt(front, x, y, walking = false) {
  if (walking) {
    // 角色的脚点可以恰好到达室内边界 y=192。
    const [left, top, width, height] = front.stepOut;
    return x >= left && x < left + width && y >= top && y <= top + height;
  }
  return contains(front.door, x, y) || contains(front.label, x, y);
}

// 家具规格一律用像素坐标（与 roomStage / FACILITY_PROPS 的历史口径一致）。
const px = (kind, x, y) => [kind, x * 16, y * 16];
export const PERSONAL_INTERIOR = Object.freeze({ props: Object.freeze([px('bed',3,2),px('hearth',10,2),px('shelf',2,7),px('table',8,5),px('rug',6,7)]) });
export const ROOM_INTERIORS = Object.freeze({
  home: Object.freeze({ props: Object.freeze([px('bed',2,2),px('hearth',10,2),px('table',7,4),px('rug',6,6),px('shelf',2,7),px('planter',11,7)]) }),
  hall: Object.freeze({ props: Object.freeze([px('bench',4,4),px('banner',10,2)]) }),
  store: Object.freeze({ props: Object.freeze([px('shelf',2,2),px('shelf',7,2),px('crate',11,3),px('crate',2,7),px('crate',7,7),px('barrel',11,7)]) }),
  watch: Object.freeze({ props: Object.freeze([px('telescope',4,2),px('crate',10,6),px('banner',2,2),px('barrel',11,2),px('rug',6,7)]) }),
  workshop: Object.freeze({ props: Object.freeze([px('furnace',2,2),px('workbench',8,2),px('anvil',6,7),px('crate',10,7),px('barrel',2,7)]) }),
  garden: Object.freeze({ props: Object.freeze([px('planter',2,3),px('planter',6,3),px('planter',10,3),px('planter',2,7),px('trellis',10,7),px('barrel',6,7)]) }),
  well: Object.freeze({ props: Object.freeze([px('well',5,4),px('bucket',10,6),px('crate',2,3),px('planter',2,7),px('barrel',11,2)]) }),
  yard: Object.freeze({ props: Object.freeze([px('fence',2,2),px('fence',6,2),px('cart',6,5),px('crate',10,3),px('barrel',2,7),px('planter',11,7)]) }),
});
export const YARD_PROPS = Object.freeze({
  garden: Object.freeze([['barrel',178,56],['bucket',195,110],['trellis',44,66],['planter',110,106]]),
  well: Object.freeze([['well',94,57],['bucket',151,100],['barrel',35,93],['barrel',190,45]]),
  yard: Object.freeze([['cart',49,66],['crate',153,49],['barrel',191,89],['workbench',147,91]]),
});
const YARD_FENCE = Object.freeze([5, 61, 176].map(x => Object.freeze(['fence', x, 144])));
export const YARD_PROPS_FULL = Object.freeze(Object.fromEntries(
  Object.entries(YARD_PROPS).map(([room, list]) => [room, Object.freeze([...list, ...YARD_FENCE])]),
));

// roomStage 的家具入参：像素坐标。personal=true 用于没有固定内景的居民宅。
export function roomPropsPx(room, { personal = false, facility = null } = {}) {
  if (facility && FACILITY_PROPS[facility]) return FACILITY_PROPS[facility];
  if (YARD_PROPS_FULL[room]) return YARD_PROPS_FULL[room];
  const spec = ROOM_INTERIORS[room] ?? (personal ? PERSONAL_INTERIOR : null);
  return spec?.props ?? [];
}

// 世界单位门矩形（roomSurface / portalAt 用）；像素门矩形保留给旧路径与绘制。
export const roomDoorWorld = () => ({ ...ROOM_DOOR_WORLD });
export const roomDoorPx = (front = null) => (front ? [...front.door] : [...ROOM_DOOR_PX]);
