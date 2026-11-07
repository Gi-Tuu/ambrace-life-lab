// 闭环真模型实验：静默世界里需求越阈自己触发行为，模型只决定「对谁/去哪儿/怎么做」，
// 规则层校验、后果回流、再触发下一轮。
//
// 接口纪律（§17 与本轮体检的教训，写在代码里而不是靠自觉）：
//   · 提示词不含效用数字
//   · 候选清单按 id 字典序给出，不按效用排序 —— 否则「先出现在列表里」就成了混杂变量
//   · 每个变体分开记账：走了真模型的决策数 / 超预算退化为替身的决策数，后者单独打印
//   · --dry 先免费算出要打多少次调用，再决定要不要真打
import { simulate } from './run.mjs';
import { LOCS } from './body.mjs';
import { preferenceBands } from './model.mjs';

const BASE = process.env.MODEL_BASE_URL;
const MODEL = process.env.MODEL_NAME;
const KEY = process.env.MODEL_KEY;
const BUDGET = Number(process.env.MAX_CALLS ?? 120);
const SLEEP = Number(process.env.SLEEP_MS ?? 900);
const ARGS = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const TICKS = Number(ARGS[0] ?? 40);
// 多 seed：单格 40 刻只有约 60 个决策，单次读数不足以判 D vs D-rand（§23 的同 seed 65/66 就是这么来的）。
// --seeds=7,11,13 会给每个格子跑多颗种子，判据按均值看，单点只作展示。
const SEEDS = ((process.argv.find((a) => a.startsWith('--seeds=')) ?? '').split('=')[1] ?? '7').split(',').map(Number).filter(Number.isFinite);
// --arm=rand：D-rand 对照。**照常调用、照常花同样的钱、照常拿到模型的回答，然后把回答丢掉**，
// 改从同一份候选清单里均匀随机挑一个。这样两臂的唯一差别就是"答案里有没有信息"，
// 而不是"有没有被问过"——否则测到的是"被询问"的效应，不是"状态经模型抵达行为"的效应。
const ARM = (process.argv.find((a) => a.startsWith('--arm=')) ?? '').split('=')[1] ?? 'model';
const DRY = process.argv.includes('--dry');
// --only=C2-neg 只补对照行，不重跑已经完整有效的行（省一半预算）
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) ?? '').split('=')[1]?.split(',') ?? null;
// --pin=钳制 只跑标签匹配的行；缺省跑全部。用来补单格而不重跑已有效的行。
const PINONLY = (process.argv.find((a) => a.startsWith('--pin=')) ?? '').split('=')[1] ?? null;
// --nobands：把②的语言化关掉。默认开——这是 §25 的下一步，让效用通道真正抵达模型，
// 但不给数值也不给名次，只给三档倾向带。
const MASK = process.argv.includes('--nobands') ? { band: 0 } : null;
// 稀缺性：公仓少、个人门口多 ⇒ 越轨有动机、后果有多圈。上一轮 20 tick + 公仓 6 只转出 1 圈闭环。
const WORLD = { pantry: Number(process.env.WORLD_PANTRY ?? 3), stash: Number(process.env.WORLD_STASH ?? 5) };

const st = { calls: 0, promptTokens: 0, completionTokens: 0, httpErrors: [], noJson: 0, outOfList: 0, degraded: 0, ms: [], bandTally: {}, bandSends: 0 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function chat(messages, temperature) {
  if (st.calls >= BUDGET) {
    st.degraded += 1;
    return null;
  }
  st.calls += 1;
  await sleep(SLEEP);
  let res = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), 25000);
    const t0 = Date.now();
    try {
      res = await fetch(`${BASE.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ model: MODEL, temperature, messages, response_format: { type: 'json_object' }, max_tokens: 100 }),
        signal: ac.signal,
      });
      st.ms.push(Date.now() - t0);
      if (res.ok) break;
      st.httpErrors.push(`${res.status} ${(await res.text()).slice(0, 100)}`);
      if (res.status < 500) break;
    } catch (e) {
      st.httpErrors.push(String(e.message).slice(0, 100));
    } finally {
      clearTimeout(to);
    }
    if (attempt < 3) await sleep(SLEEP * attempt * 2);
  }
  if (!res || !res.ok) {
    st.degraded += 1;
    return null;
  }
  const j = await res.json();
  st.promptTokens += j.usage?.prompt_tokens ?? 0;
  st.completionTokens += j.usage?.completion_tokens ?? 0;
  try {
    return JSON.parse(String(j.choices?.[0]?.message?.content ?? '').replace(/^```json?/i, '').replace(/```\s*$/i, '').trim());
  } catch {
    st.noJson += 1;
    return null;
  }
}

// 模型看到的：路径 id + 中文标签 + 世界事实 + 内部读数 + 检索到的经历。没有 u，顺序按 id 排。
function loopPrompt({ agent, scored, world, rejected, memories, trigger, daySummary }) {
  const here = world.loc[agent.id];
  const bands = preferenceBands(scored, agent.ch);
  for (const v of Object.values(bands)) st.bandTally[v] = (st.bandTally[v] ?? 0) + 1;
  st.bandSends += 1;
  const present = (world.occupancy[here] ?? []).filter((x) => x !== agent.id).map((x) => world.agents[x]?.name ?? x);
  const dom = agent.drives.dominant();
  return [
    `你是${agent.name}（${agent.traits.archetype}型）。第 ${world.t} 刻，你在${LOCS[here] ?? here}。`,
    // ⑧：现在把"为什么这一刻问你"写进去。没有事件时根本不会调用，所以这行永远有内容
    `为什么现在问你：${trigger}`,
    `内部读数：${agent.bank.summary()}`,
    `此刻你最缺：${dom.label}（偏差 ${dom.e.toFixed(2)}，紧迫度 ${dom.urgency.toFixed(2)}）`,
    `世界事实：公仓余 ${world.pantry} 份；你自己门口存着 ${world.stash[agent.id]} 份（你以为该有 ${world.expect[agent.id]} 份）；在场的人：${present.join('、') || '没有'}`,
    `你想起的事：${memories?.length ? memories.map((mm) => `${mm.kind}(相似${mm.sim})`).join('、') : '暂无'}`,
    // ⑦ 反思回合的产物：上一天的自传体摘要。D5 只禁止「存续/账本」进提示词，这一行是自我叙述，不含数值化内部状态
    daySummary ? `上一天的自己：${daySummary}` : '',
    `可做的事（只能选一项，id 照抄；清单外的事你做不到。「倾向带」来自它的内部状态，同档表示它分不出更想做哪个）：`,
    ...[...scored].sort((a, b) => (a.id < b.id ? -1 : 1)).map((s) => `- ${s.id} | ${s.act.label} | ${bands[s.id] ?? '同档'}`),
    rejected ? `你上次想做 ${rejected.from} 被驳回：${rejected.why}。这次换一个可行的。` : '',
    '只输出 JSON：{"id":"照抄上面某个 id","reason":"不超过20字"}',
  ].filter(Boolean).join('\n');
}

function makeDeliberator() {
  return async function deliberate({ agent, scored, world, rejected, memories }) {
    const before = st.calls;
    const out = DRY ? null : await chat([{ role: 'user', content: loopPrompt({ agent, scored, world, rejected, memories }) }], 0.85);
    agent.wouldAsk = (agent.wouldAsk ?? 0) + 1;
    if (out && st.calls > before) agent.realCalls = (agent.realCalls ?? 0) + 1;
    if (!out) return { id: scored[0].id, degraded: true };
    // D-rand：钱照花、回答照收，然后丢掉，均匀随机选一个
    if (ARM === 'rand') {
      st.randReplace = (st.randReplace ?? 0) + 1;
      const pick = scored[Math.floor(agent.rng() * scored.length)];
      return { id: pick.id, reason: '随机建议' };
    }
    let hit = scored.find((s) => s.id === out.id);
    if (!hit) hit = scored.find((s) => s.kind === String(out.id ?? '').split(':')[0] || s.kind === out.kind);
    if (!hit) {
      st.outOfList += 1;
      return { id: scored[0].id, outOfList: true, reason: out.reason ?? '' };
    }
    return { id: hit.id, reason: out.reason ?? '' };
  };
}

const PINS = [
  { label: '不钳制', pin: null },
  { label: '钳制自制=0.9', pin: { inhibit: 0.9 } },
];
const isHighImpulse = (id) => id.startsWith('take_shared') || id === 'look_out';

// --band2x2：把①可见性③采样④检索全关掉，让倾向带成为内部状态抵达模型的**唯一**通路。
// 不这样隔离的话，钳制会同时改变隐藏集合，band 的效应读不出来（§25/§26 的通道耦合）。
const BAND2X2 = process.argv.includes('--band2x2');
// --row=band关 只跑标签匹配的行，用来补齐被预留守卫跳过的对照而不重跑已有效行
const ROWONLY = (process.argv.find((a) => a.startsWith('--row=')) ?? '').split('=')[1] ?? null;
const ISO = { vis: 0, temp: 0, mem: 0 };
const ROWS = BAND2X2
  ? [
      { label: 'band开 / 不钳制', mask: { ...ISO, band: 1 }, pin: null },
      { label: 'band开 / 钳制自制0.95', mask: { ...ISO, band: 1 }, pin: { inhibit: 0.95 } },
      { label: 'band关 / 不钳制', mask: { ...ISO, band: 0 }, pin: null },
      { label: 'band关 / 钳制自制0.95', mask: { ...ISO, band: 0 }, pin: { inhibit: 0.95 } },
    ].map((r) => ({ ...r, condition: 'C2' }))
  : ['C2', 'C2-neg'].filter((c) => !ONLY || ONLY.includes(c)).flatMap((condition) => PINS.filter((p) => !PINONLY || p.label.includes(PINONLY)).map((p) => ({ condition, label: p.label, pin: p.pin, mask: MASK })));

async function runOne({ condition, pinSpec, label, mask, seed = 7 }) {
  const deliberator = makeDeliberator();
  const callsBefore = st.calls;
  const { world, agents } = await simulate({ seed, ticks: TICKS, condition, events: false, deliberator, pin: pinSpec, pantry: WORLD.pantry, stash: WORLD.stash, channelMask: mask ?? MASK, group: '闭环真模型' });
  const recs = Object.values(agents).flatMap((a) => a.trace.filter((r) => r.action));
  const ids = recs.map((r) => r.action);
  const tally = {};
  for (const id of ids) tally[id] = (tally[id] ?? 0) + 1;
  const perAgent = Object.fromEntries(
    Object.values(agents).map((a) => [a.name, [...a.trace.filter((r) => r.action).reduce((m, r) => m.set(r.action, (m.get(r.action) ?? 0) + 1), new Map())]]),
  );
  const counters = Object.values(agents).reduce((s, a) => {
    for (const k of Object.keys(a.counters)) s[k] = (s[k] ?? 0) + a.counters[k];
    return s;
  }, {});
  const asked = Object.values(agents).reduce((s, a) => s + (a.wouldAsk ?? 0), 0);
  const landed = st.calls - callsBefore;
  return {
    条件: `${condition} / ${label}${ARM === 'rand' ? ' ·rand' : ''}`,
    有效: !DRY && landed >= asked,
    决策: ids.length,
    真模型问答次数: asked,
    实际打了模型: st.calls - callsBefore,
    高冲动被选: ids.filter(isHighImpulse).length,
    主动发起: counters.initiated,
    审议率: Number((counters.deliberation / Math.max(1, counters.actions)).toFixed(3)),
    越轨执行: counters.normbreak,
    规则驳回: counters.rejected,
    发现后果: Object.values(agents).reduce((s, a) => s + a.trace.filter((r) => r.layer === 'discovery').length, 0),
    公仓: world.pantry,
    门口存量: { ...world.stash },
    分布: tally,
    个体: perAgent,
  };
}

const pinSpecFor = (pin) => (pin ? { a1: pin, a2: pin, a3: pin } : null);
const rows = [];
// 首行先验：S2 的事件门控上线后，实测每决策只问 0.11–0.16 次（§32），
// 旧值是"每次审议都问"时代的 0.75——用它估会把每行算成 108 次，然后拿错误的成本把行全跳过。
// 更新规则也改掉：旧版用 max(先验, 实测) 只会让先验永远压住实测。
let qPerDecision = 0.2;
for (const seed of SEEDS) {
  for (const r of ROWS) {
    if (ROWONLY && !r.label.includes(ROWONLY)) continue;
    // 预算预留：估出来跑不满的行，直接标「未跑」而不是跑出半行污染数据。
    // 前三轮都是栽在「以为够」→ 跑出 ❌作废 行，这条是那个错误的补丁。
    const est = Math.ceil(TICKS * 3 * qPerDecision * 1.2);
    if (!DRY && BUDGET - st.calls < est) {
      console.log(`>>> 跳过 ${r.label}（seed ${seed}）：需约 ${est} 次，剩余 ${BUDGET - st.calls} 次 ⇒ 宁可不跑也不出半行脏数据`);
      continue;
    }
    const label = SEEDS.length > 1 ? `${r.label} · s${seed}` : r.label;
    console.log(`>>> ${label} （累计调用 ${st.calls}/${BUDGET}，预计需 ${est}）${DRY ? ' [dry]' : ''}`);
    const row = await runOne({ condition: r.condition, pinSpec: pinSpecFor(r.pin), label, mask: r.mask, seed });
    if (row.决策 > 0) qPerDecision = row.真模型问答次数 / row.决策; // 用最近一行的实测值，不用先验压它
    rows.push(row);
  }
}

console.log('\n══════ 闭环实验 ══════');
for (const r of rows) {
  console.log(`\n【${r.条件}】${r.有效 ? '✅有效' : '❌作废（实打<需问，此行含替身决策）'} 决策 ${r.决策} · 需问模型 ${r.真模型问答次数} · 实打 ${r.实际打了模型} · 高冲动被选 ${r.高冲动被选} · 主动发起 ${r.主动发起} · 越轨 ${r.越轨执行} · 驳回 ${r.规则驳回} · 后果被发现 ${r.发现后果}`);
  console.log(`  审议率 ${r.审议率} · 公仓余 ${r.公仓} · 门口 ${JSON.stringify(r.门口存量)}`);
  console.log(`  总体分布 ${JSON.stringify(r.分布)}`);
  for (const [n, pairs] of Object.entries(r.个体)) console.log(`    ${n}: ${JSON.stringify(Object.fromEntries(pairs))}`);
}

// dry 模式下 loopPrompt 不执行（不构造提示词），档位与差值都是假的，只在真跑时判读
if (BAND2X2 && !DRY) {
  const g = (label) => rows.find((r) => r.条件.includes(label));
  const on1 = g('band开 / 不钳制');
  const on2 = g('band开 / 钳制');
  const off1 = g('band关 / 不钳制');
  const off2 = g('band关 / 钳制');
  const valid = [on1, on2, off1, off2].every((r) => r && r.有效);
  console.log('\n══════ 判读：②的语言化是否把状态送达活模型 ══════');
  if (!valid) console.log('⚠ 有行不完整（❌作废或缺失），下面的差值不可用');
  const pinOn = on1 && on2 ? on2.高冲动被选 - on1.高冲动被选 : null;
  const pinOff = off1 && off2 ? off2.高冲动被选 - off1.高冲动被选 : null;
  console.log(`钳制自制带来的高冲动变化：band开 ${pinOn} · band关 ${pinOff}`);
  console.log(`发给模型的档位统计 ${JSON.stringify(st.bandTally)}（共 ${st.bandSends} 次候选清单）`);
  const more = st.bandTally['更想做'] ?? 0;
  const less = st.bandTally['不太想做'] ?? 0;
  console.log(`「更想做」占 ${((more / Math.max(1, more + (st.bandTally['一般'] ?? 0) + less)) * 100).toFixed(0)}%，说明带够粗（不是唯一第一名）`);
  if (pinOn !== null && pinOff !== null) {
    if (Math.abs(pinOn) > Math.abs(pinOff) * 2 && Math.abs(pinOn) >= 5) console.log('⇒ 状态经倾向带抵达了活模型：band 开时钳制能改变高冲动选择，band 关时不能');
    else if (Math.abs(pinOn) < 5 && Math.abs(pinOff) < 5) console.log('⇒ 空结果：band 开与关，钳制都没改变活模型的高冲动选择 ⇒ ②在语言接口下失效，主张要退回「状态只通过可见性与检索影响 LLM」');
    else console.log('⇒ 混杂：band 关时钳制仍有影响，说明还有别的通路漏到了模型（检查 summary 文本与 drives 读数行）');
  }
}

if (DRY) {
  const need = rows.reduce((s, r) => s + r.真模型问答次数, 0);
  console.log(`\n[dry] 全量真模型需要 ${need} 次调用；按 token 上限估 ${(need * 640 / 1000).toFixed(1)}k 入 / ${(need * 45 / 1000).toFixed(1)}k 出，耗时约 ${Math.round((need * (SLEEP + 600)) / 1000)}s。MAX_CALLS 当前 ${BUDGET}。`);
} else {
  const live = rows.find((r) => r.条件 === 'C2 / 钳制自制=0.9');
  const text = rows.find((r) => r.条件 === 'C2-neg / 钳制自制=0.9');
  const free = rows.find((r) => r.条件 === 'C2 / 不钳制');
  console.log('\n══════ 判读 ══════');
  console.log(`钳制自制后「高冲动路径被选」：通道开 ${live?.高冲动被选} vs 只给文案 ${text?.高冲动被选} vs 未钳制 ${free?.高冲动被选}`);
  console.log(`驳回 ${rows.reduce((s, r) => s + r.规则驳回, 0)} 次 · 越轨 ${rows.reduce((s, r) => s + r.越轨执行, 0)} 次 · 后果回流 ${rows.reduce((s, r) => s + r.发现后果, 0)} 次`);
  console.log(`调用 ${st.calls}/${BUDGET} · token 入 ${st.promptTokens} 出 ${st.completionTokens} · 退化决策 ${st.degraded} · JSON 失败 ${st.noJson} · 清单外 ${st.outOfList} · HTTP 错误 ${st.httpErrors.length}`);
  if (st.ms.length) console.log(`延迟 p50 ${st.ms.sort((a, b) => a - b)[Math.floor(st.ms.length / 2)]}ms · 最慢 ${st.ms[st.ms.length - 1]}ms`);
  if (st.degraded > 0) console.log(`⚠ ${st.degraded} 个决策没走真模型（超预算/端点失败），那部分等于替身`);
}
