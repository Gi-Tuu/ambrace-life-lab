// 像素资产打包/校验（零依赖）。读 web/assets/*.png，校验：尺寸∈规格、颜色⊆palette、无插值中间色、
// 角色帧数=4；合格才写 manifest.json。不合格抛错（闸门能红）。
import { inflateSync } from 'node:zlib';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PALETTE } from './gen-pixel-assets.mjs';

const RGB = PALETTE.map((h) => `${parseInt(h.slice(1, 3), 16)},${parseInt(h.slice(3, 5), 16)},${parseInt(h.slice(5, 7), 16)}`);
const ALLOWED = new Set([...RGB, '0,0,0,0']);

function paeth(a, b, c) { const p = a + b - c; const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
export function decodePNG(buf) {
  let off = 8; let w = 0, h = 0, colorType = 0, bitDepth = 0; const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off); const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    off += 12 + len;
  }
  if (bitDepth !== 8 || colorType !== 6) throw new Error('只支持 RGBA8 PNG');
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * 4; const px = new Array(w * h), alphas = new Uint8Array(w * h);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride));
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? line[x - 4] : 0; const b = prev[x]; const c = x >= 4 ? prev[x - 4] : 0;
      if (filter === 1) line[x] = (line[x] + a) & 255;
      else if (filter === 2) line[x] = (line[x] + b) & 255;
      else if (filter === 3) line[x] = (line[x] + ((a + b) >> 1)) & 255;
      else if (filter === 4) line[x] = (line[x] + paeth(a, b, c)) & 255;
    }
    for (let x = 0; x < w; x++) {
      const i = x * 4; const alpha = line[i + 3]; alphas[y * w + x] = alpha;
      px[y * w + x] = alpha === 0 ? null : `${line[i]},${line[i + 1]},${line[i + 2]}`;
    }
    prev = line;
  }
  return { w, h, px, alphas };
}

const SIZES = { room: [96, 64], char: [16, 16], thing: [16, 16], icon: [8, 8], house: [128, 128], tree: [128, 160], terrain: [32, 32], prop: [64, 64] };
export function validateAsset(name, img) {
  const kind = name.startsWith('room_') ? 'room' : name.startsWith('char_') ? 'char' : name.startsWith('thing_') ? 'thing' : name.startsWith('icon_') ? 'icon' : name.startsWith('house_') ? 'house' : name.startsWith('tree_') ? 'tree' : name.startsWith('terrain_') ? 'terrain' : name.startsWith('prop_') ? 'prop' : null;
  if (!kind) throw new Error(`未知资产类型 ${name}`);
  const [w, h] = SIZES[kind];
  if (img.w !== w || img.h !== h) throw new Error(`${name} 尺寸 ${img.w}x${img.h} ≠ ${w}x${h}`);
  if (img.alphas?.some(a => a !== 0 && a !== 255)) throw new Error(`${name} 含半透明/抗锯齿像素`);
  for (const c of img.px) if (c !== null && !ALLOWED.has(c)) throw new Error(`${name} 含色板外/插值颜色 ${c}`);
  return kind;
}

export function pack(dir) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.png'));
  const manifest = { chars: {}, tiles: {}, things: {}, icons: {}, scenes: {}, palette: 'palette.json', scale: 3 };
  const charFrames = {};
  for (const f of files) {
    const img = decodePNG(readFileSync(join(dir, f)));
    const kind = validateAsset(f, img);
    const url = `/web/assets/${f}`;
    if (kind === 'room') manifest.tiles[f.slice(5, -4)] = url;
    else if (kind === 'thing') manifest.things[f.slice(6, -4)] = url;
    else if (kind === 'icon') manifest.icons[f.slice(5, -4)] = url;
    else if (['house', 'tree', 'terrain', 'prop'].includes(kind)) manifest.scenes[f.slice(0, -4)] = url;
    else {
      const m = f.match(/^char_(.+)_(\d)\.png$/); if (!m) throw new Error(`角色帧命名不符 ${f}`);
      (charFrames[m[1]] ??= [])[Number(m[2])] = url;
    }
  }
  for (const [id, frames] of Object.entries(charFrames)) {
    if (frames.length !== 4 || frames.some((x) => !x)) throw new Error(`角色 ${id} 帧数 ≠ 4`);
    manifest.chars[id] = { frames, fps: 4, anchor: [8, 16] };
  }
  if (Object.keys(manifest.scenes).length) {
    const expected = [
      ...['home', 'yard', 'hall', 'store', 'workshop', 'garden', 'watch', 'well'].map(x => `house_${x}`),
      ...[0, 1, 2].map(x => `tree_oak${x}`),
      ...['grass', 'dirt', 'water', 'wood', 'stone'].flatMap(x => [0, 1, 2, 3].map(i => `terrain_${x}${i}`)),
      ...['bed', 'table', 'longTable', 'bench', 'hearth', 'rug', 'shelf', 'crate', 'barrel', 'telescope', 'furnace', 'anvil', 'planter', 'trellis', 'well', 'bucket', 'fence', 'cart', 'banner', 'boulder', 'workbench'].map(x => `prop_${x}`),
    ];
    for (const key of expected) if (!manifest.scenes[key]) throw new Error(`缺失32px场景资产 ${key}`);
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const m = pack(resolve('web/assets'));
  console.log(`packed: ${Object.keys(m.chars).length} chars / ${Object.keys(m.tiles).length} rooms / ${Object.keys(m.things).length} things / ${Object.keys(m.icons).length} icons`);
}
