// The journal follows the world save and never participates in action selection.
export const SETTLEMENT_EVENT_LIMIT = 160;

export function recordSettlementEvent(world, kind, details) {
  if (!world.gameRules || !world.survival) return;
  const journal = world.survival.eventJournal ??= { next: 1, rows: [], lastWarningDay: null };
  const event = { id: journal.next++, t: world.t, kind, ...details };
  journal.rows.push(event);
  if (journal.rows.length > SETTLEMENT_EVENT_LIMIT) journal.rows.shift();
}

export function restoreSettlementEvents(survival) {
  const raw = survival.eventJournal;
  if (!Array.isArray(raw?.rows)) {
    delete survival.eventJournal;
    return;
  }
  const rows = raw.rows.slice(-SETTLEMENT_EVENT_LIMIT).filter((row) =>
    Number.isSafeInteger(row?.id) && row.id > 0 && Number.isSafeInteger(row.t) && typeof row.kind === 'string');
  const minNext = Math.max(0, ...rows.map((row) => row.id)) + 1;
  survival.eventJournal = { rows,
    next: Math.max(minNext, Number.isSafeInteger(raw.next) ? raw.next : 1),
    lastWarningDay: Number.isInteger(raw.lastWarningDay) ? raw.lastWarningDay : null,
  };
}

export function recordStormWarning(world, day) {
  if (!world.gameRules) return;
  if (world.survival.eventJournal?.lastWarningDay === day) return;
  recordSettlementEvent(world, 'storm_warning', { stormDay: day });
  world.survival.eventJournal.lastWarningDay = day;
}

export function stormDamageForRepair(world, loc, type) {
  const latest = world.survival.eventJournal?.rows.findLast((row) =>
    (row.kind === 'storm_impact' && Array.isArray(row.buildings) && row.buildings.some((b) => b.loc === loc && b.type === type))
    || (row.kind === 'repair' && row.ok && row.loc === loc && row.type === type));
  return latest?.kind === 'storm_impact' ? { stormDay: latest.stormDay, damageId: latest.id } : {};
}
