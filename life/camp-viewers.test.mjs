// 第三轮 N3：请求里的 camp 必须先验一次，非法键不得在 campViewers 留永久记录。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { campViewerKeys, host } from './host.mjs';

test('N3 非法 camp 不产生 campViewers 条目；主营地照常打点', () => {
  const bad = ['../etc/passwd', 'a'.repeat(32), 'x'.repeat(40)];
  for (const key of bad) host.touch('survival', key);
  const keys = campViewerKeys();
  for (const key of bad) assert.ok(!keys.includes(key), '非法键不得留痕：' + key);
  host.touch('survival');
  assert.ok(campViewerKeys().includes('MAIN'), '无 camp 时按主营地打点');
});
