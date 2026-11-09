// 测试入口：自动发现 life/*.test.mjs 并逐个点名交给 node --test。
// 为什么要有它：README 原先是一条 896 字符、点名 35 个文件的命令，历史台账自己记过"这条命令漏过文件"。
// 发现式入口让"磁盘上有哪些测试文件"成为唯一事实来源，不会再漏。
// 用法：node scripts/test.mjs            等价于作者原先的点名命令
//       node scripts/test.mjs --coverage 附带 Node 内建覆盖率（零依赖）
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const files = readdirSync(join(ROOT, 'life'))
  .filter((f) => f.endsWith('.test.mjs'))
  .sort()
  .map((f) => `life/${f}`);

if (!files.length) {
  console.error('没有发现任何 life/*.test.mjs —— 测试入口失效');
  process.exit(1);
}

const wantCoverage = process.argv.includes('--coverage');
const args = [];
if (wantCoverage) args.push('--experimental-test-coverage');
args.push('--test', ...files);

console.log(`# 测试文件 ${files.length} 个（发现式；与 ls life/*.test.mjs 同源）`);
if (wantCoverage) console.log('# 附带覆盖率：node --experimental-test-coverage（内建，无第三方依赖）');

const r = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
process.exit(r.status ?? 1);
