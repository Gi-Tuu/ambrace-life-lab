// V7.3.3 P1-A：统一长程动作观测。事件不依赖 trace 长度（裁剪后仍工作），不耗 RNG，限长。
// DATA5-13：默认上限从 20 万降到 2 万，raw 流最多 2×cap。observer 只用于诊断，不是生产状态；
// 25 万事件实测曾占 145MB heap，长跑必须让内存有界。
export const ACTION_EVENT_CAP = 20000;
export const ACTION_RAW_CAP_MULT = 2;

export function actionEvent({ actorId, actionId, worldTick, kind, status, actualMinutes = 0, actualEnergy = 0, progressMinutes = null, source = 'trace', extra = null }) {
  return { actorId, actionId, worldTick, kind, status, actualMinutes, actualEnergy, progressMinutes, source, extra };
}

export function createActionObserver({ cap = ACTION_EVENT_CAP } = {}) {
  const events = [];
  const raw = []; // 独立原始流：保留重复完成，供对账使用
  const seen = new Set();
  const byTick = new Map();
  let dropped = 0;
  return {
    events,
    raw,
    dropped: () => dropped,
    feed(event) {
      if (!event || !event.actorId || !Number.isFinite(event.worldTick) || !event.kind) return false;
      raw.push(event);
      if (raw.length > cap * ACTION_RAW_CAP_MULT) raw.shift();
      const key = event.actionId
        ? `${event.actionId}|${event.status}`
        : `${event.actorId}|${event.worldTick}|${event.kind}|${event.status}|${event.source}`;
      if (seen.has(key)) return false;
      seen.add(key);
      events.push(event);
      const bucket = byTick.get(event.worldTick) ?? []; bucket.push(event); byTick.set(event.worldTick, bucket);
      if (events.length > cap) {
        const old = events.shift();
        const ob = byTick.get(old.worldTick); if (ob) { const i = ob.indexOf(old); if (i >= 0) ob.splice(i, 1); if (!ob.length) byTick.delete(old.worldTick); }
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
    eventsAt(tick) { return (byTick.get(tick) ?? []).slice(); },
  };
}



