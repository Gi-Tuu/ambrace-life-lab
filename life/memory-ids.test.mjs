// F3 闸门（PLAN §26.2）：记忆行 id 必须单调，存档往返/截断后不得复用 id。
import test from 'node:test';
import assert from 'node:assert/strict';
import { EpisodicMemory } from './memory.mjs';

const row = (t) => ({ kind: 'x', payload: '', mSnapshot: { arousal: 0.5 }, importance: 0.5 });

test('F3 截断后 id 不复用：超过 400 条仍单调', () => {
  const m = new EpisodicMemory();
  for (let i = 0; i < 450; i++) m.add(i, row(i));
  const ids = m.rows.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, '截断后出现重复 id ⇒ failures 会作用到错行');
  assert.ok(m.nextId > 449);
});

test('F3 存档往返后继续单调：载入 120 条后新增 200 条不得撞号', () => {
  const m = new EpisodicMemory();
  for (let i = 0; i < 400; i++) m.add(i, row(i));
  const dumped = m.dump();
  const n = new EpisodicMemory();
  n.load(dumped);
  for (let i = 0; i < 200; i++) n.add(400 + i, row(400 + i));
  const ids = n.rows.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, '载入后新增与存量撞号 ⇒ 旧实现 bug 复发');
});

test('F3 旧档兼容：没有 nextId 的旧存档从现存最大 id 之后继续', () => {
  const n = new EpisodicMemory();
  n.load({ rows: [{ id: 280, t: 1, kind: 'x', payload: '', m: {}, importance: 0.5 }, { id: 399, t: 2, kind: 'x', payload: '', m: {}, importance: 0.5 }], kCap: 6, failures: [] });
  n.add(3, row(3));
  assert.equal(n.rows.at(-1).id, 400, '旧档缺 nextId 时没有从最大 id 之后继续');
});
