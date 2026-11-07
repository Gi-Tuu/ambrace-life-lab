// 场景适配器契约的判据。三条：默认场景零漂移、缺字段必须点名失败、第二个场景能独立驱动世界/动作闭环。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SCENE, SCENE_FIELDS, assertScene, extendScene } from './scene.mjs';
import { LOCS, BASE_KINDS, makeWorld, affordancesFor, actuate } from './body.mjs';
import { validate } from './rules.mjs';

test('默认场景零漂移：契约里的每一项与现有实现是同一引用', () => {
  assert.equal(DEFAULT_SCENE.locs, LOCS);
  assert.equal(DEFAULT_SCENE.kinds, BASE_KINDS);
  assert.equal(DEFAULT_SCENE.makeWorld, makeWorld);
  assert.equal(DEFAULT_SCENE.affordancesFor, affordancesFor);
  assert.equal(DEFAULT_SCENE.actuate, actuate);
  assert.equal(DEFAULT_SCENE.validate, validate);
});

test('缺字段必须点名失败（契约能变红）', () => {
  const broken = { ...DEFAULT_SCENE };
  delete broken.actuate;
  delete broken.scheduledLoc;
  assert.throws(() => assertScene(broken, 'broken'), /actuate, scheduledLoc/);
});

test('第二个场景可独立驱动闭环：不经过 body.mjs 的房间/动作表', () => {
  const toy = {
    id: 'two-rooms',
    locs: { a: '甲院', b: '乙院' },
    kinds: {
      rest: { impulse: 0.1, cost: 0.05, label: '歇一会儿' },
      walk: { impulse: 0.2, cost: 0.08, label: '走动' },
    },
    makeWorld: () => ({ t: 0, loc: {}, occupancy: { a: [], b: [] }, pending: [], log: [], agents: {} }),
    spawn(w, id, loc) {
      w.agents[id] = { id, name: id };
      w.loc[id] = loc;
      w.occupancy[loc].push(id);
    },
    move(w, id, to) {
      w.occupancy[w.loc[id]] = w.occupancy[w.loc[id]].filter((x) => x !== id);
      w.loc[id] = to;
      w.occupancy[to].push(id);
    },
    perceptsAt: () => [],
    affordancesFor(w, id) {
      const here = w.loc[id];
      return [
        { id: 'rest', kind: 'rest', cost: 0.05, impulse: 0.1, serves: {} },
        { id: `walk:${here === 'a' ? 'b' : 'a'}`, kind: 'walk', to: here === 'a' ? 'b' : 'a', cost: 0.08, impulse: 0.2, serves: {} },
      ];
    },
    actuate(w, id, act) {
      if (act.kind === 'walk') {
        toy.move(w, id, act.to);
        w.log.push({ t: w.t, kind: 'walk', to: act.to });
      } else {
        w.log.push({ t: w.t, kind: 'rest' });
      }
      return { ok: true, code: 'OK', observation: act.kind, amount: 0.1, evt: { kind: act.kind } };
    },
    validate(w, id, intent) {
      if (!toy.kinds[intent?.kind]) return { ok: false, code: 'NOT_AN_ACTION', why: intent?.kind };
      if (intent.kind === 'walk' && !toy.locs[intent.to]) return { ok: false, code: 'NO_LOC', why: intent.to };
      return { ok: true, code: 'OK' };
    },
    impulseOf: (k) => toy.kinds[k]?.impulse ?? 0.5,
    // 无秘密语义的场景也要显式声明：空实现比"字段缺失"更诚实，契约因此可以统一校验
    addSecret: () => ({ id: 's0', known: new Set() }),
    scanSecrets: () => {},
    canTell: () => ({ ok: false, code: 'NO_SECRET' }),
    markKnown: (s) => s,
    actionId: (a) => a.id,
    phaseOf: () => '昼',
    dayOf: (t) => Math.floor(t / 24),
    isNight: () => false,
    schedule: {},
    scheduledLoc: () => null,
    hail: () => ({ ok: true }),
    isHailed: () => false,
  };
  assertScene(toy, 'two-rooms');

  const w = toy.makeWorld();
  toy.spawn(w, 'x', 'a');
  for (let i = 0; i < 30; i++) {
    w.t = i + 1;
    const acts = toy.affordancesFor(w, 'x');
    const pick = acts[i % acts.length];
    const v = toy.validate(w, 'x', pick);
    assert.ok(v.ok, `第 ${i} 步被自己的规则层驳回：${v.code}`);
    toy.actuate(w, 'x', pick);
  }
  assert.ok(w.log.filter((x) => x.kind === 'walk').length > 0, '二场景里没发生走动 ⇒ 闭环没真的跑');
  assert.ok(w.log.filter((x) => x.kind === 'rest').length > 0, '二场景里没休息过 ⇒ 只走了单一路径');
  assert.deepEqual(Object.keys(w.occupancy).sort(), ['a', 'b']);
});

test('变体只覆盖差异项，其余沿用默认场景', () => {
  const v = extendScene({ id: 'winter', locs: { home: '木屋' } });
  assert.equal(v.id, 'winter');
  assert.equal(v.locs.home, '木屋');
  assert.equal(v.actuate, DEFAULT_SCENE.actuate, '变体没沿用默认实现 ⇒ 换场景要重写全部行为');
  assert.deepEqual(SCENE_FIELDS.filter((k) => v[k] === undefined), []);
});
