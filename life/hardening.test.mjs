// 2026-11-09 加固闸门（对应 docs/AUDIT-2026-11-09.md 的 BUG-1/2/3/4/5/6/7/13/20/23）。
// 纪律：每条闸门都必须能变红——把对应修复撤掉必须红。撤法见 test 名后的 【变红法】。
//
// 环境说明：host.mjs 在**模块加载**时就读取 DATA_DIR / TICK_MS，所以这两个 env 必须在
// `import('./host.mjs')` 之前设好；本文件用动态 import 保证这一点（与 host.test.mjs 同一做法）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeWorld, spawn, actuate, hail } from './body.mjs';
import { Relations, REL_NEUTRAL } from './relations.mjs';
import { validate } from './rules.mjs';
import { simulate } from './run.mjs';

const DIR = mkdtempSync(join(tmpdir(), 'ambrace-hardening-'));
process.env.DATA_DIR = DIR;
process.env.SEED_FILE = join(DIR, 'no-such-seed.json'); // 保持 hermetic：不吃仓库里的演示种子
const TICK = 40;
process.env.TICK_MS = String(TICK);
process.env.MAX_CALLS = process.env.MAX_CALLS ?? '120';

const { host } = await import('./host.mjs');

const SLEEP = (ms) => new Promise((r) => setTimeout(r, ms));

// 每个用例都从干净目录 + 全新世界开始。默认把定时器停掉：手工推进才可复现；
// 只有需要观察定时器行为的用例（BUG-3/BUG-4）才 keepTimer。
async function boot({ archive, keepTimer = false } = {}) {
  for (const name of readdirSync(DIR)) rmSync(join(DIR, name), { recursive: true, force: true });
  if (archive !== undefined) writeFileSync(join(DIR, 'world.json'), typeof archive === 'string' ? archive : JSON.stringify(archive), 'utf8');
  const r = await host.start();
  if (!keepTimer) host.stop();
  await host.ctl({ action: 'resume' });
  return r;
}

// ─────────────────────────── BUG-3 / BUG-4：定时器 ───────────────────────────

test('BUG-3 tick 不重入：一次 tick 超过 TICK_MS 时不得并发进入同一世界 【变红法：去掉 host.mjs 里 if (S.tickInFlight) return;】', async () => {
  await boot({ keepTimer: true });
  const a = host.packs.A.agents.a1;
  let active = 0;
  let maxActive = 0;
  const orig = a.tick.bind(a);
  a.tick = async (w) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    try {
      await SLEEP(TICK * 3); // 单次决策远慢于 TICK_MS：旧实现会让下一拍并发进来
      return await orig(w);
    } finally {
      active -= 1;
    }
  };
  await SLEEP(TICK * 16);
  host.stop();
  await SLEEP(TICK * 5); // 定时器已清，等在途那一拍跑完：A/B 只在**刻边界**上应该相等
  const s = host.snapshot();
  delete a.tick;
  assert.equal(maxActive, 1, `同时在飞 ${maxActive} 个 tick ⇒ setInterval 在上一拍没跑完时又进来了`);
  assert.equal(s.A.t, s.B.t, `A/B 刻数错位：A=${s.A.t} B=${s.B.t} ⇒ 两个世界的对照不再同刻`);
  assert.ok(s.A.t > 0, '一拍都没跑，测试没有样本');
});

test('BUG-4 tick 抛错不杀进程且可查询 【变红法：去掉 setInterval 回调上的 .catch】', async () => {
  await boot({ keepTimer: true });
  const a = host.packs.A.agents.a1;
  a.tick = async () => {
    throw new Error('BOOM-FOR-TEST');
  };
  await SLEEP(TICK * 6);
  const t1 = host.status().t;
  await SLEEP(TICK * 8);
  const t2 = host.status().t;
  const err = host.status().tickError;
  host.stop();
  delete a.tick;
  assert.ok(err && String(err).includes('BOOM-FOR-TEST'), `tickError 没有记下错误：${err}`);
  assert.ok(t2 > t1, `出错后定时器停摆了（${t1} → ${t2}）⇒ 世界静默冻结`);
});

// ─────────────────────────── BUG-7：原型键 ───────────────────────────

test('BUG-7 /act 的原型键不得改世界 【变红法：把 host.act 的 Object.hasOwn 校验换回 (w.locs ?? LOCS)[body.room] 真值判断】', async () => {
  await boot();
  const before = host.snapshot().A.loc.p1;
  for (const room of ['__proto__', 'toString', 'constructor', 'hasOwnProperty', '']) {
    const r = await host.act({ kind: 'move', room });
    assert.equal(r.ok, false, `room=${JSON.stringify(room)} 竟然被接受`);
    assert.equal(r.error, 'NO_LOC', `room=${JSON.stringify(room)} 的错误码是 ${r.error}`);
    const now = host.snapshot().A.loc.p1;
    assert.equal(now, before, `room=${JSON.stringify(room)} 把玩家位置改成了 ${now}`);
    assert.equal(Object.hasOwn(host.packs.A.world.occupancy, '__proto__'), false, 'occupancy 被写进了原型键');
  }
  for (const target of ['__proto__', 'toString']) {
    const r = await host.act({ kind: 'hail', target });
    assert.equal(r.ok, false, `hail target=${target} 竟然被接受`);
    assert.equal(r.error, 'NO_TARGET');
  }
  // 正控：合法房间仍然走得通（不然这条闸门会把功能一起锁死）
  const ok = await host.act({ kind: 'move', room: 'store' });
  assert.equal(ok.ok, true);
  assert.equal(host.snapshot().A.loc.p1, 'store');

  // 同族：/ctl mask 的键也必须只认自有属性（`'toString' in {}` 恒为 true）
  for (const key of ['__proto__', 'toString', 'constructor']) {
    const r = await host.ctl({ action: 'mask', key, on: true });
    assert.equal(r.ok, false, `mask key=${key} 竟然被接受`);
    assert.equal(r.error, 'UNKNOWN_MASK');
    assert.equal(Object.hasOwn(host.snapshot().masks, key), false, `masks 被写进了 ${key}`);
    assert.equal(host.snapshot().masks.m3, false, '非法 key 仍然触发了 mask 变更');
  }
});

// ─────────────────────────── BUG-6：起点快照 ───────────────────────────

test('BUG-6 切开关必须回到干净的会话起点 【变红法：把 buildPacks 里的 structuredClone 去掉、直接传 S.startRaw.A】', async () => {
  await boot();
  for (let i = 0; i < 5; i++) await host.tickOnce();
  const before = host.snapshot();
  assert.ok(before.A.stat.决策 > 0, '前 5 刻没有产生决策，测试没有样本');
  assert.equal(before.A.series.length, 5);

  const r = await host.ctl({ action: 'mask', key: 'm3', on: true });
  assert.equal(r.ok, true);
  const after = host.snapshot();
  assert.equal(after.A.t, 0, `t 没回到起点：${after.A.t}`);
  assert.equal(after.B.t, 0);
  assert.equal(after.A.stat.决策, 0, `stat 被上一局污染：决策=${after.A.stat.决策} ⇒ startRaw 与活世界共享引用`);
  assert.equal(after.A.series.length, 0, `series 被上一局污染：${after.A.series.length} 行`);
  assert.equal(after.A.series.filter((x) => x.t > after.A.t).length, 0, 'series 里混进了"未来"的刻度');

  // 幂等：连切两次结果一致（回放不能累积）
  await host.ctl({ action: 'mask', key: 'm3', on: false });
  await host.ctl({ action: 'mask', key: 'm3', on: true });
  const again = host.snapshot();
  assert.equal(again.A.t, 0);
  assert.equal(again.A.stat.决策, 0);
  assert.equal(again.A.series.length, 0);

  // 关键一步：**重放之后再推进几刻**，然后再切一次。
  // 如果 buildPacks 只是把起点快照的 log/series/stat 按引用挂上去（而不是深拷贝），
  // 这几刻的写入就会反灌回起点快照，第二次切开关时污染会冒出来。
  // （只做"切一次看干净不干净"是抓不到这个方向的：那是"装载时没被污染"，不是"起点没被后续写污染"。）
  for (let i = 0; i < 3; i++) await host.tickOnce();
  await host.ctl({ action: 'mask', key: 'm3', on: false });
  await host.ctl({ action: 'mask', key: 'm3', on: true });
  const third = host.snapshot();
  assert.equal(third.A.t, 0, `重放后被反灌：t=${third.A.t}`);
  assert.equal(third.A.stat.决策, 0, `重放后被反灌：stat.决策=${third.A.stat.决策} ⇒ 起点快照被后续写污染`);
  assert.equal(third.A.series.length, 0, `重放后被反灌：series=${third.A.series.length} 行`);
  await host.ctl({ action: 'mask', key: 'm3', on: false });
});

// ─────────────────────────── BUG-5：坏档隔离 ───────────────────────────

test('BUG-5 坏档必须隔离留底，不得被下一次保存覆盖 【变红法：把 start() 里的 rename 隔离与 packsFrom 副本装载撤掉】', async () => {
  // loc=null 会让 applyInto 在 Object.entries(d.world.loc) 处抛 TypeError，
  // 是"合法 JSON、结构损坏"的典型形状（真实现场是越界的 m3.remaining）。
  const bad = { savedAt: Date.now(), seed: 7, model: {}, A: { condition: 'C2', world: { t: 777, loc: null } }, B: { condition: 'C2-neg', world: { t: 777, loc: null } } };
  const badBytes = JSON.stringify(bad);
  const { note } = await boot({ archive: badBytes });

  assert.match(note, /损坏|隔离/, `note 没有说明坏档：${note}`);
  const quarantined = readdirSync(DIR).filter((n) => n.startsWith('world.corrupt-'));
  assert.equal(quarantined.length, 1, `隔离文件数 = ${quarantined.length}`);
  assert.equal(readFileSync(join(DIR, quarantined[0]), 'utf8'), badBytes, '隔离出来的不是原始坏档');

  // 新世界必须是新建的，而不是半载入的 t=777
  assert.equal(host.snapshot().A.t, 0, `新世界的 t=${host.snapshot().A.t} ⇒ 坏档被半载入了`);

  // 再存一次也不能把坏档盖掉
  await host.save();
  assert.equal(readFileSync(join(DIR, quarantined[0]), 'utf8'), badBytes, '下一次 save 覆盖了隔离出来的坏档');
  assert.equal(readdirSync(DIR).filter((n) => n.startsWith('world.corrupt-')).length, 1);
});

// ─────────────────────────── BUG-23：暂停 + 单步 ───────────────────────────

test('BUG-23 暂停时的"单步"必须真的推进一刻 【变红法：把 ctl 的 tick(true) 改回 tick()】', async () => {
  await boot();
  await host.ctl({ action: 'pause' });
  const t0 = host.snapshot().A.t;
  await SLEEP(TICK * 3);
  assert.equal(host.snapshot().A.t, t0, '暂停状态下世界仍在推进');
  const r = await host.ctl({ action: 'step' });
  assert.equal(r.ok, true);
  assert.equal(host.snapshot().A.t, t0 + 1, `单步没有推进：${t0} → ${host.snapshot().A.t}`);
  await host.ctl({ action: 'resume' });
});

// ─────────────────────────── BUG-2：trade 守恒 ───────────────────────────

function townWorld() {
  const w = makeWorld({ pantries: 3, preset: 'town', seed: 7, socialGossip: 1 });
  w.agents = {};
  for (const id of ['a1', 'a2', 'a3', 'a4', 'a5']) {
    w.agents[id] = { id, name: id.toUpperCase(), relations: new Relations(id) };
    spawn(w, id, id === 'a2' || id === 'a5' ? 'home' : 'hall');
  }
  w.t = 10;
  return w;
}

test('BUG-2 trade 不得凭空消灭库存 【变红法：把 body.mjs 的 stash[other] = theirStash + 1 改回 = 1】', () => {
  // 给方：a1 有 6 份，a2 有 1 份 ⇒ a1 给 a2 一份，总量必须守恒且 a2 变成 2
  const w1 = townWorld();
  w1.loc.a1 = 'hall'; w1.loc.a2 = 'hall';
  w1.stash.a1 = 6; w1.stash.a2 = 1;
  const r1 = actuate(w1, 'a1', { id: 'trade:a2', kind: 'trade', target: 'a2' });
  assert.equal(r1.ok, true, `trade 没成立：${r1.code}`);
  assert.equal(w1.stash.a1 + w1.stash.a2, 7, `总量 ${w1.stash.a1 + w1.stash.a2} ≠ 7 ⇒ 库存凭空蒸发`);
  assert.equal(w1.stash.a2, 2, `受助方手里 ${w1.stash.a2} 份（应为原有的 1 份 + 1）`);

  // 收方：a1 有 1 份，a2 有 6 份 ⇒ a1 要一份，a1 变 2、a2 变 5
  const w2 = townWorld();
  w2.loc.a1 = 'hall'; w2.loc.a2 = 'hall';
  w2.stash.a1 = 1; w2.stash.a2 = 6;
  const r2 = actuate(w2, 'a1', { id: 'trade:a2', kind: 'trade', target: 'a2' });
  assert.equal(r2.ok, true, `trade 没成立：${r2.code}`);
  assert.equal(w2.stash.a1 + w2.stash.a2, 7, `总量 ${w2.stash.a1 + w2.stash.a2} ≠ 7 ⇒ 库存凭空蒸发`);
  assert.equal(w2.stash.a1, 2, `求济方手里 ${w2.stash.a1} 份（应为原有的 1 份 + 1）`);
});

// ─────────────────────────── BUG-13：规范罚的范围 ───────────────────────────

test('BUG-13 群体规范的信任罚只能落在目击者身上 【变红法：把 body.mjs 的 for (const w of crowd) 改回 Object.keys(world.agents)】', () => {
  const w = townWorld();
  w.loc.a1 = 'hall'; w.loc.a2 = 'home'; // 受害者 a2 不在场 ⇒ 不触发 WITNESSED
  w.occupancy.hall = ['a1', 'a3', 'a4']; // a3/a4 当场目击（≥2 人）
  w.occupancy.home = ['a2', 'a5'];
  w.stash.a2 = 2;
  w.t = 10;
  const before = (id) => w.agents[id].relations.get('a1').trust;
  const t3 = before('a3'); const t4 = before('a4'); const t5 = before('a5');
  assert.equal(t3, REL_NEUTRAL.trust);

  const r = actuate(w, 'a1', { id: 'take_shared:a2', kind: 'take_shared', target: 'a2' });
  assert.equal(r.ok, true);
  assert.equal((w.normLog ?? []).length, 1, '规范事件没有记下来');
  assert.equal(before('a3'), t3 - 1, '目击者应当 −1');
  assert.equal(before('a4'), t4 - 1, '目击者应当 −1');
  assert.equal(before('a5'), t5, '不在场、也没结伴的人不该被罚');
});

// ─────────────────────────── BUG-20：hail 的 ticks ───────────────────────────

test('BUG-20 hail 的 ticks 不得把 Infinity/NaN 写进世界 【变红法：把 hail 的 Number.isFinite 校验与 [1,60] 钳制撤掉】', () => {
  const w = townWorld();
  w.t = 10;
  assert.equal(hail(w, 'a1', Infinity).ok, false, 'Infinity 竟然被接受（目标会永远不换地方）');
  assert.equal(hail(w, 'a1', NaN).ok, false, 'NaN 竟然被接受（静默无效但返回 ok）');
  const r = hail(w, 'a1', 999);
  assert.equal(r.ok, true);
  assert.ok(r.until - w.t <= 60, `ticks=999 得到 ${r.until - w.t} 刻，超过 60 的上界`);
  const r3 = hail(w, 'a1', 3);
  assert.equal(r3.until - w.t, 3, '正常档被钳制改坏了');
});

// ─────────────────────────── BUG-1：驳回重试的合法性 ───────────────────────────

test('BUG-1 驳回重选后仍非法则本刻不得执行 【变红法：删掉 agent.mjs 里重选后再 validate 的那一段】', async () => {
  // 让审议层故意挑一个规则层会拒绝的动作：第一次挑非法 → 被驳回 → 重选又挑非法。
  const delib = async ({ world, agent, paths }) => {
    const bad = paths.find((p) => !validate(world, agent.id, p).ok);
    return bad ? { id: bad.id } : null;
  };
  const { agents } = await simulate({ seed: 7, ticks: 60, condition: 'C2', pantry: 0, stash: 0, deliberator: delib });
  const rows = Object.values(agents).flatMap((a) => a.trace);
  const rejected = rows.filter((r) => r.layer === 'rejected');
  const aborted = rows.filter((r) => r.layer === 'aborted');
  assert.ok(rejected.length > 0, '一次驳回都没发生 ⇒ 这条闸门没有样本');
  assert.ok(aborted.length > 0, '从未出现"重选后仍非法" ⇒ 闸门没测到这次修复（样本不足）');

  for (const r of aborted) {
    // 同一刻、同一角色，除 trace 自身的 rejected/aborted 记账行外，不得有任何带 action 的行
    const sameTick = rows.filter((x) => x.t === r.t && x.id === r.id && x.action && x.layer !== 'rejected' && x.layer !== 'aborted');
    assert.equal(sameTick.length, 0, `第 ${r.t} 刻重选出的非法动作 ${r.to} 仍然被执行了（layer=${sameTick[0]?.layer}）`);
  }
});

// ═══════════════════ 第二次审计的修复闸门（2026-11-09 第二批）═══════════════════

test('R1 习惯层必须过规则层：夜里不许再执行 look_out 【变红法：把 agent.mjs 的 habitLegal 条件去掉】', async () => {
  const { Organism } = await import('./agent.mjs');
  const w = makeWorld({ pantries: 3, stash: 3, preset: 'lab', seed: 7 });
  const a = new Organism({ id: 'a1', name: '岑', archetype: '谨慎', seed: 1, condition: 'C2' });
  w.agents.a1 = a;
  spawn(w, 'a1', 'home');
  w.t = 20; // 夜：validate 对 look_out 返回 LOCKED_HOUR
  for (let i = 0; i < 6; i++) a.habit.observe('look_out', 2.0); // 把习惯强度喂高，足以触发习惯抢先
  assert.equal(validate(w, 'a1', { id: 'look_out', kind: 'look_out' }).ok, false, '前提不成立：夜里 look_out 竟然是合法的');
  const locBefore = w.loc.a1;
  await a.tick(w);
  const illegalAct = a.trace.filter((r) => r.action === 'look_out');
  assert.equal(illegalAct.length, 0, `习惯层执行了非法 look_out ⇒ 规则层不是唯一裁决者（loc ${locBefore}→${w.loc.a1}）`);
  // 非法捷径被挡掉之后，这一拍会落到审议层并选一个**合法**动作（实测是 move_to:hall）。
  // 所以只断言"没有去瞭台"，不能断言位置不变——位置本来就可以被合法动作改变。
  assert.notEqual(w.loc.a1, 'watch', `角色仍然去了瞭台（loc=${w.loc.a1}）`);
});

test('R1b execute 是结构性兜底：非法动作不得消耗任何资源 【变红法：删掉 execute 入口的 validate】', async () => {
  const { Organism } = await import('./agent.mjs');
  const w = makeWorld({ pantries: 0, stash: 3, preset: 'lab', seed: 7 });
  const a = new Organism({ id: 'a1', name: '岑', archetype: '谨慎', seed: 1, condition: 'C2' });
  w.agents.a1 = a;
  spawn(w, 'a1', 'home');
  w.t = 5;
  const vBefore = a.viab.v;
  const actionsBefore = a.counters.actions;
  const r = a.execute(w, { id: 'eat', kind: 'eat', cost: 0.05 }, 'deliberation', w.t, true);
  assert.equal(r, null, '空公仓的 eat 竟然被执行了');
  assert.equal(a.viab.v, vBefore, '非法动作仍然扣了存续');
  assert.equal(a.counters.actions, actionsBefore, '非法动作仍然计了动作数');
  assert.equal((a.counters.refused ?? 0), 1, '没有记 refused 计数');
});

test('R8 侵蚀后的信任上限必须被常规路径尊重 【变红法：把 agent.mjs 的 bumpRel 换回直接写 trust】', async () => {
  const { Organism } = await import('./agent.mjs');
  const w = makeWorld({ pantries: 3, stash: 3, preset: 'lab', seed: 7 });
  const a = new Organism({ id: 'a1', name: '岑', archetype: '谨慎', seed: 1, condition: 'C2' });
  w.agents.a1 = a;
  spawn(w, 'a1', 'home');
  a.world = w;
  a.bumpRel('a2', 45, 0.5);
  a.relations.erode(0.75); // 削"关系维护"：ceiling 100 → 75
  assert.equal(a.relations.ceiling, 75);
  for (let i = 0; i < 8; i++) a.assess({ kind: 'contact', about: 'a2', valence: 0.4 }, 'talk', true);
  assert.ok(a.relations.get('a2').trust <= a.relations.ceiling, `信任 ${a.relations.get('a2').trust} 越过了被侵蚀的上限 ${a.relations.ceiling} ⇒ 不可逆降级可逆`);
});

test('R3 归因表必须闭合：parts.total = Σ 已命名分量（含常数偏移） 【变红法：把 model.mjs 的 常数偏移 项去掉】', async () => {
  const { agents } = await simulate({ seed: 7, ticks: 300, condition: 'C2' });
  let rows = 0;
  let worst = 0;
  for (const a of Object.values(agents)) {
    for (const r of a.trace) {
      if (!r.action || !r.parts) continue;
      rows++;
      const sum = Object.entries(r.parts).filter(([k]) => k !== 'total').reduce((s, [, v]) => s + v, 0);
      worst = Math.max(worst, Math.abs((r.parts.total ?? 0) - sum));
    }
  }
  assert.ok(rows > 100, `样本不足（${rows} 行）`);
  // 每个分量各自 toFixed(3)，6–8 项最多累计 ~0.004；超过 0.01 就说明还有项没入账
  assert.ok(worst < 0.01, `parts.total 与已命名分量之和最大差 ${worst.toFixed(4)} ⇒ 归因表仍有未命名的项`);
});

test('H-25 结构不完整的档必须被识破，不许谎称"载入存档 t=0" 【变红法：删掉 loadArchive 的形状校验】', async () => {
  const { note } = await boot({ archive: '{}' });
  assert.match(note, /结构不完整|无法装载/, `note 谎报载入成功：${note}`);
  assert.equal(host.snapshot().A.t, 0);
});

test('H-08 并发 step 必须串行：t 只能推进请求的次数 【变红法：把 ctl step 改回 tick(true) 绕过锁】', async () => {
  await boot();
  const t0 = host.snapshot().A.t;
  await Promise.all([host.ctl({ action: 'step' }), host.ctl({ action: 'step' }), host.ctl({ action: 'step' })]);
  const t1 = host.snapshot().A.t;
  assert.equal(t1 - t0, 3, `3 次 step 推进了 ${t1 - t0} 刻 ⇒ 有并发写世界`);
  assert.equal(host.snapshot().A.t, host.snapshot().B.t, 'A/B 刻数错位');
});

test('D2 记忆落盘窗口必须与运行期一致（重启不丢 70%）【变红法：把 memory.dump 的 400 改回 120】', async () => {
  const { EpisodicMemory } = await import('./memory.mjs');
  const m = new EpisodicMemory();
  for (let i = 0; i < 300; i++) m.add(i, { kind: i === 0 ? 'rare' : 'eat', actionKind: null, payload: 'x', mSnapshot: {}, importance: 0.5 });
  const beforeFreq = m.frequency('rare', 299, 400);
  const back = new EpisodicMemory();
  back.load(m.dump());
  assert.equal(back.rows.length, 300, `往返后只剩 ${back.rows.length} 行`);
  assert.equal(back.frequency('rare', 299, 400), beforeFreq, '往返后频率统计变了 ⇒ 重启改变了评价层的意外性分量');
  assert.equal(back.nextId, m.nextId, 'nextId 不连续 ⇒ 会撞号');
});

test('D8 合法档不得因参数变更被当坏档丢弃 【变红法：把 m3-planner.load 的 remaining 钳制改回 throw】', async () => {
  const { ShortHorizonPlanner } = await import('./m3-planner.mjs');
  const p = new ShortHorizonPlanner({ commitment: 3 });
  p.load({ state: { goal: 'recover' }, remaining: 3 }); // 旧档 remaining=3 + 现在 commitment=3
  assert.equal(p.state.goal, 'recover', '承诺状态被丢弃');
  assert.ok(p.remaining >= 0 && p.remaining < p.commitment, `remaining=${p.remaining} 没被夹进 [0, commitment)`);
  // 真正非法的数据仍然要抛错（不许静默吞）
  assert.throws(() => p.load({ state: { goal: 'nonsense' }, remaining: 1 }), '未知 goal 竟然被静默接受');
});

// ═══════════════ 第三批：状态机 / 持久化 / 派生数据（2026-11-09）═══════════════

test('H-31 start() 必须复位上一会话的 running/missed/masks/tickError 【变红法：删掉 start() 开头那段归零】', async () => {
  await boot();
  await host.ctl({ action: 'pause' });
  await host.ctl({ action: 'catchup', minutes: 30 });
  await host.ctl({ action: 'mask', key: 'm3', on: true });
  await host.start(); // 不先 stop：模拟"同一进程里重新起世界"
  host.stop();
  const s = host.snapshot();
  assert.equal(s.running, true, '重启后世界仍是暂停状态 ⇒ 定时器空转，页面点"运行"也没用');
  assert.equal(s.missed.applied, 0, `重启后还挂着上一次的补时读数 ${s.missed.applied} 分钟`);
  assert.deepEqual(s.masks, { m3: false, coupling: false }, '重启后演示开关没有回到默认关');
});

test('H-12 重复 start() 不得留下孤儿定时器 【变红法：删掉 start() 里的 clearInterval】', async () => {
  await boot({ keepTimer: true });
  await host.start(); // 第二次 start：旧版会留下一个孤儿 interval
  host.stop();        // 只停掉最后一个
  const t0 = host.snapshot().A.t;
  await SLEEP(TICK * 6);
  assert.equal(host.snapshot().A.t, t0, `stop() 之后世界仍在推进（${t0} → ${host.snapshot().A.t}）⇒ 有孤儿定时器`);
  host.stop();
});

test('H-33 存档字段类型非法（t 是字符串）必须被识破 【变红法：把 loadArchive 的 badT 校验去掉】', async () => {
  const bad = { savedAt: Date.now(), A: { world: { t: '777' } }, B: { world: { t: 777 } } };
  const { note } = await boot({ archive: bad });
  assert.match(note, /结构不完整|字段类型非法|无法装载/, `t 是字符串却被当成合法档：${note}`);
  assert.equal(host.snapshot().A.t, 0);
});

test('D10 每次存档要留一份 .bak 【变红法：删掉 save() 里 rename(f, f.bak) 那一行】', async () => {
  await boot();
  const f = join(DIR, 'world.json');
  for (let i = 0; i < 10; i++) await host.tickOnce(); // 第 10 刻触发一次 save
  assert.equal(existsSync(f), true, '第一次 save 没写出 world.json');
  const first = readFileSync(f, 'utf8');
  for (let i = 0; i < 10; i++) await host.tickOnce(); // 再 10 刻，第二次 save
  const bak = `${f}.bak`;
  assert.equal(existsSync(bak), true, '第二次 save 没有留下 .bak ⇒ 坏档时无法回到上一个存档点');
  assert.equal(readFileSync(bak, 'utf8'), first, '.bak 不是上一份存档');
});

test('BUG-12 读档必须沿用存档里的 occupancy 顺序 【变红法：把 applyInto 里的 occUsable 分支去掉、永远重建】', async () => {
  const archive = {
    savedAt: Date.now(), seed: 7, model: {},
    A: { condition: 'C2', world: { t: 40, preset: 'town', loc: { a1: 'home', a2: 'hall', a3: 'watch', p1: 'hall' }, occupancy: { home: ['a1'], hall: ['p1', 'a2'], watch: ['a3'] }, stash: { p1: 0, a1: 3, a2: 3, a3: 3 }, expect: { p1: 0, a1: 3, a2: 3, a3: 3 }, pantry: 3, coins: {}, secrets: [] } },
    B: { condition: 'C2-neg', world: { t: 40, preset: 'town', loc: { a1: 'home', a2: 'hall', a3: 'watch', p1: 'hall' }, occupancy: { home: ['a1'], hall: ['p1', 'a2'], watch: ['a3'] }, stash: { p1: 0, a1: 3, a2: 3, a3: 3 }, expect: { p1: 0, a1: 3, a2: 3, a3: 3 }, pantry: 3, coins: {}, secrets: [] } },
  };
  await boot({ archive });
  assert.deepEqual(host.snapshot().A.occupancy.hall, ['p1', 'a2'], '读档后同屋顺序被重建改了 ⇒ 感知/候选顺序随重启分叉');
});

test('BUG-16 耦合状态 hold 归零后必须回弹（坏档/τ=0 不留永久态）【变红法：删掉 coupling.tick 的 else-if 分支】', async () => {
  const { Coupling } = await import('./coupling.mjs');
  const c = new Coupling({ tau: 0 });
  c.apply('seclude'); // tau=0 ⇒ hold=0，v.available 变成 0
  c.tick(1);
  assert.equal(c.v.available, 1, `hold=0 之后 available 仍是 ${c.v.available} ⇒ 角色永远叫不到`);
  c.v.refuse = 1; // 模拟坏档 restore
  c.hold.refuse = 0;
  c.tick(1);
  assert.equal(c.v.refuse, 0, 'hold=0 但值停在非默认 ⇒ 没有自愈');
});

test('B3 expect 缺失不得凭空造出「私藏超额」秘密 【变红法：把 expect 的兜底改回 ?? 3】', async () => {
  const { scanSecrets } = await import('./body.mjs');
  const w = makeWorld({ pantries: 3, stash: 3, preset: 'town', seed: 7 });
  spawn(w, 'a1', 'home');
  w.stash.a1 = 18; // 旧档常见：stash 很大但 expect 缺失
  delete w.expect.a1;
  scanSecrets(w);
  assert.equal((w.secrets ?? []).filter((s) => s.kind === 'hoard').length, 0, 'expect 缺失时把 stash 当成了"超出预期"⇒ 幻影套利事实');
});

test('D4 当天的账随档走（反思不再从 trace 现算）【变红法：把 dayTally 从 serialize/applyInto 里去掉】', async () => {
  await boot();
  for (let i = 0; i < 30; i++) await host.tickOnce();
  const before = host.snapshot().A.agents.a1;
  const tally = host.packs.A.agents.a1.dayTally;
  assert.ok(tally.decisions > 0, '当天的账没有累积（dayTally.decisions=0）');
  await host.save();
  const saved = tally.decisions;
  await host.start(); // 读档
  host.stop();
  assert.equal(host.packs.A.agents.a1.dayTally.decisions, saved, '读档后当天的账清零 ⇒ 反思会把"做了 N 个决定"写成很小的数');
});

test('D6 评价注入队列 bank.pending 随档走 【变红法：把 bankPending 从 serialize/applyInto 里去掉】', async () => {
  await boot();
  const a = host.packs.A.agents.a1;
  a.bank.pending.arousal = 0.05;
  a.bank.pending.inhibit = -0.03;
  await host.save();
  await host.start();
  host.stop();
  const p = host.packs.A.agents.a1.bank.pending;
  assert.ok(Math.abs((p.arousal ?? 0) - 0.05) < 1e-9, `pending.arousal 没随档走（${p.arousal}）`);
  assert.ok(Math.abs((p.inhibit ?? 0) + 0.03) < 1e-9, `pending.inhibit 没随档走（${p.inhibit}）`);
});
