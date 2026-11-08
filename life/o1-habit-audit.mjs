// O1 主张域审计（**只测量，不改公式**）。台账原话：habit 在四格里从没被削到，
// 而"改 usage() 让它上榜"会污染结论——要改的是世界（让习惯真的承重），不是判据。
// 这里把"为什么它不上榜"量出来：依赖度（命中占比）× 完整度 的三项读数、侵蚀账本里各器官被削次数。
import { simulate } from './run.mjs';
import { ORGANS } from './viability.mjs';

const SEEDS = [7, 11, 13];
const TICKS = Number(process.argv.find((a) => a.startsWith('--ticks='))?.split('=')[1] ?? 1200);
const CONFIGS = [['饥馑', 0, 0], ['常态', 6, 3], ['宽裕', 8, 5]];

const rows = [];
for (const seed of SEEDS) {
  for (const [name, pantry, stash] of CONFIGS) {
    const { agents } = await simulate({ seed, ticks: TICKS, condition: 'C2', pantry, stash, group: `O1审计-${name}` });
    for (const a of Object.values(agents)) {
      const u = a.viab.usage();
      const c = a.counters;
      const organs = a.viab.ledger.reduce((m, l) => { m[l.key] = (m[l.key] ?? 0) + 1; return m; }, {});
      rows.push({
        seed, 配置: name, 角色: a.name,
        行动: c.actions, 习惯命中: c.habit ?? 0,
        '命中占比': Number(((c.habit ?? 0) / Math.max(1, c.actions)).toFixed(3)),
        'usage习惯': Number(u.habit.toFixed(3)),
        'usage记忆': Number(u.memory.toFixed(3)),
        'usage关系': Number(u.social.toFixed(3)),
        '习惯最少?': u.habit <= u.memory && u.habit <= u.social ? '是' : '否',
        削习惯: organs.habit ?? 0, 削记忆: organs.memory ?? 0, 削关系: organs.social ?? 0,
        阶段: a.viab.stage,
      });
    }
  }
}
console.log(`# O1 审计（只测量不改 usage 公式）：seeds=${SEEDS.join(',')} ticks=${TICKS}，C2（⑥ 侵蚀开）`);
console.table(rows);
const n = rows.length;
const sum = (k) => rows.reduce((s, r) => s + r[k], 0);
const mean = (k) => Number((sum(k) / n).toFixed(3));
console.log(`合计 ${n} 个样本：削习惯 ${sum('削习惯')} 次／削记忆 ${sum('削记忆')} 次／削关系 ${sum('削关系')} 次`);
console.log(`习惯命中占比均值 ${mean('命中占比')}；usage 均值 习惯 ${mean('usage习惯')}／记忆 ${mean('usage记忆')}／关系 ${mean('usage关系')}`);
console.log(`usage 三项里习惯最低的样本：${rows.filter((r) => r['习惯最少?'] === '是').length}/${n}`);
console.log(`器官名对照：${JSON.stringify(ORGANS)}`);
console.log('结论口径：若"削习惯"合计为 0 且习惯 usage 恒为最低，则「已永久失去」清单里没有习惯是**真实读数**（依赖度最低），不是显示缺陷；要让它上榜必须改世界让习惯承重，那属机制改动、需另立预登记。');
