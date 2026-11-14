import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.DATA_DIR=mkdtempSync(join(tmpdir(),'ambrace-compare-'));
process.env.SEED_FILE=join(process.env.DATA_DIR,'none.json');
process.env.GAME_MODE='game';
process.env.TICK_MS='1000000';
const {host}=await import('./host.mjs');

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
