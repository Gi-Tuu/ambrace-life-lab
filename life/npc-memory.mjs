// 1.7 统一 NPC 长期记忆：事件 / 对话 / 承诺 / 知识收成一套记录。
//
// 边界（为什么这样切）：
//   1) 叙事层（对话/主动搭话/面板）只读本模块；决策层在正式世界也从这里取 episode/commitment，
//      研究/compare 之外的旧 `EpisodicMemory` 仍保留为原始行、频率统计、日反思与兼容回退；
//   2) 写入只走确定性规则：事件由 `memory.onAdd` 旁路镜像、对话由轮次/关闭写、承诺用正则判定、
//      知识只用已知居民名/地点名与 gossip 的登记；**绝不用 Date.now、绝不用 Math.random**；
//   3) 存档形状：统一层挂在 `world.survival.npcMemory[id]`，容器是纯数据对象（可直接 JSON），
//      读档走 `restoreNpcMemory` 清洗/迁移；研究态不出现该字段；
//   4) view 只出 kind/source/天/摘要/重要度，绝不出 secrets、关系明细或未登记的事实。
import { DIMS } from './traits.mjs';
import { stateDistance } from './memory.mjs';

export const NPC_MEMORY = Object.freeze({
  v: 1,
  maxEntries: 600,
  pinnedMax: 150,
  dayReserve: 120,
  residentsMax: 16,
  summaryMax: Object.freeze({ episode: 90, dialogue: 200, commitment: 140, knowledge: 160 }),
  entitiesMax: 6,
  entityMax: 24,
  // 提示词预算：字符口径与 resident-dialogue 的 promptMax 同源；尾行永远最后装配、永不截断。
  budget: Object.freeze({ total: 2200, head: 400, summary: 200, recall: 400, commitments: 120, recent: 600, current: 280, tail: 200 }),
  // 决策检索：与旧 EpisodicMemory 逐位对齐的参数（不允许在这里改权重）。
  decision: Object.freeze({ recency: 0.3, importance: 0.25, relevance: 0.3, state: 0.5, fail: 0.02, k: 6 }),
  recencyTau: Object.freeze({ episode: 120, dialogue: 120, knowledge: 720, commitment: 1440 }),
  commitmentBonus: 0.06,
});

const KINDS = new Set(['episode', 'dialogue', 'commitment', 'knowledge']);
const SOURCE_OWN = '亲历';
const SOURCE_PLAYER = '玩家';
const SOURCE_HEARD = /^听说:[A-Za-z0-9_]+$/;
const MAX_DAY_TICKS = 100000;

const finiteOr = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
const clip = (text, max) => [...String(text ?? '')].slice(0, Math.max(0, Math.round(max))).join('');
const round4 = (value) => Number(finiteOr(value).toFixed(4));
const round2 = (value) => Number(finiteOr(value).toFixed(2));
const clamp01 = (value) => Math.max(0, Math.min(1, finiteOr(value)));
const dayOf = (t, dayTicks) => Math.floor(Math.max(0, finiteOr(t)) / Math.max(1, finiteOr(dayTicks, 24) || 24));

const KIND_LABEL = Object.freeze({
  death: '有人走了', birth: '家里添了孩子', marriage: '成了家', storm_impact: '风暴掀了屋顶',
  work_completed: '做完一段活', work_interrupted: '活被打断', cooperation_reply: '有人来搭手',
  shortfall: '短缺', witnessed: '看见了一件事', thwarted: '想做没做成', normbreak: '越界',
  contact: '和人来往', consume: '吃了东西', rest: '歇了一会儿', relocate: '换了地方',
  gather: '采集', build: '施工', repair: '修补', deposit: '入库', withdraw: '取料', exchange: '换东西',
  harvest: '收庄稼', plant: '播种', forage: '采果子', reflect: '这一天', alone: '一个人待着',
  observed: '注意到', eat: '吃东西', plan: '做了打算', company_soon: '有人要来',
  discussion_result: '商量出了结果', discuss_open: '开口商量', discuss_decline: '没谈成',
  disaster: '遇上灾害', drought: '干旱', cold: '天冷了', rain: '下雨了',
});

const SOURCE_LABEL = { 亲历: '亲历', 玩家: '玩家' };

export function sourceText(source) {
  const text = String(source ?? '');
  if (text === SOURCE_OWN) return '亲历';
  if (text === SOURCE_PLAYER) return '玩家';
  const heard = /^听说:([A-Za-z0-9_]+)$/.exec(text);
  return heard ? `听说·${heard[1]}` : '亲历';
}

export function kindText(kind) {
  return { episode: '旧事', dialogue: '对话', commitment: '承诺', knowledge: '知识' }[kind] ?? '旧事';
}

function labelOf(kind) {
  return KIND_LABEL[kind] ?? String(kind ?? '');
}

function sanitizeSource(value) {
  const text = String(value ?? '');
  if (text === SOURCE_PLAYER) return SOURCE_PLAYER;
  if (SOURCE_HEARD.test(text)) return text;
  return SOURCE_OWN;
}

function sanitizeDayTicks(value) {
  const n = Math.round(finiteOr(value, 24));
  return n >= 1 && n <= MAX_DAY_TICKS ? n : 24;
}

function sanitizeM(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const d of DIMS) out[d] = round4(raw[d]);
  return out;
}

function sanitizeState(kind, raw) {
  const s = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  if (!s) return null;
  if (kind === 'episode') {
    const out = {
      m: sanitizeM(s.m),
      ak: typeof s.ak === 'string' && s.ak ? s.ak : null,
      ok: s.ok === true ? true : s.ok === false ? false : null,
      rid: Number.isSafeInteger(s.rid) ? s.rid : null,
    };
    if (s.node === true) out.node = true;
    if (s.day === true) out.day = true;
    if (s.bucket === true) out.bucket = true;
    return out;
  }
  if (kind === 'dialogue') {
    const out = { atMin: round4(s.atMin), who: s.who === 'p1' ? 'p1' : (typeof s.who === 'string' && s.who ? s.who : null) };
    if (s.node === true) out.node = true;
    if (s.summary === true) out.summary = true;
    return out;
  }
  if (kind === 'commitment') {
    const status = ['open', 'kept', 'broken', 'unresolved'].includes(s.status) ? s.status : 'open';
    return {
      status,
      by: typeof s.by === 'string' && s.by ? s.by : null,
      to: typeof s.to === 'string' && s.to ? s.to : null,
      dueAt: s.dueAt != null && Number.isFinite(Number(s.dueAt)) ? round4(s.dueAt) : null,
      actionKind: typeof s.actionKind === 'string' && s.actionKind ? s.actionKind : null,
    };
  }
  const out = { secretId: typeof s.secretId === 'string' && s.secretId ? s.secretId : null };
  if (s.day === true) out.day = true;
  if (s.bucket === true) out.bucket = true;
  if (s.node === true) out.node = true;
  return out;
}

function sanitizeEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const kind = String(raw.kind ?? '');
  if (!KINDS.has(kind)) return null;
  const at = finiteOr(raw.at, NaN);
  if (!Number.isFinite(at) || at < 0) return null;
  const summary = clip(raw.summary, NPC_MEMORY.summaryMax[kind]);
  if (!summary || !summary.trim()) return null;
  const entities = Array.isArray(raw.entities)
    ? raw.entities.filter((x) => typeof x === 'string' && x).map((x) => clip(x, NPC_MEMORY.entityMax)).slice(0, NPC_MEMORY.entitiesMax)
    : [];
  const id = Number.isSafeInteger(raw.id) && raw.id >= 0 ? raw.id : 0;
  return { id, at: round4(at), kind, summary, entities, source: sanitizeSource(raw.source), importance: round4(clamp01(raw.importance)), state: sanitizeState(kind, raw.state) };
}

export function isOpenCommitment(entry) {
  return Boolean(entry && entry.kind === 'commitment' && entry.state && entry.state.status === 'open');
}

export function isPinnedEntry(entry) {
  if (!entry) return false;
  if (isOpenCommitment(entry)) return true;
  if (entry.kind === 'knowledge' && entry.source === SOURCE_PLAYER) return true;
  if (entry.importance >= 0.8) return true;
  return Boolean(entry.state && entry.state.node === true);
}

export function newContainer(id, dayTicks = 24) {
  return { v: NPC_MEMORY.v, id: String(id ?? ''), dt: sanitizeDayTicks(dayTicks), nextId: 0, entries: [], stats: { written: 0, evicted: 0, compacted: 0 } };
}

function nextIdOf(container) {
  let max = -1;
  for (const entry of container.entries) max = Math.max(max, entry.id);
  return Math.max(Math.round(finiteOr(container.nextId, 0)), max + 1);
}

// 写入的唯一入口：校验 -> 追加 -> 超上限时按分层规则淘汰。返回落盘后的条目（调用方可读 id）。
export function addEntry(container, raw, { t = null, dayTicks = null } = {}) {
  if (!container || !Array.isArray(container.entries)) return null;
  const entry = sanitizeEntry({ ...raw, id: nextIdOf(container) });
  if (!entry) return null;
  entry.id = nextIdOf(container);
  container.nextId = entry.id + 1;
  container.entries.push(entry);
  container.stats.written += 1;
  if (container.entries.length > NPC_MEMORY.maxEntries) {
    enforceLimits(container, { t: Number.isFinite(t) ? t : entry.at, dayTicks: dayTicks ?? container.dt });
  }
  return entry;
}

// 事件镜像：decision 兼容字段放进 state（m / ak / ok / rid），叙事摘要另存 summary。
export function mirrorEpisode(container, row) {
  if (!container || !row) return null;
  const label = labelOf(row.kind);
  const payload = String(row.payload ?? '');
  const about = /^来自([A-Za-z0-9_]+)$/.exec(payload)?.[1] ?? null;
  const detail = payload && payload !== '来自环境' ? (about ? `（来自${about}）` : `：${payload}`) : '';
  return addEntry(container, {
    at: row.t, kind: 'episode', summary: `${label}${detail}`,
    entities: about ? [about] : [], source: SOURCE_OWN, importance: clamp01(row.importance),
    state: {
      m: row.m ?? null, ak: row.actionKind ?? null,
      ok: row.actionSucceeded === true ? true : row.actionSucceeded === false ? false : null,
      rid: Number.isSafeInteger(row.id) ? row.id : null,
      ...(row.kind === 'reflect' ? { day: true } : {}),
    },
  }, { t: row.t, dayTicks: container.dt });
}

export function recordDialogueTurn(container, { at, atMin, who, text, importance = 0.2, source = null }) {
  if (!container || !text) return null;
  return addEntry(container, {
    at, kind: 'dialogue', summary: clip(text, NPC_MEMORY.summaryMax.dialogue),
    entities: who === 'p1' ? ['p1'] : [], source: source ?? (who === 'p1' ? SOURCE_PLAYER : SOURCE_OWN),
    importance, state: { atMin, who },
  }, { t: at, dayTicks: container.dt });
}

export function recordKnowledge(container, { at, summary, entities = [], source = SOURCE_OWN, importance = 0.4, secretId = null, node = false, day = false }) {
  if (!container || !summary) return null;
  return addEntry(container, {
    at, kind: 'knowledge', summary, entities, source, importance,
    state: { secretId, ...(node ? { node: true } : {}), ...(day ? { day: true } : {}) },
  }, { t: at, dayTicks: container.dt });
}

export function recordCommitment(container, { at, summary, by = 'p1', to = null, dueAt = null, actionKind = 'talk', source = SOURCE_PLAYER, importance = 0.8 }) {
  if (!container || !summary) return null;
  // 同一对同一件事的重复承诺只更新期限，不灌水。
  const dup = container.entries.find((e) => isOpenCommitment(e) && e.summary === clip(summary, NPC_MEMORY.summaryMax.commitment) && e.state.by === by && e.state.to === to);
  if (dup) {
    dup.at = round4(at);
    dup.importance = Math.max(dup.importance, clamp01(importance));
    dup.state.dueAt = Number.isFinite(Number(dueAt)) ? round4(dueAt) : dup.state.dueAt;
    if (actionKind) dup.state.actionKind = actionKind;
    return dup;
  }
  return addEntry(container, {
    at, kind: 'commitment', summary, entities: [by, to].filter(Boolean), source, importance,
    state: { status: 'open', by, to, dueAt, actionKind },
  }, { t: at, dayTicks: container.dt });
}

// 兑现/失约：只改状态，不删条目（“承诺不忘”= 旧承诺仍可检索，但不再算 open）。
export function settleCommitment(container, { by, to = null, status = 'kept', at = null }) {
  if (!container) return null;
  const row = [...container.entries].reverse().find((e) => isOpenCommitment(e) && e.state.by === by && (to == null || e.state.to === to));
  if (!row) return null;
  row.state.status = ['kept', 'broken', 'unresolved'].includes(status) ? status : 'kept';
  if (Number.isFinite(Number(at))) row.at = round4(at);
  return row;
}

export function openCommitments(container) {
  return (container?.entries ?? []).filter(isOpenCommitment).sort((a, b) => b.at - a.at || b.id - a.id);
}

// 确定性承诺检测：只认显式句式，不猜语义。命中后由调用方决定写给谁。
const PROMISE_RE = /(明天|后天|回头|一会儿|等下|晚上|以后|一定|说好|答应|保证)[^。！？]{0,12}?(给|帮|带|还|留|拿|送)[^。！？]{0,10}?(你|你们)/;
const PROMISE_VERB = { 给: '给', 帮: '帮', 带: '带', 还: '还', 留: '留', 拿: '拿', 送: '送' };

export function commitmentFromText(text, { at = 0, dayTicks = 24, windowDays = 1 } = {}) {
  const raw = String(text ?? '');
  if (!raw || raw.length > 240) return null;
  const hit = PROMISE_RE.exec(raw);
  if (!hit) return null;
  const when = hit[1];
  const sinceToday = /明天/.test(when) ? 1 : /后天/.test(when) ? 2 : 0;
  const dt = Math.max(1, finiteOr(dayTicks, 24) || 24);
  const dueAt = round4(finiteOr(at) + (sinceToday || Math.max(1, finiteOr(windowDays, 1))) * dt);
  const body = clip(raw, 40);
  return { summary: `答应过：${body}`, dueAt, actionKind: 'talk', verb: PROMISE_VERB[hit[2]] ?? '给' };
}

// ── 检索（叙事层） ─────────────────────────────────────────────────────────────

function bigrams(text) {
  const chars = [...String(text ?? '')];
  const out = new Set();
  for (let i = 0; i + 1 < chars.length; i += 1) out.add(chars[i] + chars[i + 1]);
  return out;
}

function lexicalRelevance(entry, ctx) {
  const query = String(ctx?.query ?? '');
  if (!query) return 0.25;
  const names = new Set([...(ctx?.entities ?? []), ...(ctx?.names ?? [])].filter(Boolean));
  let entityHits = 0;
  for (const name of names) if (name && (entry.summary.includes(name) || entry.entities.includes(name))) entityHits += 1;
  const qb = bigrams(query);
  const tb = bigrams(`${entry.summary} ${entry.entities.join(' ')}`);
  let hits = 0;
  for (const gram of qb) if (tb.has(gram)) hits += 1;
  const overlap = qb.size ? hits / qb.size : 0;
  return clamp01(0.6 * Math.min(1, entityHits / 2) + 0.4 * overlap);
}

function entryRelevance(entry, ctx) {
  if (entry.kind === 'commitment') {
    const query = String(ctx?.query ?? '');
    if (/答应|承诺|说好|保证|还|带|给/.test(query)) return 1;
    if (entry.state?.to && ctx?.names?.includes(entry.state.to)) return 1;
    return 0.3;
  }
  if (entry.kind === 'episode' && Array.isArray(ctx?.candidates) && ctx.candidates.length) {
    return entry.state?.ak != null && ctx.candidates.some((c) => c.kind === entry.state.ak) ? 0.9 : 0.25;
  }
  return lexicalRelevance(entry, ctx);
}

function recencyTau(kind) {
  return NPC_MEMORY.recencyTau[kind] ?? 120;
}

function sourceWeight(source) {
  if (source === SOURCE_PLAYER) return 1;
  if (source === SOURCE_OWN) return 0.7;
  return 0.5;
}

export function scoreEntry(entry, ctx = {}) {
  const t = finiteOr(ctx.t, 0);
  const recency = Math.exp(-Math.max(0, t - entry.at) / recencyTau(entry.kind));
  const importance = clamp01(entry.importance);
  const relevance = entryRelevance(entry, ctx);
  const hasState = entry.kind === 'episode' && entry.state?.m && ctx.m;
  const sim = hasState ? Math.max(0, Math.min(1, 1 - stateDistance(entry.state.m, ctx.m, ctx.precision))) : 0.5;
  const commit = isOpenCommitment(entry) ? 1 : 0;
  const pinned = isPinnedEntry(entry) ? 1 : 0;
  const total = 0.3 * recency + 0.25 * importance + 0.3 * relevance + 0.35 * sim
    + 0.25 * commit + 0.1 * sourceWeight(entry.source) + 0.2 * pinned;
  return { total: round4(total), recency, relevance: round4(relevance), sim: round4(sim) };
}

// retrieve(npc, context, budget)：统一入口。只打分、不写状态，同输入同输出。
export function retrieve(container, context = {}, budget = {}) {
  const entries = container?.entries ?? [];
  const kinds = Array.isArray(budget.kinds) && budget.kinds.length ? new Set(budget.kinds) : null;
  const maxEntries = Math.max(0, Math.round(finiteOr(budget.maxEntries, 6)));
  const chars = Math.max(0, Math.round(finiteOr(budget.chars, 400)));
  const pinnedReserve = kinds?.has('commitment') || !kinds ? Math.min(120, Math.floor(chars / 3)) : 0;
  const scored = [];
  for (const entry of entries) {
    if (kinds && !kinds.has(entry.kind)) continue;
    scored.push({ entry, score: scoreEntry(entry, context) });
  }
  scored.sort((a, b) => b.score.total - a.score.total || b.entry.at - a.entry.at || a.entry.id - b.entry.id);
  const picked = [];
  const taken = new Set();
  let used = 0;
  const costOf = (entry) => [...entry.summary].length + 16;
  if (pinnedReserve > 0) {
    for (const row of scored) {
      if (picked.length >= 2) break;
      if (!isOpenCommitment(row.entry)) continue;
      const cost = costOf(row.entry);
      if (used + cost > Math.min(chars, pinnedReserve)) break;
      picked.push(row.entry); taken.add(row.entry.id); used += cost;
    }
  }
  for (const row of scored) {
    if (picked.length >= maxEntries) break;
    if (taken.has(row.entry.id)) continue;
    const cost = costOf(row.entry);
    if (used + cost > chars) continue;
    picked.push(row.entry); taken.add(row.entry.id); used += cost;
  }
  return { entries: picked.map((entry) => ({ ...entry, score: scoreEntry(entry, context).total })), usedChars: used, dropped: Math.max(0, scored.length - picked.length) };
}

export function recallPromptLines(container, context, budget = {}, { dayTicks = 24 } = {}) {
  const result = retrieve(container, context, budget);
  const dt = sanitizeDayTicks(dayTicks);
  return result.entries.map((entry) => {
    const day = dayOf(entry.at, dt) + 1;
    const source = entry.source === SOURCE_PLAYER ? '玩家' : entry.source === SOURCE_OWN ? '亲历' : `听说·${entry.source.slice(3)}`;
    return `· [${kindText(entry.kind)}·第${day}天·${source}] ${entry.summary}`;
  });
}

// ── 决策（正式世界）：episode 与旧 retrieve 逐位一致；open 承诺只加小幅定向 bonus ─────

export function decisionRank(container, memory, m, candidates, t, opts = {}) {
  const useState = opts.stateChannel !== false;
  const rows = (container?.entries ?? []).filter((entry) => entry.kind === 'episode');
  const scored = rows.map((entry) => {
    const recency = Math.exp(-Math.max(0, t - entry.at) / NPC_MEMORY.recencyTau.episode);
    const relevance = candidates.some((c) => entry.state?.ak != null && c.kind === entry.state.ak) ? 0.9 : 0.25;
    const sim = entry.state?.m ? 1 - stateDistance(entry.state.m, m, opts.precision) : 0.5;
    const fail = entry.state?.rid != null ? (memory?.failures?.get?.(entry.state.rid) ?? 0) : 0;
    const total = useState
      ? NPC_MEMORY.decision.recency * recency + NPC_MEMORY.decision.importance * entry.importance + NPC_MEMORY.decision.relevance * relevance + NPC_MEMORY.decision.state * sim - NPC_MEMORY.decision.fail * fail
      : NPC_MEMORY.decision.recency * recency + NPC_MEMORY.decision.importance * entry.importance + NPC_MEMORY.decision.relevance * relevance;
    return { entry, total, sim };
  });
  scored.sort((a, b) => b.total - a.total);
  const cap = Math.min(NPC_MEMORY.decision.k, Math.max(1, Math.round(finiteOr(memory?.kCap, NPC_MEMORY.decision.k))));
  return scored.slice(0, cap);
}

export function stateBonus(container, memory, m, candidates, t, opts = {}) {
  const top = decisionRank(container, memory, m, candidates, t, opts);
  const useState = opts.stateChannel !== false;
  if (!top.length && memory?.rows?.length) {
    for (const row of memory.rows) memory.failures.set(row.id, (memory.failures.get(row.id) ?? 0) + 1);
  }
  for (const row of top) if (row.entry.state?.rid != null) memory?.touchHit?.(row.entry.state.rid);
  const byKind = new Map();
  for (const { entry, sim } of top) {
    const actionKind = entry.state?.ak;
    if (!actionKind || entry.state?.ok !== true) continue;
    if (!candidates.some((c) => c.kind === actionKind)) continue;
    const arr = byKind.get(actionKind) ?? [];
    arr.push(useState ? sim : 0.5);
    byKind.set(actionKind, arr);
  }
  const means = new Map([...byKind].map(([k, v]) => [k, v.reduce((a, b) => a + b, 0) / v.length]));
  const overall = [...means.values()].reduce((a, b) => a + b, 0) / (means.size || 1);
  const bonus = {};
  for (const [k, mu] of means) bonus[k] = Number(Math.max(0, Math.min(0.12, 0.3 * (mu - overall))).toFixed(4));
  // 承诺进入决策：只对承诺里登记过的候选动作加固定小量，没有 open 承诺时恒为 0（逐位兼容旧轨迹）。
  for (const row of openCommitments(container)) {
    const kind = row.state?.actionKind;
    if (!kind || !candidates.some((c) => c.kind === kind)) continue;
    bonus[kind] = Number(Math.min(0.12, (bonus[kind] ?? 0) + NPC_MEMORY.commitmentBonus).toFixed(4));
  }
  const retrieved = [...means].map(([k, mu]) => ({ kind: k, sim: Number(mu.toFixed(2)) })).slice(0, 3);
  return { bonus, retrieved };
}

// ── 分层保留：上限 / 压缩 / 淘汰 ────────────────────────────────────────────────

function evictScore(entry, t, dayTicks) {
  const dayTicksSafe = Math.max(1, finiteOr(dayTicks, 24));
  const impEff = entry.importance * Math.exp(-Math.max(0, t - entry.at - 7 * dayTicksSafe) / (60 * dayTicksSafe));
  const recEff = Math.exp(-Math.max(0, t - entry.at) / (30 * dayTicksSafe));
  return 0.55 * impEff + 0.45 * recEff;
}

function compact(container, t, dayTicks) {
  if (container.entries.length <= NPC_MEMORY.maxEntries) return;
  const dt = Math.max(1, finiteOr(dayTicks, 24));
  // 1) 同一游戏日、同一 kind、低重要度的 episode/dialogue 合并成一条计数摘要。
  const groups = new Map();
  for (const entry of container.entries) {
    if (entry.state?.day === true || isPinnedEntry(entry)) continue;
    if (entry.kind !== 'episode' && entry.kind !== 'dialogue') continue;
    if (entry.importance >= 0.35) continue;
    const key = `${entry.kind}|${dayOf(entry.at, dt)}`;
    const list = groups.get(key) ?? [];
    list.push(entry);
    groups.set(key, list);
  }
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const keep = list.reduce((a, b) => (a.id <= b.id ? a : b));
    const count = list.length;
    keep.summary = clip(`第${dayOf(keep.at, dt) + 1}天：类似的事 ×${count}`, NPC_MEMORY.summaryMax.episode);
    keep.importance = Math.max(...list.map((x) => x.importance));
    keep.at = Math.max(...list.map((x) => x.at));
    keep.state = { m: null, ak: null, ok: null, rid: null, day: true };
    container.stats.compacted += count - 1;
    const drop = new Set(list.filter((x) => x !== keep).map((x) => x.id));
    container.entries = container.entries.filter((x) => !drop.has(x.id));
  }
  if (container.entries.length <= NPC_MEMORY.maxEntries) return;
  // 2) 60 天前的日摘要（reflect）按 30 天桶压缩。
  const dayEntries = container.entries.filter((e) => e.state?.day === true && !e.state?.bucket && e.state?.node !== true);
  const old = dayEntries.filter((e) => t - e.at > 60 * dt);
  const buckets = new Map();
  for (const entry of old) {
    const key = Math.floor(dayOf(entry.at, dt) / 30);
    const list = buckets.get(key) ?? [];
    list.push(entry);
    buckets.set(key, list);
  }
  for (const list of buckets.values()) {
    if (list.length < 3) continue;
    const keep = list.reduce((a, b) => (a.id <= b.id ? a : b));
    const first = Math.min(...list.map((x) => x.at));
    const last = Math.max(...list.map((x) => x.at));
    keep.summary = clip(`第${dayOf(first, dt) + 1}–${dayOf(last, dt) + 1}天：日子这么过下来的`, NPC_MEMORY.summaryMax.knowledge);
    keep.at = last;
    keep.state = { secretId: null, day: true, bucket: true };
    container.stats.compacted += list.length - 1;
    const drop = new Set(list.filter((x) => x !== keep).map((x) => x.id));
    container.entries = container.entries.filter((x) => !drop.has(x.id));
  }
}

export function enforceLimits(container, { t = null, dayTicks = null } = {}) {
  if (!container || container.entries.length <= NPC_MEMORY.maxEntries) return container;
  const dt = Math.max(1, finiteOr(dayTicks, container.dt));
  const now = Number.isFinite(t) ? t : Math.max(...container.entries.map((e) => e.at));
  compact(container, now, dt);
  // pinned 超员：先把已结算的承诺降级，再按重要度从低到高让位。
  let pinned = container.entries.filter(isPinnedEntry);
  if (pinned.length > NPC_MEMORY.pinnedMax) {
    const demote = pinned.filter((e) => e.kind === 'commitment' && e.state?.status !== 'open')
      .sort((a, b) => a.importance - b.importance || a.at - b.at || a.id - b.id);
    for (const entry of demote) {
      if (pinned.length <= NPC_MEMORY.pinnedMax) break;
      entry.state = { ...entry.state, node: false };
      entry.importance = Math.min(entry.importance, 0.79);
      pinned = container.entries.filter(isPinnedEntry);
    }
  }
  const pinnedIds = new Set(container.entries.filter(isPinnedEntry).sort((a, b) => b.importance - a.importance || b.at - a.at).slice(0, NPC_MEMORY.pinnedMax).map((e) => e.id));
  const dayIds = new Set(container.entries.filter((e) => e.state?.day === true)
    .sort((a, b) => b.at - a.at || b.id - a.id).slice(0, NPC_MEMORY.dayReserve).map((e) => e.id));
  while (container.entries.length > NPC_MEMORY.maxEntries) {
    let index = -1;
    let best = Infinity;
    for (let i = 0; i < container.entries.length; i += 1) {
      const entry = container.entries[i];
      if (pinnedIds.has(entry.id) || dayIds.has(entry.id)) continue;
      const score = evictScore(entry, now, dt);
      if (score < best) { best = score; index = i; }
    }
    if (index < 0) break;
    container.entries.splice(index, 1);
    container.stats.evicted += 1;
  }
  return container;
}

// ── 存档清洗 / 旧档迁移 ────────────────────────────────────────────────────────

export function normalizeContainer(raw, id, dayTicks = 24) {
  const container = newContainer(id, raw?.dt ?? dayTicks);
  const seen = new Set();
  const rows = Array.isArray(raw?.entries) ? raw.entries : [];
  for (const row of rows) {
    const entry = sanitizeEntry(row);
    if (!entry) continue;
    if (seen.has(entry.id)) entry.id = nextIdOf(container);
    seen.add(entry.id);
    container.entries.push(entry);
  }
  container.nextId = nextIdOf(container);
  container.stats = {
    written: Math.max(0, Math.round(finiteOr(raw?.stats?.written, 0))),
    evicted: Math.max(0, Math.round(finiteOr(raw?.stats?.evicted, 0))),
    compacted: Math.max(0, Math.round(finiteOr(raw?.stats?.compacted, 0))),
  };
  if (container.entries.length > NPC_MEMORY.maxEntries) {
    const t = Math.max(...container.entries.map((e) => e.at));
    enforceLimits(container, { t, dayTicks: container.dt });
  }
  return container;
}

function migrateContainer(world, agent) {
  const rows = Array.isArray(agent?.memory?.rows) ? agent.memory.rows : [];
  const talk = world?.survival?.talkMemory?.[agent?.id] ?? null;
  const requests = (world?.survival?.requests ?? []).filter((r) => r?.from === agent?.id);
  const commit = world?.survival?.coop?.task?.commit?.[agent?.id] ?? null;
  if (!rows.length && !talk && !requests.length && !commit) return null;
  const container = newContainer(agent.id, world?.dayTicks ?? 24);
  const talkMin = Array.isArray(talk?.recent) && talk.recent.length ? finiteOr(talk.recent.at(-1)?.atMin, 0) : 0;
  for (const row of rows) {
    const label = labelOf(row.kind);
    const payload = String(row.payload ?? '');
    const about = /^来自([A-Za-z0-9_]+)$/.exec(payload)?.[1] ?? null;
    const detail = payload && payload !== '来自环境' ? (about ? `（来自${about}）` : `：${payload}`) : '';
    addEntry(container, {
      at: row.t, kind: 'episode', summary: `${label}${detail}`,
      entities: about ? [about] : [], source: SOURCE_OWN, importance: clamp01(row.importance),
      state: { m: row.m ?? null, ak: row.actionKind ?? null, ok: row.actionSucceeded === true ? true : row.actionSucceeded === false ? false : null, rid: Number.isSafeInteger(row.id) ? row.id : null, ...(row.kind === 'reflect' ? { day: true } : {}) },
    }, { t: row.t, dayTicks: container.dt });
  }
  if (talk && typeof talk.summary === 'string' && talk.summary) {
    addEntry(container, {
      at: finiteOr(talk.lastAt, 0), kind: 'dialogue', summary: clip(talk.summary, NPC_MEMORY.summaryMax.dialogue),
      entities: ['p1'], source: SOURCE_PLAYER, importance: 0.55, state: { atMin: talkMin, who: 'p1' },
    }, { t: finiteOr(talk.lastAt, 0), dayTicks: container.dt });
  }
  if (talk && Array.isArray(talk.recent)) {
    for (const row of talk.recent.slice(-24)) {
      if (!row || typeof row.text !== 'string' || !row.text) continue;
      addEntry(container, {
        at: finiteOr(talk.lastAt, 0), kind: 'dialogue', summary: clip(row.text, NPC_MEMORY.summaryMax.dialogue),
        entities: row.who === 'p1' ? ['p1'] : [], source: row.who === 'p1' ? SOURCE_PLAYER : SOURCE_OWN,
        importance: 0.2, state: { atMin: finiteOr(row.atMin, 0), who: row.who === 'p1' ? 'p1' : agent.id },
      }, { t: finiteOr(talk.lastAt, 0), dayTicks: container.dt });
    }
  }
  for (const req of requests) {
    recordCommitment(container, {
      at: finiteOr(req.t, 0), summary: clip(`答应过：${req.kind === 'food' ? '分一点吃的' : '借一根木头'}（${agent.name ?? agent.id}提的）`, NPC_MEMORY.summaryMax.commitment),
      by: agent.id, to: 'p1', dueAt: finiteOr(req.t, 0) + 48, actionKind: null, source: SOURCE_OWN, importance: 0.65,
    });
  }
  if (commit) {
    recordCommitment(container, {
      at: finiteOr(world?.t, 0), summary: clip('答应过：到工地上帮玩家搭手', NPC_MEMORY.summaryMax.commitment),
      by: agent.id, to: 'p1', dueAt: null, actionKind: null, source: SOURCE_OWN, importance: 0.6,
    });
  }
  return container;
}

// 正式连续世界才启用统一记忆：研究态（gameRules:false）与“正式规则但无 simClock”的旧档/对照
// （v11-research 的 legacy-formal 基线）继续走旧的 EpisodicMemory 轨迹，形状与 md5 逐位不变。
export function memoryEnabled(world) {
  return Boolean(world?.gameRules && world?.simClock && world?.survival);
}

// 读档：清洗已有容器；旧档从 memory.rows + talkMemory + requests/coop 迁移。幂等（无 Date.now）。
export function restoreNpcMemory(world) {
  const survival = world?.survival;
  if (!survival) return;
  if (!memoryEnabled(world)) { delete survival.npcMemory; return; }
  const raw = survival.npcMemory && typeof survival.npcMemory === 'object' && !Array.isArray(survival.npcMemory) ? survival.npcMemory : null;
  const box = {};
  for (const agent of Object.values(world.agents ?? {})) {
    if (!agent || agent.isPlayer) continue;
    const stored = raw && raw[agent.id] && typeof raw[agent.id] === 'object' ? raw[agent.id] : null;
    const container = stored ? normalizeContainer(stored, agent.id, world.dayTicks) : migrateContainer(world, agent);
    if (!container) continue;
    box[agent.id] = container;
    agent.npcMemory = container;
    attachMirror(agent, container);
  }
  const ids = Object.keys(box);
  if (ids.length > NPC_MEMORY.residentsMax) {
    const keep = ids.map((id) => ({ id, agent: world.agents[id], last: box[id].entries.reduce((m, e) => Math.max(m, e.at), 0) }))
      .sort((a, b) => (Number(!!a.agent?.dead) - Number(!!b.agent?.dead)) || b.last - a.last || (a.id < b.id ? -1 : 1))
      .slice(0, NPC_MEMORY.residentsMax);
    const keepIds = new Set(keep.map((row) => row.id));
    for (const id of ids) if (!keepIds.has(id)) {
      delete box[id];
      if (world.agents?.[id]) delete world.agents[id].npcMemory;
    }
  }
  if (Object.keys(box).length) survival.npcMemory = box;
  else delete survival.npcMemory;
}

// 正式世界的旁路镜像：memory.onAdd 未设置时旧行为逐位不变。
export function attachMirror(agent, container) {
  const memory = agent?.memory;
  if (!memory) return;
  memory.onAdd = (row) => { mirrorEpisode(container, row); };
}

export function ensureNpcMemory(world, agent) {
  if (!memoryEnabled(world) || !agent || agent.isPlayer) return null;
  if (agent.npcMemory) return agent.npcMemory;
  const box = world.survival.npcMemory = (world.survival.npcMemory && typeof world.survival.npcMemory === 'object' && !Array.isArray(world.survival.npcMemory)) ? world.survival.npcMemory : {};
  const container = box[agent.id] ?? newContainer(agent.id, world.dayTicks ?? 24);
  box[agent.id] = container;
  agent.npcMemory = container;
  attachMirror(agent, container);
  return container;
}

// 对话历史补水：统一层里属于该 NPC 的最近若干条对话（跨会话）。
export function dialogueHistory(container, max = 16) {
  const rows = (container?.entries ?? []).filter((e) => e.kind === 'dialogue' && e.state?.who && e.state?.summary !== true)
    .sort((a, b) => a.at - b.at || a.id - b.id).slice(-Math.max(0, Math.round(max)));
  return rows.map((e) => ({ who: e.state.who, text: e.summary, atMin: finiteOr(e.state.atMin, 0) }));
}

// 面板 view：最近 + 重要，字段白名单（不含 secrets / 关系 / trust）。
export function memoryPanelView(container, { dayTicks = 24, limit = 12 } = {}) {  const dt = sanitizeDayTicks(dayTicks);
  const entries = container?.entries ?? [];
  if (!entries.length) return null;
  const rowOf = (entry) => ({
    kind: entry.kind, source: entry.source, at: entry.at, day: dayOf(entry.at, dt) + 1,
    summary: clip(entry.summary, 80), importance: round2(entry.importance),
  });
  const pinned = entries.filter(isPinnedEntry).sort((a, b) => b.at - a.at || b.id - a.id).slice(0, 4);
  const recent = [...entries].sort((a, b) => b.at - a.at || b.id - a.id).slice(0, Math.max(0, Math.round(limit)));
  const seen = new Set();
  const out = [];
  const max = Math.max(1, Math.round(limit));
  for (const entry of [...pinned, ...recent]) {
    if (out.length >= max) break;
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    out.push(rowOf(entry));
  }
  return { total: entries.length, pinned: entries.filter(isPinnedEntry).length, entries: out };
}

// 决策提示词里的回忆行：与对话/主动搭话同一检索入口（260 字符/≤4 条），只影响模型看得到什么。
export function decisionRecallLines(agent, world, trigger) {
  const container = agent?.npcMemory;
  if (!container || !memoryEnabled(world)) return [];
  const dayTicks = world.dayTicks ?? 24;
  const result = retrieve(container, { t: world.t, query: String(trigger ?? ''), names: [], m: agent.bank?.m },
    { chars: 260, maxEntries: 4, kinds: ['episode', 'commitment', 'knowledge'] });
  return result.entries.map((entry) => {
    const day = dayOf(entry.at, dayTicks) + 1;
    const source = entry.source === SOURCE_PLAYER ? '玩家' : entry.source === SOURCE_OWN ? '亲历' : `听说·${entry.source.slice(3)}`;
    const kind = entry.kind === 'commitment' ? '承诺' : entry.kind === 'knowledge' ? '知道' : '旧事';
    return `· [${kind}·第${day}天·${source}] ${entry.summary}`;
  });
}

// /world 的居民投影：只在正式游戏出现；研究/compare 形状逐位不变。
export function agentMemoryView(world, agent) {
  if (!memoryEnabled(world) || !agent || agent.isPlayer) return {};
  const container = agent.npcMemory ?? world.survival?.npcMemory?.[agent.id] ?? null;
  if (!container) return {};
  const view = memoryPanelView(container, { dayTicks: world.dayTicks ?? 24, limit: 12 });
  return view ? { memory: view } : {};
}
