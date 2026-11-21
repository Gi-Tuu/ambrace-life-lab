// 工单 B 闸门（CHATTER-03）：模型已经用决策腔回过话时，把白名单字段里的台词捡回来。
//
// 背景：27B 偶尔回 {"id":"rest","reason":"…","text":"…"}。旧 sanitize 把整段当决策体丢弃，
// 玩家看到固定话，而 asked/ok 都已记账——等于白花的钱换不回一句台词。
// 边界：只取 text/line/speech；id/act/reason 绝不当动作或世界写操作；无字段/数组仍退模板。
// 变红法见断言后注释。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'ambrace-chatter-json-'));
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
const { sanitizeModelLine } = await import('./resident-dialogue.mjs');

const read = () => ({ ...host.snapshot('survival').survival.model.chatter });

function stub(content) {
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { content } }], usage: { total_tokens: 3 },
  }), { headers: { 'content-type': 'application/json' } });
}

const talk = (w, text) => host.act({
  mode: 'survival', kind: 'camp_talk_say', target: 'a1', text,
  room: null, from: [w.survival.playerPos.x, w.survival.playerPos.z], to: [w.survival.playerPos.x, w.survival.playerPos.z],
});

test('CHATTER-03 JSON 台词取回：白名单字段当台词，无字段/数组仍退模板', async (t) => {
  await host.start();
  t.after(() => host.stop());
  host.setBackend({ providers: ['http://127.0.0.1:9/v1'], keys: ['fixture-key'], models: ['fixture'], brain: 'model' });

  const sp = campSurv(null), w = sp.world;
  w.agents.a1.drives.v.social = .5;
  w.agents.a1.drives.v.energy = .9;
  w.loc.a1 = 'yard'; w.loc.p1 = 'yard';
  const [x, z] = worldSite(w, 'yard');
  w.survival.playerPos = { x: x + .5, z: z + .5, t: w.t };
  w.survival.playerReachState = { t: w.t, allowance: 100, sub: 0 };
  host.touch('survival');
  assert.ok((await host.act({ mode: 'survival', kind: 'camp_talk', target: 'a1', room: null,
    from: [x + .5, z + .5], to: [x + .5, z + .5] })).ok, '应能开对话');

  // 1) 有 text：取回台词，ok+1、invalid 不增。
  // 变红法：删掉 lineFieldOf 里 text/line/speech 取字段这几行 ⇒ 本条红（served=template、invalid+1）。
  stub('{"id":"rest","reason":"累了","text":"篱笆补完了，手还在酸。"}');
  let before = read();
  let got = await talk(w, '今天怎么样？');
  let delta = Object.fromEntries(Object.keys(read()).map((k) => [k, read()[k] - before[k]]));
  assert.equal(got.ok, true, JSON.stringify(got));
  assert.equal(got.served, 'model', `JSON 里的 text 应被当台词取回｜计数 ${JSON.stringify(delta)}`);
  assert.equal(got.line, '篱笆补完了，手还在酸。', `台词必须等于 text 字段｜实得 ${JSON.stringify(got.line)}`);
  assert.deepEqual(delta, { asked: 1, ok: 1, timeout: 0, http: 0, empty: 0, invalid: 0 },
    `取回台词不得记 invalid｜${JSON.stringify(delta)}`);

  // 2) 没有白名单字段：仍当决策体拒掉，invalid+1。
  // 变红法：把"无字段仍拒"改成放行（返回 id/reason 或空串外的内容）⇒ 本条红。
  stub('{"id":"rest","reason":"累了"}');
  before = read();
  got = await talk(w, '那你在忙什么？');
  delta = Object.fromEntries(Object.keys(read()).map((k) => [k, read()[k] - before[k]]));
  assert.equal(got.served, 'template', `无 text/line/speech 仍须退模板｜计数 ${JSON.stringify(delta)}`);
  assert.deepEqual(delta, { asked: 1, ok: 1, timeout: 0, http: 0, empty: 0, invalid: 1 },
    `无字段应只记 invalid｜${JSON.stringify(delta)}`);

  // 3) 数组形状：取不到白名单字段，仍退模板。
  stub('["篱笆补完了"]');
  before = read();
  got = await talk(w, '再说一句？');
  delta = Object.fromEntries(Object.keys(read()).map((k) => [k, read()[k] - before[k]]));
  assert.equal(got.served, 'template', `数组不得当台词｜计数 ${JSON.stringify(delta)}`);
  assert.deepEqual(delta, { asked: 1, ok: 1, timeout: 0, http: 0, empty: 0, invalid: 1 },
    `数组应只记 invalid｜${JSON.stringify(delta)}`);

  // 白名单是封闭的：id/act/reason 永远不当台词；line/speech 与 text 同权。
  assert.equal(sanitizeModelLine('{"id":"rest","reason":"累了"}'), '');
  assert.equal(sanitizeModelLine('{"id":"rest","act":"build"}'), '');
  assert.equal(sanitizeModelLine('{"line":"嗯。"}'), '嗯。');
  assert.equal(sanitizeModelLine('{"speech":"知道了。"}'), '知道了。');
  // 带 act 的是决策体：动作语义归服务端裁决，不从决策体里捡台词。
  // v15 的 say.test S2-5 负控钉着"非法 act 的 text 不得进 converse"。
  assert.equal(sanitizeModelLine('{"act":"mind_control","text":"听我的"}'), '',
    '带 act 的决策体不得捡台词');

  await host.act({ mode: 'survival', kind: 'camp_talk_close', target: 'a1' });
});
