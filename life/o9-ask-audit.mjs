// O9 审计：每类触发到底有没有真问到思考层。**只测量**：stub deliberator 返回 null，
// 走与离线完全相同的 softmax 回退、同一条随机流，所以"会不会问"可测而不花钱、不改行为。
// 导出 askAudit 供闸门复用（`life/o9-event-first.test.mjs`），CLI 只是包一层——两处必须同一段实现（O13 的教训）。
import { simulate } from './run.mjs';
import { Organism } from './agent.mjs';

export async function askAudit({ eventFirst = 0, seeds = [7, 11, 13], ticks = 600 } = {}) {
  const original = Organism.prototype.triggerReason;
  const reasons = new Map(); // `${id}:${t}` → 触发类
  const rows = [];
  try {
    Organism.prototype.triggerReason = function (ctx) {
      const r = original.call(this, ctx);
      if (r) reasons.set(`${this.id}:${this.world?.t}`, r);
      return r;
    };
    for (const seed of seeds) {
      reasons.clear(); // 键是 id:t，不含 seed；不清就会把上一颗种子的触发算到这一颗头上（第一版因此把总数翻了三倍）
      const asked = [];
      const deliberator = async ({ agent, trigger }) => { asked.push({ id: agent.id, t: agent.world.t, trigger }); return null; };
      const { agents } = await simulate({ seed, ticks, condition: 'C2', deliberator, channelMask: { eventFirst } });
      const askedKeys = new Set(asked.map((a) => `${a.id}:${a.t}`));
      for (const a of Object.values(agents)) {
        // 每个触发刻的去向：trace 里那一刻的 layer 就是答案（reflex/habit/deliberation）
        const actionRows = a.trace.filter((r) => r.action);
        const layerAt = new Map(actionRows.map((r) => [r.t, r.layer]));
        const rowAt = new Map(actionRows.map((r) => [r.t, r]));
        for (const [key, reason] of reasons) {
          if (!key.startsWith(`${a.id}:`)) continue;
          const t = Number(key.split(':')[1]);
          const layer = layerAt.get(t) ?? '无行动';
          const row = rowAt.get(t);
          rows.push({
            seed, id: a.id, t, reason,
            问到: askedKeys.has(key) ? 1 : 0,
            反射接管: layer === 'reflex' ? 1 : 0,
            习惯接管: layer === 'habit' ? 1 : 0,
            其他未问: !askedKeys.has(key) && layer !== 'reflex' && layer !== 'habit' ? 1 : 0,
            // E3 生存语义：alarm 触发后**同一刻**是否真的到了走廊（反射没被延迟）
            同刻到hall: reason === '关键事件' && row?.kind === 'move_to' && row?.target === 'hall' ? 1 : 0,
            layer,
          });
        }
      }
    }
  } finally {
    Organism.prototype.triggerReason = original;
  }
  const classes = [...new Set(rows.map((r) => r.reason))];
  const byClass = classes.map((c) => {
    const g = rows.filter((r) => r.reason === c);
    const sum = (k) => g.reduce((s, r) => s + r[k], 0);
    return { 触发类: c, 触发次数: g.length, 真问到: sum('问到'), 被反射接管: sum('反射接管'), 被习惯接管: sum('习惯接管'), 其他未问: sum('其他未问'), '问到占比': Number((sum('问到') / g.length).toFixed(3)) };
  });
  const alarm = rows.filter((r) => r.reason === '关键事件');
  const nonSurvival = rows.filter((r) => r.reason !== '关键事件');
  const sumOf = (list, k) => list.reduce((s, r) => s + r[k], 0);
  return {
    rows, byClass, eventFirst,
    total: rows.length,
    asked: sumOf(rows, '问到'),
    askRate: rows.length ? sumOf(rows, '问到') / rows.length : null,
    nonSurvivalAskRate: nonSurvival.length ? sumOf(nonSurvival, '问到') / nonSurvival.length : null,
    alarmAsked: sumOf(alarm, '问到'),
    alarmCount: alarm.length,
    alarmToHall: sumOf(alarm, '同刻到hall'),
    habitIntercepts: sumOf(rows, '习惯接管'),
    reflexIntercepts: sumOf(rows, '反射接管'),
  };
}

if (process.argv[1]?.endsWith('o9-ask-audit.mjs')) {
  const eventFirst = Number(process.argv.find((a) => a.startsWith('--event-first='))?.split('=')[1] ?? 0);
  const ticks = Number(process.argv.find((a) => a.startsWith('--ticks='))?.split('=')[1] ?? 600);
  const r = await askAudit({ eventFirst, ticks });
  console.log(`# O9 审计（只测量不改机制）：ticks=${ticks}，eventFirst=${eventFirst}，stub deliberator 返回 null ⇒ 与离线同一条随机流`);
  console.table(r.byClass);
  console.log(`合计：触发 ${r.total} 次，真问到 ${r.asked} 次（${(r.askRate * 100).toFixed(1)}%），被反射接管 ${r.reflexIntercepts}，被习惯接管 ${r.habitIntercepts}`);
  console.log(`E1 三类非生存事件 ask 率：${(r.nonSurvivalAskRate * 100).toFixed(1)}%（预登记线 ≥90%；关键事件按设计留给反射，本档 ${r.alarmAsked}/${r.alarmCount}）`);
  console.log(`E3 生存语义：alarm 触发后同刻到 hall ${r.alarmToHall}/${r.alarmCount}（on/off 两档必须相同，红即回退）`);
  console.log(`E4 代价：本档真问到 ${r.asked} 次；相对基线档的倍数与线上见底时间需两档对比后同句报`);
  console.log('口径提醒：`驳回重决策` 是第五类（不在 triggerReason 的四类里），它只在真的走到 choose 时才发生，因此本表按"世界发生了一件事"的触发类统计；asked 总数可能高于本表的"真问到"合计，差额就是驳回重问。');
}
