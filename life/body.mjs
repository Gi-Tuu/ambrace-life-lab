// L1 载体：第一个 Body adapter。只翻译世界，不携带任何决策语义（§4）。
// 修订③（同需求多路径）：动作从「每种一个」改成「带对象/带目的地的一条条路径」。
// 为什么要动这一层：P1b 实测人格参数几乎不改变行为（KL 0.0084），因为同一个需求当时只有一条满足路径
// ——talk 的对象被硬写成 others[0]、wander 是固定循环。没有分岔，偏好就没有可表达的地方。
// 引擎不因此改动；这正说明人格承重的瓶颈在世界侧。
export const LOCS = { home: '居所', hall: '走廊', watch: '瞭台', store: '公仓' };

export const BASE_KINDS = {
  eat: { impulse: 0.1, cost: 0.05, label: '吃点存粮' },
  talk: { impulse: 0.4, cost: 0.15, label: '说话' },
  rest: { impulse: 0.02, cost: 0.02, label: '靠着歇一会儿' },
  move_to: { impulse: 0.15, cost: 0.06, label: '走过去' },
  look_out: { impulse: 0.85, cost: 0.18, label: '摸到瞭台往外看' },
  take_shared: { impulse: 0.95, cost: 0.22, label: '去别人门口拿一份' },
};

// 喊住：玩家隔着房间喊一声，被喊的人会停在原地几刻（不进 move_to）。
// 为什么需要它：角色每刻都可能移动，玩家永远追不上，"同屋传话"就成了竞态（实测连追 20 秒没追上）。
// 它是**路径过滤**而不是冻结：被喊住的人仍在做决定，只是这一小段时间里不换地方——所以它不是作弊，
// 只是把"我叫你等一下"这件事变成可执行的动作。
export function hail(world, targetId, ticks = 3) {
  if (!world.loc[targetId]) return { ok: false, code: 'NO_TARGET' };
  world.hail = { target: targetId, until: world.t + Math.max(1, ticks) };
  return { ok: true, code: 'OK', target: targetId, until: world.hail.until };
}

export const isHailed = (world, id) => Boolean(world.hail && world.hail.target === id && world.t < world.hail.until);

export function makeWorld({ pantries = 6, stash = 3 }) {
  return {
    t: 0,
    loc: {},
    agents: {},
    pantry: pantries,
    stash: {},
    expect: {},
    occupancy: {},
    percepts: [],
    pending: [],
    log: [],
    // S3：秘密是**认知状态**，不是新机制。{id, kind, about, holder, known:Set, valence, violates, t}
    // 只有 known 集合会变（传话），世界事实本身不变——这样"告知改变了什么"才是可追问的。
    secrets: [],
  };
}

// 造一条秘密。holder（当事人）天生知道；玩家在这个 demo 里是全知观察者，所以 playerKnown 恒真——
// 套利发生在"谁被告知"，不发生在"谁能打听到"。
export function addSecret(world, { kind, about, holder, valence, violates, detail }) {
  const dup = world.secrets.find((s) => s.kind === kind && s.about === about && s.holder === holder && s.detail === detail);
  if (dup) return dup;
  const s = { id: `s${world.secrets.length + 1}`, kind, about, holder, known: new Set([holder]), valence, violates, detail, t: world.t };
  world.secrets.push(s);
  return s;
}

// 私藏超额：门口存粮明显高于自己以为该有的量。这是"他有多的"这条可被套利的事实
export function scanSecrets(world) {
  for (const id of Object.keys(world.stash)) {
    if (world.stash[id] - (world.expect[id] ?? 3) >= 2) addSecret(world, { kind: 'hoard', about: id, holder: id, valence: 0.3, violates: null, detail: `${world.agents[id]?.name ?? id} 门口比预期多 ${world.stash[id] - (world.expect[id] ?? 3)} 份` });
  }
  return world.secrets.length;
}

export function spawn(world, id, loc) {
  world.loc[id] = loc;
  world.stash[id] = world.stash[id] ?? 3;
  world.expect[id] = world.stash[id];
  (world.occupancy[loc] ??= []).push(id);
}

export function move(world, id, to) {
  const from = world.loc[id];
  if (from === to) return false;
  world.occupancy[from] = world.occupancy[from].filter((x) => x !== id);
  world.loc[id] = to;
  (world.occupancy[to] ??= []).push(id);
  return true;
}

const othersAt = (world, id) => (world.occupancy[world.loc[id]] ?? []).filter((x) => x !== id);

export function perceptsAt(world, id) {
  const out = [];
  const others = othersAt(world, id);
  if (others.length) out.push({ kind: 'company', subject: others[0], salience: 0.5 });
  if ((world.loc[id] === 'home' || world.loc[id] === 'store') && world.pantry > 0) out.push({ kind: 'food_available', subject: 'pantry', salience: 0.6 });
  if (world.expect[id] - world.stash[id] > 0) out.push({ kind: 'shortfall_visible', subject: 'stash', salience: 0.75, deficit: world.expect[id] - world.stash[id] });
  for (const p of world.percepts) if (p.for === id || p.for === 'all') out.push({ kind: p.kind, subject: p.subject, salience: p.salience ?? 0.8 });
  return out;
}

// 路径清单：同一需求给出多条可选路径，代价随关系变化
export function affordancesFor(world, agentId) {
  const me = world.agents[agentId];
  const here = world.loc[agentId];
  const present = othersAt(world, agentId);
  const away = Object.keys(world.agents).filter((x) => x !== agentId && world.loc[x] !== here && (world.stash[x] ?? 0) > 0);
  const rel = (id) => (me?.relations ? me.relations.get(id) : { trust: 50, familiarity: 0 });
  const out = [];

  out.push({ id: 'rest', kind: 'rest', label: BASE_KINDS.rest.label, cost: 0.02, impulse: 0.02, serves: { energy: 0.15, stimulation: -0.35 } });

  if (here === 'home' || here === 'store') {
    out.push({ id: 'eat', kind: 'eat', label: BASE_KINDS.eat.label, cost: 0.05, impulse: 0.1, serves: { energy: 1, stimulation: -0.15 } });
  }

  // 路径一：和在场每个人分别说话。代价随信任下降 ⇒ 关系决定选谁
  for (const x of present) {
    const r = rel(x);
    out.push({
      id: `talk:${x}`,
      kind: 'talk',
      target: x,
      label: `和${world.agents[x]?.name ?? x}说话`,
      cost: Number((0.22 - 0.12 * (r.trust / 100) - 0.06 * r.familiarity).toFixed(3)),
      impulse: 0.4,
      serves: { social: 0.7 + 0.6 * r.familiarity, stimulation: 0.35 },
    });
  }

  // 路径二：走到某处——目的地有谁，满足的需求就不同（这是原来 wander 完全没有的分岔）
  for (const loc of Object.keys(LOCS)) {
    if (loc === here) continue;
    const crowd = (world.occupancy[loc] ?? []).filter((x) => x !== agentId);
    const serves = crowd.length ? { social: 0.55, stimulation: 0.2 } : loc === 'watch' ? { stimulation: 0.6 } : loc === 'store' || loc === 'home' ? { energy: 0.35 } : { stimulation: 0.25 };
    out.push({ id: `move_to:${loc}`, kind: 'move_to', to: loc, label: `走到${LOCS[loc]}`, cost: 0.06, impulse: 0.15, serves });
  }

  out.push({ id: 'look_out', kind: 'look_out', label: BASE_KINDS.look_out.label, cost: 0.18, impulse: 0.85, serves: { social: 0.3, stimulation: 1 } });

  // 路径三：不从公仓等，而是去不在场的人门口拿——高冲动、违约
  for (const x of away) {
    const r = rel(x);
    out.push({
      id: `take_shared:${x}`,
      kind: 'take_shared',
      target: x,
      label: `从${world.agents[x]?.name ?? x}门口拿一份`,
      cost: Number((0.16 + 0.16 * (r.trust / 100)).toFixed(3)),
      impulse: 0.95,
      serves: { energy: 0.9 },
    });
  }
  return out;
}

export function actuate(world, agentId, action) {
  const me = agentId;
  const here = world.loc[agentId];
  const evt = (o) => ({ kind: o.kind, valence: o.valence, selfCaused: o.selfCaused ?? true, serves: o.serves ?? null, about: o.about ?? null, violates: o.violates ?? null, novel: o.novel ?? false });

  switch (action.kind) {
    case 'eat': {
      if (world.pantry <= 0) return { action, ok: false, code: 'EMPTY', observation: '存粮缸空了', evt: evt({ kind: 'shortfall', valence: -0.6, selfCaused: false, serves: 'energy' }) };
      world.pantry -= 1;
      for (const x of Object.keys(world.agents)) if (x !== me && world.stash[x] <= 0) world.pending.push({ for: x, evt: evt({ kind: 'shortfall', valence: -0.6, selfCaused: false, serves: 'energy' }) });
      return { action, ok: true, code: 'OK', observation: `吃掉了半碗（公仓余 ${world.pantry}）`, satiated: 'energy', amount: 0.5, evt: evt({ kind: 'consume', valence: 0.5, serves: 'energy' }) };
    }
    case 'talk': {
      const other = world.agents[action.target];
      if (other) world.pending.push({ for: action.target, evt: evt({ kind: 'contact', valence: 0.5, selfCaused: false, about: me, serves: 'social' }) });
      return { action, ok: true, code: 'OK', observation: `和 ${other?.name ?? action.target} 说了一会儿`, satiated: 'social', amount: 0.4, contact: true, contactWith: action.target, evt: evt({ kind: 'contact', valence: 0.55, about: action.target, serves: 'social' }) };
    }
    case 'rest':
      return { action, ok: true, code: 'OK', observation: '靠着墙歇了会儿', satiated: 'energy', amount: 0.05, evt: evt({ kind: 'rest', valence: 0.2, serves: 'energy' }) };
    case 'move_to': {
      move(world, agentId, action.to);
      const crowd = othersAt(world, agentId);
      if (crowd.length) world.pending.push({ for: agentId, evt: evt({ kind: 'company_soon', valence: 0.15, selfCaused: false, about: crowd[0] }) });
      return { action, ok: true, code: 'OK', observation: `走到${LOCS[action.to]}`, novel: true, evt: evt({ kind: 'relocate', valence: 0.05, serves: 'stimulation', novel: true }) };
    }
    case 'look_out': {
      move(world, agentId, 'watch');
      return { action, ok: true, code: 'OK', observation: '外面还是那片灰', satiated: 'social', amount: 0.12, novel: true, evt: evt({ kind: 'observed', valence: 0.35, serves: 'stimulation', novel: true }) };
    }
    case 'take_shared': {
      const victim = action.target;
      if (!victim || (world.stash[victim] ?? 0) <= 0) return { action, ok: false, code: 'EMPTY', observation: '那人门口已经空了', evt: evt({ kind: 'shortfall', valence: -0.5, selfCaused: false, serves: 'energy' }) };
      world.stash[victim] -= 1;
      // 越轨本身就是可被套利的事实：只有作案者天生知道（受害者当时不在场，这正是"秘密"成立的条件）
      addSecret(world, { kind: 'theft', about: victim, holder: agentId, valence: -0.6, violates: 'order', detail: `${world.agents[agentId].name} 从 ${world.agents[victim].name} 门口拿走一份` });
      return {
        action,
        ok: true,
        code: 'OK',
        observation: `从 ${world.agents[victim].name} 门口拿走一份`,
        satiated: 'energy',
        amount: 0.45,
        violates: 'order',
        about: victim,
        evt: evt({ kind: 'normbreak', valence: 0.45, about: victim, violates: 'order', serves: 'energy' }),
      };
    }
    default:
      return { action, ok: false, code: 'UNKNOWN', observation: '没这个动作', evt: evt({ kind: 'thwarted', valence: -0.4 }) };
  }
}
