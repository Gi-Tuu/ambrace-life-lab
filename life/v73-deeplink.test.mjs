// V7.3 深链回归：?room=hall 必须在模块求值期就走通，不能因引用已删的 2D 期 INTERIORS 表
// 抛 ReferenceError，导致 __lifeDebug 已存在但 S/view 永不赋值（浏览器测试假绿）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ROOM_INTERIORS } from '../shared/room-layout.mjs';
import { HOUSING_PLOTS } from '../shared/camp-layout.mjs';

const APP = readFileSync(fileURLToPath(new URL('../web/app.js', import.meta.url)), 'utf8');
const V73 = readFileSync(fileURLToPath(new URL('../scripts/v73-busy-cancel-browser.mjs', import.meta.url)), 'utf8');
const V731 = readFileSync(fileURLToPath(new URL('../scripts/v731-browser.mjs', import.meta.url)), 'utf8');

test('V73 深链房间键 = ROOM_INTERIORS ∪ HOUSING_PLOTS，且不再引用已删的 INTERIORS', () => {
  assert.deepEqual(Object.keys(ROOM_INTERIORS).sort(),
    ['garden', 'hall', 'home', 'store', 'watch', 'well', 'workshop', 'yard']);
  assert.ok(Object.keys(HOUSING_PLOTS).length > 0, '住宅内景键不能为空');
  assert.doesNotMatch(APP, /Object\.hasOwn\(INTERIORS\b/, '深链还在引用已删除的 INTERIORS');
  assert.match(APP, /ROOM_INTERIORS/, '深链必须使用 shared/room-layout.mjs 的唯一数据源');
  assert.match(APP, /Object\.hasOwn\(ROOM_INTERIORS, bootRoom\)/);
  assert.match(APP, /Object\.hasOwn\(HOUSING_PLOTS, bootRoom\)/);
});

test('V73-BROWSER-WAIT 浏览器测试等待真实世界状态（S.view）并收集 pageerror，不再用 __lifeDebug 假绿', () => {
  for (const [name, source] of [['v73', V73], ['v731', V731]]) {
    assert.match(source, /__lifeDebug\?\.S\?\.view/, `${name} 必须等 S.view 而不是仅等 __lifeDebug`);
    assert.match(source, /__pageErrors/, `${name} 必须收集页面异常`);
    assert.match(source, /addEventListener\('error'/, `${name} 必须监听 error`);
  }
});
