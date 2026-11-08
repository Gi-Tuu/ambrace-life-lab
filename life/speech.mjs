// PLAN §28 D：演示世界的语言层。
// 两条明确的边界，写在最前面：
//  1) NPC 的话是**状态条件化的确定性模板**（不是生成式对话），同状态同刻同台词，可复现；
//  2) 玩家的话走**关键词意图分类**（不是语义理解）——只认六个意图类，其余按中立处理。
// 这两条都要原样写进交付文案，不许把它说成"听懂"。
import { phaseOf } from './clock.mjs';

const WEATHER_WORD = { clear: '天还算清', rain: '下着雨', cold: '有点冷' };

const hashOf = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h;
};
const pick = (arr, seedStr) => arr[hashOf(seedStr) % arr.length];

export function speechLine(agent, { world, kind, actionId = '', t = 0 }) {
  const e = agent.drives?.v?.energy ?? 1;
  const s = agent.drives?.v?.social ?? 1;
  const who = actionId.split(':')[1];
  const target = who ? (world.agents[who]?.name ?? who) : null;
  const place = (world.locs ?? {})[world.loc[agent.id]] ?? world.loc[agent.id];
  const mood = e < 0.3 ? '饿' : s < 0.35 ? '闷' : e > 0.8 && s > 0.8 ? '稳' : '平';
  const weather = WEATHER_WORD[world.weather] ?? '';
  const pool = {
    rest: [`${weather ? weather + '，' : ''}靠一会儿。`, '歇口气。', '先坐一下。'],
    eat: [`${mood === '饿' ? '总算能吃了。' : '吃点东西。'}`, '就着存的吃一口。'],
    talk: [`${target ?? '你'}，最近怎么样？`, `${target ?? '你'}，说两句。`, `和${target ?? '你'}聊两句。`],
    move_to: [`去${place}看看。`, `${place}那边走走。`, `${weather && world.weather !== 'clear' ? '躲躲，' : ''}我去${place}。`],
    look_out: [weather && world.weather !== 'clear' ? '外面这天……' : '去看看外面。', '瞭台那边看看。'],
    take_shared: ['门口还有一份。', '先拿一点应应急。'],
    work: ['工坊的活还没完。', '去干活，换点补给。'],
    trade: [`和${target ?? '他'}换点东西。`, '有来有往。'],
    companion: [`和${target ?? '他'}一起待会儿。`, '有个伴。'],
    deafen: ['让我静一静。', '先不听了。'],
    seclude: ['一个人待着。', '别找我。'],
    refuse: [`不想理${target ?? '他'}。`, '今天不说了。'],
    default: ['……', '嗯。'],
  }[kind] ?? ['嗯。'];
  const phase = phaseOf(t);
  const line = pick(pool, `${agent.id}|${t}|${kind}|${actionId}|${mood}`);
  return phase === '夜' ? line.replace(/。$/, '，夜里了。') : line;
}

// 关键词意图分类：优先级从强到弱；返回的 trust 是直接加到「说话者→对方」关系上的量。
const INTENTS = [
  { kind: 'accuse', re: /偷|贼|骗子|拿了|过分|不要脸/, valence: -0.5, trust: -4, serves: 'social' },
  { kind: 'apologize', re: /对不起|抱歉|不好意思|我错了/, valence: 0.25, trust: 2, serves: 'social' },
  { kind: 'warn', re: /小心|当心|注意|别去|危险/, valence: 0.3, trust: 1, serves: 'social' },
  { kind: 'share', re: /告诉你|听说|知道吗|有件事/, valence: 0.25, trust: 1, serves: 'social' },
  { kind: 'ask_food', re: /饿|吃的|饭|一口|分我/, valence: 0.1, trust: 0, serves: 'social' },
  { kind: 'greet', re: /你好|嗨|早上好|在吗|早啊/, valence: 0.2, trust: 0, serves: 'social' },
];

export function classifySay(text) {
  const s = String(text ?? '');
  for (const i of INTENTS) if (i.re.test(s)) return { kind: i.kind, valence: i.valence, trust: i.trust, serves: i.serves };
  return { kind: 'neutral', valence: 0.1, trust: 0, serves: 'social' };
}
