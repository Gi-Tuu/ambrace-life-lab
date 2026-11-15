import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.DATA_DIR=mkdtempSync(join(tmpdir(),'ambrace-compare-'));
process.env.SEED_FILE=join(process.env.DATA_DIR,'none.json');
process.env.GAME_MODE='game';
process.env.TICK_MS='1000000';
const {host}=await import('./host.mjs');
const {PLAYER_UNITS_PER_TICK}=await import('./body.mjs');

test('game mode advances both comparison worlds while the A/B entry is being viewed',async()=>{
  await host.start();
  try {
    const initial=host.snapshot();
    host.touch('survival');
    await host.ctl({action:'step'});
    const survival=host.snapshot();
    assert.equal(survival.survival.t,initial.survival.t+1);
    assert.equal(survival.A.t,initial.A.t);
    assert.equal(survival.B.t,initial.B.t);
    host.touch('compare');
    await host.ctl({action:'step'});
    const compare=host.snapshot();
    assert.equal(compare.A.t,survival.A.t+1);
    assert.equal(compare.B.t,survival.B.t+1);
    assert.equal(compare.survival.t,survival.survival.t+1);
  } finally {
    await host.stop();
  }
});

test('游戏 A/B 从同一生存快照起步，两侧独立裁决，研究命令只写对照档', async () => {
  await host.start();
  try {
    const snapshot = () => host.snapshot('compare');
    const control = (action, fields = {}) => host.ctl({mode: 'compare', action, ...fields});
    const original = snapshot().comparison;
    await host.ctl({action: 'survival_reset', confirm: true});
    // P0-1 改量披露：外围采集现需服务端玩家位置连续性校验（瞬移拒绝由 V4-01 闸门专测）。
    // 夹具先确立"玩家已合法步行到外围采集点"，再据此派生 A/B 对照档；断言未放宽。
    {
      const o = snapshot().survival;
      const [, dSite] = Object.entries(o.districts).find(([,s])=>s.resource==='wood');
      const hall = o.layout.sites.hall;
      await host.act({mode:'survival', kind:'player_sync', from:[hall[0],hall[1]]});
      const steps = Math.ceil(Math.hypot(dSite.source[0]-hall[0], dSite.source[1]-hall[1])/PLAYER_UNITS_PER_TICK)+1;
      for (let i=1;i<=steps;i++){
        await host.ctl({action:'step'});
        const f=i/steps;
        await host.act({mode:'survival', kind:'player_sync', from:[hall[0]+(dSite.source[0]-hall[0])*f, hall[1]+(dSite.source[1]-hall[1])*f]});
      }
    }
    const official = structuredClone(snapshot().survival);
    const worldFile = join(process.env.DATA_DIR, 'world.json');
    const compareFile = join(process.env.DATA_DIR, 'comparison.json');
    const officialFile = readFileSync(worldFile, 'utf8');
    assert.equal(snapshot().comparison.mapSeed, original.mapSeed);

    assert.equal((await control('compare_reset', {confirm:true, fromSurvival:true})).ok, true);
    let {comparison: pair} = snapshot();
    assert.equal(pair.mapSeed, official.mapSeed);
    assert.equal(pair.startTick, official.t);
    for (const key of ['A','B']) {
      for (const field of ['layout','rooms','districts','occupancy','pinv','plots','buildings','households','ecoSources','camp','player']) {
        assert.deepEqual(pair[key][field], official[field], `${key}.${field} 应至起点与正式档一致`);
      }
      assert.equal(pair[key].model.enabled, false);
    }
    const archive = () => JSON.parse(readFileSync(compareFile, 'utf8'));
    const origin = archive();
    assert.deepEqual(origin.branches.A.world, origin.branches.B.world, '首刻包含完全相同的角色状态和 RNG 状态');
    assert.ok(origin.branches.A.world.minds.a1.rng);
    const act = (kind, fields = {}) => host.act({mode:'compare', revision:pair.revision, kind,...fields});
    const source = Object.entries(pair.A.districts).find(([, site]) => site.resource === 'wood');
    const [district, {source: point}] = source;
    const gather = await act('gather', {target:district, tool:'axe', from:point, otherContact:{from:[0,0]}});
    assert.equal(gather.sides.A.ok, true);
    assert.equal(gather.sides.B.code, 'TELEPORT'); // P0-1 改量：B 用 otherContact.from=[0,0] 远处⇒连续性拒绝（原 OUT_OF_REACH）
    const after = snapshot().comparison;
    assert.equal(after.A.pinv.p1.wood, official.pinv.p1.wood+2);
    assert.equal(after.B.pinv.p1.wood, official.pinv.p1.wood);
    assert.equal(readFileSync(worldFile, 'utf8'), officialFile);
    assert.equal(existsSync(compareFile), true);

    await control('pause');
    assert.equal(snapshot().compareRunning, false);
    assert.equal(snapshot().running, true);
    await control('step');
    const advanced = snapshot().comparison;
    assert.equal(advanced.A.t, pair.startTick+1);
    assert.equal(advanced.B.t, advanced.A.t);
    assert.equal(advanced.A.series.length, 2);
    assert.equal(snapshot().survival.t, official.t);
    assert.equal(readFileSync(worldFile, 'utf8'), officialFile);

    host.stop();
    await host.start();
    const restored = snapshot();
    assert.deepEqual(restored.comparison.A.series, advanced.A.series);
    assert.deepEqual(restored.comparison.B.pinv, advanced.B.pinv);
    assert.deepEqual(restored.survival.pinv, official.pinv);

    await control('mask', {key:'m3', on:true});
    assert.equal((await act('move', {room:'yard'})).code, 'COMPARE_STALE');
    pair = snapshot().comparison;
    assert.equal(pair.A.t, pair.startTick);
    assert.equal(pair.B.t, pair.startTick);
    assert.equal(pair.A.agents.a1.layers.m3, 1);
    assert.equal(pair.B.agents.a1.layers.m3, 0);
    assert.equal(pair.A.pinv.p1.wood, official.pinv.p1.wood);
    await control('step');
    assert.equal(snapshot().comparison.A.agents.a1.layers.m3, 1, '生存刻不能清掉实验掩码');
    assert.equal(snapshot().comparison.B.agents.a1.layers.m3, 0);
    assert.equal(readFileSync(worldFile, 'utf8'), officialFile);
  } finally {
    host.stop();
  }
});

test('A 侧默认通道与相同生存快照的本地运行轨迹完全一致', async () => {
  await host.start();
  try {
    const read = () => host.snapshot('compare');
    await host.ctl({mode:'compare', action:'mask', key:'m3', on:false});
    await host.ctl({action:'reset', confirm:true});
    assert.ok((await host.ctl({mode:'compare', action:'compare_reset', confirm:true, fromSurvival:true})).ok);
    for (let i = 0; i < 20; i++) {
      await host.ctl({action:'step'});
      await host.ctl({mode:'compare', action:'step'});
    }
    const state = read();
    const { A, B } = state.comparison;
    const compareFile = join(process.env.DATA_DIR,'comparison.json');
    const record = JSON.parse(readFileSync(compareFile, 'utf8'));
    const official = JSON.parse(readFileSync(join(process.env.DATA_DIR,'world.json'),'utf8')).survival;
    assert.equal(official.t, A.t);
    assert.deepEqual(record.branches.A.world, official, '同通道、无玩家干预应复现正式生存轨迹');
    assert.equal(A.t, B.t);
    assert.notDeepEqual(record.branches.A.world.survival.aiActions, record.branches.B.world.survival.aiActions,
      '同初始随机序列下，通道切断需表现为行为差异');
  } finally {
    host.stop();
  }
});
