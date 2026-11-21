// 对话车道计数闸门：超时 / 空回复 / HTTP 失败 / 回了却被判无效，必须能在 /world 里分开看见。
//
// 为什么要这条：玩家侧的症状是"回的都是固定话"，而退模板有四条完全不同的原因
// （中继没落地、模型回空、节点 5xx、模型吐回 JSON 被 sanitize 丢掉）。
// 没有分开计数就只能靠猜——线上那次 36% 不落地就是这么被含糊过去的。
// 变红法见每条断言后的注释。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'ambrace-chatter-count-'));
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
process.env.MODEL_BREAKER_FAILS = '99';   // 本闸门要逐条数失败原因，不能被熔断改道
process.env.MODEL_BREAKER_MS = '600000';
process.env.MODEL_UNATTENDED = '0';
process.env.PRESENCE_MS = '600000';

const { host, campSurv } = await import('./host.mjs');
const { worldSite } = await import('./geometry.mjs');

const read = () => {
  const snap = host.snapshot('survival');
  return { viaSurvival: { ...snap.survival.model.chatter }, viaModel: { ...snap.model.chatter } };
};

// 夹具：按 mode 决定这次模型调用怎么回。slow 走真 abort，才能验到 timeout 那一格。
function stub(mode) {
  globalThis.fetch = async (_url, init) => {
    if (mode === 'timeout') {
      return await new Promise((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('不该发生：超时夹具没先被 abort')), 900);
        timer.unref?.();
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          const error = new Error('This operation was aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    }
    if (mode === 'http') return new Response('', { status: 503 });
    if (mode === 'empty') return new Response(JSON.stringify({ choices: [{ message: { content: '   ' } }], usage: { total_tokens: 1 } }), { headers: { 'content-type': 'application/json' } });
    if (mode === 'json') return new Response(JSON.stringify({ choices: [{ message: { content: '{"id":"rest","reason":"夹具"}' } }], usage: { total_tokens: 1 } }), { headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ choices: [{ message: { content: `今天把篱笆补完了，手还在酸。${mode}` } }], usage: { total_tokens: 2 } }), { headers: { 'content-type': 'application/json' } });
  };
}

const talk = (w, text) => host.act({
  mode: 'survival', kind: 'camp_talk_say', target: 'a1', text,
  room: null, from: [w.survival.playerPos.x, w.survival.playerPos.z], to: [w.survival.playerPos.x, w.survival.playerPos.z],
});

test('CHATTER-01 四种退模板原因分开计数，且 /world 的 survival.model.chatter 就是同一本账', async (t) => {
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

  const cases = [
    { mode: 'line', expect: { asked: 1, ok: 1, timeout: 0, http: 0, empty: 0, invalid: 0 }, served: 'model' },
    { mode: 'timeout', expect: { asked: 1, ok: 0, timeout: 1, http: 0, empty: 0, invalid: 0 }, served: 'template' },
    { mode: 'http', expect: { asked: 1, ok: 0, timeout: 0, http: 1, empty: 0, invalid: 0 }, served: 'template' },
    { mode: 'empty', expect: { asked: 1, ok: 0, timeout: 0, http: 0, empty: 1, invalid: 0 }, served: 'template' },
    // 模型确实回了话（ok+1），但内容被 sanitize 判无效 ⇒ 只有 invalid 这一格能说明"不是没问到，是问到了被丢掉"
    { mode: 'json', expect: { asked: 1, ok: 1, timeout: 0, http: 0, empty: 0, invalid: 1 }, served: 'template' },
  ];

  for (const c of cases) {
    assert.ok((await host.act({ mode: 'survival', kind: 'camp_talk', target: 'a1', room: null,
      from: [x + .5, z + .5], to: [x + .5, z + .5] })).ok, `${c.mode} 应能开对话`);
    stub(c.mode);
    const before = read().viaSurvival;
    const got = await talk(w, `第几句不重要-${c.mode}`);
    const after = read().viaSurvival;
    const delta = Object.fromEntries(Object.keys(after).map((k) => [k, after[k] - before[k]]));
    assert.equal(got.ok, true, `${c.mode} 动作应成功：${JSON.stringify(got)}`);
    assert.equal(got.served, c.served, `${c.mode} 应退到 ${c.served}，实测 ${got.served}｜计数 ${JSON.stringify(delta)}`);
    // 变红法：把 host-model.mjs 里对应那行 chatterNote(...) 删掉，这一格就少 1
    assert.deepEqual(delta, c.expect, `${c.mode} 计数不符`);
    // 变红法：把 host.mjs snapshot 里 survival.model 的 chatter 去掉，这条先红（读数根本没露出来）
    assert.deepEqual(read().viaModel, after, '/world 顶层 model.chatter 与 survival.model.chatter 必须是同一本账');
    await host.act({ mode: 'survival', kind: 'camp_talk_close', target: 'a1' });
  }

  const total = read().viaSurvival;
  assert.equal(total.asked, 5, `五句话应各记一次 asked，实测 ${total.asked}`);
  assert.equal(total.ok + total.timeout + total.http + total.empty, 5,
    `除 invalid 外四格要把 asked 分完（问成/超时/失败/回空），实测 ${JSON.stringify(total)}`);
});
