// V7.3.4 E：只读 actionId 索引与账本对账（不改存档格式）。
// 输入 observer 事件（含 actionId）与账本聚合；输出每实例异常与按 actor/kind 的聚合差异。

const FINAL = new Set(['completed', 'failed', 'aborted', 'cancelled']);

export function actionStartTick(event) {
  if (Number.isFinite(event?.startTick)) return event.startTick;
  const parts = String(event?.actionId ?? '').split(':');
  const n = Number(parts[2]);
  return Number.isFinite(n) ? n : null;
}

export function indexActions(events = []) {
  const map = new Map();
  const anomalies = [];
  for (const e of events) {
    if (!e?.actionId) {
      anomalies.push({ type: 'MISSING_ACTION_ID', actorId: e?.actorId ?? null, actionId: null, tick: e?.worldTick ?? null });
      continue;
    }
    let a = map.get(e.actionId);
    if (!a) {
      a = { actionId: e.actionId, actorId: e.actorId, kind: e.kind, startTick: actionStartTick(e),
        statuses: [], minutes: 0, energy: 0, ticks: [] };
      map.set(e.actionId, a);
    }
    a.statuses.push(e.status);
    a.minutes += Number(e.actualMinutes ?? e.progressMinutes ?? 0);
    a.energy += Number(e.actualEnergy ?? 0);
    a.ticks.push(e.worldTick);
    if (FINAL.has(e.status) && a.startTick != null && e.worldTick < a.startTick) {
      anomalies.push({ type: 'COMPLETE_BEFORE_START', actorId: a.actorId, actionId: a.actionId, tick: e.worldTick, startTick: a.startTick });
    }
  }
  for (const a of map.values()) {
    const finals = a.statuses.filter((s) => FINAL.has(s));
    const uniqueFinals = new Set(finals);
    if (uniqueFinals.size > 1) {
      anomalies.push({ type: 'MULTIPLE_FINAL_STATES', actorId: a.actorId, actionId: a.actionId, tick: a.ticks.at(-1), statuses: [...uniqueFinals] });
    }
    if (finals.length > 1) {
      anomalies.push({ type: 'DUPLICATE_FINAL', actorId: a.actorId, actionId: a.actionId, tick: a.ticks.at(-1), n: finals.length });
    }
  }
  return { map, anomalies };
}

export function reconcile({ events, ledger, costs = {} }) {
  const { map, anomalies: instanceAnomalies } = indexActions(events);
  const byActorKind = new Map();
  for (const a of map.values()) {
    const key = `${a.actorId}|${a.kind}`;
    const row = byActorKind.get(key) ?? { actorId: a.actorId, kind: a.kind, completed: 0, minutes: 0, energy: 0, aborted: 0, cancelled: 0, failed: 0 };
    const final = a.statuses.find((s) => FINAL.has(s)) ?? 'running';
    if (final === 'completed') { row.completed += 1; row.minutes += a.minutes; row.energy += a.energy; }
    else if (final === 'aborted') row.aborted += 1;
    else if (final === 'cancelled') row.cancelled += 1;
    else if (final === 'failed') row.failed += 1;
    byActorKind.set(key, row);
  }
  const aggAnomalies = [];
  for (const [key, row] of byActorKind) {
    const book = ledger?.[row.actorId]?.byKind?.[row.kind] ?? null;
    const expected = costs[row.kind];
    if (expected && row.completed && row.minutes > 0) {
      const per = row.minutes / row.completed;
      if (Math.abs(per - expected.minutes) > 1e-6) {
        aggAnomalies.push({ type: 'MINUTES_DEVIATION', actorId: row.actorId, kind: row.kind, perAction: per, expected: expected.minutes });
      }
    }
    if (book && Number.isFinite(book.minutes) && Math.abs(row.minutes - book.minutes) > 1e-6) {
      aggAnomalies.push({ type: 'LEDGER_MINUTES_MISMATCH', actorId: row.actorId, kind: row.kind, observer: row.minutes, ledger: book.minutes });
    }
  }
  return {
    instances: map.size,
    statuses: [...map.values()].reduce((acc, a) => { for (const s of a.statuses) acc[s] = (acc[s] ?? 0) + 1; return acc; }, {}),
    rows: [...byActorKind.values()],
    anomalies: [...instanceAnomalies, ...aggAnomalies],
    counts: { instances: map.size, anomalies: instanceAnomalies.length + aggAnomalies.length,
      missingActionId: instanceAnomalies.filter((x) => x.type === 'MISSING_ACTION_ID').length,
      duplicateFinal: instanceAnomalies.filter((x) => x.type === 'DUPLICATE_FINAL').length,
      multipleFinal: instanceAnomalies.filter((x) => x.type === 'MULTIPLE_FINAL_STATES').length,
      beforeStart: instanceAnomalies.filter((x) => x.type === 'COMPLETE_BEFORE_START').length,
      minutesDeviation: aggAnomalies.filter((x) => x.type === 'MINUTES_DEVIATION').length,
      ledgerMismatch: aggAnomalies.filter((x) => x.type === 'LEDGER_MINUTES_MISMATCH').length },
  };
}
