// 1.4 玩家主动对话：轻量、确定性、零模型。
//
// 边界（与 PLAN §28 D 同一条）：
//   1) 台词是"状态条件化模板"：饥饿/工作/天气/聚落事件/关系 → 固定文案，可复现；
//   2) 不接模型车道；打开/每轮/关闭都是 0 游戏分、0 体力、0 世界动作；
//   3) 只读世界状态：不加 trust/familiarity、不动 loc/occupancy/task/busy；
//   4) 成功交谈只做两件事：打 attention（当拍停表现/选动作）、把玩家的话记进会话轮次。
import { isAlive } from './body.mjs';
import { markResidentAttention } from './resident-attention.mjs';
import { simMinuteNow } from './sim-clock.mjs';

export const RESIDENT_TOPICS = Object.freeze([
  { id: 'today', label: '今天怎么样' },
  { id: 'busy', label: '在忙什么' },
  { id: 'settlement', label: '聚落怎么样' },
  { id: 'help', label: '需要帮忙吗' },
]);
const TOPIC_IDS = new Set(RESIDENT_TOPICS.map((t) => t.id));

const WORK_WORD = Object.freeze({
  build: '垒墙', till: '翻地', repair: '修屋顶', gather: '搬木石', harvest: '收庄稼',
  plant: '播种', forage: '采果子', house_work: '收拾屋子', expand: '扩地基',
  road_lay: '铺路', road_remove: '拆路', deposit: '入库', withdraw: '取料', exchange: '换东西',
});

const hashOf = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h;
};
const pick = (arr, seed) => arr[hashOf(seed) % arr.length];

function relationOf(npc) {
  // 只读：不经过 Relations.get()，避免连"看一眼关系"都新建一条关系。
  return npc?.relations?.map?.get?.('p1') ?? { familiarity: 0, trust: 30 };
}

function stateOf(world, npc) {
  const survival = world.survival ?? {};
  const energy = Number(npc?.drives?.v?.energy ?? 1);
  const busy = survival.actClock?.[npc.id]?.busy ?? null;
  const rows = survival.eventJournal?.rows ?? [];
  const last = [...rows].reverse().find((row) => [
    'death', 'birth', 'storm_impact', 'work_completed', 'work_interrupted', 'cooperation_reply',
  ].includes(row.kind)) ?? null;
  const residents = Object.values(world.agents ?? {}).filter((a) => a && !a.isPlayer && !a.dead).length;
  const rel = relationOf(npc);
  const hungry = energy < 0.3;
  const crisis = Boolean(survival.failed || (survival.starveDays ?? 0) > 0);
  return {
    energy, busy, weather: String(world.weather ?? 'clear'), store: Number(survival.store ?? 0),
    residents, last, trust: Number(rel.trust ?? 30), familiarity: Number(rel.familiarity ?? 0),
    hungry, crisis,
  };
}

function weatherWord(weather) {
  return weather === 'rain' ? '下雨' : weather === 'cold' ? '天冷' : '天晴';
}

function eventLine(world, row) {
  if (!row) return null;
  const actorName = row.actor && world.agents?.[row.actor]?.name;
  if (row.kind === 'death') return `${actorName ?? '一位居民'}走了，聚落里安静了几天。`;
  if (row.kind === 'birth') return `${actorName ?? '有人'}家添了孩子，大家都去看了看。`;
  if (row.kind === 'storm_impact') return '前阵子的风暴掀了屋顶，还在修。';
  if (row.kind === 'work_completed') return `工地上${row.action ? `刚做完一${WORK_WORD[row.action] ?? '段活'}` : '刚做完一段活'}，大家轮着上。`;
  if (row.kind === 'work_interrupted') return '有段活被打断了，不过已经做的那部分没白干。';
  if (row.kind === 'cooperation_reply') return '前两天有人来搭过手，活轻快了些。';
  return null;
}

function openingLine(world, npc, state) {
  if (state.hungry) return '抬起头，声音有点虚：「你来得正好……我正想着去哪找口吃的。」';
  if (state.busy) return '停下手里的活，抬起头：「怎么了？我听着。」';
  if (state.trust >= 45) return '抬头看见是你，神色松下来：「是你啊，坐会儿？」';
  if (state.trust < 20) return '停下手，看了你一眼：「有事？」';
  return '抬起头：「怎么了？」';
}

function topicLine(world, npc, state, topic, turn) {
  const seed = `${npc.id}|${world.t}|${topic}|${turn}`;
  if (topic === 'today') {
    if (state.hungry) return '今天有点饿，肚子一直叫，手上的活也慢了半拍。';
    if (state.weather === 'rain') return '今天下雨，鞋底全是泥，活干得不利索。';
    if (state.weather === 'cold') return '今天冷，手缩在袖子里，做一会儿就得暖一暖。';
    if (state.crisis) return '今天不算好过，仓里的粮得数着吃。';
    const pool = [];
    if (state.trust >= 45) pool.push('今天还行，看见你过来，心里踏实些。');
    pool.push(`今天还行，${weatherWord(state.weather)}，活照常做。`);
    return pick(pool, seed);
  }
  if (topic === 'busy') {
    if (state.busy) {
      const word = WORK_WORD[state.busy.kind] ?? '手上的活';
      return `在${word}，这摊还没完；你叫我我就停一下，活不会取消，回头接着做。`;
    }
    if (state.hungry) return '没在忙什么，就是有点饿，想先找口吃的。';
    return '刚把手上的活收了个尾，正想歇口气。';
  }
  if (topic === 'settlement') {
    const event = eventLine(world, state.last);
    if (state.crisis) return `${event ? event + ' ' : ''}仓里的粮紧，${state.residents}口人得省着过。`;
    if (event) return event;
    return `聚落${state.residents}口人，${state.store}份存粮，日子照常过。`;
  }
  if (topic === 'help') {
    if (state.trust >= 45 || state.familiarity >= 0.3) return '后院那堆木料还没搬完；你要真肯搭把手，我记你的情。';
    if (state.busy) return '你要帮，就去工地上问问还缺不缺人；我这边先把手上的做完。';
    if (state.crisis) return '公仓缺粮，能带点吃的回来就是大忙。';
    return '眼下还不用，先顾好你自己；真需要我会开口。';
  }
  return '嗯。';
}

function fail(code) { return { ok: false, code }; }

function talkable(world, body) {
  const target = String(body?.target ?? '');
  const npc = world.agents?.[target];
  if (!npc || npc.isPlayer) return { code: 'NO_RESIDENT' };
  if (!isAlive(npc)) return { code: 'RESIDENT_GONE' };
  if (world.compareSide) return { code: 'TALK_UNSUPPORTED' };
  const player = world.agents?.p1;
  if (world.survival?.playerDead || !isAlive(player)) return { code: 'PLAYER_DEAD' };
  if (world.survival?.actClock?.p1?.busy) return { code: 'BUSY' };
  return { npc };
}

function response(world, npc, topic, line, turn) {
  return {
    ok: true, code: topic ? 'RESIDENT_TALK_SAY' : 'RESIDENT_TALK_OPEN',
    name: npc.name, line, topic: topic ?? null, turn,
    topics: RESIDENT_TOPICS.map((row) => ({ ...row })),
    attention: { ...world.agents[npc.id].attention },
  };
}

function sessionOf(world, target) {
  const session = world.survival?.residentDialogue;
  return session && session.target === target ? session : null;
}

// 打开面板：只认已经过距离/房间校验的 contact（camp-play 先跑 residentContact）。
export function openResidentDialogue(world, body) {
  const gate = talkable(world, body);
  if (gate.code) return fail(gate.code);
  const npc = gate.npc;
  const state = stateOf(world, npc);
  const session = world.survival.residentDialogue = {
    target: npc.id, openedAt: world.t, openedMin: simMinuteNow(world), turns: 0, lastTopic: null,
  };
  // 不写关系：旧 camp_resident 的"当天首次 trust+4"仍然只属于旧入口。
  const attention = markResidentAttention(world, npc.id, { about: 'p1' });
  return { ...response(world, npc, null, openingLine(world, npc, state), session.turns), attention };
}

// 一次话题：多轮、零成本；每轮刷新 attention（当拍继续看着玩家）。
export function sayInResidentDialogue(world, body) {
  const gate = talkable(world, body);
  if (gate.code) return fail(gate.code);
  const npc = gate.npc;
  const session = sessionOf(world, npc.id);
  if (!session) return fail('NO_DIALOGUE');
  const topic = String(body?.topic ?? '');
  if (!TOPIC_IDS.has(topic)) return fail('BAD_TOPIC');
  const state = stateOf(world, npc);
  session.turns += 1;
  session.lastTopic = topic;
  session.lastAt = world.t;
  markResidentAttention(world, npc.id, { about: 'p1' });
  return {
    ...response(world, npc, topic, topicLine(world, npc, state, topic, session.turns), session.turns),
    mood: state.hungry ? 'hungry' : state.busy ? 'busy' : state.crisis ? 'crisis'
      : state.weather !== 'clear' ? state.weather : 'steady',
  };
}

// 关闭：只清会话；attention 仍按 1 游戏分/下一拍自动到期，居民继续原任务。
export function closeResidentDialogue(world, body) {
  const target = String(body?.target ?? '');
  const session = sessionOf(world, target);
  if (session) delete world.survival.residentDialogue;
  return { ok: true, code: 'RESIDENT_TALK_CLOSED', closed: Boolean(session) };
}
