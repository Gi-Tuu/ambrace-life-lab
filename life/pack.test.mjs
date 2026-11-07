// S4 场景包判据：缺校准段拒绝装载、死配置拒绝装载、自检必须能拒绝"永生世界"和"必死世界"。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validatePack, selfCheck } from './pack.mjs';

const base = JSON.parse(await readFile(new URL('../packs/example-toy.pack.json', import.meta.url), 'utf8'));

test('外部包文件可加载并通过校验（包是数据，不是代码）', () => {
  const v = validatePack(base);
  assert.ok(v.ok, `校验失败：${v.errors.join('; ')}`);
});

test('缺校准段必须拒绝：没有 economy 的包不允许装载', () => {
  const noEcon = { ...base, economy: undefined };
  const v = validatePack(noEcon);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('economy')), `报错没点名 economy：${v.errors.join('; ')}`);
});

test('死配置必须拒绝：要求的能力没有任何对象具备', () => {
  const dead = structuredClone(base);
  dead.verbs.push({ id: 'fly', needs: 'flyable', cost: 0.1, impulse: 0.1, effect: { amount: 0 } });
  const v = validatePack(dead);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('flyable')), v.errors.join('; '));
});

test('未知谓词与非法占位符必须拒绝', () => {
  const bad = structuredClone(base);
  bad.verbs[1].pre = [{ is_raining: true }];
  assert.ok(validatePack(bad).errors.some((e) => e.includes('is_raining')));
  const bad2 = structuredClone(base);
  bad2.verbs[2].idFormat = 'take_shared:{mood}';
  assert.ok(validatePack(bad2).errors.some((e) => e.includes('占位符')));
});

test('自检：玩具世界既可垮也可活（选择才有意义）', () => {
  const r = selfCheck(base, { ticks: 1200 });
  assert.ok(r.ok, `自检没过：${JSON.stringify(r.verdict)}`);
  assert.equal(r.verdict.可垮, true);
  assert.equal(r.verdict.可活, true);
  assert.equal(r.rows.length, 2);
});

test('自检负控一：补给无限的"永生世界"必须被拒', () => {
  const rich = structuredClone(base);
  rich.things.push({ id: 'pantry_b', loc: 'b', label: '粮缸', qty: 99, props: { edible: 1 } });
  rich.regen = [{ thing: 'pantry_a', every: 5, add: 8, max: 99 }, { thing: 'pantry_b', every: 5, add: 8, max: 99 }];
  const r = selfCheck(rich, { ticks: 1200 });
  assert.equal(r.verdict.可垮, false, '无限补给却仍报"可垮" ⇒ 自检算不出收支');
  assert.equal(r.ok, false, '永生世界被放行 ⇒ 自检形同虚设');
});

test('自检负控二：零补给的"必死世界"必须被拒', () => {
  const poor = structuredClone(base);
  poor.regen = [];
  poor.things.find((t) => t.id === 'pantry_a').qty = 1;
  poor.things.find((t) => t.id === 'crate_a1').qty = 0;
  const r = selfCheck(poor, { ticks: 1200 });
  assert.equal(r.verdict.可活, false, '零补给还能"可活" ⇒ 收支算错了');
  assert.equal(r.ok, false);
});

test('自检拒绝不合格包：校验不过就不跑仿真', () => {
  const r = selfCheck({ ...base, economy: undefined });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('economy')));
});
