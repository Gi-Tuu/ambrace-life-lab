import test from 'node:test';
import assert from 'node:assert/strict';
import { CURRENT_LAYOUT } from '../shared/layout-version.mjs';
import { CURRENT_LAYOUT as WEB_LAYOUT } from '../shared/camp-layout.mjs';
test('ARCH4-06 shared 与服务端布局常量一致', () => assert.equal(CURRENT_LAYOUT, WEB_LAYOUT));
test('ARCH4-06-INTEGER shared 常量是有限整数', () => assert.ok(Number.isInteger(CURRENT_LAYOUT) && CURRENT_LAYOUT > 0));

