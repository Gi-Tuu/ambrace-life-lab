// P1 输入解耦闸门：tick 在居民等待（模型/长决策）时，/act 与 /world 不被 tickChain 串行。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'p1-input-'));
process.env.SEED_FILE = join(ROOT, 'seed', 'world.json');
process.env.TICK_MS = '10000000';
process.env.GAME_MODE = 'game';
process.env.GAME_RULES = '1';
process.env.BRAIN = 'local';
process.env.MODEL_UNATTENDED = '0';

const { Organism } = await import('./agent.mjs');
const { host } = await import('./host.mjs');

test('P1-06 tick 内模型等待时，/act 与 /world 远早于整拍返回', async (t) => {
  await host.start();
  t.after(async () => { await host.stop(); });
  const original = Organism.prototype.tick;
  // 只拖慢居民决策（等价于慢模型/慢供应商），不改变任何世界数据。
  Organism.prototype.tick = async function slowTick(world) {
    await new Promise((resolve) => setTimeout(resolve, 450));
    return original.call(this, world);
  };
  try {
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
    const totalMs = Date.now() - started;
    assert.ok(view?.survival, '读必须返回生存快照');
    assert.equal(acted.ok, true, JSON.stringify(acted));
    assert.ok(totalMs >= 800, `这一拍应被拖慢（三居民串行），实测 ${totalMs}ms`);
    // 阈值留足 CI/并发磁盘抖动；真正的判据是"远小于整拍"而不是绝对值。
    assert.ok(readMs < totalMs / 2, `读被 tick 阻塞：${readMs}ms（整拍 ${totalMs}ms）`);
    assert.ok(actMs < totalMs / 2, `普通 act 被 tick 阻塞：${actMs}ms（整拍 ${totalMs}ms）`);
    assert.equal(host.snapshot().survival.loc.p1, 'yard');
  } finally {
    Organism.prototype.tick = original;
  }
});
