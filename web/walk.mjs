// 点哪走哪的寻路内核：纯函数、零 DOM、零引擎时钟。
// 只依赖 world 上的可行走栅格 { walk: Uint8Array, tw, th }（1=可走，0=挡）。
// 单独成模块是为了能在 Node 里直接单测（浏览器标签页 hidden 时动画循环会停，靠肉眼验不了）。
export const isWalkable = (world, tx, ty) => {
  tx = Math.floor(tx); ty = Math.floor(ty);
  if (tx < 0 || ty < 0 || tx >= world.tw || ty >= world.th) return false;
  return world.walk[ty * world.tw + tx] === 1;
};

// 4 邻域 A*，曼哈顿启发。返回从起点之后到终点的 tile 序列（不含起点）；不可达返回 null。
export function astar(world, start, goal) {
  const sx = Math.floor(start[0]), sy = Math.floor(start[1]);
  const gx = Math.floor(goal[0]), gy = Math.floor(goal[1]);
  if (!isWalkable(world, gx, gy)) return null;
  if (sx === gx && sy === gy) return [];
  const W = world.tw;
  const key = (x, y) => y * W + x;
  const open = [{ x: sx, y: sy, g: 0, f: Math.abs(gx - sx) + Math.abs(gy - sy), p: null }];
  const gScore = new Map([[key(sx, sy), 0]]);
  const closed = new Set();
  while (open.length) {
    let bi = 0;
    for (let i = 1; i < open.length; i += 1) if (open[i].f < open[bi].f) bi = i;
    const cur = open.splice(bi, 1)[0];
    if (cur.x === gx && cur.y === gy) {
      const path = [];
      for (let n = cur; n.p; n = n.p) path.push([n.x, n.y]);
      return path.reverse();
    }
    const ck = key(cur.x, cur.y);
    if (closed.has(ck)) continue;
    closed.add(ck);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cur.x + dx, ny = cur.y + dy;
      if (!isWalkable(world, nx, ny)) continue;
      const nk = key(nx, ny);
      if (closed.has(nk)) continue;
      const g = cur.g + 1;
      if (g < (gScore.get(nk) ?? Infinity)) {
        gScore.set(nk, g);
        open.push({ x: nx, y: ny, g, f: g + Math.abs(gx - nx) + Math.abs(gy - ny), p: cur });
      }
    }
  }
  return null;
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
