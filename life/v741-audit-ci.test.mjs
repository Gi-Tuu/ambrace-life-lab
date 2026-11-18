import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromeGate } from './chrome-gate.mjs';
test('TEST4-09 CI 浏览器缺失必须显式失败（不是静默 skip）', () => {
  const y = readFileSync('.github/workflows/check.yml', 'utf8');
  assert.match(y, /REQUIRE_CHROME:\s*'1'/, 'CI 必须强制 REQUIRE_CHROME=1');
  assert.match(y, /chrome --version|chromium --version/, 'CI 必须显式验证 Chrome 存在');
  const missing = chromeGate({ requireChrome: true, exists: () => false });
  assert.equal(missing.fail, true, 'REQUIRE_CHROME=1 且无 Chrome 时必须判失败');
  const optional = chromeGate({ requireChrome: false, exists: () => false });
  assert.equal(optional.skip, true, '未强制时才允许显式 skip');
});
