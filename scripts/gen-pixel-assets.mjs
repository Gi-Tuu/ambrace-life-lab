// 代码定义像素资产生成器（零依赖、零许可、确定性）。PLAN/ui-pixel-spec：真像素网格 + PICO-8 锁色板。
// 产出 web/assets/*.png；颜色只允许 palette.json 里的 16 色 + 透明。不写抗锯齿/中间色。
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const PALETTE = [
  '#000000', '#1D2B53', '#7E2553', '#008751', '#AB5236', '#5F574F', '#C2C3C7', '#FFF1E8',
  '#FF004D', '#FFA300', '#FFEC27', '#00E436', '#29ADFF', '#83769C', '#FF77A8', '#FFCCAA',
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

export function generate(outDir) {
  mkdirSync(outDir, { recursive: true });
  const files = [];
  const put = (name, c) => { writeFileSync(join(outDir, name), encodePNG(c.w, c.h, c.px)); files.push(name); };
  for (const r of ['home', 'yard', 'hall', 'store', 'workshop', 'garden', 'watch', 'well']) put(`room_${r}.png`, room(r));
  for (const [id, col] of Object.entries(CHARS)) for (let f = 0; f < 4; f++) put(`char_${id}_${f}.png`, charFrame(col, f));
  for (const [id, fn] of Object.entries(THINGS)) put(`thing_${id}.png`, fn());
  for (const [id, fn] of Object.entries(ICONS)) put(`icon_${id}.png`, fn());
  writeFileSync(join(outDir, 'palette.json'), JSON.stringify(PALETTE, null, 2));
  return files;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const out = resolve('web/assets');
  const files = generate(out);
  console.log(`generated ${files.length} pixel assets + palette.json -> ${out}`);
}
