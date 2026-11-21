// 1.4 玩家主动对话 + 居民注意力：服务端闸门。
// 覆盖：attention 当拍停进度/停旅行/不取消任务/下一刻清、下一分钟恢复、
//       轻量对话 4 话题/多轮/关闭/免费/只读、旧 camp_resident 当日首次信任不变、
//       距离/忙碌/死亡/compare 拒绝、成本表与视图投影。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSurvPlay, dumpSurv, playerTimeLeft, survAct, survView } from './survplay.mjs';
import { createSimClock, simMinuteNow } from './sim-clock.mjs';
import { advanceResidentBusy, clockOf } from './resident-time.mjs';
import { advanceTravels } from './body.mjs';
import { expireResidentAttention, residentAttention } from './resident-attention.mjs';
import { costFor } from './action-cost.mjs';
import { validateCamp } from './rules.mjs';
import { worldSite } from './geometry.mjs';

const GAME = Object.freeze({
  independentWorld: true, gameRules: true, residentialDecisions: true, unifiedCooperation: true,
  settlementLife: true, autonomousGoals: true, farmLife: true, regionalWork: true, ecosystem: true, wildFood: true,
});

const contactOf = (w, target = 'a1') => {
  const [x, z] = worldSite(w, w.loc[target]);
  // 夹具：把玩家站在居民锚点旁（真实客户端由 player_sync 逐步走近；这里直接给合法脚点）。
  w.survival.playerPos = { x: x + .5, z: z + .5, t: w.t };
  w.survival.playerReachState = { t: w.t, allowance: 100, sub: 0 };
  return { target, room: null, from: [x + .5, z + .5], to: [x + .5, z + .5] };
};

const formal = (seed = 7) => createSurvPlay(seed, { ...GAME });

function seedBusy(w, id, { kind = 'gather', totalMin = 20 } = {}) {
  const clock = clockOf(w, id);
  clock.tick.usedMin = 0;
  clock.busy = { kind, action: null, startTick: w.t, totalMin, remainMin: totalMin, progressMin: 0, bankedMin: 0, applied: 0, energyPaid: 0 };
  if (w.simClock) {
    const now = simMinuteNow(w);
    Object.assign(clock.busy, { startMin: now, endMin: now + totalMin, lastAdvanceMin: now });
  }
  return clock.busy;
}

test('V14-01 交谈当拍：attention 设置、劳动不推进、旅行不停留也不取消、下一刻清掉并恢复', async () => {
  const p = formal(), w = p.world;
  const contact = contactOf(w);
  const talk = survAct(p, { kind: 'camp_resident', tool: 'hand', ...contact });
  assert.equal(talk.code, 'RESIDENT_TALKED');
  const npc = w.agents.a1;
  assert.equal(npc.attention.about, 'p1');
  assert.equal(npc.attention.until, w.t + 1);
  assert.ok(Number.isFinite(npc.attention.untilMin) && npc.attention.untilMin >= simMinuteNow(w) + 1);

  const busy = seedBusy(w, 'a1');
  const paused = advanceResidentBusy(w, 'a1');
  assert.equal(paused.code, 'ATTENTION');
  assert.equal(paused.paused, true);
  assert.equal(busy.progressMin, 0, '当拍不得推进劳动进度');
  assert.equal(busy.remainMin, 20, '当拍不得扣剩余工时');
  assert.equal(clockOf(w, 'a1').busy, busy, '任务不能被取消');

  // 远行：到点也不推进/不结算，行程索引保留。
  w.survival.districtTravel = { a1: { from: 'home', to: 'store', arrive: w.t, t: w.t } };
  const beforeLoc = w.loc.a1;
  advanceTravels(w);
  assert.ok(w.survival.districtTravel.a1, '当拍不得结算/丢弃旅行');
  assert.equal(w.loc.a1, beforeLoc, '当拍不得改 loc');

  // 下一刻：自动清掉；劳动从原进度继续。
  w.t += 1;
  assert.equal(expireResidentAttention(w), 1);
  assert.equal(npc.attention, undefined);
  const resumed = advanceResidentBusy(w, 'a1');
  assert.ok(resumed.advanced || resumed.completed, JSON.stringify(resumed));
  assert.ok(busy.progressMin > 0, '清掉后下一拍必须恢复任务进度');
});

test('V14-02 轻量对话：4 话题/多轮/免费/只读/关闭；距离与忙碌门', () => {
  const p = formal(), w = p.world, npc = w.agents.a1;
  const contact = contactOf(w);
  const trust = npc.relations.map.get('p1')?.trust ?? 30;
  const fam = npc.relations.map.get('p1')?.familiarity ?? 0;
  const time0 = playerTimeLeft(w);
  const loc0 = { p1: w.loc.p1, a1: w.loc.a1 };

  assert.equal(survAct(p, { kind: 'camp_talk', target: 'a1', room: null, from: [0, 0], to: [0, 0] }).code, 'RESIDENT_OUT_OF_REACH');
  const busyPlayer = clockOf(w, 'p1');
  busyPlayer.busy = { id: 'test', kind: 'build', remainMin: 10, totalMin: 30 };
  assert.equal(survAct(p, { kind: 'camp_talk', ...contact }).code, 'BUSY');
  busyPlayer.busy = null;
  assert.equal(playerTimeLeft(w), time0);

  const open = survAct(p, { kind: 'camp_talk', ...contact });
  assert.equal(open.code, 'RESIDENT_TALK_OPEN');
  assert.equal(open.name, npc.name);
  assert.ok(open.line?.length > 0);
  assert.deepEqual(open.topics.map((t) => t.id), ['today', 'busy', 'settlement', 'help']);
  assert.equal(survAct(p, { kind: 'camp_talk_say', ...contact, topic: 'nope' }).code, 'BAD_TOPIC');

  const first = survAct(p, { kind: 'camp_talk_say', ...contact, topic: 'today' });
  const second = survAct(p, { kind: 'camp_talk_say', ...contact, topic: 'busy' });
  assert.equal(first.ok, true);
  assert.equal(first.turn, 1);
  assert.equal(second.turn, 2);
  assert.equal(second.lastTopic ?? second.topic, 'busy');
  assert.ok(first.line && second.line);
  assert.equal(survAct(p, { kind: 'camp_talk_say', ...contact, topic: 'settlement' }).turn, 3);

  // 免费 + 只读：不扣玩家分钟/体力，不写关系，不动 loc。
  assert.equal(playerTimeLeft(w), time0);
  assert.equal(npc.relations.map.get('p1')?.trust ?? 30, trust);
  assert.equal(npc.relations.map.get('p1')?.familiarity ?? 0, fam);
  assert.deepEqual({ p1: w.loc.p1, a1: w.loc.a1 }, loc0);
  assert.equal(npc.viab.v, 1);

  assert.equal(survAct(p, { kind: 'camp_talk_close', target: 'a1' }).code, 'RESIDENT_TALK_CLOSED');
  assert.equal(w.survival.residentDialogue, undefined);
  assert.equal(survAct(p, { kind: 'camp_talk_say', ...contact, topic: 'today' }).code, 'NO_DIALOGUE');

  // 死亡/compare：本地对话拒绝（不远程弹窗）。
  const dead = formal();
  dead.world.agents.p1.dead = true;
  assert.equal(survAct(dead, { kind: 'camp_talk', ...contactOf(dead.world) }).code, 'PLAYER_DEAD');
  const compared = formal();
  compared.world.compareSide = 'A';
  assert.equal(survAct(compared, { kind: 'camp_talk', ...contactOf(compared.world) }).code, 'TALK_UNSUPPORTED');
});

test('V14-03 台词按状态分化：饥饿/工作/天气/聚落事件/关系', () => {
  const p = formal(), w = p.world, npc = w.agents.a1, contact = contactOf(w);
  const open = () => survAct(p, { kind: 'camp_talk', ...contact });
  const say = (topic) => survAct(p, { kind: 'camp_talk_say', ...contact, topic });

  // 饥饿
  npc.drives.v.energy = 0.08;
  w.survival.store = 40;
  w.weather = 'clear';
  assert.match(open().line, /饿|吃的/);
  assert.match(say('today').line, /饿/);

  // 工作（任务不被取消）
  npc.drives.v.energy = 0.8;
  seedBusy(w, 'a1', { kind: 'build', totalMin: 30 });
  assert.match(say('busy').line, /垒墙|活/);
  assert.match(say('busy').line, /不(会)?取消|接着做/);
  assert.ok(clockOf(w, 'a1').busy, '对话不能取消 busy');

  // 天气：多轮里必须出现雨天模板（确定性哈希按 turn 取样）。
  clockOf(w, 'a1').busy = null;
  w.weather = 'rain'; w.survival.store = 40;
  const rainLines = [1, 2, 3, 4].map(() => say('today').line);
  assert.ok(rainLines.some((line) => /雨/.test(line)), rainLines.join(' | '));

  // 聚落事件 + 危机
  w.weather = 'clear';
  w.survival.eventJournal = { next: 2, rows: [{ id: 1, t: w.t, kind: 'death', actor: 'a2' }] };
  assert.match(say('settlement').line, /走|安静/);
  w.survival.starveDays = 2;
  const crisis = say('settlement').line;
  assert.match(crisis, /粮|省/, crisis);

  // 关系
  w.survival.starveDays = 0;
  w.survival.store = 40;
  npc.relations.map.set('p1', { familiarity: 0, trust: 70, debt: 0, lastAt: w.t });
  assert.match(say('help').line, /木料|搭把手/);
  npc.relations.map.set('p1', { familiarity: 0, trust: 10, debt: 0, lastAt: w.t });
  assert.match(say('help').line, /先顾好你自己/);
});

test('V14-04 旧 camp_resident 保留当天首次信任，且同样打 attention', () => {
  const p = formal(), w = p.world, npc = w.agents.a1, contact = contactOf(w);
  const trust0 = npc.relations.map.get('p1')?.trust ?? 30;
  assert.equal(survAct(p, { kind: 'camp_resident', tool: 'hand', ...contact }).code, 'RESIDENT_TALKED');
  assert.equal(npc.relations.get('p1').trust, trust0 + 4);
  assert.equal(npc.attention.about, 'p1');
  const trust1 = npc.relations.get('p1').trust;
  assert.equal(survAct(p, { kind: 'camp_resident', tool: 'hand', ...contact }).code, 'RESIDENT_TALKED');
  assert.equal(npc.relations.get('p1').trust, trust1, '同一天第二次交谈不得重复加信任');
});

test('V14-05 成本/规则/视图：camp_talk* 免费且同门，研究态视图不多字段', () => {
  const p = formal(), w = p.world;
  for (const kind of ['camp_talk', 'camp_talk_say', 'camp_talk_close']) {
    assert.equal(costFor(kind).minutes, 0, kind + ' 必须 0 分钟');
    assert.equal(costFor(kind).energy, 0, kind + ' 必须 0 体力');
    assert.equal(validateCamp(w, { kind, target: 'a1' }), null, kind + ' 必须过规则层');
  }
  const open = survAct(p, { kind: 'camp_talk', ...contactOf(w) });
  assert.equal(open.code, 'RESIDENT_TALK_OPEN');
  assert.ok(survView(p).agents.a1.attention, '正式视图应带 attention 投影');

  // 研究态：没有注意力时不得凭空多字段；dump 形状不变。
  const research = createSurvPlay(7, {});
  const view = survView(research);
  assert.equal(view.agents.a1.attention, undefined);
  assert.equal(research.world.simClock, undefined);
  assert.ok(dumpSurv(research).t >= 0);
});

test('V14-06 连续世界：交谈后下一分钟停、再下一分钟恢复', async () => {
  let nowMs = 0;
  const clock = createSimClock({ now: () => nowMs, manual: true });
  const p = createSurvPlay(7, { ...GAME, simTime: true, simClock: clock });
  const w = p.world;
  clock.setGameMinutes(600);
  w.t = 10;

  const contact = contactOf(w);
  const talk = survAct(p, { kind: 'camp_talk', ...contact });
  assert.equal(talk.code, 'RESIDENT_TALK_OPEN', JSON.stringify(talk));
  const untilMin = w.agents.a1.attention.untilMin;

  const busy = seedBusy(w, 'a1', { kind: 'gather', totalMin: 30 });
  clock.advanceMinutes(1);
  const { tickSurvPlay } = await import('./survplay.mjs');
  await tickSurvPlay(p);
  assert.equal(busy.progressMin, 0, '交谈后的下一分钟不得推进');
  assert.equal(w.agents.a1.attention, undefined, '这一分钟末必须清掉 attention');
  assert.ok(simMinuteNow(w) >= untilMin);

  clock.advanceMinutes(1);
  await tickSurvPlay(p);
  assert.ok(busy.progressMin > 0, '清掉后的下一分钟必须恢复任务');
});
