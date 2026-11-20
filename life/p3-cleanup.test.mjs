// P3 静态收口闸门：2D shim/生成器/符号不得回流，部署面仍是白名单 + 20 张活素材。
// 每条都对应 P3 的验收项，改回旧形态会直接变红。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const read = (p) => readFileSync(p, 'utf8');
const APP = read('web/app.js');
const RENDER = read('web/camp-3d-render.mjs');
const SERVE = read('serve.mjs');
const DOCKER = read('Dockerfile');
const IGNORE = read('.dockerignore');
const PKG = JSON.parse(read('package.json'));

test('P3-01 web/ 不再有 re-export 壳：所有相对导出直接指向 shared/', () => {
  const shims = readdirSync('web').filter((f) => f.endsWith('.mjs'))
    .filter((f) => /export\s+\*\s+from\s+['"]\.\.\/shared\//.test(read(join('web', f))));
  assert.deepEqual(shims, [], `仍有 web 兼容层：${shims.join(',')}`);
  for (const dead of ['asset-collision', 'camp-3d-physics', 'camp-3d-scene', 'camp-construction-access',
    'camp-districts', 'camp-facility', 'camp-interaction', 'camp-layout', 'camp-outskirts',
    'camp-region-entities', 'camp-terrain', 'hall-front', 'wild-landscape']) {
    assert.equal(existsSync(join('web', dead + '.mjs')), false, `web/${dead}.mjs 壳又回来了`);
  }
  // 运行路径与测试都不许再 import ../web/<已删壳>（非壳 web 模块如 audio/walk 仍可被测试引用）。
  const dead = ['asset-collision', 'camp-3d-physics', 'camp-3d-scene', 'camp-construction-access',
    'camp-districts', 'camp-facility', 'camp-interaction', 'camp-layout', 'camp-outskirts',
    'camp-region-entities', 'camp-terrain', 'hall-front', 'wild-landscape'];
  const re = new RegExp(`from\\s+['"](\\.\\./web/(?:${dead.join('|')}))\\.mjs['"]`, 'g');
  const offenders = [];
  for (const file of [...readdirSync('life').filter((f) => f.endsWith('.mjs')).map((f) => join('life', f)),
    ...readdirSync('web').filter((f) => f.endsWith('.mjs') || f.endsWith('.js')).map((f) => join('web', f))]) {
    const text = read(file);
    for (const m of text.matchAll(re)) offenders.push(`${file} → ${m[1]}.mjs`);
  }
  assert.deepEqual(offenders, [], `仍有测试/模块从 web 兼容层导入：${offenders.slice(0, 5).join(', ')}`);
});

test('P3-02 2D 生成器退役：gen-pixel-assets/pack-assets/assets 脚本不再存在', () => {
  assert.equal(existsSync('scripts/gen-pixel-assets.mjs'), false, '2D 像素生成器又回来了');
  assert.equal(existsSync('scripts/pack-assets.mjs'), false, '2D 打包器又回来了');
  assert.equal(PKG.scripts.assets, undefined, 'npm run assets（2D 管线）又回来了');
  assert.equal(PKG.scripts.actions, 'node scripts/gen-actions.mjs', '头像生成器应保留');
  assert.equal(existsSync('life/pixel-assets.test.mjs'), false, '2D 生成器测试又回来了');
});

test('P3-03 死 2D 符号不得回流到运行路径', () => {
  assert.doesNotMatch(APP, /paintTerrain\(|groundPixels|view=2d|dataset\.renderer='none'/);
  assert.doesNotMatch(RENDER, /uGround|uWater|uHasWater|waterMask|terrainTexture\(|groundBuffer|uniform\s+bool\s+uTexture/);
  assert.match(RENDER, /uniform sampler2D uRegionAtlas/, '地形图集 sampler 应叫 uRegionAtlas');
});

test('P3-04 素材只剩 20 张活 PNG（16 地形 + 4 头像），清单不指向死文件', () => {
  const pngs = [];
  for (const name of readdirSync('web/assets')) if (name.endsWith('.png')) pngs.push(name);
  for (const name of readdirSync('web/assets/actions')) if (name.endsWith('.png')) pngs.push('actions/' + name);
  assert.equal(pngs.length, 20, `PNG 数量 ${pngs.length}`);
  assert.equal(pngs.filter((p) => p.startsWith('actions/')).length, 4);
  assert.equal(JSON.parse(read('web/assets/manifest.json')).scenes ? Object.keys(JSON.parse(read('web/assets/manifest.json')).scenes).length : 0, 16);
  assert.equal(read('web/assets/actions/manifest.json').includes('"actions"'), false, '动作图集清单不得回流');
});

test('P3-05 CSP 只放魔搭两域（含 *.ms.show），无裸 *、无 X-Frame-Options', () => {
  const decl = SERVE.match(/const FRAME_ANCESTORS = "([^"]+)"/);
  assert.ok(decl, 'serve.mjs 里找不到 FRAME_ANCESTORS 常量');
  const directive = decl[1].match(/frame-ancestors([^;]*)/);
  assert.ok(directive, `FRAME_ANCESTORS 里没有 frame-ancestors：${decl[1]}`);
  const sources = directive[1].trim().split(/\s+/);
  for (const src of ["'self'", 'https://*.ms.show', 'https://modelscope.cn', 'https://www.modelscope.cn']) {
    assert.ok(sources.includes(src), `frame-ancestors 缺 ${src}：${directive[1].trim()}`);
  }
  assert.equal(sources.includes('*'), false, 'frame-ancestors 不许裸 *');
  assert.doesNotMatch(SERVE, /['"]x-frame-options['"]\s*:/i, 'X-Frame-Options 会与 CSP 白名单冲突');
});

test('P3-06 life/ 不整目录暴露、.env 不进镜像、Docker 只 COPY 运行必需目录', () => {
  // 静态面白名单：/life/ 只有 space.mjs 一个出口。
  assert.match(SERVE, /rel === '\/life\/space\.mjs' \? 'life' : null/, 'serve 的 life/ 白名单变了');
  assert.doesNotMatch(SERVE, /'\/life\/'\s*\)/, 'serve 不得整目录放行 life/');
  assert.match(IGNORE, /^\.env$/m);
  assert.match(IGNORE, /^\.env\.\*$/m);
  const copies = DOCKER.split('\n').filter((l) => /^COPY\s/.test(l)).map((l) => l.trim());
  assert.deepEqual(copies.sort(), ['COPY life/ ./life/', 'COPY seed/ ./seed/', 'COPY serve.mjs ./', 'COPY shared/ ./shared/', 'COPY web/ ./web/'].sort());
  assert.doesNotMatch(DOCKER, /^COPY\s+\.\s/m, 'Dockerfile 不得 COPY 整个仓库');
});
