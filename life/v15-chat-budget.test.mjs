// 1.5 自由对话预算闸门：节点日额度用完后，下一轮必须模板回退且不再发请求。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'ambrace-v15-budget-'));
process.env.DATA_DIR = DIR;
process.env.SEED_FILE = join(DIR, 'none.json');
process.env.GAME_MODE = 'game';
process.env.GAME_RULES = '1';
process.env.SIM_TIME = '1';
process.env.TICK_MS = '1000000';
process.env.GAME_MS_PER_MINUTE = '600000';
process.env.MAX_CALLS = '100';
process.env.NODE_CALLS_DAY = '1';
process.env.MODEL_TIMEOUT_MS = '150';
process.env.MODEL_BREAKER_FAILS = '99';
process.env.MODEL_UNATTENDED = '0';
process.env.PRESENCE_MS = '600000';

const { host, campSurv } = await import('./host.mjs');
const { worldSite } = await import('./geometry.mjs');
test.after(() => host.stop());

test('V15-09 节点日预算用完后自由对话退模板，不再发模型请求', async (t) => {
  await host.start();
  t.after(() => host.stop());
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    const prompt = String(JSON.parse(init?.body ?? '{}').messages?.[0]?.content ?? '');
    if (prompt.includes('只回一句中文台词')) {
      calls += 1;
      return new Response(JSON.stringify({ choices: [{ message: { content: '模型台词' } }], usage: { total_tokens: 2 } }), { headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"id":"rest","reason":"夹具"}' } }], usage: { total_tokens: 1 } }), { headers: { 'content-type': 'application/json' } });
  };
  host.setBackend({ providers: ['http://127.0.0.1:9/v1'], keys: ['fixture-key'], models: ['fixture'], brain: 'model' });
  const sp = campSurv(null), w = sp.world;
  w.agents.a1.drives.v.social = .5;
  w.agents.a1.drives.v.energy = .9;
  w.loc.a1 = 'yard'; w.loc.p1 = 'yard';
  w.survival.playerPos = { x: worldSite(w, 'yard')[0] + .5, z: worldSite(w, 'yard')[1] + .5, t: w.t };
  w.survival.playerReachState = { t: w.t, allowance: 100, sub: 0 };
  const [x, z] = worldSite(w, 'yard');
  const contact = { target: 'a1', room: null, from: [x + .5, z + .5], to: [x + .5, z + .5] };
  host.touch('survival');
  assert.ok((await host.act({ mode: 'survival', kind: 'camp_talk', ...contact })).ok);

  const first = await host.act({ mode: 'survival', kind: 'camp_talk_say', ...contact, text: '第一句' });
  assert.equal(first.served, 'model', JSON.stringify(first));
  assert.equal(calls, 1);
  const second = await host.act({ mode: 'survival', kind: 'camp_talk_say', ...contact, text: '第二句' });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.served, 'template', '预算用完后必须模板回退');
  assert.ok(second.line.length > 0);
  assert.equal(calls, 1, '预算用完后不得再发模型请求');
  assert.ok((host.snapshot().model.attempts ?? []).some((a) => String(a).includes('NODE_BUDGET')), JSON.stringify(host.snapshot().model.attempts));
  await host.act({ mode: 'survival', kind: 'camp_talk_close', target: 'a1' });
});
