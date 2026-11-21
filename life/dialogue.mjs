import { isAlive } from './viability.mjs';
// 居民对话层（P0 对话）：玩家输入自由文本，居民按自身状态决定理不理、耐不耐烦、
// 是否发火甚至动手。语言本身可以来自真实模型；**决策不交给模型**——理睬/离开/攻击的
// 门槛在服务端按关系、能量、性格、忙碌状态裁决，模型只负责把已定的态度说成人话。
// 这样模型宕机/预算耗尽时，居民仍然是有边界的人，而不是一个永远微笑的问答机。
import { speechLine, classifySay } from './speech.mjs';
import { startMove } from './body.mjs';
import { residentContact } from './camp-play.mjs';
import { engagementOf, BUSY } from './resident-engagement.mjs';
export { engagementOf } from './resident-engagement.mjs';
const INSULT = /滚|闭嘴|废物|蠢|傻|去死|没用|垃圾|讨厌你|烦人/;
const hash = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h;
};

const trustOf = (npc) => npc.relations?.get?.('p1')?.trust ?? 30;

// 打开的这一刻就决定"愿不愿意谈"：忙且累会拒绝，社交已满足会敷衍，信任低会冷淡。
// 实现在 resident-engagement.mjs；这里保留旧导出名。

export function talkInRange(world, talk) {
  return Boolean(talk) && isAlive(world.agents.p1) && isAlive(world.agents[talk.target]) &&
    (talk.contact ? world.loc.p1===talk.contact.playerSite && world.loc[talk.target]===talk.contact.site && !residentContact(world,talk.contact) :
      world.loc.p1 === world.loc[talk.target]);
}

export function openTalk(sp, body, now = Date.now()) {
  const w = sp.world, s = w.survival, target = String(body?.target ?? '');
  if (!isAlive(w.agents.p1) || (!w.independentWorld && (s.ended || s.failed))) return { ok: false, code: 'CAMP_ENDED' };
  const npc = w.agents[target];
  if (!npc || npc.isPlayer || !npc.drives) return { ok: false, code: 'NO_RESIDENT' };
  if (!isAlive(npc)) return { ok: false, code: 'RESIDENT_GONE' };
  let contact;
  if (Object.hasOwn(body,'from')) {
    contact={target,room:body.room,from:body.from,to:body.to,site:w.loc[target],playerSite:w.loc.p1};
    const code=residentContact(w,contact);
    if (code) return {ok:false,code};
  } else if (w.loc.p1 !== w.loc[target]) {
    return { ok: false, code: 'NOT_TOGETHER', why: `${npc.name} 不在这里` };
  }
  const engage = engagementOf(w, npc);
  // 不耐烦按服务器墙钟计（世界 tick 可能很慢：1 tick≈12s 时“10 刻”不是人能感知的耐心）。
  s.talk = { target, ...(contact&&{contact}), openTick: w.t, openAt: now, count: 0, engage, history: [], patienceMs: engage === 'open' ? 20000 : 12000 };
  const line = engage === 'refuse'
    ? `（${npc.name}没有抬头，手上的活没停。）`
    : speechLine(npc, { world: w, kind: 'talk', actionId: 'talk:p1', t: w.t });
  return { ok: true, name: npc.name, engage, line };
}

export function closeTalk(sp) {
  if (sp.world.survival) sp.world.survival.talk = null;
  return { ok: true };
}

function walkAway(w, npc) {
  const home = w.housing?.[npc.id];
  const here = w.loc[npc.id];
  const to = home && Object.hasOwn(w.locs, home) && home !== here
    ? home
    : ['home', 'hall', 'watch', 'yard'].find((l) => l !== here && Object.hasOwn(w.locs, l));
  if (to) startMove(w, npc.id, to);
}

function attack(w, npc) {
  const p1 = w.agents.p1;
  if (p1?.viab) p1.viab.v = Math.max(0, p1.viab.v - 0.1);
  npc.relations?.meet?.('p1', w.t, { delta: { trust: -15 } });
  w.pending.push({ for: 'p1', evt: { kind: 'assault', valence: -0.9, about: npc.id, selfCaused: true, serves: 'safety' } });
  return `${npc.name}动了手，你被推得踉跄（存续 −10%）。`;
}

// 主动结束（不耐烦/被打断）：居民真的走开，世界位置会变。
export function leaveTalk(sp) {
  const s = sp.world.survival, talk = s?.talk;
  if (!talk) return null;
  const npc = sp.world.agents[talk.target];
  s.talk = null;
  if (!npc) return { name: '', line: '对方已经离开了。' };
  walkAway(sp.world, npc);
  return { name: npc.name, line: `${npc.name}等得不耐烦，走开了。` };
}

// P1c：`sayTo` 拆成两阶段，供 host 在"短状态锁内 prepare → 锁外等模型 → 锁内 finish"使用。
// 并发保护：同一段对话同一时刻只允许一个待回应的玩家发言（talk.pendingSay token）。
// 第二句在模型返回前到达会得到 SAY_PENDING，不重复调模型、不覆盖对话状态。
export function prepareSay(sp, body, now = Date.now()) {
  const w = sp.world, s = w.survival, target = String(body?.target ?? '');
  const text = String(body?.text ?? '').trim().slice(0, 240);
  const talk = s.talk;
  if (!isAlive(w.agents.p1) || (!w.independentWorld && (s.ended || s.failed))) return { ok: false, code: 'CAMP_ENDED' };
  if (!talk || talk.target !== target) return { ok: false, code: 'NO_TALK' };
  if (!talkInRange(w, talk) || talk.contact && Object.hasOwn(body, 'from') &&
      residentContact(w, { ...talk.contact, from: body.from, to: body.to, room: body.room })) {
    s.talk = null;
    return { ok: false, code: 'NOT_TOGETHER' };
  }
  const npc = w.agents[target];
  if (!text) return { ok: false, code: 'EMPTY_TEXT' };
  if (now - talk.openAt > talk.patienceMs) {
    return { ok: true, left: true, ...leaveTalk(sp) };
  }
  // 上一个发言的模型还没回来：不重复提交。超过一个 patience 周期仍未落地则允许重试。
  if (talk.pendingSay && now - (talk.pendingSay.at ?? 0) < Math.max(1000, talk.patienceMs)) {
    return { ok: false, code: 'SAY_PENDING', why: '上一句话还在等回应' };
  }
  talk.count += 1;
  const trust = trustOf(npc);
  const intent = classifySay(text);
  const insulted = intent.kind === 'accuse' || INSULT.test(text);
  talk.history.push({ who: 'p1', text });
  if (talk.history.length > 8) talk.history.shift();

  // 1) 不愿/没空：不回话，也不烧模型额度。
  if (talk.engage === 'refuse' || (BUSY.has(npc.last?.kind ?? '') && talk.count <= 1)) {
    const line = `${npc.name}没有回应，继续做自己的事。`;
    talk.history.push({ who: target, text: line });
    return { ok: true, ignored: true, name: npc.name, line };
  }
  // 2) 被冒犯到临界：发火甚至动手。冲动型/低信任更容易越线。
  if (insulted && (trust < 45 || npc.traits?.archetype === '冲动' || talk.count >= 3)) {
    const hostile = trust < 25 || npc.traits?.archetype === '冲动';
    npc.relations?.meet?.('p1', w.t, { delta: { trust: -10 } });
    const line = hostile ? attack(w, npc) : `${npc.name}沉下脸："你说话放尊重点。"`;
    talk.history.push({ who: target, text: line });
    if (hostile) s.talk = null;
    return { ok: true, hostile: true, attacked: hostile, name: npc.name, line };
  }
  // 3) 正常回应：模型锁外调用；这里只登记并返回上下文。
  const token = `${target}:${talk.count}:${now}`;
  const canAsk = talk.engage !== 'reluctant';
  if (canAsk) talk.pendingSay = { token, at: now };
  return {
    pending: {
      token, target, text, trust, intent, talk, npc, canAsk,
      contactBody: Object.hasOwn(body, 'from') ? { from: body.from, to: body.to, room: body.room } : null,
      askArgs: { npc, world: w, history: talk.history, text, trust, intent: intent.kind },
    },
  };
}

export function finishSay(sp, pending, line = null, now = Date.now()) {
  const w = sp.world, s = w.survival, { target, intent, npc, talk, token } = pending;
  if (!isAlive(w.agents.p1) || (!w.independentWorld && (s.ended || s.failed))) return { ok: false, code: 'CAMP_ENDED' };
  if (!talk || s.talk !== talk || talk.target !== target) return { ok: false, code: 'NO_TALK' };
  if (talk.pendingSay && talk.pendingSay.token !== token) return { ok: false, code: 'SAY_STALE', why: '对话已被另一句接管' };
  if (talk.pendingSay?.token === token) talk.pendingSay = null;
  if (!isAlive(npc)) { s.talk = null; return { ok: false, code: 'RESIDENT_GONE' }; }
  if (!talkInRange(w, talk) || pending.contactBody &&
      residentContact(w, { ...talk.contact, ...pending.contactBody })) {
    s.talk = null;
    return { ok: false, code: 'NOT_TOGETHER' };
  }
  // 模型等待期间可能已过耐心：走开，不把一句迟到的话说出口。
  if (now - talk.openAt > talk.patienceMs) {
    if (talk.pendingSay?.token === token) talk.pendingSay = null;
    return { ok: true, left: true, ...leaveTalk(sp) };
  }
  // 正常回应：有模型用模型，没有就用状态条件化模板（态度已由服务端定好）。
  if (!line) {
    line = talk.engage === 'reluctant'
      ? `"${npc.name}":（停了一下）……${speechLine(npc, { world: w, kind: 'talk', actionId: 'talk:p1', t: w.t })}`
      : speechLine(npc, { world: w, kind: 'talk', actionId: 'talk:p1', t: w.t });
  }
  // SOC-04：对话信任有上限。居民之间受每日发言上限约束，玩家不能靠逐句复读把信任刷满。
  const TALK_TRUST_SESSION = 4, TALK_TRUST_DAY = 6;
  const day = Math.floor(w.t / (w.dayTicks ?? 24));
  const cap = s.talkTrust ??= { day, by: {} };
  if (cap.day !== day) { cap.day = day; cap.by = {}; }
  const spent = cap.by[target] ?? 0;
  const gain = Math.max(0, intent.trust ?? 0);
  const applied = intent.trust < 0
    ? intent.trust
    : Math.min(gain, Math.max(0, TALK_TRUST_SESSION - (talk.trustGained ?? 0)), Math.max(0, TALK_TRUST_DAY - spent));
  talk.trustGained = (talk.trustGained ?? 0) + Math.max(0, applied);
  cap.by[target] = spent + Math.max(0, applied);
  npc.relations?.meet?.('p1', w.t, { delta: { trust: applied, familiarity: 0.03 } });
  talk.history.push({ who: target, text: line });
  return { ok: true, name: npc.name, line, engage: talk.engage, intent: intent.kind };
}

// 兼容入口：直接调用方（测试/研究态）仍是一次 await 的 sayTo。
export async function sayTo(sp, body, ask = null, now = Date.now()) {
  const prep = prepareSay(sp, body, now);
  if (!prep.pending) return prep;
  let line = null;
  if (prep.pending.canAsk && ask) {
    try { line = await ask(prep.pending.askArgs); } catch { line = null; }
  }
  return finishSay(sp, prep.pending, line, now);
}
