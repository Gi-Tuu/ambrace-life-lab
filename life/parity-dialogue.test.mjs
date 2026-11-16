// SOC-04 闸门：逐句复读不能把信任刷满（每场 +4、每日 +6）；指责不受正向上限影响。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSurvPlay } from './survplay.mjs';
import { sayTo } from './dialogue.mjs';

const GAME = { independentWorld: true, gameRules: true, residentialDecisions: true, unifiedCooperation: true, settlementLife: true, autonomousGoals: true, farmLife: true, regionalWork: true, ecosystem: true, wildFood: true };

function openFakeTalk(w, target = 'a1') {
  w.survival.talk = { target, openTick: w.t, openAt: Date.now(), patienceMs: 1e9, count: 0, engage: 'open', history: [] };
  w.loc.p1 = 'home';
  w.loc[target] = 'home';
}

test('SOC-04 对话信任上限：同场复读只加 4，换场当日最多 6', async () => {
  const sp = createSurvPlay(7, GAME);
  const w = sp.world;
  const npc = w.agents.a1;
  openFakeTalk(w);
  const t0 = npc.relations.get('p1').trust;
  for (let i = 0; i < 8; i += 1) await sayTo(sp, { target: 'a1', text: '对不起' });
  const gain1 = npc.relations.get('p1').trust - t0;
  assert.ok(gain1 <= 4 + 0.001, '同一场对话最多 +4，实测 ' + gain1.toFixed(2));
  assert.ok(gain1 > 0, '应确实加点（不是全封）');
  // 新开一场：当日剩余额度 2
  openFakeTalk(w);
  const t1 = npc.relations.get('p1').trust;
  for (let i = 0; i < 4; i += 1) await sayTo(sp, { target: 'a1', text: '对不起' });
  const gain2 = npc.relations.get('p1').trust - t1;
  assert.ok(gain2 <= 2 + 0.001, '当日累计最多 +6，实测 ' + (gain1 + gain2).toFixed(2));
  // 负向不受上限：指责仍然扣
  openFakeTalk(w);
  const t2 = npc.relations.get('p1').trust;
  await sayTo(sp, { target: 'a1', text: '你是小偷' });
  assert.ok(npc.relations.get('p1').trust < t2, '指责必须扣信任');
});
