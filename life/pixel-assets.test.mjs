// 像素资产闸门（ui-pixel-spec §6）：生成→打包→校验；不合格必须红。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generate, PALETTE } from '../scripts/gen-pixel-assets.mjs';
import { pack, decodePNG, validateAsset } from '../scripts/pack-assets.mjs';

test('A1 生成+打包：4 角色×4 帧 / 8 房间 / 5 物件 / 5 图标，manifest 齐全', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pixel-'));
  generate(dir);
  const m = pack(dir);
  assert.equal(Object.keys(m.chars).length, 4);
  for (const c of Object.values(m.chars)) assert.equal(c.frames.length, 4);
  assert.equal(Object.keys(m.tiles).length, 8);
  assert.equal(Object.keys(m.things).length, 5);
  assert.equal(Object.keys(m.icons).length, 5);
});

test('A2 所有 PNG 颜色 ⊆ PICO-8 色板（+透明），尺寸∈规格', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pixel-'));
  generate(dir);
  const m = pack(dir); // pack 内部已逐张 validate；这里再独立解码抽查一张角色一张房间
  const allowed = new Set(PALETTE.map((h) => `${parseInt(h.slice(1, 3), 16)},${parseInt(h.slice(3, 5), 16)},${parseInt(h.slice(5, 7), 16)}`));
  for (const f of ['char_a1_0.png', 'room_home.png', 'icon_coin.png']) {
    const img = decodePNG(readFileSync(join(dir, f)));
    for (const c of img.px) if (c !== null) assert.ok(allowed.has(c), `${f} 含色板外颜色 ${c}`);
  }
  assert.ok(m.chars.a1.frames[0].endsWith('char_a1_0.png'));
});

test('A3 校验能红：色板外颜色 / 错尺寸 / 缺帧 都抛错', () => {
  assert.throws(() => validateAsset('char_x_0.png', { w: 16, h: 16, px: ['255,0,255'] }), /色板外/);
  assert.throws(() => validateAsset('room_home.png', { w: 96, h: 63, px: [] }), /尺寸/);
  assert.throws(() => validateAsset('nope.png', { w: 1, h: 1, px: [] }), /未知资产类型/);
  const dir = mkdtempSync(join(tmpdir(), 'pixel-'));
  generate(dir);
  // 删一帧 ⇒ 角色帧数 ≠ 4 ⇒ pack 抛错
  rmSync(join(dir, 'char_a1_3.png'));
  assert.throws(() => pack(dir), /帧数/);
});
