import { worldSite } from './geometry.mjs';
import { changeRoad, roadCandidate } from './home-roads.mjs';
import { homeEntry, householdAccess } from './home-access.mjs';
import { discussionAction, discussionPaths, discussionSupport } from './settlement-social.mjs';
import { till } from './farmland.mjs';
import { goalCandidates } from './goals.mjs';
import { householdPlans, houseLabor, laborAllowed, strictLifecycle } from './households.mjs';
// L1 载体：第一个 Body adapter。只翻译世界，不携带任何决策语义（§4）。
// 修订③（同需求多路径）：动作从「每种一个」改成「带对象/带目的地的一条条路径」。
// 为什么要动这一层：P1b 实测人格参数几乎不改变行为（KL 0.0084），因为同一个需求当时只有一条满足路径
// ——talk 的对象被硬写成 others[0]、wander 是固定循环。没有分岔，偏好就没有可表达的地方。
// 引擎不因此改动；这正说明人格承重的瓶颈在世界侧。
import { PARAMS } from './params.mjs';
import { scheduledLoc, weatherFor, dayOf, survivalPhaseOf } from './clock.mjs';
import { reachableOf, COUPLING_EFFECTS } from './coupling.mjs';
import { presetOf } from './presets.mjs';
import { initSurvival, advanceSurvival, maturePlots, doHarvest, doPlant } from './worldstate.mjs';
import { BUILDINGS, gatherResource, doGather, doPlan, doBuild, doRepair, doForage, forageRule, doExchange, doExpand, EXCHANGE, EXPAND, EXPAND_LABEL, PRODUCE_LABEL, LIVESTOCK_CAP, PRODUCE_CAP } from './production.mjs';
import { initCoop, stepCooperation, cooperationCandidate } from './cooperation.mjs';

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
  // Phase A 生存模式动作（仅 survival 候选会出现，lab/town 不受影响）。
  house_work: { impulse: .4, cost: .08, label: '为自己的房子加工木石' },
  harvest: { impulse: 0.3, cost: 0.08, label: '收获成熟菜畦入仓' },
  road_lay: { impulse:.25,label:'修住宅小路' },
  road_remove: { impulse:.23,label:'移除住宅小路' },
  discuss_open: { impulse:.15, label:'发起集体讨论' },
  discuss_join: { impulse:.15, label:'参加讨论' },
  discuss_decline: { impulse:.08, label:'谢绝讨论' },
  discuss_share: { impulse:.08, label:'继续交换意见' },
  discuss_leave: { impulse:.08, label:'离开讨论' },
  till: { impulse: 0.3, label: '开垦一块新田' },
  plant: { impulse: 0.25, cost: 0.06, label: '在空菜畦播种' },
  // Phase B 建设动作（仅 survival）。
  gather: { impulse: 0.3, cost: 0.07, label: '采集木石' },
  plan: { impulse: 0.2, cost: 0.05, label: '勘察并奠基' },
  build: { impulse: 0.3, cost: 0.1, label: '施工' },
  repair: { impulse: 0.2, cost: 0.06, label: '维修建筑' },
  // §15 P2-C：公仓存取。只由玩家/合作动作触发，不进候选集。
  deposit: { impulse: 0.05, cost: 0.02, label: '存入公仓' },
  withdraw: { impulse: 0.05, cost: 0.02, label: '从公仓取出' },
  // §17 产出循环：仅在 survival 候选里出现，lab/town 的候选集逐位不变。
  forage: { impulse: 0.2, cost: 0.05, label: '采一捧浆果' },
  exchange: { impulse: 0.15, cost: 0.03, label: '兑换收成' },
  expand: { impulse: 0.2, cost: 0.08, label: '扩建蓄养或果树' },
};

// P0-1 统一生命闸：单一来源在 viability（叶模块），这里转出口供 survplay/cooperation 使用。
export { isAlive, livingResidents } from './viability.mjs';
import { isAlive, livingResidents } from './viability.mjs';

// P0-2 统一基础行动成本：玩家与 AI 同一动作付同一存续代价（execute 与 survAct/camp 共用此表）。
// 数值与原 affordancesFor 候选逐字相同 ⇒ AI 轨迹不变；玩家侧从此按同表结算，不再免费劳动。
export const SURV_COST = Object.freeze({
  road_lay:.09, road_remove:.07, discuss_open:.05, discuss_join:.04, discuss_share:.035, discuss_decline:.015, discuss_leave:.015,
  house_work: 0.08, harvest: 0.08, plant: 0.06, till: 0.1, gather: 0.07, plan: 0.05, build: 0.1, repair: 0.06,
  deposit: 0.03, withdraw: 0.03, forage: 0.12, exchange: 0.12, expand: 0.15, move_to: 0.06,
});

// §30：town 的三个社会门槛原先直接写死在候选式里，扫描装置碰不到它们。提成一份可覆盖的常量，
// 默认值与原式逐位相同；只有 world.townGates 显式给值时才偏离（产品默认档一个都不覆盖，§30 G4）。
// 刻意不进 PARAMS/冻结指纹：它们是世界配置而非决策量纲，进指纹会让 lab 五份面报漂移。
// 覆盖值不进存档与 /world 载荷——扫描只服务 §30 的取舍表。
export const TOWN_GATES = Object.freeze({ tradeTrust: 30, compFam: 0.3, compTrust: 32 });
const townGates = (world) => (world.townGates ? { ...TOWN_GATES, ...world.townGates } : TOWN_GATES);

// §33 工坊当日上限。`world.workCap` **不设＝无上限＝现行为逐位相同**（W0 中立性）。
// 为什么必须是"次数上限"而不是"降价"：一次 work 换回的存续（≥0.063）远大于它的代谢代价
// （costScale 0.01 × cost 0.1 = 0.001），所以砍收入只会被"再干一次"吸收——§32 与坏天预扫两次实测都是这个形状。
// 额度记在 world.workLog[id]={day,n}，靠 dayOf(world.t) 自比对换天，不引入任何外部时钟；
// 上限是"工坊一天收几次工"这条世界事实，不是角色的能力被削弱。
export function workUsedToday(world, agentId) {
  const rec = world.workLog?.[agentId];
  return rec && rec.day === dayOf(world.t) ? rec.n : 0;
}

export function workCapLeft(world, agentId) {
  if (world.workCap === undefined || world.workCap === null) return Infinity;
  return Math.max(0, world.workCap - workUsedToday(world, agentId));
}

// 喊住：玩家隔着房间喊一声，被喊的人会停在原地几刻（不进 move_to）。
// 为什么需要它：角色每刻都可能移动，玩家永远追不上，"同屋传话"就成了竞态（实测连追 20 秒没追上）。
// 它是**路径过滤**而不是冻结：被喊住的人仍在做决定，只是这一小段时间里不换地方——所以它不是作弊，
// 只是把"我叫你等一下"这件事变成可执行的动作。
export function hail(world, targetId, ticks = 3) {
  if (!world.loc[targetId]) return { ok: false, code: 'NO_TARGET' };
  // BUG-20：ticks 来自 HTTP 载荷，Infinity / NaN 都会直接写进世界状态。
  // Infinity ⇒ 目标永远不换地方；NaN ⇒ 静默无效但返回 ok。这里钳到 [1, 60]。
  const n = Number(ticks);
  if (!Number.isFinite(n)) return { ok: false, code: 'BAD_TICKS' };
  const span = Math.min(60, Math.max(1, Math.round(n)));
  world.hail = { target: targetId, until: world.t + span };
  return { ok: true, code: 'OK', target: targetId, until: world.hail.until };
}

export const isHailed = (world, id) => Boolean(world.hail && world.hail.target === id && world.t < world.hail.until);

export function makeWorld({ pantries = 6, stash = 3, riskyPortion = PARAMS.risky.portion, scheduleWeight = PARAMS.schedule.weight, socialGossip = PARAMS.socialGossip, preset = 'lab', seed = 0, coop = false }) {
  const P = presetOf(preset);
  const w = {
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
  // 生存模式独立挂载：lab/town 无 P.survival ⇒ 不新增任何键，逐位不变。
  if (P.survival) { w.survival = initSurvival(w); initCoop(w.survival, coop); }
  return w;
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
  // Phase A：生存世界按日低频推进（host 与 simulate 每 tick 都调 scanSecrets，故在此挂日界调度）。
  // lab/town 无 world.survival ⇒ 直接跳过，逐位不变。
  if (world.survival) advanceSurvival(world);
  // Phase C：AI 合作调度（仅 survival 且 coop 开启；默认关 ⇒ Phase A/B 与 lab/town 逐位不变）。
  if (world.survival) stepCooperation(world);
  for (const id of Object.keys(world.stash)) {
    // B3：expect 缺失时不能假定 3 —— 旧档（或手工档）没有 expect 而 stash 很大时，`?? 3` 会凭空造出
    // 「私藏超额」秘密（幻影套利事实）。缺失就按 stash 自身算，等于「没有超出预期」。
    const expect = world.expect[id] ?? world.stash[id];
    if (world.stash[id] - expect >= 2) addSecret(world, { kind: 'hoard', about: id, holder: id, valence: 0.3, violates: null, detail: `${world.agents[id]?.name ?? id} 门口比预期多 ${world.stash[id] - (world.expect[id] ?? 3)} 份` });
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

// Distant trips consume world time. Occupancy changes once, when the resident arrives.
export function startMove(world,id,to) {
  const from=world.loc[id];
  if (from===to) return;
  const peripheral=loc=>world.districts?.[loc] || world.peripheralHomes?.[loc];
  if (!peripheral(from) && !peripheral(to)) {
    move(world,id,to);
    return;
  }
  const start=worldSite(world,from), end=worldSite(world,to);
  const ticks=Math.max(2,Math.ceil((start && end ? Math.hypot(end[0]-start[0],end[1]-start[1]) : 0)/12)+1);
  (world.survival.districtTravel??={})[id]={from,to,arrive:world.t+ticks};
}

export function move(world, id, to) {
  const from = world.loc[id];
  if (from === to) return false;
  // 防御：from 可能已不在 occupancy（旧档/占位错位），不能对 undefined 直接 .filter，
  // 否则每拍每角色抛 agentError、整条决策环被 catch 吞掉（实测 survplay 因此全线不动）。
  world.occupancy[from] = (world.occupancy[from] ?? []).filter((x) => x !== id);
  if (world.survival && !world.agents[id]?.isPlayer) {
    (world.residentTravel ??= {})[id] = { from, to, t:world.t };
  }
  world.loc[id] = to;
  (world.occupancy[to] ??= []).push(id);
  return true;
}

// M4 消费者③：闭门的人在**别人的**视野与清单里消失。这是"终止耦合"的世界侧证据（P6b 主判据）。
// 防御式：占位 agent（单测/离线消融里的 {id,name}）没有 coupling，必须按可交互处理。
const othersAt = (world, id) => (world.occupancy[world.loc[id]] ?? [])
  .filter(x=>x!==id && !world.survival?.districtTravel?.[x] && reachableOf(world.agents[x]));

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
const crowdForVisit=(world,loc)=>(world.occupancy[loc]??[])
  .some(id=>!world.survival?.districtTravel?.[id] && householdAccess(world,id,loc));

export function affordancesFor(world, agentId) {
  const me = world.agents[agentId];
  const here = world.loc[agentId];
  const present = othersAt(world, agentId);
  const away = Object.keys(world.agents).filter((x) => x !== agentId && world.loc[x] !== here && (world.stash[x] ?? 0) > 0);
  const rel = (id) => (me?.relations ? me.relations.get(id) : { trust: 50, familiarity: 0 });
  const out = [];

  out.push({ id: 'rest', kind: 'rest', label: BASE_KINDS.rest.label, cost: 0.02, impulse: 0.02, serves: { energy: 0.15, stimulation: -0.35 } });

  if ((here === 'home' || here === 'store') && !world.survival) {
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
  const ownHome=world.housing?.[agentId];
  const privateRooms=world.survival?.households ? Object.keys(world.survival.households.deeds) :
    world.housing ? Object.values(world.housing) : [];
  const houseGoal=world.survival?.households ? householdPlans(world,agentId) : null;
  const homeAtNight=ownHome && survivalPhaseOf(world.t)==='夜';
  for (const loc of Object.keys(world.locs ?? LOCS)) {
    if (loc===here) continue;
    if (privateRooms.includes(loc)) {
      if (world.survival.settlementLife ? !homeEntry(world,agentId,loc).ok ||
          (loc===ownHome ? !homeAtNight : !crowdForVisit(world,loc)) : loc!==ownHome || !homeAtNight) continue;
    }
    const crowd = (world.occupancy[loc] ?? []).filter(x=>x!==agentId && !world.survival?.districtTravel?.[x]);
    if (world.districts?.[loc] && !crowd.length && houseGoal!==loc && !world.survival.sites.some(s=>s.loc===loc) &&
        !world.survival.buildings.some(b=>b.loc===loc)) continue;
    const shelter=world.survival?.settlementLife && world.survival.buildings.some(b=>b.type==='shelter' && b.loc===loc && b.integrity>0);
    const serves=shelter?{energy:.65,safety:.38}:loc===houseGoal?{energy:.7,safety:1,stimulation:1}:loc===ownHome?{energy:.46,safety:.2}:crowd.length ? { social: 0.55, stimulation: 0.2 } : loc === 'watch' ? { stimulation: 0.6 } : loc === 'store' || loc === 'home' ? { energy: 0.35 } : (feats.work && loc === 'workshop') ? { energy: 0.35, stimulation: 0.2 } : { stimulation: 0.25 };
    out.push({ id: `move_to:${loc}`, kind: 'move_to', to: loc, label: `走到${(world.locs ?? LOCS)[loc] ?? loc}`, cost: 0.06, impulse: 0.15, serves });
  }

  out.push({ id: 'look_out', kind: 'look_out', label: BASE_KINDS.look_out.label, cost: 0.18, impulse: 0.85, serves: { social: 0.3, stimulation: 1 } });

  // PLAN §28 B/C：只在 town 出现的动作（lab 的候选集与旧版逐位相同）。
  if (feats.work && here === 'workshop' && workCapLeft(world, agentId) > 0) {
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

  // Phase A/B 生存模式：只有 survival 才出现这些候选。lab/town 无 world.survival ⇒ 不出现。
  if (world.survival) {
    // §15.4 状态依赖紧迫度：公仓低时抬收获/播种的能量权重，让 AI 在聚落饥饿时真种地（系数挂开关供网格）
    const s0 = world.survival;
    const pop0 = livingResidents(world).length; // P0-1：人口统计排除死者
    // §15.7 R1：农夫用更高阈值＋更强 boost（持久驻菜园动机）；其余居民原口径
    const isFarmer = s0.roleFarmer === true && agentId === s0.farmerId;
    const thr = pop0 * (isFarmer ? 3 : (s0.urgencyThreshold ?? 1));
    const urg = s0.store < thr ? (isFarmer ? 1.2 : (s0.urgencyBoost ?? 0.8)) : 0;
    // §15.5 M1：饥饿驱动去菜园、有料驱动去空位奠基（移动候选挂紧迫度，开关供网格）
    // §16 E4b：storeHunger 开时直接用能量 deficit 门控移动候选（饿就去菜园，不等公仓阈值）
    const hungry = s0.storeHunger === true && (world.agents[agentId]?.drives?.v?.energy ?? 1) < (s0.hungerGate ?? 0.4); // §17 L2 门控宽度
    if ((urg > 0 && (s0.moveUrgency === true || isFarmer)) || hungry) {
      if (here !== 'garden') out.push({ id: 'move_to:garden', kind: 'move_to', to: 'garden', label: '去菜园', cost: 0.05, impulse: 0.2, serves: { energy: urg } });
      const bagM = (world.pinv ?? {})[agentId] ?? { wood: 0, stone: 0 };
      const affordable = Object.entries(BUILDINGS).find(([, d]) => bagM.wood + s0.inv.wood >= d.cost.wood && bagM.stone + s0.inv.stone >= d.cost.stone);
      const hereFree = !s0.sites.some((x) => x.loc === here) && !s0.buildings.some((x) => x.loc === here);
      if (affordable && hereFree) {
        const free = (world.outdoor ?? []).find((l) => l !== here && !s0.sites.some((x) => x.loc === l) && !s0.buildings.some((x) => x.loc === l));
        if (free) out.push({ id: `move_to:${free}`, kind: 'move_to', to: free, label: `去${(world.locs ?? {})[free] ?? free}奠基`, cost: 0.05, impulse: 0.2, serves: { stimulation: urg } });
      }
    }
    if (here === 'garden') {
      if (maturePlots(world.survival).length) out.push({ id: 'harvest', kind: 'harvest', label: BASE_KINDS.harvest.label, cost: SURV_COST.harvest, impulse: 0.3, serves: { energy: 0.8 + urg } });
      if (world.survival.plots.some((p) => p.growth === 0)) out.push({ id: 'plant', kind: 'plant', label: BASE_KINDS.plant.label, cost: SURV_COST.plant, impulse: 0.25, serves: { energy: 0.3 + urg * 0.7 } });
    }
    if (houseLabor(world,agentId)) out.push({ id: 'house_work', kind: 'house_work', label: BASE_KINDS.house_work.label, cost: SURV_COST.house_work, impulse: BASE_KINDS.house_work.impulse, serves: { safety: 1, stimulation: .9, energy: .55 } });
    const resource=gatherResource(world,here);
    if (resource && (s0.resStock?.[here] ?? 0) > 0) out.push({ id: 'gather', kind: 'gather', label: `${BASE_KINDS.gather.label}（${resource === 'wood' ? '木料' : '石料'}）`, cost: SURV_COST.gather, impulse: 0.3, serves: houseGoal===here ? { safety: 1, energy: .65, stimulation: .9 } : { stimulation: 0.55 } });
    // §17 产出循环：AI 与玩家拿到完全相同的候选，走同一套规则层裁决。
    // 刻意低吸引：收种要移到菜园且 energy 收益 0.8+，这些"顺手可做"的动作不能把收种挤掉，
    // 否则无人值守会退化成原地刷产出（E1a/E1g 实测踩到过）。兑换另设 70% 仓容门槛，
    // 避免把公仓顶满后灾害削不动缓冲（P2-4）。
    if ((world.outdoor ?? []).includes(here) && (s0.produce?.berry ?? 0) < (s0.produceCap ?? PRODUCE_CAP) && (s0.forageCd ?? 0) <= world.t && (!s0.wildBerries || forageRule(world,agentId).ok))
      out.push({ id: 'forage', kind: 'forage', label: BASE_KINDS.forage.label, cost: SURV_COST.forage, impulse: 0.05, serves: { energy: 0.08 } });
    // §17 改量#12：所有者裁定 AI 也要能自动兑换，与玩家完全同权。
    // 仍保留 70% 仓容门槛与低吸引力：兑换是"顺手可做"的低优先动作，不能挤掉收种与建设。
    for (const [kind, rate] of Object.entries(EXCHANGE))
      if ((s0.produce?.[kind] ?? 0) >= 1 && !(rate.store && s0.store >= (s0.storeCap ?? 24) * .7))
        out.push({ id: `exchange:${kind}`, kind: 'exchange', type: kind, label: `兑换·${PRODUCE_LABEL[kind]}`, cost: SURV_COST.exchange, impulse: 0.05, serves: { energy: 0.12 } });
    // 扩建只在材料富余时出现：留够一份建筑料，避免把木石吃光拖垮建房（P2-7 实测）。
    for (const [type, cost] of Object.entries(EXPAND))
      if ((s0.livestock?.[type] ?? 0) < LIVESTOCK_CAP && (s0.inv?.wood ?? 0) >= cost.wood + 4 && (s0.inv?.stone ?? 0) >= cost.stone + 3)
        out.push({ id: `expand:${type}`, kind: 'expand', type, label: `扩建·${EXPAND_LABEL[type]}`, cost: SURV_COST.expand, impulse: 0.05, serves: { stimulation: 0.15 } });
    const bag0 = (world.pinv ?? {})[agentId] ?? { wood: 0, stone: 0 };
    const poolW = bag0.wood + world.survival.inv.wood, poolS = bag0.stone + world.survival.inv.stone;
    const site = world.survival.sites.find((s) => s.loc === here);
    const built = world.survival.buildings.find((b) => b.loc === here);
    if (site) out.push({ id: 'build', kind: 'build', label: `${BASE_KINDS.build.label}·${BUILDINGS[site.type]?.label ?? site.type}`, cost: SURV_COST.build, impulse: 0.3, serves: { energy: 0.25, social: 0.1 } });
    else if (!built && (world.outdoor ?? []).includes(here)) {
      for (const [type, def] of Object.entries(BUILDINGS)) {
        if (poolW >= def.cost.wood && poolS >= def.cost.stone)
          out.push({ id: `plan:${type}`, kind: 'plan', type, label: `奠基·${def.label}`, cost: SURV_COST.plan, impulse: 0.2, serves: { stimulation: 0.3 } });
      }
    }
    if (built && built.integrity < 1 && poolW >= 1 && poolS >= 1)
      out.push({ id: `repair:${built.type}`, kind: 'repair', label: `维修·${BUILDINGS[built.type]?.label ?? built.type}`, cost: SURV_COST.repair, impulse: 0.2, serves: { stimulation: 0.2 } });
    // §15 P2-C 公仓存取（同权动作集）：在公仓可存/取个人包
    if (here === 'store') {
      for (const res of ['wood', 'stone']) {
        if (bag0[res] > 0) out.push({ id: `deposit:${res}`, kind: 'deposit', type: res, label: `存${res === 'wood' ? '木' : '石'}入公仓`, cost: SURV_COST.deposit, impulse: 0.1, serves: { social: 0.2 } });
        if (world.survival.inv[res] > 0) out.push({ id: `withdraw:${res}`, kind: 'withdraw', type: res, label: `从公仓取${res === 'wood' ? '木' : '石'}`, cost: SURV_COST.withdraw, impulse: 0.1, serves: { stimulation: 0.15 } });
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
  // P1-1：婴幼儿/儿童不具成年劳动能力——从候选移除劳动类动作（保留移动/休息/交谈/瞭望＝成长与学习）。
  // 仅 households 模式生效；玩家无出生记录＝成年、lab/town 无 households ⇒ 逐位不变。
  for (let i = out.length - 1; i >= 0; i -= 1)
    if (!laborAllowed(world, agentId, out[i].kind)) out.splice(i, 1);
  for (const proposed of goalCandidates(world, agentId)) {
    const ordinary = out.find(a => a.id === proposed.id);
    if (ordinary) {
      if ((ordinary.goalValue ?? 0) < proposed.goalValue) {
        if (proposed.plot !== undefined) ordinary.plot = proposed.plot;
        ordinary.goal = proposed.goal;
        ordinary.goalValue = proposed.goalValue;
      }
    } else out.push(proposed);
  }
  const road=roadCandidate(world,agentId);
  if (road) out.push({...road,id:road.kind,label:BASE_KINDS[road.kind].label,
    cost:SURV_COST[road.kind],impulse:BASE_KINDS[road.kind].impulse,serves:{stimulation:.24},goalValue:road.value});
  for (const {kind,value} of discussionPaths(world,agentId)) out.push({
    id:kind,kind,label:BASE_KINDS[kind].label,impulse:BASE_KINDS[kind].impulse,cost:SURV_COST[kind],
    serves:{social:.3}, goalValue:value,
  });
  if (world.survival?.settlementLife) for (const action of out) {
    const support=discussionSupport(world,agentId,action);
    if (support) action.goalValue=(action.goalValue??0)+support;
  }
  const cooperation = cooperationCandidate(world, agentId);
  if (cooperation) {
    // 同一行为 ID 只保留一条，保留原需求收益和习惯键。
    const ordinary = out.find(a => a.id === cooperation.id);
    if (ordinary) {
      Object.assign(ordinary, { cooperation: true, cooperationValue: cooperation.cooperationValue, cost: cooperation.cost });
      for (let i = out.length - 1; i >= 0; i -= 1)
        if (out[i].id === cooperation.id && out[i] !== ordinary) out.splice(i, 1);
    } else out.push(cooperation);
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

// §15 同权观测：居民（非玩家）在生存世界的成功动作计数，供同权闸门断言
export function actuate(world, agentId, action, actionLoc = world.loc[agentId]) {
  if (strictLifecycle(world) && !laborAllowed(world, agentId, action.kind)) {
    return { action, ok: false, code: 'TOO_YOUNG' };
  }
  const r = actuateInner(world, agentId, action, actionLoc);
  if (world.survival && agentId !== 'p1' && r.ok) {
    const c = (world.survival.aiActions ??= {});
    c[action.kind] = (c[action.kind] ?? 0) + 1;
  }
  // §16 E1 劳动即进食：成功收/种/采给执行者加能量（劳动换食闭环）
  if (world.survival?.workFeeds === true && r.ok && ['harvest', 'plant', 'gather'].includes(action.kind)) {
    world.agents[agentId]?.drives?.reward('energy', 0.3);
  }
  return r;
}
function actuateInner(world, agentId, action, actionLoc) {
  const me = agentId;
  const here = world.loc[agentId];
  const evt = (o) => ({ kind: o.kind, valence: o.valence, selfCaused: o.selfCaused ?? true, serves: o.serves ?? null, about: o.about ?? null, violates: o.violates ?? null, novel: o.novel ?? false });

  switch (action.kind) {
    case 'eat': {
      if (world.survival) return { action, ok: false, code: 'NOT_AVAILABLE', observation: '生存模式靠公共粮仓每日分配，不单独吃公仓' };
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
    case 'rest': {
      const sheltered=world.survival?.settlementLife && (householdAccess(world,agentId,here) ||
        world.survival.buildings.some(b=>b.type==='shelter' && b.loc===here && b.integrity>0));
      if (sheltered) return {action,ok:true,code:'OK',observation:'在住处休息',satiated:'energy',amount:.15,
        evt:evt({kind:'rest',valence:.25,serves:'energy'})};
      return { action, ok: true, code: 'OK', observation: '靠着墙歇了会儿', satiated: 'energy', amount: 0.05, evt: evt({ kind: 'rest', valence: 0.2, serves: 'energy' }) };
    }
    case 'road_lay':
    case 'road_remove': {
      const r=changeRoad(world,agentId,action);
      return {...r,action,observation:BASE_KINDS[action.kind].label,
        ...(r.ok?{evt:evt({kind:action.kind,valence:.18,serves:'stimulation'})}:{})};
    }
    case 'discuss_open':
    case 'discuss_join':
    case 'discuss_share':
    case 'discuss_decline':
    case 'discuss_leave': {
      const r=discussionAction(world,agentId,action.kind,true);
      return {...r,action,observation:BASE_KINDS[action.kind].label,
        ...(r.ok?{evt:evt({kind:action.kind,valence:.15,serves:'social'})}:{})};
    }
    case 'move_to': {
      const access=homeEntry(world,agentId,action.to);
      if (!access.ok) return {...access,action};
      startMove(world, agentId, action.to);
      if (world.survival?.districtTravel?.[agentId])
        return { action, ok:true, code:'OK', observation:'出发前往'+world.locs[action.to], novel:true };
      const crowd = othersAt(world, agentId);
      if (crowd.length) world.pending.push({ for: agentId, evt: evt({ kind: 'company_soon', valence: 0.15, selfCaused: false, about: crowd[0] }) });
      return { action, ok: true, code: 'OK', observation: `走到${(world.locs ?? LOCS)[action.to] ?? action.to}`, novel: true, evt: evt({ kind: 'relocate', valence: 0.05, serves: 'stimulation', novel: true }) };
    }
    case 'look_out': {
      startMove(world, agentId, 'watch');
      if (world.survival?.districtTravel?.[agentId]) return { action, ok:true, code:'OK', observation:'出发前往瞭望台' };
      return { action, ok: true, code: 'OK', observation: '外面还是那片灰', satiated: 'social', amount: 0.12, novel: true, evt: evt({ kind: 'observed', valence: 0.35, serves: 'stimulation', novel: true }) };
    }
    case 'work': {
      if (!(world.features ?? {}).work || world.loc[agentId] !== 'workshop') return { action, ok: false, code: 'NO_WORKSHOP', observation: '这里没有可干的活' };
      world.coins[agentId] = (world.coins[agentId] ?? 0) + 2;
      world.stash[agentId] = (world.stash[agentId] ?? 0) + 1; // 工钱口粮：让私人库存在这张经济里有补给源
      world.expect[agentId] = Math.max(world.expect[agentId] ?? 0, world.stash[agentId]); // 合法进项同步抬预期，不然会被误登记成'私藏超额'
      (world.workLog ??= {})[agentId] = { day: dayOf(world.t), n: workUsedToday(world, agentId) + 1 }; // §33 记账：只有真干成了才占额度
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
        // BUG-2：这里曾是 `= 1`（应为「原有 +1」）。候选门允许对方有 ≥2 份，于是接济一次会把他
        // 手里的粮**赋值**成 1 份：有 5 份的人被接济后剩 1 份，世界总库存凭空蒸发。
        world.stash[other] = theirStash - 1;
        world.stash[agentId] = mineStash + 1;
        world.expect[agentId] = Math.max(world.expect[agentId] ?? 0, world.stash[agentId]);
        if (world.agents[agentId]?.relations) world.agents[agentId].relations.meet(other, world.t, { delta: { trust: 2, familiarity: 0.02 }, why: '接济' });
        return { action, ok: true, code: 'OK', observation: `向${world.agents[other]?.name ?? other}要了一份`, satiated: 'energy', amount: 0.35, evt: evt({ kind: 'trade', valence: 0.25, serves: 'energy', about: other }) };
      }
      if (theirStash + 2 <= mineStash) {
        world.stash[agentId] = mineStash - 1;
        world.stash[other] = theirStash + 1; // BUG-2：同理，受助方是 +1 不是赋值 1
        world.expect[other] = Math.max(world.expect[other] ?? 0, world.stash[other]);
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
    case 'forage': {
      if (!world.survival) return { action, ok: false, code: 'NOT_AVAILABLE' };
      const r = doForage(world, agentId);
      if (!r.ok) return { action, ok: false, code: r.code };
      return { action, ok: true, code: 'OK', observation: '采到一捧浆果', evt: evt({ kind: 'forage', valence: 0.2, serves: 'energy' }) };
    }
    case 'exchange': {
      if (!world.survival) return { action, ok: false, code: 'NOT_AVAILABLE' };
      const r = doExchange(world, agentId, action.type);
      if (!r.ok) return { action, ok: false, code: r.code };
      return { action, ok: true, code: 'OK', observation: `兑换收成：${r.gained}`, evt: evt({ kind: 'exchange', valence: 0.25, serves: 'energy' }) };
    }
    case 'expand': {
      if (!world.survival) return { action, ok: false, code: 'NOT_AVAILABLE' };
      const r = doExpand(world, agentId, action.type);
      if (!r.ok) return { action, ok: false, code: r.code };
      return { action, ok: true, code: 'OK', observation: `扩建：${r.label}`, evt: evt({ kind: 'expand', valence: 0.3, serves: 'stimulation' }) };
    }
    case 'till': {
      const r = till(world, agentId, action.plot);
      if (!r.ok) return { action, ok: false, code: r.code, observation: '当前无法开垦' };
      return { action, ok: true, code: r.code, observation: '开出一块空田，等待播种',
        evt: evt({ kind: 'till', valence: .2, serves: 'energy' }) };
    }
    case 'harvest': {
      if (!world.survival) return { action, ok: false, code: 'NOT_AVAILABLE', observation: '这个世界没有菜畦' };
      const r = doHarvest(world, agentId, action.plot);
      if (!r.ok) return { action, ok: false, code: r.code, observation: '没有可收获的菜畦' };
      return { action, ok: true, code: 'OK', observation: `收获 ${r.amount} 份入公共粮仓`, evt: evt({ kind: 'harvest', valence: 0.3, serves: 'energy' }) };
    }
    case 'plant': {
      if (!world.survival) return { action, ok: false, code: 'NOT_AVAILABLE', observation: '这个世界没有菜畦' };
      const r = doPlant(world, agentId, action.plot);
      if (!r.ok) return { action, ok: false, code: r.code, observation: r.code === 'NO_WATER' ? '水分不足，播不了种' : '没有空菜畦' };
      return { action, ok: true, code: 'OK', observation: '播下种子，等它长大', evt: evt({ kind: 'plant', valence: 0.2, serves: 'energy' }) };
    }
    case 'house_work': {
      const ok = houseLabor(world, agentId, true);
      return { action, ok, code: ok ? 'OK' : 'NO_HOUSE_WORK',
        observation: ok ? '加工了一批建房用料' : '今天没有可做的建房工作',
        evt: evt({ kind: 'house_work', valence: ok ? .3 : -.1, serves: 'stimulation' }) };
    }
    case 'gather': {
      if (!world.survival) return { action, ok: false, code: 'NOT_AVAILABLE', observation: '这里没有可采集的' };
      const r = doGather(world, agentId, actionLoc);
      if (!r.ok) return { action, ok: false, code: r.code, observation: r.code === 'NO_RESOURCE' ? '这里的资源采空了，等它恢复' : '这里没有可采集的' };
      return { action, ok: true, code: 'OK', observation: `采集到 ${r.amount} 份${r.res === 'wood' ? '木料' : '石料'}`, evt: evt({ kind: 'gather', valence: 0.2, serves: 'stimulation' }) };
    }
    case 'plan': {
      if (!world.survival) return { action, ok: false, code: 'NOT_AVAILABLE', observation: '这里不能建造' };
      const r = doPlan(world, agentId, action.type, actionLoc);
      if (!r.ok) return { action, ok: false, code: r.code, observation: r.code === 'NO_MATERIAL' ? '材料不够' : r.code === 'OCCUPIED' ? '这里已经有建筑或工地' : '这里不能奠基' };
      return { action, ok: true, code: 'OK', observation: `奠基：${BUILDINGS[action.type]?.label ?? action.type}`, evt: evt({ kind: 'plan', valence: 0.2, serves: 'stimulation' }) };
    }
    case 'build': {
      if (!world.survival) return { action, ok: false, code: 'NOT_AVAILABLE', observation: '这里没有工地' };
      const r = doBuild(world, agentId);
      if (!r.ok) return { action, ok: false, code: r.code, observation: '这里没有工地' };
      return { action, ok: true, code: 'OK', observation: r.completed ? `建成：${BUILDINGS[r.completed]?.label ?? r.completed}` : '施工推进', evt: evt({ kind: 'build', valence: 0.25, serves: 'social' }) };
    }
    case 'repair': {
      if (!world.survival) return { action, ok: false, code: 'NOT_AVAILABLE', observation: '这里没有可维修的建筑' };
      const r = doRepair(world, agentId);
      if (!r.ok) return { action, ok: false, code: r.code, observation: r.code === 'NO_MATERIAL' ? '维修材料不够' : '不需要维修' };
      return { action, ok: true, code: 'OK', observation: '修好了', evt: evt({ kind: 'repair', valence: 0.3, serves: 'stimulation' }) };
    }
    case 'deposit':
    case 'withdraw': {
      if (!world.survival) return { action, ok: false, code: 'NOT_AVAILABLE', observation: '这里没有公仓' };
      const res = action.type === 'stone' ? 'stone' : 'wood';
      const bag = (world.pinv ??= {})[agentId] ??= { wood: 0, stone: 0 };
      if (action.kind === 'deposit') {
        if (bag[res] <= 0) return { action, ok: false, code: 'NO_MATERIAL', observation: '背包里没有可存的' };
        bag[res] -= 1; world.survival.inv[res] += 1;
      } else {
        if (world.survival.inv[res] <= 0) return { action, ok: false, code: 'NO_MATERIAL', observation: '公仓里没有可取的' };
        world.survival.inv[res] -= 1; bag[res] += 1;
      }
      return { action, ok: true, code: 'OK', observation: action.kind === 'deposit' ? '存入公仓' : '从公仓取出', evt: evt({ kind: action.kind, valence: 0.1, serves: 'social' }) };
    }
    case 'take_shared': {
      // §15.4 生存语义一致性：生存模式只有公仓每日分配、无私藏 ⇒ 越轨取食不可用（否则 AI 偷吃吃饱就不种地）
      if (world.survival) return { action, ok: false, code: 'NOT_AVAILABLE', observation: '生存模式只有公仓每日分配，没有私藏可拿' };
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
          // BUG-13：只罚**目击者**（当场在场的 crowd）。上一版遍历 Object.keys(world.agents)，
          // 于是不在场、也没跟行为人结伴的人同样 −1，与上面这句注释和 §28 C 的设计不符。
          for (const w of crowd) {
            if (w === 'p1' || !world.agents[w]?.relations) continue;
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
