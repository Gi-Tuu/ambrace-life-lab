// 观察端。这里**不再有任何世界状态**：状态、调度、内部调节全在服务器（life/host.mjs）。
// 之前浏览器自己跑一套 sim，关标签页就归零 —— 那等于当面推翻「内部状态持续存在」这个主张。
const ROOMS = ['home', 'hall', 'watch', 'store'];
const LOCS = { home: '居所', hall: '走廊', watch: '瞭台', store: '公仓' };
// 兜底色也必须 ⊆ palette.json 的 16 色（manifest 缺失时走这里，不能偷偷引入色板外颜色）。
const COLORS = { a1: '#29ADFF', a2: '#FFA300', a3: '#00E436', p1: '#FFF1E8' };
// 事件 emote 的取值同样只从锁色板里挑；键名对应 log.kind，不做语义解释。
const EMOTE = { rej: '#FF004D', disc: '#00E436', tell: '#FFEC27', norm: '#FF77A8' };
// M3 目标承诺层 / M4 耦合调制权的读数翻译。键名必须和机制侧一致，这里只做呈现，不解释机制。
const GOALS = { recover: '补给', connect: '联结', explore: '外探', maintain: '维持' };
const INTERRUPTS = { committed_goal_unavailable: '目标这刻没动作', goal_has_no_visible_action: '看不到能干的事', only_coupling_actions: '此刻只剩耦合动作', no_eligible_action: '没有合格动作' };
const COUPLING_VARS = ['input', 'available', 'refuse'];
const $ = (id) => document.getElementById(id);

// 全套动作精灵 / 场景小动画：独立清单在 web/assets/actions/manifest.json（不动主 manifest schema）。
// 帧号由独立动画循环递增，A/B 严格共用同一个值；不读 w.t、不消费 rng、不写世界状态 ⇒ 不污染研究读数。
const ACT = { ready: false, chars: {}, fx: null, index: {}, rows: {}, fps: 6, frame: 0 };
const ACTIONS_MANIFEST = '/web/assets/actions/manifest.json';

// 素材可选：没有 web/assets/manifest.json 就继续用程序化矩形（当前状态可用），有就自动替换。
// manifest 形状：{ chars: { a1: "url" | ["url","url"], ... }, tiles: { home: "url" }, icons: { energy: "url" } }
const ASSETS = { ready: false, chars: {}, tiles: {}, things: {}, icons: {} };
async function loadAssets() {
  const load = (src) => new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = src; });
  try {
    const m = await api('/web/assets/manifest.json');
    for (const [k, v] of Object.entries(m.tiles ?? {})) ASSETS.tiles[k] = await load(v);
    for (const [k, v] of Object.entries(m.things ?? {})) ASSETS.things[k] = await load(v);
    for (const [k, v] of Object.entries(m.icons ?? {})) ASSETS.icons[k] = await load(v);
    for (const [k, v] of Object.entries(m.chars ?? {})) {
      const frames = Array.isArray(v) ? v : (v.frames ?? []);
      ASSETS.chars[k] = { frames: await Promise.all(frames.map(load)), fps: v.fps ?? 4 };
    }
    ASSETS.ready = true;
  } catch {
    ASSETS.ready = false; // 没素材是正常状态，不是错误
  }
  // 动作表独立加载：失败只退回原来的 4 帧 idle/walk，不影响页面与世界。
  try {
    const m = await api(ACTIONS_MANIFEST);
    ACT.index = Object.fromEntries((m.actions ?? []).map((a, i) => [a.id, i]));
    ACT.rows = Object.fromEntries((m.fxRows ?? []).map((r, i) => [r, i]));
    ACT.fps = m.fps ?? 6;
    for (const [k, v] of Object.entries(m.chars ?? {})) ACT.chars[k] = await load(v);
    ACT.fx = await load(m.fx);
    ACT.ready = true;
  } catch {
    ACT.ready = false;
  }
}

// 角色当前动作行：载荷里的 a.last.kind 是世界事实，不是前端猜的；找不到回退 idle。
const actionRow = (a) => ACT.index[a?.last?.kind] ?? ACT.index.idle ?? 0;

const ui = { room: 'hall', camRoom: null, show: 'A', overview: false };

async function api(path, body) {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── 自然世界地图 ──────────────────────────────────────────────────────────────
// 引擎仍是「地点制」：w.rooms 是地点表、w.loc.p1 是玩家所在地点、w.occupancy 是各地点的人。
// 载荷字段一个不动；这里只在表现层把地点摆进一张连续的自然地形，用相机视口取局部放大画面。
// 全局依旧是完整一大片（1536×1024 逻辑像素），所有居民都在同一张图上跑，屏幕只是取景框。
const TILE = 16;
const WORLD_TW = 96, WORLD_TH = 64;
const WORLD_W = WORLD_TW * TILE, WORLD_H = WORLD_TH * TILE;   // 1536×1024
const VIEW_TW = 16, VIEW_TH = 15;                             // 视口 16×15 tile
const VIEW_W = VIEW_TW * TILE, VIEW_H = VIEW_TH * TILE;        // 256×240 逻辑像素
const ZOOM = 2;                                                // 整数倍放大 → 448×288 CSS
const OV_W = 256, OV_H = 170;                                  // 全景微缩逻辑像素 → ×2 = 512×340 CSS
const OV_SX = OV_W / WORLD_W, OV_SY = OV_H / WORLD_H;         // 世界 → 全景的换算比例

// 村落沿河两岸展开：河从北到南穿过中部，土路跨桥连接西岸的居所/院子/菜园
// 与东岸的走廊/公仓/工坊/井台，东北是瞭台岩丘。相机默认落在走廊，能看到河与桥。
const SITES = {
  home: [26, 20], yard: [30, 30], hall: [50, 22], store: [58, 15],
  workshop: [64, 31], garden: [28, 45], watch: [72, 9], well: [47, 37],
};
const SITE_FALLBACK = [[22, 20], [34, 16], [52, 20], [64, 30], [26, 42], [46, 44], [70, 10], [56, 38]];
const SITE_THING = { home: 'beds', store: 'crates', workshop: 'bench', garden: 'bedsG', well: 'bucket' };
const ROAD_CHAIN = ['home', 'yard', 'well', 'hall', 'store', 'workshop'];
const ROAD_BRANCH = [['yard', 'garden'], ['hall', 'watch'], ['well', 'garden']];

// 确定性 hash（不用 Math.random：地图每次刷新必须逐位相同）。
const hash2 = (x, y, s = 0) => {
  let n = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 1274126177)) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
};
const distSeg = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};
const tileKey = (x, y) => `${x},${y}`;
// 河从北到南穿过村落中部，随 y 蜿蜒；路与河相交处架桥。
const riverX = (ty) => 40 + Math.sin(ty * 0.085) * 4 + Math.sin(ty * 0.031) * 2;
function sitesOf(w) {
  const keys = Object.keys(w.rooms ?? LOCS);
  const out = {};
  keys.forEach((r, i) => { out[r] = SITES[r] ?? SITE_FALLBACK[i % SITE_FALLBACK.length]; });
  return out;
}
function slotsOf(w, sites) {
  const slots = {};
  for (const [r, [sx, sy]] of Object.entries(sites)) {
    (w.occupancy?.[r] ?? []).forEach((who, i) => { slots[who] = [sx - 1 + (i % 3), sy + Math.floor(i / 3)]; });
  }
  return slots;
}

// 聚焦镜头：默认只画当前房间（角色放大 + 台词气泡），全景退为可选。
function lastLine(w, who) {
  const name = who === 'p1' ? '你' : (w.agents[who]?.name ?? who);
  for (let i = (w.log ?? []).length - 1; i >= 0; i--) {
    const e = w.log[i];
    if (e.who === name && e.kind === 'act') return e.text;
  }
  return '';
}
// 整张世界只生成一次（地点集合 / 素材就绪状态不变就复用），之后每帧只 blit 视口。
// 地形按「自然村落」组织：西侧一条蜿蜒的河、连通各处的土路、南面田垄、北面岩丘、
// 沿河与边缘的树林、每个地点一栋屋舍。没有盒子墙、没有门洞、没有房间边界。
let worldCache = null;
function buildWorld(w) {
  const sites = sitesOf(w);
  const sig = Object.keys(sites).join(',') + '|' + (ASSETS.ready ? 1 : 0);
  if (worldCache && worldCache.sig === sig) return { ...worldCache, sites };
  const cv = document.createElement('canvas');
  cv.width = WORLD_W; cv.height = WORLD_H;
  const g = cv.getContext('2d');
  g.imageSmoothingEnabled = false;
  const blockers = new Set();
  // fx 锚点：树冠 / 烟囱 / 屋舍，世界 tile 坐标。场景动画必须贴在这些真实物件上，
  // 而不是随机撒点 —— 否则「草被吹动」会长到河面或屋顶上。
  const trees = [];
  const chimneys = [];

  // 主路 / 支路：折线段（像素中心坐标），像素级判定距离，路宽约 28px 且边界带噪声。
  // 只连当前预设里真实存在的地点（lab 只有 4 个，town 有 8 个），避免凭空画出通向空地的路。
  const roads = [];
  const toPx = (p) => p ? [p[0] * TILE + TILE / 2, p[1] * TILE + TILE / 2] : null;
  const link = (u, v) => {
    const a = sites[u] && sites[v] ? toPx(sites[u]) : null, b = sites[u] && sites[v] ? toPx(sites[v]) : null;
    if (a && b) roads.push([a[0], a[1], b[0], b[1]]);
  };
  for (let i = 1; i < ROAD_CHAIN.length; i += 1) link(ROAD_CHAIN[i - 1], ROAD_CHAIN[i]);
  for (const [u, v] of ROAD_BRANCH) link(u, v);
  const roadDist = (px, py) => roads.reduce((d, r) => Math.min(d, distSeg(px, py, r[0], r[1], r[2], r[3])), Infinity);
  const onRoad = (tx, ty) => roadDist(tx * TILE + 8, ty * TILE + 8) < 18;
  const nearSite = (tx, ty, pad = 2) => Object.values(sites).some(([sx, sy]) => Math.abs(tx - sx) < pad && Math.abs(ty - sy) < pad);
  const onRiver = (tx, ty) => Math.abs(tx * TILE + 8 - riverX(ty) * TILE) < 34;

  // 1) 草地底 + 低频斑块用 2×2 Bayer 抖动过渡（不整块填色，避免出现规整马赛克）
  //    + 每 tile 的草簇 / 石 / 野花，全部硬像素、全部锁色板内。
  g.fillStyle = '#008751'; g.fillRect(0, 0, WORLD_W, WORLD_H);
  for (let gy = 0; gy < WORLD_H; gy += 2) for (let gx = 0; gx < WORLD_W; gx += 2) {
    const patch = hash2(Math.floor(gx / 40), Math.floor(gy / 40), 11);
    const q = BAYER[((gy / 2) % 4) * 4 + ((gx / 2) % 4)];
    if (patch > 0.66 && q < 9) { g.fillStyle = '#00E436'; g.fillRect(gx, gy, 2, 2); }
    else if (patch < 0.26 && q < 6) { g.fillStyle = '#5F574F'; g.fillRect(gx, gy, 2, 2); }
  }
  for (let ty = 0; ty < WORLD_TH; ty += 1) for (let tx = 0; tx < WORLD_TW; tx += 1) {
    const h = hash2(tx, ty, 1), px = tx * TILE, py = ty * TILE;
    if (h > 0.62) { g.fillStyle = '#00E436'; g.fillRect(px + 2, py + 3, 2, 2); g.fillRect(px + 9, py + 10, 2, 2); }
    else if (h < 0.09) { g.fillStyle = '#5F574F'; g.fillRect(px + 9, py + 11, 3, 2); }
    if (h > 0.93) { g.fillStyle = '#FFEC27'; g.fillRect(px + 6, py + 7, 1, 1); }
    else if (h < 0.035) { g.fillStyle = '#FF77A8'; g.fillRect(px + 12, py + 5, 1, 1); }
  }

  // 2) 蜿蜒的河：按 2px 行绘制，河宽随 y 与噪声变化，边界不规则；波纹 + 浅灰岸。
  for (let py = 0; py < WORLD_H; py += 2) {
    const ty = py / TILE;
    const rx = riverX(ty) * TILE + Math.sin(py * 0.07) * 3;
    const half = 17 + Math.sin(py * 0.021) * 3;
    g.fillStyle = '#1D2B53'; g.fillRect(Math.round(rx - half), py, Math.round(half * 2), 2);
    g.fillStyle = '#C2C3C7';
    g.fillRect(Math.round(rx - half), py, 1, 2); g.fillRect(Math.round(rx + half) - 1, py, 1, 2);
    if (py % 8 === 0) {
      g.fillStyle = '#29ADFF';
      g.fillRect(Math.round(rx - 9 + (py % 24) / 2), py, 7, 1);
      g.fillRect(Math.round(rx + 2 - (py % 16) / 2), py + 1, 5, 1);
    }
  }

  // 3) 土路：8px 网格，距路中心 <14px 铺棕底、<22px 用稀疏亮点/暗点做路肩；
  //    边界由 hash 扰动，形成不规则锯齿而不是笔直矩形；过河段架木板桥。
  for (let py = 0; py < WORLD_H; py += 8) for (let px = 0; px < WORLD_W; px += 8) {
    const d = roadDist(px + 4, py + 4);
    const h = hash2(Math.floor(px / 8), Math.floor(py / 8), 2);
    const wet = Math.abs(px + 4 - riverX(py / TILE) * TILE) < 20;
    if (d < 12 + h * 5) {
      g.fillStyle = wet ? '#7E2553' : '#AB5236'; g.fillRect(px, py, 8, 8);
      if (h > 0.86) { g.fillStyle = '#FFA300'; g.fillRect(px + 2, py + 2, 2, 1); }
      else if (h < 0.1) { g.fillStyle = '#5F574F'; g.fillRect(px + 5, py + 5, 3, 1); }
      if (wet) { g.fillStyle = '#FFCCAA'; g.fillRect(px, py, 8, 1); }
    } else if (d < 21 + h * 5 && h > 0.7) {
      g.fillStyle = '#00E436'; g.fillRect(px + 3, py + 3, 2, 2);
    }
  }
  // 桥：路中心落在河面时，横铺一排木板（每 4px 一条）。
  for (let py = 0; py < WORLD_H; py += 16) {
    const rx = riverX(py / TILE) * TILE;
    if (roadDist(rx, py + 8) < 14) {
      g.fillStyle = '#AB5236'; g.fillRect(Math.round(rx - 24), py, 48, 12);
      g.fillStyle = '#FFCCAA'; g.fillRect(Math.round(rx - 24), py, 48, 1);
      g.fillStyle = '#5F574F';
      for (let k = 0; k < 48; k += 6) g.fillRect(Math.round(rx - 24) + k, py + 2, 1, 10);
    }
  }

  // 4) 南面田垄（菜园一带）：横垄 + 苗；北面岩丘（瞭台一带）：灰岩 + 顶高光。
  const garden = sites.garden ?? SITES.garden;
  for (let ty = garden[1] - 3; ty <= garden[1] + 4; ty += 1) for (let tx = garden[0] - 7; tx <= garden[0] + 7; tx += 1) {
    if (onRoad(tx, ty) || onRiver(tx, ty)) continue;
    const d = Math.hypot((tx - garden[0]) / 8, (ty - garden[1]) / 5);
    if (d > 1) continue;
    const px = tx * TILE, py = ty * TILE;
    g.fillStyle = '#AB5236'; g.fillRect(px, py + 2, TILE, 3); g.fillRect(px, py + 11, TILE, 2);
    g.fillStyle = '#00E436'; g.fillRect(px + 3, py + 1, 2, 2); g.fillRect(px + 11, py + 1, 2, 2);
    g.fillStyle = '#008751'; g.fillRect(px + 6, py + 9, 2, 2);
  }
  const watch = sites.watch ?? SITES.watch;
  for (let ty = watch[1] - 5; ty <= watch[1] + 5; ty += 1) for (let tx = watch[0] - 7; tx <= watch[0] + 7; tx += 1) {
    const d = Math.hypot((tx - watch[0]) / 7, (ty - watch[1]) / 5);
    if (d > 1 || hash2(tx, ty, 3) > 0.82 || onRoad(tx, ty)) continue;
    const px = tx * TILE, py = ty * TILE;
    g.fillStyle = '#5F574F'; g.fillRect(px + 1, py + 3, TILE - 2, TILE - 4);
    g.fillStyle = '#83769C'; g.fillRect(px + 1, py + 3, TILE - 2, 2);
    g.fillStyle = '#C2C3C7'; g.fillRect(px + 4, py + 6, 3, 1);
    blockers.add(tileKey(tx, ty));
  }

  // 5) 树林：边缘密、村落内部疏；避开道路、河、田、岩与屋舍。树冠双 tone + 树干。
  for (let ty = 0; ty < WORLD_TH; ty += 1) for (let tx = 0; tx < WORLD_TW; tx += 1) {
    if (onRoad(tx, ty) || onRiver(tx, ty) || blockers.has(tileKey(tx, ty))) continue;
    const edge = Math.min(tx, WORLD_TW - 1 - tx, ty, WORLD_TH - 1 - ty);
    const density = edge < 6 ? 0.42 : edge < 14 ? 0.16 : 0.055;
    if (hash2(tx, ty, 4) > density || nearSite(tx, ty, 3)) continue;
    const px = tx * TILE, py = ty * TILE;
    g.fillStyle = '#1D2B53'; g.fillRect(px + 6, py + 11, 4, 5);
    g.fillStyle = '#008751'; g.fillRect(px + 2, py + 2, 12, 9);
    g.fillStyle = '#00E436'; g.fillRect(px + 3, py + 2, 8, 3); g.fillRect(px + 7, py + 5, 3, 2);
    g.fillStyle = '#AB5236'; g.fillRect(px + 7, py + 11, 2, 4);
    blockers.add(tileKey(tx, ty));
    trees.push([tx, ty]);
  }

  // 6) 屋舍：每地点一栋 3×2 tile 的小屋（屋顶/墙/门/窗），屋顶按地点换色便于辨识；
  //    屋前摆对应设施 sprite。屋舍挡视线，周边留空地给角色站。
  const ROOF = ['#7E2553', '#AB5236', '#1D2B53', '#FF004D', '#5F574F', '#008751', '#83769C', '#FFA300'];
  Object.entries(sites).forEach(([r, [sx, sy]], i) => {
    const bx = (sx - 1) * TILE, by = (sy - 5) * TILE;
    g.fillStyle = '#000000'; g.fillRect(bx - 1, by + 8, 3 * TILE + 2, 2 * TILE - 7);
    g.fillStyle = '#FFCCAA'; g.fillRect(bx, by + 10, 3 * TILE, TILE + 3);
    g.fillStyle = '#C2C3C7'; g.fillRect(bx, by + 10, 3 * TILE, 2);
    g.fillStyle = ROOF[i % ROOF.length]; g.fillRect(bx - 2, by + 2, 3 * TILE + 4, 9);
    g.fillStyle = '#FF004D'; g.fillRect(bx - 2, by + 2, 3 * TILE + 4, 1);
    g.fillStyle = '#5F574F'; g.fillRect(bx + TILE + 4, by + 17, 8, 15);
    g.fillStyle = '#29ADFF'; g.fillRect(bx + 4, by + 15, 6, 5); g.fillRect(bx + 2 * TILE + 6, by + 15, 6, 5);
    g.fillStyle = '#FFEC27'; g.fillRect(bx + 5, by + 16, 2, 2);
    for (let dx = -1; dx <= 1; dx += 1) for (let dy = -5; dy <= -4; dy += 1) blockers.add(tileKey(sx + dx, sy + dy));
    const thing = ASSETS.things[SITE_THING[r]];
    if (thing) g.drawImage(thing, bx + 3 * TILE + 4, by + 14, TILE, TILE);
    // 井台/院子加一圈栅栏，工坊加烟囱，使地点之间形状不同。
    if (r === 'yard' || r === 'well') {
      g.fillStyle = '#AB5236';
      for (let k = 0; k < 6; k += 1) g.fillRect(bx - 14 + k * 12, by + 2 * TILE + 6, 2, 7);
      g.fillRect(bx - 14, by + 2 * TILE + 8, 62, 2);
    }
    if (r === 'workshop') {
      g.fillStyle = '#5F574F'; g.fillRect(bx + 2 * TILE, by - 6, 6, 10);
      g.fillStyle = '#C2C3C7'; g.fillRect(bx + 2 * TILE, by - 8, 8, 2);
      chimneys.push([sx + 1, sy - 6]);
    }
  });

  worldCache = { sig, canvas: cv, blockers, roads, trees, chimneys };
  return { ...worldCache, sites };
}

// 玩家真实视野：从玩家 tile 出发，光半径 + Bresenham 光线投射，树/岩/屋舍挡视线。
function losClear(blockers, ax, ay, bx, by) {
  let x = ax, y = ay;
  const dx = Math.abs(bx - ax), dy = Math.abs(by - ay);
  const sx = ax < bx ? 1 : -1, sy = ay < by ? 1 : -1;
  let err = dx - dy;
  while (!(x === bx && y === by)) {
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx) { err += dx; y += sy; }
    if (x === bx && y === by) break;
    if (blockers.has(tileKey(x, y))) return false;
  }
  return true;
}
function lightRadius(phase) {
  return phase === '夜' ? 5 : phase === '昼' ? 11 : 8;
}
let lastCam = { x: 0, y: 0, zoom: ZOOM, mode: 'view' };
// 相机：默认跟随玩家所在地点（A/B 共用同一锚点，保证双世界在同一镜头下对照）；
// 点地点条可临时把镜头移过去。clamp 到世界边界；缩放取整数倍且不超出容器。
function cameraOf(w, sites, slots, container) {
  const anchor = (ui.camRoom && sites[ui.camRoom]) || sites[w.loc?.p1] || Object.values(sites)[0] || [48, 32];
  const fallback = slots.p1 ?? anchor;
  const p = anchor ?? fallback;
  const x = Math.round(Math.max(0, Math.min(WORLD_W - VIEW_W, p[0] * TILE - VIEW_W / 2)));
  // 屋舍在地点上方 3–5 tile，镜头再上抬 2 tile，保证屋顶不被视口上沿裁掉。
  const y = Math.round(Math.max(0, Math.min(WORLD_H - VIEW_H, p[1] * TILE - VIEW_H / 2 - 2 * TILE)));
  const zoom = Math.max(1, Math.min(3, Math.floor((container || VIEW_W * 2) / VIEW_W)));
  return { x, y, zoom };
}
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

// 局部视角：只渲染世界的一小块（224×144 逻辑像素），整数倍放大到屏幕。
function drawViewport(cv, w) {
  const world = buildWorld(w);
  const slots = slotsOf(w, world.sites);
  const cam = cameraOf(w, world.sites, slots, cv.parentElement?.clientWidth);
  lastCam = { ...cam, mode: 'view' };
  cv._cam = lastCam;
  const CW = VIEW_W * cam.zoom, CH = VIEW_H * cam.zoom;
  if (cv.width !== CW || cv.height !== CH) {
    cv.width = CW; cv.height = CH;
    cv.style.width = `${CW}px`; cv.style.height = `${CH}px`;
  }
  const g = cv.getContext('2d');
  g.setTransform(cam.zoom, 0, 0, cam.zoom, 0, 0);
  g.imageSmoothingEnabled = false;
  g.clearRect(0, 0, VIEW_W, VIEW_H);
  // 一整片世界只在离屏画一次，这里只取相机窗口 —— 全局始终完整在运行。
  g.drawImage(world.canvas, cam.x, cam.y, VIEW_W, VIEW_H, 0, 0, VIEW_W, VIEW_H);
  g.font = '6px fusion-pixel, monospace';
  const t0x = Math.floor(cam.x / TILE), t0y = Math.floor(cam.y / TILE);

  // 场景细节小动画：草摆动 / 水波 / 树冠 / 炊烟，按当前帧号只叠加「会动的像素」。
  // 静止部分由离屏底图提供，fx 是 98.6% 透明的动态增量层，不会盖住地形或出现补丁方块。
  // 锚点来自 buildWorld 记录的真实树/烟囱坐标与河面判定，不随机撒点。
  if (ACT.ready && ACT.fx) {
    const col = ACT.frame * 32;
    const inView = (x, y) => x >= t0x - 2 && x <= t0x + VIEW_TW + 2 && y >= t0y - 2 && y <= t0y + VIEW_TH + 2;
    const cell = (row, tx, ty) => g.drawImage(ACT.fx, col, row * 32, 32, 32, tx * TILE - cam.x - 8, ty * TILE - cam.y - 8, 32, 32);
    const nearRoad = (tx, ty) => world.roads.some((r) => distSeg(tx * TILE + 8, ty * TILE + 8, r[0], r[1], r[2], r[3]) < 20);
    const nearRiver = (tx, ty) => Math.abs((tx + 0.5) * TILE - riverX(ty) * TILE) < 22;
    const nearSite = (tx, ty) => Object.values(world.sites).some(([sx, sy]) => Math.abs(tx - sx) < 5 && Math.abs(ty - sy) < 7);
    const treeSet = new Set(world.trees.map(([x, y]) => tileKey(x, y)));
    // 草：每 2 tile 一个候选，稀疏撒在草地上（避开路/河/树/屋/岩）
    for (let ty = Math.floor(t0y / 2) * 2 - 2; ty <= t0y + VIEW_TH + 2; ty += 2) {
      for (let tx = Math.floor(t0x / 2) * 2 - 2; tx <= t0x + VIEW_TW + 2; tx += 2) {
        if (!inView(tx, ty) || nearRiver(tx, ty) || nearRoad(tx, ty) || nearSite(tx, ty) || treeSet.has(tileKey(tx, ty))) continue;
        if (hash2(tx, ty, 9) > 0.62) cell(ACT.rows.grass ?? 0, tx, ty);
      }
    }
    // 水波：河面每 2 tile 一段
    for (let ty = Math.floor(t0y / 2) * 2 - 2; ty <= t0y + VIEW_TH + 2; ty += 2) {
      for (let tx = Math.floor(t0x / 2) * 2 - 2; tx <= t0x + VIEW_TW + 2; tx += 2) {
        if (!inView(tx, ty) || !nearRiver(tx, ty) || hash2(tx, ty, 10) < 0.45) continue;
        cell(ACT.rows.water ?? 1, tx, ty);
      }
    }
    // 树冠高光 / 炊烟：贴在真实锚点
    for (const [tx, ty] of world.trees) if (inView(tx, ty)) cell(ACT.rows.tree ?? 2, tx, ty);
    for (const [tx, ty] of world.chimneys) if (inView(tx, ty)) cell(ACT.rows.smoke ?? 3, tx, ty);
  }

  const pt = slots.p1 ?? [Math.round((cam.x + VIEW_W / 2) / TILE), Math.round((cam.y + VIEW_H / 2) / TILE)];
  const radius = lightRadius(w.phase);
  const visible = new Set();
  for (let y = t0y - 1; y <= t0y + VIEW_TH + 1; y += 1) for (let x = t0x - 1; x <= t0x + VIEW_TW + 1; x += 1) {
    if (Math.hypot(x - pt[0], y - pt[1]) <= radius && losClear(world.blockers, pt[0], pt[1], x, y)) visible.add(tileKey(x, y));
  }
  // 昼夜色温：视口外框按相位换色板映射（不新画资产、不叠半透明）。
  g.fillStyle = w.phase === '夜' ? '#1D2B53' : w.phase === '昼' ? '#29ADFF' : '#FFA300';
  g.fillRect(0, 0, VIEW_W, 1); g.fillRect(0, VIEW_H - 1, VIEW_W, 1);
  g.fillRect(0, 0, 1, VIEW_H); g.fillRect(VIEW_W - 1, 0, 1, VIEW_H);
  // 玩家脚下 1px 虚线高亮圈（跟随相机坐标）。
  const hx = pt[0] * TILE - cam.x, hy = pt[1] * TILE - cam.y;
  g.fillStyle = '#FFEC27';
  for (let i = 0; i < TILE; i += 4) {
    g.fillRect(hx + i, hy, 2, 1); g.fillRect(hx + i, hy + TILE - 1, 2, 1);
    g.fillRect(hx, hy + i, 1, 2); g.fillRect(hx + TILE - 1, hy + i, 1, 2);
  }
  // 事件 emote：最近日志里该角色的驳回/发现/传话/规范，头顶画 8×8 像素图标。
  const recent = (w.log ?? []).slice(-12);
  const emoteFor = (name) => {
    for (let i = recent.length - 1; i >= 0; i -= 1) if (recent[i].who === name && EMOTE[recent[i].kind]) return EMOTE[recent[i].kind];
    return null;
  };
  // 角色：只画落在视口内且处于视野中的人；站位来自各地点 occupancy，实打实落在世界坐标上。
  for (const [who, [tx, ty]] of Object.entries(slots)) {
    const px = tx * TILE - cam.x, py = ty * TILE - cam.y;
    if (px < -TILE || px > VIEW_W || py < -TILE || py > VIEW_H + TILE) continue;
    if (!visible.has(tileKey(tx, ty))) continue;
    const sheet = ACT.chars[who];
    const sprite = ASSETS.chars[who];
    if (ACT.ready && sheet) {
      // 动作行来自载荷 a.last.kind（世界事实），帧号来自独立时钟 ACT.frame（A/B 共用）。
      g.drawImage(sheet, ACT.frame * 16, actionRow(w.agents?.[who]) * 16, 16, 16, px, py, TILE, TILE);
    } else if (sprite && sprite.frames.length) {
      g.drawImage(sprite.frames[ACT.frame % sprite.frames.length], px, py, TILE, TILE);
    } else { g.fillStyle = COLORS[who] ?? '#C2C3C7'; g.fillRect(px + 2, py + 2, 12, 12); }
    g.fillStyle = '#FFF1E8';
    g.fillText(who === 'p1' ? '你' : (w.agents?.[who]?.name ?? who), px, py + TILE + 6);
    const nm = who === 'p1' ? '你' : (w.agents?.[who]?.name ?? who);
    const em = emoteFor(nm);
    if (em) {
      g.fillStyle = '#000000'; g.fillRect(px + 4, py - 9, 8, 8);
      g.fillStyle = em; g.fillRect(px + 5, py - 8, 6, 6);
      g.fillStyle = '#000000'; g.fillRect(px + 7, py - 7, 2, 3); g.fillRect(px + 7, py - 3, 2, 1);
    }
  }
  // 迷雾：2×2 细抖动的不透明像素压暗视野外，零 alpha、保留地形轮廓。
  // 4×4 大块在 ×2 放大后会连成黑列像墙，这里改用 2×2 细点 + Bayer 平铺。
  const night = w.phase === '夜';
  for (let y = t0y; y <= t0y + VIEW_TH; y += 1) for (let x = t0x; x <= t0x + VIEW_TW; x += 1) {
    if (visible.has(tileKey(x, y))) continue;
    const edge = visible.has(tileKey(x - 1, y)) || visible.has(tileKey(x + 1, y))
      || visible.has(tileKey(x, y - 1)) || visible.has(tileKey(x, y + 1));
    const limit = edge ? 2 : night ? 11 : 7;
    const bx = x * TILE - cam.x, by = y * TILE - cam.y;
    g.fillStyle = '#000000';
    for (let j = 0; j < TILE; j += 2) for (let i = 0; i < TILE; i += 2) {
      if (BAYER[((j / 2) % 4) * 4 + ((i / 2) % 4)] < limit) g.fillRect(bx + i, by + j, 2, 2);
    }
  }
  // 地点名牌：屋舍进入视野时挂牌（黑底 + 1px 描边 + 白字），不写进图片。
  for (const [r, [sx, sy]] of Object.entries(world.sites)) {
    if (!visible.has(tileKey(sx, sy - 4))) continue;
    const label = (w.rooms ?? LOCS)[r] ?? r;
    const bw = label.length * 6 + 6;
    // 名牌夹在视口内，避免贴近边界时被裁半截；始终挂在屋舍上方。
    const bx = Math.max(2, Math.min(VIEW_W - bw - 2, sx * TILE - cam.x - bw / 2));
    const by = Math.max(2, Math.min(VIEW_H - 11, (sy - 6) * TILE - cam.y));
    g.fillStyle = '#000000'; g.fillRect(bx, by, bw, 9);
    g.fillStyle = '#83769C'; g.fillRect(bx, by, bw, 1); g.fillRect(bx, by + 8, bw, 1);
    g.fillStyle = night ? '#C2C3C7' : '#FFF1E8'; g.fillText(label, bx + 3, by + 7);
  }
  return cam;
}

// 世界全景：把完整 96×64 格压成微缩总览，证明「全局依旧是完整一大片在运行」；
// 当前相机窗口用黄虚线框标出，玩家位置用金点标出。
function drawOverview(cv, w) {
  const world = buildWorld(w);
  const slots = slotsOf(w, world.sites);
  const cam = cameraOf(w, world.sites, slots, cv.parentElement?.clientWidth);
  lastCam = { ...cam, mode: 'overview' };
  cv._cam = lastCam;
  const CW = OV_W * ZOOM, CH = OV_H * ZOOM;
  if (cv.width !== CW || cv.height !== CH) {
    cv.width = CW; cv.height = CH;
    cv.style.width = `${CW}px`; cv.style.height = `${CH}px`;
  }
  const g = cv.getContext('2d');
  g.setTransform(ZOOM, 0, 0, ZOOM, 0, 0);
  g.imageSmoothingEnabled = false;
  g.clearRect(0, 0, OV_W, OV_H);
  g.drawImage(world.canvas, 0, 0, WORLD_W, WORLD_H, 0, 0, OV_W, OV_H);
  // 地点标记 / 相机取景框 / 玩家点，全部按世界→全景比例换算。
  for (const [sx, sy] of Object.values(world.sites)) {
    const mx = Math.round(sx * TILE * OV_SX), my = Math.round(sy * TILE * OV_SY);
    g.fillStyle = '#000000'; g.fillRect(mx - 2, my - 2, 5, 5);
    g.fillStyle = '#FFEC27'; g.fillRect(mx - 1, my - 1, 3, 3);
  }
  // 相机窗口（黄虚线 1px 段）
  const vx = Math.round(cam.x * OV_SX), vy = Math.round(cam.y * OV_SY);
  const vw = Math.round(VIEW_W * OV_SX), vh = Math.round(VIEW_H * OV_SY);
  g.fillStyle = '#FFF1E8';
  for (let i = 0; i < vw; i += 4) { g.fillRect(vx + i, vy, 2, 1); g.fillRect(vx + i, vy + vh - 1, 2, 1); }
  for (let j = 0; j < vh; j += 4) { g.fillRect(vx, vy + j, 1, 2); g.fillRect(vx + vw - 1, vy + j, 1, 2); }
  // 玩家金点
  if (slots.p1) {
    const [px, py] = slots.p1;
    const mx = Math.round(px * TILE * OV_SX), my = Math.round(py * TILE * OV_SY);
    g.fillStyle = '#FF004D'; g.fillRect(mx - 1, my - 1, 4, 4);
    g.fillStyle = '#FFF1E8'; g.fillRect(mx, my, 1, 1);
  }
  g.fillStyle = w.phase === '夜' ? '#1D2B53' : w.phase === '昼' ? '#29ADFF' : '#FFA300';
  g.fillRect(0, 0, OV_W, 1); g.fillRect(0, OV_H - 1, OV_W, 1);
  g.fillRect(0, 0, 1, OV_H); g.fillRect(OV_W - 1, 0, 1, OV_H);
  return cam;
}

function draw(cv, w) {
  cv._anim = ACT.frame;   // 渲染元数据：验收可核对 A/B 是否共用同一动画帧号
  if (ui.overview) return drawOverview(cv, w);
  return drawViewport(cv, w);
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function bars(a) {
  // 分段像素格：10 格，亮格=当前值，描边格=基线位置（不再用连续渐变条）
  return Object.entries(a.m).map(([d, v]) => {
    const b = a.baseline[d] ?? 0.5;
    const cells = Array.from({ length: 10 }, (_, i) => {
      const on = (i + 0.5) / 10 <= v;
      const base = Math.round(b * 10) === i + 1;
      return `<b class="${on ? 'on' : ''}${base ? ' base' : ''}"></b>`;
    }).join('');
    return `<div class="bar" title="${d} ${v.toFixed(2)}（基线 ${b.toFixed(2)}）">${cells}</div>`;
  }).join('');
}

const SPARK_W = 220;
const SPARK_H = 44;
// 存续曲线：回答"谁先垮、从哪一步开始回不去"。
// 竖线 = 掉档（不可逆损失）发生的刻度；虚线 = 操作点 crit，跌破它存续才开始影响选择。
// 量程固定 0–1，不做自适应：自适应会把噪声放大成趋势，那正是我们否证过的那类读数。
function spark(pack, id, hue) {
  const s = pack.series ?? [];
  if (s.length < 2) return '';
  const yOf = (v) => Math.round(SPARK_H - Math.max(0, Math.min(1, v)) * (SPARK_H - 3) - 1.5);
  const xOf = (i) => Math.round((i / (s.length - 1)) * SPARK_W);
  // 1px 阶梯线：先水平走再垂直走，坐标全部取整，避免小数坐标带来的插值描边。
  const stair = [];
  s.forEach((r, i) => {
    const x = xOf(i), y = yOf(r.v?.[id] ?? 0);
    if (i > 0) stair.push(`${x},${yOf(s[i - 1].v?.[id] ?? 0)}`);
    stair.push(`${x},${y}`);
  });
  const pts = stair.join(' ');
  const marks = [];
  for (let i = 1; i < s.length; i++) {
    if ((s[i].lost?.[id] ?? 0) > (s[i - 1].lost?.[id] ?? 0)) marks.push(xOf(i));
  }
  const first = s[0].v?.[id] ?? 1;
  const last = s[s.length - 1].v?.[id] ?? 0;
  const crit = Number.isFinite(pack.viabCrit) ? pack.viabCrit : 0.6;
  return `<svg class="spark" width="${SPARK_W}" height="${SPARK_H}" viewBox="0 0 ${SPARK_W} ${SPARK_H}" style="color:var(--${hue})" role="img"
    aria-label="存续从 ${(first * 100).toFixed(0)}% 到 ${(last * 100).toFixed(0)}%，不可逆损失 ${marks.length} 次">
    <polygon points="0,${SPARK_H} ${pts} ${SPARK_W},${SPARK_H}" fill="#1D2B53" />
    <line x1="0" y1="${yOf(crit)}" x2="${SPARK_W}" y2="${yOf(crit)}" stroke="var(--dim)" stroke-dasharray="2 2" stroke-width="1" />
    <polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="1" />
    ${marks.map((x) => `<line x1="${x}" y1="0" x2="${x}" y2="${SPARK_H}" stroke="var(--warn)" stroke-width="1" />`).join('')}
  </svg>`;
}

function worldStat(pack) {
  const agents = Object.values(pack.agents ?? {});
  const lost = agents.reduce((s, a) => s + (a.viab?.lost?.length ?? 0), 0);
  const mean = agents.length ? agents.reduce((s, a) => s + (a.viab?.v ?? 0), 0) / agents.length : 0;
  const st = pack.stat ?? {};
  const withSched = agents.filter((a) => a.sched);
  const onTime = withSched.length ? Math.round((withSched.filter((a) => a.sched.onTime).length / withSched.length) * 100) : null;
  // M3/M4 的汇总只在"这一侧真的叠了这一层"时出现（layers 是开关状态，不是逐刻读数）：
  // 没开的侧摆两个 0 会被读成"开过、跑了、什么都没发生"，那是把缺席当成阴性结果。
  const m3 = agents.filter((a) => a.layers?.m3);
  const kept = m3.reduce((s, a) => s + (a.counters?.m3Reused ?? 0), 0);
  const broken = m3.reduce((s, a) => s + (a.counters?.m3Interrupted ?? 0), 0);
  const cpl = agents.some((a) => a.layers?.coupling) ? agents.reduce((s, a) => s + (a.counters?.couplingApplied ?? 0), 0) : null;
  return `<span>平均存续 <b>${(mean * 100).toFixed(0)}%</b></span><span>永久损失 <b class="${lost ? 'bad' : ''}">${lost}</b></span><span>越轨 <b>${st.越轨 ?? 0}</b></span><span>驳回 <b>${st.驳回 ?? 0}</b></span><span>决策 <b>${st.决策 ?? 0}</b></span>${st.传闻 ? `<span>传闻 <b>${st.传闻}</b></span>` : ''}${onTime === null ? '' : `<span>日程命中 <b>${onTime}%</b></span>`}${pack.weather && pack.weather !== 'clear' ? `<span>天气 <b>${pack.weather === 'rain' ? '雨' : '冷'}</b></span>` : ''}${pack.coins ? `<span>铜币 <b>${Object.values(pack.coins).reduce((x, v) => x + v, 0)}</b></span>` : ''}${m3.length ? `<span>承诺沿用 <b>${kept}</b>·中断 <b>${broken}</b></span>` : ''}${cpl === null ? '' : `<span>耦合动作 <b>${cpl}</b></span>`}`;
}

// M3 承诺层的这一行怎么写。断与不断都是读数，不粉饰：中断原因直接取自机制侧的字符串。
function m3Chip(m) {
  const why = m.interrupted ? (INTERRUPTS[m.interrupted] ?? m.interrupted) : m.reused ? '沿用上一刻的目标' : '这一刻重选了目标';
  const label = m.goal ? `目标·${GOALS[m.goal] ?? m.goal}` : '目标·无';
  const left = m.remaining > 0 ? ` 还守 ${m.remaining}` : '';
  return `<span class="tag${m.goal ? ' act' : ''}" title="${esc(why)}${m.previous ? ` · 上一个目标：${esc(GOALS[m.previous] ?? m.previous)}` : ''}">${esc(label)}${left}${m.interrupted ? ' · 断' : ''}</span>`;
}

// M4 耦合状态：三个变量只描述"外面能不能进到我这里"，全部可逆，τ 到期回初值。
function couplingChip(c) {
  const on = [];
  if (c.v.input < 1) on.push(`听进 ${(c.v.input * 100).toFixed(0)}%`);
  if (c.v.available === 0) on.push('别人找不到我');
  if (c.v.refuse === 1) on.push('预设不理');
  const left = Math.max(0, ...COUPLING_VARS.map((k) => c.hold[k] ?? 0));
  const title = on.length ? `${left} 刻后自行复原（τ=${c.tau}）` : '此刻耦合如常：听得进、找得到、不预设拒绝';
  return `<span class="tag${on.length ? ' act' : ''}" title="${esc(title)}">耦合·${on.length ? esc(on.join('/')) : '如常'}</span>`;
}

function rows(el, pack, hue) {
  // 用 entries 取 id：载荷里虽然已经加了 id，但键本来就是 id，用键更稳
  el.innerHTML = Object.entries(pack.agents).map(([id, a]) => {
    const last = a.last ? esc(a.last.action) : '—';
    const v = a.viab ? `存续 ${(a.viab.v * 100).toFixed(0)}%${a.viab.lost.length ? ' · 已永久失去 ' + esc(a.viab.lost.join('、')) : ''}${spark(pack, id, hue)}` : '';
    return `<div class="row"><div class="nm"><b>${esc(a.name)}</b> ${esc(a.archetype)}</div>
      <div><div class="bars">${bars(a)}</div><div class="pick">${last} <em>${esc(a.summary)}${a.reason ? ' 「' + esc(a.reason) + '」' : ''}</em>${a.sched ? `<span class="sched${a.sched.onTime ? ' on' : ''}" title="此刻节律应在何处">日程·${esc(a.sched.should)}${a.sched.onTime ? '✓' : ''}</span>` : ''}${a.m3 ? m3Chip(a.m3) : ''}${a.coupling ? couplingChip(a.coupling) : ''}${a.work ? `<span class="tag${a.work.today >= a.work.cap ? ' act' : ''}" title="工坊一天只收这么多次工（世界事实，不是他不想干）">活·今日 ${a.work.today}/${a.work.cap}</span>` : ''}${pack.coins?.[a.id] != null ? `<span class="tag">铜币 ${pack.coins[a.id]}</span>` : ''}${(() => { const mates = (pack.companions ?? []).filter((p) => p.includes(a.id)).map((p) => p.find((x) => x !== a.id)).map((x) => (x === 'p1' ? '你' : (pack.agents[x]?.name ?? x))); return mates.length ? `<span class="tag act">伴·${esc(mates.join('/'))}</span>` : ''; })()}${v ? `<div class="pick">${v}</div>` : ''}</div></div></div>`;
  }).join('');
}

// 你知道的事：玩家在这个 demo 里是全知观察者，套利发生在"讲给谁听"。
// 已经知道的人按钮置灰（服务器也会用 REDUNDANT 再挡一次——界面只是提前告诉你）。
function secrets(el, pack) {
  const list = pack.secrets ?? [];
  if (!list.length) {
    el.innerHTML = '<div class="empty">还没有任何秘密。等有人越轨、或有人私藏超额。</div>';
    return;
  }
  const npc = Object.values(pack.agents).filter((a) => a.id !== 'p1');
  el.innerHTML = list.map((s) => {
    const who = npc.map((a) => {
      const done = s.known.includes(a.name);
      return `<button class="${done ? 'done' : ''}" ${done ? 'disabled' : ''} data-s="${esc(s.id)}" data-t="${esc(a.id)}">${done ? '已知' : '告诉' + esc(a.name)}</button>`;
    }).join('');
    return `<div class="s">${esc(s.detail)}<div class="who">${who}</div></div>`;
  }).join('');
}

// 关系与规范（PLAN §28 C 的呈现层）：结伴对 + 最近的群体规范事件。判定在世界侧，这里只读载荷。
function social(el, pack) {
  const nm = (id) => (id === 'p1' ? '你' : (pack.agents[id]?.name ?? id));
  const pairs = (pack.companions ?? []).map(([x, y]) => `${nm(x)}–${nm(y)}`);
  const html = [`<div class="s"><b>结伴</b> ${pairs.length ? esc(pairs.join('、')) : '<span class="empty">还没有</span>'}</div>`];
  const norms = (pack.normLog ?? []).slice().reverse().slice(0, 4);
  if (!norms.length) html.push('<div class="s"><span class="empty">还没有群体规范事件（两人以上目击越轨才会触发）</span></div>');
  for (const e of norms) html.push(`<div class="s"><b>t${e.t}</b> 目击 ${esc(e.of)} 从 ${esc(e.victim)} 门口拿走一份（${esc((e.witnesses ?? []).join('、'))}）⇒ 在场者信任下降</div>`);
  el.innerHTML = html.join('');
}

// 喊住：角色的移动比玩家快，喊一声能让对方几刻不换地方，玩家才追得上（O12）
function hailRow(el, pack) {
  const npc = Object.entries(pack.agents).filter(([id]) => id !== 'p1');
  el.innerHTML = '<span>喊住：</span>' + npc.map(([id, a]) => `<button data-h="${esc(id)}" title="让对方 4 刻内不换地方">${esc(a.name)}</button>`).join('');
}

// 聚焦镜头 HUD：小地图（点房间切镜头）、当前房间角色卡（头像+台词）、事件 toast。
function fillMinimap(pack) {
  const el = $('minimap');
  const rooms = Object.keys(pack.rooms ?? LOCS);
  el.innerHTML = rooms.map((r) => {
    const n = (pack.occupancy[r] ?? []).length;
    return `<button data-room="${esc(r)}" class="${r === ui.room ? 'on' : ''}">${esc((pack.rooms ?? LOCS)[r] ?? r)}<span class="n">${n}</span></button>`;
  }).join('');
}
function fillOcc(el, pack) {
  const crowd = pack.occupancy[ui.room] ?? [];
  if (!crowd.length) { el.innerHTML = '<div class="empty">这处现在没人——点上面的地点把镜头移过去。</div>'; return; }
  el.innerHTML = crowd.map((who) => {
    const a = pack.agents[who];
    const sprite = ASSETS.chars[who];
    const img = sprite && sprite.frames[0] ? `<img src="${sprite.frames[0].src}" alt="" />` : '';
    const name = who === 'p1' ? '你' : (a?.name ?? who);
    const mood = a ? esc(a.summary ?? '') : '玩家';
    const line = esc(lastLine(pack, who) || '…');
    return `<div class="card">${img}<div class="who"><b>${esc(name)}</b><span>${mood}</span><div class="sayline">「${line}」</div></div></div>`;
  }).join('');
}
let toastSeen = 0;
function pushToasts(pack) {
  const norms = (pack.normLog ?? []).filter((e) => e.t > toastSeen);
  if (!norms.length) return;
  toastSeen = Math.max(toastSeen, ...norms.map((e) => e.t));
  const box = $('toasts');
  for (const e of norms.slice(-3)) {
    const d = document.createElement('div');
    d.className = 'toast';
    d.textContent = `t${e.t} 群体规范：${esc(e.of)} 从 ${esc(e.victim)} 门口拿走一份（目击 ${(e.witnesses ?? []).map(esc).join('、')}）⇒ 信任下降`;
    box.appendChild(d);
    setTimeout(() => d.remove(), 6000);
  }
}

function table(a, b) {
  const row = (k, x, y) => `<tr><td>${k}</td><td style="color:var(--a)">${x}</td><td style="color:var(--b)">${y}</td></tr>`;
  const lostOf = (p) => Object.values(p.agents).reduce((s, a) => s + ((a.viab?.lost ?? []).length), 0);
  const costOf = (p) => (p.cost ? `${p.cost.事件}/${p.cost.被问}（跳过 ${p.cost.跳过}·重问 ${p.cost.驳回重问}）` : '—');
  // 这一层没叠的侧给"—"而不是 0：0 会被读成"开了、跑了、什么都没发生"
  const sum = (p, k) => Object.values(p.agents).reduce((s, a) => s + (a.counters?.[k] ?? 0), 0);
  const has = (p, k) => Object.values(p.agents).some((a) => a.layers?.[k]);
  const m3Of = (p) => (has(p, 'm3') ? `${sum(p, 'm3Decisions')}（沿用 ${sum(p, 'm3Reused')}·中断 ${sum(p, 'm3Interrupted')}·退回 ${sum(p, 'm3Fallback')}）` : '—');
  const cplOf = (p) => (has(p, 'coupling') ? sum(p, 'couplingApplied') : '—');
  return row('决策数', a.stat.决策, b.stat.决策) + row('高冲动路径', a.stat.高冲动, b.stat.高冲动) + row('越轨（拿别人份额）', a.stat.越轨, b.stat.越轨) + row('被规则驳回', a.stat.驳回, b.stat.驳回) + row('后果被发现', a.stat.发现, b.stat.发现) + row('M3 承诺决策', m3Of(a), m3Of(b)) + row('M4 耦合动作', cplOf(a), cplOf(b)) + row('不可逆损失（累计）', lostOf(a), lostOf(b)) + row('推理调用（事件/被问）', costOf(a), costOf(b)) + `<tr><td>模型调用 / token</td><td colspan="2">${S.model.calls} 次 · ${S.model.tokens} token${S.brain === 'local' ? '（本地替身，0 成本）' : ''}</td></tr>`;
}

const S = { brain: 'local', model: { calls: 0, tokens: 0 }, running: true, masks: null, layer: null };

async function refresh() {
  try {
    const j = await api('/world');
    S.brain = j.brain;
    S.model = j.model;
    S.running = j.running;
    S.masks = j.masks ?? S.masks;
    S.view = j.A;
    S.viewB = j.B;   // 动画循环重绘 B 侧用；不新增请求、不动载荷形状
    S.layer = j.layer ?? S.layer;
    // 后端状态必须可见：评委要能判断"现在到底是真模型还是替身"，而不是靠猜
    const m = j.model ?? {};
    const chip = $('backend');
    if (j.brain !== 'model') { chip.textContent = '后端：本地替身'; chip.classList.remove('on'); }
    else if (!m.watching) { chip.textContent = '后端：替身（无人观看，省额度）'; chip.classList.remove('on'); }
    else if ((m.calls ?? 0) >= (m.budget ?? 0)) { chip.textContent = `后端：替身（今日 ${m.budget} 次已用完）`; chip.classList.remove('on'); }
    else { chip.textContent = `后端：真模型 ${m.calls ?? 0}/${m.budget ?? '?'}（今日额度）`; chip.classList.add('on'); }
    // H-15 / BUG-18：存档失败与 tick 异常原先在页面上**完全不可见**（只有 /healthz 里埋着），
    // 世界照跑、日志照动，重启后静默回滚到旧档。这里必须红字暴露出来。
    const faults = [];
    if (j.saveError) faults.push(`存档失败：${j.saveError}`);
    if (j.tickError) faults.push(`决策循环异常：${j.tickError}`);
    if (faults.length) {
      chip.textContent = `后端：故障 — ${faults.join(' / ')}`;
      chip.classList.remove('on');
      chip.classList.add('bad');
    } else {
      chip.classList.remove('bad');
    }
    draw($('cvA'), j.A);
    draw($('cvB'), j.B);
    rows($('rowsA'), j.A, 'a');
    rows($('rowsB'), j.B, 'b');
    $('statA').innerHTML = worldStat(j.A);
    $('statB').innerHTML = worldStat(j.B);
    secrets($('secrets'), j.A);
    hailRow($('hail'), j.A);
    social($('social'), j.A);
    // 聚焦镜头 HUD：小地图 / 当前房间角色卡 / 事件 toast
    const roomKeys = Object.keys(j.A.rooms ?? LOCS);
    if (!roomKeys.includes(ui.room)) ui.room = roomKeys[0];
    fillMinimap(j.A);
    fillOcc($('occA'), j.A);
    fillOcc($('occB'), j.B);
    pushToasts(j.A);
    $('btnOverview').classList.toggle('on', ui.overview);
    $('btnOverview').textContent = ui.overview ? '返回局部视角' : '世界全景';
    const vi = $('visionInfo');
    if (vi) vi.textContent = `世界 ${WORLD_TW}×${WORLD_TH} 格 · 视口 ${VIEW_TW}×${VIEW_TH} 格 · 视野 ${lightRadius(j.A.phase)} 格（${j.A.phase ?? ''}）`;
    $('tbl').innerHTML = table(j.A, j.B);
    const onLayers = Object.entries(S.masks ?? {}).filter(([, v]) => v).map(([k]) => (k === 'm3' ? 'M3 承诺' : 'M4 耦合'));
    $('tagA').textContent = `第 ${j.A.t} 刻 · ${j.A.phase ?? ''} · 通道全开${onLayers.length ? ' · 另叠 ' + onLayers.join('+') : ''} · 休眠补时 ${j.missed.applied ?? 0} 分钟`;
    $('tagB').textContent = `第 ${j.B.t} 刻 · ${j.B.phase ?? ''} · ①③④已切断，状态只走倾向带${onLayers.length ? '（上面的层只加在 A，B 保持登记的对照组）' : ''}`;
    const box = $('log');
    // playerLog 单独并进来：主日志只有 40 条，玩家动作几秒就会被挤出去（实测误判过"传话没生效"）
    const pTag = JSON.stringify(j.A.playerLog?.slice(-1) ?? []);
    if (box.dataset.prev !== JSON.stringify(j.A.log.slice(-1)) + JSON.stringify(j.B.log.slice(-1)) + pTag) {
      box.dataset.prev = JSON.stringify(j.A.log.slice(-1)) + JSON.stringify(j.B.log.slice(-1)) + pTag;
      const merged = [
        ...j.A.log.map((x) => ({ ...x, side: 'A' })),
        ...j.B.log.map((x) => ({ ...x, side: 'B' })),
        ...(j.A.playerLog ?? []).map((x) => ({ ...x, side: 'P' })),
      ].sort((x, y) => y.t - x.t).slice(0, 44);
      const cls = (x) => `${x.side} ${x.kind === 'rej' ? 'rej' : x.kind === 'disc' ? 'disc' : x.kind === 'tell' ? 'tell' : x.kind === 'norm' ? 'norm' : ''}`;
      box.innerHTML = merged.map((x) => `<div class="${cls(x)}">${x.side === 'P' ? '你' : x.side} t${x.t} ${esc(x.who)} ${esc(x.text)}</div>`).join('');
    }
    $('btnRun').textContent = S.running ? '▶ 运行' : '⏸ 暂停';
    $('btnRun').classList.toggle('on', S.running);
    $('btnBrain').textContent = S.brain === 'model' ? '内心：真实模型' : '内心：本地替身';
    $('btnBrain').classList.toggle('on', S.brain === 'model');
    // 开关的真实状态来自服务端：机制侧没接上时 masks 是 null，按钮写"未接入"，不摆一个点不动的"开"
    for (const [id, key, name, hint] of [['btnM3', 'm3', 'M3 承诺期', (v) => `目标守住 ${v} 刻`], ['btnM4', 'coupling', 'M4 耦合调制', (v) => `断开后 ${v} 刻自行复原`]]) {
      const btn = $(id);
      if (!btn) continue;
      btn.dataset.base ??= btn.title;
      if (!S.masks) { btn.classList.remove('on'); btn.textContent = `${name}：未接入`; btn.title = `${btn.dataset.base}｜机制侧没给开关状态`; continue; }
      const on = Boolean(S.masks[key]);
      btn.classList.toggle('on', on);
      btn.textContent = `${name}：${on ? '开' : '关'}`;
      btn.title = `${btn.dataset.base}｜${on ? `已叠在 A 侧（${hint(S.layer?.[key === 'm3' ? 'commitment' : 'tau'] ?? '?')}）` : '未叠'}·点击切换：两个世界都回到本次会话起点重放`;
    }
  } catch (e) {
    $('log').innerHTML = `<div class="rej">与服务端断开：${esc(e.message)}（世界仍在服务器那边活着）</div>`;
  }
}

async function ctl(body) {
  await api('/ctl', body);
  refresh();
}

$('cvA').addEventListener('click', (ev) => pickRoom(ev, $('cvA')));
$('cvB').addEventListener('click', (ev) => pickRoom(ev, $('cvB')));
$('minimap').addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-room]');
  if (!b) return;
  ui.room = b.dataset.room;
  ui.camRoom = b.dataset.room;   // 镜头移过去；玩家本人不动，世界状态不变
  refresh();
});
$('btnOverview').onclick = () => { ui.overview = !ui.overview; refresh(); };
// 点击画面：把屏幕坐标反算成世界 tile，再落到最近的地点（走过去 / 切换镜头）。
// 局部视角用相机偏移 + 整数倍缩放；全景用微缩比例。两个世界收到同一个动作。
function pickRoom(ev, cv) {
  const v = S.view ?? {};
  const sites = sitesOf(v);
  const cam = cv._cam ?? lastCam;
  const rect = cv.getBoundingClientRect();
  let tx, ty;
  if (cam.mode === 'overview') {
    tx = ((ev.clientX - rect.left) / rect.width) * WORLD_TW;
    ty = ((ev.clientY - rect.top) / rect.height) * WORLD_TH;
  } else {
    tx = (cam.x + (ev.clientX - rect.left) / cam.zoom) / TILE;
    ty = (cam.y + (ev.clientY - rect.top) / cam.zoom) / TILE;
  }
  let best = null, bd = Infinity;
  for (const [r, [sx, sy]] of Object.entries(sites)) {
    const d = Math.hypot(tx - sx, ty - sy);
    if (d < bd) { bd = d; best = r; }
  }
  if (!best) return;
  if (bd <= 5) return api('/act', { kind: 'move', room: best }).then(() => { ui.room = best; ui.camRoom = null; refresh(); });
  ui.room = best; ui.camRoom = best; refresh();
}

$('btnRun').onclick = () => ctl({ action: S.running ? 'pause' : 'resume' });
$('btnStep').onclick = () => ctl({ action: 'step' });
$('btnReset').onclick = () => ctl({ action: 'reset', confirm: true }); // H-02c：服务端要求 confirm 才重置
$('btnBrain').onclick = () => ctl({ action: 'brain', brain: S.brain === 'model' ? 'local' : 'model' });
// M3/M4 的开关是"这一页要不要接上这一层"，机制侧默认关；切一次会把两个世界拉回本次会话的起点重放。
$('btnM3').onclick = () => ctl({ action: 'mask', key: 'm3', on: !(S.masks?.m3) });
$('btnM4').onclick = () => ctl({ action: 'mask', key: 'coupling', on: !(S.masks?.coupling) });
if ($('btnSleep')) $('btnSleep').onclick = () => ctl({ action: 'catchup', minutes: 45 });
$('btnSay').onclick = () => {
  const v = $('sayText').value.trim();
  if (!v) return;
  api('/act', { kind: 'say', text: v }).then(() => { $('sayText').value = ''; refresh(); });
};
$('sayText').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnSay').click(); });

// 传话：一次点击只做一件事——把这条秘密讲给这个人。两个世界各收一次，规则层各自裁决。
$('secrets').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-s]');
  if (!b || b.disabled) return;
  api('/act', { kind: 'tell', secret: b.dataset.s, target: b.dataset.t }).then(refresh);
});

$('hail').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-h]');
  if (!b) return;
  api('/act', { kind: 'hail', target: b.dataset.h, ticks: 4 }).then(refresh);
});

// 轮询要"串行 + 停靠"：
//  · 旧版 setInterval(refresh,900) 不等上一请求，慢网下会叠加、且响应可乱序（旧快照覆盖新快照）；
//  · 后台标签页必须停轮询，否则它会一直替世界打 touch()，把"有观众才调真模型"的省额度设计废掉。
let refreshing = false;
async function poll() {
  if (document.hidden || refreshing) return;
  refreshing = true;
  try { await refresh(); } finally { refreshing = false; }
}
loadAssets().finally(() => {
  poll();
  setInterval(poll, 900);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
  // 独立动画时钟：只推进帧号并重绘两个画布，与 900ms 的数据轮询完全解耦。
  // 不读 w.t、不发请求、不消费 rng、不写世界状态；A/B 共用同一帧号；
  // 后台标签页停绘，沿用「省额度 / 不空转」纪律。
  setInterval(() => {
    if (document.hidden || !S.view || !S.viewB) return;
    ACT.frame = (ACT.frame + 1) % 4;
    draw($('cvA'), S.view);
    draw($('cvB'), S.viewB);
  }, Math.round(1000 / ACT.fps));
});
