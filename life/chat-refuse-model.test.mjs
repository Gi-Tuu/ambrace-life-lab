// 工单 G 闸门（CHATTER-05）：engage=refuse 的居民也让模型说一句，关系结算逐位不变。
//
// 背景：旧实现 canAsk = session.engage !== 'refuse'，拒答居民根本不发请求，玩家拿到
// freeFallbackLine() 的固定话；这与"每次对话都拿到真实回复"直接冲突。
// 边界：模型只负责措辞——态度/关系后果仍由服务端算，applyFreeRelationship 的 refuse
// 早退（0/0）一行不改。变红法见断言后注释。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'ambrace-chatter-refuse-'));
process.env.DATA_DIR = DIR;
process.env.SEED_FILE = join(DIR, 'none.json');
process.env.GAME_MODE = 'game';
process.env.GAME_RULES = '1';
process.env.SIM_TIME = '1';
process.env.TICK_MS = '1000000';
process.env.GAME_MS_PER_MINUTE = '600000';
process.env.MAX_CALLS = '200';
process.env.NODE_CALLS_DAY = '200';
process.env.MODEL_TIMEOUT_MS = '150';
process.env.MODEL_BREAKER_FAILS = '99';
process.env.MODEL_BREAKER_MS = '600000';
process.env.MODEL_UNATTENDED = '0';
process.env.PRESENCE_MS = '600000';

const { host, campSurv } = await import('./host.mjs');
const { worldSite } = await import('./geometry.mjs');

const read = () => ({ ...host.snapshot('survival').survival.model.chatter });

test('CHATTER-05 engage=refuse 也 model+asked/ok；trust/familiarity 增量逐位 0/0', async (t) => {
  await host.start();
  t.after(() => host.stop());
  const bodies = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init?.body ?? '{}'));
    return new Response(JSON.stringify({
      choices: [{ message: { content: '……知道了。' } }], usage: { total_tokens: 2 },
    }), { headers: { 'content-type': 'application/json' } });
  };
  host.setBackend({ providers: ['http://127.0.0.1:9/v1'], keys: ['fixture-key'], models: ['fixture'], brain: 'model' });

  const sp = campSurv(null), w = sp.world, npc = w.agents.a1;
  // social > 0.78 ⇒ engagementOf 判定 refuse（走真实判定，不手改 session）。
  npc.drives.v.social = .9;
  npc.drives.v.energy = .9;
  w.loc.a1 = 'yard'; w.loc.p1 = 'yard';
  const [x, z] = worldSite(w, 'yard');
  w.survival.playerPos = { x: x + .5, z: z + .5, t: w.t };
  w.survival.playerReachState = { t: w.t, allowance: 100, sub: 0 };
  const contact = { target: 'a1', room: null, from: [x + .5, z + .5], to: [x + .5, z + .5] };
  host.touch('survival');

  assert.ok((await host.act({ mode: 'survival', kind: 'camp_talk', ...contact })).ok, '应能开对话');
  assert.equal(w.survival.residentDialogue.engage, 'refuse', `夹具必须落在 refuse：${w.survival.residentDialogue.engage}`);
  const relBefore = npc.relations?.map?.get?.('p1') ?? { familiarity: 0, trust: 30 };
  assert.deepEqual({ trust: relBefore.trust, familiarity: relBefore.familiarity },
    { trust: 30, familiarity: 0 }, '开对话本身不写关系：refuse 会话起点必须是 trust 30 / familiarity 0');

  const before = read();
  const got = await host.act({ mode: 'survival', kind: 'camp_talk_say', ...contact, text: '在忙吗？' });
  const after = read();
  const delta = Object.fromEntries(Object.keys(after).map((k) => [k, after[k] - before[k]]));

  // 变红法：canAsk 改回 session.engage !== 'refuse' ⇒ 不发请求、served=template，本条红。
  assert.equal(got.ok, true, JSON.stringify(got));
  assert.equal(got.served, 'model', `refuse 也应拿到模型台词｜计数 ${JSON.stringify(delta)}｜line=${got.line}`);
  assert.equal(got.line, '……知道了。', `台词应为模型原文｜实得 ${JSON.stringify(got.line)}`);
  assert.equal(bodies.length, 1, `refuse 也必须发一次模型请求，实测 ${bodies.length}`);
  assert.deepEqual(delta, { asked: 1, ok: 1, timeout: 0, http: 0, empty: 0, invalid: 0 },
    `refuse 也要记 asked/ok｜${JSON.stringify(delta)}`);

  // 态度已定：提示词必须把"不想搭理、只冷冷丢一句"写成既定事实。
  const prompt = String(bodies[0].messages?.[0]?.content ?? '');
  assert.ok(prompt.includes('不想搭理'), `refuse 提示词缺冷淡态度：${prompt.slice(0, 120)}`);
  assert.ok(prompt.includes('冷冷'), `refuse 提示词缺"冷冷丢一句"：${prompt.slice(0, 120)}`);

  // 关系结算与改前逐位相同：refuse 的 applyFreeRelationship 早退 ⇒ 0/0，关系落点不动。
  // 变红法：让模型台词参与关系计算 ⇒ 本段 0/0 或 trust 30 / familiarity 0 的断言红。
  assert.deepEqual(got.relation, { trust: 0, familiarity: 0 }, `refuse 关系增量必须是 0/0，实测 ${JSON.stringify(got.relation)}`);
  const relAfter = npc.relations?.map?.get?.('p1') ?? { familiarity: 0, trust: 30 };
  assert.deepEqual({ trust: relAfter.trust, familiarity: relAfter.familiarity },
    { trust: 30, familiarity: 0 }, `refuse 关系落点必须与改前逐位相同，实测 ${JSON.stringify(relAfter)}`);

  await host.act({ mode: 'survival', kind: 'camp_talk_close', target: 'a1' });
});
