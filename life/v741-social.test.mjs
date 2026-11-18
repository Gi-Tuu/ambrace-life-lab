// V7.4.1 社交保留：m3=on talk 可执行、每刻≤1、m3=off 不变。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSurvPlay, dumpSurv, tickSurvPlay } from './survplay.mjs';
import { FORMAL_OPTIONS } from './balance-probe.mjs';
import { CURRENT_EVENT_RULES } from './rng.mjs';
import { createHash } from 'node:crypto';
import { move } from './body.mjs';
const sha = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

test('V741-SOC m3=on 5 日 talk 执行>0', async () => {
  process.env.FAIR_SCHED = '0';
  const sp = createSurvPlay(7, { ...FORMAL_OPTIONS, eventRulesVersion: CURRENT_EVENT_RULES, residentChannelMask: { m3: true } });
  let talk = 0;
  for (let i = 0; i < 24 * 5; i += 1) {
    await tickSurvPlay(sp, { onResidentAction: (a, rows) => { for (const r of rows) if (r.kind === 'talk' && r.ok !== false) talk += 1; } });
  }
  assert.ok(talk > 0, 'm3=on 社交保留后应有 talk 执行，实测 ' + talk);
});

test('V741-SOC m3Choose 每刻最多保留 1 个 talk', () => {
  const sp = createSurvPlay(7, { ...FORMAL_OPTIONS, eventRulesVersion: CURRENT_EVENT_RULES, residentChannelMask: { m3: true } });
  const w = sp.world, a = w.agents.a1;
  w.t = 10; move(w, 'a1', 'home'); move(w, 'a2', 'home');
  const paths = [
    { id: 'rest1', kind: 'rest', cost: 15 },
    { id: 'talk1', kind: 'talk', target: 'a2', cost: 5 },
    { id: 'talk2', kind: 'talk', target: 'a2', cost: 5 },
  ];
  const out = a.m3Choose(w, paths);
  assert.ok(out.filter((p) => p.kind === 'talk').length <= 1, '每刻最多 1 个 talk 候选');
});

test('V741-SOC m3=off 与无 mask 的 1 日 dump 哈希一致', async () => {
  const a = createSurvPlay(7, { ...FORMAL_OPTIONS, eventRulesVersion: CURRENT_EVENT_RULES, residentChannelMask: { m3: false } });
  const b = createSurvPlay(7, { ...FORMAL_OPTIONS, eventRulesVersion: CURRENT_EVENT_RULES });
  for (let i = 0; i < 24; i += 1) { await tickSurvPlay(a); await tickSurvPlay(b); }
  assert.equal(sha(dumpSurv(a)), sha(dumpSurv(b)));
});
