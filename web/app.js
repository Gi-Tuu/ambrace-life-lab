// 观察端。这里**不再有任何世界状态**：状态、调度、内部调节全在服务器（life/host.mjs）。
// 之前浏览器自己跑一套 sim，关标签页就归零 —— 那等于当面推翻「内部状态持续存在」这个主张。
import { astar, isWalkable, stepWalker } from './walk.mjs';
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

// 全套动作精灵 / 场景小动画：独立清单在 web/assets/actions/manifest.json（不动主 manifest schema）。
// 帧号由独立动画循环递增，A/B 严格共用同一个值；不读 w.t、不消费 rng、不写世界状态 ⇒ 不污染研究读数。
const ACT = { ready: false, chars: {}, portraits: {}, fx: null, index: {}, rows: {}, fps: 6, frame: 0 };
const ACTIONS_MANIFEST = '/web/assets/actions/manifest.json';

// 素材可选：没有 web/assets/manifest.json 就继续用程序化矩形（当前状态可用），有就自动替换。
// manifest 形状：{ chars: { a1: "url" | ["url","url"], ... }, tiles: { home: "url" }, icons: { energy: "url" } }
const ASSETS = { ready: false, chars: {}, tiles: {}, things: {}, icons: {}, scenes: {}, palette: [] };
async function loadAssets() {
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

const ui = { room: 'hall', camRoom: null, show: 'A', overview: false, interior: null, fullscreen: false, compare: false };

async function api(path, body) {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── 自然世界地图 ──────────────────────────────────────────────────────────────
// 引擎仍是「地点制」：w.rooms 是地点表、w.loc.p1 是玩家所在地点、w.occupancy 是各地点的人。
// 载荷字段一个不动；这里只在表现层把地点摆进一张连续的自然地形，用相机视口取局部放大画面。
// 全局依旧是完整一大片（1536×1024 逻辑像素），所有居民都在同一张图上跑，屏幕只是取景框。
const TILE = 16; // 寻路与布局单位；美术原生 32px，通过独立密度映射，避免改动世界坐标。
const ART = 2;
const WORLD_TW = 96, WORLD_TH = 64;
const WORLD_W = WORLD_TW * TILE, WORLD_H = WORLD_TH * TILE;   // 1536×1024
let VIEW_TW = 28, VIEW_TH = 14;                             // 常规视口上限 28×14 tile
let VIEW_W = VIEW_TW * TILE, VIEW_H = VIEW_TH * TILE;        // 视口逻辑像素，按地点和容器调整
const ZOOM = 2;                                                // 整数倍放大
const OV_W = 256, OV_H = 170;                                  // 全景微缩逻辑像素 → ×2 = 512×340 CSS
const OV_SX = OV_W / WORLD_W, OV_SY = OV_H / WORLD_H;         // 世界 → 全景的换算比例

// 避难聚落沿河两岸展开：西岸的居所与公仓由连廊相接，南侧是菜畦和物资棚；
// 土路跨桥通往东岸的井台、工坊与瞭台。地图坐标只属于表现层。
const SITES = {
  home: [22, 24], hall: [29, 24], store: [36, 24], yard: [20, 34],
  workshop: [61, 29], garden: [31, 39], watch: [67, 13], well: [50, 34],
};
const SITE_FALLBACK = [[22, 20], [34, 16], [52, 20], [64, 30], [26, 42], [46, 44], [70, 10], [56, 38]];
const SITE_THING = { home: 'beds', store: 'crates', workshop: 'bench', garden: 'bedsG', well: 'bucket' };
const ROAD_LINKS = [
  ['home','hall',[]],['hall','store',[]],['home','yard',[[22,28],[20,31]]],
  ['yard','garden',[[23,37]]],['hall','crossing',[[33,28],[37,32]]],
  ['garden','crossing',[[36,39],[38,37]]],['crossing','well',[]],
  ['well','workshop',[[55,35],[59,33]]],['workshop','watch',[[67,29],[71,23],[72,17],[70,14]]],
];

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
// 地表邻接只用于烘焙：像素材质图不参与寻路、视野或世界状态。
// 田畦是菜园的户外场景；地面、植物与避让共用同一份几何。
function farmBeds(sites) {
  if(!sites.garden)return [];
  const [x,y]=sites.garden;
  return [0,1].flatMap(row=>[0,1,2].map(col=>({x:(x-7+col*5)*TILE,y:(y+1+row*3)*TILE,w:4*TILE,h:2*TILE,row,col})));
}
const insideBed=(x,y,b,pad=0)=>x>=b.x-pad&&x<b.x+b.w+pad&&y>=b.y-pad&&y<b.y+b.h+pad;
const GROUND = { grass: 0, water: 1, bank: 2, road: 3, soil: 4 };
function paintTerrain(g, roadDist, sites) {
  const kinds = new Uint8Array(WORLD_W * WORLD_H);
  const waterDepth = new Float32Array(kinds.length), roadDepth = new Float32Array(kinds.length);
  const beds = farmBeds(sites);
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
    const center = riverX(y / TILE) * TILE + Math.sin(y * 0.07) * 3;
    const half = 17 + Math.sin(y * 0.021) * 3;
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
      pixels[offset] = texture ? texture[ti] : c[0]; pixels[offset + 1] = texture ? texture[ti + 1] : c[1]; pixels[offset + 2] = texture ? texture[ti + 2] : c[2]; pixels[offset + 3] = 255;
    }
  }
  g.putImageData(image, 0, 0);
  return kinds;
}
function paintForestFloor(g, trees, blockers, terrain) {
  const treeTiles = new Set(trees.map(([x, y]) => tileKey(x, y)));
  const image = g.getImageData(0, 0, WORLD_W * ART, WORLD_H * ART), pixels = image.data;
  for (const [tx, ty] of trees) for (let dy = -11; dy <= 11; dy += 1) for (let dx = -11; dx <= 11; dx += 1) {
    const x = tx * TILE + 8 + dx, y = ty * TILE + 10 + dy;
    if (x < 0 || y < 0 || x >= WORLD_W || y >= WORLD_H) continue;
    const i = y * WORLD_W + x, key = tileKey(Math.floor(x / TILE), Math.floor(y / TILE));
    if (terrain[i] !== GROUND.grass || (blockers.has(key) && !treeTiles.has(key))) continue;
    // 相邻树的圆形林下色块自然并接，边沿散点消退；不新增遮挡或不可行走格。
    const radius = Math.hypot(dx, dy * 1.15), q = BAYER[(y % 4) * 4 + x % 4];
    const coverage = radius < 6 ? 5 : radius < 9 ? 3 : radius < 11 ? 1 : 0;
    if (coverage === 0 || hash2(x, y, 15) > (radius < 6 ? .72 : .35)) continue;
    for (let sy = 0; sy < ART; sy++) for (let sx = 0; sx < ART; sx++) {
      const offset = ((y * ART + sy) * WORLD_W * ART + x * ART + sx) * 4;
      pixels[offset] = 63; pixels[offset + 1] = 112; pixels[offset + 2] = 54;
    }
  }
  g.putImageData(image, 0, 0);
}
// 视野暗化只映射到固定色阶；相邻可见格之间按实际像素距离过渡，避免方块切边。
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
let worldCache = null;
function buildWorld(w) {
  const sites = sitesOf(w);
  const sig = Object.keys(sites).join(',') + '|' + (ASSETS.ready ? 1 : 0);
  if (worldCache && worldCache.sig === sig) return { ...worldCache, sites };
  const cv = document.createElement('canvas');
  cv.width = WORLD_W * ART; cv.height = WORLD_H * ART;
  const g = cv.getContext('2d');
  g.setTransform(ART, 0, 0, ART, 0, 0); g.imageSmoothingEnabled = false;
  const blockers = new Set();
  // fx 锚点：树冠 / 烟囱 / 屋舍，世界 tile 坐标。场景动画必须贴在这些真实物件上，
  // 而不是随机撒点 —— 否则「草被吹动」会长到河面或屋顶上。
  const trees = [];
  const chimneys = [];
  // 高个可遮挡物（树 / 屋舍）不再烘进静态底图，而是各自记录为对象，交给 drawViewport 按脚底 Y 深度排序绘制。
  const objects = [];

  // 缓弯土路：共享入口与桥位，曲线只用于烘焙，不改变引擎地点关系。
  const roads=[],bins=new Map(),binSize=64;
  const addSegment=(a,b)=>{
    const r=[...a,...b];roads.push(r);
    for(let y=Math.floor((Math.min(a[1],b[1])-40)/binSize);y<=Math.floor((Math.max(a[1],b[1])+40)/binSize);y++)
      for(let x=Math.floor((Math.min(a[0],b[0])-40)/binSize);x<=Math.floor((Math.max(a[0],b[0])+40)/binSize);x++){
        const key=tileKey(x,y);if(!bins.has(key))bins.set(key,[]);bins.get(key).push(r);
      }
  };
  const routeSites={...sites};
  if(sites.well)routeSites.crossing=[Math.round(riverX(34))-4,34];
  const links=[...ROAD_LINKS];
  if(!sites.well&&sites.store&&sites.watch){routeSites.crossing=[Math.round(riverX(34))-4,34];links.push(['store','crossing',[[38,28]]],['crossing','watch',[[49,34],[61,32],[71,23],[72,17],[70,14]]]);}
  for(const [u,v,mids] of links){
    if(!routeSites[u]||!routeSites[v])continue;
    const points=[routeSites[u],...mids,routeSites[v]].map(p=>p.map(n=>n*TILE+8));
    for(let j=0;j<points.length-1;j++){
      const p0=points[Math.max(0,j-1)],p1=points[j],p2=points[j+1],p3=points[Math.min(points.length-1,j+2)];
      const steps=Math.max(1,Math.ceil(Math.hypot(p2[0]-p1[0],p2[1]-p1[1])/8));let prev=p1;
      for(let i=1;i<=steps;i++){
        const t=i/steps,pt=[0,1].map(k=>.5*((2*p1[k])+(-p0[k]+p2[k])*t+(2*p0[k]-5*p1[k]+4*p2[k]-p3[k])*t*t+(-p0[k]+3*p1[k]-3*p2[k]+p3[k])*t*t*t));
        addSegment(prev,pt);prev=pt;
      }
    }
  }
  const roadDist=(px,py)=>(bins.get(tileKey(Math.floor(px/binSize),Math.floor(py/binSize)))??[]).reduce((d,r)=>Math.min(d,distSeg(px,py,...r)),80);
  const onRoad=(tx,ty)=>roadDist(tx*TILE+8,ty*TILE+8)<23;
  const nearSite = (tx, ty, pad = 2) => Object.values(sites).some(([sx, sy]) => Math.abs(tx - sx) < pad && Math.abs(ty - sy) < pad);
  const onRiver = (tx, ty) => Math.abs(tx * TILE + 8 - riverX(ty) * TILE) < 34;

  // 1–3) 邻接材质统一烘焙草/土/水/岸/路；桥保持原来几何。
  const terrain = paintTerrain(g, roadDist, sites);
  // 草簇与野花只落在草地，避免覆盖路肩和岸线。
  for (let ty = 0; ty < WORLD_TH; ty += 1) for (let tx = 0; tx < WORLD_TW; tx += 1) {
    const px = tx * TILE, py = ty * TILE, h = hash2(tx, ty, 1);
    if (terrain[(py + 8) * WORLD_W + px + 8] !== GROUND.grass) continue;
    if (h > 0.72) { g.fillStyle = '#00E436'; g.fillRect(px + 4, py + 8, 1, 2); g.fillRect(px + 3, py + 7, 1, 1); }
    if (h > 0.97) { g.fillStyle = '#FFEC27'; g.fillRect(px + 10, py + 5, 1, 1); }
    else if (h < 0.02) { g.fillStyle = '#FF77A8'; g.fillRect(px + 7, py + 11, 1, 1); }
  }
  // 一次跨河对应一座完整木桥；同一组 bridgeCells 同时决定绘制与可走范围。
  const bridgeCells=new Set(),bridgeRows=[];
  for(let ty=1;ty<WORLD_TH-1;ty++)if(roadDist(riverX(ty+.5)*TILE,ty*TILE+8)<14)bridgeRows.push(ty);
  const groups=[];for(const y of bridgeRows){const last=groups.at(-1);if(last&&y<=last[1]+1)last[1]=y;else groups.push([y,y]);}
  for(const [first,last] of groups){
    const y0=first*TILE,y1=(last+1)*TILE,center=riverX((first+last+1)/2)*TILE;
    const x0=Math.floor((center-38)/TILE)*TILE,x1=Math.ceil((center+38)/TILE)*TILE;
    g.fillStyle='#514134';g.fillRect(x0,y0,x1-x0,y1-y0);
    for(let x=x0+1;x<x1-1;x+=5){g.fillStyle='#BA8752';g.fillRect(x,y0+2,4,y1-y0-4);g.fillStyle='#EDC787';g.fillRect(x,y0+2,1,y1-y0-4);}
    for(const y of [y0,y1-2]){g.fillStyle='#72513B';g.fillRect(x0,y,x1-x0,2);g.fillStyle='#D8A667';g.fillRect(x0,y,x1-x0,1);}
    for(let ty=first;ty<=last;ty++)for(let tx=x0/TILE;tx<x1/TILE;tx++)bridgeCells.add(tileKey(tx,ty));
  }

  // 成排菜畦、泥土垄沟和留出的通行埂；植株仅为环境表现，不捏造收获状态。
  const beds=farmBeds(sites);
  for(const b of beds){
    g.fillStyle='#72513B';g.fillRect(b.x,b.y,b.w,b.h);g.fillStyle='#BA8752';g.fillRect(b.x,b.y,b.w,1);
    for(let y=b.y+4;y<b.y+b.h-2;y+=7){
      g.fillStyle='#482D2B';g.fillRect(b.x+2,y+4,b.w-4,2);
      for(let x=b.x+5;x<b.x+b.w-2;x+=9){
        if(hash2(x,y,81)<.1)continue;
        g.fillStyle='#315431';g.fillRect(x-2,y,5,3);g.fillRect(x,y-3,2,5);
        g.fillStyle=b.col===2?'#D6AE69':'#98BD51';g.fillRect(x-3,y-1,3,1);g.fillRect(x+1,y-2,3,1);
        g.fillStyle='#73A747';g.fillRect(x-1,y-2,2,2);
        if(b.col===1){g.fillStyle='#D27A4A';g.fillRect(x+1,y+1,2,2);}
      }
    }
    for(const x of [b.x-1,b.x+b.w]){g.fillStyle='#514134';g.fillRect(x,b.y,1,b.h);}
  }
  const watch = sites.watch ?? SITES.watch;
  for (let ty = watch[1] - 6; ty <= watch[1] + 6; ty += 1) for (let tx = watch[0] - 8; tx <= watch[0] + 8; tx += 1) {
    if (onRoad(tx, ty)) continue;
    const d = Math.hypot((tx - watch[0]) / 7, (ty - watch[1]) / 5);
    if (d > 1.25 || (d <= 1 && hash2(tx, ty, 3) > 0.82)) continue;
    const px = tx * TILE, py = ty * TILE;
    if (d > 1) { if (hash2(tx, ty, 3) > 0.55) { g.fillStyle = '#6D7165'; g.fillRect(px + 6, py + 7, 4, 3); } continue; }
    const boulder = ASSETS.scenes.prop_boulder;
    if (boulder) g.drawImage(boulder, px - 2, py - 4, 20, 20);
    blockers.add(tileKey(tx, ty));
  }

  // 5) 树林：边缘密、村落内部疏；避开道路、河、田、岩与屋舍。树冠双 tone + 树干。
  for (let ty = 0; ty < WORLD_TH; ty += 1) for (let tx = 0; tx < WORLD_TW; tx += 1) {
    if (onRoad(tx, ty) || onRiver(tx, ty) || blockers.has(tileKey(tx, ty))) continue;
    const edge = Math.min(tx, WORLD_TW - 1 - tx, ty, WORLD_TH - 1 - ty);
    const density = edge < 6 ? 0.20 : edge < 14 ? 0.10 : 0.038;
    if(trees.some(([x,y])=>Math.hypot(x-tx,(y-ty)*1.25)<2.8)||beds.some(b=>insideBed(tx*TILE+8,ty*TILE+8,b,28)))continue;
    if (hash2(tx, ty, 4) > density || nearSite(tx, ty, 4) || Object.values(sites).some(([sx, sy]) => Math.abs(tx - sx) < 5 && ty > sy - 10 && ty < sy + 1)) continue;
    blockers.add(tileKey(tx, ty));
    trees.push([tx, ty]);
    objects.push({ kind: 'tree', tx, ty });
  }

  paintForestFloor(g, trees, blockers, terrain);

  // 6) 建筑群：居所—连廊—公仓共线相接；其余地点按各自用途绘制设施；
  //    屋前摆对应设施 sprite。屋舍挡视线，周边留空地给角色站。
  const ROOF = ['#7E2553', '#AB5236', '#1D2B53', '#FF004D', '#5F574F', '#008751', '#83769C', '#FFA300'];
  Object.entries(sites).forEach(([r, [sx, sy]], i) => {
    for (let dx = -4; dx <= 3; dx += 1) for (let dy = -8; dy <= -2; dy += 1) {
      if(r==='hall' && dy>-6)continue; // 连廊腹部可通行；顶梁后方遮挡视线。
      if(['well','yard','garden'].includes(r) && (dx<0 || dy<-6))continue;
      blockers.add(tileKey(sx+dx,sy+dy));
    }
    const chimney = r === 'workshop';
    // 屋舍几何 / 屋顶色 / 门前设施 / 栅栏 / 烟囱，全部记录为对象，绘制交给 drawHouseObj（视口）与全景简化块。
    objects.push({
      kind: 'house', site: r, sx, sy, roof: ROOF[i % ROOF.length],
      thing: SITE_THING[r], fence: r === 'yard' || r === 'well', chimney,
    });
    if (chimney) chimneys.push([sx + 1, sy - 6]);
  });

  // 可行走栅格：非阻挡（树/岩/屋）且（非河面 或 正落在桥上）。供 web/walk.mjs 的 A* 直接读取。
  const walk = new Uint8Array(WORLD_TW * WORLD_TH);
  for (let ty = 0; ty < WORLD_TH; ty += 1) for (let tx = 0; tx < WORLD_TW; tx += 1) {
    let ok = !blockers.has(tileKey(tx, ty));
    if(ok){const px=tx*TILE+8,py=ty*TILE+8;const water=terrain[py*WORLD_W+px]===GROUND.water||terrain[py*WORLD_W+px]===GROUND.bank;
      if(water)ok=bridgeCells.has(tileKey(tx,ty));
    }
    walk[ty * WORLD_TW + tx] = ok ? 1 : 0;
  }

  worldCache = { sig, canvas: cv, groundPixels: g.getImageData(0, 0, cv.width, cv.height).data, shadeTiles: new Map(), shadeColors: new Map(), blockers, roads, bridgeCells, beds, trees, chimneys, objects, walk, tw: WORLD_TW, th: WORLD_TH };
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
    }else if(o?.kind==='tree'){
      const image=ASSETS.scenes[`tree_oak${Math.floor(hash2(o.tx,o.ty,6)*3)}`];
      if(image)layer.contact(image,o.tx*TILE-cam.x-24,o.ty*TILE-cam.y-64,.5,cast);
    }else if(d.who){
      const x=Math.round((d.wx*TILE-cam.x)*cam.zoom)/cam.zoom,y=Math.round((d.wy*TILE-cam.y)*cam.zoom)/cam.zoom;
      layer.feet(x+8,y+15);
    }
  }
  layer.finish();
}
function drawTreeObj(g, o, cam) {
  const px = o.tx * TILE - cam.x, py = o.ty * TILE - cam.y;
  const image = ASSETS.scenes[`tree_oak${Math.floor(hash2(o.tx, o.ty, 6) * 3)}`];
  if (image) g.drawImage(image, px - 24, py - 64, 64, 80);
}
function drawHouseObj(g, o, cam) {
  const bx = (o.sx - 4) * TILE - cam.x, by = (o.sy - 9) * TILE - cam.y;
  const image = ASSETS.scenes[`house_${o.site}`];
  if (image) g.drawImage(image, bx, by, 128, 128);
  if (o.fence && o.site==='yard') {
    g.fillStyle = '#72513B';
    for (let i = 0; i < 6; i++) { g.fillRect(bx - 6 + i * 13, by + 123, 2, 7); g.fillStyle = '#D8A667'; g.fillRect(bx - 6 + i * 13, by + 123, 1, 6); g.fillStyle = '#72513B'; }
    g.fillRect(bx - 6, by + 126, 126, 1);
  }
}
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
function drawResident(g, who, action, x, y, facing = 'down') {
  const sheet = ACT.chars[who], size = ACT.size ?? [16, 24], directions = ACT.directions ?? ['down'];
  const direction = Math.max(0, directions.indexOf(facing));
  const row = action * directions.length + direction;
  if (ACT.ready && sheet) g.drawImage(sheet, ACT.frame * size[0], row * size[1], size[0], size[1], x, y - 8, 16, 24);
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
// isWalkable / astar / stepWalker 都在 web/walk.mjs（纯函数、可单测）。这里只保留行走器状态表与接线。
function ensureWalker(cvId, who, world, slots) {
  const auth = slots[who];
  if (!auth) return null;
  const k = walkKey(cvId, who);
  let s = WALK[k];
  if (!s) { s = WALK[k] = { x: auth[0], y: auth[1], path: [], pi: 0, moving: false, face: 1, auth: [auth[0], auth[1]] }; return s; }
  if (s.auth[0] !== auth[0] || s.auth[1] !== auth[1]) {   // 引擎把人挪了 ⇒ 走回认定地点
    s.auth = [auth[0], auth[1]];
    s.path = astar(world, [s.x, s.y], auth) || [];
    s.pi = 0;
  }
  return s;
}
let camFollow = null;   // A 侧玩家行走位置，供两个画布共用同一镜头（保持对照同框）
// 脚步尘：每个画布一小撮瞬态粒子，纯渲染层，由动画循环推进/老化；不入世界状态、不消费 rng。
const DUST = {};        // cvId -> [{x, y, age}]（tile 坐标）

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
  for (const o of world.objects) {
    const footTy = o.kind === 'house' ? o.sy - 1 : o.ty;
    const footTx = o.kind === 'house' ? o.sx : o.tx;
    const fy = (footTy + 1) * TILE - cam.y;
    if (fy < -2 * TILE || fy > VIEW_H + 8 * TILE) continue;
    const seen=o.kind==='house'?[-4,-3,-2,-1,0,1,2,3,4].some(dx=>visible.has(tileKey(footTx+dx,footTy))):visible.has(tileKey(footTx,footTy));
    if(!seen)continue;
    drawables.push({ sy: fy, o });
  }
  for (const who of Object.keys(slots)) {
    const s = WALK[walkKey(cv.id, who)];
    const wx = s ? s.x : slots[who][0], wy = s ? s.y : slots[who][1];
    if (!visible.has(tileKey(Math.round(wx), Math.round(wy)))) continue;
    drawables.push({ sy: (wy + 1) * TILE - cam.y, who, wx, wy, moving: s && s.moving, face: s ? s.face : 1 });
  }
  drawables.sort((a, b) => a.sy - b.sy);
  drawGroundShadows(g,drawables,cam,w.phase);
  for (const d of drawables) {
    if (d.o) {
      if (d.o.kind === 'tree') drawTreeObj(g, d.o, cam);
      else drawHouseObj(g, d.o, cam);
      continue;
    }
    const px = Math.round((d.wx * TILE - cam.x) * cam.zoom) / cam.zoom, py = Math.round((d.wy * TILE - cam.y) * cam.zoom) / cam.zoom;
    const row = d.moving ? (ACT.index.move_to ?? ACT.index.walk ?? actionRow(w.agents?.[d.who])) : actionRow(w.agents?.[d.who]);
    const walker = WALK[walkKey(cv.id, d.who)];
    drawResident(g, d.who, row, px, py, walker?.direction ?? 'down');
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
      if (Math.abs((x + 0.5) * TILE - riverX(y) * TILE) < 16) continue;
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
  // 地点名牌：屋舍进入视野时挂牌（黑底 + 1px 描边 + 白字），不写进图片。
  for (const [r, [sx, sy]] of Object.entries(world.sites)) {
    if(![-4,-3,-2,-1,0,1,2,3,4].some(dx=>visible.has(tileKey(sx+dx,sy-1))))continue;
    const label = (w.rooms ?? LOCS)[r] ?? r;
    const bw = label.length * 6 + 6;
    // 名牌夹在视口内，避免贴近边界时被裁半截；始终挂在屋舍上方。
    const bx = Math.max(2, Math.min(VIEW_W - bw - 2, sx * TILE - cam.x - bw / 2));
    const by = Math.max(2, Math.min(VIEW_H - 11, (sy - 9) * TILE - cam.y));
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
const INTERIORS = {
  home: { props: [['bed',2,2],['hearth',10,2],['table',7,4],['rug',6,6],['shelf',2,7],['planter',11,7]] },
  hall: { props: [['bench',4,4],['banner',10,2]] },
  store: { props: [['shelf',2,2],['shelf',7,2],['crate',11,3],['crate',2,7],['crate',7,7],['barrel',11,7]] },
  watch: { props: [['telescope',4,4],['crate',10,6],['banner',2,2],['barrel',11,2],['rug',6,7]] },
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
    drawProp(g,'barrel',178,1);drawProp(g,'bucket',204,119);drawProp(g,'trellis',22,-9);
  }else if(site==='well'){
    g.fillStyle='#939584';g.fillRect(71,59,114,86);
    for(let y=62;y<143;y+=12){g.fillStyle='#6D7165';g.fillRect(73,y,110,1);}
    drawProp(g,'well',94,57);drawProp(g,'bucket',151,100);drawProp(g,'barrel',35,93);drawProp(g,'barrel',190,45);
  }else{
    drawProp(g,'cart',49,66);drawProp(g,'crate',153,49);drawProp(g,'barrel',191,89);drawProp(g,'workbench',147,91);
  }
  for(const x of [5,61,176])drawProp(g,'fence',x,144);
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
  g.fillStyle='#72513B';g.fillRect(0,148,101,3);g.fillRect(155,148,101,3);
  g.fillStyle='#BA8752';g.fillRect(102,146,52,30);g.fillStyle='#EDC787';g.fillRect(102,153,52,1);g.fillRect(102,162,52,1);
}
function roomNavigation(g,w,site){
  if(site!=='hall')return;
  g.font='6px fusion-pixel, monospace';
  for(const [room,x,label] of [['home',0,'← 居所'],['store',218,'公仓 →']])if(w.rooms?.[room]){
    g.fillStyle='#514134';g.fillRect(x,104,38,22);g.fillStyle='#EDC787';g.fillRect(x,104,38,1);g.fillStyle='#FFF0CC';g.fillText(label,x+4,118);
  }
}
function drawInterior(cv, w, site) {
  const VIEW_W = 256, VIEW_H = 192;
  const spec = INTERIORS[site] ?? INTERIORS.hall, outdoor=['garden','well','yard'].includes(site);
  const zoom = ui.fullscreen ? fullZoom(VIEW_W, VIEW_H) : Math.max(1, Math.min(ZOOM, Math.floor(((cv.parentElement?.clientWidth || VIEW_W * ZOOM + 20) - 20) / VIEW_W)));
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
  const doorX = VIEW_W / 2 - TILE, doorY = VIEW_H - TILE;
  g.fillStyle = '#514134'; g.fillRect(doorX, doorY, TILE * 2, TILE); g.fillStyle = '#BA8752'; g.fillRect(doorX + 2, doorY + 2, TILE * 2 - 4, TILE - 4);
  g.fillStyle = '#000000'; g.fillRect(doorX + TILE - 1, doorY + 4, 2, 8);
  g.font = '6px fusion-pixel, monospace';
  // 房名
  const label = (w.rooms ?? LOCS)[site] ?? site;
  g.fillStyle = '#000000'; g.fillRect(VIEW_W / 2 - label.length * 3 - 4, 6, label.length * 6 + 8, 11);
  g.fillStyle = '#FFF1E8'; g.fillText(label, VIEW_W / 2 - label.length * 3, 14);
  // 家具与人按脚底深度排序，室内也遵守近遮远。
  const occ = w.occupancy?.[site] ?? [];
  if (IPOS.site !== site) { IPOS.site = site; IPOS.x = 120; IPOS.y = 150; IPOS.moving = false; IPOS.direction = 'down'; }
  const spots = [[6,8],[9,8],[5,5],[9,5],[4,9],[11,9],[6,10],[8,10]];
  const items = (outdoor?[]:spec.props).map(([kind, x, y]) => ({ kind, x, y, depth: kind === 'rug' ? -1 : y + 4 }));
  occ.forEach((who, i) => {
    if (who === 'p1') { items.push({ who, x: IPOS.x / TILE, y: IPOS.y / TILE, depth: IPOS.y / TILE + 1 }); return; }
    const [x, y] = spots[i % spots.length]; items.push({ who, x, y, depth: y + 1 });
  });
  if (!occ.includes('p1')) items.push({ who: 'p1', x: IPOS.x / TILE, y: IPOS.y / TILE, depth: IPOS.y / TILE + 1 });
  items.sort((a, b) => a.depth - b.depth);
  drawGroundShadows(g,items.filter(item=>item.who).map(item=>({who:item.who,wx:item.x,wy:item.y})),{x:0,y:0,zoom},w.phase);
  for (const item of items) {
    const px = item.x * TILE, py = item.y * TILE;
    if (item.kind) { drawProp(g, item.kind, px, py); continue; }
    const isP1 = item.who === 'p1';
    const act = isP1 && IPOS.moving ? (ACT.index?.move_to ?? ACT.index?.walk ?? actionRow(w.agents?.p1)) : actionRow(w.agents?.[item.who]);
    drawResident(g, item.who, act, px, py, isP1 ? IPOS.direction : 'down');
    g.fillStyle = '#FFF0CC'; g.fillText(isP1 ? '你' : (w.agents?.[item.who]?.name ?? item.who), px, py + TILE + 6);
  }
  const light=toneScene(g,cv,w.phase,!outdoor&&site!=='hall');
  if(!outdoor){
    for(const x of site==='hall'?[61,189]:[31,216]){
      g.fillStyle='#514134';g.fillRect(x,37,7,12);warmLamp(g,x+1,40,5,7,light);
    }
  }
  g.font='6px fusion-pixel, monospace';g.fillStyle='#514134';g.fillRect(99,174,58,15);
  g.fillStyle='#FFF0CC';g.fillText(outdoor?'返回营地':'点门离开',111,184);
  g.fillStyle='#514134';g.fillRect(103,5,50,13);g.fillStyle='#FFF0CC';g.fillText(label,128-label.length*3,14);
  roomNavigation(g,w,site);
  return { mode: 'interior', site };
}

function draw(cv, w) {
  cv._anim = ACT.frame;   // 渲染元数据：验收可核对 A/B 是否共用同一动画帧号
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
  const rooms = Object.keys(pack.rooms ?? LOCS);
  el.innerHTML = rooms.map((r) => {
    const n = (pack.occupancy[r] ?? []).length;
    return `<button data-room="${esc(r)}" class="${(ui.interior ? ui.interior === r : r === ui.room) ? 'on' : ''}">${esc((pack.rooms ?? LOCS)[r] ?? r)}<span class="n">${n}</span></button>`;
  }).join('');
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
let survOpen = true;
let survFlash = null;
const SURV_CODE_ZH = { OK: '成功', NO_MATURE: '没有成熟的菜畦', NO_EMPTY_PLOT: '没有空畦', NO_WATER: '水不够', NOT_GARDEN: '得在菜园', NOT_OUTDOOR: '得在户外', OCCUPIED: '当前地点已占用', NO_MATERIAL: '材料不够', NO_SITE: '当前地点没有工地', NO_REPAIR: '当前地点没有损坏建筑', NO_LOC: '未知地点', UNKNOWN_KIND: '未知动作', EMPTY: '公仓空了' };
function renderSurv(s) {
  const el = $('survPanel'); if (!el || !s) return;
  const b = s.buildingsDef || {};
  const bl = (t) => esc(b[t]?.label ?? t);
  const here = s.loc?.p1;
  const outdoor = (s.outdoor ?? []).includes(here);
  const inGarden = here === 'garden';
  const mature = s.plots.some((p) => p.growth >= 1);
  const empty = s.plots.some((p) => p.growth === 0);
  const siteHere = s.sites.some((x) => x.loc === here);
  const dmgHere = s.buildings.some((x) => x.loc === here && x.integrity < 1);
  const why = {
    harvest: !inGarden ? '得在菜园' : mature ? '' : '没有成熟的菜畦',
    plant: !inGarden ? '得在菜园' : !empty ? '没有空畦' : s.water >= 0.1 ? '' : '水不够',
    gather: outdoor ? '' : '得在户外',
    build: siteHere ? '' : '当前地点没有工地（先奠基）',
    repair: dmgHere ? '' : '当前地点没有损坏建筑',
  };
  const planWhy = (t) => !outdoor ? '得在户外' : (siteHere || s.buildings.some((x) => x.loc === here)) ? '当前地点已占用' : (s.inv.wood >= (b[t]?.cost.wood ?? 0) && s.inv.stone >= (b[t]?.cost.stone ?? 0)) ? '' : '材料不够';
  const btn = (sk, label, reason) => `<button data-sk="${sk}"${reason ? ` disabled title="${esc(reason)}"` : ''}>${label}</button>`;
  const flash = survFlash ? `<span class="${survFlash.ok ? 'good' : 'bad'}">${esc(survFlash.kind)}：${esc(SURV_CODE_ZH[survFlash.code] ?? survFlash.code)}</span>` : '';
  const banner = s.failed ? '<div class="survbanner bad">聚落饿垮了。点「重新开始」再来一局。</div>' : s.won ? `<div class="survbanner good">活到了第 ${s.targetDays} 天，聚落站住了！</div>` : '';
  el.innerHTML = `
    ${banner}
    <div class="survrow"><b>第 ${s.day}/${s.targetDays} 天 · ${esc(s.phase)} ${esc(s.weather ?? '')}</b>
      <span>粮 ${s.store}/${s.storeCap}</span><span>水 ${s.water}</span><span>土 ${s.soil}</span>
      <span>木 ${s.inv.wood} 石 ${s.inv.stone}</span>${flash}</div>
    <div class="survrow">你在 <b>${esc((s.rooms ?? {})[here] ?? here)}</b>${outdoor ? '（户外）' : '（室内）'}
      ${Object.entries(s.rooms ?? {}).map(([k, label]) => `<button data-mv="${k}" class="mv${k === here ? ' on' : ''}">${esc(label)}</button>`).join('')}</div>
    <div class="survrow">菜畦 ${s.plots.map((p) => `[${p.id}:${p.growth >= 1 ? '熟' : p.growth}]`).join(' ')}</div>
    <div class="survrow">建筑 ${s.buildings.map((x) => `${bl(x.type)}@${esc((s.rooms ?? {})[x.loc] ?? x.loc)}${x.integrity < 1 ? '(损)' : ''}`).join('、') || '无'} ｜ 工地 ${s.sites.map((x) => `${bl(x.type)}@${esc((s.rooms ?? {})[x.loc] ?? x.loc)}`).join('、') || '无'}</div>
    <div class="survrow">合作 ${s.coop.enabled ? '开' : '关'} ｜ 任务 ${s.coop.task ? `${bl(s.coop.task.type)}·${esc(s.coop.task.phase)}·${s.coop.task.workers.length}人` : '无'} ｜ 完工 ${s.coop.completions.length} ｜ 拒绝 ${s.coop.refusals} ｜ 重规划 ${s.coop.replans}</div>
    <div class="survrow survbtns">
      ${btn('harvest', '收获', why.harvest)}${btn('plant', '播种', why.plant)}${btn('gather', '采集', why.gather)}${btn('build', '施工', why.build)}${btn('repair', '维修', why.repair)}
      ${Object.keys(b).map((t) => `<button data-sk="plan" data-type="${t}"${planWhy(t) ? ` disabled title="${esc(planWhy(t))}"` : ''}>奠基${bl(t)}</button>`).join('')}
      ${s.failed || s.won ? '<button id="btnSurvReset">重新开始</button>' : ''}
    </div>
    <div class="survrow">${s.log.slice(-6).map((l) => `t${l.t} ${esc(l.kind)} ${l.ok ? '✓' : esc(SURV_CODE_ZH[l.code] ?? l.code)}`).join(' ｜ ')}</div>`;
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
    const sv = j.survival;
    S.soloSurv = !ui.compare && !!sv;
    document.body.classList.toggle('surv-mode', S.soloSurv);
    const viewA = S.soloSurv ? sv : j.A;
    S.view = viewA;
    if (ui.fullscreen) draw($('cvFull'), viewA);
    else { draw($('cvA'), viewA); draw($('cvB'), j.B); }
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
    $('btnOverview').classList.toggle('on', ui.overview);
    $('btnOverview').textContent = ui.overview ? '返回局部视角' : '世界全景';
    const fi = $('fullInfo');
    if (fi) fi.textContent = `拥爱生命实验室 · 全屏${ui.interior ? '室内' : ui.overview ? '全景' : ''} · 第 ${j.A.t} 刻 · ${j.A.phase ?? ''} · 视野 ${lightRadius(j.A.phase)} 格`;
    const vi = $('visionInfo');
    if (vi) vi.textContent = S.soloSurv
      ? `世界 ${WORLD_TW}×${WORLD_TH} 格 · 点地点移动 · 面板按钮行动 · 全景/全屏可用`
      : ui.interior
        ? `室内 · ${(viewA.rooms ?? LOCS)[ui.interior] ?? ui.interior} · E / 点门 离开`
        : `世界 ${WORLD_TW}×${WORLD_TH} 格 · 视口 ${VIEW_TW}×${VIEW_TH} 格 · 视野 ${lightRadius(viewA.phase)} 格（${viewA.phase ?? ''}）· WASD/方向键 移动 · E/点建筑 进出`;
    $('titA').textContent = S.soloSurv ? '生存 · 单世界' : 'A · 通道开';
    $('tagline').textContent = S.soloSurv ? '生存聚落：种地喂饱大家，AI 邻居合作建房；活到第 10 天。' : '同一颗种子、两个世界：左边内部状态参与决策，右边切断。';
    $('tbl').innerHTML = table(j.A, j.B);
    const sp = $('survPanel'); if (sp) sp.hidden = !survOpen;
    $('btnSurv').classList.toggle('on', survOpen);
    renderSurv(j.survival);
    const onLayers = Object.entries(S.masks ?? {}).filter(([, v]) => v).map(([k]) => (k === 'm3' ? 'M3 承诺' : 'M4 耦合'));
    $('tagA').textContent = S.soloSurv
      ? `第 ${sv.day}/${sv.targetDays} 天 · ${sv.phase} · ${sv.weather ?? ''} · 粮 ${sv.store}/${sv.storeCap}`
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
  const r = b.dataset.room;
  if (S.soloSurv) { ui.room = r; ui.camRoom = r; }                 // 生存单世界：只移镜头，不进室内
  else if (ui.interior === r) { ui.interior = null; ui.camRoom = r; }   // 再点当前房间 = 出门
  else { ui.interior = r; ui.room = r; ui.camRoom = r; }            // 进入该地点室内
  refresh();
});
$('btnOverview').onclick = () => { if (ui.interior) { ui.interior = null; ui.camRoom = ui.room; } else ui.overview = !ui.overview; refresh(); };
$('btnSurv').onclick = () => { survOpen = !survOpen; $('survPanel').hidden = !survOpen; $('btnSurv').classList.toggle('on', survOpen); refresh(); };
$('btnCompare').onclick = () => { ui.compare = !ui.compare; document.querySelector('main').classList.toggle('solo', !ui.compare); $('btnCompare').textContent = ui.compare ? '单世界' : '对照 A/B'; refresh(); };
$('survPanel').addEventListener('click', (e) => {
  if (e.target.closest('#btnSurvReset')) { survFlash = null; ctl({ action: 'reset' }); return; }
  const mv = e.target.closest('button[data-mv]');
  if (mv) { api('/act', { mode: 'survival', kind: 'move', room: mv.dataset.mv }).then(refresh); return; }
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
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && ui.fullscreen) { setFull(false); e.preventDefault(); } });
window.addEventListener('resize', () => { if (ui.fullscreen && S.view) draw($('cvFull'), S.view); });
// 点击画面：把屏幕坐标反算成世界 tile，再落到最近的地点（走过去 / 切换镜头）。
// 局部视角用相机偏移 + 整数倍缩放；全景用微缩比例。两个世界收到同一个动作。
function pickRoom(ev, cv) {
  // 室内：点击只认门（底部中央）→ 出门回大地图，镜头停在该建筑。按 rect 归一化，抗 CSS 缩放。
  if (ui.interior && !S.soloSurv) {
    const rect = cv.getBoundingClientRect();
    const roomW = 256, roomH = 192;
    const lx = (ev.clientX - rect.left) / rect.width * roomW, ly = (ev.clientY - rect.top) / rect.height * roomH;
    if(ui.interior==='hall' && ly>=98 && ly<=135 && (lx<=42||lx>=214)){
      const room=lx<128?'home':'store';
      if(S.view?.rooms?.[room])return api('/act',{kind:'move',room}).then(()=>{ui.room=room;ui.interior=room;refresh();});
    }
    if (lx >= roomW / 2 - TILE * 1.5 && lx <= roomW / 2 + TILE * 1.5 && ly >= roomH - TILE * 1.5) { ui.interior = null; ui.camRoom = ui.room; refresh(); }
    return;
  }
  const v = S.view ?? {};
  const sites = sitesOf(v);
  const cam = cv._cam ?? lastCam;
  const rect = cv.getBoundingClientRect();
  let tx, ty;
  if (cam.mode === 'overview') {
    tx = ((ev.clientX - rect.left) / rect.width) * WORLD_TW;
    ty = ((ev.clientY - rect.top) / rect.height) * WORLD_TH;
  } else {
    tx = (cam.x + (ev.clientX - rect.left) / rect.width * VIEW_W) / TILE;
    ty = (cam.y + (ev.clientY - rect.top) / rect.height * VIEW_H) / TILE;
  }
  let best = null, bd = Infinity;
  for (const [r, [sx, sy]] of Object.entries(sites)) {
    const d = Math.hypot(tx - sx, ty - sy);
    if (d < bd) { bd = d; best = r; }
  }
  if (!best) return;
  // 点哪走哪（纯表现层）：把玩家画布行走器目标设到点中的可行走 tile，镜头交回跟随玩家。
  const world = buildWorld(v);
  const cTile = [Math.floor(tx), Math.floor(ty)];
  const k = walkKey(cv.id, 'p1');
  if (!WALK[k]) ensureWalker(cv.id, 'p1', world, slotsOf(v, world.sites));
  const s = WALK[k];
  const walkable = isWalkable(world, cTile[0], cTile[1]);
  if (s && walkable) { const path = astar(world, [s.x, s.y], cTile); if (path && path.length) { s.path = path; s.pi = 0; } ui.camRoom = null; }
  const entry=entrySiteAt(sites,tx,ty) || (bd<=3 ? [best, sites[best]] : null);
  if (S.soloSurv) { if (!best) return; return api('/act', { mode: 'survival', kind: 'move', room: best }).then(() => { ui.room = best; ui.camRoom = null; refresh(); }); }
  if(entry){best=entry[0];return api('/act', { kind: 'move', room: best }).then(() => { ui.room = best; ui.interior = best; ui.camRoom = null; refresh(); });}
  ui.room = best;
  if (!walkable) ui.camRoom = best;   // 点到水 / 屋 / 岩等不可走处：仅把镜头移过去
  refresh();
}

// 建筑入口判定（点击与 E 键共用）：屋舍 footprint 内的矩形区域。
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
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (KEY_DIR[k]) { keys.add(KEY_DIR[k]); e.preventDefault(); return; }
  if (k === 'e' || k === 'enter') { e.preventDefault(); toggleInteriorByKeyboard(); }
});
window.addEventListener('keyup', (e) => { const d = KEY_DIR[e.key.toLowerCase()]; if (d) keys.delete(d); });
window.addEventListener('blur', () => keys.clear());
function toggleInteriorByKeyboard() {
  if (ui.interior) { ui.interior = null; ui.camRoom = ui.room; refresh(); return; }
  const s = WALK[walkKey('cvA', 'p1')]; if (!s) return;
  const sites = sitesOf(S.view ?? {});
  const at = entrySiteAt(sites, s.x, s.y);
  let room = at && at[0];
  if (!room) {   // 站在门口附近也算：最近地点 ≤2.5 格
    let bd = Infinity;
    for (const [r, [sx, sy]] of Object.entries(sites)) { const d = Math.hypot(s.x - sx, s.y - (sy - 1)); if (d < bd) { bd = d; room = r; } }
    if (bd > 2.5) return;
  }
  api('/act', { kind: 'move', room }).then(() => { ui.room = room; ui.interior = room; ui.camRoom = null; refresh(); });
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
  const rq = new URLSearchParams(location.search).get('room');   // 深链进某室内（便于直达与验收）
  if (rq && (rq in INTERIORS)) { ui.interior = rq; ui.room = rq; ui.camRoom = rq; }
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
    if (document.hidden || !S.view || !S.viewB) { lastPaint = null; return; }
    const dt = lastPaint === null ? 0 : Math.min(0.05, (now - lastPaint) / 1000); lastPaint = now; elapsed += dt; ACT.seconds=elapsed;
    ACT.frame = reduced.matches ? 0 : Math.floor(elapsed * ACT.fps) % 4;
    const changed = ACT.frame !== lastSpriteFrame; lastSpriteFrame = ACT.frame;
    const mdx = (keys.has('right') ? 1 : 0) - (keys.has('left') ? 1 : 0);
    const mdy = (keys.has('down') ? 1 : 0) - (keys.has('up') ? 1 : 0);
    const mstep = SPEED * ACT.fps * dt;
    // 室内：WASD 在房间地板范围内走动（撞墙停），走到下门自动出屋。
    if (ui.interior) {
      if (mdx || mdy) {
        const step = mstep * TILE, n = Math.hypot(mdx, mdy);
        IPOS.x = Math.max(24, Math.min(216, IPOS.x + mdx / n * step));
        IPOS.y = Math.max(34, Math.min(176, IPOS.y + mdy / n * step));
        IPOS.moving = true;
        IPOS.direction = Math.abs(mdy) > Math.abs(mdx) ? (mdy < 0 ? 'up' : 'down') : (mdx < 0 ? 'left' : 'right');
        if (mdx) IPOS.face = mdx > 0 ? 1 : -1;
        if (IPOS.y >= 174 && IPOS.x >= 108 && IPOS.x <= 140) { ui.interior = null; ui.camRoom = ui.room; refresh(); }
      } else IPOS.moving = false;
    }
    for (const k in WALK) {
      const walker = WALK[k];
      const cvId = k.slice(0, k.indexOf(':'));
      if (k.endsWith(':p1') && !ui.interior && (mdx || mdy)) {
        // 手动驾驶：覆盖 A* 路径，按可行走栅格碰撞（轴分离可贴墙滑）；A/B 同输入。
        const world = buildWorld((cvId === 'cvA' || cvId === 'cvFull') ? S.view : S.viewB);
        const n = Math.hypot(mdx, mdy);
        walker.path = []; walker.pi = 0;
        const nx = walker.x + mdx / n * mstep, ny = walker.y + mdy / n * mstep;
        if (isWalkable(world, Math.round(nx), Math.round(walker.y))) walker.x = nx;
        if (isWalkable(world, Math.round(walker.x), Math.round(ny))) walker.y = ny;
        walker.moving = true;
        walker.direction = Math.abs(mdy) > Math.abs(mdx) ? (mdy < 0 ? 'up' : 'down') : (mdx < 0 ? 'left' : 'right');
        if (mdx) walker.face = mdx > 0 ? 1 : -1;
      } else {
        const target = walker.path?.[walker.pi];
        if (target) { const dx = target[0] - walker.x, dy = target[1] - walker.y; walker.direction = Math.abs(dy) > Math.abs(dx) ? (dy < 0 ? 'up' : 'down') : (dx < 0 ? 'left' : 'right'); }
        stepWalker(walker, mstep);
      }
      if (changed && walker.moving && !reduced.matches) {
        (DUST[cvId] ??= []).push({ x: walker.x, y: walker.y + 0.8, age: 0 });
      }
    }
    if (changed) for (const cvId in DUST) DUST[cvId] = DUST[cvId].map(p => ({ ...p, age: p.age + 1 })).filter(p => p.age < 6);
    if (ui.fullscreen) draw($('cvFull'), S.view);
    else { draw($('cvA'), S.view); draw($('cvB'), S.viewB); }
  }
  requestAnimationFrame(animate);
});
