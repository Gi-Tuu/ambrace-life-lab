// 派单 P1 第二批生命周期实验（T07/T08 + P1-2/P1-3）。households 模式；确定 seed 可复现。
// 覆盖：阶段推进与劳动能力差异、老年体能下降＋自然衰老死亡、代际继承、人口上限、出生→死亡加速模拟、跨档。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSurvPlay, tickSurvPlay, survView, dumpSurv, loadSurv } from './survplay.mjs';
import { residentStage, ageDays, laborStage, ADULT_DAYS, INFANT_DAYS, ELDER_DAYS, RESIDENT_CAP, stepRelationships } from './households.mjs';
import { affordancesFor, move, isAlive } from './body.mjs';
import { doGather, doBuild } from './production.mjs';
import { Organism } from './agent.mjs';
import { DAY_TICKS, dayOf } from './clock.mjs';

const OPT = { residentialDecisions: true };

// ── T07 阶段推进与劳动能力差异 ──
test('T07 新生儿→婴幼儿→儿童→成年→老年；儿童无劳动能力、成年/老年可劳动', () => {
  const sp = createSurvPlay(7, OPT); const w = sp.world;
  const rec = w.survival.households.residents.a1;
  rec.born = w.t; // 重置为 newborn
  assert.equal(residentStage(w, 'a1'), 'infant');
  assert.equal(laborStage(w, 'a1'), false);
  w.t += INFANT_DAYS * DAY_TICKS;
  assert.equal(residentStage(w, 'a1'), 'child');
  const childAffs = affordancesFor(w, 'a1');
  assert.ok(!childAffs.some((a) => ['harvest', 'gather', 'build', 'plan', 'forage'].includes(a.kind)), '儿童不应有劳动候选');
  assert.ok(childAffs.some((a) => a.kind === 'move_to' || a.kind === 'rest'), '儿童仍可移动/休息（成长与学习）');
  w.t += (ADULT_DAYS - INFANT_DAYS) * DAY_TICKS;
  assert.equal(residentStage(w, 'a1'), 'adult');
  assert.equal(laborStage(w, 'a1'), true);
  w.t += (ELDER_DAYS - ADULT_DAYS) * DAY_TICKS;
  assert.equal(residentStage(w, 'a1'), 'elder');
  assert.equal(laborStage(w, 'a1'), true, '老年仍可劳动（减产）');
});

// ── T08 老年体能下降＋自然衰老死亡（确定可复现）──
test('T08 老年自然衰老死亡：高龄居民按日概率死亡，cause=衰老，同 seed 逐位复现', async () => {
  const run = async () => {
    const sp = createSurvPlay(7, OPT); const w = sp.world;
    w.survival.endFreeze = false; w.survival.playerEats = false; w.survival.store = 1000; // 排除饥饿致死
    w.survival.households.residents.a1.born = w.t - 120 * DAY_TICKS; // 120 天高龄（p=0.5/日）
    w.agents.a1.viab.v = 1;
    let deathDay = null;
    for (let i = 0; i < 24 * 30; i++) { await tickSurvPlay(sp); if (w.agents.a1.dead) { deathDay = dayOf(w.t); break; } }
    return { deathDay, cause: w.agents.a1.death?.cause ?? null };
  };
  const r1 = await run(); const r2 = await run();
  assert.ok(r1.deathDay !== null, '高龄居民应自然死亡');
  assert.equal(r1.cause, '衰老');
  assert.deepEqual(r1, r2, '同 seed 衰老死亡日逐位复现');
});

test('T08b 老年减产：采集 1（成年 2）、施工 +1（成年 +2）', () => {
  const sp = createSurvPlay(7, OPT); const w = sp.world;
  w.survival.households.residents.a1.born = w.t - 70 * DAY_TICKS; // 老年
  w.survival.resStock.yard = 10;
  move(w, 'a1', 'yard');
  assert.equal(doGather(w, 'a1').amount, 1, '老年采集减产');
  move(w, 'a2', 'yard');
  assert.equal(doGather(w, 'a2').amount, 2, '成年采集正常');
  // 施工减产
  w.pinv.a1 = { wood: 10, stone: 10 };
  move(w, 'a1', 'watch');
  assert.equal(doBuild(w, 'a1').ok, false); // 无工地先奠基
  // 直接验证进度增量：造一个工地
  w.survival.sites.push({ type: 'shelter', loc: 'watch', progress: 0 });
  doBuild(w, 'a1');
  assert.equal(w.survival.sites[0].progress, 1, '老年施工 +1');
});

// ── P1-2 代际继承：性格随父/母、独立记忆、亲子纽带 ──
test('P1-2 后代继承性格倾向但为独立个体（空记忆＋亲子纽带）', async () => {
  const sp = createSurvPlay(7, OPT); const w = sp.world; const h = w.survival.households;
  const a = w.agents.a1, b = w.agents.a2;
  Object.assign(a.relations.get('a2'), { trust: 65, familiarity: .8 });
  Object.assign(b.relations.get('a1'), { trust: 65, familiarity: .8 });
  stepRelationships(w, sp.log); // 结婚
  w.t += DAY_TICKS; stepRelationships(w, sp.log); // 同住
  w.survival.store = 26; w.survival.buildings.push({ type: 'shelter', loc: 'yard', integrity: 1 });
  w.t = DAY_TICKS * 2 - 1; await tickSurvPlay(sp); // 日界繁衍
  const c = w.agents.c1;
  assert.ok(c, '应出生后代');
  assert.ok([a.traits.archetype, b.traits.archetype].includes(c.traits.archetype), '性格倾向随父/母');
  assert.ok(c.memory.dump().rows.length <= 1, '后代记忆从空开始，仅自身初经历（非父母复制）');
  assert.notDeepEqual(c.memory.dump().rows, a.memory.dump().rows, '后代记忆独立于父母');
  assert.ok(c.relations.get('a1').trust >= 40, '亲子纽带（子女→父母，高于中性 30）');
  assert.ok(a.relations.get('c1').trust >= 40, '亲子纽带（父母→子女，高于中性 30；出生当拍可随经历演化）');
  assert.deepEqual(h.residents.c1.parents, ['a1', 'a2']);
});

// ── P1-3 人口上限：达上限不再生 ──
test('P1-3 人口上限：存活居民达 RESIDENT_CAP 时停止繁衍', async () => {
  const sp = createSurvPlay(7, OPT); const w = sp.world;
  const a = w.agents.a1, b = w.agents.a2;
  Object.assign(a.relations.get('a2'), { trust: 65, familiarity: .8 });
  Object.assign(b.relations.get('a1'), { trust: 65, familiarity: .8 });
  stepRelationships(w, sp.log); w.t += DAY_TICKS; stepRelationships(w, sp.log);
  w.survival.store = 1000; w.survival.buildings.push({ type: 'shelter', loc: 'yard', integrity: 1 });
  // 补足存活居民到上限（a1/a2/a3 + 7 真实 Organism 占位）
  for (let i = 0; i < RESIDENT_CAP - 3; i++) { const id = `x${i}`; w.agents[id] = new Organism({ id, name: `占${i}`, archetype: '谨慎', seed: 100 + i, condition: 'C2' }); w.sex[id] = 'M'; }
  assert.equal(Object.values(w.agents).filter((x) => !x.isPlayer && isAlive(x)).length, RESIDENT_CAP);
  const birthsBefore = w.survival.births ?? 0;
  w.t = DAY_TICKS * 2 - 1; await tickSurvPlay(sp);
  assert.equal(w.survival.births ?? 0, birthsBefore, '达人口上限不应再生');
});

// ── 加速模拟：出生→成长→成年→老年→死亡 全生命周期 + 跨档 ──
test('T07b 加速全生命周期：一个体经历 infant→child→adult→elder→死亡，存档恢复阶段一致', async () => {
  const sp = createSurvPlay(7, OPT); const w = sp.world;
  w.survival.endFreeze = false; w.survival.playerEats = false; w.survival.store = 1000;
  const rec = w.survival.households.residents.a1;
  rec.born = w.t; // newborn
  const seen = new Set();
  let died = false;
  for (let i = 0; i < 24 * 130; i++) {
    if (w.agents.p1?.viab) w.agents.p1.viab.v = 1; // 隔离：保持玩家存活，专注观察 a1 全生命周期（玩家死＝终局会冻结衰老）
    await tickSurvPlay(sp);
    seen.add(residentStage(w, 'a1'));
    if (w.agents.a1.dead) { died = true; break; }
    if (i === 24 * 20) { // 成长中途存档恢复
      const back = loadSurv(JSON.parse(JSON.stringify(dumpSurv(sp))), 7, OPT);
      assert.equal(residentStage(back.world, 'a1'), residentStage(w, 'a1'), '跨档阶段一致');
    }
  }
  assert.ok(seen.has('infant') && seen.has('child') && seen.has('adult') && seen.has('elder'), `应经历全阶段：${[...seen].join(',')}`);
  assert.ok(died, '最终应死亡');
  assert.equal(w.agents.a1.death.cause, '衰老');
});