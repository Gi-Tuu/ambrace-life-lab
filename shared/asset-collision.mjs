const URL_PREFIX = '/web/assets/';
import { WILDS } from './wild-landscape.mjs';

export function findAssetMask(doc, image) {
  if (!image || doc?.version !== 1) return null;
  const path = new URL(image.src).pathname;
  if (!path.startsWith(URL_PREFIX)) return null;
  const mask = doc.assets?.[decodeURIComponent(path.slice(URL_PREFIX.length))];
  if (mask?.width !== image.naturalWidth || mask?.height !== image.naturalHeight || !Array.isArray(mask.spans)) return null;
  if (!mask.spans.every(row => Array.isArray(row) && row.length === 3 && row.every(Number.isInteger) &&
      row[0] >= 0 && row[0] < mask.height && row[1] >= 0 && row[1] < row[2] && row[2] <= mask.width)) return null;
  return mask;
}

export function expandWalk(base, columns, size) {
  const stride = columns * size, pixels = new Uint8Array(base.length * size ** 2);
  for (let row = 0; row < base.length / columns; row += 1) {
    const start = row * columns;
    const offset = row * size * stride;
    for (let col = 0; col < columns; col += 1) {
      pixels.fill(base[start + col], offset + col * size, offset + (col + 1) * size);
    }
    for (let y = 1; y < size; y += 1) pixels.copyWithin(offset + y * stride, offset, offset + stride);
  }
  return pixels;
}

export function fillCollisionRect(walk, width, height, x, y, w, h, value) {
  const left = Math.max(0, x), right = Math.min(width, x + w);
  if (left >= right) return;
  for (let row = Math.max(0, y); row < Math.min(height, y + h); row += 1) {
    walk.fill(value, row * width + left, row * width + right);
  }
}

// 缩小精灵时保留覆盖该游戏像素的任何实心源像素。
export function stampMask(walk, width, height, { mask, x, y, w, h }) {
  for (const [row, from, to] of mask.spans) {
    const left = Math.floor(from * w / mask.width), right = Math.ceil(to * w / mask.width);
    const top = Math.floor(row * h / mask.height), bottom = Math.ceil((row + 1) * h / mask.height);
    fillCollisionRect(walk, width, height, x + left, y + top, right - left, bottom - top, 0);
  }
}

// 大网格用堆取最优节点，避免对数万像素反复线性扫描候选队列。
// deadline（毫秒时间戳，可选）：超时返回 null。服务端居民寻路用它把单刻阻塞钳在预算内。
export function pixelPath({walk, tw, th, cellAllows, edgeAllows}, [sx, sy], [gx, gy], deadline = Infinity) {
  if (sx < 0 || sy < 0 || sx >= tw || sy >= th || gx < 0 || gy < 0 || gx >= tw || gy >= th) return null;
  const start = sy * tw + sx, goal = gy * tw + gx;
  const allows=cellAllows??(i=>walk[i]);
  if (!allows(goal)) return null;
  if (start === goal) return [];
  const distance = new Int32Array(tw*th);
  const parent = new Int32Array(tw*th);
  const heuristic = i => Math.abs(i % tw - gx) + Math.abs(Math.floor(i / tw) - gy);
  const heap = [];
  const better = (a, b) => a.f < b.f || (a.f === b.f && a.g > b.g);
  function push(entry) {
    let i = heap.length;
    heap.push(entry);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!better(entry, heap[p])) break;
      heap[i] = heap[p];
      i = p;
    }
    heap[i] = entry;
  }
  function pop() {
    const first = heap[0], last = heap.pop();
    if (!heap.length) return first;
    let i = 0;
    while (i * 2 + 1 < heap.length) {
      let child = i * 2 + 1;
      if (child + 1 < heap.length && better(heap[child + 1], heap[child])) child += 1;
      if (!better(heap[child], last)) break;
      heap[i] = heap[child];
      i = child;
    }
    heap[i] = last;
    return first;
  }
  distance[start] = 1;
  push({ index: start, g: 1, f: 1 + heuristic(start) });
  let popped = 0;
  while (heap.length) {
    popped += 1;
    if ((popped & 255) === 0 && deadline !== Infinity && Date.now() > deadline) return null;
    const { index, g } = pop();
    if (g !== distance[index]) continue;
    if (index === goal) {
      const route = [[gx, gy]];
      let direction = goal - parent[goal];
      for (let i = parent[goal]; i !== start; i = parent[i]) {
        const nextDirection = i - parent[i];
        if (nextDirection !== direction) route.push([i % tw, Math.floor(i / tw)]);
        direction = nextDirection;
      }
      return route.reverse();
    }
    const x = index % tw;
    for (const next of [x > 0 ? index - 1 : -1, x < tw - 1 ? index + 1 : -1, index - tw, index + tw]) {
      if (next<0 || next>=tw*th || (distance[next] && distance[next] <= g + 1) ||
          !allows(next) || edgeAllows && !edgeAllows(index,next)) continue;
      distance[next] = g + 1;
      parent[next] = index;
      push({ index: next, g: g + 1, f: g + 1 + heuristic(next) });
    }
  }
  return null;
}

// P2c：世界坐标的窗口化寻路。它**不是**第二套 A*：算法仍是上面的 pixelPath，
// 这里只负责把世界坐标映射到窗口栅格、逐边采样可走性、按 14/60/135/320 四档扩窗。
// 服务端施工可达性（life/construction-access.mjs）与客户端出村路线都调它；
// web/walk.mjs 的 astar 是 tile 契约的唯一薄包装。
export function worldRoute(from, to, allows, { bounds = WILDS, margins = [14, 60, 135, 320], sample = 7, deadline = Infinity } = {}) {
  if (!allows(...to)) return null;
  let sampled = 0;
  const clear = (a, b) => {
    const count = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) * sample));
    for (let i = 1; i <= count; i += 1) {
      sampled += 1;
      if ((sampled & 127) === 0 && deadline !== Infinity && Date.now() > deadline) return false;
      if (!allows(a[0] + (b[0] - a[0]) * i / count, a[1] + (b[1] - a[1]) * i / count)) return false;
    }
    return true;
  };
  if (clear(from, to)) return [to];
  for (const margin of margins) {
    if (deadline !== Infinity && Date.now() > deadline) return null;
    const origin = [Math.max(bounds.west, Math.floor(Math.min(from[0], to[0]) - margin)),
      Math.max(bounds.north, Math.floor(Math.min(from[1], to[1]) - margin))];
    const tw = Math.ceil(Math.min(bounds.east, Math.max(from[0], to[0]) + margin) - origin[0]);
    const th = Math.ceil(Math.min(bounds.south, Math.max(from[1], to[1]) + margin) - origin[1]);
    const point = (x, z) => [origin[0] + x, origin[1] + z];
    const status = new Uint8Array(tw * th);
    const pointAt = i => point(i % tw, Math.floor(i / tw));
    const cellAllows = i => {
      if (!status[i]) status[i] = allows(...pointAt(i)) ? 1 : 2;
      return status[i] === 1;
    };
    const nearest = p => {
      const x = Math.round(p[0] - origin[0]), z = Math.round(p[1] - origin[1]);
      const candidates = [];
      for (let dz = -2; dz <= 2; dz += 1) for (let dx = -2; dx <= 2; dx += 1) {
        const i = x + dx, j = z + dz;
        if (i >= 0 && j >= 0 && i < tw && j < th && cellAllows(j * tw + i)) candidates.push([i, j]);
      }
      candidates.sort((a, b) => Math.hypot(...point(...a).map((v, i) => v - p[i])) - Math.hypot(...point(...b).map((v, i) => v - p[i])));
      return candidates.find(q => clear(p, point(...q)));
    };
    const start = nearest(from), end = nearest(to);
    if (!start || !end) continue;
    const route = pixelPath({ tw, th, cellAllows, edgeAllows: (a, b) => clear(pointAt(a), pointAt(b)) }, start, end, deadline);
    if (!route) continue;
    return [start, ...route].map(p => point(...p)).concat([to]);
  }
  return null;
}

// 世界路径的总长度（世界单位）；服务端旅行刻数的唯一来源。
export function routeLength(route, from = null) {
  if (!Array.isArray(route) || !route.length) return 0;
  let length = 0, prev = from;
  for (const next of route) {
    if (prev) length += Math.hypot(next[0] - prev[0], next[1] - prev[1]);
    prev = next;
  }
  return length;
}
