// 本地工作台的可视素材索引；不改写图片或覆盖稿。
// P0（2026-11-19）：像素工作台已移出运行时目录 web/，索引写到 tools/pixel-editor/。
import { readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const EDITOR_DIR = join(ROOT, 'tools', 'pixel-editor');

export function writeEditorCatalog(dir) {
  const names = readdirSync(dir).filter(n => n.endsWith('.png'));
  const actions = join(dir, 'actions');
  if (existsSync(actions)) names.push(...readdirSync(actions).filter(n => n.endsWith('.png')).map(n => 'actions/' + n));
  names.sort();
  mkdirSync(EDITOR_DIR, { recursive: true });
  writeFileSync(join(EDITOR_DIR, 'editor-catalog.js'), 'globalThis.PIXEL_CATALOG = ' + JSON.stringify(names, null, 2) + ';\n');
  return names;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const names = writeEditorCatalog(join(ROOT, 'web', 'assets'));
  console.log(`editor catalog: ${names.length} 张 → tools/pixel-editor/editor-catalog.js`);
}
