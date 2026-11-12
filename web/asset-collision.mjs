const URL_PREFIX = '/web/assets/';

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
export function pixelPath({walk, tw, th}, [sx, sy], [gx, gy]) {
  if (sx < 0 || sy < 0 || sx >= tw || sy >= th || gx < 0 || gy < 0 || gx >= tw || gy >= th) return null;
  const start = sy * tw + sx, goal = gy * tw + gx;
  if (!walk[goal]) return null;
  if (start === goal) return [];
  const distance = new Int32Array(walk.length);
  const parent = new Int32Array(walk.length);
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
  while (heap.length) {
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
      if (!walk[next] || (distance[next] && distance[next] <= g + 1)) continue;
      distance[next] = g + 1;
      parent[next] = index;
      push({ index: next, g: g + 1, f: g + 1 + heuristic(next) });
    }
  }
  return null;
}
