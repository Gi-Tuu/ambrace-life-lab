// S1 能力内核：Thing / Capability / Verb / Precondition / Effect 的纯函数实现。
// 本文件不接线到 body/agent/model——它是待验证的独立模块，接线在 S2/S3 且必须过轨迹一致闸门。
// 设计依据：docs/capability-scene-design.md

// 谓词表是**封闭集合**：未知谓词必须抛错，不能默认放行。
// 默认放行等于"写了个没人校验的前置条件"，那正是 §26 那条纪律要防的假校验。
export const PREDICATES = {
  at: (ctx, arg) => arg.includes(ctx.world.loc[ctx.agent.id]),
  qty_gt: (ctx, arg) => Number(ctx.thing?.qty ?? 0) > arg,
  owner_ne: (ctx, arg) => arg === 'self' ? ctx.thing.owner !== ctx.agent.id : ctx.thing.owner !== arg,
  owner_absent: (ctx) => {
    const owner = ctx.thing?.owner;
    if (!owner || owner === ctx.agent.id) return false;
    return ctx.world.loc[owner] !== ctx.world.loc[ctx.agent.id];
  },
  not_blocked_by_night: (ctx) => !(ctx.thing?.props?.blockedByNight && ctx.world.isNight),
  self_present: (ctx) => Boolean(ctx.world.loc[ctx.agent.id]),
};

export function evalPreconditions(pre = [], ctx) {
  for (const p of pre) {
    const [name, arg] = Object.entries(p)[0];
    const fn = PREDICATES[name];
    if (!fn) throw new Error(`未知前置谓词「${name}」：谓词是封闭集合，必须显式实现，不能默认放行`);
    if (!fn(ctx, arg)) return { ok: false, code: 'PRECONDITION', why: `${name}(${JSON.stringify(arg)})` };
  }
  return { ok: true, code: 'OK' };
}

export const hasCaps = (thing, needs) => {
  if (!needs || (Array.isArray(needs) && !needs.length)) return true;
  const list = Array.isArray(needs) ? needs : [needs];
  return list.every((c) => Boolean(thing?.props?.[c]));
};

// 金额允许引用世界参数（如 @riskyPortion），但只查表，不做运算——避免效果层变成脚本引擎
export function resolveAmount(amount, ctx) {
  if (typeof amount === 'string' && amount.startsWith('@')) {
    const v = ctx.params?.[amount.slice(1)];
    if (v === undefined) throw new Error(`效果引用了不存在的参数「${amount.slice(1)}」`);
    return v;
  }
  return amount;
}

// id 模板决定与现有 trace/判据/存档的兼容性：S2 的一致闸门要求这里产出的 id
// 与 legacy 字符串逐位相同（如 'eat'、'take_shared:a1'、'move_to:store'）。
export function idOf(verb, thing, ctx) {
  if (!verb.idFormat) return verb.id;
  return verb.idFormat
    .replace('{owner}', thing?.owner ?? ctx.agent.id)
    .replace('{loc}', thing?.loc ?? ctx.world.loc[ctx.agent.id])
    .replace('{id}', thing?.id ?? '');
}

export function visibleThings(world, agentId, { reach = (w, id) => Object.keys(w.things).filter((t) => w.things[t].loc === w.loc[id]) } = {}) {
  return reach(world, agentId).map((id) => world.things[id]);
}

export function generateAffordances({ pack, world, agent, verbs = pack.verbs, things, params = {}, visible }) {
  const pool = things ?? visibleThings(world, agent.id, { reach: visible });
  const out = [];
  for (const verb of verbs) {
    for (const thing of pool) {
      if (!hasCaps(thing, verb.needs)) continue;
      const ctx = { world, agent, thing, params };
      const pre = evalPreconditions(verb.pre ?? [], ctx);
      if (!pre.ok) continue; // 生成阶段只列可行动作；驳回由 validate 路径负责（两者口径必须一致）
      const amount = resolveAmount(verb.effect?.amount, ctx);
      out.push({
        id: idOf(verb, thing, ctx),
        kind: verb.id,
        thing: thing.id,
        label: (verb.label ?? verb.id) + (thing.label ? `·${thing.label}` : ''),
        cost: verb.cost,
        impulse: verb.impulse,
        serves: verb.serves ?? {},
        // portion 是"这一口有多大"（mealMin 比的是它）；expectedPortion 只在动词声明 expected 时出现，
        // 用于引擎的事前收益比较（O17/O18）。两者混用会把"吃不到"算成"吃不够"。
        portion: amount,
        expectedPortion: verb.expected ? amount : undefined,
      });
    }
  }
  // 顺序必须确定：同一颗种子两次跑出不同候选，等于把可复现性交给迭代顺序
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // 一个动词命中多个对象时 id 会撞车（legacy 的 'eat' 就是"每角色至多一条"）。
  // 显式声明 onePerAgent 才允许合并；剩下的撞车必须炸——静默去重等于悄悄改变动作空间。
  const kept = [];
  const seenVerb = new Set();
  for (const a of out) {
    const verb = verbs.find((v) => v.id === a.kind);
    if (verb?.onePerAgent) {
      if (seenVerb.has(a.kind)) continue;
      seenVerb.add(a.kind);
    }
    kept.push(a);
  }
  const dupes = kept.filter((a, i) => i && a.id === kept[i - 1].id).map((a) => a.id);
  if (dupes.length) throw new Error(`候选 id 撞车：${[...new Set(dupes)].join(', ')}。请为动词声明 onePerAgent 或使用 idFormat 区分对象`);
  return kept;
}

export function validateAction({ pack, world, agent, intent, params = {} }) {
  const verb = pack.verbs.find((v) => v.id === intent?.kind);
  if (!verb) return { ok: false, code: 'NOT_AN_ACTION', why: `包里没有动词 ${intent?.kind}` };
  const thing = world.things[intent.thing];
  if (!thing) return { ok: false, code: 'NO_TARGET', why: '对象不存在' };
  if (!hasCaps(thing, verb.needs)) return { ok: false, code: 'NO_CAPABILITY', why: `${thing.id} 不具备 ${JSON.stringify(verb.needs)}` };
  return evalPreconditions(verb.pre ?? [], { world, agent, thing, params });
}

export function applyEffect({ pack, world, agent, intent, params = {} }) {
  const verb = pack.verbs.find((v) => v.id === intent.kind);
  const thing = world.things[intent.thing];
  const eff = verb?.effect;
  if (!eff) return { ok: false, code: 'NO_EFFECT', why: verb?.id };
  for (const [k, dv] of Object.entries(eff.delta ?? {})) {
    if (k === 'qty') thing.qty = Math.max(0, Number(thing.qty ?? 0) + dv);
    else throw new Error(`效果器不认识增量字段「${k}」：扩展字段必须显式实现，不能静默忽略`);
  }
  const amount = resolveAmount(eff.amount, { world, agent, thing, params });
  const evt = eff.evt ? { ...eff.evt, about: resolveRef(eff.evt.about, agent, thing) } : null;
  const secret = eff.secret
    ? { kind: eff.secret.kind, about: resolveRef(eff.secret.about, agent, thing), holder: resolveRef(eff.secret.holder, agent, thing), valence: eff.secret.valence ?? -0.6, violates: eff.secret.violates ?? null }
    : null;
  if (secret) {
    secret.known = new Set([secret.holder]);
    if (eff.witness) for (const other of world.occupancy[world.loc[agent.id]] ?? []) secret.known.add(other);
    world.secrets.push(secret);
  }
  return {
    ok: true,
    code: 'OK',
    observation: eff.observation ?? verb.label ?? verb.id,
    satiated: eff.satiated ?? null,
    amount,
    evt,
    secret: secret?.kind ? secret : null,
  };
}

const resolveRef = (ref, agent, thing) => (ref === '@self' ? agent.id : ref === '@owner' ? thing?.owner : ref);

export function makeWorldFromPack(pack, agentIds = []) {
  const world = { t: 0, loc: {}, occupancy: {}, things: {}, secrets: [], pending: [], log: [], isNight: false };
  for (const id of Object.keys(pack.locs)) world.occupancy[id] = [];
  for (const t of pack.things) world.things[t.id] = { ...t, props: { ...t.props } };
  for (const id of agentIds) {
    const home = pack.agents?.[id]?.loc ?? Object.keys(pack.locs)[0];
    world.loc[id] = home;
    world.occupancy[home].push(id);
  }
  return world;
}
