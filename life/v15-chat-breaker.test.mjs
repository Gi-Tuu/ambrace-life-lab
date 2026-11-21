// 1.5 自由对话熔断闸门：免费节点连续失败后 breaker 打开，后续轮次不再白等，直接模板。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'ambrace-v15-breaker-'));
process.env.DATA_DIR = DIR;
process.env.SEED_FILE = join(DIR, 'none.json');
process.env.GAME_MODE = 'game';
process.env.GAME_RULES = '1';
process.env.SIM_TIME = '1';
process.env.TICK_MS = '1000000';
process.env.GAME_MS_PER_MINUTE = '600000';
process.env.MAX_CALLS = '100';
process.env.NODE_CALLS_DAY = '100';
process.env.MODEL_TIMEOUT_MS = '150';
process.env.MODEL_BREAKER_FAILS = '2';
process.env.MODEL_BREAKER_MS = '600000';
process.env.MODEL_UNATTENDED = '0';
process.env.PRESENCE_MS = '600000';

const { host, campSurv } = await import('./host.mjs');
const { worldSite } = await import('./geometry.mjs');
test.after(() => host.stop());

test('V15-10 免费节点连续失败 → breaker 打开 → 自由对话不再请求模型，仍返回模板', async (t) => {
  await host.start();
  t.after(() => host.stop());
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    const prompt = String(JSON.parse(init?.body ?? '{}').messages?.[0]?.content ?? '');
    if (prompt.includes('只回一句中文台词')) {
      calls += 1;
      return new Response('', { status: 503 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"id":"rest","reason":"夹具"}' } }], usage: { total_tokens: 1 } }), { headers: { 'content-type': 'application/json' } });
  };
  host.setBackend({ providers: ['http://127.0.0.1:9/v1'], keys: ['fixture-key'], models: ['fixture'], brain: 'model' });
  const sp = campSurv(null), w = sp.world;
  w.agents.a1.drives.v.social = .5;
  w.agents.a1.drives.v.energy = .9;
  w.loc.a1 = 'yard'; w.loc.p1 = 'yard';
  const [x, z] = worldSite(w, 'yard');
  w.survival.playerPos = { x: x + .5, z: z + .5, t: w.t };
  w.survival.playerReachState = { t: w.t, allowance: 100, sub: 0 };
  const contact = { target: 'a1', room: null, from: [x + .5, z + .5], to: [x + .5, z + .5] };
  host.touch('survival');
  assert.ok((await host.act({ mode: 'survival', kind: 'camp_talk', ...contact })).ok);

  const first = await host.act({ mode: 'survival', kind: 'camp_talk_say', ...contact, text: '第一句' });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.served, 'template');
  const second = await host.act({ mode: 'survival', kind: 'camp_talk_say', ...contact, text: '第二句' });
  assert.equal(second.served, 'template');
  assert.equal(host.status().breaker.open, true, `breaker 未打开：${JSON.stringify(host.status().breaker)}`);
  assert.equal(calls, 2, `熔断前应恰好试 2 次，实测 ${calls}`);
  const third = await host.act({ mode: 'survival', kind: 'camp_talk_say', ...contact, text: '第三句' });
  assert.equal(third.ok, true, JSON.stringify(third));
  assert.equal(third.served, 'template');
  assert.equal(calls, 2, 'breaker 打开后不得再发请求');
  await host.act({ mode: 'survival', kind: 'camp_talk_close', target: 'a1' });
});
