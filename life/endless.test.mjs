// §15 P2-B 无尽/繁衍/四季闸门（预登记 phase1-plan §15；跑前写死）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSurvPlay, tickSurvPlay } from './survplay.mjs';
import { advanceSurvival } from './worldstate.mjs';

test('E-1 终局语义：只剩 1 人⇒sole；只剩同性对⇒noPair；有异性对⇒不终局', () => {
  const mk = (mode) => {
    const sp = createSurvPlay(7);
    const w = sp.world;
    for (const id of ['a1', 'a2', 'a3']) w.agents[id].viab.v = 0;
    if (mode !== 'sole') {
      w.agents.a1.viab.v = 1;
      w.sex.a1 = mode === 'same' ? w.sex.p1 : (w.sex.p1 === 'M' ? 'F' : 'M');
    }
    w.t += 24; advanceSurvival(w);
    return w.survival;
  };
  assert.equal(mk('sole').ended, true);
  assert.equal(mk('sole').endReason, 'sole');
  assert.equal(mk('same').ended, true);
  assert.equal(mk('same').endReason, 'noPair');
  assert.equal(mk('pair').ended, false);
});

test('E-2 繁衍：异性对＋住所完好＋粮足＋信任≥60＋冷却 ⇒ 新生 Organism（记忆从空）', async () => {
  const sp = createSurvPlay(7);
  const w = sp.world;
  w.sex.a1 = w.sex.p1 === 'M' ? 'F' : 'M';
  w.survival.store = 20;
  w.survival.buildings.push({ type: 'shelter', loc: 'home', at: [0, 0], integrity: 1 });
  w.agents.a1.relations.get('p1').trust = 70;
  w.agents.p1.relations = w.agents.a1.relations; // 玩家无关系模型时共用以便配对判定
  w.t = 23;
  await tickSurvPlay(sp); // t24 ⇒ 日界 ⇒ reproduce
  assert.equal(w.survival.births, 1, '应诞新生');
  const child = w.agents.c1;
  assert.ok(child && child.memory && child.drives, '新生应为完整 Organism');
  assert.ok(['M', 'F'].includes(w.sex.c1));
});

test('E-3 四季调制生长：冬生长增量 < 夏（同水/土/天气）', () => {
  const grow = (day) => {
    const sp = createSurvPlay(7);
    const w = sp.world;
    w.survival.water = 0.8; w.survival.soil = 0.8;
    w.survival.plots.forEach((p) => { p.growth = 0.2; });
    w.t = day * 24 + 5;
    w.weather = 'clear';
    advanceSurvival(w);
    return w.survival.plots[0].growth - 0.2;
  };
  const summer = grow(40); const winter = grow(100);
  assert.ok(winter < summer, `冬 ${winter} 应 < 夏 ${summer}`);
});

test('E-4 无尽：won 里程碑不终局（ended 仍 false，消耗继续）', () => {
  const sp = createSurvPlay(7);
  const w = sp.world;
  w.t = 24 * 10 + 5;
  w.survival.store = 10;
  advanceSurvival(w);
  assert.equal(w.survival.won, true);
  assert.equal(w.survival.ended, false);
  assert.ok(w.survival.store < 10, '无尽应继续消耗');
});