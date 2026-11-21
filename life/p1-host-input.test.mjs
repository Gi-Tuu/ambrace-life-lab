// P1b 修订：P1 的旧断言是"整拍被 3×450ms 模型等待拖慢"；P1b 的目标是模型等待不进入主循环，
// 所以这里保留同一条闸门的意图（慢模型在途时输入不被堵），改成更强的"step 本身也快速返回 + 最终结算正确"。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'p1-input-'));
process.env.SEED_FILE = join(ROOT, 'seed', 'world.json');
process.env.TICK_MS = '10000000';
process.env.GAME_MS_PER_MINUTE = '10000000'; // 本闸门只测输入不被模型等待堵；世界用显式 step
process.env.GAME_MODE = 'game';
process.env.GAME_RULES = '1';
process.env.BRAIN = 'local';
process.env.MODEL_UNATTENDED = '0';

const { Organism } = await import('./agent.mjs');
const { host } = await import('./host.mjs');

test('P1-06 慢模型在途时 step/act/world 快速返回，最终 tick 结算正确', async (t) => {
  await host.start();
  t.after(async () => { await host.stop(); });
  const original = Organism.prototype.tick;
  // 只拖慢居民决策（等价于慢模型/慢供应商），不改变任何世界数据。
  Organism.prototype.tick = async function slowTick(world) {
    await new Promise((resolve) => setTimeout(resolve, 450));
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
    const acted = await host.act({ mode: 'survival', kind: 'move', room: 'yard' });
    const actMs = Date.now() - actAt;
    await step;
    const stepMs = Date.now() - started;
    assert.ok(view?.survival, '读必须返回生存快照');
    assert.equal(acted.ok, true, JSON.stringify(acted));
    // 阈值留足 CI/并发磁盘抖动；判据是“远小于 3×450ms 串行模型等待”。
    // act 会 await 一次真实落盘（persistAfterAction），Windows 并发磁盘/全量测试并行时实测出现过 688ms；
    // 900ms 仍低于一次“三角色串行模型等待”（≈1350ms），不放过原始回归。
    assert.ok(stepMs < 900, `step 被模型等待串行化：step=${stepMs}ms`);
    assert.ok(readMs < 250, `读被阻塞：${readMs}ms`);
    assert.ok(actMs < 400, `普通 act 被阻塞：${actMs}ms（一次模型等待 450ms）`);
    await new Promise((resolve) => setTimeout(resolve, 1100)); // 等慢 think 落地
    const after = await host.readWorld('survival');
    assert.equal(after.survival.t, beforeT + 1, '一次 step 仍只推进 60 游戏分钟/1 刻');
    assert.equal(host.snapshot().survival.loc.p1, 'yard');
    const errors = (after.survival.log ?? []).filter((row) => row.kind === 'agentError');
    assert.equal(errors.length, 0, `在途 think 不应产生 agentError：${JSON.stringify(errors)}`);
  } finally {
    Organism.prototype.tick = original;
  }
});
