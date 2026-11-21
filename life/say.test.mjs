// S2-5：模型 say 端到端（假端点，零联网）——合法句子进 converse 且 served='node'；非法词表被丢弃。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const SEED = join(ROOT, 'seed', 'world.json');

// 假模型：从提示里抽第一个候选 id；前两次故意给非法 act，之后给合法句子。
let mode = 'invalid';
let calls = 0;
const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => { raw += d; });
  req.on('end', () => {
    calls += 1;
    let prompt = '';
    try { prompt = JSON.parse(raw).messages?.[0]?.content ?? ''; } catch { /* 忽略 */ }
    const m = /- ([^ |]+) \|/.exec(prompt);
    const id = m?.[1] ?? '1';
    const content = mode === 'invalid'
      ? JSON.stringify({ id, reason: '试一下', act: 'mind_control', topic: 'trust', text: '听我的' })
      : JSON.stringify({ id, reason: '说一句', act: 'greet', topic: 'trust', text: '风大，进屋说。' });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content } }], usage: { total_tokens: 20 } }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const dir = mkdtempSync(join(tmpdir(), 'say-'));
process.env.DATA_DIR = dir;
process.env.SEED_FILE = SEED;
process.env.TICK_MS = '10000000';
process.env.GAME_MS_PER_MINUTE = '10000000'; // 本文件用显式 step；冻住正式时钟避免自动推进抢戏
process.env.BRAIN = 'model';
process.env.MODEL_PROVIDERS = `http://127.0.0.1:${port}/v1`;
process.env.MODEL_KEYS = 'k';
process.env.MODEL_NAME = 'm';
process.env.GAME_MODE = 'game';
process.env.GAME_RULES = '1';
process.env.MODEL_UNATTENDED = '1';

const { host } = await import('./host.mjs');
// host 不读 env：provider 由 serve 注入（本测试直接注入）。
host.setBackend({ providers: [`http://127.0.0.1:${port}/v1`], keys: ['k'], model: 'm', models: ['m'], brain: 'model' });

test('S2-5 模型 say：合法句子进 converse 且 served=node；非法词表被丢弃', async (t) => {
  t.after(() => { try { host.stop(); } catch { /* 已停 */ } try { server.close(); } catch { /* 已关 */ } });
  await host.start();
  host.stop();
  host.touch('survival'); // 有观众：允许走真模型

  // 阶段 A：非法词表 —— 必须有调用，且 attempts 记 SAY:INVALID，绝不进 converse
  mode = 'invalid';
  let invalidSeen = false;
  for (let i = 0; i < 120 && !invalidSeen; i += 1) {
    await host.tickOnce();
    const attempts = host.snapshot()?.model?.attempts ?? [];
    if (attempts.includes('SAY:INVALID')) invalidSeen = true;
  }
  assert.ok(calls > 0, '假端点一次都没被调用：模型路径没走通');
  assert.ok(invalidSeen, '非法 act 应被丢弃并留 SAY:INVALID');
  assert.ok(!(host.snapshot()?.survival?.converse ?? []).some((e) => e.text === '听我的'), '非法词表的句子不得进 converse');

  // 阶段 B：合法句子 —— 必须出现 served='node' 且文本原样
  mode = 'valid';
  let node = null;
  for (let i = 0; i < 160 && !node; i += 1) {
    await host.tickOnce();
    node = (host.snapshot()?.survival?.converse ?? []).find((e) => e.served === 'node') ?? null;
  }
  assert.ok(node, '没等到一条 served=node 的对话（模型 say 未生效）');
  assert.equal(node.text, '风大，进屋说。');
  assert.equal(node.act, 'greet');
});
