// 手工像素覆盖：保留程序化底稿，重生成后应用用户保存的整张素材。
import { existsSync, readFileSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
export function overridesFor(dir, paletteSize) {
  const actions = basename(dir) === 'actions';
  const file = join(actions ? dirname(dir) : dir, 'pixel-overrides.json');
  if (!existsSync(file)) return (_name, w, h, px) => px;
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  if (doc.version !== 1 || !doc.assets || typeof doc.assets !== 'object') throw new Error('像素覆盖格式错误');
  return (name, w, h, px) => {
    const edit = doc.assets[(actions ? 'actions/' : '') + name];
    if (!edit) return px;
    if (edit.width !== w || edit.height !== h || !Array.isArray(edit.pixels) || edit.pixels.length !== w*h || edit.pixels.some(v => v !== null && (!Number.isInteger(v) || v < 0 || v >= paletteSize))) throw new Error(`像素覆盖不符合尺寸或色板：${name}`);
    return edit.pixels;
  };
}
