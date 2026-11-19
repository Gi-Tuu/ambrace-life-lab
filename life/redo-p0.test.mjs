// P0（2026-11-19）渲染收敛闸门：把“2D 烘焙已删、素材只剩活清单、加载并发、静态可复验”钉在源码与资产上。
// 每条都能变红：恢复 paintTerrain/groundPixels/uGround、加回一张死 PNG、改回串行加载或 no-store 都会失败。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const APP = readFileSync('web/app.js', 'utf8');
const RENDER = readFileSync('web/camp-3d-render.mjs', 'utf8');
const SERVE = readFileSync('serve.mjs', 'utf8');
const ASSETS = 'web/assets';

const pngs = () => {
  const out = [];
  for (const name of readdirSync(ASSETS)) if (name.endsWith('.png')) out.push(name);
  const actions = join(ASSETS, 'actions');
  if (existsSync(actions)) for (const name of readdirSync(actions)) if (name.endsWith('.png')) out.push('actions/' + name);
  return out.sort();
};

test('R1 2D 烘焙整条链路已删：没有 canvas/ImageData/groundPixels/地形纹理', () => {
  assert.doesNotMatch(APP, /function paintTerrain\(/, 'paintTerrain 还在：2D 底图会继续在每次 buildWorld 里烘焙');
  assert.doesNotMatch(APP, /paintForestFloor|drawFogTerrain|groundPixels|shadeTiles|groundPixels/);
  assert.doesNotMatch(APP, /createImageData\(WORLD_W/, '仍在建整张世界 ImageData');
  assert.doesNotMatch(APP, /world\.canvas|canvas: cv/, 'world 仍挂 2D canvas');
  assert.match(APP, /function terrainKinds\(/, '缺少 terrainKinds（分类数据必须保留，walk/树种依赖它）');
  assert.match(APP, /const terrain = terrainKinds\(/, 'buildWorld 没有调用 terrainKinds');
});

test('R2 单一 3D 入口：?view=2d 与 2D 兜底绘制已删，硬失败提示保留', () => {
  assert.doesNotMatch(APP, /get\('view'\)|view=2d/, '?view=2d 开关还在');
  assert.doesNotMatch(APP, /dataset\.renderer='none'/, '仍会显示 2D 兜底画面');
  assert.match(APP, /dataset\.renderer='3d'/, '3D 渲染标记被删（真浏览器闸门 F6 会红）');
  assert.match(APP, /if \(!campRenderer\) \{ showGfxUnavailable\(true\); return; \}/, '没有 WebGL 时不再硬失败');
  assert.match(APP, /const GFX_FAILURE_LIMIT = \d+;/, 'F9 的连续失败上限被删');
  assert.doesNotMatch(APP, /placement\(|assetMasks|maskCache/, '2D 素材遮罩接线还在');
});

test('R3 渲染器只保留 regionAtlas：uGround 2D 底图 / uWater 水掩码分支已删', () => {
  assert.doesNotMatch(RENDER, /uWater|uHasWater|waterMask/, '水掩码分支还在');
  assert.doesNotMatch(RENDER, /terrainTexture\(|groundBuffer/, '2D 底图纹理/地面 quad 还在');
  assert.doesNotMatch(RENDER, /uniform\s+bool\s+uTexture/, 'shader 仍有 uTexture 开关');
  assert.match(RENDER, /atlasUpload\(regionAtlas\)/, 'regionAtlas 上传被删（3D 地面会变纯色）');
});

test('R4 资产只剩活清单：20 张 PNG（16 地形 + 4 头像），清单不指向不存在/死素材', () => {
  const list = pngs();
  assert.equal(list.length, 20, `PNG 数量 ${list.length}：死素材被加回或活素材被误删`);
  for (const name of list) {
    assert.match(name, /^(?:terrain_(?:grass|dirt|stone|water)[0-3]|actions\/portrait_(?:a1|a2|a3|p1))\.png$/, `意外保留的素材：${name}`);
  }
  const manifest = JSON.parse(readFileSync(join(ASSETS, 'manifest.json'), 'utf8'));
  const scenes = Object.entries(manifest.scenes ?? {});
  assert.equal(scenes.length, 16, 'manifest.scenes 不是 16 张地形');
  for (const [key, url] of scenes) {
    assert.match(key, /^terrain_/, `${key} 不是地形`);
    assert.ok(existsSync(join(ASSETS, url.replace('/web/assets/', ''))), `manifest 指向不存在的 ${url}`);
  }
  const actions = JSON.parse(readFileSync(join(ASSETS, 'actions', 'manifest.json'), 'utf8'));
  assert.deepEqual(Object.keys(actions.portraits ?? {}).sort(), ['a1', 'a2', 'a3', 'p1']);
  assert.equal(actions.chars, undefined, 'actions 清单又列出已删除的动作图集');
  // 开发工具必须不在运行路径
  for (const dead of ['pixel-editor.html', 'assets/pixel-overrides.json', 'assets/asset-collisions.json', 'assets/editor-catalog.js']) {
    assert.ok(!existsSync(join('web', dead)), `${dead} 又回到 web/ 运行路径`);
  }
});

test('R5 首屏加载并发 + 静态可复验缓存', () => {
  assert.match(APP, /const ASSET_CONCURRENCY = \d+;/, '缺少并发上限');
  assert.match(APP, /async function fetchLimit\(/, '缺少并发加载器');
  assert.match(APP, /await fetchLimit\(Object\.entries\(m\.scenes/, '地形 tile 没有并发加载');
  assert.match(APP, /loadAssets\(\);\s*\n\s*\/\/ 独立动画时钟/s, '启动仍在等 loadAssets（首屏被素材阻塞）');
  assert.match(SERVE, /if-none-match/, '静态文件不再支持 ETag 304');
  assert.match(SERVE, /const etag = /, '缺少内容 ETag');
  // 动态 JSON 仍应 no-store；静态面不得回退到 no-store。
  const staticFn = SERVE.slice(SERVE.indexOf('async function serveStatic'), SERVE.indexOf('// BUG-8'));
  assert.doesNotMatch(staticFn, /'cache-control':\s*'no-store'/, '静态文件又回到 no-store');
});
