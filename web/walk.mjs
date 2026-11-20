// 点哪走哪的寻路内核：纯函数、零 DOM、零引擎时钟。
// 只依赖 world 上的可行走栅格 { walk: Uint8Array, tw, th }（1=可走，0=挡）。
// 单独成模块是为了能在 Node 里直接单测（浏览器标签页 hidden 时动画循环会停，靠肉眼验不了）。
//
// P2b：A* 的唯一实现在 shared/asset-collision.mjs 的 pixelPath（二叉堆、支持 cellAllows/
// edgeAllows，能表达桥/门/绕人；服务端 joinedRoute 也用它）。本文件的 astar 只是 tile 栅格
// 的薄包装：把 pixelPath 的“转向点”展开成逐格路径，保持原有 4 邻接契约。
import { pixelPath } from '../shared/asset-collision.mjs';
export const WALK_DIRECTIONS = Object.freeze(['down','down-left','left','up-left','up','up-right','right','down-right']);

export function walkDirection(dx, dz, previous = 'down') {
  if (Math.hypot(dx,dz) < .00001) return previous;
  const octant = Math.round(Math.atan2(-dx,dz) / (Math.PI / 4));
  return WALK_DIRECTIONS[(octant + 8) % 8];
}

export const isWalkable = (world, tx, ty) => {
  tx = Math.floor(tx); ty = Math.floor(ty);
  if (tx < 0 || ty < 0 || tx >= world.tw || ty >= world.th) return false;
  return world.walk[ty * world.tw + tx] === 1;
};

// 4 邻域 A*，曼哈顿启发。返回从起点之后到终点的**逐格** tile 序列；不可达返回 null。
export function astar(world, start, goal) {
  const sx = Math.floor(start[0]), sy = Math.floor(start[1]);
  const gx = Math.floor(goal[0]), gy = Math.floor(goal[1]);
  if (!isWalkable(world, gx, gy)) return null;
  if (sx === gx && sy === gy) return [];
  const route = pixelPath({ tw: world.tw, th: world.th, walk: world.walk }, [sx, sy], [gx, gy]);
  if (!route) return null;
  // pixelPath 只回转向点；展开成逐格，供 stepWalker / 现有调用方按 4 邻接推进。
  const out = [];
  let [x, y] = [sx, sy];
  for (const [wx, wy] of route) {
    while (x !== wx || y !== wy) {
      if (x !== wx) x += Math.sign(wx - x);
      else y += Math.sign(wy - y);
      out.push([x, y]);
    }
  }
  return out;
}

// 沿路径匀速推进一个行走器：s = {x,y,path,pi,moving,face}。返回是否仍在移动。
export function stepWalker(s, speed) {
  if (!s || !s.path || s.pi >= s.path.length) { if (s) s.moving = false; return false; }
  const [wx, wy] = s.path[s.pi];
  const dx = wx - s.x, dy = wy - s.y, d = Math.hypot(dx, dy);
  if (d <= speed) { s.x = wx; s.y = wy; s.pi += 1; if (s.pi >= s.path.length) s.moving = false; }
  else { s.x += (dx / d) * speed; s.y += (dy / d) * speed; s.moving = true; if (Math.abs(dx) > Math.abs(dy)) s.face = dx > 0 ? 1 : -1; }
  return s.moving;
}
