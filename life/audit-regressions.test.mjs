import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { move } from './body.mjs';
import { openTalk, sayTo } from './dialogue.mjs';
import { createSurvPlay, survAct, survView, tickSurvPlay } from './survplay.mjs';

const options = { residentialDecisions: true, ecosystem: true, unifiedCooperation: true,
  independentWorld: true, wildFood: true, autonomousGoals: true };

test('主档缺失和生存子档损坏时恢复最近可读备份，保留损坏原档', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ambrace-recovery-'));
  const main = join(dir, 'world.json');
  const backup = main + '.bak';
  process.env.DATA_DIR = dir;
  process.env.SEED_FILE = join(dir, 'missing.json');
  process.env.TICK_MS = '3600000';
  const { host } = await import('./host.mjs');
  try {
    await host.start();
    await host.tickOnce();
    assert.equal(await host.save(), true);
    host.stop();
    const raw = JSON.parse(await readFile(main, 'utf8'));
    await rename(main, backup);
    assert.match((await host.start()).note, /备份存档/);
    assert.equal(host.snapshot().survival.t, raw.survival.t);
    host.stop();
    assert.equal(await host.save(), true);
    raw.survival.survival.sites = null;
    const damaged = JSON.stringify(raw);
    await writeFile(main, damaged);
    assert.match((await host.start()).note, /已隔离.*备份存档/);
    assert.equal(host.snapshot().survival.t, raw.survival.t);
    const isolated = (await readdir(dir)).find(name => name.startsWith('world.corrupt-'));
    assert.equal(await readFile(join(dir, isolated), 'utf8'), damaged);
    // 让文件替代数据目录，模拟运行中存档介质不可写。
    await rename(dir, dir + '-preserved');
    await writeFile(dir, 'fixture');
    const result = await host.act({ mode: 'survival', kind: 'move', room: 'yard' });
    assert.equal(result.ok, true);
    assert.equal(result.persisted, false);
    assert.equal(host.snapshot().survival.loc.p1, 'yard');
    assert.ok(host.snapshot().saveError);
  } finally { host.stop(); }
});

test('离场后对话取消且没有反馈或关系结算', async () => {
  const sp = createSurvPlay(7, options);
  const w = sp.world;
  move(w, 'p1', 'home');
  move(w, 'a1', 'home');
  assert.ok(openTalk(sp, { target: 'a1' }).ok);
  const before = { ...w.agents.a1.relations.get('p1') };
  move(w, 'p1', 'yard');
  const result = await sayTo(sp, { target: 'a1', text: '你好' }, () => assert.fail('离场后不得请求模型'));
  assert.equal(result.code, 'NOT_TOGETHER');
  assert.equal(w.survival.talk, null);
  assert.deepEqual(w.agents.a1.relations.get('p1'), before);
});

test('致死行动即时退出占位，快照与行动规则一致', () => {
  const sp = createSurvPlay(7, options);
  sp.world.agents.p1.viab.v = .000001;
  assert.ok(survAct(sp, { kind: 'move', room: 'yard' }).ok);
  const view = survView(sp);
  assert.equal(view.player.result, 'dead');
  assert.equal(view.player.dead, true);
  assert.ok(!view.occupancy.yard.includes('p1'));
  assert.equal(survAct(sp, { kind: 'move', room: 'home' }).code, 'PLAYER_DEAD');
  assert.equal(view.deaths.filter(death => death.id === 'p1').length, 1);
});

test('3000 刻生存档日志及角色轨迹有界', async () => {
  const sp = createSurvPlay(7, options);
  for (let i = 0; i < 3000; i += 1) await tickSurvPlay(sp);
  assert.equal(sp.world.t, 3000);
  assert.ok(sp.log.length <= 200);
  assert.ok(Object.values(sp.world.agents).every(agent => agent.trace.length <= 2000));
});
