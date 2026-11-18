// V7.3.3 P1-A：统一长程动作观测。事件不依赖 trace 长度（裁剪后仍工作），不耗 RNG，限长。
export const ACTION_EVENT_CAP = 200000;

export function actionEvent({ actorId, actionId, worldTick, kind, status, actualMinutes = 0, actualEnergy = 0, progressMinutes = null, source = 'trace', extra = null }) {
  return { actorId, actionId, worldTick, kind, status, actualMinutes, actualEnergy, progressMinutes, source, extra };
}

export function createActionObserver({ cap = ACTION_EVENT_CAP } = {}) {
  const events = [];
  const seen = new Set();
  let dropped = 0;
  return {
    events,
    dropped: () => dropped,
    feed(event) {
      if (!event || !event.actorId || !Number.isFinite(event.worldTick) || !event.kind) return false;
      const key = event.actionId
        ? `${event.actionId}|${event.status}`
        : `${event.actorId}|${event.worldTick}|${event.kind}|${event.status}|${event.source}`;
      if (seen.has(key)) return false;
      seen.add(key);
      events.push(event);
      if (events.length > cap) {
        const old = events.shift();
        seen.delete(old.actionId ? `${old.actionId}|${old.status}` : `${old.actorId}|${old.worldTick}|${old.kind}|${old.status}|${old.source}`);
        dropped += 1;
      }
      return true;
    },
    summary() {
      const byStatus = {}, byKind = {}, byActor = {};
      for (const e of events) {
        byStatus[e.status] = (byStatus[e.status] ?? 0) + 1;
        byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
        byActor[e.actorId] = (byActor[e.actorId] ?? 0) + 1;
      }
      return { n: events.length, dropped, byStatus, byKind, byActor };
    },
    eventsAt(tick) { return events.filter((e) => e.worldTick === tick); },
  };
}

