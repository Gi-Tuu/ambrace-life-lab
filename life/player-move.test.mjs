// 阶段 3/4 抽出来的模块的闸门。
// 这些函数原来埋在 web/app.js 里，没有任何直接测试；搬出来之后可以用 Node 直接跑（无 DOM、无浏览器）。
// 变红法写在每条 test 名里：把对应的实现改坏，必须红。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  TILE, rectGap, exteriorAllows, detourAroundBodies, routeForWalker,
} from '../web/player-move.mjs';
import { legacyCampBodyWorld } from './research-space.mjs';
import { postJson, persistNotices } from '../web/net.mjs';

const makeGrid = (tw, th, fill = 1) => ({ tw, th, walk: new Uint8Array(tw * th).fill(fill) });

test('P3-01 rectGap：点在矩形内为 0，外部给到矩形边的欧氏距离 【变红法：把 max(...,0) 去掉】', () => {
  assert.equal(rectGap(5, 5, 0, 0, 10, 10), 0, '内部点应为 0');
  assert.equal(rectGap(12, 5, 0, 0, 10, 10), 2, '右侧 2 格');
  assert.equal(rectGap(12, 14, 0, 0, 10, 10), Math.hypot(2, 4), '对角要按欧氏距离，不是曼哈顿');
  assert.equal(rectGap(-3, -4, 0, 0, 10, 10), 5, '左上对角 3-4-5');
});

test('P3-02 TILE 由行走几何模块拥有，且仍是 16 【变红法：把 16 改成 32】', () => {
  assert.equal(TILE, 16);
});

test('P3-03/P4 体半径栅格包装只在研究夹具里：返回新栅格、不改写输入、openEdge 真的改变结果', () => {
  const world = { tw: 24, th: 24, collisionGrid: makeGrid(24, 24) };
  const closed = legacyCampBodyWorld(world);
  assert.notEqual(closed.collisionGrid, world.collisionGrid, '必须给出新栅格对象');
  assert.equal(world.collisionGrid.walk[0], 1, '输入栅格不得被改写');
  assert.equal(closed.tw, world.tw, '其它字段要沿用 world');
  const open = legacyCampBodyWorld(world, true);
  assert.equal(open.collisionGrid.walk[0], 1, 'openEdge 下边缘格也可走');
  assert.equal(closed.collisionGrid.walk[0], 0, '非 openEdge 下贴边格要按身体半径挖掉');
  assert.notDeepEqual(open.collisionGrid.walk, closed.collisionGrid.walk, 'openEdge 必须真的不同');
  // 正式模块不得再提供这个包装（正式路径统一到 space collider + 构建期 pathGrid）。
  assert.equal(/campBodyWorld/.test(readFileSync(new URL('../web/player-move.mjs', import.meta.url), 'utf8')), false);
});

test('P3-04 exteriorAllows：没有地形就是 false；有地形时按身体半径躲开外围实体 【变红法：删掉 outsideSolids 检查】', () => {
  assert.equal(exteriorAllows({}, 1, 1), false, 'world.landscape 缺失时不该放行');
  const flat = { landscape: { walkable: () => true } };
  assert.equal(exteriorAllows(flat, 3, 3), true, '空地应放行');
  const blocked = { landscape: { walkable: () => true }, outsideSolids: [{ x: 3, z: 3, w: 1, d: 1 }] };
  assert.equal(exteriorAllows(blocked, 3, 3), false, '站在实体格上必须不行');
  const near = { landscape: { walkable: () => true }, outsideSolids: [{ x: 3, z: 3, w: 1, d: 1 }] };
  assert.equal(exteriorAllows(near, 3.3, 3.5), false, '身体半径内必须挡住');
  const wall = { landscape: { walkable: (x) => x !== 4 } };
  assert.equal(exteriorAllows(wall, 4, 2), false, '地形自己说不可走就不行');
});

test('P3-05 routeForWalker：通路给出路径、封死给 null，且不改写世界的寻路栅格 【变红法：把 return null 改成 return [] 】', () => {
  const open = { tw: 24, th: 24, pathGrid: makeGrid(24, 24) };
  const path = routeForWalker(open, { x: 2, y: 2 }, [10, 10]);
  assert.ok(Array.isArray(path) && path.length > 0, '空旷地图应当能找到路');
  const last = path.at(-1);
  assert.ok(Math.hypot(last[0] - 10, last[1] - 10) < 1.5, `路径终点应落在目标附近，实际 ${JSON.stringify(last)}`);

  const walled = { tw: 24, th: 24, pathGrid: makeGrid(24, 24) };
  for (let y = 0; y < 24; y += 1) walled.pathGrid.walk[y * 24 + 12] = 0;
  assert.equal(routeForWalker(walled, { x: 2, y: 2 }, [20, 2]), null, '中间整列封死时必须给 null');
  assert.equal(walled.pathGrid.walk[0], 1, '寻路过程不得改写世界的寻路栅格');
});

test('P3-06 detourAroundBodies：附近没人返回 null；有人时只读栅格副本 【变红法：把 grid.walk.slice() 改成 grid.walk】', () => {
  const world = { tw: 24, th: 24, pathGrid: makeGrid(24, 24) };
  const walker = { x: 4, y: 4, path: [[10, 10]] };
  assert.equal(detourAroundBodies(world, walker, []), null, '附近没有人时不该绕');
  const before = Array.from(world.pathGrid.walk);
  detourAroundBodies(world, walker, [{ x: 5.5, z: 5.5, r: 0.4 }]);
  assert.deepEqual(Array.from(world.pathGrid.walk), before, '绕人不能把障碍写回世界栅格');
});

test('P4-01 persistNotices：存档失败/成功的判定与抽离前逐字一致 【变红法：把 persisted===false 的分支删掉】', () => {
  assert.equal(persistNotices({ persisted: false }, '/act'), 'lost');
  assert.equal(persistNotices({ persisted: true }, '/act'), 'ok');
  assert.equal(persistNotices({}, '/world'), 'ok', '/world 无 saveError 视为正常');
  assert.equal(persistNotices({ saveError: 'ENOSPC' }, '/world'), null, '/world 有 saveError 时不该清掉提示');
  assert.equal(persistNotices({}, '/act'), null, '动作没带 persisted 字段时不动提示');
});

test('P4-02 postJson：POST 形状正确、非 2xx 抛错、成功返回 JSON 【变红法：删掉 !res.ok 的 throw】', async () => {
  const realFetch = globalThis.fetch;
  const seen = [];
  try {
    globalThis.fetch = async (url, init) => {
      seen.push({ url, init });
      if (url === '/boom') return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ ok: 1 }) };
    };
    const good = await postJson('/world');
    assert.deepEqual(good, { ok: 1 });
    assert.equal(seen[0].init, undefined, '不带 body 时不应伪造 POST 选项');

    await postJson('/act', { kind: 'move' });
    assert.equal(seen[1].init.method, 'POST');
    assert.equal(seen[1].init.headers['content-type'], 'application/json');
    assert.equal(seen[1].init.body, JSON.stringify({ kind: 'move' }));

    await assert.rejects(() => postJson('/boom'), /HTTP 500/, '非 2xx 必须抛错，不能静默当成功');
  } finally {
    globalThis.fetch = realFetch;
  }
});
