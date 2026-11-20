// 阶段 5：A/B 对照的限长回放历史（只读）。
// 范围请求只传状态卡；选定一刻才传该刻的场景数据。
// 修订号不符、超出窗口、缺帧都返回可解释结果，不猜、不补造。
//
// 1.1 第 3 项：A/B 各自连续钟后，刻不再是唯一时间键。
// 新帧同时记 `minute`（世界分钟）与逐侧 `minutes`；场景按“分钟”另存索引。
// 旧帧没有 minute 时一律按 `t*60` 归一，旧 archive 仍可读；查不到场景就返回 null，
// 绝不拿相邻分钟或另一侧的场景冒充。

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
// 旧帧的 minute 归一：没有 minute 的帧就是旧“每刻=60 分”语义。
export const replayFrameMinute = (frame) => Number.isFinite(frame?.minute)
  ? Math.max(0, frame.minute)
  : Math.max(0, Number(frame?.t ?? 0)) * 60;
const minuteKey = (minute) => String(Math.max(0, Math.floor(minute)));

function rememberScenes(replay, frame, minutes) {
  if (!frame.scene) return;
  const index = (replay.sceneMinutes ??= { A: {}, B: {} });
  for (const side of ['A', 'B']) {
    const scene = frame.scene[side];
    if (!scene) continue;
    const minute = Number.isFinite(minutes?.[side]) ? minutes[side] : replayFrameMinute(frame);
    (index[side] ??= {})[minuteKey(minute)] = scene;
  }
}

function pruneScenes(replay) {
  if (!replay.sceneMinutes) return;
  const keep = new Set();
  for (const frame of replay.frames) {
    keep.add(minuteKey(replayFrameMinute(frame)));
    for (const side of ['A', 'B']) {
      if (Number.isFinite(frame.minutes?.[side])) keep.add(minuteKey(frame.minutes[side]));
    }
  }
  for (const side of ['A', 'B']) {
    const index = replay.sceneMinutes[side];
    if (!index) continue;
    for (const key of Object.keys(index)) if (!keep.has(key)) delete index[key];
  }
}

export function recordReplayFrame(replay, { t, minute, minutes, A, B, scene, events = [], revision = replay.revision }) {
  if (revision !== replay.revision) return { ok: false, code: 'REPLAY_STALE' };
  if (!Number.isFinite(t)) return { ok: false, code: 'BAD_TICK' };
  for (const e of eventsAt(events, t)) recordReplayEvent(replay, e);
  const atMinute = Number.isFinite(minute) ? Math.max(0, minute) : Math.max(0, t) * 60;
  const frame = {
    t, minute: atMinute, ...(minutes ? { minutes } : {}),
    A, B, events: eventsAt(replay.events, t), ...(scene && { scene }),
  };
  // 连续钟下同一刻可能有多帧（分钟不同）；只有“同一分钟”才覆盖。
  const existing = replay.frames.findLastIndex((f) => replayFrameMinute(f) === atMinute);
  if (existing >= 0) replay.frames[existing] = frame;
  else replay.frames.push(frame);
  while (replay.frames.length > replay.maxFrames) { replay.frames.shift(); replay.dropped += 1; }
  rememberScenes(replay, frame, minutes);
  pruneScenes(replay);
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
    frames: pick.map(({scene,...summary})=>summary),
    events: (replay.events ?? []).filter((e) => (Number.isFinite(from) ? e.t >= from : true) && (Number.isFinite(to) ? e.t <= to : true)),
    note: pick.length ? null : '请求范围没有关键帧（窗口之外或该刻未记录）',
  };
}

// tick→scene 映射：请求仍是刻（前端/旧档契约），查找按该刻对应的世界分钟。
// 新 compare 的逐帧场景来自实时 survView；旧帧没有 sceneMinutes，退回 frame.scene。
export function replayPoint(replay, t, revision) {
  if (!replay) return { ok: false, code: 'NO_REPLAY' };
  if (revision !== undefined && revision !== replay.revision) return { ok: false, code: 'REPLAY_STALE', revision: replay.revision };
  const targetMinute = Math.max(0, Number(t)) * 60;
  const candidates = replay.frames.filter((f) => replayFrameMinute(f) === targetMinute);
  // 旧帧没有 minute 时同一刻可能有多帧（例如一侧暂停后同 tick 两帧）；优先选两侧场景都
  // 正好落在请求刻的那一帧，避免拿“半侧新、半侧旧”的最后一帧把画面判成不可用。
  const frame = candidates.findLast((f) => f.scene?.A?.t === t && f.scene?.B?.t === t)
    ?? candidates.at(-1)
    ?? replay.frames.findLast((f) => f.t === t);
  const events = (replay.events ?? []).filter((e) => e.t === t);
  if (!frame) {
    const min = replay.frames[0]?.t ?? null, max = replay.frames.at(-1)?.t ?? null;
    return { ok: false, code: 'REPLAY_NO_FRAME', t, events, coverage: { min, max }, note: events.length ? '该刻没有可回放状态，但事件详情仍可读；历史画面标记为不可用' : '该刻没有可回放状态（在窗口之外或未记录）' };
  }
  const {scene,...summary}=frame;
  const indexed = (side) => replay.sceneMinutes?.[side]?.[minuteKey(targetMinute)] ?? null;
  // 旧档/同分钟帧：scene 自带 t，只有正好是请求刻时才采用。
  const fallback = (side) => scene?.[side]?.t === t ? scene[side] : null;
  const A = indexed('A') ?? fallback('A');
  const B = indexed('B') ?? fallback('B');
  // 只有两侧都在请求分钟有真实场景才返回画面；缺一侧就 null，前端按“无场景”显示。
  const scenes = replay.terrain && A && B
    ? Object.fromEntries(['A','B'].map(side=>[side,{...replay.terrain,...(side==='A'?A:B)}]))
    : null;
  return { ok:true, revision:replay.revision, frame:summary, scenes, events };
}
