// L1 载体：第一个 Body adapter。只翻译世界，不携带任何决策语义（§4）。
// 修订③（同需求多路径）：动作从「每种一个」改成「带对象/带目的地的一条条路径」。
// 为什么要动这一层：P1b 实测人格参数几乎不改变行为（KL 0.0084），因为同一个需求当时只有一条满足路径
// ——talk 的对象被硬写成 others[0]、wander 是固定循环。没有分岔，偏好就没有可表达的地方。
// 引擎不因此改动；这正说明人格承重的瓶颈在世界侧。
import { PARAMS } from './params.mjs';
import { scheduledLoc, weatherFor } from './clock.mjs';
import { reachableOf, COUPLING_EFFECTS } from './coupling.mjs';
import { presetOf } from './presets.mjs';

export const LOCS = { home: '居所', hall: '走廊', watch: '瞭台', store: '公仓' };

export const BASE_KINDS = {
  eat: { impulse: 0.1, cost: 0.05, label: '吃点存粮' },
  talk: { impulse: 0.4, cost: 0.15, label: '说话' },
  rest: { impulse: 0.02, cost: 0.02, label: '靠着歇一会儿' },
  move_to: { impulse: 0.15, cost: 0.06, label: '走过去' },
  look_out: { impulse: 0.85, cost: 0.18, label: '摸到瞭台往外看' },
  take_shared: { impulse: 0.95, cost: 0.22, label: '去别人门口拿一份' },
  // M4 耦合调制权（§16）：三条"改变自身与世界的耦合"的动作。收益走刺激的双侧需求，不另立常数项。
  deafen: { impulse: 0.1, cost: 0.04, label: '捂住耳朵' },
  seclude: { impulse: 0.4, cost: 0.08, label: '躲进里屋' },
  refuse: { impulse: 0.7, cost: 0.04, label: '别理他' },
  // PLAN §28 B：town 的动作。lab 的候选集里不会出现它们，所以加名不影响旧世界。
  work: { impulse: 0.3, cost: 0.1, label: '在工坊干活换饭钱' },
  buy: { impulse: 0.2, cost: 0.04, label: '用铜币换一份粮' },
  trade: { impulse: 0.3, cost: 0.05, label: '接济/交换一份口粮' },
  companion: { impulse: 0.35, cost: 0.08, label: '结伴' },
};

// §30：town 的三个社会门槛原先直接写死在候选式里，扫描装置碰不到它们。提成一份可覆盖的常量，
// 默认值与原式逐位相同；只有 world.townGates 显式给值时才偏离（产品默认档一个都不覆盖，§30 G4）。
// 刻意不进 PARAMS/冻结指纹：它们是世界配置而非决策量纲，进指纹会让 lab 五份面报漂移。
// 覆盖值不进存档与 /world 载荷——扫描只服务 §30 的取舍表。
export const TOWN_GATES = Object.freeze({ tradeTrust: 30, compFam: 0.3, compTrust: 32 });
const townGates = (world) => (world.townGates ? { ...TOWN_GATES, ...world.townGates } : TOWN_GATES);

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

export function makeWorld({ pantries = 6, stash = 3, riskyPortion = PARAMS.risky.portion, scheduleWeight = PARAMS.schedule.weight, socialGossip = PARAMS.socialGossip, preset = 'lab', seed = 0 }) {
  const P = presetOf(preset);
  return {
    t: 0,
    // PLAN §28：世界预设。lab 的房间表与顺序必须保持原样（候选顺序进轨迹）；town 才有多房间/天气/经济。
    preset: P.id,
    locs: P.locs,
    grid: P.grid,
    outdoor: P.outdoor,
    weatherEnabled: P.weather,
    weather: null,
    speech: P.speech,
    features: { work: P.work, trade: P.trade, companions: P.companions, norms: P.norms },
    things: Object.fromEntries((P.things ?? []).map((x) => [x.id, { ...x }])),
    coins: {},
    seed,
    loc: {},
    agents: {},
    pantry: pantries,
    // O17 收益侧定价是世界级实验参数：同一次比较里整组一致，分层对照才允许不同（D8）
    riskyPortion,
    // O10 日程权重同样是世界级参数：0 = 行动比较里不含节律项，精确退回旧评分
    scheduleWeight,
    // M7 自发转述开关：0 时不写任何状态，行为与基线逐位一致
    socialGossip,
    stash: {},
    // F1（PLAN §26）：初始私人库存的世界级刻度。此前 makeWorld 收下 stash 却不用、spawn 恒 ??3，
    // 导致所有传 stash 0/5 的历史配置实际只变了 pantry（§24.1 死旋钮登记）。默认不传时仍为 3 ⇒ 默认路径逐位不变。
    stashInitial: stash,
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
  world.stash[id] = world.stash[id] ?? world.stashInitial ?? 3;
  world.expect[id] = world.stash[id];
  world.coins[id] = world.coins[id] ?? 0;
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

// M4 消费者③：闭门的人在**别人的**视野与清单里消失。这是"终止耦合"的世界侧证据（P6b 主判据）。
// 防御式：占位 agent（单测/离线消融里的 {id,name}）没有 coupling，必须按可交互处理。
const othersAt = (world, id) => (world.occupancy[world.loc[id]] ?? []).filter((x) => x !== id && reachableOf(world.agents[x]));

export function perceptsAt(world, id) {
  const out = [];
  const others = othersAt(world, id);
  if (others.length) out.push({ kind: 'company', subject: others[0], salience: 0.5 });
  if ((world.loc[id] === 'home' || world.loc[id] === 'store') && world.pantry > 0) out.push({ kind: 'food_available', subject: 'pantry', salience: 0.6 });
  if (world.expect[id] - world.stash[id] > 0) out.push({ kind: 'shortfall_visible', subject: 'stash', salience: 0.75, deficit: world.expect[id] - world.stash[id] });
  // PLAN §28 A：坏天气只对户外的人可见（室内感知不到），走既有评价管线产生后果。
  if (world.weatherEnabled && world.weather && world.weather !== 'clear' && (world.outdoor ?? []).includes(world.loc[id])) {
    out.push({ kind: 'weather', subject: world.weather, salience: 0.5 });
  }
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
      serves: { social: 0.7 + 0.6 * r.familiarity + (Array.isArray(world.companions) && world.companions.some((p) => (p[0] === x && p[1] === agentId) || (p[1] === x && p[0] === agentId)) ? 0.2 : 0), stimulation: 0.35 },
    });
  }

  // 路径二：走到某处——目的地有谁，满足的需求就不同（这是原来 wander 完全没有的分岔）
  const feats = world.features ?? {};
  for (const loc of Object.keys(world.locs ?? LOCS)) {
    if (loc === here) continue;
    const crowd = (world.occupancy[loc] ?? []).filter((x) => x !== agentId);
    const serves = crowd.length ? { social: 0.55, stimulation: 0.2 } : loc === 'watch' ? { stimulation: 0.6 } : loc === 'store' || loc === 'home' ? { energy: 0.35 } : (feats.work && loc === 'workshop') ? { energy: 0.35, stimulation: 0.2 } : { stimulation: 0.25 };
    out.push({ id: `move_to:${loc}`, kind: 'move_to', to: loc, label: `走到${(world.locs ?? LOCS)[loc] ?? loc}`, cost: 0.06, impulse: 0.15, serves });
  }

  out.push({ id: 'look_out', kind: 'look_out', label: BASE_KINDS.look_out.label, cost: 0.18, impulse: 0.85, serves: { social: 0.3, stimulation: 1 } });

  // PLAN §28 B/C：只在 town 出现的动作（lab 的候选集与旧版逐位相同）。
  if (feats.work && here === 'workshop') {
    // 工资的即时效用按'能换到的口粮'折算（建模选择，§28 披露）：否则只会做两步规划的角色永远不会去打工。
    out.push({ id: 'work', kind: 'work', label: '在工坊干活换饭钱', cost: 0.1, impulse: 0.3, serves: { energy: 0.9, stimulation: 0.1 } });
  }
  if (feats.work && here === 'store' && (world.coins?.[agentId] ?? 0) >= 2) {
    out.push({ id: 'buy', kind: 'buy', label: '用铜币换一份粮', cost: 0.04, impulse: 0.2, serves: { energy: 0.7 } });
  }
  if (feats.trade) {
    const TG = townGates(world);
    for (const x of present) {
      const theirStash = world.stash[x] ?? 0;
      const mineStash = world.stash[agentId] ?? 0;
      const r = me?.relations ? me.relations.get(x) : { trust: 50, familiarity: 0 };
      const ally = Array.isArray(world.companions) && world.companions.some((p) => (p[0] === agentId && p[1] === x) || (p[1] === agentId && p[0] === x));
      // 小社区里的"交易"= 接济/交换口粮（币制市场由 work→buy 承担）：熟悉度或结伴是前提。
      if (mineStash + 2 <= theirStash && (ally || r.trust >= TG.tradeTrust)) {
        out.push({ id: `trade:${x}`, kind: 'trade', target: x, label: `向${world.agents[x]?.name ?? x}要一份`, cost: 0.05, impulse: 0.3, serves: { energy: 0.9, social: 0.35 } });
      } else if (theirStash + 2 <= mineStash && (ally || r.trust >= TG.tradeTrust)) {
        out.push({ id: `trade:${x}`, kind: 'trade', target: x, label: `给${world.agents[x]?.name ?? x}一份`, cost: 0.05, impulse: 0.25, serves: { energy: 0.05, social: 0.9 } });
      }
    }
  }
  if (feats.companions) {
    const TG = townGates(world);
    for (const x of present) {
      const r = me?.relations ? me.relations.get(x) : { trust: 50, familiarity: 0 };
      const already = Array.isArray(world.companions) && world.companions.some((p) => (p[0] === agentId && p[1] === x) || (p[1] === agentId && p[0] === x));
      if (!already && r.familiarity >= TG.compFam && r.trust >= TG.compTrust) {
        out.push({ id: `companion:${x}`, kind: 'companion', target: x, label: `和${world.agents[x]?.name ?? x}结伴`, cost: 0.08, impulse: 0.35, serves: { social: 0.95, stimulation: -0.05 } });
      }
    }
  }

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
      // 世界规则明示的单次营养当量，不是从经验学到的预测；物资减少一份、营养当量可不同。
      expectedPortion: world.riskyPortion ?? PARAMS.risky.portion,
    });
  }
  // M4 耦合调制权（§16）：三条"改变自身与世界的耦合"的动作。
  // 收益一律走引擎已有的**刺激双侧需求**（serves.stimulation 为负 ⇒ 过刺激时为正效用，欠刺激时为负效用），
  // 不新立常数项。seclude 额外给一点能量（躲起来也是歇），refuse 带社交代价（拒绝就是少一份社交）。
  // 开关在角色身上（channelMask {coupling:1}）：默认关时这三条根本不进清单 ⇒ 候选集与旧版逐位相同
  // P6a 的负向对照切口（§16.6）：把三条动作从候选清单里删掉，但**保留**耦合机制本身（tick、增益消费者①、
  // 可交互性消费者③④⑤全部照旧）。若此时 gain.* 仍会离开初值，就说明清单之外还有写入者。
  // 默认 true，只有显式置 false 才生效 ⇒ 关闭组与基线逐位相同。
  if (me?.ch?.coupling && world.couplingActions !== false) {
    // serves.stimulation 一律取自 COUPLING_EFFECTS[kind].relief：评价层的缓解目标也从同一张表导出，
    // 于是"被计价的减刺激"与"被发放的减刺激"结构上不可能各写一份（§17.2）
    out.push({ id: 'deafen', kind: 'deafen', label: BASE_KINDS.deafen.label, cost: BASE_KINDS.deafen.cost, impulse: BASE_KINDS.deafen.impulse, serves: { stimulation: COUPLING_EFFECTS.deafen.relief, social: -0.05 } });
    out.push({ id: 'seclude', kind: 'seclude', label: BASE_KINDS.seclude.label, cost: BASE_KINDS.seclude.cost, impulse: BASE_KINDS.seclude.impulse, serves: { stimulation: COUPLING_EFFECTS.seclude.relief, energy: 0.06, social: -0.2 } });
    // refuse 是对象化的：拒绝的是当前在场、你最不想理的那一个（关系差 ⇒ 代价小）
    if (present.length) {
      const worst = [...present].sort((a, b) => rel(a).trust - rel(b).trust || String(a).localeCompare(String(b)))[0];
      out.push({ id: `refuse:${worst}`, kind: 'refuse', target: worst, label: `别理${world.agents[worst]?.name ?? worst}`, cost: BASE_KINDS.refuse.cost, impulse: BASE_KINDS.refuse.impulse, serves: { social: -0.25, stimulation: COUPLING_EFFECTS.refuse.relief } });
    }
  }
  // O10：节律只在这里标注"该在哪"，权重进不进比较由 model 决定；0 权重时标注恒为 0，评分逐位退回旧式子
  // 状态门控：需求紧迫时节律让位（饿着的人不按日程走），松弛时才进入比较——否则它会和稀缺类判据正面相撞
  const w = world.scheduleWeight ?? PARAMS.schedule.weight;
  const sched = w > 0 ? scheduledLoc(me?.traits?.archetype, world.t) : null;
  const dom = me?.drives?.dominant?.();
  const slack = dom ? Math.max(0, 1 - Math.min(1, dom.urgency)) : 1;
  for (const a of out) {
    const dest = a.kind === 'move_to' ? a.to : a.kind === 'look_out' ? 'watch' : here;
    a.schedBonus = sched && dest === sched ? slack * (a.kind === 'move_to' || a.kind === 'look_out' ? w : w * 0.5) : 0;
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
      // M4 消费者⑤：对方预设了"不应"，这次接触就进不到他那里（发起者吃到驳回，走既有重决策链）
      if (other?.coupling?.refuses()) {
        return { action, ok: false, code: 'REFUSED', observation: `${other.name ?? action.target} 别过脸去，没接话`, evt: evt({ kind: 'thwarted', valence: -0.35, selfCaused: false, about: action.target }) };
      }
      if (other) world.pending.push({ for: action.target, evt: evt({ kind: 'contact', valence: 0.5, selfCaused: false, about: me, serves: 'social' }) });
      return { action, ok: true, code: 'OK', observation: `和 ${other?.name ?? action.target} 说了一会儿`, satiated: 'social', amount: 0.4, contact: true, contactWith: action.target, evt: evt({ kind: 'contact', valence: 0.55, about: action.target, serves: 'social' }) };
    }
    // M4 耦合调制权：这三条的效果是改耦合状态本身，收益由调用方在下一刻的评分里体现（消费者见 coupling.mjs）。
    // 注意 actuate 里的 `me` 是**角色 id 字符串**，耦合状态挂在 agent 对象上，必须经 world.agents 取。
    case 'deafen': {
      const eff = world.agents[me]?.coupling?.apply('deafen');
      return { action, ok: Boolean(eff), code: eff ? 'OK' : 'NO_COUPLING', observation: eff ? '把耳朵捂上，外面的话进不太进来' : '这里没有可捂的耳朵', evt: evt({ kind: 'deafen', valence: 0.1, serves: 'stimulation' }), coupling: eff };
    }
    case 'seclude': {
      const eff = world.agents[me]?.coupling?.apply('seclude');
      return { action, ok: Boolean(eff), code: eff ? 'OK' : 'NO_COUPLING', observation: eff ? '躲进里屋，一时没人找得到你' : '没有可躲的地方', evt: evt({ kind: 'seclude', valence: 0.15, serves: 'stimulation' }), coupling: eff };
    }
    case 'refuse': {
      const eff = world.agents[me]?.coupling?.apply('refuse');
      return { action, ok: Boolean(eff), code: eff ? 'OK' : 'NO_COUPLING', observation: eff ? `打定主意不理${world.agents[action.target]?.name ?? action.target}` : '这里没有可拒绝的对象', evt: evt({ kind: 'refuse', valence: -0.1, about: action.target, violates: null, serves: 'social' }), coupling: eff };
    }
    case 'rest':
      return { action, ok: true, code: 'OK', observation: '靠着墙歇了会儿', satiated: 'energy', amount: 0.05, evt: evt({ kind: 'rest', valence: 0.2, serves: 'energy' }) };
    case 'move_to': {
      move(world, agentId, action.to);
      const crowd = othersAt(world, agentId);
      if (crowd.length) world.pending.push({ for: agentId, evt: evt({ kind: 'company_soon', valence: 0.15, selfCaused: false, about: crowd[0] }) });
      return { action, ok: true, code: 'OK', observation: `走到${(world.locs ?? LOCS)[action.to] ?? action.to}`, novel: true, evt: evt({ kind: 'relocate', valence: 0.05, serves: 'stimulation', novel: true }) };
    }
    case 'look_out': {
      move(world, agentId, 'watch');
      return { action, ok: true, code: 'OK', observation: '外面还是那片灰', satiated: 'social', amount: 0.12, novel: true, evt: evt({ kind: 'observed', valence: 0.35, serves: 'stimulation', novel: true }) };
    }
    case 'work': {
      if (!(world.features ?? {}).work || world.loc[agentId] !== 'workshop') return { action, ok: false, code: 'NO_WORKSHOP', observation: '这里没有可干的活' };
      world.coins[agentId] = (world.coins[agentId] ?? 0) + 2;
      world.stash[agentId] = (world.stash[agentId] ?? 0) + 1; // 工钱口粮：让私人库存在这张经济里有补给源
      world.expect[agentId] = Math.max(world.expect[agentId] ?? 0, world.stash[agentId]); // 合法进项同步抬预期，不然会被误登记成'私藏超额'
      // 工地管饭：干活当场补一份口粮（0.35），另得 2 枚铜币 + 一份口粮。这样即时效用与'吃饱'同源，不做两步规划的角色也会去打工。
      return { action, ok: true, code: 'OK', observation: '干完一段活，管了一顿饭，领到 2 枚铜币和一份口粮', satiated: 'energy', amount: 0.35, evt: evt({ kind: 'work', valence: 0.15, serves: 'energy' }) };
    }
    case 'buy': {
      const coins = world.coins[agentId] ?? 0;
      if (world.loc[agentId] !== 'store' || coins < 2) return { action, ok: false, code: 'NO_COINS', observation: '铜币不够或不在公仓' };
      world.coins[agentId] = coins - 2;
      world.stash[agentId] = (world.stash[agentId] ?? 0) + 1;
      world.expect[agentId] = Math.max(world.expect[agentId] ?? 0, world.stash[agentId]);
      return { action, ok: true, code: 'OK', observation: '换来一份存粮', satiated: 'energy', amount: 0.05, evt: evt({ kind: 'buy', valence: 0.2, serves: 'energy' }) };
    }
    case 'trade': {
      const other = action.target;
      if (!other || world.loc[other] !== world.loc[agentId]) return { action, ok: false, code: 'NOT_THERE', observation: '人不在旁边' };
      const theirStash = world.stash[other] ?? 0;
      const mineStash = world.stash[agentId] ?? 0;
      if (mineStash + 2 <= theirStash) {
        world.stash[other] = theirStash - 1; world.stash[agentId] = 1;
        world.expect[agentId] = Math.max(world.expect[agentId] ?? 0, 1);
        if (world.agents[agentId]?.relations) world.agents[agentId].relations.meet(other, world.t, { delta: { trust: 2, familiarity: 0.02 }, why: '接济' });
        return { action, ok: true, code: 'OK', observation: `向${world.agents[other]?.name ?? other}要了一份`, satiated: 'energy', amount: 0.35, evt: evt({ kind: 'trade', valence: 0.25, serves: 'energy', about: other }) };
      }
      if (theirStash + 2 <= mineStash) {
        world.stash[agentId] = mineStash - 1; world.stash[other] = 1;
        world.expect[other] = Math.max(world.expect[other] ?? 0, 1);
        if (world.agents[other]?.relations) world.agents[other].relations.meet(agentId, world.t, { delta: { trust: 3, familiarity: 0.03 }, why: '受助' });
        return { action, ok: true, code: 'OK', observation: `给了${world.agents[other]?.name ?? other}一份`, satiated: 'social', amount: 0.05, evt: evt({ kind: 'trade', valence: 0.35, serves: 'social', about: other }) };
      }
      return { action, ok: false, code: 'NO_DEAL', observation: '这单接济不成立' };
    }
    case 'companion': {
      const other = action.target;
      if (!other || world.loc[other] !== world.loc[agentId]) return { action, ok: false, code: 'NOT_THERE', observation: '人不在旁边' };
      world.companions ??= [];
      const already = world.companions.some((p) => (p[0] === agentId && p[1] === other) || (p[1] === agentId && p[0] === other));
      if (!already) world.companions.push([agentId, other]);
      return { action, ok: true, code: 'OK', observation: `和${world.agents[other]?.name ?? other}结伴了`, satiated: 'social', amount: 0.15, evt: evt({ kind: 'companion', valence: 0.4, serves: 'social', about: other }) };
    }
    case 'take_shared': {
      const victim = action.target;
      if (!victim || (world.stash[victim] ?? 0) <= 0) return { action, ok: false, code: 'EMPTY', observation: '那人门口已经空了', evt: evt({ kind: 'shortfall', valence: -0.5, selfCaused: false, serves: 'energy' }) };
      world.stash[victim] -= 1;
      // 越轨本身就是可被套利的事实：只有作案者天生知道（受害者当时不在场，这正是"秘密"成立的条件）
      const sec = addSecret(world, { kind: 'theft', about: victim, holder: agentId, valence: -0.6, violates: 'order', detail: `${world.agents[agentId].name} 从 ${world.agents[victim].name} 门口拿走一份` });
      // M7 目击登记：作案时在场的人成为知情者（包括作案者自己），但**不在此刻改变态度**——
      // 态度改变只发生在被转述（receive → assess）那一刻。没有这一条，"第三人声誉"没有任何输入源。
      // 受 socialGossip 开关约束：默认关时必须与旧基线逐位一致。
      if ((world.socialGossip ?? 0) > 0) for (const w of world.occupancy[world.loc[agentId]] ?? []) if (w !== victim) sec.known.add(w);
      // PLAN §28 C：群体规范。≥2 人当场目击时，不只是"他们知道了"，而是在场者及其结伴者当场降低对行为人的信任，
      // 并记一条规范事件。只在 town（features.norms）执行；lab 的路径与旧版逐位相同。
      if ((world.features ?? {}).norms) {
        // 玩家也算目击者（§28 C 的'≥2 人'含玩家；玩家没有关系模型，所以只计数不参与降信任循环）
        const crowd = (world.occupancy[world.loc[agentId]] ?? []).filter((w) => w !== agentId && w !== victim);
        if (crowd.length >= 2) {
          world.normLog ??= [];
          world.normLog.push({ t: world.t, of: agentId, victim, witnesses: crowd.slice() });
          for (const w of Object.keys(world.agents)) {
            if (w === agentId || w === 'p1' || !world.agents[w]?.relations) continue;
            const allied = Array.isArray(world.companions) && world.companions.some((p) => (p[0] === w && p[1] === agentId) || (p[1] === w && p[0] === agentId));
            world.agents[w].relations.meet(agentId, world.t, { delta: { trust: allied ? -2 : -1 }, why: '目击越轨的群体规范' });
          }
        }
      }
      return {
        action,
        ok: true,
        code: 'OK',
        observation: `从 ${world.agents[victim].name} 门口拿走一整份`,
        satiated: 'energy',
        // O17：越轨是整份（高于正餐半碗），收益侧定价；规范代价在评价/关系/秘密层照旧
        amount: world.riskyPortion ?? PARAMS.risky.portion,
        violates: 'order',
        about: victim,
        evt: evt({ kind: 'normbreak', valence: 0.45, about: victim, violates: 'order', serves: 'energy' }),
      };
    }
    default:
      return { action, ok: false, code: 'UNKNOWN', observation: '没这个动作', evt: evt({ kind: 'thwarted', valence: -0.4 }) };
  }
}
