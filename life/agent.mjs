// 单个生命体的装配与主循环：L2 感知 → L3 调制 → L4 需求 → L5 评价 → L6 动机 → L7 三层选择 → L9 校验 → L10 执行 → L11 记忆
// 身份粒度从 kind 升到**路径 id**（talk:绛 / move_to:hall）：习惯、记忆、trace、判据都按路径计，
// 否则「同需求多路径」只是显示层的装饰。
import { ModulatorBank } from './modulators.mjs';
import { M5ModulatorBank } from './m5-bank.mjs';
import { Drives } from './drives.mjs';
import { EpisodicMemory } from './memory.mjs';
import { Relations, REL_NEUTRAL } from './relations.mjs';
import { appraise } from './appraisal.mjs';
import { perceptsAt, affordancesFor, actuate, isHailed, SURV_COST } from './body.mjs';
import { validate, actionId } from './rules.mjs';
import { residentTimeModel, clockOf, residentBeginTime, attachBusyAction, residentRefundTime, laborEnergy } from './resident-time.mjs';
import { isLaborAction } from './households.mjs';
import { noteAction, noteRefusal } from './action-ledger.mjs';
import { costFor } from './action-cost.mjs';
import { recordRepairFailure } from './production.mjs';
import { recordConstructionBlock } from './construction-access.mjs';
import { channelsFor, visibleActions, scoreAll, temperatureOf, softmaxPick, makeHabit } from './model.mjs';
import { makeRng } from './rng.mjs';
import { sampleTraits, DIMS } from './traits.mjs';
import { simMinuteNow } from './sim-clock.mjs';
import { SelfMaintain } from './viability.mjs';
import { ForwardModel } from './s4-predictor.mjs';
import { dayOf, isSunset, phaseOf, isNight } from './clock.mjs';
import { PARAMS } from './params.mjs';
import { ShortHorizonPlanner } from './m3-planner.mjs';
import { Coupling, COUPLING_KINDS } from './coupling.mjs';
import { legacyRefusalWhy } from './research-time.mjs';
import { bodyClockEnabled } from './body-clock.mjs';

const REFLEXES = [
  { when: (p) => p.kind === 'alarm', then: () => ({ kind: 'move_to', to: 'hall' }) },
  { when: (p, d) => p.kind === 'food_available' && d.v.energy < 0.24, then: () => ({ kind: 'eat' }) },
  { when: (p, d) => p.kind === 'shortfall_visible' && d.dominant().name === 'energy', then: () => ({ kind: 'eat' }) },
];
// 正式连续世界里，感知事件超过一个派生刻还没被任何 think 消费，就视为过期（丢弃并记 trace）。
const PERCEPT_TTL_MIN = 60;
// 决策链同步/异步判定：本地替身路径必须同步落地（见 decideOn 注释）。
const isThenable = (x) => Boolean(x) && typeof x.then === 'function';

export class Organism {
  constructor({ id, name, archetype, seed, condition = 'C2', mInit, rng, deliberator = null, traitsOverride = null, channelMask = null }) {
    this.id = id;
    this.name = name;
    this.condition = condition;
    this.ch = channelsFor(condition, channelMask);
    // M5 只能显式加在 C2；C2-neg 不得被重新接通状态通道。
    if (condition !== 'C2' && this.ch.m5) this.ch.m5 = 0;
    this.rng = rng ?? makeRng(seed);
    this.traits = sampleTraits(this.rng, archetype);
    // 覆盖必须在任何子模块构造之前落地：Drives 会把 social_setpoint 拷进自己的 setpoint，
    // 事后改 traits 它读不到（实测得到 KL 恰好为 0 的假阴性）
    if (traitsOverride) Object.assign(this.traits, traitsOverride);
    const bankInit = mInit ? { ...this.traits.baseline, ...mInit } : undefined;
    this.bank = this.ch.m5 ? new M5ModulatorBank(this.traits, this.rng, bankInit, {
      brake: this.ch.m5Brake !== 0, multidim: this.ch.m5Multi !== 0, symmetric: this.ch.m5Symmetric !== 0, read: this.ch.m5Read !== 0, slowInput: this.ch.m5SlowInput !== 0,
      load: this.ch.m5Load !== 0, feedback: this.ch.m5Feedback !== 0, delay: this.ch.m5Delay ?? PARAMS.m5.delay, exposure: this.ch.m5Exposure !== 0,
    }) : new ModulatorBank(this.traits, this.rng, bankInit);
    this.drives = new Drives(this.rng, this.traits);
    this.memory = new EpisodicMemory();
    this.forwardModel = new ForwardModel();
    this.relations = new Relations(id);
    this.habit = makeHabit();
    // L13：存续量自己演化、自己花钱；它只能通过侵蚀上面三个部件来起作用（D1 不可逆降级）
    this.viab = new SelfMaintain({ organs: { habit: this.habit, memory: this.memory, social: this.relations }, agent: this, damage: Boolean(this.ch.erosion) });
    // M3 行为状态：纯确定性规划器（无随机数）。构造不产生副作用，关闭时也不会被调用。
    this.m3Planner = new ShortHorizonPlanner({ commitment: PARAMS.m3.commitment, discount: PARAMS.m3.discount, effortWeight: PARAMS.effortWeight });
    this.m3Last = null;
    this.m3PrevGoal = null;
    // M4 耦合状态：构造即存在，但只有 ch.coupling 打开时才会被写入（关闭时三个变量恒为初值）
    this.coupling = new Coupling();
    this.deliberator = deliberator;
    this.trace = [];
    this.counters = { actions: 0, reflex: 0, habit: 0, deliberation: 0, rejected: 0, spontaneous: 0, initiated: 0, externalEvents: 0, llmCalls: 0, normbreak: 0, erosion: 0, reflect: 0, asked: 0, skipped: 0, triggered: 0, informed: 0 };
    // D4：当天的账做成可持久化计数器（trace 不落盘，不能拿它当日志源）
    this.dayTally = { day: 0, decisions: 0, byDriver: {}, norm: 0, rejected: 0 };
  }

  // R8：关系写入必须统一夹到 ceiling。viab 的"关系维护"侵蚀会降低 ceiling，
  // 而 assess() 的常规路径直接 ± 而不看 ceiling ⇒ 被侵蚀的上限可以被普通社交顶穿
  // （实测 ceiling 75 时 trust 被 6 次 contact 顶到 93），"不可逆降级"因此部分可逆。
  bumpRel(id, trustDelta = 0, famDelta = 0) {
    const r = this.relations.get(id);
    const cap = typeof this.relations.ceiling === 'number' ? this.relations.ceiling : 100;
    r.trust = Math.max(0, Math.min(cap, r.trust + trustDelta));
    r.familiarity = Math.max(0, Math.min(1, r.familiarity + famDelta));
    return r;
  }

  assess(evt, actionKind = null, actionSucceeded = null) {
    const a = appraise(evt, { traits: this.traits, drives: this.drives, memory: this.memory, relations: this.relations, t: this.world?.t ?? 0, m: this.bank.m });
    this.bank.inject(a.u);
    if (this.ch.m5) this.bank.observeEvent(evt, a);
    this.memory.add(this.world?.t ?? 0, { kind: evt.kind, actionKind, actionSucceeded, payload: `来自${evt.about ?? '环境'}`, mSnapshot: this.bank.snapshot(), importance: a.importance });
    if (evt.about) {
      if (evt.kind === 'contact') this.bumpRel(evt.about, 3, 0.06);
      if (evt.violates) this.bumpRel(evt.about, -10 * this.traits.goals.order, 0);
    }
    if (evt.kind === 'shortfall' || evt.kind === 'witnessed') {
      if (this.world?.gameRules) {
        // AUD-07（游戏态）：只惩罚当事人与同屋目击者——不在场的人不该因为别人的缺口掉信任。
        const here = this.world?.loc?.[this.id];
        const suspects = new Set();
        if (evt.about) suspects.add(evt.about);
        for (const id of this.world?.occupancy?.[here] ?? []) if (id !== this.id) suspects.add(id);
        for (const id of suspects) if (id !== this.id && this.world?.agents?.[id]) this.bumpRel(id, -4 * this.traits.goals.order, 0);
      } else {
        // 研究/历史路径保持原样（逐位基线）：全体 agents。
        for (const id of Object.keys(this.world?.agents ?? {})) if (id !== this.id) this.bumpRel(id, -4 * this.traits.goals.order, 0);
      }
    }
    return a;
  }

  tick(world) {
    this.world = world;
    const t = world.t;
    // 仅记录本轮输入处理之前已知的公开状态，供时间留出实验使用。
    this.tickStart = { t, loc: world.loc[this.id], drives: { ...this.drives.v } };
    // P1：同一世界刻可能有多轮 10 分 think。调制 bank/前向模型仍只在该刻首个 think 更新一次
    // （RNG 抽取位置/次数与旧路径一致）；身体量已由 tickSurvPlay 的分钟 micro-step 结算。
    const reuseMetab = this.lastMetabTick === t && Boolean(this.lastMetab);
    // 1.1 第 2 项：正式连续世界的能量/存续/饥饿已按游戏分钟积分，think 只读快照。
    const minuteBody = bodyClockEnabled(world);
    // M3 的目标只属于"本刻真的做过非反射决策"的那些刻：反射提前 return 时不得沿用上一次的目标，否则特征表会把反射刻当成 M3 决策
    this.m3Last = null;
    // M4：τ 按刻计（不按决策机会计）——"躲一阵子"是时间量，不是机会量。关闭时不写任何状态。
    // 正式分钟身体路径在整点步里结算（stepBodyHour）；其余旧路径保持原位置逐位不变。
    const continuousClock = Boolean(world.simClock);
    if (this.ch.coupling && !minuteBody && !(continuousClock && world.independentWorld)) this.coupling.tick(1);

    const incoming = world.pending.filter((p) => p.for === this.id);
    world.pending = world.pending.filter((p) => p.for !== this.id);
    // 消费者①：输入增益决定这些事件能注入多少。gain=1 时 `valence * 1` 逐位等于原值 ⇒ 关闭时零影响
    // world.couplingGainOff 是 §17.4 的对照切口：只切断 ①（保留三条动作与评价缓解），用来问"过载改善到底来自哪条通道"
    const gain = this.ch.coupling && !world.couplingGainOff ? this.coupling.input : 1;
    for (const inc of incoming) this.assess(gain === 1 ? inc.evt : { ...inc.evt, valence: inc.evt.valence * gain });

    const percepts = perceptsAt(world, this.id);
    // P1：正式世界的 world.percepts 不再按 60 分整清。每条感知带 seq，居民只消费
    // seq > lastPerceptSeq 的新事件 ⇒ 同一事件不会被同一刻内多个 10 分 think 重复消费。
    // 研究态没有 seq 语义（每刻整清），保持旧读法逐位不变。
    const external = (() => {
      const rows = (world.percepts ?? []).filter((p) => p.for === this.id || p.for === 'all');
      if (!world.simClock) return rows;
      const nowMin = simMinuteNow(world);
      let seq = Number.isSafeInteger(world.perceptSeq) ? world.perceptSeq : 0;
      const fresh = [];
      for (const p of rows) {
        if (!Number.isSafeInteger(p.seq)) p.seq = ++seq;
        if (p.seq <= (this.lastPerceptSeq ?? -1)) continue;
        if (!Number.isFinite(p.at)) p.at = nowMin; // 旧代码/夹具直接 push 的行：按首次可见时刻计龄
        // 异步/排队 think 落地时，迟到超过一个刻的事件丢弃并留 trace，不重复消费。
        if (nowMin - p.at > PERCEPT_TTL_MIN) {
          this.perceptExpired = (this.perceptExpired ?? 0) + 1;
          this.trace.push({
            t, id: this.id, layer: 'percept_expired', name: this.name,
            kind: p.kind ?? null, subject: p.subject ?? null, at: p.at, decidedAt: nowMin,
          });
          continue;
        }
        fresh.push(p);
      }
      if (seq > (world.perceptSeq ?? 0)) world.perceptSeq = seq;
      this.lastPerceptSeq = Math.max(this.lastPerceptSeq ?? -1, world.perceptSeq ?? 0);
      // decidedAt：这一轮 think 的决策分钟。异步落地时据此判断事件是否已过期。
      this.lastPercepts = fresh.map((p) => ({ kind: p.kind, subject: p.subject ?? null, seq: p.seq, decidedAt: nowMin }));
      if (fresh.length) {
        this.perceptConsumed = (this.perceptConsumed ?? 0) + fresh.length;
        this.lastPerceptDecidedAt = nowMin;
      }
      return fresh;
    })();
    if (external.length) this.counters.externalEvents += 1;

    const deficit = percepts.find((p) => p.kind === 'shortfall_visible');
    if (deficit) {
      world.expect[this.id] = world.stash[this.id];
      this.assess({ kind: 'witnessed', valence: -0.7, selfCaused: false, about: null, violates: 'order', serves: 'safety' });
      this.trace.push({ t, id: this.id, layer: 'discovery', name: this.name, lost: deficit.deficit, m: this.bank.snapshot(), drives: { ...this.drives.v }, cond: this.condition });
    }

    // S2：日落是"一天结束"这个世界事实，不是某个 tick 数。反思回合挂在它上面，⑦ 关掉就不发生。
    // P1b：think 改到分钟级后同一 t 会有多次决策机会；日落反思必须每个 t 只发生一次。
    const sunset = isSunset(t);
    if (sunset && this.ch.reflect && this.lastReflectTick !== t) { this.lastReflectTick = t; this.reflect(world); }
    // ⑧ 事件门控：思考层只在这四类时刻被动用。没有事件时由自主层自己决定，不调模型。
    // triggered 与 asked 分开记：反射层可能在这一刻直接接管（关键事件、发现缺口都会触发反射），
    // 那时事件确实发生了、但思考层没被问。混成一个计数就会把这个"吞并"藏起来。
    const told = this.informedTick === t; // 告知发生在这一 tick（receive 里已当场注入评价）
    const reason = this.triggerReason({
      informed: told,
      alarm: external.some((p) => p.kind === 'alarm'),
      contact: incoming.some((i) => i.evt.kind === 'contact'),
      discovery: Boolean(deficit),
      sunset,
    });
    if (reason) this.counters.triggered += 1;
    if (told) this.informedTick = null;

    // P1c：按"距上次结算过了几个派生刻"推进。正式分钟身体路径不再在 think 里扣身体，
    // 但调制 bank 仍按旧口径在该刻首个 think 更新（M5 只 step(1)，其余按 elapsedTicks）。
    const elapsedTicks = reuseMetab ? 0 : Math.max(1, t - (Number.isFinite(this.lastMetabTick) ? this.lastMetabTick : t));
    const step = this.ch.m5 ? 1 : (world.simClock ? elapsedTicks : 1);
    // 只更新调制 bank / 前向模型（旧顺序：先预测，再 bank.tick，再学习）；不碰能量/存续/饥饿。
    // 分钟身体路径与研究态共用这一段，保证 bank 的 RNG 抽取点与次数逐位不变。
    const cognitionStep = () => {
      const input = { m: this.bank.snapshot(), pending: { ...this.bank.pending }, traits: this.traits };
      const estimate = this.forwardModel.predict(input, { precision: Boolean(this.ch.precision) });
      // M6-P（PLAN §25.2）：木桶门控 = 最不可靠通道的相对精度。只在开关开时写这个状态；
      // 关时不写、不传 gate ⇒ 轨迹逐位不变。weights 在无样本/precision 关时全 1 ⇒ gate 恒 1（P2 负控）。
      if (this.ch.plasticGate) this.plasticGateNow = Math.min(...Object.values(estimate.weights));
      const prediction = this.ch.forwardModel ? estimate : { ...estimate, mu: { ...input.m }, probability: null };
      this.bank.tick(step);
      if (this.ch.forwardLearn) this.forwardModel.observe(input, prediction, this.bank.m);
      // M6-L（PLAN §25.6）：在线相对进度 = 误差双 EMA 的 (slow−fast)/slow。只在 lpExplore 且 forwardLearn 开时写；
      // 没学习就没有"进度"（L2 负控）。误差只用本次更新前的预测 mu，因果、无未来信息。
      if (this.ch.lpExplore && this.ch.forwardLearn) {
        const err = DIMS.reduce((s, d) => s + Math.abs(this.bank.m[d] - prediction.mu[d]), 0) / DIMS.length;
        this.lpFast = this.lpFast === undefined ? err : this.lpFast + (err - this.lpFast) * PARAMS.lp.fast;
        this.lpSlow = this.lpSlow === undefined ? err : this.lpSlow + (err - this.lpSlow) * PARAMS.lp.slow;
      }
      return { ch: this.ch, prediction };
    };
    // 旧路径（研究态 / M5_MINUTE_METAB=0 回退）：身体仍由 think 每刻结算一次，逐位不变。
    const metabolize = () => {
      if (this.ch.m5 && world.simClock && elapsedTicks > 1) this.metabRemainder = (this.metabRemainder ?? 0) + (elapsedTicks - 1);
      this.metabCount = (this.metabCount ?? 0) + 1; // 观测用，不进入存档
      const metab = cognitionStep();
      const contact = (world.occupancy[world.loc[this.id]] ?? []).length > 1;
      this.drives.tick(step, contact);
      // PLAN §28 A：坏天气下在户外额外耗一点能量（town 启用；lab 的 weatherEnabled=false ⇒ 不执行）。
      if (world.weatherEnabled && world.weather && world.weather !== 'clear' && (world.outdoor ?? []).includes(world.loc[this.id])) {
        this.drives.v.energy = Math.max(0, this.drives.v.energy - 0.0008 * step);
      }
      const erosion = this.viab.tick(step); // 维持自身组织的基础代谢：活着不花钱的话，viability 就是装饰
      if (erosion) this.noteErosion(erosion, t);
      // M4：正式连续世界里随基础代谢一起每刻一次；研究态在 tick 顶部按旧位置结算。
      if (this.ch.coupling && continuousClock && world.independentWorld) this.coupling.tick(step);
      const ch = this.ch;
      const effUtil = ch.util ? this.bank.m : { ...this.traits.baseline };
      if (ch.driveRegulation !== 0) this.drives.regulate(effUtil); // 被调量：警觉。通道②关着就喂基线
      return metab;
    };
    const preMetab = !reuseMetab && world.independentWorld ? (minuteBody ? cognitionStep() : metabolize()) : null;
    // V7.3.2 P0：被 episode 配额挡下的居民只结算基础代谢/感知，不做自主决策。
    if (this.fairSuppress) {
      const metab = reuseMetab ? this.lastMetab : (preMetab ?? metabolize());
      this.lastMetab = metab;
      this.lastMetabTick = t;
      return null;
    }

    for (const p of percepts) {
      for (const r of REFLEXES) {
        if (!r.when(p, this.drives)) continue;
        const intent = r.then(p, this.drives);
        if (validate(world, this.id, intent).ok) {
          this.counters.reflex += 1;
          return this.execute(world, intent, 'reflex', t, external.length === 0);
        }
      }
    }

    // V7.2：旧路径里进行中的动作占住这一刻的决策机会（推进由 tickSurvPlay 提前结算）。
    // P1 连续路径：身体忙不等于头脑停——照常感知/评价/决策，行动由 execute 以 BUSY trace 拒绝。
    if (residentTimeModel(world) && !world.simClock && clockOf(world, this.id).busy) return null;

    const metab = reuseMetab ? this.lastMetab : (preMetab ?? (minuteBody ? cognitionStep() : metabolize()));
    this.lastMetab = metab;
    this.lastMetabTick = t;
    return this.decideOn(world, { metab, reason, told, silent: external.length === 0 });
  }

  // V7.2：把"选一个动作并执行"从 tick 里拆出来。代谢/感知/反射只在 tick 里结算一次；
  // 个人时间模型允许同一刻再追加决策（reason=null ⇒ 不会问模型，模型预算仍在 host 资源层）。
  //
  // P1b-修：本地替身（没问模型）必须**同步**结算完，不能只因为 `async` 包装就欠 4~6 个微任务。
  // 连续钟按游戏分钟推进，一次 `await Promise.resolve()` 只够还一个微任务 ⇒ 被包装的决策会在
  // 分钟循环里挂 4~6 分钟（批量 60 分钟一步时更久），把 think 节拍从 10 分/次拖到 ~38 分/次。
  // 因此 decideOn/choose 改为"同步返回值；只有真问模型才返回 Promise"，tick 也不再是 async。
  // 研究态/旧路径都 await 返回值，逐位结果不变；连续路径的决策不再依赖批次/微任务排队。
  decideOn(world, { metab, reason = null, told = false, silent = true, sameKind = null } = {}) {
    this.world = world;
    const t = world.t;
    const { ch, prediction } = metab;
    const affs = affordancesFor(world, this.id);
    const weights = ch.precision ? prediction.weights : null;
    const visible = visibleActions(affs, this.traits, ch, this.bank, weights);
    // 被喊住：这几刻不换地方（仍要决定做什么，只是去掉移动路径）。
    // 不用"冻结整个 tick"：那样它会连带停止吃喝与反应，测到的就不是"站着别动"而是"死机"。
    let paths0 = isHailed(world, this.id) ? visible.filter((p) => p.kind !== 'move_to') : visible;
    // 同一刻的追加动作只沿着同一个动作继续（采集完再采集），不重新规划人生；
    // 否则一次 tick 里"采集→存仓→再跑一趟"会把家庭目标冲掉。
    if (sameKind) paths0 = paths0.filter((p) => p.kind === sameKind);
    if (!paths0.length) return null;
    // M3 行为状态：在习惯/审议之前先定功能目标，承诺期内只保留落在该目标上的候选。
    // 只过滤候选集——评分、习惯分支、真模型、驳回重决策、告知都还是原来的链条，所以它"承重"的方式是改变比较而不是加常数。
    let paths = ch.m3 ? this.m3Choose(world, paths0) : paths0;
    if (ch.m3) {
      // 目标过滤后再兜底一次：每刻最多保留 1 个 talk 候选（仅 m3=on）。
      const rest = paths.filter((p) => p.kind !== 'talk');
      const one = paths.find((p) => p.kind === 'talk') ?? paths0.find((p) => p.kind === 'talk');
      if (one) rest.push(one);
      paths = rest;
    }

    const mem = this.condition === 'C0' ? { bonus: {}, retrieved: [] } : this.memory.stateBonus(this.bank.m, affs, t, { stateChannel: Boolean(ch.mem), precision: weights });
    const memBonus = mem.bonus;
    this.lastMemories = mem.retrieved; // 通道④ 对模型可见的那一行：想起的事
    // 存续风险：⑤ 关着就传 0。注意 viab.tick() 在上面已经跑过了——**演化不受开关影响，只有"进不进比较"受**，
    // 和 C2-neg 让 m 照常演化是同一个口径，否则对照组连"它有没有撑不住"都测不出来。
    const risk = this.viabilityRisk();
    const scored = scoreAll(paths, { drives: this.drives, traits: this.traits, bank: this.bank, ch, memBonus, risk, exploreGate: ch.lpExplore ? this.lpProgress() : 0, exploreIds: ch.lpExplore ? this.explorationIds(paths) : null });
    const temp = temperatureOf(this.traits, ch, this.bank);
    // O1-M（PLAN §23.1）：反事实影响度。默认关（cfUsage:0）⇒ 这一步与下面习惯分支里的计数都不执行，零开销、轨迹逐位不变。
    if (ch.cfUsage) this.noteInfluence({ world, paths, scored, memBonus, risk, weights });

    const hb = ch.habitChoice === 0 ? null : this.habit.best();
    // R1（第二次审计 P0）：习惯分支**原先不做任何规则校验**就直接 execute ——
    // "规则层是唯一裁决者"因此是假的。实测 50159 次执行里 693 次非法动作真的改了世界：
    // 607 次夜里 look_out（LOCKED_HOUR）、86 次空缸 eat（DEPLETED）。这里先验一次：
    // 非法就不许走捷径，落回下面的审议层由规则层裁决（而不是静默什么都不做）。
    const hbPick = hb ? scored.find((s) => s.id === hb.id) : null;
    const habitLegal = Boolean(hbPick) && validate(world, this.id, hbPick.act).ok;
    // O9-M（PLAN §23.2）：有登记在册的事件时，习惯不得抢先接管——否则"四类事件才问模型"实测只对一半成立
    // （§47.3：587 次触发只有 294 次真问到，习惯截流 40.5%）。反射层**不动**：alarm/缺口是生存反应，
    // 让它等一次模型往返在线上 6 秒/刻的世界里是可见退化，所以"关键事件"类仍由反射接管，这是设计不是缺陷。
    if (habitLegal && !told && !(ch.eventFirst && reason) && hb && scored[0] && hb.ema >= scored[0].u - temp * 0.5 && scored.some((s) => s.id === hb.id) && this.rng() < 0.7) {
      // 习惯的"改变"只在它真的接管时计：习惯选中 ≠ 评分第一名（PLAN §23.1 的基线口径：argmax，不是抽样结果）
      if (ch.cfUsage) {
        const pick = hbPick;
        const top = scored.reduce((best, x) => (x.u > best.u ? x : best), scored[0]);
        if (pick && pick.id !== top.id) this.counters.cfHabit = (this.counters.cfHabit ?? 0) + 1;
      }
      this.counters.habit += 1;
      return this.execute(world, hbPick.act, 'habit', t, silent, { temp, scored });
    }

    this.counters.deliberation += 1;
    const ctx = { world, t, silent, ch, temp, scored, paths };
    const chosen = this.choose({ scored, temp, ch, world, paths, reason });
    return isThenable(chosen) ? chosen.then((pick) => this.landDecision(pick, ctx)) : this.landDecision(chosen, ctx);
  }

  // decideOn 的后半段：规则层裁决 + 一次驳回重决策 + 执行。同步返回；只有真问模型时返回 Promise。
  landDecision(chosen, ctx) {
    const { world, t, silent, ch, temp, scored } = ctx;
    const v = validate(world, this.id, chosen.act);
    if (v.ok) return this.execute(world, chosen.act, 'deliberation', t, silent, { temp, scored });
    if (chosen.act.kind === 'repair') recordRepairFailure(world, this.id, world.loc[this.id], v.code);
    recordConstructionBlock(world, this.id, chosen.act.to ?? world.loc[this.id], chosen.act.kind, v.code);
    this.counters.rejected += 1;
    this.noteDayReject(t);
    const rest = scored.filter((s) => s.id !== chosen.id);
    if (!rest.length) return null;
    // 被驳回本身就是"关键事件"：这次一定要问，否则重试永远走替身
    const again = this.choose({ scored: rest, temp, ch, world, paths: rest.map((r) => r.act), rejected: v, reason: '驳回重决策' });
    return isThenable(again)
      ? again.then((pick) => this.landRetry(chosen, pick, ctx, v))
      : this.landRetry(chosen, again, ctx, v);
  }

  landRetry(chosen, again, ctx, v) {
    const { world, t, silent, scored } = ctx;
    this.trace.push({ t, id: this.id, layer: 'rejected', name: this.name, code: v.code, why: v.why, from: chosen.id, to: again.id, m: this.bank.snapshot(), cond: this.condition });
    // BUG-1：重选出来的动作必须再过一次规则层。上一版这里直接把 again 交给 execute，
    // 等于"被驳回一次之后就免检"——实测夜里 eat 被 DEPLETED 驳回、重选到 look_out
    // （validate 明确返回 LOCKED_HOUR）仍然执行，角色夜里上了瞭台。
    // 不无限重试，也不重复计数：一次驳回只记一次 rejected（askedRetry === rejected 这条恒等式靠它）。
    const retryGate = validate(world, this.id, again.act);
    if (!retryGate.ok) {
      if (again.act.kind === 'repair') recordRepairFailure(world, this.id, world.loc[this.id], retryGate.code);
      recordConstructionBlock(world, this.id, again.act.to ?? world.loc[this.id], again.act.kind, retryGate.code);
      // 重选后仍非法 ⇒ 本刻不行动。但仍然留一条 trace（带 scored、不带 action），
      // 否则引擎内的 cfDecisions 会比"从 trace 独立重算的决策数"多出来，
      // o1-counterfactual 的装置交叉核对（两条实现必须一致）就会红。
      this.trace.push({ t, id: this.id, layer: 'aborted', name: this.name, code: 'RETRY_ILLEGAL', why: `${again.id} 重选后仍不合法`, from: chosen.id, to: again.id, action: null, m: this.bank.snapshot(), scored, cond: this.condition });
      return null;
    }
    return this.execute(world, again.act, 'deliberation', t, silent, { temp: ctx.temp, scored });
  }

  // 审议层：插了 deliberator 且**这一刻有事件**才走真模型，否则走确定性替身。
  // 注意这里不再构造任何提示词 —— 提示词由 deliberator 自己建（见 loop-real.mjs / host.modelBrain），
  // 目的是让「效用数字」在结构上没法泄漏进模型视野，而不是靠自觉。
  // 返回同步的 picked，或（只有真问模型时）一个 Promise<picked>；调用方按 thenable 判断。
  choose({ scored, temp, ch, world, paths, rejected, reason = null }) {
    const ask = Boolean(this.deliberator) && Boolean(ch.ask) && reason !== null;
    if (!ask) {
      // 有模型但这一刻没有事件 ⇒ 自主层自己决定。skipped 是"事件门控在起作用"的直接读数
      if (this.deliberator) this.counters.skipped += 1;
      return softmaxPick(this.rng, scored, temp).picked;
    }
    this.counters.asked += 1;
    this.counters.llmCalls += 1;
    // 第五类触发：被规则驳回后的重决策。它不在 triggerReason 的四类里（那是"世界发生了一件事"），
    // 但同样必须计入预算，否则 asked > triggered 这种差额会变成一个没人能解释的数
    if (reason === '驳回重决策') this.counters.askedRetry = (this.counters.askedRetry ?? 0) + 1;
    const settle = (r) => {
      const hit = scored.find((s) => s.id === r?.id || s.kind === r?.kind);
      // 模型不可用（超预算/端点抖动/返回清单外动作）时退回替身抽样，而不是 argmax：
      // argmax 会让 A/B 两个世界一起变呆，把「通道差异」压平成「都选第一名」，等于自己造出一个假阴性
      if (hit) return hit;
      this.counters.fallback = (this.counters.fallback ?? 0) + 1;
      return softmaxPick(this.rng, scored, temp).picked;
    };
    const r = this.deliberator({ world, agent: this, paths, scored, temp, ch, rejected, trigger: reason, summary: this.bank.summary(), memories: this.lastMemories ?? [], daySummary: this.daySummary(world.t) });
    return isThenable(r) ? r.then(settle) : settle(r);
  }

  // S2：收到一条意图消息。后果只有三件——关系（调用方已按规则表改）、情景记忆、计数。
  // 仍然只有规则层能改世界：这里不碰 store/pinv/位置。
  receiveMessage(world, msg) {
    const rec = { t: world.t, id: this.id, name: this.name, layer: 'message', from: msg.from, act: msg.act, topic: msg.topic, text: msg.text, served: msg.served };
    this.counters.messages = (this.counters.messages ?? 0) + 1;
    this.trace.push(rec);
    this.lastMessage = rec;
    return rec;
  }

  // S3：被告知一条秘密。认知后果只有两件事——known 集合（由调用方改）与一次评价注入。
  // ⑨ 关掉时**只留痕迹不注入**：这样"传过话"的运行能与"没传话"逐动作比对（负向对照要求它必须相同）。
  receive(world, secret, fromId) {
    const rec = { t: world.t, id: this.id, name: this.name, layer: 'informed', secret: secret.id, about: secret.about, detail: secret.detail, from: fromId, m: this.bank.snapshot(), cond: this.condition };
    this.counters.informed += 1;
    if (!this.ch.gossip) {
      rec.dropped = true;
      this.trace.push(rec);
      return rec;
    }
    // 当场注入：上一版把注入推迟到下一次 tick，结果世界暂停时"告知"只改了 known 集、内部状态一动不动
    // （实测：known 变了、信任没变）。玩家做的动作，后果必须在那一刻发生。
    // about 必须指向**当事人（holder）**而不是"受影响的受害者"：评价层拿 about 去扣信任，
    // 指向受害者会变成"岑 因为被偷而降低对自己的信任"（上一版就这么错的）。受害者仍在记录里（detail/about）。
    this.world = world;
    this.assess({ kind: 'informed', valence: secret.valence, selfCaused: false, about: secret.holder, violates: secret.violates, serves: 'safety' });
    this.informedTick = world.t; // 只用来给思考层一个触发理由
    this.trace.push(rec);
    return rec;
  }

  // 四类触发 + 被告知（S3 加的第六类）
  triggerReason(ctx = {}) {
    if (ctx.informed) return '被告知秘密';
    if (ctx.alarm) return '关键事件';
    if (ctx.contact) return '遭遇';
    if (ctx.discovery) return '发现缺口';
    if (ctx.sunset) return '日落';
    return null;
  }

  // D4：把"这一天的账"做成可持久化的计数器，供 ⑦ 反思读取。
  // 只在跨天时归零，所以即使 reflect 关着也不会跨天累计。
  rollDay(day) {
    if (this.dayTally.day !== day) this.dayTally = { day, decisions: 0, byDriver: {}, norm: 0, rejected: 0 };
  }
  noteDay(t, driver = 'none', norm = false) {
    this.rollDay(dayOf(t));
    this.dayTally.decisions += 1;
    this.dayTally.byDriver[driver] = (this.dayTally.byDriver[driver] ?? 0) + 1;
    if (norm) this.dayTally.norm += 1;
  }
  noteDayReject(t) {
    this.rollDay(dayOf(t));
    this.dayTally.rejected += 1;
  }

  // ⑦ 反思回合：把这一天压成一条自传体记忆。**只写记忆，不动 m、不动效用**——
  // 巩固对内部状态的影响属于 M6，现在做就等于把两个里程碑的效应混成一团。
  reflect(world) {
    this.rollDay(dayOf(world.t));
    const t = this.dayTally;
    if (!t.decisions && !t.rejected) return null;
    const tally = { ...t.byDriver };
    const top = Object.entries(tally).sort((a, b) => b[1] - a[1])[0] ?? ['none', 0];
    const text = `第 ${dayOf(world.t) + 1} 天：做了 ${t.decisions} 个决定，多数由「${top[0]}」驱动；越轨 ${t.norm} 次，被驳回 ${t.rejected} 次`;
    this.memory.add(world.t, { kind: 'reflect', payload: text, mSnapshot: this.bank.snapshot(), importance: 0.6 });
    this.counters.reflect += 1;
    this.trace.push({ t: world.t, id: this.id, name: this.name, layer: 'reflect', text, drivers: tally, m: this.bank.snapshot(), cond: this.condition });
    return text;
  }

  // 给思考层看的那一行"上一天的自己"。检索不到就返回 null——⑦ 关掉后必须永远读不到（闸门验这条）
  daySummary(t) {
    const rows = this.memory.rows.filter((r) => r.kind === 'reflect');
    return rows.length ? rows[rows.length - 1].payload : null;
  }

  // 存续风险的唯一切断点。写成方法而不是在 tick 里内联三元表达式，是为了让"⑤ 关着必须为 0"
  // 这件事能被直接断言——注意 hashSeed 把 channelMask 也编进了种子，所以引擎层不存在"同种子的开关对照"，
  // 想验证切断只能在这个点上验（S1 实测踩到的）。
  viabilityRisk() {
    return this.ch.viab ? this.viab.risk : 0;
  }

  noteErosion(row, t) {
    this.counters.erosion += 1;
    this.trace.push({ t, id: this.id, name: this.name, layer: 'erosion', organ: row.organ, before: row.before, after: row.after, cause: row.cause, m: this.bank.snapshot(), cond: this.condition });
  }

  // M3：快照只取公开可预测的量（位置、公仓、自身需求与设定点、同屋者熟悉度）；私人物资与他人未来行为不进预测。
  m3Snapshot(world) {
    const loc = world.loc[this.id];
    const companions = {};
    for (const id of world.occupancy[loc] ?? []) if (id !== this.id) companions[id] = this.relations.map.get(id)?.familiarity ?? 0;
    // look_out/take_shared 的"可不可行"是当前可观察事实，不是对未来的预测：
    // 夜禁来自时钟；可越轨的对象 = 不在场且门口还有货的人（在场会被规则层判 WITNESSED，先排除掉）。
    const takeable = {};
    for (const id of Object.keys(world.agents)) {
      if (id === this.id || (world.stash[id] ?? 0) <= 0 || world.loc[id] === loc) continue;
      takeable[id] = world.riskyPortion ?? PARAMS.risky.portion;
    }
    // PLAN §28：房间表随世界预设走；规划器的合法性校验以这份为准（lab 下键集与原 KNOWN_LOCS 相同）。
    return { selfId: this.id, loc, locs: Object.keys(world.locs ?? {}), energy: this.drives.v.energy, social: this.drives.v.social, pantry: Number.isFinite(world.pantry) ? world.pantry : (world.survival?.store ?? 0), energySetpoint: this.drives.setpoint.energy, socialSetpoint: this.drives.setpoint.social, companions, lookOutLegal: !isNight(world.t), takeable };
  }

  m3Choose(world, paths) {
    const M3_KINDS = new Set(['rest', 'eat', 'move_to', 'talk', 'look_out', 'take_shared']);
    // V7.4.1 修复：规划器只接受白名单 kind、有限成本、唯一 id；生存候选先做最小 sanitize，不重写规划器。
    const source = paths.filter((p) => !COUPLING_KINDS.includes(p.kind) && !['work', 'buy', 'trade', 'companion'].includes(p.kind) && M3_KINDS.has(p.kind));
    const planned = [];
    const rev = new Map();
    source.forEach((p, i) => {
      const id = `${p.id}:m3:${i}`;
      planned.push({ ...p, id, cost: Number.isFinite(p.cost) ? p.cost : costFor(p.kind).minutes });
      rev.set(id, p.id);
    });
    if (!planned.length) {
      this.m3Last = { previous: this.m3PrevGoal, goal: null, remaining: this.m3Planner.remaining, reused: false, interrupted: 'only_coupling_actions' };
      return this.m3CapTalk(paths);
    }
    let r;
    try {
      r = this.m3Planner.step({ snapshot: this.m3Snapshot(world), actions: planned, catalog: planned });
    } catch {
      // 规划器仍拒绝时退回完整候选集，绝不让 M3 把每拍决策全部吃掉。
      this.m3Last = { previous: this.m3PrevGoal, goal: null, remaining: this.m3Planner.remaining, reused: false, interrupted: 'planner_rejected' };
      this.counters.m3Fallback = (this.counters.m3Fallback ?? 0) + 1;
      return this.m3CapTalk(paths);
    }
    const previous = this.m3PrevGoal;
    this.m3PrevGoal = r.goal;
    this.m3Last = { previous, goal: r.goal, remaining: r.remaining, reused: r.reused, interrupted: r.interrupted };
    this.counters.m3Decisions = (this.counters.m3Decisions ?? 0) + 1;
    if (r.reused) this.counters.m3Reused = (this.counters.m3Reused ?? 0) + 1;
    if (r.interrupted) this.counters.m3Interrupted = (this.counters.m3Interrupted ?? 0) + 1;
    const keep = new Set(r.plans.filter((p) => p.goal === r.goal).map((p) => rev.get(p.first.id) ?? p.first.id).filter(Boolean));
    // 非 M3 白名单的生存动作（采集/建造等）不进规划，但必须保留在候选集，否则 M3 会把人饿死。
    const filtered = paths.filter((p) => keep.has(p.id) || COUPLING_KINDS.includes(p.kind) || !M3_KINDS.has(p.kind));
    if (!filtered.length) {
      this.counters.m3Fallback = (this.counters.m3Fallback ?? 0) + 1;
      this.m3Last.interrupted ??= 'goal_has_no_visible_action';
      return this.m3CapTalk(paths);
    }
    return this.m3CapTalk(filtered);
  }

  // V7.4.1：仅 m3=on 时每刻最多保留 1 个 talk 候选；不改其他 keep 规则。
  m3CapTalk(paths) {
    if (!this.ch.m3) return paths;
    const rest = paths.filter((p) => p.kind !== 'talk');
    const one = paths.find((p) => p.kind === 'talk');
    if (one) rest.push(one);
    return rest;
  }

  // M6-L（PLAN §25.6）：相对进度 g∈[0,1]；slow=0（还没样本）时 g=0 ⇒ 不加探索预算。
  lpProgress() {
    if (!this.lpSlow) return 0;
    return Math.max(0, Math.min(1, (this.lpSlow - (this.lpFast ?? this.lpSlow)) / this.lpSlow));
  }

  // 探索类 = 瞭望 + 还算新的移动（习惯计数 ≤ noveltyMax）。只读，不改状态。
  explorationIds(paths) {
    return new Set(paths.filter((p) => p.kind === 'look_out' || (p.kind === 'move_to' && this.habit.count(p.id) <= PARAMS.lp.noveltyMax)).map((p) => p.id));
  }

  // O1-M（PLAN §23.1）：三项"反事实改变率"里的记忆与关系在这里算；习惯那一项在它真正接管的时刻算。
  // 分母统一 = 非反射决策数（cfDecisions）⇒ 三项同量纲、可直接比较（旧公式的毛病就是三项不同量纲：§47.2）。
  // 默认关（cfUsage:0）时整段不执行 ⇒ 不消费随机数、不写状态、轨迹逐位不变。
  noteInfluence({ world, paths, scored, memBonus, risk, weights }) {
    this.counters.cfDecisions = (this.counters.cfDecisions ?? 0) + 1;
    const top = scored.reduce((best, x) => (x.u > best.u ? x : best), scored[0]);
    // 记忆：u 可加 ⇒ 直接减掉"记忆"那一项重排（精确，不引入影子重算）
    const noMem = scored.map((s) => ({ id: s.id, u: s.u - (s.parts?.记忆 ?? 0) }));
    const topNoMem = noMem.reduce((best, x) => (x.u > best.u ? x : best), noMem[0]);
    if (topNoMem.id !== top.id) this.counters.cfMem = (this.counters.cfMem ?? 0) + 1;
    // 关系：中性化后重建候选再重排。候选按 id 对齐，保证与基线是同一批候选；
    // 对齐失败（例如对象化的 refuse 在中性信任下换了目标 id）就跳过这一次并计数，不许静默混进分子。
    const realRel = this.relations;
    try {
      this.relations = { get: () => ({ familiarity: REL_NEUTRAL.familiarity, trust: REL_NEUTRAL.trust }) }; // C1：与真实初值同源，不再写死 50
      const visN = visibleActions(affordancesFor(world, this.id), this.traits, this.ch, this.bank, weights);
      const byId = new Map(visN.map((x) => [x.id, x]));
      const pathsN = paths.map((p) => byId.get(p.id)).filter(Boolean);
      if (pathsN.length !== paths.length) { this.counters.cfRelSkipped = (this.counters.cfRelSkipped ?? 0) + 1; return; }
      const scoredN = scoreAll(pathsN, { drives: this.drives, traits: this.traits, bank: this.bank, ch: this.ch, memBonus, risk, exploreGate: this.ch.lpExplore ? this.lpProgress() : 0, exploreIds: this.ch.lpExplore ? this.explorationIds(pathsN) : null });
      // 影子路径的活性读数：中性化到底有没有动过任何一个候选的效用。
      // 没有它的话，"cfRel 恒 0"分不清是"关系不影响第一名"（数据）还是"中性化没接上"（bug）——变异电池实测踩到过。
      const moved = pathsN.some((p) => {
        const real = scored.find((s) => s.id === p.id);
        const neu = scoredN.find((s) => s.id === p.id);
        return real && neu && Math.abs(real.u - neu.u) > 1e-9;
      });
      if (moved) this.counters.cfRelMoved = (this.counters.cfRelMoved ?? 0) + 1;
      const topN = scoredN.reduce((best, x) => (x.u > best.u ? x : best), scoredN[0]);
      if (topN.id !== top.id) this.counters.cfRel = (this.counters.cfRel ?? 0) + 1;
    } finally {
      this.relations = realRel;
    }
  }

  execute(world, action, layer, t, silent, extra = {}) {
    // R1 的结构性兜底：execute 是唯一的效果器入口，所以裁决必须在这里也成立一次。
    // 上面三条路径（反射/习惯/审议）各自都验过了，但"每个调用点各补一遍"正是这个 P0 得以存在的
    // 原因（习惯那条漏了三个月）。这里再验一次：非法就拒绝，并且**不消耗任何资源**。
    const gate = validate(world, this.id, action);
    if (!gate.ok) {
      if (action?.kind === 'repair') recordRepairFailure(world, this.id, world.loc[this.id], gate.code);
      recordConstructionBlock(world,this.id,action?.to ?? world.loc[this.id],action?.kind,gate.code);
      noteRefusal(world, 'resident', action?.kind);
      this.counters.refused = (this.counters.refused ?? 0) + 1;
      this.trace.push({ t, id: this.id, layer: 'refused', name: this.name, action: action?.id ?? null, kind: action?.kind ?? null, ok: false, code: gate.code, why: gate.why, m: this.bank.snapshot(), cond: this.condition });
      return null;
    }
    let timeSpent = 0;
    if (world.unifiedCooperation) {
      if (residentTimeModel(world)) {
        // V7.2：居民不再"每刻一次"。在当天/本刻分钟预算内可连续动作；同一时刻只有一个进行中动作。
        const clock = clockOf(world, this.id);
        if (clock.busy) {
          this.trace.push({ t, id: this.id, layer: 'refused', name: this.name, action: action?.id ?? null, kind: action?.kind ?? null, ok: false, code: 'BUSY', why: '手上还有没做完的动作', m: this.bank.snapshot(), cond: this.condition });
          return null;
        }
        const budget = residentBeginTime(world, this.id, action.kind);
        if (!budget.ok) {
          noteRefusal(world, 'resident', action?.kind);
          this.counters.refused = (this.counters.refused ?? 0) + 1;
          this.trace.push({ t, id: this.id, layer: 'refused', name: this.name, action: action?.id ?? null, kind: action?.kind ?? null, ok: false, code: budget.code, why: legacyRefusalWhy(budget.code), m: this.bank.snapshot(), cond: this.condition });
          return null;
        }
        if (budget.staged) {
          // 装不下本刻剩余分钟：转成进行中动作，下一（几）刻推进；这一下不产生效果。
          attachBusyAction(world, this.id, action);
          return { action, ok: true, code: 'BUSY_START', staged: true, remainMin: budget.remainMin };
        }
        timeSpent = budget.minutes ?? 0;
        // 体力门：普通劳动要先有体力，否则连开工都不行（不会白扣时间）。
        const energyCost = laborEnergy(action.kind, world);
        if (energyCost > 0 && (this.drives?.v?.energy ?? 0) + 1e-9 < energyCost) {
          residentRefundTime(world, this.id, timeSpent);
          noteRefusal(world, 'resident', action?.kind);
          this.counters.refused = (this.counters.refused ?? 0) + 1;
          this.trace.push({ t, id: this.id, layer: 'refused', name: this.name, action: action?.id ?? null, kind: action?.kind ?? null, ok: false, code: 'STAMINA', why: '体力不够做这件活', m: this.bank.snapshot(), cond: this.condition });
          return null;
        }
      } else {
        const spent = world.survival.residentActionsAt ??= {};
        if (spent[this.id] === world.t) return null;
        spent[this.id] = world.t;
      }
    }
    const result = actuate(world, this.id, action);
    // 失败的动作退还个人时间：误点/被驳回不占当天预算。
    if (timeSpent > 0 && !result?.ok) residentRefundTime(world, this.id, timeSpent);
    // 行动要消耗存续（贵动作更耗）；吃到东西按进食量补回**存续**，但补不回已被侵蚀的部件——这就是 D1
    const actionCost = (world.unifiedCooperation ? SURV_COST[action.kind] : undefined) ?? action.cost ?? 0.06;
    let spentNow = null;
    let paid = 0;
    let energyPaid = 0;
    if (residentTimeModel(world)) {
      // V7.2：普通劳动扣体力（drives.energy），viab 只承担长期损耗；力气不够就不扣 viab。
      const energyCost = laborEnergy(action.kind, world);
      if (result?.ok && energyCost > 0) {
        this.drives.v.energy = Math.max(0, this.drives.v.energy - energyCost);
        energyPaid = energyCost;
      }
    } else {
      const eBeforeSpend = this.viab.v + this.viab.reserve;
      spentNow = this.viab.spend(actionCost);
      paid = Number((eBeforeSpend - (this.viab.v + this.viab.reserve)).toFixed(6)); // 实际扣掉的：v 归零时少于名义值
    }
    if (spentNow) this.noteErosion(spentNow, t);
    // E2/E3：玩家与居民同一口径的累计账本（时间/体力/劳动成败；位置同步不在此处进账）。
    noteAction(world, 'resident', action?.kind, !!result?.ok, layer, {
      minutes: result?.ok ? timeSpent : 0,
      energy: energyPaid,
      labor: isLaborAction(action.kind),
    });
    // 记录用四舍五入，喂给模型的必须是原值：进食量是 0.26+0.24×熟悉度 这类带小数的量，舍一下就会改变收支
    const ateAmount = result.ok && result.satiated === 'energy' ? result.amount ?? 0 : 0;
    const eBeforeRegen = this.viab.v + this.viab.reserve;
    if (ateAmount) this.viab.regen(ateAmount);
    const fed = Number((this.viab.v + this.viab.reserve - eBeforeRegen).toFixed(6)); // 实际到账的：两个账户都满时这一口会被丢掉
    const evt = result.evt ?? { kind: 'thwarted', valence: -0.4, selfCaused: true };
    const a = this.assess(evt, action.kind, result.ok);

    if (result.ok && result.satiated) {
      let amount = result.amount ?? 0.1;
      if (result.contactWith) {
        const rel = this.relations.meet(result.contactWith, t, { delta: { familiarity: 0.07, trust: 3 } });
        amount = 0.26 + 0.24 * rel.familiarity; // 社交满足取决于对象熟悉度 ⇒ 关系有功能意义
      }
      this.drives.reward(result.satiated, amount);
    }
    if (result.violates) this.counters.normbreak += 1;
    // M4：耦合动作一旦被执行就记账（S1 看的就是这个数；按 kind 的分布从 trace 里数，不建嵌套计数器——
    // ablationChannels 会对 counters 逐项求和，嵌套对象会把消融表加成 NaN）
    if (result.coupling) this.counters.couplingApplied = (this.counters.couplingApplied ?? 0) + 1;

    const id = actionId(action);
    const uAtDecision = extra.scored?.find((s) => s.id === id)?.u ?? 0.1;
    this.habit.observe(id, result.ok ? uAtDecision : -0.2, this.ch.plasticGate ? (this.plasticGateNow ?? 1) : 1);

    this.counters.actions += 1;
    if (result.ok) world.observeResidentAction?.({ id: this.id, t, kind: action.kind, cooperation: Boolean(action.cooperation), goal: action.goal, paid, energyPaid });
    if ((world.unifiedCooperation || world.autonomousGoals) && result.ok) {
      const audit = world.survival.actionAudit ??= {};
      const row = audit[this.id] ??= { ordinary: {}, cooperation: {}, paid: 0 };
      const counts = action.cooperation ? row.cooperation : row.ordinary;
      counts[action.kind] = (counts[action.kind] ?? 0) + 1;
      row.paid += paid;
      if (action.goal) {
        const goals = row.goals ??= {};
        const goal = goals[action.goal] ??= {};
        goal[action.kind] = (goal[action.kind] ?? 0) + 1;
      }
    }
    if (silent && result.ok) {
      this.counters.spontaneous += 1;
      if (['talk', 'take_shared', 'look_out'].includes(action.kind) || (action.kind === 'move_to' && (world.occupancy[action.to] ?? []).length > 0)) this.counters.initiated += 1;
    }
    const entry = extra.scored?.find((s) => s.id === id);
    const driverOf = entry?.driver ?? (layer === 'reflex' ? '反射' : layer === 'habit' ? '习惯' : 'none');
    // D4：当天账累积在状态里（不是每次从 trace 现算）。trace 不落盘、还会被 TRACE_CAP 裁掉，
    // 重启后现算会把"做了 23 个决定"写成"3 个"，并且那段文字会被永久写进自传体记忆。
    this.noteDay(t, driverOf, result.ok && action.kind === 'take_shared');
    this.trace.push({
      t, id: this.id, name: this.name, layer, action: id, kind: action.kind, target: action.target ?? action.to ?? null,
      tickStart: this.tickStart?.t === t ? this.tickStart : null,
      ok: result.ok, obs: result.observation, m: this.bank.snapshot(), drives: { ...this.drives.v }, dep: this.drives.describe(),
      driver: driverOf, parts: entry?.parts ?? null,
      appraisal: a.parts, importance: Number(a.importance.toFixed(3)), rel: this.relations.dump(t), summary: this.bank.summary(), cond: this.condition,
      m3: this.ch.m3 ? this.m3Last : null,
      viab: { v: Number(this.viab.v.toFixed(3)), reserve: Number(this.viab.reserve.toFixed(3)), risk: Number((this.ch.viab ? this.viab.risk : 0).toFixed(3)), ledger: this.viab.ledger.length, cost: Number(actionCost.toFixed(3)), ate: Number(ateAmount.toFixed(3)), paid, fed },
      ...extra,
    });
    return { id, ...result };
  }
}










