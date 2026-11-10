// 本地工作台的可视素材索引；不改写图片或覆盖稿。
import { readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export function writeEditorCatalog(dir) {
  const names = readdirSync(dir).filter(n => n.endsWith('.png'));
  const actions = join(dir, 'actions');
  if (existsSync(actions)) names.push(...readdirSync(actions).filter(n => n.endsWith('.png')).map(n => 'actions/' + n));
  names.sort();
  writeFileSync(join(dir, 'editor-catalog.js'), 'globalThis.PIXEL_CATALOG = ' + JSON.stringify(names, null, 2) + ';\n');
  return names;
}
