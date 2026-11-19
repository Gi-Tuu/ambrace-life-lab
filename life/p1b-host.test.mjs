// P1b 宿主闸门：真实 125ms/游戏分钟调度 + 慢模型不阻塞输入 + 最终结算仍正确。
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
process.env.TICK_MS = '7500'; // 125ms/游戏分钟；30 分钟动作 = 3.75s
process.env.GAME_MODE = 'game';
process.env.GAME_RULES = '1';
process.env.BRAIN = 'local';
process.env.MODEL_UNATTENDED = '0';
process.env.V73_TEST = '1';
process.env.SAVE_EVERY = '1000000'; // 本闸门不写盘，避免磁盘抖动进入计时
process.env.CATCHUP_COOLDOWN_MS = '0';

const { host } = await import('./host.mjs');
const { Organism } = await import('./agent.mjs');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('P1b-H01 真实 125ms 调度：30 分动作 ~3.75s 完成，不等 7.5s 整拍', async (t) => {
  await host.start();
  t.after(async () => { await host.stop(); });
  const fixture = await host.ctl({ action: 'v73_fixture' });
  assert.equal(fixture.ok, true, JSON.stringify(fixture));
  const moved = await host.act({ mode: 'survival', kind: 'move', room: 'yard' });
  assert.equal(moved.ok, true, JSON.stringify(moved));
  const build = await host.act({ mode: 'survival', kind: 'build' });
  assert.equal(build.code, 'BUSY_START', JSON.stringify(build));
  assert.equal(build.endMin - (build.startMin ?? (build.endMin - 30)), 30, 'build 的时间成本是 30 游戏分钟');

  const started = Date.now();
  let doneMs = null;
  let sawBusy = false;
  let minRemain = Infinity;
  while (Date.now() - started < 8000) {
    await sleep(80);
    const view = await host.readWorld('survival');
    const busy = view?.survival?.player?.busy ?? null;
    if (busy) {
      sawBusy = true;
      minRemain = Math.min(minRemain, Number(busy.remainMin));
    } else {
      doneMs = Date.now() - started;
      break;
    }
  }
  assert.ok(sawBusy, '30 分动作必须至少被观察为 busy，不能 125ms 内一步走完');
  assert.ok(minRemain > 0, `完成前必须有剩余分钟，实测 ${minRemain}`);
  assert.ok(doneMs !== null, '30 分动作在 8s 内没有完成');
  assert.ok(doneMs >= 2500, `完成过快，说明没有按 30 游戏分钟推进：${doneMs}ms`);
  assert.ok(doneMs < 6800, `30 分动作不应等到 7.5s 整拍：${doneMs}ms`);
  const view = await host.readWorld('survival');
  assert.ok((view.survival.sites?.[0]?.progress ?? 0) > 0, '完成时必须真的结算施工');
});

test('P1b-H03 离线补时：1 真实分=480 游戏分、1 分步长；cap 仍 120 刻=7200 游戏分', async (t) => {
  await host.start();
  t.after(async () => { await host.stop(); });
  await host.ctl({ action: 'pause' });
  const before = await host.readWorld('survival');
  const one = await host.ctl({ action: 'catchup', minutes: 1, confirm: true });
  assert.equal(one.ok, true, JSON.stringify(one));
  const oneSummary = host.snapshot().missed.survival;
  assert.equal(oneSummary.appliedMinutes, 480, '默认 125ms/游戏分 ⇒ 1 真实分=480 游戏分');
  assert.equal(oneSummary.applied, 8, '480 游戏分 = 8 刻');
  assert.equal(oneSummary.capped, false);
  const mid = await host.readWorld('survival');
  assert.equal(mid.survival.t, before.survival.t + 8, '离线补时与在线同一游戏时间刻度');

  const capped = await host.ctl({ action: 'catchup', minutes: 30, confirm: true });
  assert.equal(capped.ok, true, JSON.stringify(capped));
  const capSummary = host.snapshot().missed.survival;
  assert.equal(capSummary.capMinutes, 7200, 'cap 仍按 120 刻换算成 7200 游戏分');
  assert.equal(capSummary.appliedMinutes, 7200);
  assert.equal(capSummary.applied, 120);
  assert.equal(capSummary.capped, true);
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
