import { overridesFor } from './pixel-overrides.mjs';
// 代码定义像素资产生成器（零依赖、零许可、确定性）。PLAN/ui-pixel-spec：真像素网格 + 经所有者批准的固定 64 色板。
// 产出 web/assets/*.png；颜色只允许 palette.json 里的 64 色 + 透明。不写抗锯齿/中间色。
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const PALETTE = [
  '#000000', '#1D2B53', '#7E2553', '#008751', '#AB5236', '#5F574F', '#C2C3C7', '#FFF1E8',
  '#FF004D', '#FFA300', '#FFEC27', '#00E436', '#29ADFF', '#83769C', '#FF77A8', '#FFCCAA',
  '#18251E', '#263D29', '#315431', '#3F7036', '#568D3E', '#73A747', '#98BD51', '#BED773',
  '#D9E8A2', '#32302C', '#514134', '#72513B', '#976A45', '#BA8752', '#D8A667', '#EDC787',
  '#F6DDA8', '#FFF0CC', '#482D2B', '#6E3830', '#944735', '#B65B3C', '#D27A4A', '#E99E61',
  '#6D7165', '#939584', '#B9B8A1', '#D9D6B8', '#1E3D4B', '#2D5D6E', '#458996', '#6CB3B4',
  '#A0D2C6', '#533E5C', '#77607A', '#A18597', '#D4B0B4', '#A85A55', '#D58274', '#F2B29A',
  '#D6AE69', '#B58A4C', '#8D6A3D', '#664D32', '#497245', '#70905A', '#93AE73', '#C2CFA0',
];
const RGB = PALETTE.map((h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]);

// ── 最小 PNG 编码（RGBA8，filter 0）──
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();
function crc32(buf) { let c = -1; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
export function encodePNG(w, h, px) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const c = px[y * w + x]; // null=透明, 否则 palette index
      if (c === null || c === undefined) { raw[y * (w * 4 + 1) + 1 + x * 4 + 3] = 0; }
      else { const [r, g, b] = RGB[c]; raw[y * (w * 4 + 1) + 1 + x * 4] = r; raw[y * (w * 4 + 1) + 2 + x * 4] = g; raw[y * (w * 4 + 1) + 3 + x * 4] = b; raw[y * (w * 4 + 1) + 4 + x * 4] = 255; }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// ── 画布 helper ──
const canvas = (w, h) => ({ w, h, px: new Array(w * h).fill(null) });
const set = (c, x, y, v) => { if (x >= 0 && y >= 0 && x < c.w && y < c.h) c.px[y * c.w + x] = v; };
const rect = (c, x, y, w, h, v) => { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) set(c, x + i, y + j, v); };
const fromRows = (rows) => { const c = canvas(rows[0].length, rows.length); rows.forEach((r, y) => [...r].forEach((ch, x) => set(c, x, y, ch === '.' ? null : parseInt(ch, 16)))); return c; };
// 带 outline + 顶光 + 底影的盒子（手绘风体积感）
const box = (c, x, y, w, h, fill, light, dark) => {
  rect(c, x, y, w, h, 0);
  rect(c, x + 1, y + 1, w - 2, h - 2, fill);
  if (light !== undefined) rect(c, x + 1, y + 1, w - 2, 1, light);
  if (dark !== undefined) rect(c, x + 1, y + h - 2, w - 2, 1, dark);
};
// 抖动纹理（pixel-art dither，不引入中间色）
const dither = (c, x, y, w, h, a, b) => { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) set(c, x + i, y + j, (i + j) % 2 ? a : b); };

// ── 房间（96×64）：抖动地板 +  shaded 墙 + 带体积的家具 + 窗光 ──
function room(kind) {
  const c = canvas(96, 64);
  const F = { home: [4, 5], hall: [5, 6], store: [5, 4], workshop: [5, 4], garden: [3, 11], yard: [3, 4], watch: [1, 5], well: [5, 6] }[kind] ?? [1, 5];
  dither(c, 0, 0, 96, 64, F[0], F[1]);
  // 墙：外圈 + 顶墙高光 + 砖缝
  rect(c, 0, 0, 96, 6, 0); rect(c, 0, 0, 96, 2, 13); rect(c, 0, 6, 96, 1, 5);
  for (let x = 4; x < 96; x += 8) rect(c, x, 2, 1, 4, 5);
  rect(c, 0, 60, 96, 4, 0); rect(c, 0, 0, 3, 64, 0); rect(c, 93, 0, 3, 64, 0);
  // 窗光（左上斜投一块亮斑）
  dither(c, 8, 8, 18, 10, 7, F[0]);
  const M = {
    home: () => { box(c, 8, 34, 28, 16, 4, 15, 2); rect(c, 10, 36, 9, 6, 7); rect(c, 10, 36, 9, 2, 15); box(c, 60, 12, 22, 12, 5, 6, 0); rect(c, 63, 15, 16, 6, 12); box(c, 44, 40, 16, 10, 2, 14, 0); },
    yard: () => { rect(c, 10, 44, 76, 3, 3); rect(c, 10, 44, 76, 1, 11); for (const [px, py] of [[18, 18], [42, 26], [66, 16]]) { box(c, px, py, 8, 8, 3, 11, 0); set(c, px + 3, py + 2, 10); } box(c, 30, 46, 10, 8, 4, 9, 2); },
    hall: () => { box(c, 6, 28, 84, 10, 5, 6, 0); box(c, 40, 10, 18, 14, 4, 9, 2); rect(c, 43, 13, 12, 8, 9); rect(c, 43, 13, 12, 2, 10); box(c, 12, 44, 14, 8, 2, 14, 0); box(c, 70, 44, 14, 8, 2, 14, 0); },
    store: () => { box(c, 8, 12, 20, 20, 4, 9, 2); rect(c, 11, 15, 14, 4, 9); rect(c, 11, 23, 14, 4, 9); box(c, 40, 12, 20, 20, 4, 9, 2); rect(c, 43, 15, 14, 4, 9); box(c, 70, 34, 18, 16, 5, 6, 0); rect(c, 73, 37, 12, 4, 9); },
    workshop: () => { box(c, 10, 30, 34, 12, 4, 15, 2); rect(c, 14, 42, 4, 10, 5); rect(c, 36, 42, 4, 10, 5); box(c, 60, 14, 18, 18, 5, 6, 0); rect(c, 64, 18, 10, 10, 12); rect(c, 64, 18, 10, 2, 7); box(c, 50, 44, 12, 8, 2, 8, 0); },
    garden: () => { for (let i = 0; i < 4; i++) { box(c, 8 + i * 22, 14, 16, 36, 4, 9, 2); for (let j = 0; j < 3; j++) { rect(c, 11 + i * 22, 18 + j * 10, 10, 4, 3); rect(c, 11 + i * 22, 18 + j * 10, 10, 1, 11); } } },
    watch: () => { box(c, 28, 40, 40, 8, 5, 6, 0); rect(c, 32, 48, 4, 10, 5); rect(c, 60, 48, 4, 10, 5); box(c, 42, 10, 12, 12, 12, 7, 1); rect(c, 45, 13, 6, 6, 7); },
    well: () => { box(c, 36, 26, 24, 16, 5, 6, 0); rect(c, 40, 29, 16, 8, 12); rect(c, 40, 29, 16, 2, 7); rect(c, 34, 12, 4, 14, 4); rect(c, 58, 12, 4, 14, 4); box(c, 34, 10, 28, 5, 4, 9, 2); },
  };
  (M[kind] ?? M.hall)();
  return c;
}

// ── 角色 16×16：outline + 肤色/衣色双 tone + 发型高光 + 4 帧（idle/blink/walkA/walkB）──
const CHAR_BASE = [
  '................',
  '.....000000.....',
  '....0hHhhhh0....',
  '...0hHhhhhhh0...',
  '...0hhsssshh0...',
  '...0s0ss0ss0....',
  '...0ssssssss0...',
  '....0ss44ss0....',
  '....0tTttt0.....',
  '...0tTttttTt0...',
  '...0tTttttTt0...',
  '...0stttttts0...',
  '....0tTttT0.....',
  '....0pp0pp0.....',
  '....0p0..0p0....',
  '....00....00....',
];
function charFrame(colors, frame) {
  const rows = CHAR_BASE.map((r) => [...r]);
  if (frame === 1) { rows[5] = [...'...0ssssssss0...']; }           // blink
  if (frame === 2) { rows[13] = [...'...0pp0..0pp0...']; rows[14] = [...'...0p0....0p0...']; rows[15] = [...'...00......00...']; }
  if (frame === 3) { rows[13] = [...'.....0pp0pp0....']; rows[14] = [...'.....0p00p0.....']; rows[15] = [...'.....00..00.....']; }
  const map = { h: colors.hair, H: 7, s: colors.skin, e: 0, m: 4, t: colors.shirt, T: colors.shirtLight, p: colors.pants, b: 0 };
  const c = canvas(16, 16);
  rows.forEach((r, y) => r.forEach((ch, x) => set(c, x, y, ch === '.' ? null : (map[ch] ?? 0))));
  return c;
}
const CHARS = {
  a1: { hair: 1, skin: 15, shirt: 12, shirtLight: 7, pants: 1 },
  a2: { hair: 8, skin: 15, shirt: 9, shirtLight: 10, pants: 4 },
  a3: { hair: 5, skin: 15, shirt: 3, shirtLight: 11, pants: 5 },
  p1: { hair: 7, skin: 15, shirt: 6, shirtLight: 7, pants: 1 },
};

// ── 物件 16×16 / 图标 8×8 ──
const THINGS = {
  bench: () => { const c = canvas(16, 16); box(c, 1, 6, 14, 5, 4, 15, 2); rect(c, 2, 11, 2, 4, 5); rect(c, 12, 11, 2, 4, 5); box(c, 5, 2, 6, 4, 12, 7, 1); return c; },
  beds: () => { const c = canvas(16, 16); box(c, 1, 6, 14, 9, 4, 15, 2); rect(c, 2, 7, 12, 3, 7); rect(c, 2, 7, 12, 1, 15); box(c, 2, 10, 5, 3, 12, 7, 1); rect(c, 1, 15, 2, 1, 5); rect(c, 13, 15, 2, 1, 5); return c; },
  crates: () => { const c = canvas(16, 16); box(c, 2, 8, 8, 7, 4, 9, 2); rect(c, 3, 11, 6, 1, 2); box(c, 8, 2, 7, 6, 4, 9, 2); rect(c, 9, 4, 5, 1, 2); return c; },
  bedsG: () => { const c = canvas(16, 16); box(c, 1, 10, 14, 5, 4, 9, 2); for (const [px, py, col] of [[2, 5, 3], [7, 4, 3], [12, 5, 11]]) { rect(c, px, py, 3, 5, col); rect(c, px, py, 3, 1, 11); set(c, px + 1, py + 2, 10); } return c; },
  bucket: () => { const c = canvas(16, 16); box(c, 5, 6, 6, 9, 5, 6, 0); rect(c, 6, 7, 4, 2, 12); rect(c, 6, 7, 4, 1, 7); rect(c, 4, 4, 8, 1, 6); rect(c, 4, 4, 1, 3, 6); rect(c, 11, 4, 1, 3, 6); return c; },
};
const ICONS = {
  energy: () => fromRows(['...10...', '..10....', '.10.....', '.11110..', '...10...', '..10....', '.10.....', '........']),
  social: () => fromRows(['.12..12.', '.12..12.', '..1111..', '.111111.', '11111111', '11111111', '.111111.', '..1111..']),
  coin: () => fromRows(['..9999..', '.9aaaa9.', '9a9999a9', '9a9999a9', '9a9999a9', '9a9999a9', '.9aaaa9.', '..9999..']),
  weather: () => fromRows(['..1212..', '.121212.', '12121212', '........', '..1212..', '.121212.', '12121212', '........']),
  viab: () => fromRows(['.88..88.', '88888888', '88888888', '88888888', '.888888.', '..8888..', '...88...', '........']),
};

// 32px 美术图集。布局坐标仍由观察端处理，资产不依赖世界时钟。
const ink = h => { const i = PALETTE.indexOf(h); if (i < 0) throw new Error(`未登记颜色 ${h}`); return i; };
const H = (x, y, seed = 0) => { let n = Math.imul(x + seed, 374761393) ^ Math.imul(y - seed, 668265263); n = Math.imul(n ^ n >>> 13, 1274126177); return ((n ^ n >>> 16) >>> 0) / 4294967296; };
const line = (c, x, y, ex, ey, col) => {
  const steps = Math.max(Math.abs(ex - x), Math.abs(ey - y));
  for (let i = 0; i <= steps; i++) set(c, Math.round(x + (ex - x) * i / (steps || 1)), Math.round(y + (ey - y) * i / (steps || 1)), col);
};
const poly = (c, points, col) => {
  const minY = Math.max(0, Math.min(...points.map(p => p[1]))), maxY = Math.min(c.h - 1, Math.max(...points.map(p => p[1])));
  for (let y = minY; y <= maxY; y++) {
    const cuts = [];
    points.forEach(([x1, y1], i) => { const [x2, y2] = points[(i + 1) % points.length]; if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) cuts.push(x1 + (y - y1) * (x2 - x1) / (y2 - y1)); });
    cuts.sort((a, b) => a - b); for (let i = 0; i < cuts.length; i += 2) for (let x = Math.ceil(cuts[i]); x <= Math.floor(cuts[i + 1]); x++) set(c, x, y, col);
  }
};
function timber(c, x, y, w, h, vertical = false) {
  box(c, x, y, w, h, ink('#BA8752'), ink('#EDC787'), ink('#72513B'));
  for (let k = 6; k < (vertical ? w : h) - 1; k += 6) {
    if (vertical) { rect(c, x + k, y + 1, 1, h - 2, ink('#976A45')); rect(c, x + k + 1, y + 2, 1, h - 4, ink('#D8A667')); }
    else { rect(c, x + 1, y + k, w - 2, 1, ink('#976A45')); rect(c, x + 2, y + k + 1, w - 4, 1, ink('#D8A667')); }
  }
  for (let k = 0; k < w * h / 50; k++) { const px = x + 2 + Math.floor(H(k, x, y) * (w - 4)), py = y + 2 + Math.floor(H(k, y, x) * (h - 4)); rect(c, px, py, vertical ? 1 : 3, vertical ? 3 : 1, ink('#B58A4C')); }
}
function windowArt(c, x, y, w = 22, h = 24, lit = false) {
  box(c, x, y, w, h, ink('#72513B'), ink('#EDC787'), ink('#482D2B'));
  box(c, x + 3, y + 3, w - 6, h - 6, ink(lit ? '#EDC787' : '#458996'), ink(lit ? '#FFF0CC' : '#A0D2C6'), ink('#2D5D6E'));
  rect(c, x + w / 2 - 1, y + 3, 2, h - 6, ink('#EDC787')); rect(c, x + 3, y + h / 2, w - 6, 2, ink('#D8A667'));
  line(c, x + 5, y + 5, x + 9, y + 5, ink('#D9D6B8'));
  rect(c, x - 2, y + h - 2, w + 4, 3, ink('#BA8752'));
}
function shelterArt(kind) {
  const c=canvas(128,128);
  const beam=(x,y,w,h)=>box(c,x,y,w,h,ink('#976A45'),ink('#D8A667'),ink('#482D2B'));
  const roof=(points,green=false)=>{
    const outline=ink('#482D2B');poly(c,points,outline);
    for(let y=0;y<80;y++)for(let x=0;x<128;x++)if(c.px[y*128+x]===outline){
      const row=y%7,tile=(x+Math.floor(y/7)%2*6)%12;
      set(c,x,y,ink(row===6||tile===0?'#514134':row===1?(green?'#93AE73':'#D8A667'):(green?'#3F7036':'#976A45')));
    }
  };
  if(kind==='hall'){
    // 开放式连廊：横向走道、两端连入侧翼，前排双柱之间留出入口。
    timber(c,0,91,128,24);timber(c,46,113,36,6);
    beam(0,52,128,7);beam(0,81,128,3);
    for(const x of [4,39,86,120])beam(x,48,4,62);
    roof([[0,35],[7,22],[121,22],[128,35],[128,53],[0,53]],true);
    beam(0,51,128,5);
    for(const x of [15,100]){box(c,x,64,10,15,ink('#514134'),ink('#EDC787'),ink('#482D2B'));rect(c,x+3,68,4,7,ink('#458996'));}
    return c;
  }
  if(kind==='yard'||kind==='well'||kind==='garden'){
    if(kind==='garden'){
      box(c,65,60,49,47,ink('#BA8752'),ink('#EDC787'),ink('#514134'));timber(c,67,62,45,43,true);
      box(c,80,77,20,30,ink('#72513B'),ink('#D8A667'),ink('#482D2B'));windowArt(c,72,64,26,12);
      roof([[58,63],[69,40],[112,43],[123,65]],true);
      beam(54,62,3,45);beam(120,64,3,43);beam(53,105,71,4);
      for(let y=87;y<109;y+=8)beam(10,y,35,5);
      for(const x of [15,22,29,36])line(c,x,77,x+3,88,ink('#D6AE69'));
      beam(5,108,43,3);
    }else{
      timber(c,13,101,103,11);for(const x of [19,105])beam(x,44,5,62);
      roof([[7,50],[21,24],[94,24],[122,50],[116,59],[13,59]],kind==='well');beam(12,57,105,4);
      if(kind==='well'){
        box(c,39,90,53,22,ink('#6D7165'),ink('#B9B8A1'),ink('#514134'));
        rect(c,43,89,45,8,ink('#1E3D4B'));rect(c,41,87,49,3,ink('#D9D6B8'));
        beam(38,66,55,4);line(c,66,68,66,96,ink('#D6AE69'));box(c,63,94,8,8,ink('#72513B'),ink('#D8A667'),ink('#482D2B'));
        for(let y=98;y<111;y+=6)rect(c,40,y,50,1,ink('#514134'));
      }else{
        timber(c,26,87,33,22,true);timber(c,61,93,35,16,true);beam(33,82,24,5);
        line(c,88,67,98,96,ink('#6D7165'));beam(12,109,105,4);
      }
    }
    return c;
  }
  if(kind==='store'){
    box(c,13,49,102,60,ink('#976A45'),ink('#D8A667'),ink('#482D2B'));timber(c,15,50,98,57,true);
    roof([[4,49],[24,17],[93,17],[124,49],[117,55],[10,55]]);
    beam(12,55,104,5);box(c,44,67,41,41,ink('#72513B'),ink('#D8A667'),ink('#482D2B'));
    timber(c,47,70,35,36,true);line(c,48,72,80,104,ink('#EDC787'));line(c,80,72,48,104,ink('#D8A667'));
    windowArt(c,21,65,17,20);windowArt(c,91,65,17,20);timber(c,34,108,61,10);
    timber(c,5,94,22,19,true);timber(c,100,96,23,17,true);
    return c;
  }
  return null;
}
function houseArt(kind) {
  const shelter=shelterArt(kind);if(shelter)return shelter;
  const c = canvas(128, 128), stone = kind === 'workshop' || kind === 'watch', green = kind === 'garden' || kind === 'well';
  const roof = (green ? ['#315431', '#3F7036', '#568D3E', '#93AE73'] : kind === 'watch' ? ['#32302C', '#514134', '#6D7165', '#939584'] : ['#482D2B', '#944735', '#B65B3C', '#E99E61']).map(ink);
  // 基座与前廊，木纹方向一致，踏步有厚度。
  box(c, 12, 96, 104, 18, ink('#976A45'), ink('#D8A667'), ink('#514134'));
  timber(c, 13, 97, 102, 10); timber(c, 45, 106, 40, 8); timber(c, 42, 113, 46, 6);
  box(c, 18, 43, 92, 56, ink(stone ? '#939584' : '#EDC787'), ink('#FFF0CC'), ink('#976A45'));
  // 木墙竖缝与错列石墙；没有大面积平涂的空墙。
  for (let y = 46; y < 96; y++) for (let x = 20; x < 108; x++) {
    if (stone) { if (y % 9 === 0 || (x + Math.floor(y / 9) % 2 * 9) % 18 === 0) set(c, x, y, ink('#6D7165')); else if (y % 9 === 1) set(c, x, y, ink('#B9B8A1')); }
    else { if (x % 6 === 0) set(c, x, y, ink('#BA8752')); else if (x % 6 === 1) set(c, x, y, ink('#F6DDA8')); else if (H(x, y, 3) > .985) set(c, x, y, ink('#D8A667')); }
  }
  // 斜屋顶，瓦片每行错半片：描边、瓦底阴影和左上反光共用材质色阶。
  poly(c, [[4, 46], [17, 16], [82, 5], [124, 44], [114, 57], [13, 57]], roof[0]);
  for (let y = 8; y < 55; y++) for (let x = 5; x < 124; x++) if (c.px[y * c.w + x] === roof[0]) {
    const tile = (x + Math.floor(y / 7) % 2 * 5) % 10, row = y % 7;
    set(c, x, y, row === 6 && tile > 0 && tile < 9 ? roof[0] : tile === 0 && row > 1 ? roof[1] : row === 1 && tile > 1 && tile < 7 ? roof[3] : row === 5 || tile > 7 ? roof[1] : roof[2]);
  }
  // 中央前山墙嵌入瓦顶，立柱与檐口构成稳定剪影。
  poly(c, [[28, 51], [67, 18], [105, 51]], ink('#F6DDA8'));
  for (let x = 34; x < 103; x += 6) line(c, x, 52, x, Math.round(20 + Math.abs(x - 67) * .85), ink('#D8A667'));
  line(c, 25, 52, 67, 15, ink('#482D2B')); line(c, 26, 53, 67, 17, roof[3]);
  line(c, 67, 15, 108, 52, roof[0]); line(c, 68, 18, 106, 52, roof[2]);
  rect(c, 14, 54, 101, 3, ink('#72513B')); rect(c, 15, 54, 99, 1, ink('#D8A667'));
  windowArt(c, 57, 30, 20, 19); windowArt(c, 27, 65, 22, 25); windowArt(c, 84, 65, 20, 25);
  // 门框、门板与小铜把手。
  box(c, 57, 64, 22, 38, ink('#72513B'), ink('#EDC787'), ink('#482D2B'));
  box(c, 61, 68, 14, 32, ink(green ? '#568D3E' : '#944735'), ink('#E99E61'), ink('#482D2B'));
  rect(c, 64, 71, 8, 11, ink(green ? '#315431' : '#6E3830')); rect(c, 64, 86, 8, 10, ink(green ? '#3F7036' : '#6E3830'));
  rect(c, 71, 83, 2, 2, ink('#EDC787'));
  // 侧面的实体立柱与下沿木裙板。
  for (const x of [18, 108]) { rect(c, x, 57, 3, 42, ink('#72513B')); rect(c, x, 58, 1, 39, ink('#D8A667')); }
  if (kind === 'home' || kind === 'workshop') {
    box(c, 99, 8, 12, 22, ink('#6D7165'), ink('#B9B8A1'), ink('#514134')); rect(c, 97, 7, 16, 4, ink('#939584'));
    for (let y = 14; y < 29; y += 6) rect(c, 100, y, 9, 1, ink('#514134'));
  }
  if (kind === 'store') { timber(c, 3, 79, 18, 20, true); timber(c, 108, 83, 17, 17, true); }
  if (kind === 'hall') { box(c, 3, 70, 14, 24, ink('#D8A667'), ink('#FFF0CC'), ink('#72513B')); rect(c, 5, 75, 10, 1, ink('#976A45')); rect(c, 5, 80, 8, 1, ink('#976A45')); }
  if (kind === 'garden' || kind === 'yard') for (const x of [6, 108]) { timber(c, x, 96, 14, 12); for (let k = 0; k < 3; k++) { rect(c, x + 2 + k * 4, 90 - k % 2 * 3, 3, 8, ink('#568D3E')); set(c, x + 3 + k * 4, 89 - k % 2 * 3, ink('#D58274')); } }
  if (kind === 'well') { rect(c, 4, 95, 12, 7, ink('#6D7165')); rect(c, 5, 94, 10, 2, ink('#B9B8A1')); }
  if (kind === 'watch') { line(c, 117, 59, 117, 93, ink('#72513B')); poly(c, [[118, 59], [128, 63], [118, 69]], ink('#D8A667')); }
  return c;
}
function treeArt(seed = 0) {
  const c = canvas(128, 160);
  // 成树有宽阔冠层、分枝与裸露根部；保留一像素叶尖，不放大旧像素块。
  poly(c, [[56,65],[73,64],[72,132],[87,150],[70,146],[62,157],[55,148],[39,153],[54,133]], ink('#482D2B'));
  poly(c, [[57,70],[66,72],[66,139],[61,149],[57,139]], ink('#BA8752'));
  poly(c, [[65,90],[91,66],[95,69],[71,106],[70,142],[65,138]], ink('#72513B'));
  poly(c, [[57,100],[32,78],[30,83],[55,115]], ink('#976A45'));
  for(let y=103;y<144;y+=8){rect(c,59,y,2,5,ink('#976A45'));rect(c,68,y-4,2,6,ink('#514134'));}
  const clusters = [[59,27,32,26],[30,47,28,29],[89,48,31,31],[60,66,46,33],[36,84,30,27],[83,89,35,26],[63,105,28,18]];
  const ramp = ['#18251E','#263D29','#315431','#3F7036','#568D3E','#73A747','#98BD51','#BED773'].map(ink);
  const covered=(x,y)=>clusters.some(([cx,cy,rx,ry])=>((x-cx)/rx)**2+((y-cy)/ry)**2<1+(H(Math.floor(x/3),Math.floor(y/3),seed)-.5)*.12);
  for(let y=1;y<128;y++)for(let x=1;x<127;x++){
    if(!covered(x,y))continue;
    if(!covered(x-1,y)||!covered(x+1,y)||!covered(x,y-1)||!covered(x,y+1)){set(c,x,y,ramp[1]);continue;}
    let shade=3;
    for(const [cx,cy,rx,ry] of clusters){const d=((x-cx+rx*.16)/rx)**2+((y-cy+ry*.22)/ry)**2;
      if(d<.8)shade=Math.max(shade,Math.min(6,4+Math.floor((1-d)*2.8)-(cy>85?1:0)));}
    if(H(Math.floor(x/5),Math.floor(y/4),seed+4)<.13)shade=Math.max(2,shade-1);
    set(c,x,y,ramp[shade]);
  }
  for(let k=0;k<330;k++){
    const x=4+Math.floor(H(k,seed,31)*119),y=4+Math.floor(H(seed,k,19)*115);
    if(!covered(x-3,y)||!covered(x+3,y)||!covered(x,y-3)||!covered(x,y+3))continue;
    const col=c.px[y*c.w+x],n=ramp.indexOf(col);if(n<3)continue;
    line(c,x-1,y,x+1,y-1,ramp[Math.min(7,n+1)]);rect(c,x,y+2,3,1,ramp[n-1]);
  }
  return c;
}
function terrainArt(kind, variant = 0) {
  const c = canvas(32, 32), grass = ['#3F7036', '#568D3E', '#73A747', '#98BD51'], dirt = ['#BA8752', '#D8A667', '#EDC787', '#F6DDA8'];
  const ramp = (kind === 'grass' ? grass : kind === 'water' ? ['#1E3D4B', '#2D5D6E', '#458996', '#6CB3B4'] : kind === 'wood' ? ['#72513B', '#976A45', '#BA8752', '#D8A667'] : kind === 'stone' ? ['#6D7165', '#939584', '#B9B8A1', '#D9D6B8'] : dirt).map(ink);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
    const h = H(x, y, variant), patch = H(Math.floor(x / 4), Math.floor(y / 4), variant + 9);
    let col = h < .025 ? 0 : h > .96 ? 2 : 1;
    if (kind === 'grass') col = patch > .85 && h > .88 ? 2 : h < .014 ? 0 : 1;
    if (kind === 'wood') col = y % 8 === 0 || (x + Math.floor(y / 8) % 2 * 16) % 32 === 0 ? 0 : y % 8 === 1 ? 3 : h > .992 ? 1 : 2;
    if (kind === 'stone') col = y % 16 === 0 || (x + (Math.floor(y / 16) % 2) * 16) % 32 === 0 ? 0 : y % 16 === 1 ? 3 : 1;
    if (kind === 'water') col = y % 11 === 0 && x % 17 < 9 ? 2 : 1;
    set(c, x, y, ramp[col]);
  }
  if (kind === 'grass') for (let k = 0; k < 9; k++) {
    const x = 2 + Math.floor(H(k, variant, 4) * 28), y = 3 + Math.floor(H(variant, k, 6) * 27);
    set(c, x, y, ramp[0]); set(c, x - 1, y - 1, ramp[2]); set(c, x, y - 2, ramp[2]);
  }
  return c;
}
function propArt(kind) {
  const c = canvas(64, 64), wood = ink('#976A45'), dark = ink('#514134'), light = ink('#EDC787');
  if (kind === 'boulder') {
    poly(c, [[9,45],[10,29],[20,18],[36,15],[50,27],[55,46],[47,54],[22,56]],ink('#514134'));
    poly(c, [[10,41],[13,28],[22,19],[35,17],[48,27],[50,44],[44,49],[21,50]],ink('#939584'));
    poly(c, [[14,31],[23,20],[34,18],[43,25],[35,32],[21,34]],ink('#B9B8A1'));
    line(c,17,28,24,21,ink('#D9D6B8'));line(c,35,34,39,43,ink('#6D7165'));line(c,39,43,47,44,ink('#6D7165'));
  } else if (kind === 'rug') {
    rect(c, 5, 19, 54, 36, ink('#6E3830')); rect(c, 6, 20, 52, 34, ink('#D8A667')); rect(c, 9, 23, 46, 28, ink('#944735'));
    for (let y = 25; y < 50; y += 4) for (let x = 11; x < 54; x += 4) if ((x + y) % 8 === 0) rect(c, x, y, 2, 2, ink('#EDC787'));
    for (let x = 6; x < 58; x += 3) { rect(c, x, 17, 1, 3, ink('#F6DDA8')); rect(c, x, 54, 1, 3, ink('#F6DDA8')); }
  } else if (kind === 'well') {
    box(c, 10, 31, 44, 25, ink('#939584'), ink('#D9D6B8'), ink('#6D7165')); box(c, 14, 32, 36, 10, ink('#2D5D6E'), ink('#B9B8A1'), ink('#32302C'));
    rect(c, 13, 13, 4, 24, wood); rect(c, 47, 13, 4, 24, wood); timber(c, 9, 10, 46, 7); rect(c, 31, 17, 1, 22, light);
    for (let x = 20; x < 49; x += 12) rect(c, x, 45, 1, 10, ink('#6D7165'));
  } else if (kind === 'fence') {
    for (const x of [8, 28, 48]) { box(c, x, 16, 6, 42, wood, light, dark); set(c, x + 2, 15, light); }
    timber(c, 5, 26, 54, 6); timber(c, 5, 43, 54, 6);
  } else if (kind === 'bed') {
    timber(c, 11, 8, 43, 48, true); box(c, 14, 12, 37, 38, ink('#939584'), light, dark);
    box(c, 17, 13, 31, 11, ink('#FFF0CC'), ink('#FFF1E8'), ink('#D8A667'));
    box(c, 15, 27, 35, 23, ink('#458996'), ink('#6CB3B4'), ink('#2D5D6E')); rect(c, 17, 30, 31, 2, light);
    for (let x = 19; x < 48; x += 8) rect(c, x, 33, 1, 15, ink('#6CB3B4'));
  } else if (['table', 'longTable', 'bench', 'cart'].includes(kind)) {
    rect(c, 12, 39, 6, 17, dark); rect(c, 47, 39, 6, 17, dark); rect(c, 14, 40, 2, 14, wood); rect(c, 49, 40, 2, 14, wood); timber(c, 6, 18, 52, 25);
    if (kind === 'table' || kind === 'longTable') { box(c, 21, 19, 17, 12, ink('#D9D6B8'), ink('#FFF0CC'), ink('#939584')); rect(c, 26, 22, 7, 6, ink('#D8A667')); }
    if (kind === 'cart') { box(c, 10, 45, 10, 10, dark, wood, dark); box(c, 44, 45, 10, 10, dark, wood, dark); }
  } else if (kind === 'crate') {
    timber(c, 10, 19, 44, 36, true);timber(c, 9, 18, 46, 7);
    line(c,14,29,48,49,ink('#514134'));line(c,15,29,49,49,ink('#EDC787'));
    line(c,48,29,14,49,ink('#72513B'));line(c,49,29,15,49,ink('#D8A667'));
    for(const x of [13,49])for(const y of [28,50])set(c,x,y,ink('#32302C'));
  } else if (kind === 'workbench') {
    rect(c,12,39,6,18,dark);rect(c,47,39,6,18,dark);timber(c,5,25,54,18);
    box(c,10,18,14,11,ink('#6D7165'),ink('#B9B8A1'),ink('#32302C'));rect(c,14,12,4,10,ink('#514134'));rect(c,10,12,12,3,ink('#939584'));
    rect(c,36,23,17,3,ink('#514134'));rect(c,42,17,3,12,ink('#976A45'));rect(c,39,16,10,3,ink('#939584'));
    rect(c,28,20,2,10,ink('#D8A667'));rect(c,26,17,6,5,ink('#32302C'));
  } else if (kind === 'anvil') {
    timber(c,20,37,25,20,true);poly(c,[[12,22],[54,22],[47,31],[34,32],[33,38],[20,38],[24,31],[12,29]],ink('#514134'));
    poly(c,[[7,17],[54,17],[48,24],[23,25],[14,22],[7,22]],ink('#939584'));line(c,8,17,53,17,ink('#D9D6B8'));rect(c,25,25,9,6,ink('#6D7165'));
  } else if (kind === 'shelf') {
    timber(c, 9, 6, 46, 49, true);
    for (const y of [13, 29]) { rect(c, 12, y, 40, 13, dark); for (let i = 0; i < 5; i++) box(c, 15 + i * 7, y + 3 + i % 2, 5, 9, ink(['#458996', '#944735', '#568D3E', '#D8A667', '#77607A'][i]), light, wood); rect(c, 12, y + 14, 40, 3, wood); }
  } else if (['hearth', 'furnace'].includes(kind)) {
    box(c, 10, 10, 44, 45, ink('#939584'), ink('#D9D6B8'), dark);
    for (const y of [20, 30, 40]) rect(c, 12, y, 40, 1, ink('#6D7165'));
    box(c, 20, 29, 24, 23, ink('#32302C'), dark, dark); rect(c, 23, 44, 18, 5, ink('#B65B3C')); poly(c, [[23, 46], [27, 34], [30, 40], [35, 32], [40, 46]], ink('#E99E61')); rect(c, 29, 42, 8, 6, light);
    if (kind === 'anvil') { rect(c, 8, 10, 48, 12, ink('#6D7165')); rect(c, 9, 10, 46, 2, ink('#D9D6B8')); }
  } else if (['planter', 'trellis'].includes(kind)) {
    timber(c, 8, 37, 48, 18); rect(c, 11, 36, 42, 3, dark);
    for (let i = 0; i < 6; i++) { const x = 13 + i * 7, y = 17 + i % 3 * 5; rect(c, x, y, 2, 22, ink('#315431')); poly(c, [[x, y + 8], [x - 6, y + 1], [x, y + 2], [x + 6, y - 4], [x + 4, y + 9]], ink('#568D3E')); rect(c, x, y, 3, 3, ink(i % 2 ? '#D58274' : '#EDC787')); }
  } else if (['well', 'bucket', 'barrel'].includes(kind)) {
    box(c, 15, 24, 35, 29, wood, light, dark);
    for (const y of [29, 44]) rect(c, 15, y, 35, 3, ink('#939584'));
    rect(c, 19, 26, 27, 3, ink('#2D5D6E')); rect(c, 20, 20, 2, 6, dark); rect(c, 44, 20, 2, 6, dark); rect(c, 20, 18, 26, 2, ink('#939584'));
  } else if (kind === 'telescope') {
    line(c,32,36,17,58,dark);line(c,33,36,49,58,dark);rect(c,31,31,4,25,wood);rect(c,31,32,1,21,light);
    poly(c,[[7,11],[47,24],[52,34],[44,37],[9,24]],ink('#32302C'));
    poly(c,[[9,13],[46,26],[48,32],[43,34],[11,23]],ink('#BA8752'));line(c,11,14,44,26,ink('#F6DDA8'));
    poly(c,[[7,11],[14,13],[16,26],[9,24]],ink('#939584'));poly(c,[[8,14],[12,15],[13,23],[9,22]],ink('#2D5D6E'));line(c,9,15,11,17,ink('#A0D2C6'));
    rect(c,44,28,9,4,ink('#72513B'));rect(c,46,28,5,1,light);
  } else if (kind === 'banner') {
    rect(c, 15, 7, 4, 52, wood); rect(c, 15, 8, 2, 48, light); poly(c, [[19, 10], [51, 10], [51, 44], [35, 37], [19, 44]], ink('#944735')); rect(c, 22, 12, 26, 2, ink('#E99E61')); rect(c, 31, 20, 9, 10, light);
  } else {
    timber(c, 10, 16, 44, 30); for (let x = 15; x < 51; x += 12) rect(c, x, 47, 4, 10, dark);
  }
  return c;
}
export function generate(outDir) {
  const override = overridesFor(outDir, PALETTE.length);
  mkdirSync(outDir, { recursive: true });
  const files = [];
  const put = (name, c) => { writeFileSync(join(outDir, name), encodePNG(c.w, c.h, override(name, c.w, c.h, c.px))); files.push(name); };
  for (const r of ['home', 'yard', 'hall', 'store', 'workshop', 'garden', 'watch', 'well']) put(`room_${r}.png`, room(r));
  for (const [id, col] of Object.entries(CHARS)) for (let f = 0; f < 4; f++) put(`char_${id}_${f}.png`, charFrame(col, f));
  for (const [id, fn] of Object.entries(THINGS)) put(`thing_${id}.png`, fn());
  for (const [id, fn] of Object.entries(ICONS)) put(`icon_${id}.png`, fn());
  for (const r of ['home', 'yard', 'hall', 'store', 'workshop', 'garden', 'watch', 'well']) put(`house_${r}.png`, houseArt(r));
  for (let i = 0; i < 3; i++) put(`tree_oak${i}.png`, treeArt(i * 17));
  for (const kind of ['grass', 'dirt', 'water', 'wood', 'stone']) for (let i = 0; i < 4; i++) put(`terrain_${kind}${i}.png`, terrainArt(kind, i));
  for (const kind of ['bed', 'table', 'longTable', 'bench', 'hearth', 'rug', 'shelf', 'crate', 'barrel', 'telescope', 'furnace', 'anvil', 'planter', 'trellis', 'well', 'bucket', 'fence', 'cart', 'banner', 'boulder', 'workbench']) put(`prop_${kind}.png`, propArt(kind));
  writeFileSync(join(outDir, 'palette.json'), JSON.stringify(PALETTE, null, 2));
  return files;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const out = resolve('web/assets');
  const files = generate(out);
  console.log(`generated ${files.length} pixel assets + palette.json -> ${out}`);
}
