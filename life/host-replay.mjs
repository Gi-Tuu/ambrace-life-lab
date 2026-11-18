// 对照/回放域：A/B 两分支的记录、视图、落盘与只读回放查询。
// 世界推进与动作执行仍由 host-world 提供（通过 world 引用调用），这里不复制世界状态。
import { mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { dumpSurv, loadSurv, survView, tickSurvPlay } from './survplay.mjs';
import { campSleepTicks } from './camp-play.mjs';
import { createReplay, recordReplayFrame, replayRange, replayPoint } from './replay-history.mjs';
import { speechLine } from './speech.mjs';
import { PARAMS } from './params.mjs';
import { validCampArchive } from './camp-instances.mjs';

export function createReplayDomain({ S, CFG, C, world }) {
  const { SERIES_CAP } = C;
  const { survivalOptions, actInSurvival } = world;
const COMPARE_SIDES = ['A', 'B'];

function compareMasks() {
  return {
    A: Object.fromEntries(Object.entries(S.comparisonMasks).filter(([key, on]) => on && key !== 'm3').map(([key]) => [key, 1])),
    B: {m3: 0, coupling: 0},
  };
}

function makeComparison(origin, revision = 0, saved) {
  const masks = compareMasks();
  const branches = Object.fromEntries(COMPARE_SIDES.map((key) => {
    const record = saved?.branches?.[key];
    const play = loadSurv(structuredClone(record?.world ?? origin), CFG.seed, {
      ...survivalOptions(),
      residentCondition: key === 'A' ? 'C2' : 'C2-neg',
      residentChannelMask: masks[key],
      deliberator: null,
    });
    return [key, {play, series: record?.series?.slice(-SERIES_CAP) ?? [], log: record?.log?.slice(-80) ?? [],
      stat: record?.stat ?? {决策: 0, 高冲动: 0, 越轨: 0, 驳回: 0, 发现: 0}, last: record?.last ?? {}}];
  }));
  const pair = {origin, branches, revision};
  pair.replay = saved?.replay?.revision === revision ? saved.replay : createReplay(revision);
  for (const branch of Object.values(branches)) {
    survView(branch.play);
    if (!branch.series.length) recordComparisonSeries(branch);
  }
  return pair;
}

function comparisonFromSave(saved) {
  if (!saved) return makeComparison(structuredClone(dumpSurv(S.surv)));
  try {
    const {origin, branches, revision} = saved;
    if (!validCampArchive(origin) || !validCampArchive(branches?.A?.world) || !validCampArchive(branches?.B?.world) ||
        branches.A.world.t !== branches.B.world.t ||
        [branches.A.world, branches.B.world].some(w => w.seed !== origin.seed || w.mapSeed !== origin.mapSeed) ||
        !Number.isSafeInteger(revision) || revision < 0) throw new Error('对照存档结构无效');
    const formerMasks = S.comparisonMasks;
    S.comparisonMasks = {m3: false, coupling: saved.masks?.coupling === true};
    try { return makeComparison(origin, revision, saved); }
    catch (error) { S.comparisonMasks = formerMasks; throw error; }
  } catch {
    // 生存档可独立恢复；对照记录异常时从生存快照开一轮。
    S.compareSaveError = '对照档状态无效，已从生存快照另起一轮';
    return makeComparison(structuredClone(dumpSurv(S.surv)));
  }
}

function recordComparisonSeries(branch) {
  const w = branch.play.world;
  const residents = Object.values(w.agents).filter(a => !a.isPlayer);
  branch.series.push({t: w.t,
    v: Object.fromEntries(residents.map(a => [a.id, Number(a.viab.v.toFixed(3))])),
    lost: Object.fromEntries(residents.map(a => [a.id, a.viab.ledger.length])),
  });
  if (branch.series.length > SERIES_CAP) branch.series.shift();
}

function recordComparisonAction(branch, a, trace) {
  const w = branch.play.world;
  for (const row of trace) {
    if (row.layer === 'rejected') branch.stat.驳回 += 1;
    if (row.layer === 'discovery') branch.stat.发现 += 1;
    if (!row.action || typeof row.ok !== 'boolean' || row.layer === 'refused') continue;
    branch.stat.决策 += 1;
    if (row.kind === 'look_out' || row.kind === 'take_shared') branch.stat.高冲动 += 1;
    if (row.kind === 'take_shared' && row.ok) branch.stat.越轨 += 1;
    branch.last[a.id] = {action: row.action};
    const line = row.kind === 'talk' && row.ok ? speechLine(a, {world: w, kind: row.kind, actionId: row.action, t: row.t}) : null;
    branch.log.push({t: row.t, who: a.name, kind: line ? 'act' : row.ok ? 'decision' : 'rej', text: line ?? row.obs ?? row.action});
  }
  if (branch.log.length > 80) branch.log.splice(0, branch.log.length - 80);
}

function replayCard(branch) {
  const w = branch.play.world;
  return {
    side: w.residentCondition === 'C2' ? 'A' : 'B', t: w.t,
    store: w.survival?.store ?? null,
    buildings: (w.survival?.buildings ?? []).map((b) => ({ type: b.type, loc: b.loc, integrity: b.integrity })),
    pinv: { wood: w.pinv?.p1?.wood ?? 0, stone: w.pinv?.p1?.stone ?? 0 },
    agents: Object.values(w.agents).filter((a) => !a.isPlayer).map((a) => ({
      id: a.id, name: a.name, loc: w.loc[a.id], dead: !!a.dead,
      energy: Number((a.drives?.v?.energy ?? 0).toFixed(2)), viab: Number((a.viab?.v ?? 0).toFixed(2)),
    })),
  };
}

async function tickComparison(now = Date.now()) {
  for (const key of COMPARE_SIDES) {
    const branch = S.comparison.branches[key];
    await tickSurvPlay(branch.play, {now, onResidentAction: (agent, rows) => recordComparisonAction(branch, agent, rows)});
    recordComparisonSeries(branch);
  }
  const A = S.comparison.branches.A, B = S.comparison.branches.B;
  const t = A.play.world.t;
  const events = [['A', A], ['B', B]].flatMap(([side, br]) =>
    (br.play.world.survival?.eventJournal?.rows ?? []).filter((e) => e.t === t).map((e) => ({ ...e, side })));
  recordReplayFrame(S.comparison.replay, { t, A: replayCard(A), B: replayCard(B), events });
}

function makeComparisonView() {
  if (!S.comparison) return null;
  const view = (branch) => {
    const s = survView(branch.play), w = branch.play.world;
    const residents = Object.values(w.agents).filter(a => !a.isPlayer);
    const sum = k => residents.reduce((total,a) => total+(a.counters[k]??0),0);
    return {...s, compareSide: w.residentCondition === 'C2' ? 'A' : 'B',
      stat: branch.stat, series: branch.series, viabCrit: PARAMS.viab.crit,
      researchLog: branch.log, model: {enabled: false, configured: false},
      cost: {事件: sum('triggered'), 被问: sum('asked'), 跳过: sum('skipped'), 驳回重问: sum('askedRetry')},
      agents: {...s.agents, ...Object.fromEntries(residents.map(a => [a.id, {...s.agents[a.id],
        archetype: a.traits.archetype, m: a.bank.snapshot(), baseline: a.traits.baseline, summary: a.bank.summary(),
        researchViab: {v: a.viab.v, lost: a.viab.ledger.map(l => l.organ)}, last: branch.last[a.id],
        layers: {m3: a.ch.m3, coupling: a.ch.coupling}, m3: a.ch.m3 ? a.m3Last : null,
        coupling: a.ch.coupling ? a.coupling.dump() : null,
      }]))},
    };
  };
  const {branches, origin, revision} = S.comparison;
  return {A: view(branches.A), B: view(branches.B), startTick: origin.t, mapSeed: origin.mapSeed, revision, masks: S.comparisonMasks};
}

function publishComparison() {
  S.compareView = structuredClone(makeComparisonView());
}

async function saveComparison() {
  const {origin, revision, branches} = S.comparison;
  const record = {origin, revision, masks: S.comparisonMasks, replay: S.comparison.replay,
    branches: Object.fromEntries(COMPARE_SIDES.map(key => {
      const {play, ...observations} = branches[key];
      return [key, {...observations, world: dumpSurv(play)}];
    })),
  };
  const dest = join(S.dir, 'comparison.json'), tmp = dest + '.tmp';
  try {
    await mkdir(S.dir, {recursive:true});
    await writeFile(tmp, JSON.stringify(record), 'utf8');
    await rename(tmp, dest);
    S.compareSaveError = null;
    return true;
  } catch (error) {
    S.compareSaveError = String(error.message ?? error).slice(0, 80);
    return false;
  } finally {
    await rm(tmp, {force:true}).catch(()=>{});
  }
}

async function actInComparison(body) {
  const pair = S.comparison;
  if (!pair || body.revision !== pair.revision) return {ok: false, code: 'COMPARE_STALE'};
  const now = Date.now();
  const results = {};
  if (body.kind === 'camp_sleep') {
    for (const key of COMPARE_SIDES) results[key] = campSleepTicks(pair.branches[key].play.world);
    const ticks = Math.max(...Object.values(results).map(r => r.ticks ?? 0));
    // Both clocks advance when either player can sleep. The other side lives through the same interval.
    if (ticks) for (let i = 0; i < ticks; i++) await tickComparison(now);
  } else {
    for (const key of COMPARE_SIDES) {
      const command = key==='B' && body.otherContact ? {
        ...body, from: body.otherContact.from,
        ...(Object.hasOwn(body,'to') && {to: body.otherContact.to}),
      } : body;
      results[key] = await actInSurvival(pair.branches[key].play, command, null, now);
    }
  }
  if (body.kind !== 'player_sync') for (const key of COMPARE_SIDES) {
    const branch = pair.branches[key], r = results[key];
    branch.log.push({t: branch.play.world.t, who: '玩家', kind: r.ok ? 'player' : 'rej',
      text: [body.kind, r.line ?? r.code ?? r.error].filter(Boolean).join(' · ')});
    if (branch.log.length > 80) branch.log.shift();
  }
  publishComparison();
  if (body.kind === 'player_sync' && !Object.values(results).some(r => r.ok)) return {...results.A,sides:results};
  return {...results.A, sides: results, persisted: await saveComparison()};
}

  function replayQuery(query = {}) {
    if (!S.comparison?.replay) return { ok: false, code: 'NO_COMPARISON' };
    if (Number.isFinite(query?.t)) return replayPoint(S.comparison.replay, query.t, query.revision);
    return replayRange(S.comparison.replay, { from: query?.from, to: query?.to, revision: query?.revision });
  }

  return { replayQuery, makeComparison, comparisonFromSave, publishComparison, saveComparison, tickComparison, actInComparison, makeComparisonView };
}
