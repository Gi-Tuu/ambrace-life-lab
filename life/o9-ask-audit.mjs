// O9 主张域审计（**只测量，不改机制**）：台账原话是"四类事件才问模型"，但反射层与习惯分支会在
// `choose()` 之前提前 return，所以那句话可能只对部分触发类成立。这里把每一类触发的去向数出来：
//   真问到（stub deliberator 被调用）／被反射接管／被习惯接管／没有候选。
// 用 stub deliberator 而不是真模型：它返回 null ⇒ 走与离线完全相同的 softmax 回退（同一条随机流），
// 于是"会不会问、问的是哪一类"可测，且不花钱、不改行为。
import { simulate } from './run.mjs';
import { Organism } from './agent.mjs';

const SEEDS = [7, 11, 13];
const TICKS = Number(process.argv.find((a) => a.startsWith('--ticks='))?.split('=')[1] ?? 600);

const original = Organism.prototype.triggerReason;
const reasons = new Map(); // `${id}:${t}` → 触发类
try {
  Organism.prototype.triggerReason = function (ctx) {
    const r = original.call(this, ctx);
    if (r) reasons.set(`${this.id}:${this.world?.t}`, r);
    return r;
  };

  const rows = [];
  for (const seed of SEEDS) {
    reasons.clear(); // 键是 id:t，不含 seed；不清就会把上一颗种子的触发算到这一颗头上（第一版实测因此把总数翻了三倍）
    const asked = [];
    const deliberator = async ({ agent, trigger }) => { asked.push({ id: agent.id, t: agent.world.t, trigger }); return null; };
    const { agents } = await simulate({ seed, ticks: TICKS, condition: 'C2', deliberator });
    const askedKeys = new Set(asked.map((a) => `${a.id}:${a.t}`));
    for (const a of Object.values(agents)) {
      // 每个触发刻的去向：trace 里那一刻的 layer 就是答案（reflex/habit/deliberation）
      const layerAt = new Map(a.trace.filter((r) => r.action).map((r) => [r.t, r.layer]));
      for (const [key, reason] of reasons) {
        if (!key.startsWith(`${a.id}:`)) continue;
        const t = Number(key.split(':')[1]);
        const layer = layerAt.get(t) ?? '无行动';
        rows.push({
          seed, id: a.id, t, reason,
          问到: askedKeys.has(key) ? 1 : 0,
          反射接管: layer === 'reflex' ? 1 : 0,
          习惯接管: layer === 'habit' ? 1 : 0,
          其他未问: !askedKeys.has(key) && layer !== 'reflex' && layer !== 'habit' ? 1 : 0,
          layer,
        });
      }
    }
  }
  const classes = [...new Set(rows.map((r) => r.reason))];
  const table = classes.map((c) => {
    const g = rows.filter((r) => r.reason === c);
    const sum = (k) => g.reduce((s, r) => s + r[k], 0);
    return { 触发类: c, 触发次数: g.length, 真问到: sum('问到'), 被反射接管: sum('反射接管'), 被习惯接管: sum('习惯接管'), 其他未问: sum('其他未问'), '问到占比': Number((sum('问到') / g.length).toFixed(3)) };
  });
  const total = rows.length;
  const askedTotal = rows.reduce((s, r) => s + r.问到, 0);
  console.log(`# O9 审计（只测量不改机制）：seeds=${SEEDS.join(',')} ticks=${TICKS}，stub deliberator 返回 null ⇒ 与离线同一条随机流`);
  console.table(table);
  console.log(`合计：触发 ${total} 次，真问到 ${askedTotal} 次（${((askedTotal / total) * 100).toFixed(1)}%），被反射接管 ${rows.reduce((s, r) => s + r.反射接管, 0)}，被习惯接管 ${rows.reduce((s, r) => s + r.习惯接管, 0)}，其他未问 ${rows.reduce((s, r) => s + r.其他未问, 0)}`);
  console.log('口径提醒：`驳回重决策` 是第五类（不在 triggerReason 的四类里），它只在真的走到 choose 时才发生，因此本表按"世界发生了一件事"的触发类统计；asked 总数可能高于本表的"真问到"合计，差额就是驳回重问。');
} finally {
  Organism.prototype.triggerReason = original;
}
