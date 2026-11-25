#!/usr/bin/env node
// 零依赖模型测试客户端。令牌只从 AMBRACE_TEST_TOKEN / MODEL_TEST_TOKEN 读取，绝不写入仓库。
import process from 'node:process';

const args = process.argv.slice(2);
let json = false;
let base = process.env.AMBRACE_TEST_BASE ?? 'https://gituuu-ambrace-life-lab.ms.show/test/v1';
let model = process.env.AMBRACE_TEST_MODEL ?? 'qwen3.8-27b';
let maxTokens = Number(process.env.AMBRACE_TEST_MAX_TOKENS ?? 256);
const promptParts = [];

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '--json') json = true;
  else if (arg === '--base') base = args[++i] ?? '';
  else if (arg === '--model') model = args[++i] ?? '';
  else if (arg === '--max-tokens') maxTokens = Number(args[++i]);
  else if (arg === '--help' || arg === '-h') {
    console.log('用法: AMBRACE_TEST_TOKEN=... node scripts/model-test.mjs [--json] [--base URL] [--model ID] [--max-tokens N] "提示词"');
    console.log('未给提示词时从标准输入读取。默认端点: https://gituuu-ambrace-life-lab.ms.show/test/v1');
    process.exit(0);
  } else promptParts.push(arg);
}

const token = process.env.AMBRACE_TEST_TOKEN ?? process.env.MODEL_TEST_TOKEN ?? '';
if (!token) {
  console.error('缺少 AMBRACE_TEST_TOKEN（或 MODEL_TEST_TOKEN）。令牌不要写进仓库或前端。');
  process.exit(2);
}
let prompt = promptParts.join(' ').trim();
if (!prompt && !process.stdin.isTTY) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  prompt = Buffer.concat(chunks).toString('utf8').trim();
}
if (!prompt) {
  console.error('请给出提示词，或通过标准输入传入。');
  process.exit(2);
}

let url;
try {
  url = new URL('chat/completions', base.endsWith('/') ? base : base + '/');
} catch {
  console.error('AMBRACE_TEST_BASE 不是合法 URL。');
  process.exit(2);
}
url.searchParams.set('test_token', token);

try {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0 Safari/537.36',
    },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`HTTP ${res.status} ${String(body.error ?? 'REQUEST_FAILED')}`);
    process.exitCode = 1;
  } else if (json) {
    console.log(JSON.stringify(body, null, 2));
  } else {
    console.log(body?.choices?.[0]?.message?.content ?? '');
  }
} catch (error) {
  console.error(`请求失败：${String(error?.cause?.code ?? error?.name ?? 'NETWORK_ERROR')}`);
  process.exitCode = 1;
}
