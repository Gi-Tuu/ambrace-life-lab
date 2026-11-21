// 1.6 A：牲畜圈舍的**唯一几何来源**（纯模块，Node / 浏览器同构，无 DOM / 无随机）。
//
// 改前：campPen 只是院子左侧一个 7×6.4 的围栏，鸡/牛/羊三群共用同一块地，
//      每种牲畜在场景里只有几个盒子（见旧 livestockPen），`livestock[x]+1` 完全不改圈舍。
// 现在：院子西侧一整块 12.6×10.8 的院落，中间一条 1.2 宽的走道，四块 6×4.85 的分区：
//   鸡舍（小屋 + 围栏 + 食槽 + 栖木）、牛棚（棚顶 + 栏杆 + 槽 + 草料）、
//   羊圈（围栏 + 棚 + 草架）、草料棚。每块都有真实门洞，东侧走道门朝院子。
//
// 契约：
//   · 同一份 campLivestock(at) 被 shared/camp-scene（绘制）、life/source-produce（拾取点）、
//     life/construction-access（space/collision）、web/app.js（atPen/碰撞）共同使用；
//   · 所有实体都是 stage solid AABB，门洞是围栏缺段，不靠“通透材质”；
//   · 结构层级直接由 `livestock[kind]` 派生（不新增存档字段）⇒ 旧档自然可读；
//   · 位置只依赖院子 tile 坐标，同一输入逐位相同，客户端/服务端不会各算一套。

export const LIVESTOCK_KINDS = Object.freeze(['chickens', 'cows', 'sheep']);
export const LIVESTOCK_CAPACITY = Object.freeze({ chickens: 12, cows: 4, sheep: 6 });
export const LIVESTOCK_ITEMS = Object.freeze({ chickens: 'egg', cows: 'milk', sheep: 'wool' });
export const LIVESTOCK_LABELS = Object.freeze({ chickens: '鸡舍', cows: '牛棚', sheep: '羊圈' });
export const LIVESTOCK_DEFAULT = Object.freeze({ chickens: 3, cows: 2, sheep: 2 });

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v, fallback) => Number.isFinite(Number(v)) ? Number(v) : fallback;

export const PEN_T = 0.14;          // 栏杆/墙厚（与 rail() 的顶栏一致）
export const PEN_OUTER_W = 12.6;    // 院落总面积（明显大于旧 7×6.4）
export const PEN_OUTER_D = 10.8;
const PEN_BAY_W = 6.0;
const PEN_BAY_D = 4.85;
const PEN_LANE_D = 1.2;

// 旧调用面（camp-interaction.campPen）保留：返回院落 AABB + 东侧走道门。
// gate/opening 仍是数值，但语义改成“东侧走道门在 z 上的偏移/门宽”，
// 老读法（p.x+p.gate）仅供兼容，不再是动物/入口的权威来源。
export function campPen(at) {
  if (!Array.isArray(at) || !at.every(Number.isFinite)) return null;
  const x = Math.max(0.8, at[0] - 15);
  const z = Math.max(0.8, at[1] - 7);  return {
    x, z, w: PEN_OUTER_W, d: PEN_OUTER_D,
    lane: { x: x + PEN_T, z: z + PEN_BAY_D, w: PEN_OUTER_W - PEN_T * 2, d: PEN_LANE_D },
    gate: PEN_BAY_D, opening: 1.6,
    compound: true,
  };
}

function bayAt(layout, kind) {
  return layout.pens[kind];
}

function fenceSegments(x, z) {
  const T = PEN_T, W = PEN_OUTER_W, D = PEN_OUTER_D;
  const laneZ = z + PEN_BAY_D;
  const out = [];
  const push = (id, sx, sz, sw, sd) => { if (sw > 0.02 && sd > 0.02) out.push({ id, x: sx, z: sz, w: sw, d: sd }); };
  // 外圈：北/南/西闭合；东侧在走道处留门（朝院子）。
  push('pen:north', x, z, W, T);
  push('pen:south', x, z + D - T, W, T);
  push('pen:west', x, z, T, D);
  push('pen:east:n', x + W - T, z, T, PEN_BAY_D);
  push('pen:east:s', x + W - T, laneZ + PEN_LANE_D, T, D - PEN_BAY_D - PEN_LANE_D);
  // 上排两舍的南栏杆（走道北沿），各自留 1.5 门洞。
  for (const kind of ['chickens', 'cows']) {
    const b = bayAt({ pens: bayRects(x, z) }, kind);
    const g = b.gateStart - b.x, bw = b.w;
    push(`pen:${kind}:s:a`, b.x, laneZ - T, g, T);
    push(`pen:${kind}:s:b`, b.x + g + b.gateW, laneZ - T, bw - g - b.gateW, T);
  }
  // 下排两舍的北栏杆（走道南沿），羊圈 1.5 门洞、草料棚 2.0 门洞。
  for (const kind of ['sheep', 'fodder']) {
    const b = bayAt({ pens: bayRects(x, z) }, kind);
    const g = b.gateStart - b.x, bw = b.w;
    push(`pen:${kind}:n:a`, b.x, laneZ + PEN_LANE_D, g, T);
    push(`pen:${kind}:n:b`, b.x + g + b.gateW, laneZ + PEN_LANE_D, bw - g - b.gateW, T);
  }
  // 上下排之间的中缝隔栏。
  push('pen:divider:n', x + PEN_BAY_W + 0.3 - T / 2, z, T, PEN_BAY_D);
  push('pen:divider:s', x + PEN_BAY_W + 0.3 - T / 2, laneZ + PEN_LANE_D, T, PEN_BAY_D);
  return out;
}

function bayRects(x, z) {
  const laneZ = z + PEN_BAY_D;
  return {
    chickens: {
      kind: 'chickens', x, z, w: PEN_BAY_W, d: PEN_BAY_D,
      gateStart: x + 2.05, gateW: 1.5, side: 'south',
    },
    cows: {
      kind: 'cows', x: x + PEN_BAY_W + 0.6, z, w: PEN_BAY_W, d: PEN_BAY_D,
      gateStart: x + PEN_BAY_W + 0.6 + 2.05, gateW: 1.5, side: 'south',
    },
    sheep: {
      kind: 'sheep', x, z: laneZ + PEN_LANE_D, w: PEN_BAY_W, d: PEN_BAY_D,
      gateStart: x + 2.05, gateW: 1.5, side: 'north',
    },
    fodder: {
      kind: 'fodder', x: x + PEN_BAY_W + 0.6, z: laneZ + PEN_LANE_D, w: PEN_BAY_W, d: PEN_BAY_D,
      gateStart: x + PEN_BAY_W + 0.6 + 2.0, gateW: 2.0, side: 'north', open: true,
    },
  };
}

// 槽位：与场景动物、sourceView 的拾取点同源。slot 以 0 起，超出容量取模。
export function campAnimalSlots(kind, at) {
  const pen = campPen(at);
  if (!pen) return [];
  const x = pen.x, z = pen.z, laneZ = z + PEN_BAY_D;
  if (kind === 'chickens') {
    // 6×2 槽位：鸡的体宽 ~0.76，0.9 间距在 6 宽跑场里放得下 12 只（容量与圈舍规模对应）。
    return Array.from({ length: LIVESTOCK_CAPACITY.chickens }, (_, i) => ({
      x: x + 0.75 + (i % 6) * 0.9,
      z: z + 2.35 + Math.floor(i / 6) * 1.05,
    }));
  }
  if (kind === 'cows') {
    return Array.from({ length: LIVESTOCK_CAPACITY.cows }, (_, i) => ({
      x: x + 1.3 + (i % 2) * 1.75,
      z: z + 1.05 + Math.floor(i / 2) * 1.55,
    }));
  }
  if (kind === 'sheep') {
    return Array.from({ length: LIVESTOCK_CAPACITY.sheep }, (_, i) => ({
      x: x + 0.85 + (i % 3) * 1.05,
      z: laneZ + PEN_LANE_D + 1.05 + Math.floor(i / 3) * 1.35,
    }));
  }
  return [];
}

export function campAnimalSlot(kind, slot, at) {
  const slots = campAnimalSlots(kind, at);
  if (!slots.length) return null;
  const i = ((Math.trunc(num(slot, 0)) % slots.length) + slots.length) % slots.length;
  return { ...slots[i] };
}

// `livestock[kind]` ⇒ 结构层级：0 = 只有空场/围栏，>0 = 真实屋舍并随数量加 bay。
export function livestockLevel(stock, kind) {
  const cap = LIVESTOCK_CAPACITY[kind] ?? 0;
  if (!stock || !Object.hasOwn(stock, kind)) return LIVESTOCK_DEFAULT[kind] ?? 0;
  return clamp(Math.trunc(num(stock[kind], 0)), 0, cap);
}

/**
 * 完整院落布局：围栏段、四块分区、容量、槽位、门洞。
 * @param {[number,number]} at 院子 tile 坐标（campSite('yard', layout)）
 * @param {object|null} stock survival.livestock
 */
export function campLivestock(at, stock = null) {
  const pen = campPen(at);
  if (!pen) return null;
  const { x, z } = pen;
  const pens = bayRects(x, z);
  const fences = fenceSegments(x, z);
  const doors = {
    yard: { x: x + pen.w - PEN_T, z: z + PEN_BAY_D, w: PEN_T, d: PEN_LANE_D },
    chickens: { x: pens.chickens.gateStart, z: z + PEN_BAY_D - PEN_T, w: pens.chickens.gateW, d: PEN_T },
    cows: { x: pens.cows.gateStart, z: z + PEN_BAY_D - PEN_T, w: pens.cows.gateW, d: PEN_T },
    sheep: { x: pens.sheep.gateStart, z: z + PEN_BAY_D + PEN_LANE_D, w: pens.sheep.gateW, d: PEN_T },
    fodder: { x: pens.fodder.gateStart, z: z + PEN_BAY_D + PEN_LANE_D, w: pens.fodder.gateW, d: PEN_T },
  };
  const levels = Object.fromEntries(LIVESTOCK_KINDS.map((kind) => [kind, livestockLevel(stock, kind)]));
  return {
    ...pen, pens, fences, doors, levels,
    capacity: { ...LIVESTOCK_CAPACITY },
    slots: Object.fromEntries(LIVESTOCK_KINDS.map((kind) => [kind, campAnimalSlots(kind, at)])),
    // 每块分区的内缩活动范围（给动物漫游/拾取用）。
    habitats: Object.fromEntries(LIVESTOCK_KINDS.map((kind) => {
      const b = pens[kind];
      return [kind, { x: b.x + 0.42, z: b.z + 0.42, w: b.w - 0.84, d: b.d - 0.84 }];
    })),
  };
}

// UI 用：0 → 建，>0 → 扩；文案只在这里生成，服务端/客户端同一口径。
export function expandVerb(stock, kind) {
  return livestockLevel(stock, kind) > 0 ? '扩' : '建';
}

export function expandLabel(stock, kind) {
  return `${expandVerb(stock, kind)}${LIVESTOCK_LABELS[kind] ?? kind}`;
}
