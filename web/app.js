import { campSight, sightScene, terrainHit } from './camp-sight.mjs';
import { districtPads } from './camp-districts.mjs';
import { solarLight } from './camp-sun.mjs';
import { createCampOutskirts, joinedRoute, moveJoinedWalker } from './camp-outskirts.mjs';
import { forestDensity, inCamp, WILDS } from './wild-landscape.mjs';
import { facilityGate, FACILITY_NAMES, FACILITY_PROPS, facilityId, facilityOf } from './camp-facility.mjs';
import { ANIMAL_ITEMS as CAMP_ANIMAL_ITEM, CAMP_SITES as SITES, CAMP_TOOLS as CAMP_TOOL, HEAVY_CAMP_TOOLS, REACH, campBeds, campPlants, wildHabitats, distanceTo, distanceToRect, nearResident } from './camp-interaction.mjs';
import { campTerrain, reliefAt, floorContains, hash2 } from './camp-terrain.mjs';
import { itemBoxes, itemIcon } from './camp-items.mjs';
import { constructionLot, overlapsLot, residentialSite, HOUSING_PLOTS, TIMBER_GROVE, TOWN_SIZE } from './camp-layout.mjs';
// 观察端。这里**不再有任何世界状态**：状态、调度、内部调节全在服务器（life/host.mjs）。
// 之前浏览器自己跑一套 sim，关标签页就归零 —— 那等于当面推翻「内部状态持续存在」这个主张。
import { astar, isWalkable, stepWalker, walkDirection } from './walk.mjs';
import {
  COLLISION_CELL, ROOM_BOUNDS, ROOM_GRID, mapAllows, moveMapFeet, moveRoomFeet,
  overrideWalk, pathFromWalker, roomAllows,
} from './collision.mjs';
import { expandWalk, fillCollisionRect, findAssetMask, pixelPath, stampMask } from './asset-collision.mjs';
import { districtResources, addCampWork, homeAppearance, outdoorHomes, outdoorLife, outdoorStage, penLayout, roomStage, timberStage, workModelKey } from './camp-3d-scene.mjs';
import { actorBoxes, animalBoxes, campCamera, collisionFootprint, coveredModels, createCampRenderer, modelBounds, rayBox } from './camp-3d-render.mjs';
import { CAMP_BODY_RADIUS, bodyGrid, separates } from './camp-3d-physics.mjs';
import { hallExitAt, hallFrontGeometry } from './hall-front.mjs';
import { createCollisionEditor } from './collision-editor.mjs';
// 验收/调试钩子：占位碰撞与寻路可在浏览器内断言（drive6 用）
window.__lifeDebug = { buildWorld, astar, isWalkable, sitesOf, talk: (target) => openTalkWith(target) };
const ROOMS = ['home', 'hall', 'watch', 'store'];
const LOCS = { home: '居所', hall: '走廊', watch: '瞭台', store: '公仓' };
// 兜底色也必须 ⊆ palette.json 的固定色板（manifest 缺失时走这里，不能偷偷引入色板外颜色）。
const COLORS = { a1: '#29ADFF', a2: '#FFA300', a3: '#00E436', p1: '#FFF1E8' };
// 事件 emote 的取值同样只从锁色板里挑；键名对应 log.kind，不做语义解释。
const EMOTE = { rej: '#FF004D', disc: '#00E436', tell: '#FFEC27', norm: '#FF77A8' };
// M3 目标承诺层 / M4 耦合调制权的读数翻译。键名必须和机制侧一致，这里只做呈现，不解释机制。
const GOALS = { recover: '补给', connect: '联结', explore: '外探', maintain: '维持' };
const INTERRUPTS = { committed_goal_unavailable: '目标这刻没动作', goal_has_no_visible_action: '看不到能干的事', only_coupling_actions: '此刻只剩耦合动作', no_eligible_action: '没有合格动作' };
const COUPLING_VARS = ['input', 'available', 'refuse'];
const $ = (id) => document.getElementById(id);
let campRenderer = null;
if (new URLSearchParams(location.search).get('view') !== '2d') {
  try { campRenderer = createCampRenderer(); }
  catch (error) { console.warn('3D 初始化失败，使用像素视图', error); }
}

// 全套动作精灵 / 场景小动画：独立清单在 web/assets/actions/manifest.json（不动主 manifest schema）。
// 帧号由独立动画循环递增，A/B 严格共用同一个值；不读 w.t、不消费 rng、不写世界状态 ⇒ 不污染研究读数。
const ACT = { ready: false, chars: {}, portraits: {}, fx: null, index: {}, rows: {}, fps: 6, frame: 0 };
const ACTIONS_MANIFEST = '/web/assets/actions/manifest.json';

// 素材可选：没有 web/assets/manifest.json 就继续用程序化矩形（当前状态可用），有就自动替换。
// manifest 形状：{ chars: { a1: "url" | ["url","url"], ... }, tiles: { home: "url" }, icons: { energy: "url" } }
const ASSETS = { ready: false, chars: {}, tiles: {}, things: {}, icons: {}, scenes: {}, palette: [] };
let assetMasks = {};
const maskCache = new WeakMap();
function placement(key, x, y, w, h) {
  const image = ASSETS.scenes[key];
  if (!image) return null;
  if (!maskCache.has(image)) maskCache.set(image, findAssetMask(assetMasks, image));
  const mask = maskCache.get(image);
  return mask ? { mask, x, y, w, h } : null;
}

async function loadAssets() {
  try { assetMasks = await api('/web/assets/asset-collisions.json'); }
  catch { assetMasks = {}; }
  const load = (src) => new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = src; });
  try {
    const m = await api('/web/assets/manifest.json');
    ASSETS.palette = await api('/web/assets/palette.json');
    for (const [k, v] of Object.entries(m.scenes ?? {})) ASSETS.scenes[k] = await load(v);
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
    ACT.fps = m.fps ?? 6; ACT.size = m.frame ?? [16, 24]; ACT.directions = m.directions ?? ['down'];
    for (const [k, v] of Object.entries(m.chars ?? {})) ACT.chars[k] = await load(v);
    for (const [k, v] of Object.entries(m.portraits ?? {})) ACT.portraits[k] = await load(v);
    ACT.fx = await load(m.fx);
    ACT.ready = true;
  } catch {
    ACT.ready = false;
  }
}

// 角色当前动作行：载荷里的 a.last.kind 是世界事实，不是前端猜的；找不到回退 idle。
const actionRow = (a) => ACT.index[a?.last?.kind] ?? ACT.index.idle ?? 0;

const launch = new URLSearchParams(location.search);
const ui = { menu: !launch.has('room') && launch.get('full')!=='1' &&
  !['survival','compare'].includes(launch.get('mode')), room: 'hall', camRoom: null, show: 'A', overview: false, interior: null, fullscreen: false, compare: launch.get('mode')==='compare' };

async function api(path, body) {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const result = await res.json();
  if (result.persisted === false) {
    const warning = $('saveNotice');
    warning.hidden = false;
    warning.textContent = '本次操作已执行，存档失败。重启后可能丢失这段进度。';
  } else if (result.persisted === true || path.startsWith('/world') && !result.saveError) {
    $('saveNotice').hidden = true;
  }
  return result;
}

// ── 自然世界地图 ──────────────────────────────────────────────────────────────
// 引擎仍是「地点制」：w.rooms 是地点表、w.loc.p1 是玩家所在地点、w.occupancy 是各地点的人。
// 载荷字段一个不动；这里只在表现层把地点摆进一张连续的自然地形，用相机视口取局部放大画面。
// 世界地图与视口分开；旧地形坐标保持原位，住宅区向东南扩展。
const TILE = 16; // 寻路与布局单位；美术原生 32px，通过独立密度映射，避免改动世界坐标。
const ART = 2;
const WORLD_TW=TOWN_SIZE.width, WORLD_TH=TOWN_SIZE.depth;
const WORLD_W=WORLD_TW*TILE, WORLD_H=WORLD_TH*TILE;
let VIEW_TW = 28, VIEW_TH = 14;                             // 常规视口上限 28×14 tile
let VIEW_W = VIEW_TW * TILE, VIEW_H = VIEW_TH * TILE;        // 视口逻辑像素，按地点和容器调整
const ZOOM = 2;                                                // 整数倍放大
const OV_W = 256, OV_H = 170;                                  // 全景微缩逻辑像素 → ×2 = 512×340 CSS
const OV_SX = OV_W / WORLD_W, OV_SY = OV_H / WORLD_H;         // 世界 → 全景的换算比例

// 避难聚落沿河两岸展开：西岸的居所与公仓由连廊相接，南侧是菜畦和物资棚；
// 土路跨桥通往东岸的井台、工坊与瞭台。地图坐标只属于表现层。
const SITE_FALLBACK = [[22, 20], [34, 16], [52, 20], [64, 30], [26, 42], [46, 44], [70, 10], [56, 38]];
const SITE_THING = { home: 'beds', store: 'crates', workshop: 'bench', garden: 'bedsG', well: 'bucket' };
const ROAD_LINKS = [
  ['home','hall',[]],['hall','store',[]],['home','yard',[[22,28],[20,31]]],
  ['yard','garden',[[23,37]]],['hall','crossing',[[33,28],[37,32]]],
  ['garden','crossing',[[36,39],[38,37]]],['crossing','well',[]],
  ['well','workshop',[[55,35],[59,33]]],['workshop','watch',[[67,29],[71,23],[72,17],[70,14]]],
];

// 确定性 hash（不用 Math.random：地图每次刷新必须逐位相同）。
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
  keys.forEach((r, i) => { out[r] = w.districts?.[r]?.at ?? w.layout?.sites[r] ?? SITES[r] ?? residentialSite(r,w.peripheralHomes) ?? SITE_FALLBACK[i % SITE_FALLBACK.length]; });
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
// 地表邻接只用于烘焙：像素材质图不参与寻路、视野或世界状态。
// 田畦是菜园的户外场景；地面、植物与避让共用同一份几何。
function farmBeds(w) {
  return (w.plots ?? []).filter(p=>p.bed).map(({id,bed,growth,moisture})=>({
    id,x:bed.x*TILE,y:bed.z*TILE,w:bed.w*TILE,h:bed.d*TILE,growth,moisture,
  }));
}
const insideBed=(x,y,b,pad=0)=>x>=b.x-pad&&x<b.x+b.w+pad&&y>=b.y-pad&&y<b.y+b.h+pad;
const GROUND = { grass: 0, water: 1, bank: 2, road: 3, soil: 4 };
function paintTerrain(g, roadDist, sites, beds, hash2, streamCenter, streamHalfWidth) {
  const kinds = new Uint8Array(WORLD_W * WORLD_H);
  // 地形配色重做：草地不再分「亮草 / 林下暗块」两档硬切。
  // 先按到最近树的距离 + 低频噪声算连续绿度，再用 Bayer 有序抖动在相邻色阶间过渡。
  const shade = new Uint8Array(WORLD_W * WORLD_H);
  {
    // 注意：paintTerrain 在树生成之前调用，这里按同一套 hash 规则近似算树位（只用于配色，不进世界状态）。
    const approx = [];
    for (let ty = 0; ty < WORLD_TH; ty += 1) for (let tx = 0; tx < WORLD_TW; tx += 1) {
      const edge = Math.min(tx, WORLD_TW - 1 - tx, ty, WORLD_TH - 1 - ty);
      const density = edge < 6 ? .20 : edge < 14 ? .10 : .038;
      if (hash2(tx, ty, 4) > density) continue;
      if (Object.values(sites).some(([sx, sy]) => Math.abs(tx - sx) < 5 && ty > sy - 10 && ty < sy + 1)) continue;
      approx.push([tx, ty]);
    }
    const tw = WORLD_TW, th = WORLD_TH, dist = new Float32Array(tw * th).fill(99);
    for (const [tx, ty] of approx) for (let dy = -14; dy <= 14; dy += 1) for (let dx = -14; dx <= 14; dx += 1) {
      const x = tx + dx, y = ty + dy;
      if (x < 0 || y < 0 || x >= tw || y >= th) continue;
      const d = Math.hypot(dx, dy * 1.15), i = y * tw + x;
      if (d < dist[i]) dist[i] = d;
    }
    for (let ty = 0; ty < th; ty += 1) for (let tx = 0; tx < tw; tx += 1) {
      const d = dist[ty * tw + tx];
      const near = Math.max(0, Math.min(1, (13 - d) / 13));
      const n = hash2(Math.floor(tx / 3), Math.floor(ty / 3), 11);
      const level = Math.max(0, Math.min(1, near * .56 + n * .30 - .12));
      for (let y = ty * TILE; y < (ty + 1) * TILE; y += 1)
        for (let x = tx * TILE; x < (tx + 1) * TILE; x += 1) shade[y * WORLD_W + x] = Math.round(level * 15);
    }
  }
  const waterDepth = new Float32Array(kinds.length), roadDepth = new Float32Array(kinds.length);
  // 低频噪声的控制点只算一次；每像素只插值，避免反复 hash。
  const noiseField = scale => {
    const width = Math.ceil(WORLD_W / scale) + 1, height = Math.ceil(WORLD_H / scale) + 1;
    const values = new Float32Array(width * height);
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) values[y * width + x] = hash2(x, y, 11);
    const columns = Array.from({ length: WORLD_W }, (_, x) => { const f = x / scale % 1; return [Math.floor(x / scale), f * f * (3 - 2 * f)]; });
    return (x, y) => {
      const [ix, u] = columns[x], fy = y / scale % 1, v = fy * fy * (3 - 2 * fy), i = Math.floor(y / scale) * width + ix;
      const a = values[i], b = values[i + 1], c = values[i + width], d = values[i + width + 1];
      return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
    };
  };
  const edgeNoise = noiseField(24), grassNoise = noiseField(64);
  // 道路距离在 2px 采样格上缓存，再线性插值；轮廓仍逐像素描绘。
  const stride = WORLD_W / 2 + 1, distances = new Float32Array(stride * (WORLD_H / 2 + 1));
  for (let y = 0; y <= WORLD_H; y += 2) for (let x = 0; x <= WORLD_W; x += 2) distances[y / 2 * stride + x / 2] = roadDist(x, y);
  const distance = (x, y) => {
    const i = (y >> 1) * stride + (x >> 1), u = (x % 2) / 2, v = (y % 2) / 2;
    const a = distances[i], b = distances[i + 1], c = distances[i + stride], d = distances[i + stride + 1];
    return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
  };
  for (let y = 0; y < WORLD_H; y += 1) {
    const center = streamCenter(y), half = streamHalfWidth(y);
    for (let x = 0; x < WORLD_W; x += 1) {
      const i = y * WORLD_W + x;
      const wet = half - Math.abs(x - center), road = distance(x, y);
      const rough = edgeNoise(x, y) * 2 - 1;
      waterDepth[i] = wet; roadDepth[i] = road;
      if (wet >= 0) kinds[i] = GROUND.water;
      else if (wet > -3 - rough) kinds[i] = GROUND.bank;
      else if (road < 12 + rough) kinds[i] = GROUND.road;
      else {
        if (beds.some(b=>insideBed(x,y,b)) && wet < -16) kinds[i] = GROUND.soil;
      }
    }
  }
  const image = g.createImageData(WORLD_W * ART, WORLD_H * ART), pixels = image.data;
  const textures = {};
  for (const material of ['grass', 'dirt', 'water']) for (let v = 0; v < 4; v++) {
    const tile = document.createElement('canvas'); tile.width = 32; tile.height = 32;
    const ctx = tile.getContext('2d'); const source = ASSETS.scenes[`terrain_${material}${v}`];
    if (source) ctx.drawImage(source, 0, 0); textures[`${material}${v}`] = source ? ctx.getImageData(0, 0, 32, 32).data : null;
  }
  const rgb = Object.fromEntries(['#008751', '#00E436', '#1D2B53', '#29ADFF', '#FFCCAA', '#C2C3C7', '#FFF1E8', '#AB5236', '#7E2553', '#5F574F', '#FFA300'].map(c => [c, [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16))]));
  const ramps = { '#008751': [86,141,62], '#00E436': [152,189,81], '#1D2B53': [30,61,75], '#29ADFF': [69,137,150], '#FFCCAA': [237,199,135], '#C2C3C7': [185,184,161], '#AB5236': [216,166,103], '#7E2553': [186,135,82], '#5F574F': [114,81,59] };
  const at = (x, y, fallback) => x < 0 || y < 0 || x >= WORLD_W || y >= WORLD_H ? fallback : kinds[y * WORLD_W + x];
  const isDirt = k => k === GROUND.road || k === GROUND.soil;
  for (let y = 0; y < WORLD_H; y += 1) for (let x = 0; x < WORLD_W; x += 1) {
    const i = y * WORLD_W + x, k = kinds[i], q = BAYER[(y % 4) * 4 + x % 4];
    const n = at(x, y - 1, k), e = at(x + 1, y, k), south = at(x, y + 1, k), west = at(x - 1, y, k);
    // N/E/S/W 的邻接掩码让连片地形共享轮廓，不在每块 tile 上重复画框。
    const dirt = isDirt(k), sameN = n === k || (dirt && isDirt(n)), sameE = e === k || (dirt && isDirt(e));
    const sameS = south === k || (dirt && isDirt(south)), sameW = west === k || (dirt && isDirt(west));
    const mask = (sameN ? 1 : 0) | (sameE ? 2 : 0) | (sameS ? 4 : 0) | (sameW ? 8 : 0);
    let color = '#008751';
    if (k === GROUND.water) {
      color = '#1D2B53';
      if (waterDepth[i] < 4 && q < 8) color = '#29ADFF';
      if (mask !== 15 && (!sameN || !sameW)) color = q < 6 ? '#C2C3C7' : '#29ADFF';
      if (waterDepth[i] > 4 && y % 13 === 0 && (x + Math.floor(y / 13) * 3) % 19 < 6) color = '#29ADFF';
    } else if (k === GROUND.bank) {
      color = q < 5 ? '#C2C3C7' : '#FFCCAA';
      if (south === GROUND.water || e === GROUND.water) color = '#5F574F';
      if ((n === GROUND.grass || west === GROUND.grass) && q < 6) color = '#008751';
    } else if (isDirt(k)) {
      color = '#AB5236';
      if (k === GROUND.soil && y % 9 < 2) color = '#7E2553';
      if (k === GROUND.road && roadDepth[i] < 3 && q < 3) color = '#7E2553';
      if (mask !== 15) {
        if (!sameN || !sameW) color = q < 10 ? '#FFCCAA' : '#AB5236';
        else if (!sameS || !sameE) color = '#7E2553';
      } else if (hash2(Math.floor(x / 3), Math.floor(y / 3), 12) > 0.985 && q < 2) color = '#FFA300';
    } else {
      const patch = grassNoise(x, y);
      if (patch > 0.7 && hash2(x, y, 12) > .99) color = '#00E436';
      // 外侧 1–2px 路肩/田缘：零 alpha 的有序抖动，转角同时看斜邻居。
      const inner = isDirt(n) || isDirt(e) || isDirt(south) || isDirt(west);
      const outer = inner || isDirt(at(x - 2, y, k)) || isDirt(at(x + 2, y, k)) || isDirt(at(x, y - 2, k)) || isDirt(at(x, y + 2, k)) || isDirt(at(x - 1, y - 1, k)) || isDirt(at(x + 1, y + 1, k));
      if (outer && q < (inner ? 9 : 3)) color = '#AB5236';
      const bank = n === GROUND.bank || e === GROUND.bank || south === GROUND.bank || west === GROUND.bank;
      if (bank && q < 5) color = '#C2C3C7';
    }

    const c = ramps[color] ?? rgb[color], material = k === GROUND.grass && color === '#008751' ? 'grass' : isDirt(k) && color === '#AB5236' ? 'dirt' : k === GROUND.water && color === '#1D2B53' ? 'water' : null;
    const texture = material && textures[`${material}${Math.floor(hash2(Math.floor(x / TILE), Math.floor(y / TILE), 19) * 4)}`];
    for (let dy = 0; dy < ART; dy++) for (let dx = 0; dx < ART; dx++) {
      const offset = ((y * ART + dy) * WORLD_W * ART + x * ART + dx) * 4, ti = (((y * ART + dy) % 32) * 32 + (x * ART + dx) % 32) * 4;
      const deep = k === GROUND.grass && q < shade[i];
      pixels[offset] = deep ? 49 : texture ? texture[ti] : c[0];
      pixels[offset + 1] = deep ? 84 : texture ? texture[ti + 1] : c[1];
      pixels[offset + 2] = deep ? 49 : texture ? texture[ti + 2] : c[2];
      pixels[offset + 3] = 255;
    }
  }
  g.putImageData(image, 0, 0);
  return kinds;
}
function paintForestFloor(g, trees, blockers, terrain) {
  // 只补确定性林下细节散点；连续绿阶已在 paintTerrain 里完成，这里绝不再整块盖色。
  const image = g.getImageData(0, 0, WORLD_W * ART, WORLD_H * ART), pixels = image.data;
  for (let y = 0; y < WORLD_H; y += 1) for (let x = 0; x < WORLD_W; x += 1) {
    if (terrain[y * WORLD_W + x] !== GROUND.grass || hash2(x, y, 23) >= .06) continue;
    for (let sy = 0; sy < ART; sy += 1) for (let sx = 0; sx < ART; sx += 1) {
      const off = ((y * ART + sy) * WORLD_W * ART + x * ART + sx) * 4;
      pixels[off] = 63; pixels[off + 1] = 112; pixels[off + 2] = 54;
    }
  }
  g.putImageData(image, 0, 0);
}

let worldCache = null;
const worldCaches = new Map();
const outskirtsCache=new WeakMap();
let terrainAtlas, terrainAtlasReady;
function outskirtsAtlas() {
  if (terrainAtlas && terrainAtlasReady===ASSETS.ready) return terrainAtlas;
  terrainAtlasReady=ASSETS.ready;
  terrainAtlas=document.createElement('canvas');
  terrainAtlas.width=128;terrainAtlas.height=128;
  const g=terrainAtlas.getContext('2d');
  g.imageSmoothingEnabled=false;
  for (const [row,material,fallback] of [[0,'grass','#568D3E'],[1,'dirt','#BA8752'],[2,'stone','#939584'],[3,'water','#1E3D4B']]) {
    for (let i=0;i<4;i++) {
      const tile=ASSETS.scenes[`terrain_${material}${i}`];
      if (tile) g.drawImage(tile,i*32,row*32,32,32);
      else { g.fillStyle=fallback;g.fillRect(i*32,row*32,32,32); }
    }
  }
  return terrainAtlas;
}
function campOutskirts(w, world) {
  const key=world.canvas;
  let terrain=outskirtsCache.get(key);
  if (!terrain) {
    terrain=world.landscape??createCampOutskirts(w.mapSeed??0,w.layoutVersion??0,w.layout?.crossZ??34,world);
    outskirtsCache.set(key,terrain);
  }
  return terrain;
}
function terrainPixels() {
  if (worldCache.terrainWalk3d) return worldCache.terrainWalk3d;
  return worldCache.terrainPixels ??= expandWalk(worldCache.movementWalk, WORLD_TW, TILE);
}
function worldWithCollisions(sites, w) {
  const buildings = w.buildings ?? [];
  const timber=w.camp?.timber;
  const treeSignature=timber?worldCache.grove.map(t=>timber[t.id]?.stage??'mature').join(','):'';
  const appearance=homeAppearance(w,sites);
  const signature=workModelKey(w,appearance,treeSignature);
  if (worldCache.buildingMaskSignature !== signature) {
    const { assetWalk, scene3d } = worldCache;
    if (scene3d) {
      const boxes=[], previous=worldCache.workProjects;
      const projects=addCampWork(boxes,w,appearance);
      for (const project of projects) {
        const old=previous?.find(p=>p.id===project.id);
        project.since=previous && old?.phase!==project.phase ? performance.now() : old?.since??-1000;
      }
      worldCache.workProjects=projects;
      boxes.push(...timberStage(timber,worldCache.grove).boxes);
      worldCache.work3d=boxes;
      const solids=boxes.filter(b=>b.solid).map(b=>({...b,...(b.bounds??modelBounds(b))}));
      worldCache.outsideSolids=solids.filter(b=>!inCamp(b.x+b.w/2,b.z+b.d/2));
      const collisionSignature=JSON.stringify(solids.map(b=>[b.x,b.z,b.w,b.d].join(',')).sort());
      if (worldCache.solidSignature!==collisionSignature) {
        worldCache.solidSignature=collisionSignature;
        worldCache.assetPixels=solids.length?assetWalk.slice():assetWalk;
        stampSceneCollision(worldCache.assetPixels,WORLD_W,WORLD_H,{boxes:solids});
        worldCache.pixelBase=terrainPixels().map((value,index)=>value & worldCache.assetPixels[index]);
        worldCache.collisionRevision=-1;
      }
      const homeSolids=solids.filter(b=>b.occluder?.endsWith(':house'));
      const homeBlockerKey=JSON.stringify(homeSolids.map(b=>[b.x,b.z,b.w,b.d].join(',')).sort());
      if (worldCache.homeBlockerKey!==homeBlockerKey) {
        worldCache.homeBlockerKey=homeBlockerKey;
        const blockers=new Set(worldCache.blockers);
        for (const b of homeSolids) {
          for (let z=Math.ceil(b.z-.5); z<b.z+b.d-.5; z++) {
            for (let x=Math.ceil(b.x-.5); x<b.x+b.w-.5; x++) blockers.add(tileKey(x,z));
          }
        }
        worldCache.visibleBlockers=blockers;
      }
    } else {
      const lots=[...buildings,...(w.sites??[])].map(b=>b.lot??constructionLot(b.loc,w.layout)).filter(Boolean);
      const grove=timberStage(timber,worldCache.grove);
      worldCache.assetPixels=lots.length || grove.boxes.length ? assetWalk?.slice()??new Uint8Array(WORLD_W*WORLD_H).fill(1) : assetWalk;
      for (const lot of lots) fillCollisionRect(worldCache.assetPixels,WORLD_W,WORLD_H,
        lot.x*TILE,lot.z*TILE,Math.ceil(lot.w*TILE),Math.ceil(lot.d*TILE),0);
      if (grove.boxes.length) stampSceneCollision(worldCache.assetPixels,WORLD_W,WORLD_H,grove);
      const assets=worldCache.assetPixels;
      worldCache.pixelBase=assets ? terrainPixels().map((value,index)=>value & assets[index]) : null;
      worldCache.collisionRevision=-1;
    }
    worldCache.buildingMaskSignature=signature;
  }
  if (worldCache.scene3d) {
    const homeKey=JSON.stringify(appearance);
    if (worldCache.homeKey!==homeKey) {
      worldCache.homeKey=homeKey;
      worldCache.homes3d=outdoorHomes(w,appearance);
    }
  }
  if (worldCache.collisionRevision !== collisionEditor.revision) {
    const cells = worldCache.mapSeed ? new Map() : collisionEditor.cells('map');
    const base = worldCache.pixelBase ?? (cells.size ? terrainPixels() : null);
    worldCache.collisionGrid = base ? {
      tw: WORLD_W, th: WORLD_H, walk: overrideWalk(base, cells, worldCache.assetPixels),
    } : null;
    worldCache.collisionRevision = collisionEditor.revision;
  }
  const { scene3d, lifeLayers } = worldCache;
  const occupied=new Set([...(w.buildings??[]),...(w.sites??[])].map(b=>b.loc));
  const openLots=(w.outdoor??[]).flatMap(loc=>{
    const lot=w.districts?.[loc]?.lot??constructionLot(loc,w.layout);
    return !lot || occupied.has(loc)?[]:[{loc,lot}];
  });
  const beds=farmBeds(w);
  let life3d;
  if (scene3d) {
    const livestock=w.livestock ?? {};
    const plots=beds.map(({growth,...b})=>({...b,
      growth:growth>0 ? Math.max(1,Math.floor(growth*20))/20 : 0,
      moisture:(b.moisture??0)>0,
    }));
    const berryPatches=w.berryPatches && Object.fromEntries(Object.entries(w.berryPatches)
      .map(([site,patches])=>[site,patches.map(Math.floor)]));
    const plantStock=berryPatches ?? ['yard','garden'].map(site=>Math.min(3,Math.floor(w.wildBerries?.[site]??3)));
    const key=[livestock.orchards,livestock.chickens,livestock.cows,livestock.sheep,JSON.stringify(plots),w.season,
      JSON.stringify(plantStock),JSON.stringify(w.ecoSources),Math.min(3,w.produce?.fruit??0)].join(',');
    life3d=lifeLayers.get(key);
    if (!life3d) {
      life3d=outdoorLife({ ...worldCache, sites, beds:plots, livestock, layout:w.layout, layoutVersion:w.layoutVersion, season:w.season, wildBerries:w.wildBerries, berryPatches, ecoSources:w.ecoSources, produce:w.produce, housing:w.housing });
      lifeLayers.set(key,life3d);
      if (lifeLayers.size>8) lifeLayers.delete(lifeLayers.keys().next().value);
    }
  }
  worldCache.districtResources??=districtResources(w.districts);
  return { ...worldCache, sites, beds, life3d, timber, openLots, blockers:worldCache.visibleBlockers??worldCache.blockers };
}
function stampSceneCollision(walk, width, height, scene) {
  for (const b of scene.boxes) {
    if (!b.solid) continue;
    fillCollisionRect(walk,width,height,...collisionFootprint(b,TILE),0);
  }
}

function buildWorld(w) {
  const liveSites = sitesOf(w);
  const mapSeed=w.mapSeed??0;
  const staticSites=Object.fromEntries(Object.entries(liveSites).filter(([room])=>
    !w.districts?.[room] && (!campRenderer || !residentialSite(room,w.peripheralHomes))));
  const pads=districtPads(w.districts);
  const sites=staticSites;
  const sig=JSON.stringify([w.layoutVersion??0,mapSeed,staticSites,pads,ASSETS.ready,Boolean(campRenderer),Boolean(w.camp?.timber),Boolean(w.households),Object.entries(w.homeRoads??{}).filter(([k,v])=>w.peripheralHomes?.[k]?v.present:!v.present)
    .map(([k])=>k).sort(),campRenderer?null:farmBeds(w).map(b=>({...b,growth:b.growth>=1?2:Number(b.growth>0),moisture:0}))]);
  if (worldCaches.has(sig)) {
    worldCache = worldCaches.get(sig);
    return worldWithCollisions(liveSites, w);
  }
  const { river, riverCenter:streamCenter, riverHalfWidth:streamHalfWidth, hills: candidates }=
    campTerrain(mapSeed, Boolean(w.camp), w.layoutVersion);
  const grove=w.layout?.grove??TIMBER_GROVE;
  const terrainHash=mapSeed ? (x,z,s)=>hash2(x,z,s+mapSeed) : hash2;
  const cv = document.createElement('canvas');
  cv.width = WORLD_W * ART; cv.height = WORLD_H * ART;
  const g = cv.getContext('2d');
  g.setTransform(ART, 0, 0, ART, 0, 0); g.imageSmoothingEnabled = false;
  const blockers = new Set(), movementBlockers = new Set(), masks = [];
  const occupy = (x, y, mask) => {
    const key = tileKey(x, y);
    blockers.add(key);
    if (!mask && !campRenderer) movementBlockers.add(key);
  };
  // fx 锚点：树冠 / 烟囱 / 屋舍，世界 tile 坐标。场景动画必须贴在这些真实物件上，
  // 而不是随机撒点 —— 否则「草被吹动」会长到河面或屋顶上。
  const trees = [];
  const chimneys = [];
  // 高个可遮挡物（树 / 屋舍）不再烘进静态底图，而是各自记录为对象，交给 drawViewport 按脚底 Y 深度排序绘制。
  const objects = [], bridges = [], rocks = [];

  // 缓弯土路：共享入口与桥位，曲线只用于烘焙，不改变引擎地点关系。
  const roads=[],bins=new Map(),binSize=64;
  const addSegment=(a,b,hidden)=>{
    const r=[...a,...b,hidden];roads.push(r);
    for(let y=Math.floor((Math.min(a[1],b[1])-40)/binSize);y<=Math.floor((Math.max(a[1],b[1])+40)/binSize);y++)
      for(let x=Math.floor((Math.min(a[0],b[0])-40)/binSize);x<=Math.floor((Math.max(a[0],b[0])+40)/binSize);x++){
        const key=tileKey(x,y);if(!bins.has(key))bins.set(key,[]);bins.get(key).push(r);
      }
  };
  const routeSites=w.layout?{...w.layout.sites,...w.layout.nodes}:{...sites};
  const links=w.layout?[...w.layout.links]:[...ROAD_LINKS];
  if (!w.layout) {
    if(sites.well)routeSites.crossing=[Math.round(river(34))-4,34];
    const homes=w.households?Object.keys(HOUSING_PLOTS):Object.keys(liveSites).filter(residentialSite);
    if (homes.length) {
      Object.assign(routeSites,{residential:[75,38],northLane:[89,43],southLane:[89,56],edgeLane:[89,69]});
      links.push(['workshop','residential',[[68,33]]],['residential','northLane',[[79,40]]],['northLane','southLane',[]]);
      if (w.households) links.push(['southLane','edgeLane',[]]);
      for (const room of homes) {
        routeSites[room]=residentialSite(room);
        const z=routeSites[room][1];
        links.push([z<50?'northLane':z<62?'southLane':'edgeLane',room,[]]);
      }
    }
    if (w.camp?.timber && sites.yard) {
      routeSites.grove=[15,42];
      links.push(['yard','grove',[[19,37],[17,40]]]);
    }
    if(!sites.well&&sites.store&&sites.watch){routeSites.crossing=[Math.round(river(34))-4,34];links.push(['store','crossing',[[38,28]]],['crossing','watch',[[49,34],[61,32],[71,23],[72,17],[70,14]]]);}
  }
  for (const [loc,district] of Object.entries(w.districts??{})) {
    const home='house-'+loc;
    if (!district.home || !w.households?.deeds[home] || !w.homeRoads?.[home]?.present) continue;
    const [x,z]=district.home;
    const [sx,sz]=district.at;
    addSegment([(x+.5)*TILE,(z-1.1)*TILE],[(x+.5)*TILE,(sz+2.6)*TILE]);
    addSegment([(x+.5)*TILE,(sz+2.6)*TILE],[(sx+.5)*TILE,(sz+2.6)*TILE]);
  }
  for(const [u,v,mids] of links){
    if(!routeSites[u]||!routeSites[v])continue;
    const points=[routeSites[u],...mids,routeSites[v]].map(p=>p.map(n=>n*TILE+8));
    for(let j=0;j<points.length-1;j++){
      const p0=points[Math.max(0,j-1)],p1=points[j],p2=points[j+1],p3=points[Math.min(points.length-1,j+2)];
      const steps=Math.max(1,Math.ceil(Math.hypot(p2[0]-p1[0],p2[1]-p1[1])/8));let prev=p1;
      for(let i=1;i<=steps;i++){
        const t=i/steps,pt=[0,1].map(k=>.5*((2*p1[k])+(-p0[k]+p2[k])*t+(2*p0[k]-5*p1[k]+4*p2[k]-p3[k])*t*t+(-p0[k]+3*p1[k]-3*p2[k]+p3[k])*t*t*t));
        addSegment(prev,pt,w.homeRoads?.[v]?.present===false);prev=pt;
      }
    }
  }
  const roadDist=(px,py,paint=false)=>(bins.get(tileKey(Math.floor(px/binSize),Math.floor(py/binSize)))??[]).reduce((d,r)=>paint && r[4] ? d : Math.min(d,distSeg(px,py,r[0],r[1],r[2],r[3])),80);
  const onRoad=(tx,ty)=>roadDist(tx*TILE+8,ty*TILE+8)<23;
  const nearSite = (tx, ty, pad = 2) => Object.values(sites).some(([sx, sy]) => Math.abs(tx - sx) < pad && Math.abs(ty - sy) < pad);
  const onRiver = (tx, ty) => Math.abs(tx * TILE + 8 - streamCenter(ty*TILE+8)) < 34;

  // 1–3) 邻接材质统一烘焙草/土/水/岸/路；桥保持原来几何。
  const beds=campRenderer?[]:farmBeds(w);
  const land=campBeds(sites.garden,mapSeed,w.layoutVersion);
  const pen=campRenderer?penLayout(sites):null;
  const onFarm=(x,z,pad=0)=>land.some(b=>x>=b.x-pad && x<b.x+b.w+pad && z>=b.z-pad && z<b.z+b.d+pad);
  const inPen=(tx,tz)=>pen && tx+.5>=pen.x-1 && tx+.5<=pen.x+pen.w+1 &&
    tz+.5>=pen.z-1 && tz+.5<=pen.z+pen.d+1;
  const reserved=Object.keys(sites).map(room=>constructionLot(room,w.layout)).filter(Boolean);
  if (w.households) for (const [x,z] of Object.keys(HOUSING_PLOTS).map(room=>w.layout?.sites[room]??HOUSING_PLOTS[room])) reserved.push({x:x-3.15,z:z-6.5,w:6.3,d:6.8});
  const flatLand=[
    ...reserved,...pads,
    ...Object.values(sites).map(([x,z])=>({x:x-4.5,z:z-8,w:9,d:11})),
    ...land,
    ...grove.map(({x,z})=>({x:x-1,z:z-1,w:2,d:2})),
    ...(pen?[pen]:[]),
  ];
  const hills=candidates.filter(hill=>{
    const {x,z,rx,rz}=hill;
    const footprint={x:x-rx-1,z:z-rz,w:2*rx+2,d:2*rz};
    return !flatLand.some(lot=>overlapsLot(footprint,lot)) &&
      Array.from({length:2*rz+1},(_,i)=>z-rz+i).every(y=>Math.abs(x-river(y))>rx+3.5);
  });
  const roadDistance=(x,z)=>roadDist(x*TILE,z*TILE,true)/TILE;
  const highGround=(x,z)=>hills.some(hill=>reliefAt(hill,x+.5,z+.5)>.055);
  const nearLot=(x,z,pad=.85)=>reserved.some(lot=>overlapsLot({x,z,w:1,d:1},lot,pad));
  const nearGrove=(x,z)=>Boolean(w.camp?.timber) && grove.some(t=>Math.hypot(x+.5-t.x,z+.5-t.z)<1.7);
  const plantClearance=(x,z)=>{
    const tx=Math.floor(x),tz=Math.floor(z);
    return !inPen(tx,tz) && !nearLot(tx,tz,0) && !nearGrove(tx,tz) && !onFarm(x,z,.8) &&
      !nearSite(x,z,2.5) && roadDistance(x,z)>1.3 &&
      !blockers.has(tileKey(tx,tz)) && !flatLand.some(lot=>
        x>=lot.x && x<lot.x+lot.w && z>=lot.z && z<lot.z+lot.d);
  };
  const harvestNodes=w.camp ? campPlants(w.layout,12,mapSeed,w.layoutVersion,w.ecoSources ?
    {...w.ecoSources,fruit:Array.from({length:12},(_,slot)=>({id:`fruit:${slot}`,slot}))} : undefined) : [];
  const landscape=campRenderer && w.camp ? createCampOutskirts(mapSeed,w.layoutVersion??0,w.layout?.crossZ??34,
    {flatLand,hills,roadDistance,plantClearance,harvestNodes,districtPads:pads}) : null;
  const terrain = paintTerrain(g, (x,z)=>roadDist(x,z,true), sites, beds, terrainHash, streamCenter, streamHalfWidth), grass=[];
  // 草簇与野花只落在草地，避免覆盖路肩和岸线。
  for (let ty = 0; ty < WORLD_TH; ty += 1) for (let tx = 0; tx < WORLD_TW; tx += 1) {
    const px = tx * TILE, py = ty * TILE, h = terrainHash(tx, ty, 1);
    if (terrain[(py + 8) * WORLD_W + px + 8] !== GROUND.grass || highGround(tx,ty)) continue;
    if (campRenderer && h > .91 && !nearLot(tx,ty,0) && !nearGrove(tx,ty) && !onFarm(tx+.5,ty+.5)) grass.push([tx+.5,ty+.5]);
    if (h > 0.72) { g.fillStyle = '#00E436'; g.fillRect(px + 4, py + 8, 1, 2); g.fillRect(px + 3, py + 7, 1, 1); }
    if (h > 0.97) { g.fillStyle = '#FFEC27'; g.fillRect(px + 10, py + 5, 1, 1); }
    else if (h < 0.02) { g.fillStyle = '#FF77A8'; g.fillRect(px + 7, py + 11, 1, 1); }
    // 野花/浆果点：确定性散点，让 2D 兜底视图也能读到新增的世界内容。
    const fh = terrainHash(tx, ty, 31);
    if (fh > 0.965) { g.fillStyle = '#FFF0CC'; g.fillRect(px + 12, py + 9, 2, 2); g.fillStyle = '#FFA300'; g.fillRect(px + 12, py + 9, 1, 1); }
    else if (fh > 0.94) { g.fillStyle = '#FF77A8'; g.fillRect(px + 3, py + 3, 2, 2); }
    else if (fh < 0.012) { g.fillStyle = '#315431'; g.fillRect(px + 5, py + 6, 5, 3); }
  }
  // 一次跨河对应一座完整木桥；同一组 bridgeCells 同时决定绘制与可走范围。
  const bridgeCells=new Set(),bridgeRows=[];
  if (w.layout) bridgeRows.push(w.layout.crossZ);
  else for(let ty=1;ty<WORLD_TH-1;ty++)if(roadDist(river(ty+.5)*TILE,ty*TILE+8)<14)bridgeRows.push(ty);
  const groups=[];
  for (const row of bridgeRows) {
    const first=Math.max(0,row-1), last=Math.min(WORLD_TH-1,row+1), prior=groups.at(-1);
    if (prior && first<=prior[1]+1) prior[1]=Math.max(prior[1],last);
    else groups.push([first,last]);
  }
  for(const [first,last] of groups){
    const y0=first*TILE,y1=(last+1)*TILE;
    let west=Infinity,east=-Infinity;
    for (let y=y0;y<y1;y+=1) {
      const center=streamCenter(y), half=streamHalfWidth(y);
      west=Math.min(west,center-half);
      east=Math.max(east,center+half);
    }
    // 两侧坡道均伸过河岸，留出角色和推车的上桥余量。
    const x0=Math.floor((west-1.65*TILE)/TILE)*TILE,x1=Math.ceil((east+1.65*TILE)/TILE)*TILE;
    bridges.push([x0/TILE,y0/TILE,x1/TILE,y1/TILE]);
    if (!campRenderer) {
      g.fillStyle='#514134';g.fillRect(x0,y0,x1-x0,y1-y0);
      for(let x=x0+1;x<x1-1;x+=5){g.fillStyle='#BA8752';g.fillRect(x,y0+2,4,y1-y0-4);g.fillStyle='#EDC787';g.fillRect(x,y0+2,1,y1-y0-4);}
      for(const y of [y0,y1-2]){g.fillStyle='#72513B';g.fillRect(x0,y,x1-x0,2);g.fillStyle='#D8A667';g.fillRect(x0,y,x1-x0,1);}
    }
    for(let ty=first;ty<=last;ty++)for(let tx=x0/TILE;tx<x1/TILE;tx++)bridgeCells.add(tileKey(tx,ty));
  }

  // 成排菜畦、泥土垄沟和留出的通行埂；植株仅为环境表现，不捏造收获状态。
  for(const b of beds){
    g.fillStyle='#72513B';g.fillRect(b.x,b.y,b.w,b.h);g.fillStyle='#BA8752';g.fillRect(b.x,b.y,b.w,1);
    for(let y=b.y+4;y<b.y+b.h-2;y+=7){
      g.fillStyle='#482D2B';g.fillRect(b.x+2,y+4,b.w-4,2);
      if (!b.growth) continue;
      for(let x=b.x+5;x<b.x+b.w-2;x+=9){
        if(terrainHash(x,y,81)<.1)continue;
        g.fillStyle='#315431';g.fillRect(x-2,y,5,3);g.fillRect(x,y-3,2,5);
        g.fillStyle=b.growth>=1?'#D6AE69':'#98BD51';g.fillRect(x-3,y-1,3,1);g.fillRect(x+1,y-2,3,1);
        g.fillStyle='#73A747';g.fillRect(x-1,y-2,2,2);
        if(b.growth>=1){g.fillStyle='#D27A4A';g.fillRect(x+1,y+1,2,2);}
      }
    }
    for(const x of [b.x-1,b.x+b.w]){g.fillStyle='#514134';g.fillRect(x,b.y,1,b.h);}
  }
  const watch = sites.watch ?? SITES.watch;
  for (let ty = watch[1] - 6; ty <= watch[1] + 6; ty += 1) for (let tx = watch[0] - 8; tx <= watch[0] + 8; tx += 1) {
    if (highGround(tx,ty) || onRoad(tx, ty) || nearLot(tx,ty)) continue;
    const d = Math.hypot((tx - watch[0]) / 7, (ty - watch[1]) / 5);
    if (d > 1.25 || (d <= 1 && terrainHash(tx, ty, 3) > 0.82)) continue;
    const px = tx * TILE, py = ty * TILE;
    if (d > 1) { if (terrainHash(tx, ty, 3) > 0.55) { g.fillStyle = '#6D7165'; g.fillRect(px + 6, py + 7, 4, 3); } continue; }
    rocks.push([tx,ty]);
    const boulder = ASSETS.scenes.prop_boulder;
    if (boulder && !campRenderer) g.drawImage(boulder, px - 2, py - 4, 20, 20);
    const mask = campRenderer ? null : placement('prop_boulder', px - 2, py - 4, 20, 20);
    if (mask) masks.push(mask);
    occupy(tx, ty, mask);
  }

  const byBridge=(x,z)=>bridges.some(([x0,z0,x1,z1])=>x>=x0-1 && x<=x1 && z>=z0-1 && z<=z1);
  // 5) 树林：边缘密、村落内部疏；避开道路、河、田、岩与屋舍。树冠双 tone + 树干。
  for (let ty = 0; ty < WORLD_TH; ty += 1) for (let tx = 0; tx < WORLD_TW; tx += 1) {
    if (highGround(tx,ty) || onRoad(tx, ty) || onRiver(tx, ty) || byBridge(tx,ty) || inPen(tx,ty) || nearLot(tx,ty) || nearGrove(tx,ty) || blockers.has(tileKey(tx, ty))) continue;
    const edge = Math.min(tx, WORLD_TW - 1 - tx, ty, WORLD_TH - 1 - ty);
    const density = landscape ? forestDensity(mapSeed,tx+.5,ty+.5)*.76 :
      edge < 6 ? 0.20 : edge < 14 ? 0.10 : 0.038;
    if(trees.some(([x,y])=>Math.hypot(x-tx,(y-ty)*1.25)<2.8)||beds.some(b=>insideBed(tx*TILE+8,ty*TILE+8,b,28)))continue;
    if (terrainHash(tx, ty, 4) > density || nearSite(tx, ty, 4) || Object.values(sites).some(([sx, sy]) => Math.abs(tx - sx) < 5 && ty > sy - 10 && ty < sy + 1)) continue;
    const mask = campRenderer ? null : placement(treeAsset(tx, ty), tx * TILE - 24, ty * TILE - 64, 64, 80);
    if (mask) masks.push(mask);
    occupy(tx, ty, mask);
    trees.push([tx, ty]);
    objects.push({ kind: 'tree', tx, ty });
  }

  // 世界植被：果树棵数与服务器 livestock.orchards 同源绑定（改量#12 遗项⑤），其余植被确定性哈希。
  const cands = [];
  for (let ty = 0; !landscape && ty < WORLD_TH; ty += 1) for (let tx = 0; tx < WORLD_TW; tx += 1) {
    if (highGround(tx,ty) || onRoad(tx, ty) || onRiver(tx, ty) || inPen(tx,ty) || nearLot(tx,ty) || nearGrove(tx,ty) || blockers.has(tileKey(tx, ty))) continue;
    if (onFarm(tx+.5,ty+.5,1.25)) continue;
    const near = Object.values(sites).some(([sx, sy]) => Math.hypot(tx - sx, ty - sy) < 6);
    if (near) continue;
    const h = terrainHash(tx, ty, 31);
    // 果树候选放宽到村落外环（6–14 格），让默认首屏边缘就能看到；其余植被仍在林子里。
    const ring = Object.values(sites).some(([sx, sy]) => { const d = Math.hypot(tx - sx, ty - sy); return d >= 6 && d <= 14; });
    const limit=ring?.045:.073;
    if (h < limit) cands.push([tx, ty, h, ring ? 0 : 1]);
  }
  cands.sort((a, b) => a[3] - b[3] || a[2] - b[2]);
  const flora=cands.map(([tx,ty,h])=>[tx,ty,h]);
  paintForestFloor(g, trees, blockers, terrain);

  // 6) 建筑群：居所—连廊—公仓共线相接；其余地点按各自用途绘制设施；
  //    屋前摆对应设施 sprite。屋舍挡视线，周边留空地给角色站。
  const ROOF = ['#7E2553', '#AB5236', '#1D2B53', '#FF004D', '#5F574F', '#008751', '#83769C', '#FFA300'];
  Object.entries(sites).forEach(([r, [sx, sy]], i) => {
    // 连廊在 3D 下由平台、栏杆和柱子的真实投影决定通行。
    if (campRenderer && r === 'hall') return;
    const mask = campRenderer ? null : placement('house_' + r, (sx - 4) * TILE, (sy - 9) * TILE, 128, 128);
    if (mask) masks.push(mask);
    for (let dx = -4; dx <= 3; dx += 1) for (let dy = -8; dy <= -2; dy += 1) {
      if (r === 'hall') continue; // 走廊改用站台占位模板（下方）
      if(['well','yard','garden'].includes(r) && (dx<0 || dy<-6))continue;
      occupy(sx + dx, sy + dy, mask);
    }
    if (r === 'hall') {
      // §14 用户规格：站台四周横棍＋四柱实碰撞，仅正面入口可上（占位）
      for (let dx = -4; dx <= 3; dx += 1) for (let dy = -8; dy <= -6; dy += 1) occupy(sx + dx, sy + dy, mask); // 顶梁
      for (let dx = -4; dx <= 3; dx += 1) for (let dy = -4; dy <= -1; dy += 1) {
        if (dx === -1 || dx === 0) continue; // 正面入口通道
        occupy(sx + dx, sy + dy, mask);
      }
      for (const [px,py] of [[-4,-4],[3,-4],[-4,-1],[3,-1]]) occupy(sx + px, sy + py, mask); // 四柱
    }
    const chimney = r === 'workshop';
    if (r === 'hall') {
      // 两段绘制：背段（屋顶/后柱/后棍）先画，前段（前柱/前棍）后画 ⇒ 站上站台被前柱/前棍遮挡
      objects.push({ kind:'house', part:'back', site:r, sx, sy, foot: sy-4, roof: ROOF[i%ROOF.length], thing: SITE_THING[r], fence:false, chimney });
      objects.push({ kind:'house', part:'front', site:r, sx, sy, foot: sy-1, roof: ROOF[i%ROOF.length], thing: SITE_THING[r], fence:false, chimney });
    } else {
      objects.push({
        kind: 'house', site: r, sx, sy, roof: ROOF[i % ROOF.length],
        thing: SITE_THING[r], fence: r === 'yard' || r === 'well', chimney,
      });
    }
    if (chimney) chimneys.push([sx + 1, sy - 6]);
  });

  // 可行走栅格：非阻挡（树/岩/屋）且（非河面 或 正落在桥上）。供 web/walk.mjs 的 A* 直接读取。
  const walk = new Uint8Array(WORLD_TW * WORLD_TH);
  const movementWalk = new Uint8Array(walk.length);
  for (let ty = 0; ty < WORLD_TH; ty += 1) for (let tx = 0; tx < WORLD_TW; tx += 1) {
    const key = tileKey(tx, ty), index = ty * WORLD_TW + tx;
    const px = tx * TILE + 8, py = ty * TILE + 8;
    const ground = terrain[py * WORLD_W + px];
    const traversable = (ground !== GROUND.water && ground !== GROUND.bank) || bridgeCells.has(key);
    walk[index] = Number(traversable && !blockers.has(key));
    movementWalk[index] = Number(traversable && !movementBlockers.has(key));
  }
  const scene3d = campRenderer ? outdoorStage({ tw: WORLD_TW, th: WORLD_TH, sites, trees, grass:landscape?[]:grass, hills:landscape?[]:hills, height:landscape?.height, layoutSeed:w.layout?mapSeed:null }, bridges, rocks) : null;
  const habitats=wildHabitats(w.layout);
  const wildlife=[];
  for (const {id,x:hx,z:hz,kind} of habitats) {
    if (kind==='bird') {
      wildlife.push({id,x:hx,z:hz,kind});
      continue;
    }
    let best=null, dist=7;
    for (const [x,z] of grass) {
      const tx=Math.floor(x), tz=Math.floor(z), delta=Math.hypot(x-hx,z-hz);
      if (delta>=dist || !walk[tz*WORLD_TW+tx] || inPen(tx,tz) || nearLot(tx,tz) ||
          trees.some(([a,b])=>Math.hypot(a+.5-x,b+.5-z)<1.35) ||
          wildlife.some(a=>Math.hypot(a.x-x,a.z-z)<3)) continue;
      best={id,x,z,kind};dist=delta;
    }
    if (best) wildlife.push(best);
  }
  const assetWalk = masks.length || scene3d ? new Uint8Array(WORLD_W * WORLD_H).fill(1) : null;
  for (const mask of masks) stampMask(assetWalk, WORLD_W, WORLD_H, mask);
  if (scene3d) stampSceneCollision(assetWalk, WORLD_W, WORLD_H, scene3d);

  const waterMask=scene3d ? {width:WORLD_W,height:WORLD_H,bytes:terrain.map(k=>k===GROUND.water?255:0)} : null;
  const terrainWalk3d=scene3d ? terrain.map((k,i)=>Number((k!==GROUND.water && k!==GROUND.bank) ||
    bridgeCells.has(tileKey(Math.floor((i%WORLD_W)/TILE),Math.floor(i/WORLD_W/TILE))))) : null;
  worldCache = { sig, mapSeed, river, hills, grove, groveEntrance:w.layout?.nodes.grove??[15,42], canvas: cv, waterMask, terrainWalk3d, flatLand, roadDistance, landscape, plantClearance, harvestNodes, groundPixels: g.getImageData(0, 0, cv.width, cv.height).data, shadeTiles: new Map(), shadeColors: new Map(), blockers, roads, bridgeCells, bridges, beds, trees, chimneys, objects, flora, wildlife, walk, movementWalk, assetWalk, scene3d, lifeLayers:new Map(), tw: WORLD_TW, th: WORLD_TH };
  worldCaches.set(sig, worldCache);
  if (worldCaches.size > 3) worldCaches.delete(worldCaches.keys().next().value);
  return worldWithCollisions(liveSites, w);
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
// 全屏＝原样放大：取景逻辑像素不变，只把整数倍放大到屏幕能容纳的最大值（不裁切、不拉伸）。
const fullZoom = (lw, lh) => Math.max(1, Math.min(Math.floor((window.innerWidth - 8) / lw), Math.floor((window.innerHeight - 64) / lh)));
function cameraOf(w, sites, slots, container, follow) {
  const manual = ui.camRoom && sites[ui.camRoom];
  const anchor = manual || follow || sites[w.loc?.p1] || slots.p1 || Object.values(sites)[0] || [48, 32];
  const p = anchor;
  const x = Math.round(Math.max(0, Math.min(WORLD_W - VIEW_W, p[0] * TILE - VIEW_W / 2)));
  // 屋舍在地点上方 3–5 tile，镜头再上抬 2 tile，保证屋顶不被视口上沿裁掉。
  const y = Math.round(Math.max(0, Math.min(WORLD_H - VIEW_H, p[1] * TILE - VIEW_H / 2 - ((ui.camRoom??w.loc?.p1)==='garden'?1:3) * TILE)));
  const zoom = ui.fullscreen ? fullZoom(VIEW_W, VIEW_H) : Math.max(1, Math.min(2, Math.floor(((container || VIEW_W * 2) - 20) / VIEW_W)));
  return { x, y, zoom };
}
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

// 接触阴影读取精灵底部的实际不透明轮廓；透明留白不是地面锚点。
// 所有地面阴影合成一次，再画树、屋与人，避免后画的阴影压到前面的实体上。
const CONTACT_PROFILES=new WeakMap(),GROUND_SHADE_COLORS=new Map();
function contactProfile(image){
  if(CONTACT_PROFILES.has(image))return CONTACT_PROFILES.get(image);
  const c=document.createElement('canvas');c.width=image.width;c.height=image.height;
  const g=c.getContext('2d');g.drawImage(image,0,0);
  const pixels=g.getImageData(0,0,c.width,c.height).data,edge=new Int16Array(c.width).fill(-1);
  for(let x=0;x<c.width;x++)for(let y=c.height-1;y>=Math.floor(c.height*.8);y--){
    if(pixels[(y*c.width+x)*4+3]===255){edge[x]=y+1;break;}
  }
  CONTACT_PROFILES.set(image,edge);return edge;
}
function groundShadowLayer(g){
  const width=g.canvas.width,height=g.canvas.height,zoom=g.getTransform().a;
  const mask=new Uint8Array(width*height);
  const mark=(x,y,w,h,level)=>{
    const left=Math.max(0,Math.floor(x*zoom)),right=Math.min(width,Math.ceil((x+w)*zoom));
    const top=Math.max(0,Math.floor(y*zoom)),bottom=Math.min(height,Math.ceil((y+h)*zoom));
    for(let py=top;py<bottom;py++)for(let px=left;px<right;px++){const i=py*width+px;if(mask[i]<level)mask[i]=level;}
  };
  return {
    contact(image,x,y,scale,cast){
      const edge=contactProfile(image);
      for(let sx=0;sx<edge.length;sx++)if(edge[sx]>=0){
        const px=x+sx*scale,py=y+edge[sx]*scale;
        // 接触色与底座重叠半格，实体随后盖上；下沿没有亮地缝隙。
        mark(px,py-.5,scale,1.5,3);mark(px,py+1,scale,1,2);
        for(let d=1;d<=cast;d++)mark(px+d,py+d*.5,scale,1,1);
      }
    },
    feet(x,y){
      mark(x-3,y-.5,6,1.5,3);mark(x-2,y+1,4,.5,1);
    },
    finish(){
      const image=g.getImageData(0,0,width,height),pixels=image.data;
      const palette=ASSETS.palette.map(h=>[1,3,5].map(i=>parseInt(h.slice(i,i+2),16)));
      if(!palette.length)return;
      for(let i=0;i<mask.length;i++){
        const level=mask[i];if(!level)continue;
        const p=i*4,r=pixels[p],green=pixels[p+1],b=pixels[p+2],key=((r<<16)|(green<<8)|b)*4+level;
        let shade=GROUND_SHADE_COLORS.get(key);
        if(!shade){
          const factor=[1,.84,.70,.54][level],target=[r*factor,green*factor,b*factor];let best=Infinity;
          for(const color of palette){const d=(color[0]-target[0])**2+(color[1]-target[1])**2+(color[2]-target[2])**2;if(d<best){best=d;shade=color;}}
          GROUND_SHADE_COLORS.set(key,shade);
        }
        pixels[p]=shade[0];pixels[p+1]=shade[1];pixels[p+2]=shade[2];
      }
      g.putImageData(image,0,0);
    },
  };
}
function drawGroundShadows(g,drawables,cam,phase){
  const layer=groundShadowLayer(g),cast=phase==='夜'?0:4;
  for(const d of drawables){
    const o=d.o;
    if(o?.kind==='house'){
      const image=ASSETS.scenes[`house_${o.site}`];
      if(image)layer.contact(image,(o.sx-4)*TILE-cam.x,(o.sy-9)*TILE-cam.y,1,cast);
    }else if(o?.kind==='tree' && !o.sapling){
      const image=ASSETS.scenes[`tree_oak${Math.floor(hash2(o.tx,o.ty,6)*3)}`];
      if(image)layer.contact(image,o.tx*TILE-cam.x-24,o.ty*TILE-cam.y-64,.5,cast);
    }else if(d.who){
      const x=Math.round((d.wx*TILE-cam.x)*cam.zoom)/cam.zoom,y=Math.round((d.wy*TILE-cam.y)*cam.zoom)/cam.zoom;
      layer.feet(x+8,y+15);
    }
  }
  layer.finish();
}
const treeAsset = (x, y) => `tree_oak${Math.floor(hash2(x, y, 6) * 3)}`;
function drawTreeObj(g, o, cam) {
  const px = o.tx * TILE - cam.x, py = o.ty * TILE - cam.y;
  if (o.sapling) {
    g.fillStyle='#72513B';g.fillRect(px+3,py+11,5,4);g.fillRect(px+10,py+6,2,8);
    g.fillStyle='#C29662';g.fillRect(px+3,py+10,5,2);
    g.fillStyle='#6D9F4E';g.fillRect(px+8,py+3,4,5);g.fillRect(px+12,py+6,3,3);
    return;
  }
  const image=ASSETS.scenes[treeAsset(o.tx,o.ty)];
  if (image) g.drawImage(image,px-24,py-64,64,80);
}
function drawHouseObj(g, o, cam) {
  const bx = (o.sx - 4) * TILE - cam.x, by = (o.sy - 9) * TILE - cam.y;
  const image=ASSETS.scenes[`house_${o.site}`]??(residentialSite(o.site)?ASSETS.scenes.house_home:null);
  if (image) {
    if (o.part === 'back') g.drawImage(image, 0, 0, 128, 96, bx, by, 128, 96);
    else if (o.part === 'front') g.drawImage(image, 0, 96, 128, 32, bx, by + 96, 128, 32);
    else g.drawImage(image, bx, by, 128, 128);
  }
  if (o.fence && o.site==='yard') {
    g.fillStyle = '#72513B';
    for (let i = 0; i < 6; i++) { g.fillRect(bx - 6 + i * 13, by + 123, 2, 7); g.fillStyle = '#D8A667'; g.fillRect(bx - 6 + i * 13, by + 123, 1, 6); g.fillStyle = '#72513B'; }
    g.fillRect(bx - 6, by + 126, 126, 1);
  }
}
// 生存建筑实体：素材钩子 bld_<type> 优先（美术到货即生效），缺省程序化像素兜底（色板内）。
const BLD_ROOF = { shelter: '#FF004D', granary: '#83769C', workshop: '#008751', wall: '#D8A667' };
function drawBuildingObj(g, d, cam) {
  const b = d.bld;
  const bx=d.lot.x*TILE-cam.x, by=d.lot.z*TILE-cam.y;
  const image = ASSETS.scenes[`bld_${b.type}`];
  if (image) g.drawImage(image, bx, by, 64, 64);
  else if (b.type === 'wall') {
    g.fillStyle = '#72513B';
    for (let i = 0; i < 8; i++) { g.fillRect(bx + i * 8, by + 16, 4, 32); g.fillStyle = '#D8A667'; g.fillRect(bx + i * 8, by + 12, 4, 4); g.fillStyle = '#72513B'; }
    g.fillRect(bx, by + 28, 64, 2);
  } else {
    const roof = BLD_ROOF[b.type] ?? '#83769C';
    g.fillStyle = roof;
    g.fillRect(bx + 8, by, 48, 6); g.fillRect(bx + 4, by + 6, 56, 6);
    g.fillStyle = b.type === 'workshop' ? '#5F574F' : '#AB5236';
    g.fillRect(bx + 6, by + 12, 52, 32);
    g.fillStyle = '#72513B';
    g.fillRect(bx + 6, by + 22, 52, 2); g.fillRect(bx + 6, by + 34, 52, 2);
    if (b.type === 'shelter') { g.fillStyle = '#1D2B53'; g.fillRect(bx + 26, by + 26, 12, 18); g.fillStyle = '#FFEC27'; g.fillRect(bx + 12, by + 16, 6, 6); }
    if (b.type === 'granary') { g.fillStyle = '#FFA300'; for (let i = 0; i < 5; i++) g.fillRect(bx + 10 + i * 10, by + 26, 4, 4); }
    if (b.type === 'workshop') { g.fillStyle = '#1D2B53'; g.fillRect(bx + 22, by + 28, 20, 8); g.fillRect(bx + 28, by + 36, 8, 8); g.fillStyle = '#FFA300'; g.fillRect(bx + 44, by + 26, 3, 3); }
  }
  if (b.integrity < 1) {
    g.fillStyle = '#1D2B53';
    g.fillRect(bx + 14, by + 14, 3, 10); g.fillRect(bx + 17, by + 24, 3, 8); g.fillRect(bx + 40, by + 18, 3, 12);
    g.fillStyle = '#FF004D'; g.fillRect(bx + 46, by + 40, 6, 4);
  }

}
function drawSiteObj(g, d, cam) {
  const st = d.st;
  const bx=d.lot.x*TILE-cam.x, by=d.lot.z*TILE-cam.y;
  g.fillStyle = '#83769C';
  for (let i = 0; i < 48; i += 6) { g.fillRect(bx + i, by, 3, 1); g.fillRect(bx + i, by + 31, 3, 1); }
  for (let i = 0; i < 32; i += 6) { g.fillRect(bx, by + i, 1, 3); g.fillRect(bx + 47, by + i, 1, 3); }
  const labor = BLD_LABOR[st.type] ?? 6;
  g.fillStyle = '#1D2B53'; g.fillRect(bx, by + 36, 48, 4);
  g.fillStyle = '#008751'; g.fillRect(bx, by + 36, Math.round(48 * Math.min(1, (st.progress ?? 0) / labor)), 4);

}
const BLD_LABEL = { shelter: '住所', granary: '储粮', workshop: '工坊', wall: '防护' };
const BLD_LABOR = { shelter: 6, granary: 6, workshop: 8, wall: 8 };
// 环境光由世界相位决定，过渡只使用共享渲染时钟；每一输出颜色仍在固定色板内。
const TONE_CACHE=new Map();
function toneScene(g,cv,phase,indoor=false){
  const target=({'晨':.22,'昼':0,'暮':.58,'夜':1})[phase]??0,now=ACT.seconds??0;
  const state=cv._light??{value:target,time:now};
  const dt=Math.max(0,Math.min(.05,now-state.time));state.time=now;
  state.value+=Math.sign(target-state.value)*Math.min(Math.abs(target-state.value),dt*.6);
  if(matchMedia('(prefers-reduced-motion: reduce)').matches)state.value=target;
  cv._light=state;
  const level=Math.round(state.value*(indoor?.72:1)*32);
  if(!level)return state.value;
  let map=TONE_CACHE.get(level);
  if(!map){
    const pal=ASSETS.palette.map(h=>[1,3,5].map(i=>parseInt(h.slice(i,i+2),16)));map=new Map();
    for(const c of pal){
      const t=level/32,desired=[c[0]*(1-.57*t)+3*t,c[1]*(1-.53*t)+5*t,c[2]*(1-.35*t)+8*t];
      let best=Infinity,color=c;
      for(const v of pal){const d=(v[0]-desired[0])**2*.8+(v[1]-desired[1])**2*1.2+(v[2]-desired[2])**2;if(d<best){best=d;color=v;}}
      map.set((c[0]<<16)|(c[1]<<8)|c[2],color);
    }TONE_CACHE.set(level,map);
  }
  const image=g.getImageData(0,0,cv.width,cv.height),px=image.data;
  for(let i=0;i<px.length;i+=4){const c=map.get((px[i]<<16)|(px[i+1]<<8)|px[i+2]);if(c){px[i]=c[0];px[i+1]=c[1];px[i+2]=c[2];}}
  g.putImageData(image,0,0);return state.value;
}
function warmLamp(g,x,y,w,h,strength){
  if(strength<.3)return;
  g.fillStyle=strength>.7?'#EDC787':'#D6AE69';g.fillRect(Math.round(x),Math.round(y),w,h);
  g.fillStyle='#FFF0CC';g.fillRect(Math.round(x),Math.round(y),Math.max(1,w-2),1);
  g.fillStyle='#72513B';g.fillRect(Math.round(x+w/2),Math.round(y),1,h);
}
function houseLights(g,o,cam,strength){
  if(strength<.3)return;
  const bx=(o.sx-4)*TILE-cam.x,by=(o.sy-9)*TILE-cam.y;
  const windows=o.site==='hall'?[[18,68,4,7],[103,68,4,7]]:o.site==='store'?[[24,68,11,14],[94,68,11,14]]:['well','yard'].includes(o.site)?[]:o.site==='garden'?[[75,67,20,6]]:[[60,33,14,13],[30,68,16,19],[87,68,14,19]];
  for(const [x,y,w,h] of windows)warmLamp(g,bx+x,by+y,w,h,strength);
  // 门灯的落光止于门前小片地面，保持硬像素边缘，不覆盖远处角色。
  if(!windows.length)return;
  const [doorX,groundY]=o.site==='garden'?[90,109]:o.site==='store'?[64,118]:[64,119];
  g.fillStyle=strength>.7?'#D6AE69':'#B58A4C';
  for(let y=0;y<7;y++)for(let x=-12;x<=12;x++)if(Math.abs(x)<12-y&&(x+2*y)%5===0)g.fillRect(Math.round(bx+doorX+x),Math.round(by+groundY+y),1,1);
}
function drawResident(g, who, action, x, y, facing = 'down', stage) {
  const descendant = /^c\d+$/.test(who), child = stage==='child' || (stage==null && descendant);
  const sheet = ACT.chars[who] ?? (descendant ? ACT.chars.a1 : null), size = ACT.size ?? [16, 24], directions = ACT.directions ?? ['down'];
  const exact = directions.indexOf(facing);
  const direction = exact >= 0 ? exact : Math.max(0, directions.indexOf(facing.split('-')[0]));
  const row = action * directions.length + direction;
  const dw = child ? 12 : 16, dh = child ? 18 : 24;
  if (ACT.ready && sheet) g.drawImage(sheet, ACT.frame * size[0], row * size[1], size[0], size[1], x, y - 8, dw, dh);
  else if (ASSETS.chars[who]) g.drawImage(ASSETS.chars[who].frames[ACT.frame % 4], x, y, 16, 16);
}
// ── 点哪走哪（纯表现层）───────────────────────────────────────────────────────
// 引擎是「地点制」：w.occupancy 决定 p1 在哪个地点，/act move 也只把人挪到某个地点。
// 这里不改世界状态、不发请求、不消费 rng —— 只是把「角色此刻画在哪」从「瞬移到地点」
// 变成「沿 A* 路径走过去」。点击空地 = 一个纯视觉的临时目标；引擎一旦把人挪走（auth 变化），
// 角色就重新规划、走回引擎认定的地点。读数完全不受影响。
const WALK = {};                 // `${cvId}:${who}` -> {x,y,path,pi,moving,face,auth}
const SPEED = 0.5;               // 每动画帧推进的 tile 数（6fps ⇒ 约 3 tile/秒）
const walkKey = (cvId, who) => `${cvId}:${who}`;
// 室内玩家位置（逻辑像素，tile-top 锚点）：WASD 在房间内走动，走到下门自动出屋。纯表现层。
const IPOS = { site: null, x: 120, y: 150, moving: false, direction: 'down', face: 1 };
let roomRoute=null;
// isWalkable / astar / stepWalker 都在 web/walk.mjs（纯函数、可单测）。这里只保留行走器状态表与接线。
function campBodyWorld(world,openEdge=false) {
  return { ...world, collisionGrid:bodyGrid(world.collisionGrid,TILE,openEdge) };
}
function exteriorAllows(world,x,z) {
  return world.landscape?.walkable(x,z) &&
    !(world.outsideSolids??[]).some(b=>rectGap(x,z,b.x,b.z,b.w,b.d)<CAMP_BODY_RADIUS);
}
function routeForWalker(world, walker, goal, bodies=[]) {
  const from=[walker.x+.5,walker.y+.5], to=goal.map(v=>v+.5);
  if (world.landscape && (!inCamp(...from) || !inCamp(...to))) {
    const map=campBodyWorld(world,true);
    const allows=(x,z)=>(inCamp(x,z)?mapAllows(map,x-.5,z-.5):exteriorAllows(world,x,z)) &&
      bodies.every(b=>Math.hypot(x-b.x,z-b.z)>=b.r+CAMP_BODY_RADIUS+.05);
    return joinedRoute(from,to,allows)
      ?.map(p=>p.map(v=>v-.5))??null;
  }
  const path = pathFromWalker(world, walker, goal);
  if (!world.scene3d) return path;
  world=campBodyWorld(world);
  if (!mapAllows(world,...goal)) return null;
  // 快速路线在穿过窄栏杆时可能遗漏细格，逐段复核后再采用。
  if (path) {
    let x=walker.x, z=walker.y;
    const complete=[...path,goal], smooth=[];
    const clear=([nx,nz])=>{
      const dx=nx-x, dz=nz-z, steps=Math.max(1,Math.ceil(Math.hypot(dx,dz)*TILE*2));
      for (let i=1;i<=steps;i++) {
        const px=x+dx*i/steps, pz=z+dz*i/steps;
        if (!mapAllows(world,px,pz) || !mapAllows(world,px,pz-dz/steps)) return false;
      }
      return true;
    };
    for (let i=0;i<complete.length;) {
      let next=Math.min(i+2,complete.length-1);
      while (next>i && !clear(complete[next])) next-=1;
      if (!clear(complete[next])) break;
      [x,z]=complete[next];
      smooth.push(complete[next]);
      i=next+1;
      if (i===complete.length) return smooth;
    }
  }
  const pixel = v=>Math.floor((v+.5)*TILE);
  const start = [pixel(walker.x),pixel(walker.y)];
  const exact = pixelPath(world.collisionGrid,start,goal.map(pixel));
  if (!exact?.length) return exact;
  return [start,...exact].map(cell=>cell.map(v=>(v+.5)/TILE-.5));
}

function stepCampWalker(world,walker,cvId,snapshot,dx,dz,speed,manual) {
  const distance=Math.hypot(dx,dz);
  if (distance<.0001) {
    walker.moving=false;
    if (!manual) walker.pi+=1;
    return;
  }
  const neighbours=(campHerds.get(cvId)??world.life3d?.animals??[]).filter(a=>a.kind!=='bird');
  for (const who of Object.values(snapshot.occupancy??{}).flat()) {
    const other=WALK[walkKey(cvId,who)];
    if (other && other!==walker) neighbours.push({x:other.x+.5,z:other.y+.5,r:CAMP_BODY_RADIUS});
  }
  const fits=(x,z,nx,nz)=>separates(x+.5,z+.5,nx+.5,nz+.5,neighbours);
  const step=manual?speed:Math.min(speed,distance);
  const connected=S.soloSurv && cvId==='cvA';
  const map=campBodyWorld(world,connected);
  const dxStep=dx/distance*step, dzStep=dz/distance*step;
  const x0=walker.x+.5,z0=walker.y+.5;
  const joined=connected &&
    (!inCamp(x0,z0) || !inCamp(x0+dxStep,z0+dzStep));
  const [x,z]=joined
    ? moveJoinedWalker(x0,z0,dxStep,dzStep,
      (x,z,px,pz)=>mapAllows(map,x-.5,z-.5) && fits(px-.5,pz-.5,x-.5,z-.5),
      (x,z,px,pz)=>exteriorAllows(world,x,z) && fits(px-.5,pz-.5,x-.5,z-.5)).map(v=>v-.5)
    : moveMapFeet(map,walker.x,walker.y,dxStep,dzStep,fits);
  walker.moving=Math.hypot(x-walker.x,z-walker.y)>.00001;
  walker.x=x; walker.y=z;
  if (manual) return;
  if (Math.hypot(x-walker.path[walker.pi][0],z-walker.path[walker.pi][1])<.01) walker.pi+=1;
  if (walker.moving) walker.stuckSince=undefined;
  else {
    const now=performance.now();
    walker.stuckSince??=now;
    if (now-walker.stuckSince>620) {
      walker.stuckSince=now;
      const goal=walker.path.at(-1);
      const crossRegion=connected && (!inCamp(x0,z0) || !inCamp(goal[0]+.5,goal[1]+.5));
      const nearby=neighbours.filter(o=>Math.hypot(o.x-x0,o.z-z0)<5);
      const path=crossRegion ? routeForWalker(world,walker,goal,nearby) : detourAroundBodies(map,walker,neighbours);
      if (path?.length) { walker.path=path; walker.pi=0; }
    }
  }
}

function detourAroundBodies(world,walker,neighbours) {
  const nearby=neighbours.filter(o=>Math.hypot(o.x-walker.x-.5,o.z-walker.y-.5)<2.5);
  if (!nearby.length) return null;
  const grid=world.collisionGrid, walk=grid.walk.slice();
  for (const o of nearby) {
    const r=o.r+CAMP_BODY_RADIUS+.08;
    const x=Math.floor((o.x-r)*TILE), z=Math.floor((o.z-r)*TILE);
    fillCollisionRect(walk,grid.tw,grid.th,x,z,Math.ceil((o.x+r)*TILE)-x,Math.ceil((o.z+r)*TILE)-z,0);
  }
  const pixel=coordinate=>Math.floor((coordinate+.5)*TILE);
  const [goalX,goalZ]=walker.path.at(-1);
  const path=pixelPath({...grid,walk},[pixel(walker.x),pixel(walker.y)],[pixel(goalX),pixel(goalZ)]);
  return path?.length ? path.map(cell=>cell.map(v=>(v+.5)/TILE-.5)) : null;
}

const outingKey=w=>`ambrace:outing:${w?.layoutVersion??0}:${w?.mapSeed??0}`;
function savedOuting(w,world) {
  try {
    const point=JSON.parse(sessionStorage.getItem(outingKey(w)));
    if (Array.isArray(point) && point.length===2 && point.every(Number.isFinite) &&
        !inCamp(...point) && campOutskirts(w,world).walkable(...point)) return point.map(v=>v-.5);
  } catch { /* storage can be unavailable */ }
  return null;
}
function storeOuting(walker,w) {
  const [x,z]=[walker.x+.5,walker.y+.5];
  try {
    const key=outingKey(w);
    if (inCamp(x,z)) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key,JSON.stringify([x,z]));
  } catch { /* storage can be unavailable */ }
}
addEventListener('pagehide',()=>{
  const walker=WALK['cvA:p1'];
  if (S.soloSurv && walker && S.view) storeOuting(walker,S.view);
});
function ensureWalker(cvId, who, world, slots) {
  const snapshot=cvId==='cvB'?S.viewB:S.view;
  const travel=who!=='p1' && snapshot?.districtTravel?.[who];
  const destination=travel && world.sites[travel.to];
  const auth = destination ? [destination[0]-1,destination[1]] : slots[who];
  const route=s=>{
    s.path=routeForWalker(world,s,auth)??[];
    if (!s.path.length && destination) {
      const gate=world.homes3d?.entrances[travel.to]??world.scene3d?.entrances[travel.to];
      if (gate) s.path=routeForWalker(world,s,[gate.x+gate.w/2-.5,gate.z+gate.d*.7-.5])??[];
    }
    s.pi=0;
    if (!travel) { delete s.tripSpeed; return; }
    let prior=[s.x,s.y], length=0;
    for (const p of s.path) {
      length+=distanceTo(p,prior);
      prior=p;
    }
    s.tripSpeed=length/Math.max(1,travel.arrive-snapshot.t)/(S.tickMs??7500)/.8;
  };
  if (!auth) return null;
  const k = walkKey(cvId, who);
  let s = WALK[k];
  if (!s) {
    const point=campRenderer && S.soloSurv && k==='cvA:p1' ? savedOuting(S.view,world) : null;
    const room=who==='p1' && snapshot?.campPlayerRoom;
    const facility=room && facilityOf(snapshot,room);
    const gate=room && (facility ? facilityGate(facility,snapshot.layout) : world.homes3d?.entrances[room]);
    const door=gate && !inCamp(gate.x,gate.z) ? [gate.x+gate.w/2-.5,gate.z+gate.d*.8-.5] : null;
    const [x,y]=door??point??slots[who]??auth;
    s=WALK[k]={x,y,path:[],pi:0,moving:false,face:1,auth:[...auth]};
    if (destination) route(s);
    return s;
  }
  if (s.auth[0] !== auth[0] || s.auth[1] !== auth[1]) {
    if (s.holdDoor) {
      s.auth=[auth[0],auth[1]];
      delete s.holdDoor;
      return s;
    }   // 引擎把人挪了 ⇒ 走回认定地点
    s.auth = [auth[0], auth[1]];
    if (S.soloSurv && k==='cvA:p1' && !inCamp(s.x+.5,s.y+.5) && !S.view.player?.dead) return s;
    route(s);
  }
  return s;
}
let camFollow = null;   // A 侧玩家行走位置，供两个画布共用同一镜头（保持对照同框）
// 脚步尘：每个画布一小撮瞬态粒子，纯渲染层，由动画循环推进/老化；不入世界状态、不消费 rng。
const DUST = {};        // cvId -> [{x, y, age}]（tile 坐标）

function drawFogTerrain(g, world, cam, visible, night, tx0, ty0) {
  const neighbors = [[0,-1],[1,0],[0,1],[-1,0],[-1,-1],[1,-1],[1,1],[-1,1]], size = TILE * ART;
  const palette = ASSETS.palette.map(h => [1,3,5].map(i => parseInt(h.slice(i,i+2),16)));
  for(let ty=ty0;ty<=ty0+VIEW_TH;ty++)for(let tx=tx0;tx<=tx0+VIEW_TW;tx++){
    if(tx<0||ty<0||tx>=WORLD_TW||ty>=WORLD_TH||visible.has(tileKey(tx,ty)))continue;
    let mask=0;neighbors.forEach(([dx,dy],i)=>{if(visible.has(tileKey(tx+dx,ty+dy)))mask|=1<<i;});
    const key=`${tx},${ty}:${mask}:${night?1:0}`;let tile=world.shadeTiles.get(key);
    if(!tile){
      tile=document.createElement('canvas');tile.width=size;tile.height=size;
      const ctx=tile.getContext('2d'),image=ctx.createImageData(size,size),pixels=image.data;
      for(let y=0;y<size;y++)for(let x=0;x<size;x++){
        let distance=size*2;
        if(mask&1)distance=Math.min(distance,y+1);if(mask&2)distance=Math.min(distance,size-x);if(mask&4)distance=Math.min(distance,size-y);if(mask&8)distance=Math.min(distance,x+1);
        if(mask&16)distance=Math.min(distance,Math.hypot(x+1,y+1));if(mask&32)distance=Math.min(distance,Math.hypot(size-x,y+1));
        if(mask&64)distance=Math.min(distance,Math.hypot(size-x,size-y));if(mask&128)distance=Math.min(distance,Math.hypot(x+1,size-y));
        const t=Math.min(1,distance/(size*1.12)),shade=night?.48:.72;
        const factor=Math.max(shade,Math.min(1,1-(1-shade)*t*t*(3-2*t)+(hash2(tx*size+x,ty*size+y,71)-.5)*.02));
        const source=((ty*size+y)*WORLD_W*ART+tx*size+x)*4,packed=(world.groundPixels[source]<<16)|(world.groundPixels[source+1]<<8)|world.groundPixels[source+2];
        const level=Math.round(factor*32),colorKey=packed*33+level;let color=world.shadeColors.get(colorKey);
        if(!color){
          const target=[world.groundPixels[source]*level/32,world.groundPixels[source+1]*level/32,world.groundPixels[source+2]*level/32];let best=Infinity;
          for(const c of palette){const d=(c[0]-target[0])**2+(c[1]-target[1])**2+(c[2]-target[2])**2;if(d<best){best=d;color=c;}}
          color??=[38,61,41];world.shadeColors.set(colorKey,color);
        }
        const i=(y*size+x)*4;pixels[i]=color[0];pixels[i+1]=color[1];pixels[i+2]=color[2];pixels[i+3]=255;
      }
      ctx.putImageData(image,0,0);if(world.shadeTiles.size>2000)world.shadeTiles.clear();world.shadeTiles.set(key,tile);
    }
    g.drawImage(tile,tx*TILE-cam.x,ty*TILE-cam.y,TILE,TILE);
  }
}

function drawViewport(cv, w) {
  // 按容器选择完整的原生像素格，桌面横向取景；窄屏缩小取景范围而非压缩精灵。
  VIEW_TW = Math.max(20, Math.min(28, Math.floor(((cv.parentElement?.clientWidth || 916) - 20) / (TILE * ART))));
  const gardenView=(ui.camRoom??w.loc?.p1)==='garden';
  VIEW_TH = gardenView?Math.min(20,Math.max(12,Math.round(VIEW_TW*.72))):Math.min(14,Math.max(10,Math.round(VIEW_TW*.6)));
  VIEW_W = VIEW_TW * TILE; VIEW_H = VIEW_TH * TILE;
  const world = buildWorld(w);
  const slots = slotsOf(w, world.sites);
  for (const who of Object.keys(slots)) ensureWalker(cv.id, who, world, slots);
  const pw = WALK[walkKey(cv.id, 'p1')];
  const pTile = pw ? [pw.x, pw.y] : (slots.p1 ?? null);
  if (cv.id === 'cvA') camFollow = pTile;   // A 侧玩家位置驱动镜头；B 共用同一镜头，保持对照同框
  const cam = cameraOf(w, world.sites, slots, cv.parentElement?.clientWidth, cv.id === 'cvA' ? pTile : camFollow);
  lastCam = { ...cam, mode: 'view' };
  cv._cam = lastCam;
  const CW = VIEW_W * cam.zoom, CH = VIEW_H * cam.zoom;
  if (cv.width !== CW || cv.height !== CH) { cv.width = CW; cv.height = CH; }
  const fitW = Math.min(CW, cv.parentElement?.clientWidth || CW);   // 窄屏缩到容器宽，避免溢出或过度放大
  cv.style.width = `${fitW}px`; cv.style.height = `${Math.round(CH * fitW / CW)}px`;
  const g = cv.getContext('2d');
  g.setTransform(cam.zoom, 0, 0, cam.zoom, 0, 0);
  g.imageSmoothingEnabled = false;
  g.clearRect(0, 0, VIEW_W, VIEW_H);
  // 一整片世界只在离屏画一次，这里只取相机窗口 —— 全局始终完整在运行。
  g.drawImage(world.canvas, cam.x * ART, cam.y * ART, VIEW_W * ART, VIEW_H * ART, 0, 0, VIEW_W, VIEW_H);
  g.font = '6px fusion-pixel, monospace';
  const t0x = Math.floor(cam.x / TILE), t0y = Math.floor(cam.y / TILE);

  const pt = pTile ?? [Math.round((cam.x + VIEW_W / 2) / TILE), Math.round((cam.y + VIEW_H / 2) / TILE)];
  const oTile = [Math.round(pt[0]), Math.round(pt[1])];   // LOS 原点取整，保证 Bresenham 一定终止
  const radius = lightRadius(w.phase);
  const visible = new Set();
  for (let y = t0y - 1; y <= t0y + VIEW_TH + 1; y += 1) for (let x = t0x - 1; x <= t0x + VIEW_TW + 1; x += 1) {
    if (Math.hypot(x - oTile[0], y - oTile[1]) <= radius && losClear(world.blockers, oTile[0], oTile[1], x, y)) visible.add(tileKey(x, y));
  }
  const night = w.phase === '夜';
  // 地表可见性保留 LOS；暗化只作用于地表，在房屋/人物之前画，不会给屋顶盖棋盘格。
  drawFogTerrain(g, world, cam, visible, night, t0x, t0y);

  // 场景细节小动画：草摆动 / 水波 / 树冠 / 炊烟，按当前帧号只叠加「会动的像素」。
  // 静止部分由离屏底图提供，fx 是 98.6% 透明的动态增量层，不会盖住地形或出现补丁方块。
  // 锚点来自 buildWorld 记录的真实树/烟囱坐标与河面判定，不随机撒点。
  if (ACT.ready && ACT.fx) {
    const col = ACT.frame * 32;
    const inView = (x, y) => x >= t0x - 2 && x <= t0x + VIEW_TW + 2 && y >= t0y - 2 && y <= t0y + VIEW_TH + 2;
    const cell = (row, tx, ty) => { if (visible.has(tileKey(tx, ty))) g.drawImage(ACT.fx, col, row * 32, 32, 32, tx * TILE - cam.x - 8, ty * TILE - cam.y - 8, 32, 32); };
    const nearRoad = (tx, ty) => world.roads.some((r) => distSeg(tx * TILE + 8, ty * TILE + 8, r[0], r[1], r[2], r[3]) < 20);
    const nearRiver = (tx, ty) => Math.abs((tx + 0.5) * TILE - (world.river??riverX)(ty) * TILE) < 22;
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

  // §11 R5：灾害日在菜园上方画 8×8 像素图标（风暴红/寒潮蓝），反馈长在变化处。
  if (w.disasterToday && world.sites.garden) {
    const [gx, gy] = world.sites.garden;
    const ix = gx * TILE - cam.x, iy = (gy - 10) * TILE - cam.y;
    if (ix > -8 && ix < VIEW_W && iy > -8 && iy < VIEW_H) {
      g.fillStyle = w.disasterToday === 'storm' ? '#FF004D' : '#29ADFF';
      g.fillRect(ix, iy, 8, 2); g.fillRect(ix + 2, iy + 2, 4, 2); g.fillRect(ix + 3, iy + 4, 2, 4);
    }
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
  // 深度排序：树 / 屋舍 / 角色放进同一张列表，按脚底所在屏幕 Y 升序绘制 ⇒ 近处盖住远处、
  // 屋后的人被屋挡住（2.5D 空间关系由此而来）。视野外（LOS 挡住）的整件不画，避免穿雾显形。
  const drawables = [];
  const grove=world.timber?world.grove.map(t=>({kind:'tree',tx:Math.floor(t.x),ty:Math.floor(t.z),
    sapling:world.timber[t.id]?.stage==='sapling'})):[];
  for (const o of [...world.objects,...grove]) {
    const footTy = o.kind === 'house' ? (o.foot ?? o.sy - 1) : o.ty;
    const footTx = o.kind === 'house' ? o.sx : o.tx;
    const fy = (footTy + 1) * TILE - cam.y;
    if (fy < -2 * TILE || fy > VIEW_H + 8 * TILE) continue;
    const seen=o.kind==='house'?[-4,-3,-2,-1,0,1,2,3,4].some(dx=>visible.has(tileKey(footTx+dx,footTy))):visible.has(tileKey(footTx,footTy));
    drawables.push({ sy: fy, o, faded: !seen });   // 视野外＝半透而非消失（避免"空气墙"观感）
  }
  for (const [records,key] of [[w.buildings,'bld'],[w.sites,'st']]) for (const record of records??[]) {
    const lot=record.lot??constructionLot(record.loc,w.layout);
    if (!lot) continue;
    const fy=(lot.z+lot.d)*TILE-cam.y;
    if (fy < -2*TILE || fy > VIEW_H+8*TILE) continue;
    drawables.push({sy:fy,[key]:record,lot,faded:!visible.has(tileKey(Math.floor(lot.x+lot.w/2),Math.floor(lot.z+lot.d)))});
  }
  for (const who of Object.keys(slots)) {
    const s = WALK[walkKey(cv.id, who)];
    const wx = s ? s.x : slots[who][0], wy = s ? s.y : slots[who][1];
    if (!visible.has(tileKey(Math.round(wx), Math.round(wy)))) continue;
    drawables.push({ sy: (wy + 1) * TILE - cam.y, who, wx, wy, moving: s && s.moving, face: s ? s.face : 1 });
  }
  drawables.sort((a, b) => a.sy - b.sy);
  drawGroundShadows(g, drawables.filter((d) => !d.faded && !(d.o && d.o.part === 'back')), cam, w.phase);
  for (const d of drawables) {
    g.globalAlpha = d.faded ? 0.35 : 1;
    if (d.bld) { drawBuildingObj(g, d, cam); g.globalAlpha = 1; continue; }
    if (d.st) { drawSiteObj(g, d, cam); g.globalAlpha = 1; continue; }
    if (d.o) {
      if (d.o.kind === 'tree') drawTreeObj(g, d.o, cam);
      else drawHouseObj(g, d.o, cam);
      g.globalAlpha = 1;
      continue;
    }
    g.globalAlpha = 1;
    const px = Math.round((d.wx * TILE - cam.x) * cam.zoom) / cam.zoom, py = Math.round((d.wy * TILE - cam.y) * cam.zoom) / cam.zoom;
    const row = d.moving ? (ACT.index.move_to ?? ACT.index.walk ?? actionRow(w.agents?.[d.who])) : actionRow(w.agents?.[d.who]);
    const walker = WALK[walkKey(cv.id, d.who)];
    drawResident(g, d.who, row, px, py, walker?.direction ?? 'down', w.agents?.[d.who]?.stage);
    const nm = d.who === 'p1' ? '你' : (w.agents?.[d.who]?.name ?? d.who);
    g.fillStyle = '#FFF1E8';
    g.fillText(nm, px, py + TILE + 6);
    const em = emoteFor(nm);
    if (em) {
      const ey = py - 21;
      g.fillStyle = '#000000'; g.fillRect(px + 4, ey, 8, 8);
      g.fillStyle = em; g.fillRect(px + 5, ey + 1, 6, 6);
      g.fillStyle = '#000000'; g.fillRect(px + 7, ey + 2, 2, 3); g.fillRect(px + 7, ey + 6, 2, 1);
    }
  }
  // ── P4 环境特效（纯渲染层 · 确定性 · 锁色板 · LOS 门控）────────────────────
  // 夜：萤火虫。贴草地/树缘，避开河与阻挡物；漂移与闪烁由 hash2 + ACT.frame 决定，不引随机、不动读数。
  if (night) {
    for (let y = t0y - 1; y <= t0y + VIEW_TH + 1; y += 1) for (let x = t0x - 1; x <= t0x + VIEW_TW + 1; x += 1) {
      if (!visible.has(tileKey(x, y)) || world.blockers.has(tileKey(x, y))) continue;
      if (Math.abs((x + 0.5) * TILE - (world.river??riverX)(y) * TILE) < 16) continue;
      const seed = hash2(x, y, 21);
      if (seed < 0.9) continue;
      const fx = Math.round(x * TILE - cam.x + 8 + Math.sin((ACT.frame + x * 2 + y) * 0.7) * 3);
      const fy = Math.round(y * TILE - cam.y + 6 + Math.cos((ACT.frame + x) * 0.5) * 2);
      g.fillStyle = (ACT.frame + Math.floor(seed * 4)) % 4 < 2 ? '#FFEC27' : '#00E436';
      g.fillRect(fx, fy, 1, 1);
    }
  }
  // 脚步尘：移动角色脚下留下的瞬态小点，随 age 上飘、变稀、转暗（无 alpha，靠数量与色阶淡出）。
  for (const p of DUST[cv.id] ?? []) {
    if (!visible.has(tileKey(Math.floor(p.x), Math.floor(p.y)))) continue;
    const dx = Math.round(p.x * TILE - cam.x), dy = Math.round(p.y * TILE - cam.y);
    if (dx < -4 || dx > VIEW_W + 4 || dy < -4 || dy > VIEW_H + 4) continue;
    g.fillStyle = p.age < 3 ? '#C2C3C7' : '#83769C';
    const n = Math.max(1, 3 - Math.floor(p.age / 2));
    for (let i = 0; i < n; i += 1) {
      const ox = Math.round(hash2(Math.round(p.x * 16) + i, p.age, 30) * 5) - 2;
      g.fillRect(dx + ox, dy - Math.round(p.age * 0.6), 1, 1);
    }
  }
  const light=toneScene(g,cv,w.phase);
  for(const d of drawables)if(d.o?.kind==='house')houseLights(g,d.o,cam,light);
  return cam;
}

// 世界全景：把完整地图压成微缩总览，证明「全局依旧是完整一大片在运行」；
// 当前相机窗口用黄虚线框标出，玩家位置用金点标出。
function drawOverview(cv, w) {
  const world = buildWorld(w);
  const slots = slotsOf(w, world.sites);
  for (const who of Object.keys(slots)) ensureWalker(cv.id, who, world, slots);
  const pw = WALK[walkKey(cv.id, 'p1')];
  const pTile = pw ? [pw.x, pw.y] : (slots.p1 ?? null);
  if (cv.id === 'cvA') camFollow = pTile;
  const cam = cameraOf(w, world.sites, slots, cv.parentElement?.clientWidth, cv.id === 'cvA' ? pTile : camFollow);
  lastCam = { ...cam, mode: 'overview' };
  cv._cam = lastCam;
  const zoom = ui.fullscreen ? fullZoom(OV_W, OV_H) : Math.max(1, Math.min(ZOOM, Math.floor(((cv.parentElement?.clientWidth || OV_W * ZOOM + 20) - 20) / OV_W)));
  const CW = OV_W * zoom, CH = OV_H * zoom;
  if (cv.width !== CW || cv.height !== CH) {
    cv.width = CW; cv.height = CH;
    cv.style.width = `${CW}px`; cv.style.height = `${CH}px`;
  }
  const g = cv.getContext('2d');
  g.setTransform(zoom, 0, 0, zoom, 0, 0);
  g.imageSmoothingEnabled = false;
  g.clearRect(0, 0, OV_W, OV_H);
  g.drawImage(world.canvas, 0, 0, WORLD_W * ART, WORLD_H * ART, 0, 0, OV_W, OV_H);
  // 树 / 屋舍已改到视口层动态绘制，全景里用简化色块补上，保证总览仍看得出村落形状。
  for (const o of world.objects) {
    if (o.kind === 'tree') {
      const mx = Math.round(o.tx * TILE * OV_SX), my = Math.round(o.ty * TILE * OV_SY);
      g.fillStyle = '#008751'; g.fillRect(mx, my, 2, 2);
    } else {
      const mx = Math.round((o.sx - 1) * TILE * OV_SX), my = Math.round((o.sy - 5) * TILE * OV_SY);
      const bw = Math.max(2, Math.round(3 * TILE * OV_SX)), bh = Math.max(2, Math.round(2 * TILE * OV_SY));
      g.fillStyle = o.roof; g.fillRect(mx, my, bw, bh);
    }
  }
  for (const record of [...(w.buildings??[]),...(w.sites??[])]) {
    const lot=record.lot??constructionLot(record.loc,w.layout);
    if (!lot) continue;
    const mx=Math.round(lot.x*TILE*OV_SX), my=Math.round(lot.z*TILE*OV_SY);
    g.fillStyle=record.integrity<1?'#FF004D':BLD_ROOF[record.type]??'#83769C';
    g.fillRect(mx,my,3,Object.hasOwn(record,'progress')?1:2);
  }
  toneScene(g,cv,w.phase);
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
  // 玩家金点（跟随行走位置）
  if (pTile) {
    const [px, py] = pTile;
    const mx = Math.round(px * TILE * OV_SX), my = Math.round(py * TILE * OV_SY);
    g.fillStyle = '#FF004D'; g.fillRect(mx - 1, my - 1, 4, 4);
    g.fillStyle = '#FFF1E8'; g.fillRect(mx, my, 1, 1);
  }
  g.fillStyle = w.phase === '夜' ? '#1D2B53' : w.phase === '昼' ? '#29ADFF' : '#FFA300';
  g.fillRect(0, 0, OV_W, 1); g.fillRect(0, OV_H - 1, OV_W, 1);
  g.fillRect(0, 0, 1, OV_H); g.fillRect(OV_W - 1, 0, 1, OV_H);
  return cam;
}

// ── 室内场景（独立画面 + 门转场，8 处全部可进）──────────────────────────────
// 纯表现层：室内只是把「某地点 occupancy 里的人」搬进一间画好的屋子里展示。
// 进入 = 点地图建筑（沿用既有 /act move，引擎把人挪进该地点）或点地点按钮；退出 = 点门 / 再点当前按钮 / 世界全景。
// 不新增世界状态字段、不消费 rng、不动读数；A/B 各画自己世界的屋内人，保持对照。
const personalInterior={props:[['bed',3,2],['hearth',10,2],['shelf',2,7],['table',8,5],['rug',6,7]]};
const INTERIORS = {
  ...Object.fromEntries(Object.keys(HOUSING_PLOTS).map(room=>[room,personalInterior])),
  home: { props: [['bed',2,2],['hearth',10,2],['table',7,4],['rug',6,6],['shelf',2,7],['planter',11,7]] },
  hall: { props: [['bench',4,4],['banner',10,2]] },
  store: { props: [['shelf',2,2],['shelf',7,2],['crate',11,3],['crate',2,7],['crate',7,7],['barrel',11,7]] },
  watch: { props: [['telescope',4,2],['crate',10,6],['banner',2,2],['barrel',11,2],['rug',6,7]] },
  workshop: { props: [['furnace',2,2],['workbench',8,2],['anvil',6,7],['crate',10,7],['barrel',2,7]] },
  garden: { props: [['planter',2,3],['planter',6,3],['planter',10,3],['planter',2,7],['trellis',10,7],['barrel',6,7]] },
  well: { props: [['well',5,4],['bucket',10,6],['crate',2,3],['planter',2,7],['barrel',11,2]] },
  yard: { props: [['fence',2,2],['fence',6,2],['cart',6,5],['crate',10,3],['barrel',2,7],['planter',11,7]] },
};
// 家具：每种画在 32×32 单元内，硬像素、锁色板内。
function drawProp(g, kind, x, y) {
  const art = ASSETS.scenes[`prop_${kind}`];
  if (art) { g.drawImage(art, x, y, 64, 64); return; }
  const r = (dx, dy, w, h, c) => { g.fillStyle = c; g.fillRect(x + dx, y + dy, w, h); };
  switch (kind) {
    case 'bed': r(2,6,26,20,'#000000'); r(4,8,22,16,'#AB5236'); r(4,8,8,10,'#FFF1E8'); r(12,10,14,14,'#FF004D'); r(4,8,22,2,'#FFCCAA'); break;
    case 'table': r(3,8,26,12,'#000000'); r(5,10,22,8,'#AB5236'); r(6,18,3,8,'#7E2553'); r(23,18,3,8,'#7E2553'); r(12,12,8,4,'#FFEC27'); break;
    case 'longTable': r(2,10,28,10,'#000000'); r(4,12,24,6,'#AB5236'); r(5,18,3,8,'#7E2553'); r(24,18,3,8,'#7E2553'); break;
    case 'bench': r(4,12,24,6,'#000000'); r(6,14,20,3,'#AB5236'); r(7,17,3,6,'#7E2553'); r(22,17,3,6,'#7E2553'); break;
    case 'hearth': r(6,6,20,22,'#000000'); r(8,8,16,18,'#5F574F'); r(11,16,10,8,'#FFA300'); r(13,18,6,4,'#FFEC27'); r(8,8,16,2,'#C2C3C7'); break;
    case 'rug': r(3,10,26,16,'#7E2553'); r(3,10,26,1,'#FFEC27'); r(3,25,26,1,'#FFEC27'); r(5,12,22,12,'#83769C'); break;
    case 'shelf': r(4,2,24,28,'#000000'); r(6,4,20,24,'#7E2553'); r(6,10,20,2,'#5F574F'); r(6,18,20,2,'#5F574F'); r(8,6,4,4,'#FFEC27'); r(14,6,4,4,'#29ADFF'); r(20,14,4,4,'#00E436'); r(8,14,4,4,'#FFA300'); break;
    case 'crate': r(6,8,20,20,'#000000'); r(8,10,16,16,'#AB5236'); r(6,17,20,2,'#7E2553'); r(15,8,2,20,'#7E2553'); break;
    case 'barrel': r(8,6,16,22,'#000000'); r(10,8,12,18,'#7E2553'); r(8,11,16,2,'#C2C3C7'); r(8,19,16,2,'#C2C3C7'); break;
    case 'telescope': r(14,22,4,8,'#5F574F'); r(8,10,18,5,'#83769C'); r(6,8,6,4,'#C2C3C7'); r(24,12,4,3,'#29ADFF'); break;
    case 'furnace': r(4,4,24,24,'#000000'); r(6,6,20,20,'#5F574F'); r(10,14,12,10,'#1D2B53'); r(12,18,8,5,'#FFA300'); r(14,20,4,3,'#FFEC27'); r(6,6,20,2,'#C2C3C7'); break;
    case 'anvil': r(8,16,16,6,'#5F574F'); r(6,12,20,4,'#83769C'); r(12,20,8,6,'#5F574F'); break;
    case 'planter': r(4,14,24,14,'#000000'); r(6,16,20,10,'#AB5236'); r(8,8,4,8,'#008751'); r(14,6,4,10,'#00E436'); r(20,8,4,8,'#008751'); r(13,4,3,3,'#FFEC27'); break;
    case 'trellis': r(6,4,2,24,'#7E2553'); r(24,4,2,24,'#7E2553'); r(6,8,20,2,'#7E2553'); r(6,16,20,2,'#7E2553'); r(10,6,3,6,'#00E436'); r(18,14,3,6,'#008751'); break;
    case 'well': r(6,16,20,12,'#5F574F'); r(8,18,16,8,'#1D2B53'); r(6,16,20,2,'#C2C3C7'); r(10,4,2,12,'#7E2553'); r(20,4,2,12,'#7E2553'); r(8,4,16,3,'#AB5236'); break;
    case 'bucket': r(10,14,12,12,'#83769C'); r(10,14,12,2,'#C2C3C7'); r(12,10,8,2,'#5F574F'); break;
    case 'fence': r(4,10,3,18,'#AB5236'); r(14,10,3,18,'#AB5236'); r(24,10,3,18,'#AB5236'); r(2,14,28,3,'#AB5236'); r(2,20,28,3,'#7E2553'); break;
    case 'cart': r(4,12,22,8,'#AB5236'); r(2,10,26,3,'#7E2553'); r(6,20,6,6,'#5F574F'); r(18,20,6,6,'#5F574F'); break;
    case 'banner': r(14,2,4,4,'#5F574F'); r(10,6,12,20,'#29ADFF'); r(10,6,12,2,'#1D2B53'); r(14,12,4,6,'#FFEC27'); break;
    default: r(6,10,20,16,'#000000'); r(8,12,16,12,'#5F574F'); break;
  }
}
function outdoorDetail(g,site){
  const grass=ASSETS.scenes.terrain_grass0;
  for(let y=0;y<192;y+=16)for(let x=0;x<256;x+=16)if(grass)g.drawImage(grass,x,y,16,16);
  g.fillStyle='#BA8752';g.fillRect(111,20,34,172);g.fillRect(22,143,213,25);
  if(site==='garden'){
    for(const y of [49,95])for(const x of [26,151]){
      g.fillStyle='#72513B';g.fillRect(x,y,77,35);g.fillStyle='#EDC787';g.fillRect(x,y,77,1);
      for(let r=0;r<3;r++)for(let c=0;c<7;c++){
        const px=x+7+c*10,py=y+7+r*9;g.fillStyle='#482D2B';g.fillRect(px-3,py+3,7,2);
        g.fillStyle='#315431';g.fillRect(px-2,py,5,3);g.fillRect(px,py-3,1,5);
        g.fillStyle='#98BD51';g.fillRect(px-3,py-2,3,2);g.fillRect(px+1,py-3,3,2);
        if(r%2){g.fillStyle='#D27A4A';g.fillRect(px+1,py+1,2,2);}
      }
    }
  } else if (site === 'well') {
    g.fillStyle='#939584';g.fillRect(71,59,114,86);
    for(let y=62;y<143;y+=12){g.fillStyle='#6D7165';g.fillRect(73,y,110,1);}
  }
  for (const [kind, x, y] of yardProps(site)) drawProp(g, kind, x, y);
}

function yardProps(site) {
  const props = {
    garden: [['barrel',178,56],['bucket',195,110],['trellis',44,66],['planter',110,106]],
    well: [['well',94,57],['bucket',151,100],['barrel',35,93],['barrel',190,45]],
    yard: [['cart',49,66],['crate',153,49],['barrel',191,89],['workbench',147,91]],
  }[site];
  return props ? [...props, ...[5,61,176].map(x => ['fence',x,144])] : [];
}

const hallFront = hallFrontGeometry();
const roomDoor = site => site === 'hall' ? hallFront.door : [112,176,32,16];
const roomMasks = new Map(), campRooms = new Map(), campRoomBounds = new Map();
function campRoom(site) {
  if (!campRooms.has(site)) {
    const facility=facilityOf(S.view??{},site);
    const spec=INTERIORS[site]??(S.view?.peripheralHomes?.[site] && personalInterior);
    const props = FACILITY_PROPS[facility?.type] ?? (['garden','well','yard'].includes(site) ? yardProps(site)
      : (spec?.props ?? []).map(([kind,x,y])=>[kind,x*TILE,y*TILE]));
    campRooms.set(site,roomStage(site,props,hallFront,ROOM_GRID.width/TILE,ROOM_GRID.height/TILE));
  }
  return campRooms.get(site);
}
function roomBounds(site) {
  if (!campRenderer) return ROOM_BOUNDS;
  if (!campRoomBounds.has(site)) {
    const {left,right,top,bottom}=campRoom(site).walkBounds;
    campRoomBounds.set(site,{left:Math.ceil(left*TILE),right:Math.floor(right*TILE),
      top:Math.ceil(top*TILE),bottom:Math.floor(bottom*TILE)});
  }
  return campRoomBounds.get(site);
}
function roomPixelWalk(site) {
  const key = site + '|' + Boolean(campRenderer) + '|' + (campCart?.site===site?'cart':'');
  if (!roomMasks.has(key)) {
    const { width, height } = ROOM_GRID;
    const props = ['garden', 'well', 'yard'].includes(site)
      ? yardProps(site) : (INTERIORS[site]?.props ?? []).map(([kind, x, y]) => [kind, x * TILE, y * TILE]);
    const masks = campRenderer ? [] : props.map(([kind,x,y])=>placement('prop_'+kind,x,y,64,64)).filter(Boolean);
    const walk = masks.length || site === 'hall' || campRenderer ? new Uint8Array(width * height).fill(1) : null;
    if (campRenderer) stampSceneCollision(walk,width,height,roomRenderStage(site));
    if (site === 'hall') {
      for (const rail of hallFront.rails) fillCollisionRect(walk, width, height, ...rail, 0);
    }
    for (const mask of masks) stampMask(walk, width, height, mask);
    roomMasks.set(key, walk);
  }
  return roomMasks.get(key);
}
function corridorDetail(g){
  // 连廊朝院子敞开，横向地板通向左右侧翼；没有独立房间的四面围墙。
  const grass=ASSETS.scenes.terrain_grass0,wood=ASSETS.scenes.terrain_wood0;
  for(let y=0;y<192;y+=16)for(let x=0;x<256;x+=16)if(grass)g.drawImage(grass,x,y,16,16);
  const tree=ASSETS.scenes.tree_oak0;if(tree){g.drawImage(tree,12,-35,64,80);g.drawImage(tree,178,-21,64,80);}
  g.fillStyle='#514134';g.fillRect(0,52,256,95);
  for(let y=55;y<146;y+=16)for(let x=0;x<256;x+=16)if(wood)g.drawImage(wood,x,y,16,16);
  g.fillStyle='#3F7036';g.fillRect(0,23,256,24);g.fillStyle='#98BD51';g.fillRect(0,24,256,2);
  for(let x=0;x<256;x+=9){g.fillStyle='#315431';g.fillRect(x,26,1,21);}
  g.fillStyle='#72513B';g.fillRect(0,47,256,6);g.fillStyle='#D8A667';g.fillRect(0,47,256,1);
  for(const x of [6,57,194,245]){g.fillStyle='#514134';g.fillRect(x,47,5,103);g.fillStyle='#D8A667';g.fillRect(x,49,1,99);}
  g.fillStyle = '#72513B';
  for (const rail of hallFront.rails) g.fillRect(...rail);
  const [x, y, w, h] = hallFront.stair;
  g.fillStyle = '#BA8752'; g.fillRect(x, y, w, h);
  g.fillStyle = '#EDC787'; g.fillRect(x, y + 7, w, 1); g.fillRect(x, y + 16, w, 1);
}
function roomNavigation(g,w,site){
  if(site!=='hall')return;
  g.font='6px fusion-pixel, monospace';
  for(const [room,x,label] of [['home',0,'← 居所'],['store',218,'公仓 →']])if(w.rooms?.[room]){
    g.fillStyle='#514134';g.fillRect(x,104,38,22);g.fillStyle='#EDC787';g.fillRect(x,104,38,1);g.fillStyle='#FFF0CC';g.fillText(label,x+4,118);
  }
}
function drawInterior(cv, w, site, preview = false) {
  const { width: VIEW_W, height: VIEW_H } = ROOM_GRID;
  const spec = INTERIORS[site] ?? INTERIORS.hall, outdoor=['garden','well','yard'].includes(site);
  const zoom = preview ? 1 : ui.fullscreen ? fullZoom(VIEW_W, VIEW_H) : Math.max(1, Math.min(ZOOM, Math.floor(((cv.parentElement?.clientWidth || VIEW_W * ZOOM + 20) - 20) / VIEW_W)));
  const CW = VIEW_W * zoom, CH = VIEW_H * zoom;
  if (cv.width !== CW || cv.height !== CH) { cv.width = CW; cv.height = CH; cv.style.width = `${CW}px`; cv.style.height = `${CH}px`; }
  const g = cv.getContext('2d');
  g.setTransform(zoom, 0, 0, zoom, 0, 0); g.imageSmoothingEnabled = false;
  g.clearRect(0, 0, VIEW_W, VIEW_H);
  // 成套地板/墙裙/窗框：原生32px贴图以整数像素显示。
  const stone = ['workshop', 'well', 'watch'].includes(site), texture = ASSETS.scenes[`terrain_${stone ? 'stone' : 'wood'}0`];
  g.fillStyle = '#BA8752'; g.fillRect(0, 0, VIEW_W, VIEW_H);
  if (texture) for (let y = 0; y < VIEW_H; y += 16) for (let x = 0; x < VIEW_W; x += 16) g.drawImage(texture, x, y, 16, 16);
  g.fillStyle = '#514134'; g.fillRect(0, 0, VIEW_W, 34); g.fillRect(0, 0, 24, VIEW_H); g.fillRect(VIEW_W - 24, 0, 24, VIEW_H);
  g.fillStyle = '#F6DDA8'; g.fillRect(3, 3, VIEW_W - 6, 25);
  for (let x = 4; x < VIEW_W - 4; x += 8) { g.fillStyle = '#D8A667'; g.fillRect(x, 3, 1, 25); g.fillStyle = '#FFF0CC'; g.fillRect(x + 1, 4, 1, 23); }
  g.fillStyle = '#976A45'; g.fillRect(2, 28, VIEW_W - 4, 4); g.fillStyle = '#EDC787'; g.fillRect(2, 28, VIEW_W - 4, 1);
  for (const wx of [4, 10]) {
    const x = wx * TILE;
    g.fillStyle = '#72513B'; g.fillRect(x - 2, 7, 28, 20); g.fillStyle = '#D8A667'; g.fillRect(x - 1, 8, 26, 18);
    g.fillStyle = '#458996'; g.fillRect(x + 1, 10, 22, 13); g.fillStyle = '#A0D2C6'; g.fillRect(x + 2, 10, 8, 4);
    g.fillStyle = '#F6DDA8'; g.fillRect(x + 11, 10, 2, 13); g.fillRect(x + 1, 16, 22, 1);
    g.fillStyle = '#72513B'; g.fillRect(x - 3, 25, 30, 2);
    // 零 alpha 的窗光；夜间不伪造日光。
    if (w.phase !== '夜') { g.fillStyle = '#EDC787'; for (let y = 36; y < 60; y++) for (let xx = 0; xx < 28; xx++) if ((xx + y) % 4 === 0) g.fillRect(x + xx + Math.floor((y - 36) / 3), y, 1, 1); }
  }

  if(site==='hall')corridorDetail(g);
  if(outdoor)outdoorDetail(g,site);

  // 门（底部中央 2 格）+ 提示
  const [doorX, doorY, doorW, doorH] = site === 'hall' ? hallFront.door
    : [VIEW_W / 2 - TILE, VIEW_H - TILE, TILE * 2, TILE];
  g.fillStyle = '#514134'; g.fillRect(doorX, doorY, doorW, doorH);
  g.fillStyle = '#BA8752'; g.fillRect(doorX + 2, doorY + 2, doorW - 4, doorH - 4);
  g.fillStyle = '#000000'; g.fillRect(doorX + doorW / 2 - 1, doorY + 4, 2, 8);
  g.font = '6px fusion-pixel, monospace';
  // 房名
  const label = (w.rooms ?? LOCS)[site] ?? site;
  g.fillStyle = '#000000'; g.fillRect(VIEW_W / 2 - label.length * 3 - 4, 6, label.length * 6 + 8, 11);
  g.fillStyle = '#FFF1E8'; g.fillText(label, VIEW_W / 2 - label.length * 3, 14);
  // 家具与人按脚底深度排序，室内也遵守近遮远。
  const occ = preview ? [] : w.occupancy?.[site] ?? [];
  if (!preview && IPOS.site !== site) { IPOS.site = site; IPOS.x = site === 'hall' ? hallFront.centerX - 8 : 120; IPOS.y = 150; IPOS.moving = false; IPOS.direction = 'down'; }
  const spots = [[6,8],[9,8],[5,5],[9,5],[4,9],[11,9],[6,10],[8,10]];
  const items = (outdoor?[]:spec.props).map(([kind, x, y]) => ({ kind, x, y, depth: kind === 'rug' ? -1 : y + 4 }));
  occ.forEach((who, i) => {
    if (who === 'p1') { items.push({ who, x: IPOS.x / TILE, y: IPOS.y / TILE, depth: IPOS.y / TILE + 1 }); return; }
    const [x, y] = spots[i % spots.length]; items.push({ who, x, y, depth: y + 1 });
  });
  if (!preview && !occ.includes('p1')) items.push({ who: 'p1', x: IPOS.x / TILE, y: IPOS.y / TILE, depth: IPOS.y / TILE + 1 });
  items.sort((a, b) => a.depth - b.depth);
  drawGroundShadows(g,items.filter(item=>item.who).map(item=>({who:item.who,wx:item.x,wy:item.y})),{x:0,y:0,zoom},w.phase);
  for (const item of items) {
    const px = item.x * TILE, py = item.y * TILE;
    if (item.kind) { drawProp(g, item.kind, px, py); continue; }
    const isP1 = item.who === 'p1';
    const act = isP1 && IPOS.moving ? (ACT.index?.move_to ?? ACT.index?.walk ?? actionRow(w.agents?.p1)) : actionRow(w.agents?.[item.who]);
    drawResident(g, item.who, act, px, py, isP1 ? IPOS.direction : 'down', w.agents?.[item.who]?.stage);
    g.fillStyle = '#FFF0CC'; g.fillText(isP1 ? '你' : (w.agents?.[item.who]?.name ?? item.who), px, py + TILE + 6);
  }
  const light=toneScene(g,cv,w.phase,!outdoor&&site!=='hall');
  if(!outdoor){
    for(const x of site==='hall'?[61,189]:[31,216]){
      g.fillStyle='#514134';g.fillRect(x,37,7,12);warmLamp(g,x+1,40,5,7,light);
    }
  }
  const exitLabel = site === 'hall' ? hallFront.label : [99, 174, 58, 15];
  g.font = '6px fusion-pixel, monospace'; g.fillStyle = '#514134'; g.fillRect(...exitLabel);
  g.fillStyle = '#FFF0CC'; g.fillText(outdoor ? '返回营地' : '点门离开', exitLabel[0] + 12, exitLabel[1] + 10);
  g.fillStyle='#514134';g.fillRect(103,5,50,13);g.fillStyle='#FFF0CC';g.fillText(label,128-label.length*3,14);
  roomNavigation(g,w,site);
  return { mode: 'interior', site };
}

let campAngle=0;
const CAMP_ANGLES=[.29,-.29,0];
const campFog=new WeakMap();
const previewFlags=new URLSearchParams(location.search);
const physicalLighting=!previewFlags.has('bakedLight');
const animateParts=!previewFlags.has('staticParts');
const campShadowSources=new WeakMap();
function campShadows(world,regions) {
  const layers=[world.scene3d.boxes,world.work3d,
    ...regions.flatMap(region=>region.boxes?[region.boxes]:[])].filter(Boolean);
  const old=campShadowSources.get(world.canvas);
  if (old?.layers.length===layers.length && layers.every((layer,i)=>old.layers[i]===layer)) return old.source;
  const source=layers.flatMap(layer=>layer.filter(b=>b.solid && b.w*b.d>.10)
    .map(b=>b.bounds??modelBounds(b)));
  campShadowSources.set(world.canvas,{layers,source});
  return source;
}

function campVisibility(world,cvId,x,z,phase,extended,regional,regions) {
  const radius=lightRadius(phase);
  const lists=[world.scene3d.boxes,world.homes3d?.boxes,world.work3d,world.life3d?.boxes,regional?.boxes,
    ...regions.flatMap(r=>r.boxes && r!==regional?[r.boxes]:[])].filter(Boolean);
  let views=campFog.get(world.canvas);
  if (!views) { views=new Map(); campFog.set(world.canvas,views); }
  const previous=views.get(cvId);
  const sameScene=previous?.lists.length===lists.length && lists.every((boxes,i)=>boxes===previous.lists[i]);
  x=Math.round(x*4)/4;z=Math.round(z*4)/4;
  const key=x+','+z+'|'+radius;
  if (sameScene && previous.key===key) return previous.mask;
  const height=(px,pz)=>{
    const surface=world.scene3d.heightAt(px,pz);
    const ground=extended?.height(px,pz);
    return ground===undefined ? surface : inCamp(px,pz)?Math.max(surface,ground):ground;
  };
  const scene=sameScene?previous.scene:sightScene(height,lists);
  const mask=campSight(scene,x,z,radius);
  views.set(cvId,{lists,key,scene,mask});
  return mask;
}

function campViewport(cv, aspect) {
  const full=cv.id==='cvFull', room=Boolean(ui.interior);
  const available=full ? innerWidth-12 : cv.parentElement.clientWidth-20;
  const display=Math.max(180,Math.min(full?innerWidth-12:1120,available));
  const height=Math.min(full?innerHeight-80:520,Math.round(display/aspect));
  const ratio=Math.min(devicePixelRatio||1,1.5);
  const width=Math.round(display*ratio), pixels=Math.round(Math.max(150,height)*ratio);
  if(cv.width!==width||cv.height!==pixels){cv.width=width;cv.height=pixels;}
  cv.style.width=display+'px';
  cv.style.height=Math.max(150,height)+'px';
  return { width,height:pixels,room };
}

// ── 3D 世界标注层（规格：AMBRACE-3D-UI规格.md §3/§7）─────────────────────
// 正交投影 w≡1 ⇒ 1 世界单位 = 画布宽/span，远近不缩放；下面的坐标全是 backing 像素。
// 字号一律以 CSS px 定义，绘制时乘 ratio，否则 dpr 1.5 的屏上会缩水 1/3。
function campRatio(cv) {
  const css = parseFloat(cv.style.width) || cv.width;
  return Math.max(1, Math.min(2, cv.width / css));
}
const labelPx = (size, ratio) => Math.round(size * ratio);

function campRing(g,camera,p,ratio,color,frame=0) {
  const y=p.y+.025, r=.34+[0,.02,0,-.02][frame%4], c=camera.project(p.x,y,p.z);
  const ax=camera.project(p.x+r,y,p.z), az=camera.project(p.x,y,p.z+r);
  const vx=[ax[0]-c[0],ax[1]-c[1]], vz=[az[0]-c[0],az[1]-c[1]];
  const dot=Math.max(2,Math.round(2*ratio));
  for(let i=0;i<32;i+=1){
    const t=i/32*Math.PI*2, q=Math.cos(t), s=Math.sin(t);
    // AI 用中性浅灰而不是草绿：实拍确认 #98BD51 压在草地上对比度不足，几乎看不见。
    g.fillStyle=(color==='#FFEC27'||color==='#EDC787')?color:(i%2===0?'#C2C3C7':'#5F574F');
    g.fillRect(Math.round(c[0]+vx[0]*q+vz[0]*s),Math.round(c[1]+vx[1]*q+vz[1]*s),dot,dot);
  }
}
// 悬停名牌用 8×8 象形图标表示"在做什么"，不写中文动作词：宽度比「绛 · 采集」少约 40%。
// 动作来自载荷 a.last.kind（世界事实），前端只做归类，不猜行为。
const ACTION_TINT = {
  still:'#C2C3C7', move:'#29ADFF', work:'#C2C3C7', build:'#EDC787', repair:'#D58274',
  gather:'#98BD51', talk:'#A0D2C6', food:'#FFA300', social:'#FF77A8',
};
// 建/修/采各自独立：不再把所有劳动塞进一个 work 图标。
const ACTION_KIND = {
  idle:'still', rest:'still', seclude:'still', deafen:'still',
  walk:'move', move_to:'move', look_out:'move',
  work:'work',
  build:'build', plan:'build',
  repair:'repair',
  till:'build', gather:'gather', harvest:'gather', plant:'gather', forage:'gather', collect:'gather', produce:'gather',
  talk:'talk', hail:'talk', rej:'talk', refuse:'talk', say:'talk',
  eat:'food', take_shared:'food', trade:'food', buy:'food',
  companion:'social',
};
const ACTION_ICON = {
  // 家族口径见 AMBRACE-图标家族表.md：覆盖率收在 31%–41%，只改过重/过轻的 5 个，其余原样。
  // still=暂停符（与 social 的人形明确区分）、gather=提篮、food=冒热气的碗。
  still: ['...##...','..####..','.######.','..####..','...##...','........','..####..','........'],
  move:  ['...#....','..##....','.#####..','#######.','.#####..','..##....','........','........'],
  work:  ['........','....###.','...####.','..###...','.###....','.###....','####....','........'],
  build: ['........','...##...','..####..','.######.','..#..#..','..#..#..','.######.','........'],
  repair:['#......#','.#....#.','..####..','...##...','...##...','..####..','.#....#.','#......#'],
  gather:['#......#','.#....#.','.######.','.######.','..####..','........','........','........'],
  talk:  ['..####..','.#....#.','#..##..#','#..##..#','#......#','.#....#.','..####..','...##...'],
  food:  ['..#..#..','..#..#..','.######.','.#....#.','.######.','..####..','........','........'],
  social:['...##...','..####..','...##...','.######.','..#..#..','..#..#..','..####..','........'],
};
// 动作从已有载荷推导，不新增引擎字段：玩家取最近一次成功行动（3 刻内）或当前工具；
// AI 取合作任务的 phase（gather/plan/build/repair）与 workers，兜底 last.kind。
function campAct(w, who) {
  const raw = w?.agents?.[who]?.act;
  if (raw && raw !== 'idle') return raw;   // 载荷里的真实决策动作（只读字段）
  if (who === 'p1') {
    const t = w?.t ?? 0;
    const hit = (w?.log ?? []).slice(-8).reverse().find((l) => l.ok && l.kind && l.kind !== 'agentError' && t - (l.t ?? t) <= 3);
    if (hit) return hit.kind;
    return { hand:'idle', axe:'gather', pick:'gather', hammer:'build', hoe:'harvest', bag:'idle' }[ui.tool] ?? 'idle';
  }
  const task = w?.coop?.task;
  if (task && Array.isArray(task.workers) && task.workers.includes(who)) return task.phase;
  return w?.agents?.[who]?.last?.kind ?? 'idle';
}
function campBadge(g,camera,point,name,kind,size,ratio) {
  const [x,y]=camera.project(...point);
  const px=labelPx(size,ratio), pad=16*ratio, bottom=88*ratio;
  if(x<pad||y<pad+px||x>g.canvas.width-pad||y>g.canvas.height-bottom)return;
  g.font=px+'px fusion-pixel,monospace';
  const tw=Math.ceil(g.measureText(name).width), unit=Math.max(1,Math.round(ratio));
  const icon=8*unit, gap=4*unit, inner=3*unit, bw=tw+icon+gap+inner*2;
  const bx=Math.max(pad,Math.min(g.canvas.width-bw-pad,Math.round(x-bw/2)));
  const by=Math.round(y)-px-2, bh=px+4;
  g.fillStyle='#18251E';g.fillRect(bx,by,bw,bh);
  g.fillStyle='#83769C';g.fillRect(bx,by,bw,unit);
  g.fillStyle='#FFF0CC';g.fillText(name,bx+inner,Math.round(y));
  const key=ACTION_KIND[kind]??'still', rows=ACTION_ICON[key];
  g.fillStyle=ACTION_TINT[key];
  const ix=bx+tw+gap+inner, iy=by+Math.round((bh-icon)/2);
  for(let r=0;r<8;r+=1)for(let c=0;c<8;c+=1)if(rows[r][c]==='#')g.fillRect(ix+c*unit,iy+r*unit,unit,unit);
}

// 炊烟：改在 2D 叠加层画（3D 几何会被 WebGL light 压暗成蓝灰方块，看不出是烟）。
function campSmoke(g,camera,chimneys,ratio,frame,light) {
  if(!chimneys||!chimneys.length)return;
  const u=Math.max(2,Math.round(3*ratio));
  const day=['#FFF0CC','#C2C3C7','#939584','#6D7165'], night=['#C2C3C7','#939584','#6D7165','#5F574F'];
  for(const [x,y,z] of chimneys) for(let i=0;i<3;i+=1){
    const k=(frame+i)%4;
    const [sx,sy]=camera.project(x+[0,.16,.05,-.16][k],y+k*.34,z+k*.06);
    if(sx<0||sy<0||sx>g.canvas.width||sy>g.canvas.height)continue;
    g.fillStyle=(light[0]<.7?night:day)[k];
    g.fillRect(Math.round(sx),Math.round(sy),u,u);
  }
}

// 夜/暮萤火：确定性 hash 撒点 + 共享帧号闪烁，零随机、零 alpha、不进世界状态。
function campAmbient(g,camera,span,cx,cz,ratio,frame) {
  const unit=Math.max(1,Math.round(ratio)), t=frame%4;
  for(let i=0;i<22;i+=1){
    if((i+t)%3===0)continue;
    const h1=Math.sin(i*12.9898)*43758.5453, h2=Math.sin(i*78.233)*22578.145;
    const wx=cx+(h1-Math.floor(h1)-.5)*span*.8, wz=cz+(h2-Math.floor(h2)-.5)*span*.5;
    const [sx,sy]=camera.project(wx,.28+((i+t)%3)*.14,wz);
    if(sx<0||sy<0||sx>g.canvas.width||sy>g.canvas.height)continue;
    g.fillStyle=(i+t)%2?'#FFEC27':'#00E436';
    g.fillRect(Math.round(sx),Math.round(sy),unit,unit);
  }
}

// 拾取点：4 个角括号，不画整圈，避免和贴地光圈抢视觉。
function campPick(g,camera,x,z,ratio) {
  const [sx,sy]=camera.project(x,0,z), X=Math.round(sx), Y=Math.round(sy);
  const s=Math.max(4,Math.round(6*ratio)), t=Math.max(1,Math.round(2*ratio));
  g.fillStyle='#EDC787';
  for(const [ox,oy] of [[-1,-1],[1,-1],[-1,1],[1,1]]){
    const px=X+(ox<0?-s:0), py=Y+(oy<0?-s:0);
    g.fillRect(px,py,s,t);g.fillRect(px,py,t,s);
  }
}
// 全景：把正交投影留出的边带画成"地图桌"边框，而不是一大圈空白。
function campMapFrame(g,camera,stage,ratio,bounds={west:0,north:0,east:stage.width,south:stage.depth}) {
  const a=camera.project(bounds.west,0,bounds.north), b=camera.project(bounds.east,0,bounds.south);
  const x0=Math.min(a[0],b[0]),y0=Math.min(a[1],b[1]),x1=Math.max(a[0],b[0]),y1=Math.max(a[1],b[1]);
  const t=Math.max(1,Math.round(ratio));
  g.fillStyle='#72513B';
  g.fillRect(x0,y0,x1-x0,t);g.fillRect(x0,y1-t,x1-x0,t);
  g.fillRect(x0,y0,t,y1-y0);g.fillRect(x1-t,y0,t,y1-y0);
  const k=Math.round(8*ratio);
  g.fillStyle='#EDC787';
  for(const [cx,cy] of [[x0,y0],[x1,y0],[x0,y1],[x1,y1]]){
    g.fillRect(cx-(cx===x0?0:k),cy-(cy===y0?0:k),k,t);g.fillRect(cx-(cx===x0?0:k),cy-(cy===y0?0:k),t,k);
  }
  g.font=labelPx(12,ratio)+'px fusion-pixel,monospace';
  g.fillStyle='#D9D6B8';g.fillText(`世界全景 · ${bounds.east-bounds.west}×${bounds.south-bounds.north} 格`,Math.max(16*ratio,x0),Math.max(16*ratio,y0-8*ratio));
}
let campHover=null, outdoorIntent=null;

function campClimate(w) {
  const weather=w.weather, storm=w.disasterToday==='storm';
  return {storm, drought:Boolean(w.drought),
    rain:storm || weather==='rain', snow:w.disasterToday==='coldsnap' || (w.season==='冬' && weather==='cold'),
    season:['春','夏','秋','冬'].indexOf(w.season)};
}
function paintWeather(g,climate,time,ratio) {
  if (!climate.rain && !climate.snow) return;
  const {width,height}=g.canvas, snow=climate.snow && !climate.storm;
  const count=climate.storm?104:snow?50:55, speed=snow?24:climate.storm?420:265;
  g.save();
  g.strokeStyle=snow?'#DDE4DE':'#A3BEC1';
  g.fillStyle=g.strokeStyle;
  g.lineWidth=Math.max(1,ratio);
  g.globalAlpha=snow?.57:climate.storm?.46:.26;
  g.beginPath();
  for (let i=0;i<count;i+=1) {
    const x=((i*271.3+time*(snow?9:climate.storm?160:65))*ratio)%(width+20)-10;
    const y=((i*163.7+time*speed)*ratio)%(height+24)-12;
    if (snow) g.fillRect(Math.round(x),Math.round(y),ratio*(i%3===0?2:1),ratio);
    else { g.moveTo(x,y); g.lineTo(x+(climate.storm?7:3)*ratio,y+10*ratio); }
  }
  g.stroke();
  g.restore();
}

function roomCrowd(w,site) {
  const ids=(w.occupancy?.[site]??[]).filter(who=>who!=='p1');
  const slots=[[6,9],[9.6,9],[5.65,5.4],[9.45,5.4],[4,9],[11.7,9],[6.7,7.3],[9.6,7.3]];
  const pixels=roomPixelWalk(site), cells=collisionEditor.cells(site), bounds=roomBounds(site);
  return slots.filter(([x,z])=>roomBodyFits(site,cells,pixels,bounds,x*TILE,z*TILE)).slice(0,ids.length)
    .map(([x,z],i)=>({who:ids[i],x,z,r:CAMP_BODY_RADIUS,moving:false,direction:'down'}));
}
function roomBodyFits(site,cells,pixels,bounds,x,z) {
  const [doorX,,doorW]=roomDoor(site), r=CAMP_BODY_RADIUS*TILE;
  const inDoor=x>=doorX+r && x<=doorX+doorW-r;
  const left=x-r, right=x+r, top=z-r, bottom=inDoor?Math.min(z+r,bounds.bottom):z+r;
  if (left<bounds.left || right>bounds.right || top<bounds.top || bottom>bounds.bottom) return false;
  for (let y=Math.floor(top);y<=Math.floor(bottom);y+=1) {
    for (let px=Math.floor(left);px<=Math.floor(right);px+=1) {
      if (!roomAllows(cells,px,y,pixels,bounds)) return false;
    }
  }
  return true;
}
const campWorlds=new Map(), campHerds=new Map();
function animalGround(world,a,x,z) {
  const h=a.habitat,r=a.r*.87;
  if (x-r<h.x || x+r>h.x+h.w || z-r<h.z || z+r>h.z+h.d) return false;
  if (a.kind==='bird') return true;
  if (!inCamp(x,z)) return Boolean(world.landscape?.walkable(x,z));
  return [[0,0],[-r,0],[r,0],[0,-r],[0,r]].every(([dx,dz])=>mapAllows(world,x+dx-.5,z+dz-.5));
}
function drawHerd(world,id,time,roster,trust,regional=[]) {
  const previous=campHerds.get(id)??[], blockers=[];
  for (const who of Object.keys(roster)) {
    const person=WALK[walkKey(id,who)];
    if (person) blockers.push({id:who,x:person.x+.5,z:person.y+.5,r:CAMP_BODY_RADIUS});
  }
  const animals=[], bases=[...(world.life3d?.animals??[]),...regional];
  for (const [i,base] of bases.entries()) {
    const old=previous.find(a=>a.id===base.id && a.habitat.x===base.habitat.x && a.habitat.z===base.habitat.z);
    const a={...base,x:old?.x??base.x,z:old?.z??base.z,next:old?.next??time+hash2(i,11,4)*2,
      target:old?.target,serial:old?.serial??0,direction:old?.direction??0,phase:hash2(i,42,3)*6,
      moving:false,time};
    const neighbors=a.kind==='bird'?[]:[...blockers,...animals,...bases.slice(i+1).map(b=>previous.find(p=>p.id===b.id)??b)].filter(b=>b.kind!=='bird');
    const alert=a.wild && a.kind!=='bird' && blockers.find(p=>{
      const bond=p.id==='p1'?trust?.[a.id]?.trust??0:0;
      const distance=Math.hypot(p.x-a.x,p.z-a.z);
      return distance<(bond>=4?.7:2.7) && !(p.id==='p1' && id==='cvA' && ui.tool==='basket' && distance>=1.15);
    });
    const dt=old?Math.min(.12,Math.max(0,time-old.time)):0;
    if (alert && (!old?.alert || a.target && Math.hypot(a.target.x-alert.x,a.target.z-alert.z)<=Math.hypot(a.x-alert.x,a.z-alert.z))) {
      a.target=null; a.next=time;
    }
    if (a.afraid && !old?.afraid) { a.target=null; a.next=time+1; }
    a.alert=Boolean(alert);
    if (time>=a.next && !a.target) {
      const h=a.habitat;
      for (let attempt=0;attempt<8;attempt+=1) {
        const n=++a.serial;
        const x=h.x+a.r+hash2(i,n,13)*(h.w-2*a.r), z=h.z+a.r+hash2(i,n,37)*(h.d-2*a.r);
        if (alert && Math.hypot(x-alert.x,z-alert.z)<Math.hypot(a.x-alert.x,a.z-alert.z)+.8) continue;
        if (a.afraid && Math.hypot(x-a.x,z-a.z)>2.2) continue;
        if (Math.hypot(x-a.x,z-a.z)>.5 && animalGround(world,a,x,z)) { a.target={x,z}; break; }
      }
      if (!a.target) a.next=time+.7;
    }
    if (a.target && dt) {
      const dx=a.target.x-a.x,dz=a.target.z-a.z,len=Math.hypot(dx,dz);
      if (len>.12) {
        const step=Math.min(len,a.speed*dt*(alert?1.7:a.afraid?.48:1)), x=a.x+dx*step/len, z=a.z+dz*step/len;
        if (animalGround(world,a,x,z) && separates(a.x,a.z,x,z,neighbors,a.r)) {
          a.x=x;a.z=z;a.moving=true;
          a.direction=Math.abs(dx)>Math.abs(dz)?(dx>0?3:1):(dz>0?0:2);
        }
      }
      if (!a.moving) {
        a.target=null;
        a.next=time+(alert?.12:.65+hash2(i,a.serial,71)*3.8);
      }
    }
    animals.push(a);
  }
  campHerds.set(id,animals);
  return animals;
}
function roomRenderStage(site) {
  const stage=campRoom(site);
  if (campCart?.site!==site) return stage;
  return campCart.stage??={...stage,boxes:stage.boxes.filter(b=>b.occluder!==campCart.prop.id)};
}
function roomProps(site) {
  const props=campRoom(site).interactables;
  if (campCart?.site!==site) return props;
  const {prop,x,z}=campCart, dx=x-prop.x, dz=z-prop.z;
  return props.map(p=>p.id!==prop.id?p:{...p,x,z,boxes:p.boxes.map(b=>({...b,x:b.x+dx,z:b.z+dz}))});
}
function startCart(prop) {
  const {site}=IPOS;
  if (campCart?.site!==site) campCart={site,prop,x:prop.x,z:prop.z};
  campCart.attached=true;
  toast('推车中 · F 松手');
}
function cartAllows(site,cells,pixels,bounds,x,z,nx,nz,crowd) {
  if (campCart?.site!==site) return true;
  const {prop,attached}=campCart;
  const tx=campCart.x+(attached?(nx-IPOS.x-8)/TILE:0), tz=campCart.z+(attached?(nz-IPOS.y-16)/TILE:0);
  const gap=rectGap(nx/TILE,nz/TILE,tx,tz,prop.w,prop.d);
  if (!attached) return gap>=CAMP_BODY_RADIUS ||
    gap>rectGap(x/TILE,z/TILE,tx,tz,prop.w,prop.d);
  const left=tx*TILE,right=(tx+prop.w)*TILE,top=tz*TILE,bottom=(tz+prop.d)*TILE;
  for (let row=Math.floor(top);row<=Math.floor(bottom);row+=1)
    for (let col=Math.floor(left);col<=Math.floor(right);col+=1)
      if (!roomAllows(cells,col,row,pixels,bounds)) return false;
  return crowd.every(p=>rectGap(p.x,p.z,tx,tz,prop.w,prop.d)>=p.r);
}
function roomPropsMesh(site,s) {
  const work=[];
  const cart=roomProps(site).find(p=>p.kind==='cart');
  if (cart && campCart?.site===site) work.push(...cart.boxes);
  const table=campRoom(site).interactables.find(p=>p.kind==='table');
  if (!table) return work;
  const food=s.camp?.containers?.[`${site}:meal`]??{};
  const y=Math.max(...table.boxes.map(b=>b.y+b.h));
  if (food.tray) for (const [dx,dy,dz,w,h,d,color] of itemBoxes('tray'))
    work.push({x:table.x+dx*1.9,y:y+.004+dy*.18,z:table.z+dz*1.3,w:w*1.9,h:h*.18,d:d*1.3,color});
  let i=0;
  for (const item of CAMP_FOOD) for (let n=0;n<(food[item]??0) && i<6;n+=1,i+=1) {
    const x=table.x+.21+(i%3)*.44,z=table.z+.29+Math.floor(i/3)*.46;
    work.push({x,y:y+.004,z,w:.31,h:.043,d:.26,color:'#DCD3B7'});
    for (const [dx,dy,dz,w,h,d,color] of itemBoxes(item))
      work.push({x:x-.015+dx*.35,y:y+.044+dy*.34,z:z-.043+dz*.35,w:w*.35,h:h*.34,d:d*.35,color});
  }
  return work;
}

function animatedConstruction(world) {
  const boxes=world.work3d??[];
  if (!ACT.motionTime || !world.workProjects?.length) return boxes;
  const now=performance.now(), factors=new Map();
  for (const {id,since,phase} of world.workProjects) {
    const t=Math.min(1,Math.max(0,(now-since)/650));
    const from=phase==='complete'?.55:phase==='frame'?.18:.045;
    if (t<1) factors.set(id,from+(1-from)*(1-(1-t)**3));
  }
  if (!factors.size) return boxes;
  return boxes.map(b=>{
    const factor=b.rise && factors.get(b.occluder);
    if (!factor) return b;
    const base=b.rise==='ground'?0:.16;
    return {...b,transient:true,y:base+(b.y-base)*factor,h:b.h*factor};
  });
}
function drawCamp(cv,w) {
  const aspect=ui.fullscreen?Math.max(1.18,(innerWidth-12)/(innerHeight-80)):ui.interior?1.65:1.9;
  const {width,height,room}=campViewport(cv,aspect);
  const overview=ui.overview&&!room;
  let stage, life, homes, exterior, terrain, visibility, sight, waterMask, people=[], animals=[], residentHint, work=[], hearth, regions, extended, targetY, x,z,span;
  const playerId=cv.id==='cvFull'?'cvA':cv.id;
  if (room) {
    const site=ui.interior;
    stage=roomRenderStage(site);
    if (IPOS.site!==site) {
      IPOS.site=site;IPOS.x=site==='hall'?hallFront.centerX-8:120;IPOS.y=150;IPOS.moving=false;IPOS.direction='down';
    }
    x=stage.width/2; z=stage.depth/2;
    span=Math.max(stage.width+4,stage.depth*.78*width/height+2);
    people=roomCrowd(w,site);
    work=roomPropsMesh(site,w);
    const fire=stage.interactables.find(p=>p.kind==='hearth');
    if (fire) hearth=[fire.x+fire.w*.5,fire.z+fire.d*.85,0,.79+.14*Math.sin((ACT.motionTime??0)*6)];
    people.push({who:'p1',x:(IPOS.x+8)/TILE,z:(IPOS.y+16)/TILE,moving:IPOS.moving,direction:IPOS.direction,act:campAct(w,'p1')});
    if (campCart?.attached && campCart.site===site) people.at(-1).act='push';
    if (campPose) {
      const person=people.at(-1), prop=campPose.prop;
      if (campPose.kind==='eat') person.act='eat';
      else {
        person.x=prop.x+prop.w*.5;
        person.z=prop.z+prop.d*.5;
        person.pose=campPose.kind;
        person.poseY=stage.heightAt(person.x,person.z)+(person.pose==='sleep'?.52:.29);
        person.moving=false;
        person.direction='down';

      }
    }
  } else {
    const world=buildWorld(w);
    exterior=world;
    campWorlds.set(playerId,world);
    stage=world.scene3d;life=world.life3d;homes=world.homes3d;terrain=world.canvas;waterMask=world.waterMask;
    const slots=slotsOf(w,world.sites);
    for(const who of Object.keys(slots))ensureWalker(playerId,who,world,slots);
    const pw=WALK[walkKey(playerId,'p1')];
    const pTile=pw?[pw.x,pw.y]:slots.p1;
    if(playerId==='cvA')camFollow=pTile;
    const p=(playerId==='cvB'?camFollow:pTile) ||
      world.sites[w.loc?.p1] || [world.tw/2,world.th/2];
    x=overview?world.tw/2:p[0]+.5;z=overview?world.th/2:p[1]-2;
    span=overview?Math.max(world.tw+5,(world.th+4)*width/height):Math.min(29,Math.max(18,width/28));
    const connected=S.soloSurv && playerId==='cvA';
    const playerX=p[0]+.5, playerZ=p[1]+.5;
    if (connected) {
      extended=campOutskirts(w,world);
      terrain=null; waterMask=null;
      if (overview) {
        x=(WILDS.west+WILDS.east)/2;
        z=(WILDS.north+WILDS.south)/2;
        span=Math.max(WILDS.east-WILDS.west+12,(WILDS.south-WILDS.north+12)*width/height);
        regions=extended.overview();
      } else {
        regions=extended.regions(playerX,playerZ);
        const regional=w.settlementLife ? extended.life(playerX,playerZ,w) : null;
        if (regional) {
          regions=[...regions,regional];
          exterior={...world,regional};
        }
        targetY=(inCamp(playerX,playerZ)?Math.max(stage.heightAt(playerX,playerZ),extended.height(playerX,playerZ)):
          extended.height(playerX,playerZ))+.55;
      }
    }
    animals=drawHerd(world,playerId,ACT.motionTime??0,slots,w.wildTrust,exterior.regional?.animals);
    if (extended) for (const animal of animals) animal.groundY=extended.height(animal.x,animal.z);
    if (!overview && pTile) {
      visibility=campVisibility(world,playerId,playerX,playerZ,w.phase,extended,exterior.regional,regions??[]);
      animals=animals.filter(a=>visibility.sees(a.x,a.z,(a.groundY??stage.heightAt(a.x,a.z))+(a.kind==='bird'?3.4:.65)));
    }
    if (!overview && pTile) sight=[pTile[0]+.5,pTile[1]+.5,lightRadius(w.phase)];
    for(const [who,[sx,sy]] of Object.entries(slots)){
      const walker=WALK[walkKey(playerId,who)];
      const px=walker?.x??sx, pz=walker?.y??sy;
      if (visibility && who!=='p1' && !visibility.sees(px+.5,pz+.5)) continue;
      people.push({who,x:px+.5,z:pz+.5,moving:walker?.moving,direction:walker?.direction,act:campAct(w,who)});
    }
    work=[...animatedConstruction(world),...world.districtResources];
    if (S.soloSurv && ui.tool==='hammer' && !overview) {
      for (const {loc,lot:{x,z,w,d}} of world.openLots) {
        if (Math.hypot(x+w/2-playerX,z+d/2-playerZ)>22) continue;
        for (const px of [x+.04,x+w-.16]) for (const pz of [z+.04,z+d-.16])
          work.push({x:px,z:pz,y:extended?.height(px,pz)??stage.heightAt(px,pz),w:.12,d:.12,h:.26,color:'#C19962',occluder:'lot:'+loc,transient:true});
      }
    }
  }
  const camera=campCamera({x,z,width,height,span,yaw:overview?0:CAMP_ANGLES[campAngle],pitch:overview?Math.PI/2-.001:room?.76:.65,targetY});
  const climate=campClimate(w);
  const time=ACT.motionTime??0, open=!room || ['hall','yard','garden','well','watch'].includes(ui.interior);
  const elapsed=S.running ? Math.max(0,performance.now()-(S.sunTickAt??performance.now())) : 0;
  const sun=S.soloSurv ? solarLight(w.t+Math.min(.98,elapsed/(S.tickMs??7500)),w.dayTicks??24,climate.season,
    {storm:climate.storm,overcast:climate.rain||climate.snow,indoor:!open}) : null;
  const light=sun?.light??(w.phase==='夜'?[.55,.62,.76]:w.phase==='暮'?[.88,.79,.70]:climate.storm?[.68,.76,.82]:[1,1,1]);
  const weather=[time,open?(climate.storm?2.7:climate.rain?1.15:.55):0,Number(open&&climate.drought),
    sun?.glow??(w.phase==='夜'?.96:w.phase==='暮'?.48:0)];
  const sunHint=$('campSunPhase');
  if (sun && sunHint.textContent!==sun.phase) sunHint.textContent=sun.phase;
  for(const person of people){
        const surface=stage.heightAt(person.x,person.z);
    const ground=extended?.height(person.x,person.z);
    person.y=person.poseY??(ground===undefined ? surface : inCamp(person.x,person.z)?Math.max(surface,ground):ground);
    person.sex=w.agents?.[person.who]?.sex;
    person.stage=w.agents?.[person.who]?.stage;
    if (S.soloSurv && person.who==='p1') person.tool=ui.tool;
    person.color=person.who==='p1'?'#AB5236':COLORS[person.who]??'#98BD51';
  }
  const player=people.find(p=>p.who==='p1');
  if (S.soloSurv && player && !overview && !campPose && !campCart?.attached) {
    residentHint=residentInReach(w,[player.x,player.z],people,room?ui.interior:null);
  }
  const shadows=exterior && !overview && player && sun?.direct && sun.phase!=='夜晚' ? {
    source:campShadows(exterior,regions??[]), x:player.x,z:player.z,
    height:extended?.height??( (x,z)=>stage.heightAt(x,z) ),
  } : undefined;
  const regionDetails=regions?.flatMap(region=>region.boxes?[region.boxes]:[])??[];
  const covered=coveredModels(camera,player,stage.boxes,life?.boxes??[],homes?.boxes??[],work,...regionDetails);
  if(!campRenderer.render({target:cv,stage,regions,regionAtlas:regions?.length?outskirtsAtlas():null,life,homes,terrain,camera,people,animals,work,hearth,covered,frame:ACT.frame,light,sun,visibility,sight,waterMask,season:open?climate.season:-1,weather,shadows,
    physical:physicalLighting,animateParts}))return false;
  const g=cv.getContext('2d'), ratio=campRatio(cv);
  cv._cam={mode:room?'interior':overview?'overview':'view',project3d:camera,stage,site:ui.interior,covered,
    exterior,extended,people,animals,work,visibility,sight,regionDetails};
  if (exterior && playerId==='cvA' && S.soloSurv) advanceOutdoorIntent(cv._cam,w,player);
  if (open && !overview) paintWeather(g,climate,time,ratio);
  if(overview)campMapFrame(g,camera,stage,ratio,extended?WILDS:undefined);
  // 贴地光圈：p1 黄、AI 绿抖动环；常驻，不穿屋顶。
  for(const p of people)campRing(g,camera,p,ratio,p.who==='p1'?'#FFEC27':'#C2C3C7',ACT.frame);
  if (residentHint) {
    const [nx,nz]=residentHint.to, npc=w.agents[residentHint.target];
    const ny=Math.max(stage.heightAt(nx,nz),extended?.height(nx,nz)??0)+(npc.stage==='child'?1.12:1.58);
    const heavy=HEAVY_CAMP_TOOLS.includes(ui.tool);
    const hint=ui.tool==='hand'?'F 交谈':heavy?'F 会击伤':'收起工具';
    campBadge(g,camera,[nx,ny,nz],`${npc.name} · ${hint}`,heavy?'build':'talk',16,ratio);
  }
  const smoke=[...(stage.chimneys??[]),...(homes?.chimneys??[])].filter(([x,y,z])=>
    !visibility || visibility.sees(x,z,y+.3));
  if (smoke.length) campSmoke(g,camera,smoke,ratio,ACT.frame,light);
  if(light[0]<.9)campAmbient(g,camera,span,x,z,ratio,ACT.frame);
  const h=campHover?.cv===cv.id?campHover:null;
  let hoverLabel;
  if (h) {
    const hit=pointedEntity(cv,h);
    const now=performance.now();
    if (h.entity!==hit?.id) { h.entity=hit?.id; h.since=now; }
    if (hit && now-Math.max(h.t,h.since??h.t)>=200) {
      hoverLabel=hit.name;
      const [px,pz]=hit.at;
      campBadge(g,camera,[px,hit.labelHeight??Math.max(stage.heightAt(px,pz),extended?.height(px,pz)??0)+1.15,pz],hit.name,'',16,ratio);
    }
  }
  cv._debug={pose:campPose?.kind,animals:animals.map(a=>[a.kind,a.x,a.z]),renderer:'3d',ratio,span,people:people.length,stageBoxes:stage.boxes.length,stageFxs:stage.fxs?.length??0,chimneys:stage.chimneys?.length??0,acts:people.map(q=>q.who+':'+q.act),climate,sun:sun?.phase,focus:[x,z],facing:player?.direction,hover:!!h,hoverLabel,wildRegions:regions?.length??0,unifiedGround:Boolean(extended && !terrain),p1:player?[player.x,player.y,player.z]:null};
  cv.dataset.renderer='3d';
  return true;
}

function campPoint(cv, ev) {
  const { project3d, stage, extended }=cv._cam??{};
  if(!project3d)return null;
  const rect=cv.getBoundingClientRect(), u=(ev.clientX-rect.left)/rect.width, v=(ev.clientY-rect.top)/rect.height;
  const base=project3d.ground(u,v), unit=project3d.ground(u,v,1);
  const dx=unit[0]-base[0], dz=unit[1]-base[1];
  let point=base, nearest=0;
  for(const f of stage.floors){
    const ax=f.ax??(f.axis==='x'?(f.end-f.y)/f.w:0), az=f.az??(f.axis==='z'?(f.end-f.y)/f.d:0);
    const denominator=1-ax*dx-az*dz;
    if(Math.abs(denominator)<1e-6)continue;
    const y=(f.y+ax*(base[0]-f.x)+az*(base[1]-f.z))/denominator;
    const x=base[0]+dx*y,z=base[1]+dz*y;
    if(y>nearest && floorContains(f,x,z)){
      nearest=y;point=[x,z];
    }
  }
  if (extended) {
    // First terrain intersection on the camera ray, including low ground outside the village.
    for (let y=42;y>=-30;y-=.5) {
      const x=base[0]+dx*y,z=base[1]+dz*y;
      if (y<=nearest && nearest>0) break;
      if (y<=extended.height(x,z)) return [x,z];
    }
  }
  return point;
}

function draw(cv, w) {
  cv._anim = ACT.frame;   // 渲染元数据：验收可核对 A/B 是否共用同一动画帧号
  if (campRenderer) {
    if (cv.id === 'cvB' && !ui.compare) return;
    try {
      if (drawCamp(cv,w)) return;
    } catch(error) { console.warn('3D 绘制失败，使用像素视图',error); }
    campRenderer=null;
    for(const walker of Object.values(WALK)){walker.path=[];walker.pi=0;walker.moving=false;}
    $('btnCampAngle').hidden=true;
  }
  cv.dataset.renderer='2d';
  // 全屏＝把"当前视角"原样放大（取景不变，只放开整数倍上限），不切换成别的视图。
  if (ui.interior) { cv._cam = { mode: 'interior', site: ui.interior }; return drawInterior(cv, w, ui.interior); }
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
  const rooms = Object.keys(pack.rooms ?? LOCS).filter(r=>campRenderer || !pack.districts?.[r]);
  el.innerHTML = rooms.map((r) => {
    const n = (pack.occupancy[r] ?? []).length;
    return `<button data-room="${esc(r)}" class="${(ui.interior ? ui.interior === r : r === ui.room) ? 'on' : ''}">${esc((pack.rooms ?? LOCS)[r] ?? r)}<span class="n">${n}</span></button>`;
  }).join('') + (pack.camp?.timber?'<button data-room="grove" type="button">伐木林</button>':'');
}
function fillOcc(el, pack) {
  const crowd = pack.occupancy[ui.room] ?? [];
  if (!crowd.length) { el.innerHTML = '<div class="empty">这处现在没人——点上面的地点把镜头移过去。</div>'; return; }
  el.innerHTML = crowd.map((who) => {
    const a = pack.agents[who];
    const sprite = ASSETS.chars[who];
    const portrait = ACT.portraits[who] ?? sprite?.frames?.[0];
    const img = portrait ? `<img src="${portrait.src}" alt="" />` : '';
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

// ── 生存单世界游玩面板（Phase D，独立于 A/B 对照）─────────────────────────────
let survFlash = null;
// 行为提示统一经 toast() 输出，2.6s 后清空；此前直接赋 textContent 会永久停留。
let toastTimer = null;
function toast(msg, ms = 2600) {
  const el = $('campToast'); if (!el) return;
  el.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.textContent = ''; }, ms);
}
const SURV_CODE_ZH = { OK: '成功', NO_MATURE: '没有成熟的菜畦', NO_EMPTY_PLOT: '没有空畦', NO_WATER: '水不够', NOT_GARDEN: '得在菜园', NOT_OUTDOOR: '得在户外', OCCUPIED: '当前地点已占用', NO_MATERIAL: '材料不够', NO_SITE: '当前地点没有工地', NO_LOT:'这里没有可施工的地块', NO_REPAIR: '当前地点没有损坏建筑', NO_LOC: '未知地点', UNKNOWN_KIND: '未知动作', EMPTY: '公仓空了', NOTHING_HERE: '这里没有可交互的对象', NEED_TOOL: '工具不对', NEED_TRAY: '需要木托盘（工坊/院子用 2 木制作）', ACTION_BUDGET: '本刻行动时间已用完，等下一拍', PLAYER_DEAD: '你已倒下', CAMP_ENDED: '这一局已经结束', NOT_TOGETHER: '对方不在这里', NO_RESIDENT: '这里没有可交谈的人', NO_TALK: '对话已经结束', EMPTY_TEXT: '说点什么', NO_RESOURCE: '这里的资源采空了，等它恢复', NOT_GATHER_LOC: '这里没有可采集的资源', REFUSED: '对方拒绝协助', COOP_OFF: '合作未开启', assist: '愿意协助', alternative: '有条件参与', refuse: '拒绝协助' };
// E 打开背包，F/Enter 使用场景中的对象。
const TOOL_ZH={hand:'空手',axe:'斧',pick:'镐',hoe:'锄',hammer:'锤',basket:'篮子',shears:'剪刀',bucket:'桶'};
const CAMP_ITEMS={meat:'肉',wood:'木料',stone:'石料',berry:'浆果',fruit:'水果',crop:'蔬菜',egg:'鸡蛋',wool:'羊毛',milk:'牛奶',water:'水',tray:'木托盘'};
const CAMP_FOOD=['meat','berry','fruit','crop','egg','milk'];
const campLabels={animal_feed:'投喂',animal_slaughter:'屠宰',road_lay:'铺路',road_remove:'移除小路',facility_use:'使用设施',home_fix:'修门',camp_chop:'伐木',camp_store:'放入',camp_take:'取出',camp_eat:'吃饭',camp_craft:'制作托盘',camp_collect:'采集',camp_plant:'播种',camp_water:'浇水',camp_sleep:'睡觉',coop_request:'请求协助'};
const campCodes={ANIMAL_WAIT:'让动物休息半天再喂。',ANIMAL_NEEDS_FOOD:'篮子需要浆果、水果或蔬菜。',ANIMAL_TRUSTED:'它已经信任你了。',ANIMAL_AFRAID:'动物受惊了，暂时无法收集产物。',ROAD_COOLDOWN:'小路刚改过，四天后才能再改。',ROAD_UNCHANGED:'小路已经处于这个状态。',HOME_LOCKED:'房门上锁，需要钥匙、授权或住户邀请。',NO_AUTHORITY:'只有住户或房主有权这样做。',NO_FACILITY:'设施尚未完工或已失效。',OUT_OF_REACH:'距离太远，请再靠近一点',NO_ANIMAL:'这只动物已不在这里',NO_PLANT:'这株植物已不在这里',RESIDENT_OUT_OF_REACH:'距离太远，请再靠近一点',RESIDENT_GONE:'对方已不在这里',NO_TREE:'这里没有可砍的树',TREE_GROWING:'树苗还在长',BAD_ITEM:'不能放入这种物品',NO_CONTAINER:'需走近容器',CONTAINER_FULL:'容器已满',NO_PRODUCE:'尚无可收集的产物',
  NO_MATURE:'作物尚未成熟',BUCKET_FULL:'背包已装三份水',WATER_FULL:'水分已满',NOT_HOME:'需要在居所内',SLEEP_BUSY:'正在睡觉',CAMP_ENDED:'这一局已结束',
  FORAGE_COOLDOWN:'稍后再采',NO_WILD_FOOD:'这里的野生浆果已采空',BAD_PLOT:'这里没有可用菜畦'};
let campBusy=false, campPose=null, campCart=null;

const GATHER_RES = { yard: 'wood', garden: 'wood', watch: 'stone', well: 'stone' };
// 上下文动作解析：当前地点能做什么＋需要哪把工具；优先匹配当前手持工具（持斧在菜园可砍木，不被播种优先挡住）
function contextAction(s, tool = ui.tool) {
  const here = s.loc?.p1;
  const b = s.buildingsDef || {};
  const bag = s.pinv?.p1 ?? { wood: 0, stone: 0 };
  const poolW = bag.wood + s.inv.wood, poolS = bag.stone + s.inv.stone;
  const cands = [];
  if ((s.buildings ?? []).some((x) => x.loc === here && x.integrity < 1) && poolW >= 1 && poolS >= 1) cands.push({ kind: 'repair', tool: 'hammer' });
  if ((s.sites ?? []).some((x) => x.loc === here)) cands.push({ kind: 'build', tool: 'hammer' });
  if (here === 'garden') {
    if (s.plots.some((p) => p.growth >= 1)) cands.push({ kind: 'harvest', tool: 'hoe' });
    if (s.plots.some((p) => p.growth === 0) && s.water >= 0.06) cands.push({ kind: 'plant', tool: 'hoe' });
  }
  // 采浆果：手（1）在户外、未冷却、产出账未满时可用；合法性最终由规则层 forageRule 裁决。
  if ((s.outdoor ?? []).includes(here) && (s.produce?.berry ?? 0) < (s.produceCap ?? 24) && (s.forageCd ?? 0) <= (s.t ?? 0) && (!s.wildBerries || s.wildBerries[here] >= 1))
    cands.push({ kind: 'forage', tool: 'hand' });
  const res = GATHER_RES[here];
  if (res && (s.outdoor ?? []).includes(here)) cands.push({ kind: 'gather', tool: res === 'wood' ? 'axe' : 'pick' });
  if ((s.outdoor ?? []).includes(here) && !(s.sites ?? []).some((x) => x.loc === here) && !(s.buildings ?? []).some((x) => x.loc === here)) {
    const t = Object.keys(b).find((k) => poolW >= b[k].cost.wood && poolS >= b[k].cost.stone);
    if (t) cands.push({ kind: 'plan', type: t, tool: 'hammer' });
  }
  return cands.find((c) => c.tool === tool) ?? cands[0] ?? null;
}
const ROOM_PROPS = {
  bed: ['床铺','居所的床铺。'],
  hearth: ['壁炉','这里可以查看营地的天气和粮食。'],
  furnace: ['熔炉','查看工坊物资和当前施工。'],
  table: ['餐桌','营地成员在这里用餐。'],
  shelf: ['储物架','查看背包和公仓。'],
  crate: ['物资箱','查看背包和公仓。'],
  barrel: ['木桶','查看背包和公仓。'],
  grain: ['储粮箱','与公共粮仓共用库存。'],
  workbench: ['工作台','查看工坊物资和当前施工。'],
  anvil: ['铁砧','查看工坊物资和当前维修。'],
  rug: ['地毯','铺在地板上的编织地毯。'],
  bench: ['长凳','连廊里的木制座椅。'],
  banner: ['营地旗帜','聚落的标记。'],
  planter: ['种植箱','查看菜园的生长情况。'],
  trellis: ['攀藤架','查看菜园的生长情况。'],
  well: ['水井','查看营地当前水量。'],
  bucket: ['水桶','查看营地当前水量。'],
  telescope: ['望远镜','查看天气和次日预报。'],
  fence: ['木栏','栏杆之间留有通道。'],
  cart: ['手推车','整理随身材料。'],
  pen: ['养殖围栏','查看存栏、兑换收成或用公仓材料扩建。'],
};
function rectGap(x,z,left,top,w,d) {
  return Math.hypot(Math.max(left-x,x-left-w,0),Math.max(top-z,z-top-d,0));
}
function atRoomDoor(site, walking=false) {
  const x=IPOS.x+8, z=IPOS.y+16;
  if (walking && site==='hall') return hallExitAt(hallFront,x,z,true);
  const [left,top,w,d]=roomDoor(site);
  if (walking) return x>=left && x<=left+w && z>=top+d-2;
  return rectGap(x,z,left,top,w,d)<=7;
}
function propDistance(prop) {
  return rectGap((IPOS.x+8)/TILE,(IPOS.y+16)/TILE,prop.x,prop.z,prop.w,prop.d);
}
const PROP_REACH=1.15;
function nearbyProp(site) {
  let best=null, distance=PROP_REACH;
  for (const prop of roomProps(site)) {
    if (prop.kind==='rug') continue;
    const gap=propDistance(prop);
    if (gap<=distance) { best=prop; distance=gap; }
  }
  return best;
}
let leavingRoom=false;
function closeRoom(redraw=true) {
  roomRoute=null;
  outdoorIntent=null;
  const leaving=ui.interior && S.soloSurv;
  if (leaving) {
    leavingRoom=true;
    void api('/act',{mode:'survival',kind:'camp_exit'}).catch(()=>{}).finally(()=>{
      leavingRoom=false;
      if (redraw) void refresh();
    });
  }
  $('campPropDialog').close();
  campPose=null;
  if (campCart) campCart.attached=false;
  ui.interior=null;
  keys.clear();
  ui.camRoom=null;
  ui.overview=false;
  IPOS.site=null;
  if (redraw && !leaving) void refresh();
}
function useRoom() {
  const site=ui.interior;
  if (campPose) { if (campPose.kind==='sit') campPose=null; return; }
  if (campCart?.attached) { campCart.attached=false; toast('已停放手推车'); return; }
  if (atRoomDoor(site)) { closeRoom(); return; }
  const prop=nearbyProp(site);
  if (prop) { inspectRoomProp(prop); return; }
  const side=hallSideAtFeet(site);
  if (side) enterRoom(side);
}
function hallSideAtFeet(site) {
  if (site!=='hall' || IPOS.y+16<99 || IPOS.y+16>133) return null;
  const x=IPOS.x+8;
  const side=x<=48?'home':x>=208?'store':null;
  return side && S.view?.rooms?.[side] ? side : null;
}

function inspectRoomProp(prop) {
  roomRoute=null;
  const [name,description]=ROOM_PROPS[prop.kind], s=S.view;
  const dialog=$('campPropDialog'), action=$('campPropAction'), options=$('campPropOptions');
  options.replaceChildren();
  $('campPropTitle').textContent=name;
  $('campPropText').textContent=description;
  action.hidden=true;
  action.onclick=null;
  let detail='';
  const bindAction=(label,fn)=>{
    action.textContent=label;
    action.hidden=false;
    action.onclick=()=>{ dialog.close(); fn(); };
  };
  if (prop.kind==='telescope') bindAction('通过望远镜观测营地',()=>{
    ui.surveyRoom=ui.interior;
    ui.interior=null;
    ui.overview=true;
    ui.camRoom=null;
    refresh();
  });
  if (S.soloSurv && !S.campReady) {
    detail='当前入口的服务版本较旧，家具存取、睡觉和采集工具需要新版生存。';
    if (['shelf','crate','barrel','cart'].includes(prop.kind)) bindAction('打开背包',openBackpack);
  }
  if (S.soloSurv && S.campReady) {
    const privateVisitor=residentialSite(ui.interior,s.peripheralHomes) && !(s.homeAccess?.[ui.interior]?.resident ?? (s.housing?.p1===ui.interior));
    const facility=facilityOf(s,ui.interior);
    if (facility) {
      const use=(type,tool)=>performCamp({kind:'facility_use',target:ui.interior,type,tool},ui.interior,()=>inspectRoomProp(prop));
      if (prop.kind==='grain') {
        $('campPropDetail').textContent=`公仓 ${s.store}/${s.storeCap} · 背包作物 ${s.pinv.p1.crop??0}`;
        propOption(options,'存入一份作物',!(s.pinv.p1.crop>=1)?'背包没有作物':s.store+1>s.storeCap?'公仓已满':'',()=>use('deposit'));
        propOption(options,'领取一份粮食',s.store<1?'公仓没有整份粮食':'',()=>use('withdraw'));
      } else if (facility.type==='shelter') {
        $('campPropDetail').textContent='在避难住所休息可恢复精力。';
        bindAction('休息',()=>use('rest'));
      } else {
        $('campPropDetail').textContent='木料 ×2，制作一个木托盘。';
        propOption(options,'用锤制作木托盘',(s.pinv.p1.wood??0)<2?'背包木料不足':'',()=>{
          ui.tool='hammer'; return use('craft','hammer');
        });
      }
      $('campPropDetail').hidden=false;
      keys.clear();
      if (!dialog.open) dialog.showModal();
      return;
    }
    const stock=`公仓木料 ${s.inv.wood} · 石料 ${s.inv.stone}`;
    const food=`粮食 ${s.store}/${s.storeCap}`;
    const weather=[s.phase,s.weather,s.forecast && `明日 ${s.forecast}`].filter(Boolean).join(' · ');
    const bindTool=ctx=>bindAction(
      ui.tool===ctx.tool ? ACT_ZH[ctx.kind] : `换${TOOL_ZH[ctx.tool]}并${ACT_ZH[ctx.kind]}`,()=>{
        ui.tool=ctx.tool;
        runSurvAction(ctx);
      });
    switch (prop.kind) {
      case 'shelf': case 'crate': case 'barrel': case 'cart': {
        const target=ui.interior+':'+prop.id.split(':').at(-1);
        detail=privateVisitor?'私人储物架。':showContainer(s,options,target,prop);
        if (prop.kind==='cart' && campRenderer) bindAction('推手推车',()=>startCart(prop));
        else bindAction('打开背包',openBackpack);
        break;
      }
      case 'workbench': case 'furnace': case 'anvil': {
        detail=stock;
        const ctx=s.loc?.p1===ui.interior ? contextAction(s,'hammer') : null;
        if (ctx?.tool==='hammer') bindTool(ctx);
        if (prop.kind==='workbench')
          propOption(options,'制作木托盘（木料 ×2）',(s.pinv?.p1?.wood??0)<2?'背包木料不足':'',
            ()=>performCamp({kind:'camp_craft',type:'tray'},ui.interior,()=>inspectRoomProp(prop)));
        break;
      }
      case 'planter': case 'trellis': {
        detail=s.plots.map((p,i)=>`第 ${i+1} 畦 ${p.growth>=1?'成熟':p.growth===0?'空畦':Math.round(p.growth*100)+'%'}`).join(' · ');
        const ctx=ui.interior==='garden' && s.loc?.p1==='garden' ? contextAction(s,'hoe') : null;
        if (ctx?.tool==='hoe') bindTool(ctx);
        break;
      }
      case 'well': case 'bucket':
        detail=`营地水量 ${s.water} · 背包水 ${s.pinv?.p1?.water??0}/3`;
        if (ui.interior==='well') bindAction('用桶取水',()=>collectCamp('water','well'));
        break;
      case 'bed':
        detail=weather;
        if (!privateVisitor) bindAction('躺下睡觉',()=>sleepInBed(prop));
        break;
      case 'bench':
        bindAction('坐下',()=>{ campPose={kind:'sit',prop}; });
        break;
      case 'telescope': detail=weather; break;
      case 'banner': {
        if (ui.interior==='hall' && s.social?.discussions) {
          const names=Object.fromEntries(s.social.people.map(person=>[person.id,person.name]));
          const d=s.social.discussions, meeting=d.active??d.history?.at(-1);
          const topics={famine:'缺粮',storm:'风暴',cold:'寒潮',build:'施工',farm:'开垦',housing:'住房'};
          detail=meeting ? `第 ${meeting.t} 刻 · ${names[meeting.by]??meeting.by} · ${topics[meeting.topic]} · ${({agreed:'达成共识',split:'意见分歧',no_quorum:'未能成会'})[meeting.result]??'讨论中'}` : '目前没有集体讨论记录。';
          const task=s.coop?.task;
          if (task) detail+=` · 协作：${BUILDING_NAMES[task.type]}，地点 ${s.rooms[task.loc]??task.loc}，${task.workers.length} 人。`;
          for (const [id,advice] of Object.entries(meeting?.advice??{})) propOption(options,`${names[id]??id} · ${advice}`,'讨论记录',null);
        }
        break;
      }
      case 'hearth': detail=[food,weather].filter(Boolean).join(' · '); break;
      case 'table':
        detail=privateVisitor?'住户的餐桌。':showContainer(s,options,`${ui.interior}:meal`,prop,true);
        break;
      case 'pen': {
        const counts=s.livestock;
        detail=`鸡 ${counts.chickens} · 牛 ${counts.cows} · 羊 ${counts.sheep} · 公仓木 ${s.inv.wood} / 石 ${s.inv.stone}`;
        if (s.ecoSources) detail+='。到室外靠近动物，用对应工具收集。';
        for (const type of ['chickens','cows','sheep']) {
          const cost=s.economy.expand[type];
          propOption(options,`扩建${s.economy.expandLabel[type]}（木 ${cost.wood} · 石 ${cost.stone}）`,
            counts[type]>=s.economy.cap?'已达上限':s.inv.wood<cost.wood+4 || s.inv.stone<cost.stone+3?'公仓材料不足':'',
            ()=>{ dialog.close(); runSurvAction({kind:'expand',type}); });
        }
        for (const type of ['egg','milk','wool']) {
          if (!s.ecoSources) propOption(options,`用${TOOL_ZH[CAMP_TOOL[type]]}收集${CAMP_ITEMS[type]}`,
            s.produce[type]<1?'尚无产物':'',()=>collectCamp(type,'yard',()=>inspectRoomProp(prop)));
          const label=s.economy.produceLabel[type];
          propOption(options,`兑换${label}（存有 ${s.produce[type]}）`,s.produce[type]<1?'缺收成':'',
            ()=>{ dialog.close(); runSurvAction({kind:'exchange',type}); });
        }
        break;
      }
      default: break;
    }
  }
  $('campPropDetail').textContent=detail;
  $('campPropDetail').hidden=!detail;
  keys.clear();
  if (!dialog.open) dialog.showModal();
}

async function performCamp(body,site,done) {
  if (campBusy || !S.campReady) return null;
  campBusy=true;
  try {
    if (site && !body.from && S.view?.loc?.p1!==site && S.view?.campPlayerRoom!==site) {
      const moved=await api('/act',{mode:'survival',kind:'move',room:site});
      if (!moved.ok) return moved;
      const walker=WALK[walkKey('cvA','p1')];
      if (walker) walker.holdDoor=site;
    }
    const result=await api('/act',{mode:'survival',...body});
    survFlash={kind:body.kind,ok:result.ok,code:result.code??result.error??'OK'};
    await refresh();
    if (done && $('campPropDialog').open) done();
    const msg=result.ok ? (body.kind==='camp_sleep'?`睡过了 ${result.ticks} 刻`:`${campLabels[body.kind]??ACT_ZH[body.kind]??'操作'}成功`)
      : campCodes[result.code]??SURV_CODE_ZH[result.code]??'动作未完成';
    toast(msg);
    return result;
  } catch {
    toast('操作未完成，请重试。');
    return null;
  } finally { campBusy=false; }
}
function collectCamp(item,site,done,plot) {
  const tool=CAMP_TOOL[item];
  ui.tool=tool;
  updateHotbar();
  return performCamp({kind:'camp_collect',type:item,tool,plot},site,done);
}
function showContainer(s,options,target,prop,meal=false) {
  const stored=s.camp?.containers?.[target]??{}, bag=s.pinv?.p1??{};
  const items=meal?[...CAMP_FOOD,'tray']:Object.keys(CAMP_ITEMS);
  const count=Object.values(stored).reduce((a,b)=>a+b,0), capacity=meal?6:24;
  const rerender=()=>inspectRoomProp(prop);
  for (const item of items) {
    const own=bag[item]??0, here=stored[item]??0;
    if (own>0) propOption(options,`放入 ${CAMP_ITEMS[item]} · 背包 ${own}`,count>=capacity?'已满':'',
      ()=>performCamp({kind:'camp_store',type:item,target},ui.interior,rerender));
    if (here>0) propOption(options,`取回 ${CAMP_ITEMS[item]} · ${here}`,'',
      ()=>performCamp({kind:'camp_take',type:item,target},ui.interior,rerender));
    if (meal && CAMP_FOOD.includes(item) && here>0) propOption(options,`吃一份${CAMP_ITEMS[item]}`,'',()=>{
      $('campPropDialog').close();
      campPose={kind:'eat',prop};
      setTimeout(()=>{ if (campPose?.kind==='eat') campPose=null; },850);
      performCamp({kind:'camp_eat',type:item},ui.interior);
    });
  }
  return `${meal?'桌上食物':'容器'} ${count}/${capacity} · 每次移动一份`;
}
async function sleepInBed(prop) {
  if (campBusy || campPose?.kind==='sleep') return;
  campPose={kind:'sleep',prop};
  toast('正在睡觉…');
  keys.clear();
  await new Promise(resolve=>setTimeout(resolve,720));
  try { await performCamp({kind:'camp_sleep'},ui.interior); }
  finally { campPose=null; }
}
function inspectPlot(bed) {
  const plot=S.view.plots.find(p=>p.id===bed.id), d=$('campPropDialog');
  if (!plot) return;
  const from=()=>{
    const walker=WALK[walkKey('cvA','p1')];
    return walker && [walker.x+.5,walker.y+.5];
  };
  const action=$('campPropAction'), options=$('campPropOptions');
  options.replaceChildren();
  action.hidden=true;
  action.onclick=null;
  $('campPropTitle').textContent=`第 ${bed.id+1} 畦`;
  const crop=plot.growth>=1?'作物成熟':plot.growth>0?`生长 ${Math.round(plot.growth*100)}%`:'空畦';
  $('campPropText').textContent=crop+(plot.moisture>0?' · 已浇水':'');
  $('campPropDetail').hidden=true;
  if (plot.growth===0) propOption(options,'用锄播种','',()=>{
    ui.tool='hoe';
    performCamp({kind:'camp_plant',tool:'hoe',plot:plot.id,from:from()},'garden',()=>inspectPlot(bed));
  });
  if (plot.growth>=1) propOption(options,'用篮子收菜','',()=>performCamp({kind:'camp_collect',type:'crop',tool:'basket',plot:plot.id,from:from()},'garden',()=>inspectPlot(bed)));
  if (S.view.pinv?.p1?.water) propOption(options,'用桶浇水',(S.view.farmLife ? plot.moisture : S.view.water)>=1?'水分已满':'',()=>{
    ui.tool='bucket';
    performCamp({kind:'camp_water',tool:'bucket',plot:plot.id,from:from()},'garden',()=>inspectPlot(bed));
  });
  keys.clear();
  if (!d.open) d.showModal();
}

function propOption(container,label,reason,onClick) {
  const button=document.createElement('button');
  button.type='button';
  button.textContent=reason?`${label} · ${reason}`:label;
  button.disabled=Boolean(reason);
  button.onclick=onClick;
  container.append(button);
}
function entranceAt(world,x,z) {
  return Object.entries({...world.scene3d?.entrances,...world.homes3d?.entrances}).find(([,e])=>
    x>=e.x && x<=e.x+e.w && z>=e.z && z<=e.z+e.d)?.[0]??null;
}
function survRoomAtFeet() {
  const world = buildWorld(S.view ?? {});
  const walker = WALK[walkKey('cvA', 'p1')];
  if (!walker) return null;
  if (world.scene3d) return entranceAt(world,walker.x+.5,walker.y+.5);
  return Object.entries(world.sites).find(([, [x,z]])=>Math.hypot(x-walker.x,z-walker.y)<=1.45)?.[0]??null;
}
function atPen(world,walker) {
  const p=penLayout(world.sites);
  if (!p || !walker) return false;
  const x=walker.x+.5, z=walker.y+.5;
  return rectGap(x,z,p.x+p.gate-.55,p.z+p.d-.95,p.opening+1.1,1.9)<=.65;
}
function localSurvSite(world,walker) {
  if (!walker) return null;
  const x=walker.x+.5, z=walker.y+.5;
  if (world.beds.some(b=>insideBed(x*TILE,z*TILE,b,10))) return 'garden';
  let nearest=null, distance=3.35;
  for (const [site,[sx,sz]] of Object.entries(world.sites)) {
    const d=Math.hypot(x-sx-.5,z-sz-.5);
    if (d<distance) { nearest=site; distance=d; }
  }
  return nearest;
}
function residentInReach(s, player, crowd, room) {
  if (!s?.agents || !player) return null;
  let best=null;
  for (const person of crowd) {
    const {who,x,z}=person, npc=s.agents[who];
    if (!npc || npc.isPlayer || npc.dead || npc.viab<=0 || !nearResident(player,[x,z])) continue;
    const distance=Math.hypot(player[0]-x,player[1]-z);
    if (!best || distance<best.distance) best={target:who,room,from:player,to:[x,z],distance};
  }
  return best;
}

async function useResident(person) {
  const {target}=person;
  // P0 对话：空手按 F = 打开对话；重工具仍保留"会击伤"的代价交互。
  if (ui.tool==='hand') { await openTalkWith(target,person); return; }
  const {room,from,to}=person, tool=ui.tool;
  campBusy=true;
  try {
    const result=await api('/act',{mode:'survival',kind:'camp_resident',target,room,from,to,tool});
    toast(result.code==='RESIDENT_TALKED' ? `${result.name}：「${result.line}」` :
      result.code==='RESIDENT_HURT' ? `${result.name}被${TOOL_ZH[tool]}击中，损失 ${Math.round(result.damage*100)}% 存续值。` :
      result.code==='RESIDENT_NEED_HAND' ? '收起工具后再交谈。' :
      result.code==='RESIDENT_COOLDOWN' ? '对方还没缓过来。' : '请再靠近一点。');
    if (result.code==='RESIDENT_HURT') await refresh();
  } catch {
    toast('互动未完成，请重试。');
  } finally { campBusy=false; }
}

function addTalk(who,text){
  const box=$('talkLog'); if(!box)return;
  const row=document.createElement('div');
  row.className=who; row.textContent=text;
  box.appendChild(row); box.scrollTop=box.scrollHeight;
}
async function openTalkWith(target,contact){
  if(!target||campBusy)return;
  campBusy=true;
  try{
    const r=await api('/act',{mode:'survival',kind:'talk_open',target,...contact});
    if(!r.ok){ toast(r.why ?? campCodes[r.code] ?? (r.code==='NOT_TOGETHER'?'对方不在这里。':r.code==='CAMP_ENDED'?'这一局已经结束。':'现在没法交谈。')); return; }
    ui.talk={target,name:r.name,contact};
    renderTalkAccess();
    $('talkTitle').textContent=`和 ${r.name} 交谈`;
    $('talkLog').innerHTML='';
    addTalk('npc',r.line);
    const dlg=$('talkDlg'); if(!dlg.open) dlg.showModal();
    $('talkText').value=''; $('talkText').focus(); $('talkSend').disabled=false;
  }catch{ toast('交谈失败，请重试。'); }
  finally{ campBusy=false; }
}
function renderTalkAccess() {
  const target=ui.talk?.target;
  if (!target) return;
  const access=$('talkAccess');
  access.replaceChildren();
  const room=S.view.housing?.[target];
  if (room && S.view.homeAccess?.[room]?.entry===false) {
    propOption(access,'请求到对方家做客','',async()=>{
      if (!ui.talk) return;
      const result=await api('/act',{mode:'survival',kind:'home_request',target,...currentTalkContact(ui.talk),home:room});
      addTalk('sys',result.ok?'住户邀请你在一天内到访。':'住户暂时没有发出邀请。');
      if (result.ok) { await refresh(); renderTalkAccess(); }
    });
  }
  for (const [room,h] of Object.entries(S.view.homeAccess??{})) {
    if (!h.resident) continue;
    for (const [type,label] of [['invite','邀请一天'],['key','交钥匙'],['permission','授权访问']]) {
      if (type!=='invite' && h.owner!=='p1') continue;
      const revoke=h.grants.some(g=>g.to===target && g.type===type && (g.by==='p1'||h.owner==='p1'));
      propOption(access,`${S.view.rooms[room]} · ${revoke?'撤回 '+label:label}`,'',async()=>{
        if (!ui.talk) return;
        const result=await api('/act',{mode:'survival',kind:revoke?'home_revoke':'home_grant',room,target,type});
        addTalk('sys',result.ok?'已更新住宅访问权限。':'无法更新访问权限。');
        if (result.ok) { await refresh(); renderTalkAccess(); }
      });
    }
  }
}
function currentTalkContact(t) {
  if (!t.contact) return {};
  const room=ui.interior;
  const player=WALK[walkKey('cvA','p1')], npc=WALK[walkKey('cvA',t.target)];
  if (!room) return {room:null,from:player?[player.x+.5,player.y+.5]:null,to:npc?[npc.x+.5,npc.y+.5]:null};
  const person=roomCrowd(S.view,room).find(p=>p.who===t.target);
  return {room,from:[(IPOS.x+8)/TILE,(IPOS.y+16)/TILE],to:person?[person.x,person.z]:null};
}
async function sendTalk(){
  const t=ui.talk, input=$('talkText'); if(!t||!input)return;
  const text=input.value.trim(); if(!text)return;
  addTalk('me','你：'+text); input.value=''; $('talkSend').disabled=true;
  try{
    const r=await api('/act',{mode:'survival',kind:'talk_say',target:t.target,text,...currentTalkContact(t)});
    if(r.ok){
      addTalk(r.ignored?'sys':'npc', r.line);
      if(r.attacked) toast('你被打了，存续值下降。');
      if(r.left) setTimeout(closeTalkDlg,1200);
      refresh();
    } else { addTalk('sys', r.code==='NO_TALK'?'（对话已经结束。）':'（没有回应。）'); if(r.code==='NO_TALK') setTimeout(closeTalkDlg,800); }
  }catch{ addTalk('sys','（对方没有回应。）'); }
  finally{ $('talkSend').disabled=false; if($('talkDlg').open)input.focus(); }
}
function closeTalkDlg(){
  const t=ui.talk; ui.talk=null;
  const d=$('talkDlg'); if(d?.open)d.close();
  if(t)api('/act',{mode:'survival',kind:'talk_close'}).catch(()=>{});
}

async function survInteract() {
  if (campBusy || !S.soloSurv) return;
  if (ui.surveyRoom) { returnFromSurvey(); return; }
  const s=S.view;
  if (ui.interior) {
    if (!campPose && !campCart?.attached && s?.loc?.p1===ui.interior) {
      const person=residentInReach(s,[(IPOS.x+8)/TILE,(IPOS.y+16)/TILE],roomCrowd(s,ui.interior),ui.interior);
      if (person) { await useResident(person); return; }
    }
    useRoom(); return;
  }
  if (!s?.loc) return;
  const world=buildWorld(s), walker=WALK[walkKey('cvA','p1')];
  const view=$(ui.fullscreen?'cvFull':'cvA')._cam;
  if (campRenderer && (ui.overview || !view?.exterior || !view.visibility)) return;
  const active=view?.exterior??world;
  if (walker) {
    const x=walker.x+.5,z=walker.y+.5;
    const entities=outdoorEntities(active,s,view?.people??[],view?.animals??[]);
    const reachable=entities.filter(e=>e.kind!=='scenery' && entityGap([x,z],e)<=e.reach);
    const visible=reachable.filter(e=>outdoorSight(view,e,[x,z]));
    const entity=visible
      .sort((a,b)=>{
        const equipped=e=>e.tool===ui.tool || e.kind==='animal' && ui.tool==='axe' ||
          e.kind==='door' && ui.tool==='hoe' && s.homeAccess?.[e.room]?.resident;
        return Number(equipped(b))-Number(equipped(a)) || entityGap([x,z],a)-entityGap([x,z],b);
      })[0];
    if (entity) { await useOutdoorEntity(entity,[x,z]); return; }
    if (reachable.length) {
      toast('视线被挡住了，请换个位置。');
      return;
    }
    if (atPen(world,walker)) { inspectRoomProp({kind:'pen'}); return; }
    if (!inCamp(x,z)) toast('靠近木石采集点，或持锤靠近可施工地块。');
  }
  if (campRenderer && walker && !inCamp(walker.x+.5,walker.y+.5)) return;
  if (!campRenderer) {
    const door=survRoomAtFeet();
    if (door) { enterRoom(door); return; }
  }
  const here=localSurvSite(world,walker);
  if (world.timber && ui.tool==='axe') {
    toast('到伐木林靠近成熟的树，再按 F。');
    return;
  }
  const ctx=here && contextAction({...s,loc:{...s.loc,p1:here}});
  if (ctx && campRenderer) {
    // In 3D, construction and crop work have actual targets. Only abstract
    // village gathering actions may use the location fallback.
    if (!['gather','forage'].includes(ctx.kind)) return;
    const [x,z]=world.sites[here];
    if (!view.visibility.sees(x+.5,z+.5)) {
      toast('视线被挡住了，请换个位置。');
      return;
    }
  }
  if (ctx) {
    if (ctx.tool===ui.tool && s.loc.p1!==here && !(await api('/act',{mode:'survival',kind:'move',room:here})).ok) return;
    runSurvAction(ctx);
  } else { survFlash={kind:'interact',ok:false,code:'NOTHING_HERE'}; refresh(); }
}
let enteringRoom=false;
async function enterRoom(room,force=false) {
  if (enteringRoom || leavingRoom) return;
  enteringRoom=true;
  try {
    if (S.soloSurv || S.view?.loc?.p1!==room) {
      const walker=WALK[walkKey('cvA','p1')];
      const body=S.soloSurv?{mode:'survival',kind:'move',room,entrance:Boolean(campRenderer)||Boolean(S.view?.settlementLife && residentialSite(room,S.view.peripheralHomes)),
        from:walker?[walker.x+.5,walker.y+.5]:null}:{kind:'move',room};
      let result=await api('/act',body);
      if (S.soloSurv && ui.tool==='hammer' && result.code==='HOME_LOCKED') {
        if (!force) {
          const dialog=$('campPropDialog'), action=$('campPropAction');
          $('campPropTitle').textContent='上锁的房门';
          $('campPropText').textContent='用锤破门会损坏房门、消耗行动时间并降低住户的信任。';
          $('campPropDetail').hidden=true;
          $('campPropOptions').replaceChildren();
          action.hidden=false; action.textContent='用锤破门';
          action.onclick=()=>{dialog.close(); void enterRoom(room,true);};
          keys.clear();
          if (!dialog.open) dialog.showModal();
          return;
        }
        const broken=await api('/act',{...body,kind:'home_break',tool:ui.tool});
        if (broken.ok) {
          result=await api('/act',body);
          toast('门已损坏，住户对你的信任下降。');
        } else result=broken;
      }
      if (!result.ok) { toast(campCodes[result.code]??SURV_CODE_ZH[result.code]??'无法进入'); return; }
    }
    const walker=WALK[walkKey('cvA','p1')];
    if (walker) {
      walker.path=[]; walker.pi=0; walker.moving=false;
      // 进入后服务器地点会更新。保留门外实际站位，避免退出时被旧路径拖走。
      if (S.view?.loc?.p1!==(facilityOf(S.view??{},room)?.loc??room)) walker.holdDoor=room;
    }
    keys.clear();
    ui.overview=false;
    ui.interior=room;
    ui.room=room;
    ui.camRoom=null;
    IPOS.site=null;
    refresh();
  } finally { enteringRoom=false; }
}
function returnFromSurvey() {
  ui.interior=ui.surveyRoom;
  ui.surveyRoom=null;
  ui.overview=false;
  ui.camRoom=null;
  refresh();
}
function runSurvAction(ctx) {
  if (ctx.tool && ui.tool !== ctx.tool) { survFlash = { kind: ctx.kind, ok: false, code: 'NEED_TOOL', tool: ctx.tool }; refresh(); return; }
  api('/act', { mode: 'survival', kind: ctx.kind, type: ctx.type }).then((r) => { survFlash = { kind: ctx.kind, ok: !!r.ok, code: r.code ?? r.error ?? 'OK' }; refresh(); });
}
const ACT_ZH = { discuss_open:'发起讨论',discuss_join:'参加讨论',discuss_share:'交换意见',discuss_decline:'谢绝讨论',discuss_leave:'离开讨论', gather: '采集', harvest: '收获', plant: '播种', build: '施工', repair: '维修', plan: '奠基', forage: '采野果', exchange: '兑换', expand: '扩建', move_to: '移动', walk: '走路', rest: '休息', idle: '待机', talk: '交谈', eat: '进食', look_out: '瞭望', work: '做工', coop_request: '请求协助', death: '死亡', birth: '出生', adult: '成年', elder: '老年' };
const STAGE_ZH = { infant: '婴幼儿', child: '儿童', adult: '成年', elder: '老年' };
function updateHotbar() {
  ui.tool ??= 'hand';
  const s = S.view;
  const ctx = S.soloSurv && s?.loc ? contextAction(s) : null;
  for (const el of document.querySelectorAll('#hotbar .slot[data-tool]')) {
    const t=el.dataset.tool;
    if (!el.querySelector('img')) {
      const img=document.createElement('img');
      img.src=itemIcon(t);
      img.alt='';
      img.width=32;img.height=32;
      el.setAttribute('aria-label',TOOL_ZH[t]);
      for (const node of el.childNodes) if (node.nodeType===Node.TEXT_NODE) node.textContent='';
      el.prepend(img);
    }
    const c=S.soloSurv && s?.loc ? contextAction(s,t) : null;
    el.disabled=!S.campReady && ['basket','shears','bucket'].includes(t);
    const can = !!c && c.tool === t;
    el.classList.toggle('on', ui.tool === t);
    el.setAttribute('aria-pressed', String(ui.tool === t));
    el.classList.toggle('can', can);
    el.classList.toggle('dim', !!s?.loc && !can && !['hand','basket','shears','bucket'].includes(t));
    // 工具栏不再出现任何红色角标（含「走位」「需X」）：可用性由 .can 的绿色边框表达，
    // 同一行重复 5 次的红标既抢眼又与 64 色板冲突。data-need 仅保留给背包/面板按钮。
    delete el.dataset.need;
  }
  for (const [id,model] of [['btnBag','backpack'],['btnUse','pointer']]) {
    const button=$(id);
    if (button.querySelector('img')) continue;
    const img=document.createElement('img');
    img.src=itemIcon(model); img.alt=''; img.width=32;img.height=32;
    for (const node of button.childNodes) if (node.nodeType===Node.TEXT_NODE) node.textContent='';
    button.prepend(img);
  }
  const hint = $('toolHint');
  // 工具栏右侧只显示当前手持工具名；具体可做什么交给 F 提示，不再重复整段键位说明。
  if (hint) hint.textContent = `手持 · ${TOOL_ZH[ui.tool] ?? '空手'}`
    + (ctx ? `　F ${ACT_ZH[ctx.kind]}（需${TOOL_ZH[ctx.tool]}）` : '');
}
function openBackpack() { roomRoute=null; keys.clear(); renderBackpack(); const d = $('backpack'); if (!d.open) d.showModal(); }
function closeBackpack() { const d = $('backpack'); if (d.open) d.close(); }
function renderItemBar(view) {
  const el = $('itemBar'); if (!el || !view) return;
  const bag = view.pinv?.p1 ?? {};
  el.innerHTML = Object.entries(CAMP_ITEMS).map(([item,label])=>{
    const n = bag[item] ?? 0;
    return `<div class="cell${n?'':' empty'}" title="${label}"><img width="32" height="32" alt="" src="${itemIcon(item)}"><b>${n}</b></div>`;
  }).join('');
}
function renderBackpack() {
  const s=S.survivalView, el=$('bpBody');
  if (!s) { el.textContent='当前入口没有加载生存世界。请打开新版生存入口。'; return; }
  const bag = s.pinv?.p1 ?? { wood: 0, stone: 0 };
  const atStore=S.soloSurv && ui.interior==='store' && s.loc?.p1==='store';
  const row = (label, mine, shared, res) => `
    <div class="bp-line"><b>${label}</b><span>个人 <span class="n">${mine}</span></span><span>公仓 <span class="n">${shared}</span></span>
      <button data-bp="deposit:${res}"${!atStore || mine <= 0 ? ` disabled data-need="${!atStore ? '在公仓' : '无货'}"` : ''}>存入公仓</button>
      <button data-bp="withdraw:${res}"${!atStore || shared <= 0 ? ` disabled data-need="${!atStore ? '在公仓' : '无货'}"` : ''}>取出</button></div>`;
  const slots=Object.entries(CAMP_ITEMS).map(([item,label])=>{
    const n=bag[item]??0;
    return `<div class="bp-item${n?'':' zero'}" title="${label}"><img width="36" height="36" alt="" src="${itemIcon(item)}"><b>${n}</b></div>`;
  }).join('');
  el.innerHTML=`<div class="bp-grid">${slots}</div>` + row('木料', bag.wood, s.inv.wood, 'wood') + row('石料', bag.stone, s.inv.stone, 'stone') +
    `<div class="bp-line"><b>粮食</b><span>公仓 <span class="n">${s.store}/${s.storeCap}</span></span><span>每日按人口分配</span></div>` +
    (atStore ? '' : '<div class="bp-note">进入公仓才能存取。</div>');
}
$('hotbar').addEventListener('click', (e) => {
  const slot = e.target.closest('.slot[data-tool]');
  if (slot && !slot.disabled) { ui.tool=slot.dataset.tool; updateHotbar(); return; }
  if (e.target.closest('#btnBag')) openBackpack();
  if (e.target.closest('#btnUse')) survInteract();
});
$('bpClose').onclick=closeBackpack;
$('btnBagTop').onclick=openBackpack;
$('btnBagFull').onclick=openBackpack;
$('talkSend').onclick=sendTalk;
$('talkClose').onclick=closeTalkDlg;
$('talkText').addEventListener('keydown',(e)=>{ if(e.key==='Enter'){ e.preventDefault(); sendTalk(); } });
$('talkDlg').addEventListener('cancel',(e)=>{ e.preventDefault(); closeTalkDlg(); });
$('backpack').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-bp]'); if (!b || b.disabled) return;
  const [kind, type] = b.dataset.bp.split(':');
  api('/act', { mode: 'survival', kind, type }).then((r) => { survFlash = { kind, ok: !!r.ok, code: r.code ?? 'OK' }; renderBackpack(); refresh(); });
});
// 点过按钮后把焦点还给 body，否则 WASD/E/F 会被按钮焦点吞掉（"交互全失效"的根因之一）
document.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b && !b.closest('dialog')) b.blur(); });
// 顶栏仪表化：像素方块条＋色板内 SVG 图标（粮/水/土/木/石），数值仍保留小字供精确读
const GICON = {
  grain: '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M3 3h6l1 2v5H2V5z" fill="#FFA300"/><path d="M4 1h4v2H4z" fill="#AB5236"/><path d="M4 6h4v1H4z" fill="#FFEC27"/></svg>',
  water: '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M6 1l3 5v3a3 3 0 0 1-6 0V6z" fill="#29ADFF"/><path d="M4 8h2v1H4z" fill="#FFF1E8"/></svg>',
  soil: '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M1 8h10v3H1z" fill="#AB5236"/><path d="M5 8V5h2v3z" fill="#008751"/><path d="M3 4h2v2H3zM7 3h2v2H7z" fill="#008751"/></svg>',
  wood: '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><rect x="1" y="4" width="10" height="4" fill="#AB5236"/><circle cx="10" cy="6" r="2" fill="#FFCCAA"/><circle cx="10" cy="6" r="1" fill="#AB5236"/></svg>',
  stone: '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M2 9l2-5h4l2 5z" fill="#83769C"/><path d="M4 4h4v1H4z" fill="#C2C3C7"/></svg>',
};
function gauge(icon, label, frac, text) {
  const cells = Array.from({ length: 10 }, (_, i) => `<b class="${(i + 0.5) / 10 <= Math.max(0, Math.min(1, frac)) ? 'on' : ''}"></b>`).join('');
  return `<span class="gauge" title="${label} ${text}">${icon}<span class="gbar">${cells}</span><i>${text}</i></span>`;
}
function renderGauges(s) {
  const el = $('hudGauges'); if (!el || !s) return;
  el.innerHTML =
    gauge(GICON.grain, '粮', s.store / s.storeCap, `${s.store}/${s.storeCap}`) +
    gauge(GICON.water, '水', s.water, s.water.toFixed(2)) +
    gauge(GICON.soil, '土', s.soil, s.soil.toFixed(2)) +
    gauge(GICON.wood, '木', s.inv.wood / 12, `${s.inv.wood}`) +
    gauge(GICON.stone, '石', s.inv.stone / 12, `${s.inv.stone}`);
}
// 聚落一览：居民饱食（能量方块条）＋去向＋当前动作，填右栏控制下方空白
function renderVillage(s) {
  const el = $('villagePanel'); if (!el || !s) return;
  const rows = Object.values(s.agents ?? {}).filter((a) => !a.isPlayer).map((a) => {
    if (a.dead) return `<div class="vrow dead"><b>${esc(a.name)}</b><span class="bad">已故</span><span class="dim">${esc(a.death?.cause ?? '')} · 第${(a.death?.day ?? 0) + 1}天</span></div>`;
    const cells = Array.from({ length: 5 }, (_, i) => `<b class="${(i + 0.5) / 5 <= (a.energy ?? 0) ? 'on' : ''}"></b>`).join('');
    const stage = a.stage && a.stage !== 'adult' ? `<span class="dim">${STAGE_ZH[a.stage] ?? a.stage}</span>` : (a.age != null ? `<span class="dim">${a.age}天</span>` : '');
    return `<div class="vrow"><b>${esc(a.name)}</b>${stage}<span class="vbar" title="饱食 ${a.energy ?? 0}">${cells}</span><span>${esc((s.rooms ?? {})[a.loc] ?? a.loc ?? '?')}</span><span class="dim">${esc(ACT_ZH[a.act] ?? a.act ?? 'idle')}</span></div>`;
  }).join('');
  el.innerHTML = rows || '<div class="dim">无居民</div>';
}
const FAMILY_RESULT = {
  OK:'已登记', ADULT_REQUIRED:'需成年后办理', MEET_REQUIRED:'请和对方见面',
  MARRIAGE_UNAVAILABLE:'目前不能结婚', OFFER_DECLINED:'对方没有同意',
  NO_BED:'对方没有可用床位', HOME_OCCUPIED:'只有空置的自有房屋可以出售',
  NO_OFFER:'邀请已失效', NO_FAMILY:'找不到这位子女',
  FAMILY_ENDED:'本局已经结束',
};

function familyPanel(s) {
  const h=s.households;
  if (!h) return '';
  const name=id=>esc(s.agents[id]?.name??'聚落');
  const title=room=>esc(s.rooms?.[room]??'暂无住处');
  const btn=(kind,id,text,accept=false)=>
    `<button type="button" data-family="${kind}" data-id="${esc(id)}" data-accept="${accept}">${text}</button>`;
  const spouse=h.spouses.p1;
  const present=Object.values(s.agents).filter(a=>!a.isPlayer && a.stage==='adult' && a.viab>0 && !s.districtTravel?.[a.id] && a.loc===s.loc.p1);
  const available=present.filter(a=>!h.spouses[a.id] && !h.residents[a.id]?.parents.includes('p1'));
  const offers=h.offers.filter(o=>o.to==='p1');
  const vacant=Object.entries(h.deeds).filter(([room,d])=>d.owner==='p1' && !Object.values(s.housing).includes(room));
  return `<div class="housing-body">
    <p>你的住处 · ${title(s.housing.p1)}${spouse?` · 配偶 ${name(spouse)}`:''}</p>
    <p>子女 ${h.adultDays} 个游戏日成年。成年后会根据床位、家人意愿和个人物资选择住处。</p>
    <ul>${Object.entries(s.agents).filter(([id])=>id!=='p1').map(([id,a])=>{
      const r=h.residents[id], state={seeking:'正在攒建房物资',stayed:'成年后留家',building:'正在建房',built:'已建新房',bought:'已买房'}[r?.decision];
      return `<li>${name(id)} · ${a.stage==='child'?'未成年':'成年'} · ${title(s.housing[id])}
        ${h.spouses[id]?` · 配偶 ${name(h.spouses[id])}`:''}
        ${r?.parents.length?` · 双亲 ${r.parents.map(name).join('、')}`:''}
        ${state?` · ${state}`:''}
        ${r?.parents.includes('p1') && r.decision!=='stayed' ?
          btn('family_stay',id,r.stayAllowed?'撤回留家同意':'同意成年后留家',!r.stayAllowed):''}</li>`;
    }).join('')}</ul>
    ${Object.entries(h.projects).map(([room,p])=>`<p>${name(p.owner)} · 施工 ${p.progress}/3</p>`).join('')}
    ${offers.map(o=>`<p>${name(o.from)}邀请${o.kind==='family_marry'?'结婚':'同住'}
      ${btn('family_answer',o.from,'接受',true)} ${btn('family_answer',o.from,'婉拒')}</p>`).join('')}
    ${!spouse?available.map(a=>btn('family_marry',a.id,`向${name(a.id)}求婚`)).join(''):
      s.loc[spouse]===s.loc.p1 && s.housing[spouse]!==s.housing.p1
        ? btn('family_move',spouse,'提议搬到配偶家') : ''}
    ${vacant.map(([room,d])=>btn('family_list',room,d.listed?`撤下${title(room)}`:`出售${title(room)}`,!d.listed)).join('')}
  </div>`;
}

function coopPanel(s) {
  if (!s.coop?.enabled) return '';
  const here = s.loc?.p1;
  const site = (s.sites ?? []).find((x) => x.loc === here);
  const task = s.coop.task;
  const residents = Object.values(s.agents ?? {}).filter((a) => !a.isPlayer && !a.dead && (a.viab ?? 1) > 0);
  const reqBtns = site ? residents.map((a) => `<button data-coop="${esc(a.id)}">请${esc(a.name)}协助</button>`).join('') : '';
  return `<details class="survdetail"><summary>合作施工</summary>
    <div class="survrow">${task ? `当前任务 ${esc(task.type)}·${esc(task.phase)}·${task.workers.length}人` : '暂无任务'} ｜ 完工 ${s.coop.completions.length} ｜ 拒绝 ${s.coop.refusals} ｜ 退出 ${s.coop.exits ?? 0}</div>
    ${site ? `<div class="survrow survbtns">你在工地 ${esc(site.type)}：${reqBtns}</div>` : '<div class="survrow dim">说明书 · 合作施工 查看规则</div>'}
  </details>`;
}

// P2 新玩家目标引导：按当前世界状态给出"下一步该做什么"的上下文提示（编号递进）。
function objectiveHint(s) {
  if (!s || s.player?.dead) return '';
  if (s.settlement === 'extinct' || s.ended) return '聚落已没有存活居民；自然生态仍在演化，可继续观察世界。';
  if (s.settlement === 'crisis' || s.settlement === 'recovering' || s.failed) {
    const goals = (s.crisisGoals ?? []).map((g, i) => `${i + 1}) ${g}`).join(' ');
    return `⚠ 缺粮危机${s.crisisDays ? `（连续 ${s.crisisDays} 天缺口）` : ''}：${goals || '先补食物并恢复公仓；危机不是终局。'}`;
  }
  const has = (t) => (s.buildings ?? []).some((x) => x.type === t && x.integrity > 0);
  const shelterSite = (s.sites ?? []).some((x) => x.type === 'shelter');
  const poolW = (s.pinv?.p1?.wood ?? 0) + (s.inv?.wood ?? 0);
  const poolS = (s.pinv?.p1?.stone ?? 0) + (s.inv?.stone ?? 0);
  if (s.stormTomorrow || s.coldsnapTomorrow) return '⚠ 灾害将至：维修加固建筑、储备食物；住所可减半饥饿压力。';
  if (!has('shelter') && !shelterSite) {
    if (poolW < 4 || poolS < 2) return '① 采集木石：院子/树林持斧采木，瞭台/井台持镐采石（住所要 4 木 2 石）。';
    return '② 奠基住所：到户外空地持锤奠基，再施工建成（降低饥饿压力）。';
  }
  if (shelterSite) return '③ 施工：站在工地持锤施工；在「合作施工」请居民协助可加快进度。';
  if ((s.store ?? 0) < 6) return '④ 储备食物：菜园持锄收获/播种，或采浆果到公仓兑换；公仓养活聚落。';
  if (!has('granary')) return '⑤ 建储粮设施提高粮仓上限；居民信任越高越愿意协助。';
  return '';   // 玩法概括已并入左上角 tagline，不在面板重复
}

const STAT_ICON = {
  calendar: '<svg viewBox="0 0 12 12" width="14" height="14" aria-hidden="true"><rect x="1" y="2" width="10" height="9" fill="#D8A667"/><rect x="1" y="2" width="10" height="2" fill="#AB5236"/><path d="M3 6h2v2H3zM7 6h2v2H7z" fill="#72513B"/></svg>',
  weather: '<svg viewBox="0 0 12 12" width="14" height="14" aria-hidden="true"><circle cx="6" cy="6" r="3" fill="#FFEC27"/><path d="M6 0v2M6 10v2M0 6h2M10 6h2" stroke="#FFA300" stroke-width="1"/></svg>',
  heart: '<svg viewBox="0 0 12 12" width="14" height="14" aria-hidden="true"><path d="M6 10 1.5 5.5A2.5 2.5 0 0 1 6 3a2.5 2.5 0 0 1 4.5 2.5z" fill="#D58274"/></svg>',
  shield: '<svg viewBox="0 0 12 12" width="14" height="14" aria-hidden="true"><path d="M6 1 1 3v4c0 3 2.2 4.4 5 5 2.8-.6 5-2 5-5V3z" fill="#5B574C"/><path d="M6 2 2 3.5V7c0 2.3 1.6 3.4 4 4 2.4-.6 4-1.7 4-4V3.5z" fill="#98BD51"/></svg>',
  place: '<svg viewBox="0 0 12 12" width="14" height="14" aria-hidden="true"><path d="M6 1a3.5 3.5 0 0 0-3.5 3.5C2.5 7 6 11 6 11s3.5-4 3.5-6.5A3.5 3.5 0 0 0 6 1z" fill="#458996"/><circle cx="6" cy="4.5" r="1.2" fill="#FFF0CC"/></svg>',
  action: '<svg viewBox="0 0 12 12" width="14" height="14" aria-hidden="true"><path d="M7 0 2 7h3l-1 5 6-7H7z" fill="#FFA300"/></svg>',
  forecast: '<svg viewBox="0 0 12 12" width="14" height="14" aria-hidden="true"><path d="M2 8h8v2H2z" fill="#5B574C"/><path d="M3 5a3 3 0 0 1 6 0" stroke="#83769C" stroke-width="1.2" fill="none"/></svg>',
};
function openCenterDlg(id, renderFn) {
  const d = $(id); if (!d) return;
  renderFn(S.survivalView);
  if (!d.open) d.showModal();
}
function renderManual(s) {
  const el = $('manualBody'); if (!el) return;
  const line = (t) => `<li>${esc(t)}</li>`;
  const h = (t) => `<h3>${esc(t)}</h3>`;
  const v = (t) => `<p>${esc(t)}</p>`;
  el.innerHTML = [
    h('当前目标'), v(objectiveHint(s) || '自由经营：维持食物、住所与生态，应对四季与灾害。'),
    h('新手步骤'), '<ul>' + [
      '① 采集木石：院子/树林持斧采木，瞭台/井台持镐采石（住所要 4 木 2 石）。',
      '② 奠基住所：到户外空地持锤奠基，再施工建成（降低饥饿压力）。',
      '③ 施工：站在工地持锤施工；在「合作施工」请居民协助可加快进度。',
      '④ 储备食物：菜园持锄收获/播种，或采浆果到公仓兑换；公仓养活聚落。',
      '⑤ 建储粮设施提高粮仓上限；居民信任越高越愿意协助。',
      '⑥ 长期经营：维持食物、住所和生态，应对四季与灾害。',
    ].map(line).join('') + '</ul>',
    h('按键'), '<ul>' + [
      'WASD/方向键 走路 · Shift 奔跑 · 1-8 选工具 · E 背包 · 靠近居民空手按 F 交谈（重工具会击伤） · 点家具走近使用 · 到门口进入 · Esc 关闭面板',
      '工具：手/斧/镐/锄/锤/篮/剪/桶；工具栏右侧显示当前手持与可用动作。',
    ].map(line).join('') + '</ul>',
    h('家庭与住房'), v('子女 12 个游戏日成年。成年后会根据床位、家人意愿和个人物资选择住处。'),
    v('房屋可自主建造、施工、居住、继承、空置与再次使用；产权归住户，房主去世后按规则处理。'),
    h('合作施工'), v('站在工地上可向居民请求协助；居民按自身需求、对你的信任、天气与任务价值决定是否参与，也可能中途退出。'),
    h('世界'), v(`世界 ${s.tw ?? 120}×${s.th ?? 80} 格完整运行，视口随屏幕调整；树与屋舍挡视线，昼夜影响环境明暗。`),
    v('生态自行出生/进食/繁殖/衰老，受水分与灾害影响；野果、野生动物按季节变化。'),
    h('细账 · 当前数值'),
    v(`背包 木 ${s.pinv?.p1?.wood ?? 0} 石 ${s.pinv?.p1?.stone ?? 0} ｜ 公仓 木 ${s.inv?.wood ?? 0} 石 ${s.inv?.stone ?? 0}`),
    v(`粮 ${s.store ?? 0}/${s.storeCap ?? 24} ｜ 水 ${s.water ?? 0} ｜ 土 ${s.soil ?? 0}`),
    v(`菜畦 ${(s.plots ?? []).map((q) => `[${q.id}:${q.growth >= 1 ? '熟' : q.growth}]`).join(' ') || '无'}`),
    v(`收成 浆果 ${s.produce?.berry ?? 0} · 果 ${s.produce?.fruit ?? 0} · 蛋 ${s.produce?.egg ?? 0} · 奶 ${s.produce?.milk ?? 0} · 毛 ${s.produce?.wool ?? 0}`),
    v(`存栏 鸡 ${s.livestock?.chickens ?? 0} 牛 ${s.livestock?.cows ?? 0} 羊 ${s.livestock?.sheep ?? 0} 果树 ${s.livestock?.orchards ?? 0}`),
    v(`建筑 ${(s.buildings ?? []).length} 座 ｜ 工地 ${(s.sites ?? []).length} 处 ｜ 完工 ${s.coop?.completions?.length ?? 0} ｜ 拒绝 ${s.coop?.refusals ?? 0}`),
    h('最近日志'), v((s.log ?? []).slice(-8).map((l) => `t${l.t} ${l.kind} ${l.ok ? '✓' : l.code}`).join(' ｜ ') || '暂无'),
    h('关于规则'), v('居民与玩家使用同一套存续规则：不吃饭会死；婚姻、住房产权、衰老与死亡都由世界规则决定。'),
  ].join('');
}
function renderHousing(s) {
  const el = $('housingBody'); if (!el || !s) return;
  el.innerHTML = familyPanel(s);
}
// 像素叶子：全部 6×6 方块，落在 2px 网格上，不做矢量曲线
const SEASON_LEAVES = {
  春: [[30,32],[60,26],[48,50],[72,36]].map(([x,y])=>`<rect x="${x}" y="${y}" width="6" height="6" fill="#98BD51"/>`).join(''),
  夏: [[28,28],[36,24],[44,20],[54,28],[62,22],[70,30],[32,42],[50,46],[66,42],[76,20]]
      .map(([x,y],i)=>`<rect x="${x}" y="${y}" width="8" height="8" fill="${i%2?'#008751':'#73A747'}"/>`).join(''),
  秋: [[30,30],[46,22],[62,30],[76,22],[54,48],[70,44],[38,44],[82,36]]
      .map(([x,y],i)=>`<rect x="${x}" y="${y}" width="8" height="8" fill="${i%2?'#FFA300':'#FFEC27'}"/>`).join(''),
  冬: [[30,28],[40,28],[58,20],[68,20],[76,32],[50,44]]
      .map(([x,y])=>`<rect x="${x}" y="${y}" width="10" height="3" fill="#FFF0CC"/>`).join(''),
};
const TIME_ARC = [
  { key:'晨', color:'#FFD37A' }, { key:'昼', color:'#FFF0CC' },
  { key:'暮', color:'#E8864B' }, { key:'夜', color:'#3B4A73' },
];
function seasonWheelSVG(seasonName, phase) {
  // 圆心移到右上角，整个扇形相对上一版反转 180°
  const cx=94, cy=10, r=88;
  const pt=(deg)=>[cx+r*Math.cos(deg*Math.PI/180), cy+r*Math.sin(deg*Math.PI/180)];
  const arc=(a,b,color,w)=>{
    const [x1,y1]=pt(a),[x2,y2]=pt(b);
    return `<path d="M${x1.toFixed(1)} ${y1.toFixed(1)} A${r} ${r} 0 0 1 ${x2.toFixed(1)} ${y2.toFixed(1)}" stroke="${color}" stroke-width="${w}" fill="none"/>`;
  };
  let arcs='';
  TIME_ARC.forEach((seg,i)=>{
    const a=180+i*22.5, b2=180+(i+1)*22.5;
    if(phase===seg.key) arcs+=arc(a,b2,'#FFF0CC',9);
    arcs+=arc(a,b2,seg.color,5);
  });
  // 右上为圆心的 1/4 圆扇形（朝左下展开）
  const fan='<path d="M94 10 L94 90 A80 80 0 0 0 14 10 Z" fill="#3B4A33" stroke="#5B4434" stroke-width="2"/>';
  // 枝干：从左下往右上，与反转后的扇形方向一致
  const branch='<path d="M18 86 L34 70 L48 52 L62 40 L78 26" stroke="#5B4434" stroke-width="4" fill="none" stroke-linejoin="miter"/>'
    + '<path d="M34 70 L28 56 M48 52 L42 38 M62 40 L70 30" stroke="#5B4434" stroke-width="3" fill="none"/>';
  const leaves=SEASON_LEAVES[seasonName]??SEASON_LEAVES.春;
  return `<svg viewBox="0 0 106 106" aria-label="${seasonName} · ${phase}">${arcs}${fan}${branch}${leaves}</svg>`;
}
function renderSeasonHud(view, location, outdoor) {
  const el = $('seasonHud'); if (!el || !view) return;
  $('seasonWeather').innerHTML = `${esc(view.season ?? '')} ${view.dayInSeason ?? '?'}天<br>${esc(view.weather ?? '')}`;
  $('seasonWheel').innerHTML = seasonWheelSVG(view.season, view.phase);
  const ph = $('playerHud');
  if (ph) ph.innerHTML = [
    [`${STAT_ICON.heart}`, '体力', view.player?.energy ?? '?'],
    [`${STAT_ICON.shield}`, '存续', view.player?.viab ?? '?'],
    [`${STAT_ICON.action}`, '本刻行动', `${view.player?.timeLeft ?? 0}/100`],
  ].map(([i,k,v])=>`<span class="stat">${i}<span>${k}</span><b>${v}</b></span>`).join('');
  const pl = $('placeHud');
  if (pl) pl.textContent = `${location ?? ''}${outdoor ? ' · 户外' : ' · 室内'}`;
}
function ecoButtons(s, which) {
  if (!s) return '';
  if (which === 'exchange') return Object.keys(s.economy?.exchange ?? {}).map((k) => {
    const n = s.produce?.[k] ?? 0, label = s.economy?.produceLabel?.[k] ?? k;
    return `<button data-sk="exchange" data-type="${k}" title="兑换${label}（现有 ${n}）"${n < 1 ? ' disabled' : ''}><img width="32" height="32" alt="" src="${itemIcon(k)}"><span class="tag">${n}</span></button>`;
  }).join('');
  return Object.entries(s.economy?.expand ?? {}).map(([k, c]) => {
    const label = s.economy?.expandLabel?.[k] ?? k;
    const ok = (s.inv?.wood ?? 0) >= c.wood && (s.inv?.stone ?? 0) >= c.stone;
    return `<button data-sk="expand" data-type="${k}" title="建造${label}（木${c.wood} 石${c.stone}）"${ok ? '' : ' disabled'}><img width="32" height="32" alt="" src="${itemIcon('wood')}"><span class="tag">${c.wood}/${c.stone}</span></button>`;
  }).join('');
}
function renderExchangeDlg(s) { const el=$('exchangeBody'); if(el) el.innerHTML=`<div class="eco-icons">${ecoButtons(s,'exchange')}</div>`; }
function renderBuildDlg(s) { const el=$('buildBody'); if(el) el.innerHTML=`<div class="eco-icons">${ecoButtons(s,'build')}</div>`; }
function renderVillageDlg(s) {
  const el = $('villageBody'); if (!el || !s) return;
  const rows = Object.entries(s.agents ?? {}).filter(([id]) => id !== 'p1').map(([id,a]) => {
    const v = Math.max(0, Math.min(1, a.viab ?? 1));
    const bar = `<span style="display:inline-block;width:70px;height:8px;border:1px solid var(--line);background:var(--sunken)"><span style="display:block;height:100%;width:${Math.round(v*100)}%;background:${v<.3?'#D58274':'#98BD51'}"></span></span>`;
    return `<div class="vrow"><b>${esc(a.name ?? id)}</b><span>${esc(a.stage ?? '')}</span>${bar}<span class="dim">${esc(s.rooms?.[s.loc?.[id]] ?? s.loc?.[id] ?? '')}</span><span>${esc(a.action ?? '待机')}</span></div>`;
  }).join('');
  el.innerHTML = rows || '<p class="dim">暂无居民</p>';
}
// ① 研究面板：合作施工统计
function renderLabCoop(s) {
  const el = $('labCoop'); if (!el || !s?.coop) return;
  const t = s.coop.task;
  el.innerHTML = `<div class="survrow">当前任务 ${t ? `${esc(t.type)}·${esc(t.phase)}·${t.workers.length}人` : '暂无任务'} ｜ 完工 ${s.coop.completions?.length ?? 0} ｜ 拒绝 ${s.coop.refusals ?? 0} ｜ 退出 ${s.coop.exits ?? 0}</div>`;
}
function renderSurv(s) {
  const el = $('survPanel'); if (!el || !s) return;
  // 动作结果提示只在 3 秒内显示，之后自动收起（renderSurv 每 900ms 轮询重建）
  if (survFlash && !survFlash.at) survFlash.at = Date.now();
  if (survFlash && Date.now() - survFlash.at > 3000) survFlash = null;
  // 面板每 900ms 由轮询重建；先记下折叠区状态，重建后原样恢复，否则用户点开会被自动合上。
  if (el.contains(document.activeElement) && document.activeElement.matches('button:focus-visible')) return;
  const openState = [...el.querySelectorAll(':scope > details')].map((d) => d.open);
  const b = s.buildingsDef || {};
  const bl = (t) => esc(b[t]?.label ?? t);
  const here = s.loc?.p1;
  const feet=WALK['cvA:p1'];
  const outside=!ui.interior && feet && !inCamp(feet.x+.5,feet.y+.5);
  const nearby=outside && Object.entries(s.districts??{}).find(([,d])=>distanceToRect([feet.x+.5,feet.y+.5],d.pad)<1.15);
  const location=outside ? nearby?.[1].label??'外围野地' : (s.rooms??{})[here]??here;
  const outdoor = !ui.interior;
  const flash = survFlash ? `<span class="${survFlash.ok ? 'good' : 'bad'}">${esc(campLabels[survFlash.kind]??survFlash.kind)}：${esc(campCodes[survFlash.code] ?? SURV_CODE_ZH[survFlash.code] ?? survFlash.code)}${survFlash.tool ? `（需要${TOOL_ZH[survFlash.tool]}）` : ''}</span>` : '';
  const banner = s.player?.dead ? '<div class="survbanner bad">你倒下了。营地还在，但这一局属于你结束了。点「重新开始」再来一局。</div>' : s.ended ? `<div class="survbanner bad">终局：${s.endReason === 'extinct' ? '聚落已没有存活居民，自然生态仍在变化' : s.endReason === 'sole' ? '只剩一个生命' : '再无异性对，无法繁衍'}。存活 ${s.day} 天。点「重新开始」再来一局。</div>` : s.failed ? `<div class="survbanner bad">聚落陷入缺粮危机（连续 ${s.crisisDays ?? 0} 天缺口）：居民仍在生活，按目标恢复供给。</div>` : s.settlement === 'recovering' ? '<div class="survbanner">危机已缓解，正在恢复：把公仓补回安全线。</div>' : '';
  el.innerHTML = `
    ${banner}
    <div class="survrow stat-icons">
      <span class="stat" title="季节与日期">${STAT_ICON.calendar}<b>${esc(s.season ?? '')} ${s.dayInSeason ?? '?'} / ${s.day+1}</b></span>
      <span class="stat" title="时段与天气">${STAT_ICON.weather}<b>${esc(s.phase)} ${esc(s.weather ?? '')}</b></span>
      <span class="stat" title="体力">${STAT_ICON.heart}<b>${s.player?.energy ?? '?'}</b></span>
      <span class="stat" title="存续">${STAT_ICON.shield}<b class="${(s.player?.viab ?? 1) < 0.3 ? 'bad' : ''}">${s.player?.viab ?? '?'}</b></span>
      <span class="stat" title="当前地点">${STAT_ICON.place}<b>${esc(location)}${outdoor ? '·户外' : '·室内'}</b></span>
      ${s.player?.timeLeft != null ? `<span class="stat" title="本刻行动">${STAT_ICON.action}<b>${s.player.timeLeft}/100</b></span>` : ''}
      ${(s.stormTomorrow || s.coldsnapTomorrow || s.drought || s.disasterToday)
        ? `<span class="bad" title="预警">⚠ ${[s.stormTomorrow ? '风暴' : '', s.coldsnapTomorrow ? '寒潮' : '', s.drought ? '干旱' : '', s.disasterToday ? (s.disasterToday === 'storm' ? '风暴' : '寒潮') : ''].filter(Boolean).join(' · ')}</span>`
        : `<span class="dim stat" title="明日预报">${STAT_ICON.forecast}<b>${esc(s.forecast ?? '')}${s.clearStreak ? ` 连晴${s.clearStreak}` : ''}</b></span>`}
      ${flash}
      ${s.player?.dead || s.ended ? '<button id="btnSurvReset">重新开始</button>' : ''}
    </div>
    <details class="surveco"><summary>收成兑换 / 蓄养扩建 · 图标操作</summary>
      <div class="eco-icons">
        ${Object.keys(s.economy?.exchange ?? {}).map((k) => {
          const n = s.produce?.[k] ?? 0, label = s.economy?.produceLabel?.[k] ?? k;
          return `<button data-sk="exchange" data-type="${k}" title="兑换${label}（现有 ${n}）"${n < 1 ? ' disabled' : ''}><img width="32" height="32" alt="" src="${itemIcon(k)}"><span class="tag">${n}</span></button>`;
        }).join('')}
        ${Object.entries(s.economy?.expand ?? {}).map(([k, c]) => {
          const label = s.economy?.expandLabel?.[k] ?? k;
          const ok = (s.inv?.wood ?? 0) >= c.wood && (s.inv?.stone ?? 0) >= c.stone;
          return `<button data-sk="expand" data-type="${k}" title="扩建${label}（木${c.wood} 石${c.stone}）"${ok ? '' : ' disabled'}><img width="32" height="32" alt="" src="${itemIcon('wood')}"><span class="tag">${c.wood}/${c.stone}</span></button>`;
        }).join('')}
      </div>
    </details>`;
  el.querySelectorAll(':scope > details').forEach((d, i) => { if (openState[i]) d.open = true; });
  renderItemBar(s);
  renderSeasonHud(s, location, outdoor);
  renderLabCoop(s);
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

const MAP_GRID={width:WORLD_W,height:WORLD_H,cell:COLLISION_CELL,legacy:[96*TILE,64*TILE]};
const ROOM_LABELS = { ...LOCS, workshop: '工坊', garden: '菜园', well: '井台', yard: '院子' };
function collisionScene(id) {
  const w = S.view;
  const background = document.createElement('canvas');
  if (id !== 'map') {
    drawInterior(background, w, id, true);
    return { background, assetPixels: roomPixelWalk(id), roomBounds:roomBounds(id) };
  }
  const world = buildWorld(w);
  background.width = WORLD_W;
  background.height = WORLD_H;
  const g = background.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.drawImage(world.canvas, 0, 0, WORLD_W, WORLD_H);
  const origin = { x: 0, y: 0 };
  const depth = o => o.kind === 'tree' ? o.ty : o.foot ?? o.sy - 1;
  for (const o of [...world.objects].sort((a, b) => depth(a) - depth(b))) {
    if (o.kind === 'tree') drawTreeObj(g, o, origin);
    else drawHouseObj(g, o, origin);
  }
  g.font = '8px fusion-pixel, monospace';
  for (const [key, render] of [['buildings', drawBuildingObj], ['sites', drawSiteObj]]) {
    for (const item of w[key] ?? []) {
      const lot=item.lot??constructionLot(item.loc,w.layout);
      if (lot) render(g,{lot,bld:item,st:item},origin);
    }
  }
  return { background, pixelWalk: world.pixelBase ?? terrainPixels(), assetPixels: world.assetPixels };
}

const collisionDialog = $('collisionEditor');
const localCollisionEditor = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
// 调试入口关闭，继续读取本机已保存的碰撞。
const COLLISION_EDITING_ENABLED = false;
const canEditCollisions = COLLISION_EDITING_ENABLED && localCollisionEditor;
$('btnCollision').hidden = !canEditCollisions;
const collisionEditor = createCollisionEditor({
  dialog: collisionDialog,
  enabled: localCollisionEditor,
  editable: canEditCollisions,
  grids: { map: MAP_GRID, ...Object.fromEntries(Object.keys(INTERIORS).map(id => [id, ROOM_GRID])) },
  labels: { map: '室外地图', ...ROOM_LABELS },
  makeScene: collisionScene,
  move(id, cells, point, dx, dy, spawn) {
    const [x, y] = point;
    if (id !== 'map') {
      const mask=roomPixelWalk(id), bounds=roomBounds(id);
      const fits=campRenderer?(_x,_y,nx,ny)=>roomBodyFits(id,cells,mask,bounds,nx,ny):undefined;
      if (spawn) return (fits?fits(x,y,x,y):roomAllows(cells,x,y,mask,bounds))?point:null;
      return moveRoomFeet(cells,x,y,dx,dy,mask,fits,bounds);
    }
    const world = buildWorld(S.view);
    if (spawn) {
      if (!mapAllows(world, x / TILE - 0.5, y / TILE - 0.5)) return null;
      return [x, y].map(pixel => Math.floor(pixel) + 0.5);
    }
    const [nextX, nextY] = moveMapFeet(world, x / TILE - 0.5, y / TILE - 0.5, dx / TILE, dy / TILE);
    return [(nextX + 0.5) * TILE, (nextY + 0.5) * TILE];
  },
  changed() {
    // 修改通路后，丢弃按旧网格排好的路径。
    for (const walker of Object.values(WALK)) {
      walker.path = []; walker.pi = 0; walker.moving = false;
    }
  },
});
$('btnCollision').onclick = () => {
  if (!canEditCollisions || !S.view || collisionDialog.open) return;
  keys.clear();
  collisionEditor.open();
};

function renderPlayMode(sv) {
  const hasSurvival=Boolean(sv);
  S.survivalView=sv;
  S.soloSurv=!ui.menu && !ui.compare && hasSurvival;
  document.body.classList.toggle('menu-mode',ui.menu);
  $('startMenu').hidden=!ui.menu;
  $('startSurvival').disabled=!hasSurvival || resettingSurvival;
  $('startNew').disabled=!hasSurvival || resettingSurvival;
  $('startCompare').disabled=resettingSurvival;
  if (!resettingSurvival && !startError)
    $('startStatus').textContent=sv?`生存存档 · 第 ${sv.day+1} 天`:'当前服务没有生存存档。';
  S.campReady=Boolean(sv?.camp);
  document.body.classList.toggle('surv-mode',S.soloSurv);
  const main=$('worldMain');
  main.classList.toggle('solo',!ui.compare);
  main.hidden=ui.menu || (!hasSurvival && !ui.compare);
  const notice=$('playNotice'), preview=$('playPreviewLink');
  const message=ui.compare
    ? (hasSurvival?'研究对照正在显示。点「生存游玩」返回工具栏、背包和家具玩法。':'当前入口仅有研究对照，生存玩法请打开新版入口。')
    : !hasSurvival ? '当前入口没有加载生存世界。背包、工具栏和家具玩法在新版生存入口。'
      : !S.campReady ? '当前入口的生存服务版本较旧。新版入口支持家具存取、睡觉和采集工具。' : '';
  notice.hidden=!message;
  if ($('playNoticeText').textContent!==message) $('playNoticeText').textContent=message;
  const isLocal=['localhost','127.0.0.1','[::1]'].includes(location.hostname);
  preview.hidden=!isLocal || S.campReady || location.port==='17948';
  if (!preview.hidden) preview.href='http://127.0.0.1:17948/';
  $('btnSurv').classList.toggle('on',S.soloSurv);
  $('btnSurv').setAttribute('aria-pressed',String(S.soloSurv));
  $('btnCompare').setAttribute('aria-pressed',String(ui.compare));
  $('btnBagTop').disabled=!hasSurvival;
  $('btnBagFull').disabled=!hasSurvival;
}

async function refresh() {
  try {
    const requestedMode=ui.menu?'menu':ui.compare?'compare':'survival';
    const j = await api('/world?mode='+requestedMode);
    if (requestedMode!==(ui.menu?'menu':ui.compare?'compare':'survival') || resettingSurvival) return;
    renderPlayMode(j.survival);
    if (ui.menu) return;
    if (S.soloSurv && j.survival?.settlementLife && !enteringRoom && !leavingRoom && !ui.surveyRoom &&
        (ui.interior?.startsWith('facility:') || residentialSite(ui.interior,j.survival.peripheralHomes) || j.survival.campPlayerRoom)) {
      const room=j.survival.campPlayerRoom;
      if (ui.interior!==room) {
        ui.interior=room;
        IPOS.site=null;
        roomRoute=null;
        $('campPropDialog').close();
      }
    }
    // 交谈结束（不耐烦/走开/服务端清空）：收尾，别让输入框停在死对话上。
    if (ui.talk && j.survival && !j.survival.talk) {
      addTalk('sys', `${ui.talk.name}结束了对话。`);
      closeTalkDlg();
    }
    S.brain = j.brain;
    S.model = j.model;
    if (S.running!==j.running || S.sunTick!==j.survival?.t || S.sunSeed!==j.survival?.mapSeed) {
      S.sunTick=j.survival?.t;
      S.sunSeed=j.survival?.mapSeed;
      S.sunTickAt=performance.now();
    }
    S.running = j.running;
    S.tickMs=j.tickMs;
    S.masks = j.masks ?? S.masks;
    S.viewB = j.B;   // 动画循环重绘 B 侧用；不新增请求、不动载荷形状
    S.layer = j.layer ?? S.layer;
    // 后端状态必须可见：评委要能判断"现在到底是真模型还是替身"，而不是靠猜
    const m = j.model ?? {};
    const chip = $('backend');
    if (S.soloSurv && j.survival.model?.enabled && !j.survival.model.configured) {
      chip.textContent='生存：本地替身（模型未配置）'; chip.classList.remove('on');
    } else if (j.brain !== 'model') { chip.textContent = '后端：本地替身'; chip.classList.remove('on'); }
    else if (!m.watching) { chip.textContent = '后端：替身（无人观看，省额度）'; chip.classList.remove('on'); }
    else if ((m.calls ?? 0) >= (m.budget ?? 0)) { chip.textContent = `后端：替身（今日 ${m.budget} 次已用完）`; chip.classList.remove('on'); }
    else {
      chip.textContent=S.soloSurv && j.survival.model
        ? `生存：模型已接入 · 今日有效选择 ${j.survival.model.choices}`
        : `后端：真模型 ${m.calls ?? 0}/${m.budget ?? '?'}（今日额度）`;
      chip.classList.add('on');
    }
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
    const sv = j.survival;
    const viewA = S.soloSurv ? sv : j.A;
    S.view = viewA;
    $('btnCollision').disabled = !canEditCollisions;
    if (!$('worldMain').hidden) {
      if (ui.fullscreen) draw($('cvFull'),viewA);
      else { draw($('cvA'),viewA); draw($('cvB'),j.B); }
    }
    rows($('rowsA'), j.A, 'a');
    rows($('rowsB'), j.B, 'b');
    $('statA').innerHTML = worldStat(j.A);
    $('statB').innerHTML = worldStat(j.B);
    secrets($('secrets'), j.A);
    hailRow($('hail'), j.A);
    social($('social'), j.A);
    // 聚焦镜头 HUD：小地图 / 当前房间角色卡 / 事件 toast
    const roomKeys = Object.keys(viewA.rooms ?? LOCS);
    if (!roomKeys.includes(ui.room)) ui.room = roomKeys[0];
    fillMinimap(viewA);
    fillOcc($('occA'), viewA);
    fillOcc($('occB'), j.B);
    if (!S.soloSurv) pushToasts(j.A);
    $('btnOverview').classList.toggle('on',ui.overview);
    $('btnOverview').disabled=Boolean(ui.interior);
    $('btnOverview').title=ui.interior?'返回营地后可打开全景':'';
    $('btnOverview').textContent = ui.surveyRoom ? '返回瞭望台' : ui.overview ? '返回角色视角' : '世界全景';
    const fi = $('fullInfo');
    if (fi) fi.textContent = `拥爱生命实验室 · 全屏${ui.interior ? '室内' : ui.overview ? '全景' : ''} · 第 ${viewA.t} 刻 · ${viewA.phase ?? ''} · 视野 ${lightRadius(viewA.phase)} 格`;
    const vi = $('visionInfo');
    if (vi) vi.textContent = ui.interior
      ? `室内 · ${(viewA.rooms ?? LOCS)[ui.interior] ?? ui.interior} · 走近按 F 或点家具 · 到门口离开`
      : S.soloSurv
        ? `聚落与荒野 ${WILDS.east-WILDS.west}×${WILDS.south-WILDS.north} 格 · WASD 探索 · F 交互 · E 背包 · Shift 奔跑 · 全景/全屏可用`
        : `世界 ${WORLD_TW}×${WORLD_TH} 格 · 视口 ${VIEW_TW}×${VIEW_TH} 格 · 视野 ${lightRadius(viewA.phase)} 格（${viewA.phase ?? ''}）· WASD/方向键 移动 · 走近入口按 F 进入 · E 背包 · Shift 奔跑`;
    $('titA').textContent = S.soloSurv ? '生存 · 单世界' : 'A · 通道开';
    $('tagline').textContent = S.soloSurv ? '无尽生存 · 在荒野与居民共同生活。维持食物、住所和生态，应对四季与灾害。' : '同一颗种子、两个世界：左边内部状态参与决策，右边切断。';
    $('tbl').innerHTML = table(j.A, j.B);
    updateHotbar();
    renderGauges(sv);
    renderVillage(sv);
    if ($('backpack').open) renderBackpack();
    renderSurv(j.survival);
    const onLayers = Object.entries(S.masks ?? {}).filter(([, v]) => v).map(([k]) => (k === 'm3' ? 'M3 承诺' : 'M4 耦合'));
    $('tagA').textContent = S.soloSurv
      ? `第 ${sv.day+1} 天 · ${sv.phase} · ${sv.weather ?? ''} · 粮 ${sv.store}/${sv.storeCap}`
      : `第 ${j.A.t} 刻 · ${j.A.phase ?? ''} · 通道全开${onLayers.length ? ' · 另叠 ' + onLayers.join('+') : ''} · 休眠补时 ${j.missed.applied ?? 0} 分钟`;
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
    $('log').innerHTML=`<div class="rej">与服务端断开：${esc(e.message)}</div>`;
    if (ui.menu) $('startStatus').textContent='无法连接世界，正在重试。';
    $('playNoticeText').textContent='无法连接生存服务，正在重试。';
    $('playNotice').hidden=false;
  }
}

async function ctl(body) {
  await api('/ctl', body);
  refresh();
}

$('cvA').addEventListener('click', (ev) => pickRoom(ev, $('cvA')));
$('cvB').addEventListener('click', (ev) => pickRoom(ev, $('cvB')));
// 3D 悬停命中：只记指针位置与时间，实际反算放在 drawCamp（每帧用当帧相机，避免错位）。
for(const id of ['cvA','cvB','cvFull']){
  const el=$(id);
  el.addEventListener('pointermove',e=>{
    if (!campHover || campHover.cv!==id || Math.hypot(e.clientX-campHover.clientX,e.clientY-campHover.clientY)>3) {
      campHover={cv:id,clientX:e.clientX,clientY:e.clientY,t:performance.now()};
    }
    el.style.cursor=pointedEntity(el,e)?'pointer':'';
  });
  el.addEventListener('pointerleave',()=>{campHover=null;el.style.cursor='';});
}
$('minimap').addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-room]');
  if (!b) return;
  const r = b.dataset.room;
  if (ui.interior || ui.surveyRoom) return;
  walkToEntrance(r);

});
$('btnCampAngle').hidden=!campRenderer;
$('btnCampAngle').onclick=()=>{
  campAngle=(campAngle+1)%CAMP_ANGLES.length;
  if(ui.fullscreen&&S.view)draw($('cvFull'),S.view);
  else if(S.view){draw($('cvA'),S.view);if(ui.compare&&S.viewB)draw($('cvB'),S.viewB);}
};
$('btnOverview').onclick=()=>{
  if (ui.surveyRoom) { returnFromSurvey(); return; }
  if (ui.interior) return;
  ui.overview=!ui.overview;
  ui.camRoom=null;
  refresh();
};
let resettingSurvival=false, startError=false;

function rememberSurvivalPosition() {
  const walker=WALK['cvA:p1'];
  if (S.soloSurv && walker && S.view) storeOuting(walker,S.view);
  outdoorIntent=null;
  keys.clear();
}
function selectWorld(compare) {
  rememberSurvivalPosition();
  ui.menu=false;
  startError=false;
  if (ui.compare!==compare) {
    closeRoom(false);
    closeBackpack();
    ui.surveyRoom=null;
    for (const id of Object.keys(WALK)) delete WALK[id];
  }
  ui.compare=compare;
  if (!compare) $('grpSurv').open=true;
  renderPlayMode(S.survivalView);
  refresh();
}
function showStart() {
  rememberSurvivalPosition();
  if (ui.fullscreen) {
    ui.fullscreen=false;
    $('fullStage').hidden=true;
    document.body.classList.remove('full-on');
    $('btnFull').classList.remove('on');
    $('btnFull').textContent='⛶ 全屏';
  }
  closeRoom(false);
  closeBackpack();
  toast('');
  ui.surveyRoom=null;
  ui.menu=true;
  renderPlayMode(S.survivalView);
  $('startTitle').focus();
  poll();
}

async function newSurvival() {
  if (resettingSurvival || !window.confirm('新开一局会替换此服务器的当前生存存档。继续吗？')) return;
  resettingSurvival=true;
  startError=false;
  $('startStatus').textContent='正在生成新的生存地图…';
  $('startNew').disabled=$('startSurvival').disabled=$('startCompare').disabled=true;
  try {
    const result=await api('/ctl',{action:'survival_reset',confirm:true});
    if (!result.ok || result.saveError) throw new Error('RESET_FAILED');
    closeRoom(false);
    closeBackpack();
    ui.surveyRoom=null;
    campCart=null;
    for (const id of Object.keys(WALK)) delete WALK[id];
    survFlash=null;
    S.view=null;
    ui.room='hall';
    resettingSurvival=false;
    selectWorld(false);
  } catch {
    resettingSurvival=false;
    startError=true;
    $('startStatus').textContent='新地图保存失败，请再试一次。';
    if (!ui.menu) toast('新地图保存失败，请再试一次。');
    $('startNew').disabled=$('startSurvival').disabled=$('startCompare').disabled=false;
  }
}

$('startSurvival').onclick=()=>selectWorld(false);
$('startCompare').onclick=()=>selectWorld(true);
$('startNew').onclick=newSurvival;
$('btnMenu').onclick=$('btnMenuFull').onclick=showStart;
$('btnSurv').onclick=()=>selectWorld(false);
$('btnCompare').onclick=()=>selectWorld(!ui.compare);
// 说明书 / 家庭与住房：局内屏幕中央新 UI
const bindCenterDlg=(btnId,dlgId,renderFn)=>{
  const btn=$(btnId); if(btn) btn.onclick=()=>openCenterDlg(dlgId,renderFn);
  const dlg=$(dlgId); if(dlg) dlg.addEventListener('click',(e)=>{ if(e.target===dlg) dlg.close(); });
};
bindCenterDlg('btnExchange','exchangeDlg',renderExchangeDlg);
bindCenterDlg('btnBuild','buildDlg',renderBuildDlg);
bindCenterDlg('btnVillage','villageDlg',renderVillageDlg);
for (const id of ['exchangeDlg','buildDlg','villageDlg']) {
  const dlg=$(id);
  dlg.addEventListener('click',(e)=>{
    if (e.target === dlg) { dlg.close(); return; }
    const c=e.target.closest('button[data-close]'); if(c){ $(c.dataset.close).close(); return; }
    const b=e.target.closest('button[data-sk]');
    if(b && !b.disabled){
      api('/act',{mode:'survival',kind:b.dataset.sk,type:b.dataset.type}).then(r=>{
        toast(r.ok?'操作成功':(campCodes[r.code]??r.code??'未完成'));
        refresh();
        const rr=S.survivalView;
        renderExchangeDlg(rr); renderBuildDlg(rr); renderVillageDlg(rr);
      }).catch(()=>toast('操作未完成，请重试。'));
    }
  });
}
bindCenterDlg('btnManual','manualDlg',renderManual);
bindCenterDlg('btnHousing','housingDlg',renderHousing);
if($('manualClose')) $('manualClose').onclick=()=>$('manualDlg').close();
if($('housingClose')) $('housingClose').onclick=()=>$('housingDlg').close();
$('housingDlg').addEventListener('click',(e)=>{
  const family=e.target.closest('button[data-family]'); if(!family) return;
  const {family:kind,id:target,accept}=family.dataset;
  api('/act',{mode:'survival',kind,target,accept:accept==='true'}).then(r=>{
    toast(FAMILY_RESULT[r.code]??'办理失败');
    family.blur(); refresh();
    setTimeout(()=>renderHousing(S.survivalView),350);
  }).catch(()=>{ toast('无法登记，请重试。'); });
});
$('survPanel').addEventListener('click', (e) => {
  if (e.target.closest('#btnSurvReset')) { newSurvival(); return; }
  const family=e.target.closest('button[data-family]');
  if (family) {
    const {family:kind,id:target,accept}=family.dataset;
    api('/act',{mode:'survival',kind,target,accept:accept==='true'}).then(r=>{
      toast(FAMILY_RESULT[r.code]??'办理失败');
      family.blur();
      refresh();
    }).catch(()=>{ toast('无法登记，请重试。'); });
    return;
  }
  const coop=e.target.closest('button[data-coop]');
  if (coop) {
    api('/act',{mode:'survival',kind:'coop_request',target:coop.dataset.coop}).then((r)=>{
      survFlash={kind:'coop_request',ok:!!r.ok,code:r.decision ?? r.code ?? 'OK'};
      coop.blur(); refresh();
    });
    return;
  }
  const btn = e.target.closest('button[data-sk]'); if (!btn || btn.disabled) return;
  api('/act', { mode: 'survival', kind: btn.dataset.sk, type: btn.dataset.type }).then((r) => { survFlash = { kind: btn.dataset.sk, ok: !!r.ok, code: r.code ?? r.error ?? 'OK' }; refresh(); });
});
// 全屏全景：整张地图铺满屏幕，只画 A 世界；退出回退出前的视角。纯表现层，不动世界与读数。
function setFull(on) {
  ui.fullscreen = on;   // 保持当前视角（聚焦/室内/全景）原样放大，不切换视图
  $('fullStage').hidden = !on;
  document.body.classList.toggle('full-on', on);
  $('btnFull').classList.toggle('on', on);
  $('btnFull').textContent = on ? '⛶ 退出全屏' : '⛶ 全屏';
  refresh();
}
$('btnFull').onclick = () => setFull(!ui.fullscreen);
$('btnFullExit').onclick = () => setFull(false);
$('cvFull').addEventListener('click', (ev) => pickRoom(ev, $('cvFull')));
window.addEventListener('resize', () => { if (ui.fullscreen && S.view) draw($('cvFull'), S.view); });
// 点击画面：把屏幕坐标反算成世界 tile，再落到最近的地点（走过去 / 切换镜头）。
// 局部视角用相机偏移 + 整数倍缩放；全景用微缩比例。两个世界收到同一个动作。
function walkToEntrance(room) {
  outdoorIntent=null;
  const world=buildWorld(S.view), site=room==='grove'?world.groveEntrance:world.sites[room], e=world.homes3d?.entrances[room]??world.scene3d?.entrances[room];
  const walker=ensureWalker('cvA','p1',world,slotsOf(S.view,world.sites));
  if (!walker || !site) return;
  const goal=e ? [e.x+e.w/2-.5,e.z+e.d*.73-.5] : S.view.districts?.[room] ? [site[0]-1,site[1]] : site;
  const path=routeForWalker(world,walker,goal);
  if (!path) return;
  walker.path=path; walker.pi=0;
  if (room!=='grove') ui.room=room;
  ui.overview=false; ui.camRoom=null;
  refresh();
}
function walkInside(site,x,z,prop=null,exit=false) {
  if (!campRenderer || !S.soloSurv || campCart?.attached) return;
  const cell=4, tw=ROOM_GRID.width/cell, th=ROOM_GRID.height/cell;
  const cells=collisionEditor.cells(site), pixels=roomPixelWalk(site), bounds=roomBounds(site);
  const crowd=roomCrowd(S.view,site), walk=new Uint8Array(tw*th), goals=[];
  const start=[Math.floor((IPOS.x+8)/cell),Math.min(th-1,Math.floor((IPOS.y+16)/cell))];
  const [dx,dz,dw,dd]=roomDoor(site);
  for (let row=0;row<th;row+=1) for (let col=0;col<tw;col+=1) {
    const px=(col+.5)*cell,pz=(row+.5)*cell;
    if (!roomBodyFits(site,cells,pixels,bounds,px,pz) ||
        !cartAllows(site,cells,pixels,bounds,px,pz,px,pz,crowd) ||
        !separates(px/TILE,pz/TILE,px/TILE,pz/TILE,crowd)) continue;
    walk[row*tw+col]=1;
    const gap=prop?rectGap(px/TILE,pz/TILE,prop.x,prop.z,prop.w,prop.d):0;
    if ((prop && gap>PROP_REACH-.1) || (exit && rectGap(px,pz,dx,dz,dw,dd)>5)) continue;
    goals.push({col,row,distance:(px-x)**2+(pz-z)**2});
  }
  goals.sort((a,b)=>a.distance-b.distance);
  for (const {col,row,distance} of goals.slice(0,12)) {
    if (!prop && !exit && distance>14**2) break;
    const path=pixelPath({tw,th,walk},start,[col,row]);
    if (!path) continue;
    roomRoute={site,path:path.map(point=>point.map(v=>(v+.5)*cell)),index:0,prop:prop?.id,exit};
    return;
  }
  roomRoute=null;
  toast('这里走不过去，试试从另一侧靠近。');
}
function roomWaypoint() {
  if (!roomRoute || roomRoute.site!==ui.interior) return null;
  const {site,path,prop,exit}=roomRoute;
  while (roomRoute.index<path.length) {
    const [x,z]=path[roomRoute.index], dx=x-IPOS.x-8, dz=z-IPOS.y-16;
    if (Math.hypot(dx,dz)>.6) return [dx,dz];
    roomRoute.index+=1;
  }
  roomRoute=null;
  if (prop) {
    const target=roomProps(site).find(p=>p.id===prop);
    if (target && propDistance(target)<=PROP_REACH) inspectRoomProp(target);
  } else if (exit && atRoomDoor(site)) closeRoom();
  return null;
}

const SITE_NAMES={home:'居所',hall:'连廊',store:'公仓',workshop:'工坊',watch:'瞭望台',well:'井台',yard:'院子',garden:'菜园'};
const BUILDING_NAMES={granary:'储粮设施',workshop:'生产设施',shelter:'住所',wall:'防护设施'};
const ANIMAL_NAMES={bird:'林鸟',chickens:'鸡',cows:'牛',sheep:'羊',rabbit:'野兔',deer:'鹿',fox:'狐狸'};

function outdoorEntities(world,w,people,animals) {
  const entrances={...world.scene3d?.entrances,...world.homes3d?.entrances};
  const doors=Object.entries(entrances).map(([room,rect])=>({id:'door:'+room,kind:'door',room,rect,reach:.1,
    at:[rect.x+rect.w/2,rect.z+rect.d*.72],name:SITE_NAMES[room]??w.rooms?.[room]??room}));
  const timber=(world.timber?world.grove:[]).map(tree=>({id:'timber:'+tree.id,kind:'timber',target:tree.id,at:[tree.x,tree.z],
    reach:REACH.timber,tool:'axe',name:world.timber[tree.id]?.stage==='sapling'?'树苗':'伐木林的树'}));
  const plants=[...(world.life3d?.gatherables??[]),...(world.regional?.gatherables??[])].map(p=>({...p,kind:'plant',target:p.id,at:[p.x,p.z],reach:REACH.plant,
    tool:'basket',name:(p.item==='fruit'?(p.mature===false?'果树幼苗':'果树'):'浆果灌木')+` · 可采 ${p.ready}`}));
  const fields=world.beds.map(b=>{
    const rect={x:b.x/TILE,z:b.y/TILE,w:b.w/TILE,d:b.h/TILE};
    return {id:'plot:'+b.id,kind:'plot',bed:b,rect,at:[rect.x+rect.w/2,rect.z+rect.d/2],reach:REACH.plot,name:`第 ${b.id+1} 畦`};
  });
  const facilities=w.settlementLife ? (world.workProjects??[]).filter(p=>p.record.integrity>0 && p.gate && FACILITY_PROPS[p.record.type]).map(p=>{
    const rect=p.gate, room=facilityId(p.record);
    return {id:'door:'+room,kind:'door',room,rect,reach:.1,at:[rect.x+rect.w/2,rect.z+rect.d*.82],
      name:FACILITY_NAMES[p.record.type]};
  }) : [];
  const lots=ui.tool==='hammer' ? world.openLots.map(({loc,lot:rect})=>({
    id:'lot:'+loc,kind:'lot',target:loc,rect,at:[rect.x+rect.w/2,rect.z+rect.d/2],
    reach:1.15,tool:'hammer',name:'可施工地块',
  })) : [];
  const resources=Object.entries(w.districts??{}).map(([loc,{source:[x,z],resource}])=>({
    id:'resource:'+loc,kind:'resource',target:loc,rect:{x:x-.42,z:z-.42,w:.84,d:.84},at:[x,z],
    reach:1.15,tool:resource==='wood'?'axe':'pick',
    name:(resource==='wood'?'木料':'石料')+' · '+(w.resStock?.[loc]??0),
  }));
  const works=(world.workProjects??[]).filter(p=>p.record.type!=='house').map(p=>({
    id:p.id,kind:'work',target:p.id,room:p.record.loc,rect:p.lot,at:[p.lot.x+p.lot.w/2,p.lot.z+p.lot.d/2],
    reach:1.15,tool:'hammer',name:BUILDING_NAMES[p.record.type]??'工地',
  }));
  return [...doors,...facilities,...timber,...plants,...fields,...works,...lots,...resources,...people.filter(p=>p.who!=='p1'&&!w.agents?.[p.who]?.dead)
    .map(p=>({id:'resident:'+p.who,kind:'resident',target:p.who,at:[p.x,p.z],room:null,reach:REACH.resident,
      tool:'hand',name:w.agents?.[p.who]?.name??p.who,person:p})),
    ...animals.map(a=>({id:a.id,kind:a.kind==='bird'?'scenery':a.wild?'wildAnimal':'animal',target:a.id,at:[a.x,a.z],reach:REACH.animal,
      tool:a.wild?'basket':CAMP_TOOL[CAMP_ANIMAL_ITEM[a.kind]],item:CAMP_ANIMAL_ITEM[a.kind],name:ANIMAL_NAMES[a.kind]+(a.afraid?' · 受惊':a.wild && a.kind!=='bird'?` · 信任 ${w.wildTrust?.[a.id]?.trust??0}/4`:
        a.ready===undefined?'':` · 可收集 ${a.ready}`),labelHeight:a.kind==='bird'?3.9:undefined,animal:a}))];
}
const entityGap=(p,e)=>e.rect?distanceToRect(p,e.rect):distanceTo(p,e.at);

function visibleEntityHit(origin,ray,surfaces,maxDepth=Infinity) {
  let best=null,depth=maxDepth;
  for (const [box,entity] of surfaces) {
    const hit=rayBox(origin,ray,box);
    if (hit!==null && hit<depth) { depth=hit; best=entity && {entity,depth}; }
  }
  return best;
}

function pointedEntity(cv,ev) {
  const view=cv._cam, camera=view?.project3d;
  if (!camera || ui.surveyRoom || view.mode==='overview') return null;
  const rect=cv.getBoundingClientRect(), u=(ev.clientX-rect.left)/rect.width,v=(ev.clientY-rect.top)/rect.height;
  const sky=view.extended ? 54 : 24;
  const [x,z]=camera.ground(u,v,sky), origin=[x,sky,z], ray=camera.back.map(n=>-n);
  const surfaces=[];
  for (const boxes of view.regionDetails??[]) for (const b of boxes) {
    const id=b.occluder;
    if (id?.startsWith('wildtree:') && !view.covered.has(id)) {
      const [,x,z]=id.split(':');
      surfaces.push([b,{id,kind:'scenery',name:'树',at:[Number(x),Number(z)],labelHeight:b.y+b.h+.1}]);
    }
  }
  const push=(boxes,e)=>{for (const box of boxes) surfaces.push([box,e]);};
  if (view.site) {
    const [dx,dz,dw,dd]=roomDoor(view.site);
    push([{x:dx/TILE,z:dz/TILE,w:dw/TILE,d:dd/TILE,y:.045,h:.01}],
      {id:'exit:'+view.site,kind:'exit',at:[(dx+dw/2)/TILE,(dz+dd/2)/TILE],name:'出口'});
    for (const prop of roomProps(view.site)) push(prop.boxes,{...prop,kind:'prop',at:[prop.x+prop.w/2,prop.z+prop.d/2],
      name:ROOM_PROPS[prop.kind]?.[0]??prop.kind,prop});
    for (const p of view.people.filter(p=>p.who!=='p1')) push(actorBoxes(p,ACT.frame),{id:'resident:'+p.who,
      kind:'resident',target:p.who,at:[p.x,p.z],room:view.site,name:S.view.agents?.[p.who]?.name??p.who});
    const assigned=new Set(surfaces.map(([b])=>b));
    for (const box of view.stage.boxes) if (!assigned.has(box) && !view.covered.has(box.occluder)) surfaces.push([box,null]);
  } else if (view.exterior) {
    const w=cv.id==='cvB'?S.viewB:S.view, world=view.exterior;
    const entries=outdoorEntities(world,w,view.people,view.animals), ids=new Map(entries.map(e=>[e.id,e]));
    for (const e of entries) {
      if (e.person) push(actorBoxes(e.person,ACT.frame),e);
      if (e.animal) push(animalBoxes(e.animal,ACT.motionTime??0),e);
      if (e.kind==='plot' || e.kind==='door' || e.kind==='lot') {
        const {x,z,w,d}=e.rect;
        push([{x,z,w,d,y:(e.kind==='lot' && view.extended ? view.extended.height(...e.at) : view.stage.heightAt(...e.at))+.025,h:.008}],e);
      }
    }
    for (const b of [...view.stage.boxes,...(world.life3d?.boxes??[]),...(world.homes3d?.boxes??[]),...(world.regional?.boxes??[]),...view.work]) {
      if (view.covered.has(b.occluder)) continue;
      const [tag,id,type]=b.occluder?.split(':')??[];
      const e=ids.get(b.occluder)??(tag==='site'||tag==='roof'||tag==='work'&&type==='house'?
        (['yard','garden','hall'].includes(id)&&b.y===0&&b.h<=.22?null:ids.get('door:'+id)):
        tag==='work'?(ids.get(b.occluder)?.tool===ui.tool ? ids.get(b.occluder) :
          ids.get('door:facility:'+id+':'+type)??ids.get(b.occluder)):
        tag==='tree'?{id:b.occluder,kind:'scenery',at:[Number(id)+.5,Number(type)+.5],name:'树'}:null);
      surfaces.push([b,e??null]);
    }
  }
  const ground=view.extended ? terrainHit(origin,ray,view.extended.height,135) : Infinity;
  const hit=visibleEntityHit(origin,ray,surfaces,ground);
  if (!hit) return null;
  const point=origin.map((value,i)=>value+ray[i]*hit.depth);
  return outdoorSight(view,hit.entity,null,point)?hit.entity:null;
}

function outdoorSight(view,e,from,point) {
  if (!view?.visibility) return true;
  const [x,z]=e.at;
  const model=e.kind==='door' ? e.room.startsWith('facility:') ? 'work:'+e.room.slice(9)
    : view.exterior.homes3d?.entrances[e.room] ? 'work:'+e.room+':house' : 'site:'+e.room
    : e.kind==='plant' || e.kind==='work' ? e.target : e.id;
  if (point) return view.visibility.sees(point[0],point[2],point[1],model);
  if (!e.rect || !from) return view.visibility.sees(x,z,undefined,model);
  const {x:left,z:top,w,d}=e.rect;
  return view.visibility.sees(Math.max(left,Math.min(left+w,from[0])),Math.max(top,Math.min(top+d,from[1])),undefined,model);
}

function inspectWorkSite(title,options) {
  const dialog=$('campPropDialog'), action=$('campPropAction');
  $('campPropTitle').textContent=title;
  $('campPropText').textContent='';
  $('campPropDetail').hidden=true;
  const container=$('campPropOptions');
  container.replaceChildren();
  action.hidden=true;
  for (const [label,reason,run] of options) propOption(container,label,reason,()=>{
    dialog.close();
    void run();
  });
  keys.clear();
  if (!dialog.open) dialog.showModal();
}

async function useOutdoorEntity(e,from) {
  if (e.kind==='lot') {
    const s=S.view, bag=s.pinv.p1;
    inspectWorkSite(s.rooms?.[e.target]??'施工地块',Object.entries(s.buildingsDef??{}).map(([type,{label,cost}])=>[
      label+' · '+cost.wood+' 木 / '+cost.stone+' 石',
      bag.wood+s.inv.wood<cost.wood || bag.stone+s.inv.stone<cost.stone?'材料不足':'',
      ()=>performCamp({kind:'plan',type,target:e.target,from,tool:'hammer'}),
    ]));
    return;
  }
  if (e.kind==='resource') {
    if (e.tool!==ui.tool) { toast('需要'+TOOL_ZH[e.tool]+'。'); return; }
    await performCamp({kind:'gather',target:e.target,from,tool:e.tool});
    return;
  }
  if (e.kind==='resident') { await useResident({target:e.target,room:null,from,to:e.at}); return; }
  if (e.kind==='door') {
    if (e.room.startsWith('facility:') && ui.tool==='hammer') {
      const b=facilityOf(S.view,e.room);
      if (b && b.integrity<1) {
        await performCamp({kind:'repair',target:'work:'+b.loc+':'+b.type,from});
        return;
      }
    }
    const access=S.view.homeAccess?.[e.room];
    if (access?.resident && S.view.layout && ui.tool==='hoe') {
      const kind=S.view.homeRoads?.[e.room]?.present===false?'road_lay':'road_remove';
      const dialog=$('campPropDialog'), action=$('campPropAction');
      $('campPropTitle').textContent='住宅小路';
      $('campPropText').textContent=kind==='road_lay'?'铺设淡黄色小路需要一份石料。':'移除住宅门前的小路。';
      $('campPropDetail').hidden=true;
      $('campPropOptions').replaceChildren();
      action.hidden=false; action.textContent=kind==='road_lay'?'铺路':'移除小路';
      action.onclick=()=>{dialog.close();void performCamp({kind,room:e.room,from},null);};
      keys.clear();
      if (!dialog.open) dialog.showModal();
      return;
    }
    if (access?.resident && access.damage && ui.tool==='hammer') {
      await performCamp({kind:'home_fix',room:e.room,tool:ui.tool,from},null);
      return;
    }
    await enterRoom(e.room); return;
  }
  if (e.kind==='plot') { inspectPlot(e.bed); return; }
  if (e.kind==='work') {
    const wall=S.view.settlementLife && ui.tool==='hand' && S.view.buildings?.find(b=>b.type==='wall' && b.loc===e.room && b.integrity>0);
    if (wall) {
      const result=await api('/act',{mode:'survival',kind:'facility_use',target:facilityId(wall),from});
      toast(result.ok?`防护墙完整度 ${Math.round(result.integrity*100)}% · 正在减轻灾害损耗`:'无法检查防护墙。');
      return;
    }
    if (ui.tool!=='hammer') { toast('需要锤。');return; }
    const site=S.view.sites?.find(s=>s.loc===e.room && `work:${s.loc}:${s.type}`===e.target);
    const building=S.view.buildings?.find(b=>b.loc===e.room && `work:${b.loc}:${b.type}`===e.target);
    if (site || building?.integrity<1) {
      if (site && S.view.coop?.enabled) {
        inspectWorkSite(e.name,[
          ['施工','',()=>performCamp({kind:'build',target:e.target,from})],
          ...Object.values(S.view.agents??{}).filter(a=>!a.isPlayer && !a.dead && a.stage!=='child')
            .map(a=>['请'+a.name+'协助','',()=>performCamp({kind:'coop_request',target:a.id,site:e.target,from})]),
        ]);
      } else await performCamp({kind:site?'build':'repair',target:e.target,from});
      return;
    }
    toast(e.name+' · 当前没有可进行的施工。');
    return;
  }
  if (e.kind==='wildAnimal') {
    if (ui.tool!=='basket') { toast('拿篮子，慢慢靠近并投喂。');return; }
    const result=await performCamp({kind:'animal_feed',target:e.target,tool:'basket',from,to:e.at});
    if (result?.ok) toast(`投喂成功 · 信任 ${result.trust}/4`);
    return;
  }
  if (e.kind==='animal' && ui.tool==='axe') {
    const dialog=$('campPropDialog'), action=$('campPropAction');
    $('campPropTitle').textContent='屠宰'+ANIMAL_NAMES[e.animal.kind];
    $('campPropText').textContent='会惊吓同圈动物。受惊动物两天内停产，屠宰所得肉也会减少。';
    $('campPropOptions').replaceChildren(); $('campPropDetail').hidden=true;
    action.hidden=false;action.textContent='确认屠宰';
    action.onclick=()=>{
      dialog.close();
      const current=campHerds.get('cvA')?.find(a=>a.id===e.id), walker=WALK[walkKey('cvA','p1')];
      if (current && walker) void performCamp({kind:'animal_slaughter',target:e.id,tool:'axe',
        from:[walker.x+.5,walker.y+.5],to:[current.x,current.z]}).then(r=>{
        if(r?.ok) toast(`获得肉 ×${r.meat}`);
      });
    };
    keys.clear();
    if (!dialog.open) dialog.showModal();
    return;
  }
  if (e.tool!==ui.tool) { toast(`需要${TOOL_ZH[e.tool]}。`); return; }
  if (e.kind==='timber') await performCamp({kind:'camp_chop',target:e.target,tool:ui.tool,from});
  else await performCamp({kind:'camp_collect',target:e.target,type:e.item,tool:ui.tool,from,to:e.at});
}

function approachEntity(world,walker,e) {
  const from=[walker.x+.5,walker.y+.5];
  const candidates=e.kind==='door'?[e.at]:Array.from({length:8},(_,i)=>{
    const a=i*Math.PI/4, r=e.rect?0:e.reach*.75;
    return [e.at[0]+Math.cos(a)*(e.rect?e.rect.w/2+.25:r),e.at[1]+Math.sin(a)*(e.rect?e.rect.d/2+.25:r)];
  });
  candidates.sort((a,b)=>distanceTo(a,from)-distanceTo(b,from));
  const map=campBodyWorld(world,true);
  for (const p of candidates) {
    const goal=p.map(v=>v-.5);
    const outside=!inCamp(...p);
    if (entityGap(p,e)>e.reach || !(outside?exteriorAllows(world,...p):mapAllows(map,...goal))) continue;
    const path=routeForWalker(world,walker,goal);
    if (path) { walker.path=path;walker.pi=0;return true; }
  }
  return false;
}

function advanceOutdoorIntent(view,w,player) {
  const world=view.exterior;
  if (!outdoorIntent || !player || campBusy) return;
  const walker=WALK[walkKey('cvA','p1')], from=[player.x,player.z];
  const residents=Object.keys(w.agents??{}).flatMap(who=>{
    const actor=WALK[walkKey('cvA',who)];
    return actor?[{who,x:actor.x+.5,z:actor.y+.5}]:[];
  });
  const e=outdoorEntities(world,w,residents,
    campHerds.get('cvA')??[]).find(e=>e.id===outdoorIntent.id);
  if (!e) { outdoorIntent=null; toast('目标已离开。'); return; }
  if (entityGap(from,e)<=e.reach) {
    outdoorIntent=null;walker.path=[];walker.pi=0;walker.moving=false;
    if (outdoorSight(view,e,from)) void useOutdoorEntity(e,from);
    else toast('视线被挡住了，请换个位置。');
  } else if (walker.pi>=walker.path.length || performance.now()>outdoorIntent.deadline) {
    if (performance.now()>outdoorIntent.deadline || !approachEntity(world,walker,e)) {
      outdoorIntent=null;walker.path=[];walker.pi=0;
      toast('无法走到目标附近。');
    }
  }
}

function pickRoom(ev, cv) {
  if ($('worldMain').hidden || ui.surveyRoom || campPose) return;
  outdoorIntent=null;
  const hit=pointedEntity(cv,ev);
  if (ui.interior) {
    const site=ui.interior, rect=cv.getBoundingClientRect();
    const u=(ev.clientX-rect.left)/rect.width, v=(ev.clientY-rect.top)/rect.height;
    const projected=campPoint(cv,ev);
    const [lx,ly]=projected ? projected.map(n=>n*TILE) : [u*ROOM_GRID.width,v*ROOM_GRID.height];
    const side=hallSideAtFeet(site);
    if (side && ly>=98 && ly<=135 && (side==='home'?lx<=48:lx>=208)) {
      enterRoom(side);
      return;
    }
    if (hit?.kind==='exit') {
      const [x,z,w]=roomDoor(site);
      if (atRoomDoor(site)) closeRoom();
      else walkInside(site,x+w/2,z+2,null,true);
      return;
    }
    if (hit?.kind==='resident') {
      const from=[(IPOS.x+8)/TILE,(IPOS.y+16)/TILE];
      if (nearResident(from,hit.at)) void useResident({target:hit.target,room:site,from,to:hit.at});
      else toast('走近后再交谈。');
      return;
    }
    const props=roomProps(site);
    const prop=hit?.prop??(!cv._cam?.project3d?props.find(p=>rectGap(lx/TILE,ly/TILE,p.x,p.z,p.w,p.d)===0):null);
    if (prop) {
      if (propDistance(prop)<=PROP_REACH) inspectRoomProp(prop);
      else walkInside(site,(prop.x+prop.w/2)*TILE,(prop.z+prop.d/2)*TILE,prop);
    } else {
      const [x,z,w,d]=roomDoor(site);
      const exit=rectGap(lx,ly,x,z,w,d)<=4 || (site==='hall' && hallExitAt(hallFront,lx,ly));
      if (exit && atRoomDoor(site)) closeRoom();
      else walkInside(site,exit?x+w/2:lx,exit?z+2:ly,null,exit);
    }
    return;
  }
  const v = (campRenderer && cv.id === 'cvB' ? S.viewB : S.view) ?? {};
  const sites = sitesOf(v);
  const cam = cv._cam ?? lastCam;
  const rect = cv.getBoundingClientRect();
  let tx, ty;
  const projected=campPoint(cv,ev);
  if (projected) {
    [tx,ty]=projected;
  } else if (cam.mode === 'overview') {
    tx = ((ev.clientX - rect.left) / rect.width) * WORLD_TW;
    ty = ((ev.clientY - rect.top) / rect.height) * WORLD_TH;
  } else {
    tx = (cam.x + (ev.clientX - rect.left) / rect.width * VIEW_W) / TILE;
    ty = (cam.y + (ev.clientY - rect.top) / rect.height * VIEW_H) / TILE;
  }
  const world=buildWorld(v);
  const playerCanvas=projected && cv.id==='cvFull'?'cvA':cv.id;
  const walker=ensureWalker(playerCanvas,'p1',world,slotsOf(v,world.sites));
  if (!walker) return;
  if (S.soloSurv && hit && playerCanvas==='cvA' && hit.kind!=='scenery') {
    const from=[walker.x+.5,walker.y+.5];
    if (entityGap(from,hit)<=hit.reach && outdoorSight(cv._cam,hit,from)) void useOutdoorEntity(hit,from);
    else if (approachEntity(world,walker,hit)) {
      outdoorIntent={id:hit.id,deadline:performance.now()+45000};ui.overview=false;ui.camRoom=null;
    } else toast('无法走到目标附近。');
    return;
  }
  const entry=!projected&&entrySiteAt(sites,tx,ty);
  if (entry && playerCanvas==='cvA') { walkToEntrance(entry[0]);return; }
  const goal=[tx-.5,ty-.5];
  const path=routeForWalker(world,walker,goal);
  if (!path) return;
  walker.path=path; walker.pi=0;
  ui.overview=false; ui.camRoom=null;
  refresh();
}

// 无 WebGL 时用旧版像素场景的房屋位置。
function entrySiteAt(sites, tx, ty) {
  return Object.entries(sites).find(([r, [sx, sy]]) => {
    const left = r === 'garden' ? sx - .6 : sx - 3.4;
    const top = ['hall', 'well', 'yard', 'garden'].includes(r) ? sy - 7.5 : sy - 8.5;
    return tx >= left && tx <= sx + 3.4 && ty >= top && ty <= sy + 2;
  }) || null;
}
// 键盘：WASD / 方向键走路，E / Enter 进出建筑。输入框聚焦或带修饰键时不抢键。
const keys = new Set();
const KEY_DIR = { w: 'up', arrowup: 'up', s: 'down', arrowdown: 'down', a: 'left', arrowleft: 'left', d: 'right', arrowright: 'right' };
window.addEventListener('keydown', (e) => {
  if (ui.menu) return;
  // 只让真正的输入控件吞按键；按钮/summary 焦点不吞（点过按钮后键盘仍可用）
  if (collisionDialog.open || e.target.closest?.('input,textarea,select,[contenteditable]') ||
      e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if ($('campPropDialog').open) {
    if (k==='e' && !e.repeat) { e.preventDefault(); $('campPropDialog').close(); openBackpack(); }
    return;
  }
  if ($('backpack').open && !['e','escape'].includes(k)) return;
  if (campPose?.kind==='sleep') return;
  if (KEY_DIR[k] && campPose?.kind==='sit') campPose=null;
  if (k==='shift') { keys.add('sprint'); return; }
  if (KEY_DIR[k]) { keys.add(KEY_DIR[k]); e.preventDefault(); return; }
  if (k === 'escape') {
    if ($('backpack').open) { closeBackpack(); e.preventDefault(); return; }
    if (ui.fullscreen) { setFull(false); e.preventDefault(); }
    return;
  }
  if (S.soloSurv && (S.campReady?/^[1-8]$/:/^[1-8]$/).test(k)) {
    ui.tool = Object.keys(TOOL_ZH)[Number(k) - 1]; updateHotbar(); e.preventDefault(); return;
  }
  if (e.repeat) return;
  if (k==='e') { e.preventDefault(); $('backpack').open?closeBackpack():openBackpack(); return; }
  if (k === 'f' || k === 'enter') { e.preventDefault(); if (S.soloSurv) survInteract(); else toggleInteriorByKeyboard(); }
});
window.addEventListener('keyup',e=>{
  const key=e.key.toLowerCase();
  keys.delete(key==='shift'?'sprint':KEY_DIR[key]);
});
window.addEventListener('blur', () => keys.clear());
function toggleInteriorByKeyboard() {
  if (ui.surveyRoom) { returnFromSurvey(); return; }
  if (ui.interior) { useRoom(); return; }
  const room=survRoomAtFeet();
  if (room) enterRoom(room);
}

$('btnRun').onclick = () => ctl({ action: S.running ? 'pause' : 'resume' });
$('btnStep').onclick = () => ctl({ action: 'step' });
$('btnReset').onclick = () => {
  if (window.confirm('重置 A/B 对照世界？')) ctl({ action: 'compare_reset', confirm: true });
};
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
  const rq = new URLSearchParams(location.search).get('room');   // 深链进某室内（便于直达与验收）
  if (rq && Object.hasOwn(INTERIORS,rq)) { ui.interior = rq; ui.room = rq; ui.camRoom = rq; }
  poll();
  if (new URLSearchParams(location.search).get('full') === '1') setFull(true);   // 深链直达全屏全景（便于分享与验收）
  setInterval(poll, 900);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
  // 独立动画时钟：只推进帧号并重绘两个画布，与 900ms 的数据轮询完全解耦。
  // 不读 w.t、不发请求、不消费 rng、不写世界状态；A/B 共用同一帧号；
  // 后台标签页停绘，沿用「省额度 / 不空转」纪律。
  // 位置按浏览器渲染帧平滑推进，精灵换帧仍为6fps；两者均不依赖世界 tick。
  let lastPaint = null, elapsed = 0, lastSpriteFrame = -1;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  function animate(now) {
    requestAnimationFrame(animate);
    if (document.hidden || $('worldMain').hidden || collisionDialog.open || !S.view || !S.viewB) { lastPaint = null; return; }
    const dt = lastPaint === null ? 0 : Math.min(0.05, (now - lastPaint) / 1000); lastPaint = now; elapsed += dt; ACT.seconds=elapsed;
    ACT.frame = reduced.matches ? 0 : Math.floor(elapsed * ACT.fps) % 4;
    const changed = ACT.frame !== lastSpriteFrame; lastSpriteFrame = ACT.frame;
    const mdx = (keys.has('right') ? 1 : 0) - (keys.has('left') ? 1 : 0);
    const mdy = (keys.has('down') ? 1 : 0) - (keys.has('up') ? 1 : 0);
    ACT.motionTime=reduced.matches?0:elapsed;
    const mstep=SPEED*ACT.fps*dt, playerStep=mstep*(keys.has('sprint')?1.75:1);
    const repaint3d=changed || (!reduced.matches && Math.floor(elapsed*24)!==Math.floor((elapsed-dt)*24)) ||
      mdx || mdy || roomRoute || Object.values(WALK).some(walker=>walker.pi<walker.path?.length);
    // 室内：WASD 在房间地板范围内走动（撞墙停），走到下门自动出屋。
    if (ui.interior) {
      if (mdx || mdy) roomRoute=null;
      const routeMove=campPose?null:roomWaypoint();
      const [dx,dz]=routeMove??[mdx,mdy];
      if (!campPose && (dx || dz)) {
        const site=ui.interior, n=Math.hypot(dx,dz);
        const maxStep=playerStep*TILE*(campCart?.attached?.68:1), step=routeMove?Math.min(maxStep,n):maxStep;
        const cells=collisionEditor.cells(site), pixels=roomPixelWalk(site), bounds=roomBounds(site);
        const crowd=campRenderer?roomCrowd(S.view,site):[];
        const fits=campRenderer?(x,z,nx,nz)=>
          roomBodyFits(site,cells,pixels,bounds,nx,nz) &&
          cartAllows(site,cells,pixels,bounds,x,z,nx,nz,crowd) &&
          separates(x/TILE,z/TILE,nx/TILE,nz/TILE,crowd):undefined;
        const [footX, footY]=moveRoomFeet(cells,IPOS.x+8,IPOS.y+16,dx/n*step,dz/n*step,pixels,fits,bounds);
        IPOS.moving = footX !== IPOS.x + 8 || footY !== IPOS.y + 16;
        if (campCart?.attached && campCart.site===site) {
          campCart.x+=(footX-IPOS.x-8)/TILE;
          campCart.z+=(footY-IPOS.y-16)/TILE;
        }
        IPOS.direction=walkDirection(footX-IPOS.x-8,footY-IPOS.y-16,IPOS.direction);
        IPOS.x = footX - 8;
        IPOS.y = footY - 16;
        if (dx) IPOS.face=dx>0?1:-1;
        if (routeMove && step>.01 && !IPOS.moving) {
          roomRoute=null;
          toast('路上有障碍，换个方向试试。');
        }
        if (!campCart?.attached && atRoomDoor(ui.interior,true)) { closeRoom(); return; }
      } else IPOS.moving = false;
    }
    for (const k in WALK) {
      const walker = WALK[k];
      const cvId = k.slice(0, k.indexOf(':'));
      const who=k.slice(k.indexOf(':')+1), player=who==='p1', snapshot=cvId==='cvB'?S.viewB:S.view;
      if (ui.interior || ui.surveyRoom || (!ui.compare && cvId==='cvB') ||
          !Object.values(snapshot.occupancy??{}).some(ids=>ids.includes(who))) continue;
      const manual=player && (mdx || mdy);
      if (!manual && walker.pi>=walker.path.length) { walker.moving=false; continue; }
      const [dx,dy]=manual?[mdx,mdy]:walker.path[walker.pi].map((v,i)=>v-(i?walker.y:walker.x));
      const oldX=walker.x, oldZ=walker.y;
      if (manual) { walker.path=[]; walker.pi=0; outdoorIntent=null; }
      if (campRenderer) {
        const world=campWorlds.get(cvId);
        if (!world) continue;
        const trip=snapshot.districtTravel?.[who];
        const rate=trip?Math.max(mstep,(walker.tripSpeed??0)*dt*1000):mstep;
        stepCampWalker(world,walker,cvId,snapshot,dx,dy,manual?playerStep:rate,manual);
      } else if (manual) {
        const n=Math.hypot(dx,dy);
        const [x,y]=moveMapFeet(buildWorld(snapshot),walker.x,walker.y,dx/n*playerStep,dy/n*playerStep);
        walker.moving=x!==walker.x || y!==walker.y;
        walker.x=x; walker.y=y;
      } else stepWalker(walker,mstep);
      walker.direction=walkDirection(walker.x-oldX,walker.y-oldZ,walker.direction);
      if (dx) walker.face=dx>0?1:-1;
      if (changed && walker.moving && !reduced.matches) {
        (DUST[cvId] ??= []).push({ x: walker.x, y: walker.y + 0.8, age: 0 });
      }
    }
    if (changed) for (const cvId in DUST) DUST[cvId] = DUST[cvId].map(p => ({ ...p, age: p.age + 1 })).filter(p => p.age < 6);
    if (campRenderer && !repaint3d) return;
    if (ui.fullscreen) draw($('cvFull'), S.view);
    else { draw($('cvA'), S.view); draw($('cvB'), S.viewB); }
  }
  requestAnimationFrame(animate);
});
// 验收钩子补挂：WALK/ui 在模块后段声明，顶部对象字面量引用会 TDZ 炸掉整个模块
Object.assign(window.__lifeDebug, {
  WALK, ui, S,
  survFlash: () => survFlash,
  interact: () => survInteract(),
  pointedEntity,
  hallFront: () => structuredClone(hallFront),
  hallWalkable: (x,y) => roomAllows(collisionEditor.cells('hall'),x,y,roomPixelWalk('hall'),roomBounds('hall')),
});
