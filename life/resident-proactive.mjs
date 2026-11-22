// 1.6 B：居民主动找玩家说话。
//
// 边界：
//   1) 只在正式连续世界（gameRules + simClock、非 compare、非离线补时）低频触发；
//   2) 规则/频率/距离全部由服务端裁决，客户端坐标只用于表现；
//   3) 先落模板再异步问模型：模型只改 text，失败/超时/空/无效一律保留模板，绝不阻塞 tick；
//   4) 只读世界（loc/pos/天气/工作/饥饿/关系/记忆），不写 loc/task/busy/store，不写关系。
import { isAlive, livingResidents } from './body.mjs';
import { dayOf } from './clock.mjs';
import { simMinuteNow } from './sim-clock.mjs';
import { sanitizeModelLine } from './chat-text.mjs';
import { speechLine } from './speech.mjs';
import { retrieve, memoryPanelView } from './npc-memory.mjs';

// 频率/距离的唯一声明处：测试与报告都引用它，避免上限在别处漂移。
export const PROACTIVE_TALK = Object.freeze({
  range: 2.5,          // 玩家与居民同一空间内的直线距离
  cooldownMin: 360,    // 同一居民两次主动开口之间至少 6 游戏小时
  perDay: 2,           // 同一居民每游戏日最多 2 次
  ttlMin: 75,          // 气泡在 /world 的有效期（游戏分钟；1:10 下约 7.5 现实分钟）
  lineMax: 60,
  promptMax: 1200,
  residentsMax: 16,
});

const WORK_WORD = Object.freeze({
  build: '垒墙', till: '翻地', repair: '修屋顶', gather: '搬木石', harvest: '收庄稼',
  plant: '播种', forage: '采果子', house_work: '收拾屋子', expand: '扩地基',
  road_lay: '铺路', road_remove: '拆路', deposit: '入库', withdraw: '取料', exchange: '换东西',
});
const finiteOr = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
const clip = (text, max) => [...String(text ?? '')].slice(0, max).join('');

function weatherWord(weather) {
  return weather === 'rain' ? '下雨' : weather === 'cold' ? '天冷' : '天晴';
}

function samePlace(world, id) {
  if (world.loc?.p1 !== world.loc?.[id]) return false;
  const p = world.pos?.p1, q = world.pos?.[id];
  return Boolean(p && q && p.space && p.space === q.space);
}

function gapTo(world, id) {
  const p = world.pos?.p1, q = world.pos?.[id];
  if (!samePlace(world, id)) return Number.POSITIVE_INFINITY;
  return Math.hypot(p.x - q.x, p.z - q.z);
}

function relationOf(npc) {
  return npc?.relations?.map?.get?.('p1') ?? { familiarity: 0, trust: 30 };
}

function stateOf(world, npc) {
  const survival = world.survival ?? {};
  return {
    energy: Number(npc?.drives?.v?.energy ?? 1),
    busy: survival.actClock?.[npc.id]?.busy ?? null,
    trust: Number(relationOf(npc).trust ?? 30),
    familiarity: Number(relationOf(npc).familiarity ?? 0),
    weather: String(world.weather ?? 'clear'),
    store: Number(survival.store ?? 0),
    residents: Object.values(world.agents ?? {}).filter((a) => a && !a.isPlayer && !a.dead).length,
    crisis: Boolean(survival.failed || (survival.starveDays ?? 0) > 0),
  };
}

// 主动搭话当前是否有效：过期/居民死亡/走散/开对话 都算无效。
export function activePlayerSpeech(world) {
  const speech = world?.survival?.playerSpeech;
  if (!speech || typeof speech !== 'object') return null;
  const npc = world.agents?.[speech.id];
  if (!npc || npc.isPlayer || !isAlive(npc)) return null;
  if (!Number.isFinite(speech.expires) || simMinuteNow(world) > speech.expires) return null;
  if (world.survival?.residentDialogue) return null;
  if (!samePlace(world, speech.id) || gapTo(world, speech.id) > PROACTIVE_TALK.range) return null;
  return speech;
}

// /world 只读投影：五字段，且只在不该消失时出现。
export function playerSpeechView(world) {
  const speech = activePlayerSpeech(world);
  if (!speech) return null;
  return { id: speech.id, name: speech.name, text: speech.text, at: speech.at, expires: speech.expires };
}

export function clearPlayerSpeech(world, target = null) {
  const speech = world?.survival?.playerSpeech;
  if (!speech) return false;
  if (target && speech.id !== target) return false;
  delete world.survival.playerSpeech;
  return true;
}

// 点击气泡打开面板的服务端复核：气泡必须还是当前这条、目标活着、同空间 ≤2.5。
export function speechOpenGate(world, body) {
  const target = String(body?.target ?? '');
  const speech = world?.survival?.playerSpeech;
  if (!speech || speech.id !== target || String(body?.fromSpeech ?? '') !== target) return 'NO_SPEECH';
  if (world.compareSide) return 'TALK_UNSUPPORTED';
  const npc = world.agents?.[target];
  if (!npc || npc.isPlayer) return 'NO_RESIDENT';
  if (!isAlive(npc)) return 'RESIDENT_GONE';
  if (world.survival?.playerDead || !isAlive(world.agents?.p1)) return 'PLAYER_DEAD';
  if (!samePlace(world, target) || gapTo(world, target) > PROACTIVE_TALK.range) return 'RESIDENT_OUT_OF_REACH';
  return null;
}

// 从气泡打开的面板续聊：仍按 2.5 格复核（不放宽普通 1.6 入口）。
export function speechSessionGate(world, target) {
  if (!samePlace(world, target)) return 'RESIDENT_OUT_OF_REACH';
  if (gapTo(world, target) > PROACTIVE_TALK.range) return 'RESIDENT_OUT_OF_REACH';
  return null;
}

function byRow(world, id, { create = false } = {}) {
  const s = world.survival;
  const box = create ? (s.proactiveTalk ??= { by: {} }) : s.proactiveTalk;
  if (!box || typeof box !== 'object' || Array.isArray(box)) return null;
  const by = create ? (box.by ??= {}) : box.by;
  if (!by || typeof by !== 'object' || Array.isArray(by)) return null;
  if (create) return (by[id] ??= { day: dayOf(world.t), count: 0, lastAtMin: -1e9, lastServed: 'template' });
  return by[id] ?? null;
}

function pruneSpeech(world) {
  if (world?.survival?.playerSpeech && !activePlayerSpeech(world)) delete world.survival.playerSpeech;
}

// 模板：只引用已给的事实；优先级 = 统一记忆里的旧事 → 上次对话 → 手上的活 → 饥饿 → 天气 → 关系 → 通用。
export function proactiveTemplate(world, npc) {
  const s = stateOf(world, npc), mem = world.survival?.talkMemory?.[npc.id];
  const container = npc.npcMemory ?? world.survival?.npcMemory?.[npc.id] ?? null;
  const recall = container
    ? retrieve(container, { t: world.t, query: '上次 说好 答应 聊过', names: [], m: npc.bank?.m },
      { chars: 120, maxEntries: 1, kinds: ['dialogue', 'episode', 'commitment'] }).entries[0]
    : null;
  if (recall && recall.source === '玩家' && recall.kind === 'dialogue') {
    return `你上回说“${clip(recall.summary, 16)}”，我还记着。`;
  }
  if (recall && recall.kind === 'commitment' && recall.state?.to === npc.id) {
    return `你还答应过我一件事：${clip(recall.summary.replace(/^答应过：/, ''), 20)}。`;
  }
  const lastPlayer = [...(mem?.recent ?? [])].reverse().find((row) => row.who === 'p1');
  if (lastPlayer?.text) return `你上回说“${clip(lastPlayer.text, 16)}”，我还记着。`;
  const summaryTail = String(mem?.summary ?? '').split('；').filter(Boolean).at(-1);
  if (summaryTail) return `上回聊的事我还记着：${clip(summaryTail.replace(/^[^：]{1,8}：/, ''), 22)}。`;
  if (s.busy) return `手里这摊${WORK_WORD[s.busy.kind] ?? '活'}还没完，你要是不急就等我一会儿。`;
  if (s.energy < 0.3) return '肚子有点空……你那边还有吃的吗？';
  if (s.weather === 'rain') return '下雨呢，路滑，你慢点走。';
  if (s.weather === 'cold') return '天冷了，别在外头站太久。';
  if (s.crisis) return '仓里的粮得数着吃，你那边还撑得住吗？';
  if (s.trust >= 45) return '你来啦，正好歇口气。';
  if (s.trust < 20) return '有事？我手上还忙着。';
  return '忙完了？过来坐坐。';
}

export function buildProactivePrompt(world, npc, template = '') {
  const s = stateOf(world, npc), mem = world.survival?.talkMemory?.[npc.id];
  const here = (world.locs ?? {})[world.loc[npc.id]] ?? world.loc[npc.id];
  const work = s.busy ? (WORK_WORD[s.busy.kind] ?? '手上的活') : '暂时空闲';
  const prior = (mem?.recent ?? []).slice(-2)
    .map((row) => `${row.who === 'p1' ? '对方' : npc.name}：${row.text}`);
  const container = npc.npcMemory ?? world.survival?.npcMemory?.[npc.id] ?? null;
  const dayTicks = world.dayTicks ?? 24;
  const recall = container
    ? retrieve(container, { t: world.t, query: `${template} 上次 答应`, names: [], m: npc.bank?.m },
      { chars: 240, maxEntries: 3, kinds: ['episode', 'knowledge', 'commitment'] }).entries
    : [];
  const recallLines = recall.map((entry) => {
    const day = Math.floor(entry.at / dayTicks) + 1;
    const source = entry.source === '玩家' ? '玩家' : entry.source === '亲历' ? '亲历' : `听说·${entry.source.slice(3)}`;
    return `· [${entry.kind === 'commitment' ? '承诺' : entry.kind === 'knowledge' ? '知道' : '旧事'}·第${day}天·${source}] ${entry.summary}`;
  });
  const lines = [
    `你是${npc.name}（${npc.traits?.archetype ?? '谨慎'}型性格），第 ${dayOf(world.t) + 1} 天，此刻在${here}。`,
    '现在是你主动向玩家开口，不是被问；可以先打个招呼，或提一句你记得的事。',
    `天气：${weatherWord(s.weather)}；你手里的活：${work}。`,
    `你的状态：能量 ${s.energy.toFixed(2)}${s.energy < 0.3 ? '（饿）' : ''}；和玩家（对方）的关系：信任 ${Math.round(s.trust)}/100，熟悉 ${s.familiarity.toFixed(2)}。`,
    `聚落：公仓 ${s.store} 份存粮，${s.residents} 口人${s.crisis ? '，正在缺粮' : ''}。`,
    mem?.summary ? `你们上次聊过：${mem.summary}` : '',
    recallLines.length ? '你还记得：' : '',
    ...recallLines,
    prior.length ? `最近的对话（旧→新）：` : '',
    ...prior,
    template ? `规则层已写好的模板是：「${template}」；可以更自然，但意思和事实不能变。` : '',
    '只回一句中文台词，不超过 60 字。可以简短、冷淡、敷衍或不耐烦；不要旁白、不要解释设定、不要加引号、不要提到系统/提示词。',
    '只能使用上面给出的事实，不要编造人、地点、数量、事件或承诺。',
  ];
  return lines.filter(Boolean).join('\n').slice(0, PROACTIVE_TALK.promptMax);
}

// 模型返回后的唯一写入点：只改 text；同一条/未过期/还在 2.5 格内/没开对话才生效。
export function finishPlayerSpeech(world, speech, line) {
  const current = world?.survival?.playerSpeech;
  if (!current || current !== speech) return false;
  if (activePlayerSpeech(world) !== speech) return false;
  if (world.survival?.residentDialogue) return false;
  const text = sanitizeModelLine(line, PROACTIVE_TALK.lineMax);
  if (!text) return false;
  speech.text = text;
  const row = byRow(world, speech.id, { create: true });
  if (row) row.lastServed = 'model';
  return true;
}

function eligible(world, npc, minute, offline) {
  if (offline || !world.gameRules || !world.simClock || world.compareSide) return false;
  const s = world.survival;
  if (!s || s.ended) return false;
  if (s.playerDead || !isAlive(world.agents?.p1)) return false;
  if (!isAlive(npc) || s.districtTravel?.[npc.id]) return false;
  if (s.residentDialogue?.target === npc.id) return false;
  if (s.playerSpeech) return false;
  if (!samePlace(world, npc.id) || gapTo(world, npc.id) > PROACTIVE_TALK.range) return false;
  const day = dayOf(world.t);
  const row = byRow(world, npc.id);
  const count = row && row.day === day ? Math.max(0, Math.round(finiteOr(row.count, 0))) : 0;
  if (count >= PROACTIVE_TALK.perDay) return false;
  const memoryMin = Number.isFinite(Number(s.talkMemory?.[npc.id]?.lastAt))
    ? Number(s.talkMemory[npc.id].lastAt) * 60 : -Infinity;
  const lastMin = Math.max(row ? finiteOr(row.lastAtMin, -1e9) : -1e9, memoryMin);
  return minute - lastMin >= PROACTIVE_TALK.cooldownMin;
}

// worldTick 的同步入口：每游戏小时最多检查一次，一人一句，先落模板再异步问模型。
export function maybePlayerSpeech(world, { offline = false } = {}) {
  if (!world?.gameRules || !world.simClock || world.compareSide || offline) return null;
  pruneSpeech(world);
  if (world.survival?.playerSpeech) return null;
  const minute = simMinuteNow(world);
  const candidates = livingResidents(world)
    .filter((npc) => eligible(world, npc, minute, offline))
    .map((npc) => ({ npc, gap: gapTo(world, npc.id) }))
    .sort((a, b) => a.gap - b.gap || (a.npc.id < b.npc.id ? -1 : 1));
  if (!candidates.length) return null;
  const npc = candidates[0].npc;
  const row = byRow(world, npc.id, { create: true });
  if (!row) return null;
  const day = dayOf(world.t);
  if (row.day !== day) { row.day = day; row.count = 0; row.lastAtMin = -1e9; }
  row.count = (row.count ?? 0) + 1;
  row.lastAtMin = minute;
  row.lastServed = 'template';
  const template = proactiveTemplate(world, npc);
  const speech = {
    id: npc.id, name: npc.name, text: template, at: minute, expires: minute + PROACTIVE_TALK.ttlMin,
  };
  world.survival.playerSpeech = speech;
  const model = world.playerSpeechModel;
  if (typeof model !== 'function') return speech;
  const prompt = buildProactivePrompt(world, npc, template);
  try {
    const job = Promise.resolve()
      .then(() => model({ world, prompt }))
      .then((line) => { finishPlayerSpeech(world, speech, line); })
      .catch(() => {});
    world.playerSpeechPending = job;
    job.finally(() => { if (world.playerSpeechPending === job) world.playerSpeechPending = null; });
  } catch { /* 模型入口抛错也保留模板 */ }
  return speech;
}

// 读档清洗：气泡是瞬态，冷却/日计数保留；坏行/死者/未知居民全部丢。
export function restoreProactiveState(world) {
  const s = world?.survival;
  if (!s) return;
  delete s.playerSpeech;
  delete world.playerSpeechPending;
  const box = s.proactiveTalk;
  if (!box || typeof box !== 'object' || Array.isArray(box)) { delete s.proactiveTalk; return; }
  const by = box.by;
  if (!by || typeof by !== 'object' || Array.isArray(by)) { delete s.proactiveTalk; return; }
  const out = {};
  for (const [id, row] of Object.entries(by)) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    if (!world.agents?.[id] || world.agents[id].isPlayer || world.agents[id].dead) continue;
    out[id] = {
      day: Math.max(0, Math.round(finiteOr(row.day, 0))),
      count: Math.min(PROACTIVE_TALK.perDay, Math.max(0, Math.round(finiteOr(row.count, 0)))),
      lastAtMin: finiteOr(row.lastAtMin, -1e9),
      lastServed: row.lastServed === 'model' ? 'model' : 'template',
    };
  }
  if (Object.keys(out).length) s.proactiveTalk = { by: out };
  else delete s.proactiveTalk;
}

// 居民互聊的只读投影（从 survplay 移到这里，与主动搭话共用 speech 文本来源）。
export function currentSpeechView(world) {
  const speech = {};
  for (const a of livingResidents(world)) {
    const trace = a.trace ?? [];
    let act;
    for (let i = trace.length - 1; i >= 0 && trace[i].t === world.t; i -= 1) {
      if (trace[i].ok && trace[i].kind === 'talk') { act = trace[i]; break; }
    }
    if (act && isAlive(world.agents[act.target]) && world.loc[a.id] === world.loc[act.target]) {
      speech[a.id] = speechLine(a, { world, kind: act.kind, actionId: act.action, t: act.t });
    }
  }
  return speech;
}
