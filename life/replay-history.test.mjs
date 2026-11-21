// 阶段 5 闸门：回放历史的窗口、修订、缺帧与同刻顺序。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createReplay, recordReplayFrame, recordReplayEvent, replayRange, replayPoint } from './replay-history.mjs';

const card = (side, t, extra = {}) => ({ side, t, store: 10, buildings: [{ type: 'house', loc: 'home', integrity: 1 }], agents: [], ...extra });

test('RP-01 窗口：保留最近 N 帧，范围裁剪并报告 coverage', () => {
  const replay = createReplay(3, 4);
  for (let t = 1; t <= 6; t += 1) recordReplayFrame(replay, { t, A: card('A', t), B: card('B', t) });
  assert.equal(replay.frames.length, 4);
  assert.equal(replay.dropped, 2);
  const r = replayRange(replay, { from: 4, to: 6, revision: 3 });
  assert.deepEqual(r.frames.map((f) => f.t), [4, 5, 6]);
  assert.deepEqual(r.coverage, { min: 3, max: 6, requested: [4, 6] });
  const outside = replayRange(replay, { from: 1, to: 2 });
  assert.equal(outside.frames.length, 0);
  assert.ok(outside.note);
});

test('RP-02 修订号不符：range/point/record 都返回 REPLAY_STALE，不混入旧时间轴', () => {
  const replay = createReplay(7);
  recordReplayFrame(replay, { t: 5, A: card('A', 5), B: card('B', 5) });
  assert.equal(replayRange(replay, { revision: 6 }).code, 'REPLAY_STALE');
  assert.equal(replayPoint(replay, 5, 6).code, 'REPLAY_STALE');
  assert.equal(recordReplayFrame(replay, { t: 6, A: card('A', 6), B: card('B', 6), revision: 6 }).code, 'REPLAY_STALE');
  assert.equal(replay.frames.length, 1, '过期修订不得写入');
});

test('RP-03 缺帧：事件详情仍可读，历史画面标记不可用', () => {
  const replay = createReplay(1);
  recordReplayFrame(replay, { t: 10, A: card('A', 10), B: card('B', 10) });
  recordReplayEvent(replay, { id: 9, t: 500, kind: 'storm_impact', side: 'A' });
  const p = replayPoint(replay, 500, 1);
  assert.equal(p.ok, false);
  assert.equal(p.code, 'REPLAY_NO_FRAME');
  assert.equal(p.events.length, 1, '事件必须独立于帧保留');
  assert.match(p.note, /事件详情仍可读/);
  const r = replayRange(replay, { from: 490, to: 510 });
  assert.equal(r.events.length, 1, '范围查询也要带事件');
});

test('RP-04 同刻多动作顺序稳定：事件按记录顺序返回', () => {
  const replay = createReplay(2);
  recordReplayFrame(replay, {
    t: 20, A: card('A', 20), B: card('B', 20),
    events: [{ id: 1, t: 20, kind: 'act', side: 'A', seq: 0 }, { id: 2, t: 20, kind: 'act', side: 'A', seq: 1 }, { id: 3, t: 20, kind: 'storm_impact', side: 'B', seq: 2 }],
  });
  assert.deepEqual(replayPoint(replay, 20, 2).frame.events.map((e) => e.id), [1, 2, 3]);
});

test('RP-05 空历史/无对照：可解释，不抛异常', () => {
  const empty = createReplay(0);
  const r = replayRange(empty, { from: 1, to: 9 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.frames, []);
  assert.ok(r.note);
  assert.equal(replayRange(null).code, 'NO_REPLAY');
  assert.equal(replayPoint(null, 1).code, 'NO_REPLAY');
});

test('RP-06 单侧暂停：缺场景侧显式 null，不借相邻分钟/另一侧场景', () => {
  const replay = createReplay(4);
  replay.terrain = { mapSeed: 13 };
  // A 冻结在 60 分；B 推进到 120 分。新帧 minute 取共同前沿，逐侧 minutes 各自入索引。
  recordReplayFrame(replay, {
    t: 1, minute: 60, minutes: { A: 60, B: 60 }, A: card('A', 1), B: card('B', 1),
    scene: { A: { t: 1, weather: 'clear' }, B: { t: 1, weather: 'clear' } },
  });
  recordReplayFrame(replay, {
    t: 2, minute: 120, minutes: { A: 60, B: 120 }, A: card('A', 1), B: card('B', 2),
    scene: { A: { t: 1, weather: 'clear' }, B: { t: 2, weather: 'rain' } },
  });
  const atB = replayPoint(replay, 2, 4);
  assert.equal(atB.ok, true);
  assert.equal(atB.sceneSides.A.scene, null, 'A 在 120 分没有场景，必须为 null');
  assert.equal(atB.sceneSides.A.minute, 60, '缺场景侧仍要带出自己的实际记录分钟');
  assert.ok(atB.sceneSides.B.scene, 'B 在该分钟有真实场景');
  assert.equal(atB.sceneSides.B.minute, 120);
  assert.equal(atB.scenes.A, null);
  assert.equal(atB.scenes.B.weather, 'rain');
  assert.match(atB.note, /A 侧没有场景/);
});

test('RP-07 相邻分钟不冒充：tick 1 的 B 侧不得拿 62 分场景', () => {
  const replay = createReplay(5);
  replay.terrain = { mapSeed: 13 };
  // 只有 62 分的帧（t 派生为 1）；B 侧分钟 62 ≠ t×60=60，必须 null。
  recordReplayFrame(replay, {
    t: 1, minute: 62, minutes: { A: 60, B: 62 }, A: card('A', 1), B: card('B', 1),
    scene: { A: { t: 1, weather: 'clear' }, B: { t: 1, weather: 'rain' } },
  });
  const partial = replayPoint(replay, 1, 5);
  assert.equal(partial.ok, true);
  assert.equal(partial.sceneSides.B.scene, null, '相邻分钟场景不得冒充请求分钟');
  assert.equal(partial.sceneSides.B.minute, 62);
  assert.ok(partial.sceneSides.A.scene, 'A 侧本身在 60 分，仍可显示');
  // 两侧都不在请求分钟 ⇒ 明确缺帧，不借任何相邻帧。
  recordReplayFrame(replay, {
    t: 2, minute: 122, minutes: { A: 61, B: 122 }, A: card('A', 1), B: card('B', 2),
    scene: { A: { t: 1, weather: 'clear' }, B: { t: 2, weather: 'rain' } },
  });
  const missing = replayPoint(replay, 2, 5);
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'REPLAY_NO_FRAME');
  assert.equal(missing.minute, 120);
  assert.equal(missing.scenes, undefined);
});

test('同一刻保留最新场景及已有事件；旧帧不借用新场景',()=>{
  const replay=createReplay(2);
  replay.terrain={mapSeed:13};
  recordReplayFrame(replay,{t:0,A:card('A',0),B:card('B',0)});
  const scenes=(weather)=>({A:{t:1,weather},B:{t:1,weather:'clear'}});
  recordReplayFrame(replay,{t:1,A:card('A',1),B:card('B',1),scene:scenes('clear'),events:[{id:1,t:1}]});
  recordReplayFrame(replay,{t:1,A:card('A',1),B:card('B',1),scene:scenes('rain')});
  const selected=replayPoint(replay,1,2);
  assert.equal(replay.frames.length,2);
  assert.ok(selected.scenes);
  assert.deepEqual(selected.scenes.A,{mapSeed:13,t:1,weather:'rain'});
  assert.equal(selected.scenes.B.weather,'clear');
  assert.deepEqual(selected.frame.events,[{id:1,t:1}]);
  assert.equal(replayPoint(replay,0,2).scenes,null);
  assert.ok(replayRange(replay).frames.every(frame=>!frame.scene));
});
