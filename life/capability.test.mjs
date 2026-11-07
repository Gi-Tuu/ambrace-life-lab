// S1 能力内核判据：谓词封闭、组合确定、效果可追溯、未知字段必须炸。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evalPreconditions, hasCaps, generateAffordances, applyEffect, validateAction, makeWorldFromPack, resolveAmount, idOf } from './capability.mjs';

const pack = {
  verbs: [
    { id: 'eat', label: '吃点', needs: 'edible', onePerAgent: true, cost: 0.05, impulse: 0.1, serves: { energy: 1 }, pre: [{ qty_gt: 0 }], effect: { delta: { qty: -1 }, satiated: 'energy', amount: 0.5 } },
    { id: 'take_shared', label: '拿别人的份', needs: ['edible', 'private'], idFormat: 'take_shared:{owner}', cost: 0.16, impulse: 0.95, pre: [{ owner_ne: 'self' }, { owner_absent: true }], expected: true, effect: { delta: { qty: -1 }, satiated: 'energy', amount: '@riskyPortion' } },
  ],
};
const worldOf = () => ({
  t: 5, isNight: false, loc: { a1: 'a', a2: 'b' }, occupancy: { a: ['a1'], b: ['a2'] }, secrets: [],
  things: {
    pantry: { id: 'pantry', loc: 'a', qty: 2, props: { edible: 1 } },
    crate: { id: 'crate', loc: 'a', owner: 'a2', qty: 2, props: { edible: 1, private: 1 } },
    bed: { id: 'bed', loc: 'a', props: { restable: 1 } },
  },
});

test('谓词是封闭集合：未知谓词必须抛错，不能默认放行', () => {
  assert.throws(() => evalPreconditions([{ is_friday: true }], { world: worldOf(), agent: { id: 'a1' }, thing: {}, params: {} }), /未知前置谓词/);
});

test('能力不匹配的对象不生成候选（组合爆炸防线）', () => {
  assert.equal(hasCaps({ props: { restable: 1 } }, ['edible', 'private']), false);
  assert.equal(hasCaps({ props: { edible: 1, private: 1 } }, ['edible', 'private']), true);
});

test('候选顺序确定且 id 与 legacy 形状逐位相同', () => {
  const w = worldOf();
  const acts = generateAffordances({ pack, world: w, agent: { id: 'a1' }, params: { riskyPortion: 1.1 } });
  assert.deepEqual(acts.map((a) => a.id), ['eat', 'take_shared:a2']);
  assert.equal(idOf(pack.verbs[1], w.things.crate, { agent: { id: 'a1' }, world: w }), 'take_shared:a2');
});

test('id 撞车必须炸：静默去重等于悄悄改变动作空间', () => {
  const noFlag = { verbs: [{ id: 'eat', needs: 'edible', cost: 0.05, impulse: 0.1, effect: { amount: 0.5 } }] };
  assert.throws(() => generateAffordances({ pack: noFlag, world: worldOf(), agent: { id: 'a1' } }), /候选 id 撞车/);
});

test('前置条件生效：owner 在场时不能转述式取走，缺席时可以', () => {
  const w = worldOf();
  assert.equal(validateAction({ pack, world: w, agent: { id: 'a1' }, intent: { kind: 'take_shared', thing: 'crate' }, params: { riskyPortion: 1.1 } }).ok, true);
  w.loc.a2 = 'a';
  w.occupancy.a.push('a2');
  const v = validateAction({ pack, world: w, agent: { id: 'a1' }, intent: { kind: 'take_shared', thing: 'crate' }, params: { riskyPortion: 1.1 } });
  assert.equal(v.ok, false);
  assert.match(v.why, /owner_absent/);
});

test('效果器：数量减少、参数引用解析、未知增量字段必须炸', () => {
  const w = worldOf();
  const r = applyEffect({ pack, world: w, agent: { id: 'a1' }, intent: { kind: 'take_shared', thing: 'crate' }, params: { riskyPortion: 1.1 } });
  assert.equal(r.ok, true);
  assert.equal(w.things.crate.qty, 1, '数量没减少 ⇒ delta 未生效');
  assert.equal(r.amount, 1.1, '@riskyPortion 未解析');
  assert.throws(() => resolveAmount('@nope', { params: {} }), /不存在的参数/);
  const bad = { verbs: [{ id: 'x', effect: { delta: { mood: -1 } } }] };
  assert.throws(() => applyEffect({ pack: bad, world: w, agent: { id: 'a1' }, intent: { kind: 'x', thing: 'bed' } }), /不认识增量字段/);
});

test('目击登记由动词声明，而不是写死在效果器里', () => {
  const w = worldOf();
  const secretPack = { verbs: [{ id: 'take_shared', needs: ['edible', 'private'], pre: [], effect: { delta: { qty: -1 }, amount: 1.1, secret: { kind: 'theft', about: '@owner', holder: '@self', violates: 'order' }, witness: true } }] };
  applyEffect({ pack: secretPack, world: w, agent: { id: 'a1' }, intent: { kind: 'take_shared', thing: 'crate' } });
  const s = w.secrets[0];
  assert.deepEqual([...s.known].sort(), ['a1'], '只登记作案者 ⇒ witness 声明没生效');
  assert.equal(s.about, 'a2');
});

test('makeWorldFromPack 产出可运行的空世界', () => {
  const w = makeWorldFromPack({ locs: { a: {}, b: {} }, things: [{ id: 't', loc: 'a', props: {}, qty: 1 }], agents: { a1: { loc: 'a' } } }, ['a1']);
  assert.equal(w.loc.a1, 'a');
  assert.deepEqual(w.occupancy.a, ['a1']);
});
