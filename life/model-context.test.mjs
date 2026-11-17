// 阶段 4 闸门：压缩候选只改渲染，不改判定；默认关闭；负控能被判据抓住。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCompactDeliberationPrompt, compactEnabled, missingCriticalFacts, MEMORY_CAP } from './model-context.mjs';
import { buildDeliberationPrompt, deliberationPrompt } from './host.mjs';

const agent = {
  id: 'a1', name: '甲', traits: { archetype: '孤僻' },
  drives: { dominant: () => ({ label: 'energy', e: 0.4, urgency: 0.6 }) },
  bank: { summary: () => '警觉中、趋近低' }, ch: {},
};
const scored = [
  { id: 'gather', u: 0.6, act: { label: '采集' } },
  { id: 'rest', u: 0.5, act: { label: '休息' } },
  { id: 'move_to:yard', u: 0.4, act: { label: '走到院子' } },
];
const world = {
  t: 42, loc: { a1: 'yard' }, occupancy: { yard: ['a1', 'a2'] },
  agents: { a2: { name: '乙' } },
  survival: { store: 2, water: 0.4 }, pinv: { a1: { wood: 1, stone: 0 } },
};
const base = {
  agent, scored, world, rejected: null,
  memories: [{ kind: 'gather', sim: 0.9 }, { kind: 'gather', sim: 0.8 }, { kind: 'rest', sim: 0.7 }],
  trigger: '发现缺口', daySummary: '第 1 天：做了 3 个决定', bands: {},
};
const sample = {
  t: 42, loc: 'yard', trigger: '发现缺口',
  survival: { store: 2, water: 0.4, wood: 1, stone: 0 },
  rejected: null, candidateIds: scored.map((s) => s.id),
};

test('CTX-01 默认关闭：deliberationPrompt 默认与生产构造器逐字相同', () => {
  const old = process.env.MODEL_CONTEXT;
  delete process.env.MODEL_CONTEXT;
  try {
    assert.equal(compactEnabled(), false);
    assert.equal(deliberationPrompt(base), buildDeliberationPrompt(base), '未开开关时默认路径必须逐字相同');
    assert.equal(deliberationPrompt(base, 'original'), buildDeliberationPrompt(base));
  } finally {
    if (old === undefined) delete process.env.MODEL_CONTEXT; else process.env.MODEL_CONTEXT = old;
  }
});

test('CTX-02 打开开关：候选只由 compact 渲染，两版复用同一份输入', () => {
  const old = process.env.MODEL_CONTEXT;
  process.env.MODEL_CONTEXT = 'compact';
  try {
    const compact = deliberationPrompt(base);
    assert.equal(compact, buildCompactDeliberationPrompt({ ...base }));
    assert.notEqual(compact, buildDeliberationPrompt(base));
    assert.ok(compact.length < buildDeliberationPrompt(base).length);
  } finally {
    if (old === undefined) delete process.env.MODEL_CONTEXT; else process.env.MODEL_CONTEXT = old;
  }
});

test('CTX-03 关键事实不丢：触发/库存/候选顺序/协议都在，缺一即判据失败', () => {
  const prompt = buildCompactDeliberationPrompt(base);
  assert.deepEqual(missingCriticalFacts(prompt, sample), [], '候选必须保留全部关键事实');
  // 负控二：删掉库存或驳回理由，判据必须抓住
  assert.ok(missingCriticalFacts(prompt.replace('公共食物 2 份', ''), sample).includes('store'));
  const withRejected = { ...base, rejected: { from: 'build', why: '材料不够', code: 'NO_MATERIAL' } };
  const sampleR = { ...sample, rejected: { from: 'build', why: '材料不够' } };
  const p2 = buildCompactDeliberationPrompt(withRejected);
  assert.deepEqual(missingCriticalFacts(p2, sampleR), []);
  assert.ok(missingCriticalFacts(p2.replace('材料不够', ''), sampleR).includes('rejected.why'), '删掉驳回理由必须变红');
  for (const id of scored.map((s) => s.id)) assert.ok(p2.includes(`- ${id} |`), '候选顺序/ID 必须保留：' + id);
});

test('CTX-04 记忆去重与上限：同 kind 只留最相似一条，缺字段走可解释降级', () => {
  const many = [
    { kind: 'gather', sim: 0.9 }, { kind: 'gather', sim: 0.5 },
    { kind: 'rest', sim: 0.8 }, { kind: 'move_to', sim: 0.7 },
    { kind: 'talk', sim: 0.6 }, { kind: 'eat', sim: 0.4 },
    { kind: 'look_out', sim: 0.3 }, { kind: 'plant', sim: 0.2 },
  ];
  const prompt = buildCompactDeliberationPrompt({ ...base, memories: many });
  assert.equal((prompt.match(/gather\(相似0\.9\)/g) ?? []).length, 1, '同 kind 只留最高相似度');
  assert.ok(!prompt.includes('gather(相似0.5)'));
  const kinds = (prompt.match(/[a-z_]+\(相似/g) ?? []).length;
  assert.ok(kinds <= MEMORY_CAP, `记忆行不得超过 ${MEMORY_CAP} 条，实测 ${kinds}`);
  // 旧记录只有 kind、没有 sim/loc/task 时：按原序、不崩
  const legacy = buildCompactDeliberationPrompt({ ...base, memories: [{ kind: 'gather' }, { kind: 'rest', sim: 0.2 }] });
  assert.ok(legacy.includes('gather(相似0)'));
  const empty = buildCompactDeliberationPrompt({ ...base, memories: [] });
  assert.ok(empty.includes('你想起的事：暂无'));
});

test('CTX-05 空候选/重复 ID/同名居民：构造器不崩且不擅自删候选', () => {
  const dup = [
    { id: 'talk:a2', u: 0.6, act: { label: '和乙说话' } },
    { id: 'talk:a2', u: 0.5, act: { label: '和乙说话' } },
  ];
  const prompt = buildCompactDeliberationPrompt({ ...base, scored: dup });
  assert.equal((prompt.match(/- talk:a2 \|/g) ?? []).length, 2, '重复 ID 不得被静默合并');
  const none = buildCompactDeliberationPrompt({ ...base, scored: [] });
  assert.ok(none.includes('可做的事'));
});
