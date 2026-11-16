#!/usr/bin/env node
// 阶段 B：角色互换实验装置（V7 §5）。
// 同一份种子、同样的身体/资源/位置，把同一意图分别交给玩家路径与居民路径，
// 记录 合法性 / 成功 / 失败原因 / 产出 / 材料 / 时间 / 存续 / 关系 / 事件，并给出差异。
// 只读世界、不联网、不写 data/；输出 JSON + Markdown 表。
import { createSurvPlay, survAct, survView, tickSurvPlay } from '../life/survplay.mjs';

const GAME = { independentWorld: true, gameRules: true, residentialDecisions: true, unifiedCooperation: true, settlementLife: true, autonomousGoals: true, farmLife: true, regionalWork: true, ecosystem: true, wildFood: true };

const seed = Number(process.argv[2] ?? 7);
const out = [];

function summary(sp, agentId = 'p1') {
  const w = sp.world;
  const a = w.agents[agentId];
  return {
    t: w.t,
    loc: w.loc[agentId],
    viab: Number(a?.viab?.v?.toFixed(4)),
    energy: Number(a?.drives?.v?.energy?.toFixed(4)),
    inv: { ...(w.pinv?.[agentId] ?? {}) },
    store: w.survival?.store,
    buildings: Object.keys(w.survival?.buildings ?? {}).length,
    timeLeft: w.survival?.p1BudgetLeft,
  };
}

const diff = (before, after, keys) => {
  const d = {};
  for (const k of keys) d[k] = { before: before[k], after: after[k] };
  return d;
};

// ── 1) 移动 + 重劳动同刻
{
  const sp = createSurvPlay(seed, GAME);
  const w = sp.world;
  w.loc.p1 = 'yard';
  const b = summary(sp);
  const move = survAct(sp, { kind: 'move', room: 'hall' });
  const gather = survAct(sp, { kind: 'gather', resource: 'wood' });
  out.push({
    scenario: '移动+劳动同刻',
    player: { move: move.ok, gather: gather.ok, spentTime: (b.timeLeft ?? 100) - summary(sp).timeLeft, after: summary(sp) },
    resident: { note: '居民每刻只 execute 一次；跨区移动期间不能劳动（survplay.mjs 311-320）', sameTickActions: 1 },
    verdict: move.ok && gather.ok ? 'DIFF：玩家可在同刻移动并完成重劳动' : 'SAME',
  });
}

// ── 2) 失败动作的时间/存续成本
{
  const sp = createSurvPlay(seed, GAME);
  const w = sp.world;
  w.loc.p1 = 'hall';
  const b = summary(sp);
  const r = survAct(sp, { kind: 'build' }); // 无工地 ⇒ NO_SITE
  const a = summary(sp);
  out.push({
    scenario: '失败动作成本（build 无工地）',
    player: { ok: r.ok, code: r.code ?? r.error, viabBefore: b.viab, viabAfter: a.viab, timeBefore: b.timeLeft, timeAfter: a.timeLeft },
    resident: { note: 'agent.execute 在 validate 通过后无条件 viab.spend(actionCost)，与 result.ok 无关（agent.mjs 475-480）' },
    verdict: (b.timeLeft === a.timeLeft) ? 'DIFF：玩家失败全退时间且不扣存续；居民失败照扣' : 'SAME',
  });
}

// ── 3) 进食：玩家 camp_eat 每刻次数 vs 居民日界回补
{
  const sp = createSurvPlay(seed, GAME);
  const w = sp.world;
  w.loc.p1 = 'home';
  w.campPlayerRoom = 'home';
  w.pinv.p1 = { ...(w.pinv.p1 ?? {}), tray: 1 };
  w.survival.campContainers = { 'home:meal': { crop: 6 } };
  w.agents.p1.viab.v = 0.3;
  const b = summary(sp);
  let okCount = 0;
  for (let i = 0; i < 4; i += 1) if (survAct(sp, { kind: 'camp_eat', type: 'crop' }).ok) okCount += 1;
  const a = summary(sp);
  out.push({
    scenario: '进食恢复（同刻多次）',
    player: { meals: okCount, viabBefore: b.viab, viabAfter: a.viab, timeLeftAfter: a.timeLeft, containerLeft: w.survival.campContainers['home:meal'] },
    resident: { note: '生存模式无 eat 入口；日界 regen(0.5)×mealYield 0.18 = 0.09/日（worldstate.mjs 167-174）' },
    verdict: okCount > 1 ? 'DIFF：玩家同刻多次进食、居民每日 1 次' : 'SAME',
  });
}

// ── 4) 伤害动作成本（camp_resident）
{
  const sp = createSurvPlay(seed, { ...GAME });
  const w = sp.world;
  const target = Object.keys(w.agents).find((id) => id !== 'p1' && !w.agents[id].isPlayer);
  w.loc.p1 = w.loc[target];
  w.pinv.p1 = { ...(w.pinv.p1 ?? {}), axe: 1 };
  const b = summary(sp);
  const r = survAct(sp, { kind: 'camp_resident', target, tool: 'axe' });
  const a = summary(sp);
  out.push({
    scenario: '伤害居民的成本',
    player: { ok: r.ok, code: r.code ?? r.error, timeBefore: b.timeLeft, timeAfter: a.timeLeft, viabBefore: b.viab, viabAfter: a.viab, targetViab: w.agents[target]?.viab?.v },
    resident: { note: '居民无对等动作；PLAYER_TIME 无 camp_resident ⇒ 时间成本 0（survplay.mjs 452-464）' },
    verdict: a.timeLeft === b.timeLeft ? 'DIFF：玩家伤害零时间零存续' : 'SAME',
  });
}

// ── 5) 采集产出（应对等）
{
  const run = (asPlayer) => {
    const sp = createSurvPlay(seed, GAME);
    const w = sp.world;
    const id = asPlayer ? 'p1' : Object.keys(w.agents).find((x) => x !== 'p1' && !w.agents[x].isPlayer);
    const site = Object.entries(w.survival.sites ?? {}).find(([, s]) => s.resource === 'wood')?.[0] ?? 'yard';
    w.loc[id] = site;
    const before = { wood: w.pinv[id]?.wood ?? 0, storeWood: w.survival.wood ?? 0 };
    const r = asPlayer ? survAct(sp, { kind: 'gather', resource: 'wood' }) : null;
    return { id, before, after: { wood: w.pinv[id]?.wood ?? 0 }, ok: r?.ok };
  };
  out.push({ scenario: '采集产出（玩家侧；居民侧需推进 tick，见阶段 B 补测）', player: run(true), verdict: '待补' });
}

console.log(JSON.stringify({ seed, scenarios: out }, null, 2));
