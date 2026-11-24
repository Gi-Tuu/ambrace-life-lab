// 1.3 幽魂 · 宿主级闸门：睡梦中死亡不能冻结世界；幽魂可观察（暂停/倍速）；刷新（重启）后仍在观察。
// 这里走的是真实 /ctl 夹具与宿主 tick 链，不是单元替身。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'ambrace-v13-ghost-'));
process.env.DATA_DIR = DIR;
process.env.SEED_FILE = join(DIR, 'none.json');
process.env.V73_TEST = '1';
process.env.GAME_MODE = 'game';
process.env.GAME_RULES = '1';
process.env.SIM_TIME = '1';
process.env.GAME_MS_PER_MINUTE = '6000';
process.env.TICK_MS = '360000';
process.env.MODEL_UNATTENDED = '0';
process.env.ACT_SAVE_COALESCE_MS = '0';

const { host } = await import('./host.mjs');
const state = async () => host.ctl({ action: 'v13_state' });
const sumActions = (st) => Object.values(st.residentActions ?? {}).reduce((a, b) => a + b, 0);

test.after(() => { host.stop(); rmSync(DIR, { recursive: true, force: true }); });

test('V13-GHOST-HOST 睡梦中饿死→睡眠当刻中断（转幽魂），世界继续 tick；观察可暂停/倍速；重启后仍在观察', async () => {
  await host.start();
  const home = await host.act({ mode: 'survival', kind: 'move', room: 'home' });
  assert.ok(home.ok, `走回家失败：${JSON.stringify(home)}`);
  // 先跑一拍，让日界账（lastDay=0）结算过；否则睡梦中的第一次整点会给玩家回补存续，饿不死。
  await host.ctl({ action: 'step' });
  const normal = await state();
  assert.equal(normal.player.dead, false);
  assert.equal(normal.ghost.active, false);

  const starve = await host.ctl({ action: 'v13_fixture', op: 'starve', v: 0.0015 });
  assert.ok(starve.ok, JSON.stringify(starve));
  const sleep = await host.act({ mode: 'survival', kind: 'camp_sleep' });
  assert.ok(sleep.ok, `睡眠失败：${JSON.stringify(sleep)}`);
  const afterSleep = await state();
  assert.equal(afterSleep.player.dead, true, '睡眠中存续耗尽应死亡');
  assert.equal(afterSleep.ghost.active, true, '死亡后应是幽魂观察，而不是终局');
  assert.equal(afterSleep.ended, false, '玩家死亡不得结束游戏');
  assert.equal(sleep.ghost, true, '睡眠结果应显式报告“睡梦中死亡→中断”');
  assert.ok(sleep.ticks < 4, `睡梦中死亡后睡眠应中断而不是把剩下时长算完，实测 ticks=${sleep.ticks}`);

  // 世界继续：再推进一拍（60 游戏分），时钟必须前进、居民仍在行动。
  const before = { t: afterSleep.t, minutes: afterSleep.clockMinutes, actions: sumActions(afterSleep) };
  await host.ctl({ action: 'step' });
  const after = await state();
  assert.ok(after.t > before.t, `幽魂态世界刻度应继续推进：${before.t} → ${after.t}`);
  // tickSim 的目标分钟会向下取整；从亚分钟锚点显式推进 60 分，实际增量介于 59–60 分。
  assert.ok(after.clockMinutes >= before.minutes + 59 - 0.01, `幽魂态游戏分钟应继续推进：${before.minutes} → ${after.clockMinutes}`);
  assert.ok(sumActions(after) > before.actions, `幽魂态居民仍应行动：${before.actions} → ${sumActions(after)}`);
  assert.ok(after.population >= 1, '聚落仍应有存活居民');
  assert.equal(after.ended, false, '聚落未灭绝不得 ended');
  assert.equal(after.settlement === 'extinct', false, '聚落未灭绝 settlement 不得是 extinct');

  // 观察控制复用世界 rate / 暂停；只写时钟，不写实体。
  const posBefore = JSON.stringify(after.player.pos);
  const rate = await host.ctl({ action: 'rate', rate: 4 });
  assert.ok(rate.ok && rate.rate === 4, `倍速失败：${JSON.stringify(rate)}`);
  assert.equal((await state()).rate, 4);
  await host.ctl({ action: 'pause' });
  const paused = await state();
  assert.equal(paused.paused, true, '暂停观察应冻结世界时钟');
  assert.equal(paused.running, false);
  await host.ctl({ action: 'resume' });
  const resumed = await state();
  assert.equal(resumed.paused, false);
  assert.equal(resumed.running, true);
  assert.equal(JSON.stringify(resumed.player.pos), posBefore, '暂停/倍速不得移动或写玩家实体');

  // 幽魂动作仍被拒（宿主 /act 真实入口）。
  const denied = await host.act({ mode: 'survival', kind: 'gather' });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'PLAYER_DEAD');

  // 刷新等价：存档 → 重启 → 仍是幽魂，未变终局。
  assert.ok(await host.save(), '幽魂档保存失败');
  await host.start();
  host.stop();
  const reloaded = await state();
  assert.equal(reloaded.player.dead, true, '重启后仍是死亡事实');
  assert.equal(reloaded.ghost.active, true, '重启后仍在幽魂观察');
  assert.equal(reloaded.ended, false, '未灭绝的幽魂档重启后不得变成终局');
  assert.ok(Number.isFinite(reloaded.ghost.at?.x), '重启后镜头锚点仍在');
});
