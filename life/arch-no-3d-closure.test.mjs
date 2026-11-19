// ARCH-NO-3D：服务端入口的模块加载闭包不得含 3D / WebGL / web 前端模块。
// 这是"server 去 3D 闭包"的验收：不是 grep 源码，而是真子进程 import host.mjs 与 serve.mjs 后看加载表。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
function probe(target) {
  const r = spawnSync(process.execPath, ['scripts/module-closure-probe.mjs', target], {
    cwd: ROOT, encoding: 'utf8', timeout: 120000,
  });
  assert.equal(r.status, 0, `${target} 探针失败：${r.stderr}`);
  const line = r.stdout.trim().split('\n').at(-1);
  return JSON.parse(line);
}

for (const target of ['host', 'serve']) {
  test(`ARCH-NO-3D ${target}: 加载闭包不含 camp-3d-* / WebGL / web 前端模块`, () => {
    const { modules, webgl } = probe(target);
    assert.ok(modules.length > 0, '探针没记录到任何模块');
    const three = modules.filter((m) => /(^|\/)web\/camp-3d-/.test(m) || /(^|\/)camp-3d-/.test(m));
    assert.deepEqual(three, [], `${target} 闭包含 3D 模块：${three.join(', ')}`);
    assert.deepEqual(webgl, [], `${target} 闭包含 WebGL 渲染模块：${webgl.join(', ')}`);
    const web = modules.filter((m) => m.startsWith('web/'));
    assert.deepEqual(web, [], `${target} 闭包仍加载 web/ 模块：${web.join(', ')}`);
  });
}
