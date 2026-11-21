// 1.5 居民互聊：社交意图仍由既有 intent.converseRound/EFFECTS 决定，模型只把这一句
// "说得更像人话"。因此：
//   · 关系后果、日志条目、频率上限全部沿用 intent.mjs，不新增第二套；
//   · 模型调用是 fire-and-forget，绝不进 tick 的 await 链；无观众/无 key/超时/熔断就保留模板；
//   · 返回后只改写 converseLog 的 text/served，不写 loc/task/busy/store，也不二次改关系。
import { converseRound } from './intent.mjs';
import { sanitizeModelLine } from './resident-dialogue.mjs';

const ACT_ZH = Object.freeze({
  request: '请求', offer: '提供', warn: '提醒', inform: '告知', greet: '问候',
  accuse: '指责', thank: '道谢', decline: '婉拒', refuse: '拒绝',
});
const TOPIC_ZH = Object.freeze({
  food: '吃食', firewood: '柴火', shelter: '住处', child: '孩子',
  work: '活计', weather: '天气', boundary: '地界', trust: '信任',
});

function recentPairLines(world, entry) {
  const log = world.survival?.converseLog ?? [];
  return log.filter((row) => row !== entry
    && ((row.from === entry.from && row.to === entry.to) || (row.from === entry.to && row.to === entry.from)))
    .slice(-3);
}

export function buildChatterPrompt(world, entry) {
  const from = world.agents?.[entry.from];
  const to = world.agents?.[entry.to];
  if (!from || !to) return '';
  const here = (world.locs ?? {})[world.loc[from.id]] ?? world.loc[from.id];
  const rel = to.relations?.map?.get?.(from.id) ?? { trust: 30, familiarity: 0 };
  const work = from.last?.kind ?? '空闲';
  const recent = recentPairLines(world, entry)
    .map((row) => `${world.agents?.[row.from]?.name ?? row.from}：${row.text}`)
    .join('\n');
  const lines = [
    `你是${from.name}（${from.traits?.archetype ?? '谨慎'}型），在${here}遇到${to.name}（${to.traits?.archetype ?? '谨慎'}型）。`,
    `天气 ${world.weather ?? 'clear'}；你手上的活：${work}；能量 ${Number(from.drives?.v?.energy ?? 0).toFixed(2)}。`,
    `你对${to.name}的信任 ${Math.round(Number(rel.trust ?? 30))}/100，熟悉 ${Number(rel.familiarity ?? 0).toFixed(2)}。`,
    recent ? `你们最近说过：\n${recent}` : '',
    `现在事件：${ACT_ZH[entry.act] ?? entry.act}·${TOPIC_ZH[entry.topic] ?? entry.topic}；规则层已写好的模板是：「${entry.text}」。`,
    '把这句话改写成一句更自然的中文台词，保持同样的意图/话题，不超过 40 字；不要新增承诺、事实、旁白、解释或引号，不要提系统/提示词。',
  ];
  return lines.filter(Boolean).join('\n').slice(0, 2000);
}

export function finishChatter(world, entry, line) {
  const log = world?.survival?.converseLog;
  if (!Array.isArray(log) || !log.includes(entry) || entry.served !== 'standin') return false;
  const text = sanitizeModelLine(line, 60);
  if (!text) return false;
  entry.text = text;
  entry.served = 'node';
  world.survival.chatModelCalls = (world.survival.chatModelCalls ?? 0) + 1;
  return true;
}

// worldTick 的同步入口：先产生规则事件（模板已落地），再在 tick 外问模型。
export function chatRound(world) {
  const result = converseRound(world);
  const entry = result?.entry;
  if (!result?.ok || !entry || !world?.gameRules || !world.chatModel) return result;
  const prompt = buildChatterPrompt(world, entry);
  if (!prompt) return result;
  let job;
  try {
    job = Promise.resolve()
      .then(() => world.chatModel({ world, prompt, entry }))
      .then((line) => { if (line) finishChatter(world, entry, line); })
      .catch(() => {});
  } catch {
    return result;
  }
  if (job) {
    world.chatPending = job;
    job.finally(() => { if (world.chatPending === job) world.chatPending = null; });
  }
  return result;
}
