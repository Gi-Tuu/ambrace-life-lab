// P1b 宿主闸门：6000ms/游戏分钟默认调度 + 慢模型不阻塞输入 + 最终结算仍正确。
//
// 边界（P1b 明确保留旧链）：talk_say（内部 await 模型）、camp_sleep（内嵌多拍结算）、
// compare 仍走 queueWorldWrite/tickChain，不迁到分钟调度；本文件只钉"普通输入不被居民 think 阻塞"，
// 以及这些旧链动作结束后世界仍可继续。它们不阻塞普通 /act 与 /world 的闸门见 P1-06 / P1b-H02。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'p1b-host-'));
process.env.SEED_FILE = join(ROOT, 'seed', 'world.json');
process.env.TICK_MS = '360000'; // 旧整拍：60 游戏分/刻；正式 simClock 不读它
process.env.GAME_MS_PER_MINUTE = '6000'; // 正式默认：1 游戏分=6s，1 真实分=10 游戏分
process.env.GAME_MODE = 'game';
process.env.GAME_RULES = '1';
process.env.BRAIN = 'local';
process.env.MODEL_UNATTENDED = '0';
process.env.V73_TEST = '1';
process.env.SAVE_EVERY = '1000000'; // 本闸门不写盘，避免磁盘抖动进入计时
process.env.CATCHUP_COOLDOWN_MS = '0';
process.env.CATCHUP_DAY_CAP_MIN = '2000'; // H03 要一次补到 7200 游戏分（rate=2 时 720 真实分）

const { host, campSurv } = await import('./host.mjs');
const { Organism } = await import('./agent.mjs');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('P1b-H01 正式默认 6000ms/游戏分：自动调度按分钟边界叫醒，不等旧 7.5s 整拍', async (t) => {
  await host.start();
  t.after(async () => { await host.stop(); });
  const fixture = await host.ctl({ action: 'v73_fixture' });
  assert.equal(fixture.ok, true, JSON.stringify(fixture));
  const moved = await host.act({ mode: 'survival', kind: 'move', room: 'yard' });
  assert.equal(moved.ok, true, JSON.stringify(moved));
  const build = await host.act({ mode: 'survival', kind: 'build' });
  assert.equal(build.code, 'BUSY_START', JSON.stringify(build));
  assert.equal(build.remainMin, 30, 'build 的时间成本仍是 30 游戏分钟（现实耗时变长是预期，不改游戏分钟）');

  const before = await host.readWorld('survival');
  assert.equal(before.survival.clock.msPerGameMinute, 6000, '正式默认必须是 6000ms/游戏分');
  // 不真等 30 游戏分（新节奏=180s）：把同一个 busy 缩短到 1 游戏分，再以 16× 倍速让
  // 自动调度按真实 timer 到点。倍速只改 clock.rate，不换第二套时间源。
  const sp = campSurv(null);
  const busy = sp.world.survival.actClock.p1.busy;
  assert.ok(busy, '缩时夹具必须先有 busy');
  busy.endMin = busy.startMin + 1;
  busy.totalMin = 1;
  busy.remainMin = 1;
  busy.progressMin = 0;
  const rate = await host.ctl({ action: 'rate', rate: 16 });
  assert.equal(rate.ok, true, JSON.stringify(rate));

  const started = Date.now();
  let doneMs = null;
  let sawBusy = false;
  const remains = [];
  while (Date.now() - started < 4000) {
    await sleep(50);
    const view = await host.readWorld('survival');
    const live = view?.survival?.player?.busy ?? null;
    if (live) {
      sawBusy = true;
      remains.push(Number(live.remainMin));
    } else {
      doneMs = Date.now() - started;
      break;
    }
  }
  assert.ok(sawBusy, '1 游戏分动作必须先被观察为 busy，不能瞬间跳过');
  assert.ok(remains.some((min) => min > 0), `完成前必须有剩余分钟，实测 ${JSON.stringify(remains)}`);
  assert.ok(doneMs !== null, '1 游戏分动作在 4s 内没有完成');
  assert.ok(doneMs >= 200, `完成过快，说明没有按游戏分钟推进：${doneMs}ms`);
  assert.ok(doneMs < 3500, `自动调度不应等到旧 7.5s 整拍：${doneMs}ms`);
  const view = await host.readWorld('survival');
  assert.ok((view.survival.sites?.[0]?.progress ?? 0) > 0, '完成时必须真的结算施工');
  await host.ctl({ action: 'rate', rate: 1 });
});

test('P1b-H03 离线补时：默认 1 真实分=10 游戏分、1 分步长；cap 仍 120 刻=7200 游戏分', async (t) => {
  await host.start();
  t.after(async () => { await host.stop(); });
  await host.ctl({ action: 'pause' });
  const before = await host.readWorld('survival');
  const one = await host.ctl({ action: 'catchup', minutes: 1, confirm: true });
  assert.equal(one.ok, true, JSON.stringify(one));
  const oneSummary = host.snapshot().missed.survival;
  assert.equal(oneSummary.appliedMinutes, 10, '默认 6000ms/游戏分 ⇒ 1 真实分=10 游戏分');
  assert.equal(oneSummary.applied, 0, '10 游戏分不足 1 刻，刻数不变');
  assert.equal(oneSummary.capped, false);
  const mid = await host.readWorld('survival');
  assert.equal(mid.survival.t, before.survival.t, '离线补时与在线同一游戏时间刻度（不足一刻不跳刻）');
  assert.ok(Math.abs((mid.survival.gameMinutes - before.survival.gameMinutes) - 10) <= 1,
    `游戏分钟应补约 10 分（暂停点的小数分钟会带来 <1 分差），实测 ${mid.survival.gameMinutes - before.survival.gameMinutes}`);

  // rate=2 时 720 真实分 = 14400 游戏分，超过 cap ⇒ 只补 7200 分/120 刻。
  const rate = await host.ctl({ action: 'rate', rate: 2 });
  assert.equal(rate.ok, true, JSON.stringify(rate));
  const capped = await host.ctl({ action: 'catchup', minutes: 720, confirm: true });
  assert.equal(capped.ok, true, JSON.stringify(capped));
  const capSummary = host.snapshot().missed.survival;
  assert.equal(capSummary.capMinutes, 7200, 'cap 仍按 120 刻换算成 7200 游戏分');
  assert.equal(capSummary.appliedMinutes, 7200);
  assert.equal(capSummary.applied, 120);
  assert.equal(capSummary.capped, true);
  await host.ctl({ action: 'rate', rate: 1 });
});

test('P1b-H02 慢模型在途时 step/act/world 快速返回，最终 tick 结算正确', async (t) => {
  await host.start();
  t.after(async () => { await host.stop(); });
  const original = Organism.prototype.tick;
  // 只拖慢居民决策（等价慢供应商），不改变世界数据；P1b 要求它不再堵住 tick 主循环。
  Organism.prototype.tick = async function slowTick(world) {
    await sleep(450);
    return original.call(this, world);
  };
  try {
    const before = await host.readWorld('survival');
    const beforeT = before.survival.t;
    const started = Date.now();
    const step = host.ctl({ action: 'step' });
    await new Promise((resolve) => setImmediate(resolve));
    const readAt = Date.now();
    const view = await host.readWorld('survival');
    const readMs = Date.now() - readAt;
    const actAt = Date.now();
    const acted = await host.act({ mode: 'survival', kind: 'move', room: 'hall' });
    const actMs = Date.now() - actAt;
    const returnedMs = Date.now() - started;
    await step;
    const stepMs = Date.now() - started;
    assert.ok(view?.survival, '读必须返回生存快照');
    assert.equal(acted.ok, true, JSON.stringify(acted));
    // 旧 P1 断言是“整拍被 3×450ms 拖慢”；P1b 目标改为模型等待不阻塞主循环。
    assert.ok(returnedMs < 250, `step 在慢模型在途时没有快速返回：${returnedMs}ms`);
    assert.ok(readMs < 250 && actMs < 250, `读/普通 act 被阻塞：read=${readMs}ms act=${actMs}ms`);
    assert.ok(stepMs < 400, `step 被串行模型等待拖慢：${stepMs}ms`);
    await sleep(1100); // 让在途居民 think 落地
    const after = await host.readWorld('survival');
    assert.equal(after.survival.t, beforeT + 1, '一次 step 仍只推进 60 游戏分钟/1 刻');
    const errors = (after.survival.log ?? []).filter((row) => row.kind === 'agentError');
    assert.equal(errors.length, 0, `在途 think 不应产生 agentError：${JSON.stringify(errors)}`);
  } finally {
    Organism.prototype.tick = original;
  }
});
