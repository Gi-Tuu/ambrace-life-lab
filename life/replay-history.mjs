// 阶段 5：A/B 对照的限长回放历史（只读）。
// 只保存"可解释的最小状态"：每侧每刻的建筑损伤/库存/角色位置，加当刻事件与同刻顺序。
// 修订号不符、超出窗口、缺帧都返回可解释结果，不猜、不补造。

export const REPLAY_MAX_FRAMES = 240;

export function createReplay(revision = 0, maxFrames = REPLAY_MAX_FRAMES) {
  return { revision, maxFrames, frames: [], events: [], dropped: 0 };
}

const eventKey = (e) => [e?.side ?? '', e?.kind ?? '', e?.t ?? '', e?.id ?? ''].join('|');
export function recordReplayEvent(replay, event, { maxEvents = 400 } = {}) {
  const key = eventKey(event);
  if (!replay.events.some((e) => eventKey(e) === key)) replay.events.push(event);
  if (replay.events.length > maxEvents) replay.events.shift();
  return event;
}

const eventsAt = (events, t) => (events ?? []).filter((e) => e.t === t);

export function recordReplayFrame(replay, { t, A, B, events = [], revision = replay.revision }) {
  if (revision !== replay.revision) return { ok: false, code: 'REPLAY_STALE' };
  if (!Number.isFinite(t)) return { ok: false, code: 'BAD_TICK' };
  for (const e of eventsAt(events, t)) recordReplayEvent(replay, e);
  replay.frames.push({ t, A, B, events: eventsAt(events, t) });
  while (replay.frames.length > replay.maxFrames) { replay.frames.shift(); replay.dropped += 1; }
  return { ok: true };
}

export function replayRange(replay, { from, to, revision } = {}) {
  if (!replay) return { ok: false, code: 'NO_REPLAY' };
  if (revision !== undefined && revision !== replay.revision) return { ok: false, code: 'REPLAY_STALE', revision: replay.revision };
  const frames = replay.frames;
  if (!frames.length) return { ok: true, revision: replay.revision, from: null, to: null, coverage: null, frames: [], note: '还没有可回放的关键帧' };
  const min = frames[0].t, max = frames[frames.length - 1].t;
  const lo = Number.isFinite(from) ? Math.max(from, min) : min;
  const hi = Number.isFinite(to) ? Math.min(to, max) : max;
  const pick = frames.filter((f) => f.t >= lo && f.t <= hi);
  return {
    ok: true, revision: replay.revision,
    from: lo, to: hi, coverage: { min, max, requested: [Number.isFinite(from) ? from : min, Number.isFinite(to) ? to : max] },
    dropped: replay.dropped,
    frames: pick,
    events: (replay.events ?? []).filter((e) => (Number.isFinite(from) ? e.t >= from : true) && (Number.isFinite(to) ? e.t <= to : true)),
    note: pick.length ? null : '请求范围没有关键帧（窗口之外或该刻未记录）',
  };
}

export function replayPoint(replay, t, revision) {
  if (!replay) return { ok: false, code: 'NO_REPLAY' };
  if (revision !== undefined && revision !== replay.revision) return { ok: false, code: 'REPLAY_STALE', revision: replay.revision };
  const frame = replay.frames.find((f) => f.t === t);
  const events = (replay.events ?? []).filter((e) => e.t === t);
  if (!frame) {
    const min = replay.frames[0]?.t ?? null, max = replay.frames.at(-1)?.t ?? null;
    return { ok: false, code: 'REPLAY_NO_FRAME', t, events, coverage: { min, max }, note: events.length ? '该刻没有可回放状态，但事件详情仍可读；历史画面标记为不可用' : '该刻没有可回放状态（在窗口之外或未记录）' };
  }
  return { ok: true, revision: replay.revision, frame, events };
}

