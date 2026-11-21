// 对话计数对"旧形状存档"的兼容闸门：仓库里的 seed/world.json 只有 model:{calls,tokens,attempts}，
// 没有 chatter（也没有 moneyCalls/nodeCalls）。全新部署第一次读档就会走这条路径——
// 那一刻 /world 里到底有没有 chatter 这一格，决定线上能不能当天就读出落地率。
// 变红法：删掉 life/host-world.mjs 里 `S.model.chatter ??= {...}` 那行，第一条断言立刻红。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'ambrace-chatter-seed-'));
process.env.DATA_DIR = DIR;
process.env.SEED_FILE = join(process.cwd(), 'seed', 'world.json');   // 真种子，不造夹具
process.env.GAME_MODE = 'game';
process.env.GAME_RULES = '1';
process.env.SIM_TIME = '1';
process.env.TICK_MS = '1000000';
process.env.GAME_MS_PER_MINUTE = '600000';
process.env.MAX_CALLS = '50';
process.env.NODE_CALLS_DAY = '50';
process.env.MODEL_TIMEOUT_MS = '150';
process.env.MODEL_BREAKER_FAILS = '99';
process.env.MODEL_UNATTENDED = '0';
process.env.PRESENCE_MS = '600000';

const { host, campSurv } = await import('./host.mjs');
const { worldSite } = await import('./geometry.mjs');

test('CHATTER-02 读入没有 chatter 的旧档后，/world 仍给出零计数并能往上加', async (t) => {
  await host.start();
  t.after(() => host.stop());

  const chatter = host.snapshot('survival').survival.model.chatter;
  assert.ok(chatter, '/world 的 survival.model.chatter 必须存在（旧档没这一格也要补出来）');
  assert.deepEqual(chatter, { asked: 0, ok: 0, timeout: 0, http: 0, empty: 0, invalid: 0 },
    `旧档读入后应是一格零，实测 ${JSON.stringify(chatter)}`);

  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { content: '井台那头还等着人搬石头。' } }], usage: { total_tokens: 2 },
  }), { headers: { 'content-type': 'application/json' } });
  host.setBackend({ providers: ['http://127.0.0.1:9/v1'], keys: ['fixture-key'], models: ['fixture'], brain: 'model' });

  const sp = campSurv(null), w = sp.world;
  w.agents.a1.drives.v.social = .5;
  w.agents.a1.drives.v.energy = .9;
  w.loc.a1 = 'yard'; w.loc.p1 = 'yard';
  const [x, z] = worldSite(w, 'yard');
  w.survival.playerPos = { x: x + .5, z: z + .5, t: w.t };
  w.survival.playerReachState = { t: w.t, allowance: 100, sub: 0 };
  host.touch('survival');

  const contact = { target: 'a1', room: null, from: [x + .5, z + .5], to: [x + .5, z + .5] };
  assert.ok((await host.act({ mode: 'survival', kind: 'camp_talk', ...contact })).ok);
  const got = await host.act({ mode: 'survival', kind: 'camp_talk_say', ...contact, text: '你在忙什么' });
  assert.equal(got.served, 'model', JSON.stringify(got));
  assert.deepEqual(host.snapshot('survival').survival.model.chatter,
    { asked: 1, ok: 1, timeout: 0, http: 0, empty: 0, invalid: 0 },
    '一句话应当各加一格 asked/ok');
});
