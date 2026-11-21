// 模型域：配置、审议/对话两条模型路径、车道与预算入口。
// S/CFG 由 host 以引用传入（单例不复制）；observerActive 也由 host 注入，避免第二份在场判据。
import { LOCS } from './body.mjs';
import { preferenceBands } from './model.mjs';
import { withNoThink, withoutNoThink } from './model-adapter.mjs';
import { parseSay } from './intent.mjs';
import { modelLaneFor } from './camp-lane.mjs';
import { modelChannel, breakerOpenAt, budgetTick, pickProviderKey, createBudgetDomain, isFreeProvider as freeProvider } from './host-budget.mjs';

export function createModelDomain({ S, CFG, C, observerActive }) {
  const { BUDGET, NODE_BUDGET, PER_TICK_CAP, MODEL_TIMEOUT_MS, MODEL_TICK_BUDGET_MS,
    UNATTENDED_ON, UNATTENDED_ASK_CAP, PAID_WHEN_UNATTENDED, BREAKER_FAILS, BREAKER_MS,
    FREE_HOSTS, PAID_HOSTS, ATTEMPT_CAP, PRESENCE_MS } = C;
// 预算/熔断域只拿状态引用，不持有第二份单例。
let budget = createBudgetDomain({
  getState: () => S, budget: BUDGET, nodeBudget: NODE_BUDGET, presenceMs: PRESENCE_MS,
  breakerFails: BREAKER_FAILS, breakerMs: BREAKER_MS, attemptCap: ATTEMPT_CAP,
});
const modelGate = () => budget.gate();
const modelRelease = () => budget.release();
const modelChargeLane = (free) => budget.chargeLane(free);
const modelCharged = (tokens = 0) => budget.charged(tokens);

// 对话道地的失败口径。玩家侧只看到"回的是固定话"，分不清是超时、空回复，还是回了却被判无效，
// 所以这里按 boot 累计六个计数（与 attempts 同寿命，不参与每日归零），线上直接除一下就是落地率。
const chatterNote = (key, n = 1) => {
  const c = S.model.chatter ??= { asked: 0, ok: 0, timeout: 0, http: 0, empty: 0, invalid: 0 };
  c[key] = (c[key] ?? 0) + n;
};
const isAbort = (e) => /abort/i.test(`${String(e?.name ?? '')} ${String(e?.message ?? '')}`);

function isFreeProvider(base) {
  return freeProvider(base, { freeHosts: FREE_HOSTS, paidHosts: PAID_HOSTS });
}

function configure({ providers = [], keys = [], model = '', models = [], deliberationModel, seed, brain } = {}) {
  if (providers.length) CFG.providers = providers.map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
  if (keys.length) CFG.keys = keys.map(s => String(s ?? '').trim());
  if (model) CFG.model = model;
  if (models.length) CFG.models = models.map((s) => String(s ?? '').trim());
  // 审议车道单独指引擎：只在只花电的节点路上生效。显式传空串就是要关掉，所以判 undefined 而不是判真假。
  if (deliberationModel !== undefined) CFG.deliberationModel = String(deliberationModel ?? '').trim();
  if (seed) CFG.seed = seed;
  if (brain) CFG.brain = brain;
}

const providerKey = i => pickProviderKey(CFG.keys, i, CFG.providers.length);

function modelConfigured() {
  return CFG.providers.some((_, i) => providerKey(i) && (CFG.models[i] || CFG.model));
}

async function postChat(provider, key, body, mdl, ac) {
  const url = `${provider}/chat/completions`;
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${key}` };
  const send = (payload) => fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: ac.signal });
  let res = await send(withNoThink(body, mdl));
  if (!res.ok && (res.status === 400 || res.status === 422) && withNoThink(body, mdl).chat_template_kwargs) {
    budget.attempt('RETRY_NO_KWARGS');    res = await send(withoutNoThink(withNoThink(body, mdl)));
  }
  return res;
}

function buildDeliberationPrompt({ agent, scored, world, rejected, memories, trigger, daySummary }) {
  const here = world.loc[agent.id];
  const bands = preferenceBands(scored, agent.ch);
  const present = (world.occupancy[here] ?? []).filter((x) => x !== agent.id && (world.survival || x !== 'p1')).map((x) => world.agents[x]?.name ?? x);
  const dom = agent.drives.dominant();
  const lines = [
    `你是${agent.name}（${agent.traits.archetype}型）。第 ${world.t} 刻，你在${here}。`,
    `为什么现在问你：${trigger}`, // ⑧ 事件门控：没有事件就不会被问到，所以这行永远有内容
    `内部读数：${agent.bank.summary()}`,
    `此刻你最缺：${dom.label}（偏差 ${dom.e.toFixed(2)}，紧迫度 ${dom.urgency.toFixed(2)}）`,
    world.survival
      ? `生存营地：公共食物 ${world.survival.store} 份，水 ${world.survival.water.toFixed(2)}，个人木料 ${world.pinv?.[agent.id]?.wood ?? 0}、石料 ${world.pinv?.[agent.id]?.stone ?? 0}。在场的人：${present.join('、') || '没有'}`
      : `世界事实：公仓余 ${world.pantry} 份；你自己门口存着 ${world.stash[agent.id]} 份（你以为该有 ${world.expect[agent.id]} 份）；在场的人：${present.join('、') || '没有'}`,
    `你想起的事：${memories?.length ? memories.map((m) => `${m.kind}(相似${m.sim})`).join('、') : '暂无'}`,
    daySummary ? `上一天的自己：${daySummary}` : '', // ⑦ 反思回合的产物；关掉开关后这行必须消失
    '可做的事（只能选一项，id 照抄）：',
    ...[...scored].sort((a, b) => (a.id < b.id ? -1 : 1)).map((s) => `- ${s.id} | ${s.act.label} | ${bands[s.id] ?? '同档'}`),
  ].filter(Boolean);
  if (rejected) lines.push(`你上次想做 ${rejected.from} 被驳回：${rejected.why}。这次换一个可行的。`);
  // #53 实测：耗时 ≈ 0.5s(预填) + 0.127s × 生成token；生产均值 30.9 token ⇒ 4.3s，超 TTL 4500 就全部作废。
  // 唯一不动模型也能省时间的办法是让它少写字，所以理由从 14 字收到 6 字（约省 1 秒）。
  // 注意不能压低 max_tokens 当油门：均值已 31、长答案到 100，截断会产出半截 JSON ⇒ 审议静默失败（见 decision-lane 闸门 LANE-07）。
  lines.push('只输出 JSON：{"id":"照抄上面某个 id","reason":"不超过6字"}，不要复述选项、不要写过程。');
  lines.push('如果此刻有在场的人、你想顺带说一句话，再加三个字段："act" 从 request/offer/warn/inform/greet/accuse/thank/decline/refuse 里选一个；"topic" 从 food/firewood/shelter/child/work/weather/boundary/trust 里选一个；"text" 不超过 28 字。不想说就省略这三项。');

  return lines.join(String.fromCharCode(10));
}

// P1c：正式连续时钟没有"每拍最多 N 次"配额；模型调用由真实毫秒令牌桶/全局预算/并发上限约束。
// 研究态（没有 simClock）保留旧每拍配额与无人时压缩，既有轨迹逐位不变。
function continuousWorld() {
  return Boolean((S.mainSurv ?? S.surv)?.world?.simClock);
}

// 审议输入边界：仅保留原版构造器（实验态 compact 已移除）。
function deliberationPrompt(args) {
  return buildDeliberationPrompt(args);
}

async function modelBrain(args) {
  const { agent, scored, world, rejected, memories, trigger, daySummary } = args;
  const prompt = deliberationPrompt(args);
  budgetTick(S.model, new Date().toISOString().slice(0, 10));
  // C3：按营地判车道。分名字营地在无人时直接走确定性替身，询问不发出。
  const campKey = world?.campKey ?? 'MAIN';
  const watched = campKey === 'MAIN'
    ? observerActive(S.viewers[world.survival ? 'survival' : 'compare'], Date.now())
    : observerActive(S.campViewers[campKey], Date.now());
  const lane = modelLaneFor({ campKey, watched, unattendedOn: UNATTENDED_ON });
  if (lane === 'idle') {
    budget.attempt('LANE:IDLE_CAMP');
    return null;
  }
  // 无人观看：研究态照旧直接走替身（既有轨迹逐位不变）；游戏态继续上真模型，让世界自洽。
  if (!watched && !UNATTENDED_ON) return null;
  // 单拍上限：默认 0 = 不限（研究态保证默认行为逐位不变）。
  // 无人时压到 UNATTENDED_CALLS_PER_TICK：看得见的时刻优先，没人看时吃吞吐而不是抢并发。
  // P1c：正式连续世界不设每拍上限（世界按分钟推进，"拍"不是时间单位）。
  const askCap = continuousWorld() ? 0 : (watched ? PER_TICK_CAP
    : (PER_TICK_CAP > 0 ? Math.min(PER_TICK_CAP, UNATTENDED_ASK_CAP) : UNATTENDED_ASK_CAP));
  if (askCap > 0 && (S.asksThisTick ?? 0) >= askCap) return null;
  S.asksThisTick = (S.asksThisTick ?? 0) + 1;
  const note = (msg) => budget.attempt(msg);
  const laneOf = (base) => modelChannel({
    watched, free: isFreeProvider(base),
    moneyCalls: S.model.moneyCalls ?? 0, nodeCalls: S.model.nodeCalls ?? 0,
    moneyBudget: BUDGET, nodeBudget: NODE_BUDGET,
    breakerOpen: breakerOpenAt(S.breaker), allowPaidUnattended: PAID_WHEN_UNATTENDED
  });
  let refusal = null;
  for (let i = 0; i < CFG.providers.length; i++) {
    // 空 model 会让上游 400、calls 恒 0（真实踩过：MODEL_NAME 改名成 MODEL_NAMES 后审议层静默失效）——显式记账而不是让它哑着
    const mdlBase = CFG.models[i] || CFG.model;
    if (!mdlBase) { note('NO_MODEL'); continue; }
    const key = providerKey(i);
    if (!key) { note('NO_KEY'); continue; }
    const lane = laneOf(CFG.providers[i]);
    if (!lane.go) { refusal = lane.why; continue; } // 这条路不该走（无人时的付费路／熔断／该本账用完）：换下一条，世界照跑
    const free = lane.kind === 'node';
    // DM-3′：审议问的是"选哪个 id"，与另一台引擎同题实测一致率不降、尾部短一截；
    // 只在节点路上改名，付费路上这个名字上游不认识，换了就是白烧一次 400。
    const mdl = free && CFG.deliberationModel ? CFG.deliberationModel : mdlBase;
    const ac = new AbortController();
    const waitMs = Math.min(MODEL_TIMEOUT_MS, S.modelDeadline ? Math.max(0, S.modelDeadline - Date.now()) : MODEL_TIMEOUT_MS);
    if (waitMs <= 0) return null;
    const to = setTimeout(() => ac.abort(), waitMs);
    try {
      const res = await postChat(CFG.providers[i], key, { model: mdl, temperature: 0.85, messages: [{ role: 'user', content: prompt }], response_format: { type: 'json_object' }, max_tokens: 100 }, mdl, ac);
      if (!res.ok) { note(`HTTP ${res.status}`); budget.see(free, false); continue; }
      const j = await res.json();
      // ARCH5-06：calls/车道/token 统一由预算域记账，host 不再手写字段。
      budget.recordCall({ free, tokens: j.usage?.total_tokens ?? 0 });
      budget.see(free, true);
      const p = JSON.parse(String(j.choices?.[0]?.message?.content ?? '').replace(/^```json?/i, '').replace(/```\s*$/i, '').trim());
      const hit = scored.find((s) => s.id === p.id);
      if (!hit) return null;
      agent.lastReason = p.reason ?? '';
      // S2 say：只在这里收下；是否说得出口、说了有什么后果，由规则层（converse）裁决。
      const say = parseSay(p);
      if (say) agent.pendingSay = say;
      else if (p?.act || p?.text) budget.attempt('SAY:INVALID');
      if (world.survival) budget.choice();
      return { id: hit.id };
    } catch (e) {
      note(String(e.message).slice(0, 40));
      budget.see(free, false); // 超时/断连是熔断的输入：中继没答上来就该冷一段，别每次都白等一个 TTL
    } finally {
      clearTimeout(to);
    }
  }
  if (refusal) note(`LANE:${refusal}`); // 一条路都没走成时留个原因，否则"没人看时不上模型"会变成一个查不到的黑箱
  return null;
}

// 对话模型：只负责"怎么说"，态度已由 dialogue.sayTo 在服务端裁决。
// 这条路**始终要求有观众**：它是玩家开口引发的对话，没人说话时不该存在。
// 但记账与决策模型共用同一套分账（节点=电，托管=钱），否则节点聊得多了会把付费额度吃掉。
async function modelTalk({ npc, world, history, text, trust }) {
  if (!CFG.providers.length || !CFG.keys.some(Boolean)) return null;
  if (CFG.brain !== 'model') return null;
  budgetTick(S.model, new Date().toISOString().slice(0, 10));
  const campKey = world.campKey ?? 'MAIN';
  const lastVisitor = campKey === 'MAIN' ? S.viewers.survival : S.campViewers[campKey];
  if (!observerActive(lastVisitor, Date.now())) return null;
  if (!continuousWorld() && PER_TICK_CAP > 0 && (S.asksThisTick ?? 0) >= PER_TICK_CAP) return null;
  S.asksThisTick = (S.asksThisTick ?? 0) + 1;
  chatterNote('asked');
  const here = (world.locs ?? LOCS)[world.loc[npc.id]] ?? world.loc[npc.id];
  const turns = (history ?? []).slice(-6).map((h) => `${h.who === 'p1' ? '对方' : npc.name}：${h.text}`).join('\n');
  const prompt = [
    `你叫${npc.name}，${npc.traits?.archetype ?? '谨慎'}型性格，此刻在${here}。`,
    `你手里的活：${npc.last?.kind ?? '空闲'}；能量 ${(npc.drives?.v?.energy ?? 0.7).toFixed(2)}，社交 ${(npc.drives?.v?.social ?? 0.5).toFixed(2)}。`,
    `你对玩家（对方）的信任：${Math.round(trust)}/100。`,
    turns ? `刚才的对话：\n${turns}` : '',
    `对方刚说：${text}`,
    '只回一句中文台词，不超过 40 字。可以冷淡、敷衍、不耐烦或发火；不要旁白，不要解释设定，不要加引号。',
  ].filter(Boolean).join('\n');
  for (let i = 0; i < CFG.providers.length; i++) {
    const mdl = CFG.models[i] || CFG.model;
    const key = providerKey(i);
    if (!mdl || !key) continue;
    const free = isFreeProvider(CFG.providers[i]);
    const lane = modelChannel({
      watched: true, free,
      moneyCalls: S.model.moneyCalls ?? 0, nodeCalls: S.model.nodeCalls ?? 0,
      moneyBudget: BUDGET, nodeBudget: NODE_BUDGET, breakerOpen: breakerOpenAt(S.breaker)
    });
    if (!lane.go) continue;
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), MODEL_TIMEOUT_MS);
    try {
      const res = await postChat(CFG.providers[i], key, { model: mdl, temperature: 0.9, messages: [{ role: 'user', content: prompt }], max_tokens: 120 }, mdl, ac);
      if (!res.ok) { budget.see(free, false); chatterNote('http'); continue; }
      const j = await res.json();
      // ARCH5-06：calls/车道/token 统一由预算域记账，host 不再手写字段。
      budget.recordCall({ free, tokens: j.usage?.total_tokens ?? 0 });
      budget.see(free, true);
      const line = String(j.choices?.[0]?.message?.content ?? '').replace(/\s+/g, ' ').replace(/^["“]|["”]$/g, '').trim();
      if (line) { chatterNote('ok'); return line.slice(0, 80); }
      chatterNote('empty');
    } catch (e) { budget.see(free, false); chatterNote(isAbort(e) ? 'timeout' : 'http'); /* 超时/解析失败：换下一个供应商，全都失败则模板兜底 */ } finally { clearTimeout(to); }
  }
  return null;
}

// 1.5 自由对话/居民互聊：只负责"把一句话说自然"。
// 与 modelTalk 共用 provider 循环、观众判据、每日预算与 breaker；不预扣 gate，
// 因为这两条路都由短锁外的调用方驱动，失败一律返回 null 让调用方退模板。
async function askLine({ world, prompt, maxTokens = 120, temperature = 0.9, tag = 'CHAT' } = {}) {
  if (!CFG.providers.length) { budget.attempt(`${tag}:NO_PROVIDER`); return null; }
  if (!CFG.keys.some(Boolean)) { budget.attempt(`${tag}:NO_KEY`); return null; }
  if (CFG.brain !== 'model') { budget.attempt(`${tag}:BRAIN_LOCAL`); return null; }
  budgetTick(S.model, new Date().toISOString().slice(0, 10));
  const campKey = world?.campKey ?? 'MAIN';
  const lastVisitor = campKey === 'MAIN' ? S.viewers.survival : S.campViewers[campKey];
  if (!observerActive(lastVisitor, Date.now())) return null;
  if (!continuousWorld() && PER_TICK_CAP > 0 && (S.asksThisTick ?? 0) >= PER_TICK_CAP) return null;
  S.asksThisTick = (S.asksThisTick ?? 0) + 1;
  chatterNote('asked');
  const note = (msg) => budget.attempt(`${tag}:${msg}`);
  let refusal = null;
  for (let i = 0; i < CFG.providers.length; i++) {
    const mdl = CFG.models[i] || CFG.model;
    const key = providerKey(i);
    if (!mdl) { note('NO_MODEL'); continue; }
    if (!key) { note('NO_KEY'); continue; }
    const free = isFreeProvider(CFG.providers[i]);
    const lane = modelChannel({
      watched: true, free,
      moneyCalls: S.model.moneyCalls ?? 0, nodeCalls: S.model.nodeCalls ?? 0,
      moneyBudget: BUDGET, nodeBudget: NODE_BUDGET, breakerOpen: breakerOpenAt(S.breaker),
    });
    if (!lane.go) { refusal = lane.why; note(`LANE:${lane.why}`); continue; }
    const ac = new AbortController();
    const waitMs = Math.min(MODEL_TIMEOUT_MS, S.modelDeadline ? Math.max(0, S.modelDeadline - Date.now()) : MODEL_TIMEOUT_MS);
    if (waitMs <= 0) { chatterNote('timeout'); return null; }   // 本刻模型时限已耗尽：玩家那侧同样是"没等到回话"
    const to = setTimeout(() => ac.abort(), waitMs);
    try {
      const res = await postChat(CFG.providers[i], key, {
        model: mdl, temperature, messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens,
      }, mdl, ac);
      if (!res.ok) { note(`HTTP ${res.status}`); budget.see(free, false); chatterNote('http'); continue; }
      const j = await res.json();
      budget.recordCall({ free, tokens: j.usage?.total_tokens ?? 0 });
      budget.see(free, true);
      const line = String(j.choices?.[0]?.message?.content ?? '').replace(/\s+/g, ' ').trim();
      if (line) { chatterNote('ok'); return [...line].slice(0, 240).join(''); }
      chatterNote('empty');
    } catch (e) {
      note(String(e?.message ?? e).slice(0, 40));
      budget.see(free, false);
      chatterNote(isAbort(e) ? 'timeout' : 'http');
    } finally {
      clearTimeout(to);
    }
  }
  if (refusal) note(`LANE:${refusal}`);
  return null;
}

function modelChat({ world, prompt } = {}) {
  return askLine({ world, prompt, maxTokens: 140, temperature: 0.9, tag: 'CHAT' });
}

function modelChatter({ world, prompt } = {}) {
  // 居民互聊只改一句措辞，48 token 足够；玩家自由输入走 modelChat（140），别混。
  return askLine({ world, prompt, maxTokens: 48, temperature: 0.85, tag: 'CHATTER' });
}

  return {
    configure, isFreeProvider, modelGate, modelRelease, modelChargeLane, modelCharged,
    modelBrain, modelTalk, modelChat, modelChatter, modelConfigured, chatterNote,
    buildDeliberationPrompt, deliberationPrompt, budget,
  };
}
