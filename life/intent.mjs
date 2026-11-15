// S2 意图通道（2026-11-15）：一条意图消息 = 一个结构化事件。
// 分工：模型只写"怎么说"（text），规则层决定"能不能说、说了有什么用"——模型不能直接改世界状态。
// 只在 GAME_RULES=1 的游戏态生效；研究路径不调用（否则会动五面基线）。

export const INTENT_ACTS = Object.freeze(['request', 'offer', 'warn', 'inform', 'greet', 'accuse', 'thank', 'decline', 'refuse']);
export const INTENT_TOPICS = Object.freeze(['food', 'firewood', 'shelter', 'child', 'work', 'weather', 'boundary', 'trust']);
// 所有者批准的口径：每人每游戏日主动发言 A=3，同一对同日 P=1。
export const INTENT_CAPS = Object.freeze({ perDay: 3, perPairPerDay: 1 });
export const INTENT_LOG_CAP = 240;
export const INTENT_TEXT_MAX = 28;

// 后果表：小、闭合、可断言。一次交流信任变化上限 ±8（设计 §3.1）。
const EFFECTS = Object.freeze({
  greet: { trust: 1, familiarity: 0.02, valence: 0.15 },
  thank: { trust: 2, familiarity: 0.02, valence: 0.35 },
  offer: { trust: 1, familiarity: 0.03, valence: 0.25 },
  inform: { trust: 0.5, familiarity: 0.01, valence: 0.05 },
  request: { trust: 0, familiarity: 0.01, valence: 0 },
  decline: { trust: -0.5, familiarity: 0.01, valence: -0.1 },
  refuse: { trust: -1, familiarity: 0, valence: -0.3 },
  warn: { trust: -2, familiarity: 0.01, valence: -0.4 },
  accuse: { trust: -3, familiarity: 0, valence: -0.6 },
});
export const MAX_TRUST_DELTA = 8;

// 模板只用于"降级/替身"与离线测试：模型给了 text 就用模型的。
const TEMPLATES = Object.freeze({
  greet: { food: '吃了吗？', firewood: '柴还够烧吗？', shelter: '屋顶还漏吗？', child: '孩子还好吧。', work: '今天忙哪样？', weather: '这天气要变。', boundary: '最近都还好？', trust: '有事就找我。' },
  request: { food: '能匀我一份吃的吗？', firewood: '借我两根柴。', shelter: '今晚能借住一晚吗？', child: '帮我照看下孩子。', work: '这活能搭把手吗？', weather: '明天要下雨，帮个忙。', boundary: '别进我那片地。', trust: '这事我只信你。' },
  offer: { food: '我这儿多一份，拿去。', firewood: '柴我砍多了，分你。', shelter: '屋里还有空，来住。', child: '孩子我帮你看会儿。', work: '这活我来搭把手。', weather: '要变天了，收衣服。', boundary: '我那边给你们留着。', trust: '我信你，才跟你说。' },
  warn: { food: '仓里要空了，省着点。', firewood: '柴堆见底了，得去砍。', shelter: '墙根松了，别靠。', child: '孩子别让他乱跑。', work: '那活今天别干。', weather: '夜里降温，多盖点。', boundary: '别再往那边走。', trust: '有人在背后说你。' },
  inform: { food: '东边树下还有浆果。', firewood: '瞭台那边倒了两棵树。', shelter: '公仓漏雨了。', child: '孩子在菜园那边。', work: '工坊今天缺人。', weather: '明天有雨。', boundary: '河边涨水了。', trust: '他刚才在说你。' },
  accuse: { food: '你偷了公仓的粮。', firewood: '柴是你拿走的吧。', shelter: '你把屋顶弄坏的。', child: '你别再吓孩子。', work: '这活你根本没干。', weather: '别拿天气当借口。', boundary: '你又越界了。', trust: '你一直在骗我。' },
  thank: { food: '谢了，这口饭记着。', firewood: '柴我记你一份情。', shelter: '收留之恩我记着。', child: '谢谢你照看孩子。', work: '这活多亏你。', weather: '谢你提醒收衣服。', boundary: '谢你守规矩。', trust: '谢谢你信我。' },
  decline: { food: '这会儿真没有。', firewood: '柴我自己也不够。', shelter: '屋里住不下。', child: '我看不了孩子。', work: '这活我帮不上。', weather: '明天再说吧。', boundary: '那地方不能进。', trust: '这事我不能答应。' },
  refuse: { food: '不给。', firewood: '柴不借。', shelter: '不留你。', child: '孩子不给你看。', work: '不干。', weather: '少废话。', boundary: '你敢过去试试。', trust: '别跟我提这个。' },
});

const CONTROL = /[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029\ufeff]/g;

// 归一化：去控制/零宽、压空白、截到 28 字。模型给的 text 与模板都走这里。
export function normalizeIntentText(text) {
  const clean = String(text ?? '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  return [...clean].slice(0, INTENT_TEXT_MAX).join('');
}

export function templateText(act, topic) {
  return TEMPLATES[act]?.[topic] ?? '';
}

// 当日上限账本。按游戏日重置（day = dayOf(world.t)）。
function capsFor(world, day) {
  const s = world.survival;
  const caps = s.intentCaps ??= { day, by: {}, pair: {} };
  if (caps.day !== day) {
    caps.day = day;
    caps.by = {};
    caps.pair = {};
  }
  return caps;
}

function pairKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

// 能不能说：同地点、双方活着、清醒（不在睡/谈话中）、词表闭合、文本可接受。
export function validateIntent(world, from, to, { act, topic, text } = {}) {
  const s = world.survival;
  if (!s) return { ok: false, code: 'NO_SURVIVAL' };
  const a = world.agents[from], b = world.agents[to];
  if (!a || !b) return { ok: false, code: 'NO_AGENT' };
  if (a.dead || b.dead) return { ok: false, code: 'DEAD' };
  if (from === to) return { ok: false, code: 'SELF' };
  if (!INTENT_ACTS.includes(act)) return { ok: false, code: 'BAD_ACT' };
  if (!INTENT_TOPICS.includes(topic)) return { ok: false, code: 'BAD_TOPIC' };
  if (world.loc[from] !== world.loc[to]) return { ok: false, code: 'NOT_TOGETHER' };
  if (s.talk && (s.talk.target === from || s.talk.target === to)) return { ok: false, code: 'TALKING' };
  const normalized = normalizeIntentText(text ?? templateText(act, topic));
  if (!normalized) return { ok: false, code: 'EMPTY_TEXT' };
  const day = Math.floor((world.t ?? 0) / (world.dayTicks ?? 24));
  const caps = capsFor(world, day);
  if ((caps.by[from] ?? 0) >= INTENT_CAPS.perDay) return { ok: false, code: 'DAY_CAP' };
  if ((caps.pair[pairKey(from, to)] ?? 0) >= INTENT_CAPS.perPairPerDay) return { ok: false, code: 'PAIR_CAP' };
  return { ok: true, code: 'OK', text: normalized, day, caps };
}

// 规则层裁决后投递：关系变化 + 接收方留痕 + 日志（环形）。
export function converse(world, from, to, { act = 'greet', topic = 'trust', say = null, served = 'standin' } = {}) {
  const gate = validateIntent(world, from, to, { act, topic, text: say });
  if (!gate.ok) return gate;
  const s = world.survival;
  const speaker = world.agents[from], target = world.agents[to];
  const effect = EFFECTS[act] ?? EFFECTS.greet;
  const dTrust = Math.max(-MAX_TRUST_DELTA, Math.min(MAX_TRUST_DELTA, effect.trust));
  const before = target.relations?.get?.(from)?.trust ?? 30;
  target.relations?.meet?.(from, world.t, { delta: { trust: dTrust, familiarity: effect.familiarity } });
  const after = target.relations?.get?.(from)?.trust ?? before;
  const entry = {
    t: world.t, day: gate.day, from, to, act, topic, text: gate.text, served,
    effect: { trust: Number((after - before).toFixed(3)), familiarity: effect.familiarity },
  };
  target.receiveMessage?.(world, entry);
  speaker.drives?.reward?.('social', 0.12);
  target.drives?.reward?.('social', 0.12);
  const log = s.converseLog ??= [];
  log.push(entry);
  if (log.length > INTENT_LOG_CAP) log.splice(0, log.length - INTENT_LOG_CAP);
  gate.caps.by[from] = (gate.caps.by[from] ?? 0) + 1;
  gate.caps.pair[pairKey(from, to)] = (gate.caps.pair[pairKey(from, to)] ?? 0) + 1;
  s.intents ??= 0;
  s.intents += 1;
  return { ok: true, code: 'OK', entry };
}

// 每刻至多一次遭遇对话：同地点两人，按 t+双方 id 的确定性哈希挑 act/topic。
export function converseRound(world) {
  if (!world.gameRules || !world.survival) return null;
  const dayTicks = world.dayTicks ?? 24;
  const byLoc = new Map();
  for (const a of Object.values(world.agents)) {
    if (a.dead || a.isPlayer) continue;
    const loc = world.loc[a.id];
    if (!loc) continue;
    if (!byLoc.has(loc)) byLoc.set(loc, []);
    byLoc.get(loc).push(a.id);
  }
  const pairs = [...byLoc.values()].filter((ids) => ids.length >= 2);
  if (!pairs.length) return null;
  // 确定性挑选：世界刻决定选哪一组、谁先说
  const pick = pairs[(world.t + dayTicks) % pairs.length];
  const from = pick[world.t % pick.length];
  const to = pick[(world.t + 1) % pick.length];
  if (from === to) return null;
  const h = (world.t * 2654435761 + from.length * 97 + to.length * 131) >>> 0;
  const act = INTENT_ACTS[h % INTENT_ACTS.length];
  const topic = INTENT_TOPICS[(h >>> 5) % INTENT_TOPICS.length];
  return converse(world, from, to, { act, topic, served: 'standin' });
}
