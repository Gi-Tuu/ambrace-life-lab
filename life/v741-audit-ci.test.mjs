import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
test('TEST4-09 CI 浏览器缺失必须显式标注（不是静默 skip）', () => { const y = readFileSync('.github/workflows/check.yml', 'utf8'); assert.ok(/REQUIRE_CHROME|chrome/i.test(y), 'CI 文件缺少 Chrome 显式策略'); });
