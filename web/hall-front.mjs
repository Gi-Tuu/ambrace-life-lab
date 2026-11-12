import { ROOM_BOUNDS, ROOM_GRID } from './collision.mjs';

// 连廊室内正门。移动 centerX 即可同步台阶、栏杆缺口和出口交互。
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
