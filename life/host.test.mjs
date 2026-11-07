// 服务端持久化 / 休眠补时 / 重置。这几条是用户看得见的路径，只有真跑一遍才算验过：代码在 ≠ 走得到。
// DATA_DIR 必须在 import host 之前设好——host 在模块加载时就把它读成常量。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, statSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'ambrace-host-'));
process.env.DATA_DIR = DIR;
process.env.SEED_FILE = join(DIR, 'no-seed.json'); // 其余测试保持 hermetic：不吃仓库里的演示种子
const CAP = Number(process.env.CATCHUP_CAP_MIN ?? 360);
const PROD = resolve(process.cwd(), 'data', 'world.json');

const { host, budgetTick, observerActive } = await import('./host.mjs');
const snap = () => host.snapshot();

test('存档只落在 DATA_DIR，不碰真实 ./data', async () => {
  const prodBefore = existsSync(PROD) ? statSync(PROD).mtimeMs : null;
  await host.start();
  host.stop();
  await host.ctl({ action: 'reset' }); // reset 内部会 await save()
  assert.ok(existsSync(join(DIR, 'world.json')), `临时目录里没有 world.json ⇒ host 没按 DATA_DIR 落盘，重定向没生效`);
  if (prodBefore !== null) assert.equal(statSync(PROD).mtimeMs, prodBefore, '测试改写了真实存档的 mtime ⇒ 生产状态被碰了');
});

test('重置会归零：世界回到起点，补时横幅也不能留着', async () => {
  const fresh = snap();
  await host.ctl({ action: 'catchup', minutes: 45 });
  assert.equal(host.status().missed.minutes, 45, '补时之后横幅没记上分钟数');
  await host.ctl({ action: 'reset' });
  const st = host.status();
  assert.equal(st.t, 0, '重置后世界刻度没归零');
  assert.equal(st.missed.minutes, 0, '重置后还挂着「休眠 N 分钟后醒来」——那句话描述的是已经被丢掉的世界');
  assert.equal(st.missed.applied, 0, '重置后 applied 没清零');
  const after = snap();
  assert.equal(after.A.pantry, fresh.A.pantry, '重置后配给数与新建世界不一致');
  assert.deepEqual(Object.values(after.A.stat).map((x) => (typeof x === 'number' ? x : 0)), Object.values(fresh.A.stat).map((x) => (typeof x === 'number' ? x : 0)), '重置后统计计数没回到新建值');
});

test('存续曲线随存档走：重启后"谁先垮"那段历史不能凭空消失', async () => {
  await host.ctl({ action: 'reset' });
  for (let i = 0; i < 12; i++) await host.tickOnce();
  const before = host.packs.A.series;
  assert.ok(before.length >= 10, `跑了 12 刻只采到 ${before.length} 个点 ⇒ 采样钩子没接上 tick()`);
  assert.ok(Object.keys(before[before.length - 1].v).length === 3, '曲线里缺某个个体的读数 ⇒ 画不出"谁先垮"');
  await host.save();
  await host.start();
  host.stop();
  const after = host.packs.A.series;
  assert.equal(after.length, before.length, `重启后曲线长度 ${before.length} → ${after.length} ⇒ 存档没带 series`);
  assert.equal(JSON.stringify(after[after.length - 1]), JSON.stringify(before[before.length - 1]), '重启后最后一个采样点变了 ⇒ 曲线被重启后的新读数覆盖');
});

test('L13 的不可逆损失必须活过重启：账本与受损状态从存档回来', async () => {
  await host.ctl({ action: 'reset' });
  const a1 = host.packs.A.agents.a1;
  const intactBefore = JSON.stringify(a1.viab.usage());
  a1.viab.v = 0.4; // 直接跌过第一档：这里要验的是"损失能不能持久"，不是"能不能饿到"
  const fired = a1.viab.check();
  assert.ok(fired, '跌破阈值没触发侵蚀 ⇒ 后面谈不上持久化');
  const saved = { ledger: a1.viab.ledger.length, stage: a1.viab.stage, v: a1.viab.v };
  assert.ok(saved.ledger === 1 && saved.stage === 1, `掉一档应记 1 笔、计 1 档，实测 ${JSON.stringify(saved)}`);
  await host.save();
  await host.start(); // 等价于重启进程：重新从 DATA_DIR 读档
  host.stop();
  const b1 = host.packs.A.agents.a1;
  assert.equal(b1.viab.ledger.length, saved.ledger, '重启后账本条数变了 ⇒ 不可逆损失没有真的持久');
  assert.equal(b1.viab.stage, saved.stage, '重启后掉档计数归零 ⇒ 同一个部件可以被反复侵蚀，损失次数会被虚报');
  assert.equal(JSON.stringify(b1.viab.usage()), intactBefore, `重启后部件完整度回到受损前（${intactBefore} → ${JSON.stringify(b1.viab.usage())}）⇒ "想不起来的记忆"复活了`);
});

test('补时只补慢过程，不补决策；超过上限要如实标截断', async () => {
  await host.ctl({ action: 'reset' });
  const before = snap();
  const e0 = before.A.agents.a1.drives.energy;
  const d0 = before.A.stat.决策;
  await host.ctl({ action: 'catchup', minutes: 10 });
  const after = snap();
  assert.ok(e0 - after.A.agents.a1.drives.energy > 0.05, `补了 10 分钟，能量却几乎没降（${e0} → ${after.A.agents.a1.drives.energy}）⇒ 补时没接到需求层`);
  assert.equal(after.A.stat.决策, d0, '补时把决策也补进去了 ⇒ 世界在替角色编造没发生过的行为');
  assert.equal(after.A.t, before.A.t, '补时推进了世界刻度（真实时间不该等于模拟决策数）');
  const big = await host.ctl({ action: 'catchup', minutes: CAP + 40 });
  assert.equal(big.missed.capped, true, '超过截断上限却没标 capped');
  assert.equal(big.missed.applied, CAP, `实际补时 ${big.missed.applied} 不等于上限 ${CAP}`);
});

test('有观众才上真模型：在场窗口内允许，超时与从未访问都必须退替身', () => {
  const now = 1_000_000;
  assert.equal(observerActive(now - 1000, now, 180000), true, '刚有人访问却不让调 ⇒ 真模型接不上');
  assert.equal(observerActive(now - 200000, now, 180000), false, '超过在场窗口仍调用 ⇒ 无人观看也在烧额度');
  assert.equal(observerActive(0, now, 180000), false, '从未有人访问却允许调用 ⇒ 服务一启动就开始烧钱');
});

test('每日预算：同日不重置，跨天归零（魔粒按天回血，预算必须同节奏）', () => {
  const m = { calls: 60, tokens: 900, attempts: ['HTTP 402'], dayKey: '2026-11-07' };
  budgetTick(m, '2026-11-07');
  assert.equal(m.calls, 60, '同一天把预算重置了 ⇒ 一天内会被重复放行，烧钱无上限');
  budgetTick(m, '2026-11-08');
  assert.equal(m.calls, 0, '跨天后预算没归零 ⇒ 额度用完就永久停摆，与签到回血节奏不符');
  assert.equal(m.tokens, 0);
  assert.deepEqual(m.attempts, []);
  assert.equal(m.dayKey, '2026-11-08');
});

test('容器重建无存档时载入内置种子；连种子也没有才新建世界', async () => {
  const seedFile = resolve(process.cwd(), 'seed', 'world.json');
  const seedT = JSON.parse(readFileSync(seedFile, 'utf8')).A.world.t;
  rmSync(join(DIR, 'world.json'), { force: true });
  process.env.SEED_FILE = seedFile;
  await host.start();
  host.stop();
  assert.equal(host.status().t, seedT, `无存档重启后 t=${host.status().t} ≠ 种子 ${seedT} ⇒ 固定历史起点没接上`);
  assert.ok(Object.values(host.packs.A.agents).some((a) => a.viab.ledger.length > 0), '种子没带不可逆损失 ⇒ 开场看不到掉档历史');
  rmSync(join(DIR, 'world.json'), { force: true });
  process.env.SEED_FILE = join(DIR, 'missing.json');
  await host.start();
  host.stop();
  assert.equal(host.status().t, 0, '种子缺失时没回到新建世界 ⇒ 兜底路径坏了');
});
