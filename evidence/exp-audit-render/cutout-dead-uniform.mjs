// 只读审计脚本：证明 uCutout 是死 uniform（声明在 VERTEX，但 main() 从未引用；FRAGMENT 完全没有）。
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../../web/camp-3d-render.mjs', import.meta.url), 'utf8');
const grab = (name) => {
  const start = src.indexOf(`const ${name} = \``) + `const ${name} = \``.length;
  const end = src.indexOf('`;', start);
  return src.slice(start, end);
};
const vertex = grab('VERTEX'), fragment = grab('FRAGMENT');
const mainOf = (s) => s.slice(s.indexOf('void main()'));
const count = (s, re) => (s.match(re) || []).length;
console.log(JSON.stringify({
  vertex_uCutout_total: count(vertex, /uCutout/g),
  vertex_uCutout_in_main: count(mainOf(vertex), /uCutout/g),
  fragment_uCutout_total: count(fragment, /uCutout/g),
  fragment_discard_total: count(fragment, /discard/g),
  vertex_main: mainOf(vertex).trim().split('\n').map(l => l.trim()).filter(Boolean),
}, null, 1));
// getUniformLocation 对未被使用的 uniform 返回 null；gl.uniform4f(null,...) 在 WebGL 中是静默 no-op。
console.log('=> uCutout 在 VERTEX 里只声明、未使用；FRAGMENT 完全没有 cutout/discard 逻辑。',
  '\n=> ink/挖洞从未发生：paintStage 的 cutout 分支（camp-3d-render.mjs:833-840）只是把屋顶按原色重画。');
