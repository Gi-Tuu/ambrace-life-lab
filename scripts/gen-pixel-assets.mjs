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

// ── 房间（96×64 = 6×4 tile）：地板格纹 + 墙边 + 家具母题 ──
function room(kind) {
  const c = canvas(96, 64);
  const floorA = 1, floorB = 5;
  for (let y = 0; y < 64; y++) for (let x = 0; x < 96; x++) set(c, x, y, ((x >> 4) + (y >> 4)) % 2 ? floorA : floorB);
  rect(c, 0, 0, 96, 4, 0); rect(c, 0, 60, 96, 4, 0); rect(c, 0, 0, 4, 64, 0); rect(c, 92, 0, 4, 64, 0);
  rect(c, 4, 4, 88, 2, 13);
  const M = {
    home: () => { rect(c, 10, 34, 26, 14, 4); rect(c, 10, 34, 26, 4, 15); rect(c, 12, 38, 8, 6, 7); rect(c, 60, 12, 20, 10, 5); rect(c, 62, 14, 16, 6, 6); },
    yard: () => { rect(c, 12, 40, 72, 4, 3); rect(c, 20, 20, 6, 6, 11); rect(c, 44, 28, 6, 6, 11); rect(c, 68, 18, 6, 6, 11); rect(c, 30, 44, 4, 4, 10); },
    hall: () => { rect(c, 8, 28, 80, 8, 5); rect(c, 8, 28, 80, 2, 6); rect(c, 40, 10, 16, 12, 4); rect(c, 42, 12, 12, 8, 9); },
    store: () => { rect(c, 10, 12, 18, 18, 4); rect(c, 12, 14, 14, 4, 9); rect(c, 12, 22, 14, 4, 9); rect(c, 40, 12, 18, 18, 4); rect(c, 42, 14, 14, 4, 9); rect(c, 70, 34, 16, 14, 5); },
    workshop: () => { rect(c, 12, 30, 30, 10, 4); rect(c, 12, 30, 30, 3, 15); rect(c, 16, 40, 4, 10, 5); rect(c, 34, 40, 4, 10, 5); rect(c, 60, 14, 16, 16, 5); rect(c, 64, 18, 8, 8, 12); },
    garden: () => { for (let i = 0; i < 4; i++) { rect(c, 10 + i * 20, 16, 14, 32, 4); rect(c, 12 + i * 20, 18, 10, 4, 3); rect(c, 12 + i * 20, 26, 10, 4, 3); rect(c, 12 + i * 20, 34, 10, 4, 11); } },
    watch: () => { rect(c, 30, 40, 36, 6, 5); rect(c, 34, 46, 4, 10, 5); rect(c, 58, 46, 4, 10, 5); rect(c, 44, 12, 8, 8, 12); rect(c, 46, 14, 4, 4, 7); },
    well: () => { rect(c, 38, 26, 20, 14, 5); rect(c, 40, 28, 16, 8, 12); rect(c, 36, 12, 4, 14, 4); rect(c, 56, 12, 4, 14, 4); rect(c, 36, 10, 24, 4, 4); },
  };
  (M[kind] ?? M.hall)();
  return c;
}

// ── 角色 16×16：一个模板 +  per-char 配色 + 4 帧（idle2/walk2）──
const CHAR_BASE = [
  '................',
  '.....hhhhhh.....',
  '....hhhhhhhh....',
  '....hssssssh....',
  '....ssessess....',
  '....ssssssss....',
  '.....ssmmss.....',
  '....tttttttt....',
  '...tttttttttt...',
  '...tsttttttst...',
  '...tsttttttst...',
  '....tttttttt....',
  '....pppppppp....',
  '....pp....pp....',
  '....pp....pp....',
  '....bb....bb....',
];
function charFrame(colors, frame) {
  const rows = CHAR_BASE.map((r) => [...r]);
  // frame: 0 idle, 1 idle-blink, 2 walk-a, 3 walk-b
  if (frame === 1) { rows[4] = [...'....ssssssss....']; }
  if (frame === 2) { rows[13] = [...'...pp......pp...']; rows[14] = [...'...pp......pp...']; rows[15] = [...'...bb......bb...']; }
  if (frame === 3) { rows[13] = [...'.....pp..pp.....']; rows[14] = [...'.....pp..pp.....']; rows[15] = [...'.....bb..bb.....']; }
  const map = { h: colors.hair, s: colors.skin, e: 0, m: 4, t: colors.shirt, p: colors.pants, b: 0 };
  const c = canvas(16, 16);
  rows.forEach((r, y) => r.forEach((ch, x) => set(c, x, y, ch === '.' ? null : map[ch])));
  return c;
}
const CHARS = {
  a1: { hair: 1, skin: 15, shirt: 12, pants: 1 },
  a2: { hair: 8, skin: 15, shirt: 9, pants: 4 },
  a3: { hair: 5, skin: 15, shirt: 3, pants: 5 },
  p1: { hair: 7, skin: 15, shirt: 6, pants: 1 },
};

// ── 物件 16×16 / 图标 8×8 ──
const THINGS = {
  bench: () => { const c = canvas(16, 16); rect(c, 1, 6, 14, 4, 4); rect(c, 1, 6, 14, 1, 15); rect(c, 2, 10, 2, 5, 5); rect(c, 12, 10, 2, 5, 5); rect(c, 5, 3, 6, 3, 12); return c; },
  beds: () => { const c = canvas(16, 16); rect(c, 1, 6, 14, 8, 4); rect(c, 1, 6, 14, 3, 7); rect(c, 2, 9, 5, 3, 12); rect(c, 1, 14, 2, 2, 5); rect(c, 13, 14, 2, 2, 5); return c; },
  crates: () => { const c = canvas(16, 16); rect(c, 2, 8, 8, 7, 4); rect(c, 2, 8, 8, 1, 9); rect(c, 8, 2, 7, 6, 4); rect(c, 8, 2, 7, 1, 9); return c; },
  bedsG: () => { const c = canvas(16, 16); rect(c, 1, 10, 14, 4, 4); rect(c, 2, 6, 3, 4, 3); rect(c, 7, 5, 3, 5, 3); rect(c, 12, 6, 3, 4, 11); return c; },
  bucket: () => { const c = canvas(16, 16); rect(c, 5, 6, 6, 8, 5); rect(c, 5, 6, 6, 2, 12); rect(c, 4, 4, 8, 1, 6); rect(c, 4, 4, 1, 3, 6); rect(c, 11, 4, 1, 3, 6); return c; },
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
