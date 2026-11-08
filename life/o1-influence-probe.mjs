// O1-M 测量装置先验（**只测量，不改 usage**）：验"反事实改变率"这套口径测得到什么。
// 记忆与习惯两项能直接从现有 trace 的 `scored/u/parts` 算，不需要新仿真路径：
//   记忆改变 = argmax(u) ≠ argmax(u − parts.记忆)   （即"去掉检索加成后，评分第一名是否换人"）
//   习惯改变 = 习惯分支选中的 id ≠ argmax(u)          （习惯覆盖了评分结果才算承重）
// 装置自身的负控：④ 检索关掉时，记忆改变率必须精确为 0。
// 关系项需要"影子 affordance"（中性化 trust/fam 后重算候选），本轮先不接——按 §23.1 的顺序，装置先验通过再动 usage()。
import { simulate } from './run.mjs';

const argmaxOf = (list) => list.reduce((best, x) => (x.u > best.u ? x : best), list[0]);

export function influenceFromTrace(agents) {
  let scoredRows = 0, memChanged = 0, habitRows = 0, habitChanged = 0;
  for (const a of Object.values(agents)) {
    for (const r of a.trace) {
      if (!r.scored || !r.action) continue; // 反射刻没有 scored；它们不属于"非反射决策机会"
      scoredRows++;
      const u = r.scored.map((s) => ({ id: s.id, u: s.u }));
      const top = argmaxOf(u);
      const withoutMem = r.scored.map((s) => ({ id: s.id, u: s.u - (s.parts?.记忆 ?? 0) }));
      if (argmaxOf(withoutMem).id !== top.id) memChanged++;
      if (r.layer === 'habit') {
        habitRows++;
        if (r.action !== top.id) habitChanged++;
      }
    }
  }
  return {
    非反射决策: scoredRows,
    记忆改变: memChanged,
    记忆改变率: scoredRows ? Number((memChanged / scoredRows).toFixed(3)) : null,
    习惯命中: habitRows,
    习惯改变: habitChanged,
    习惯改变率: scoredRows ? Number((habitChanged / scoredRows).toFixed(3)) : null,
  };
}

if (process.argv[1]?.endsWith('o1-influence-probe.mjs')) {
  const SEEDS = (process.argv.find((x) => x.startsWith('--seeds='))?.split('=')[1] ?? '7,11,13').split(',').map(Number);
  const ticks = Number(process.argv.find((x) => x.startsWith('--ticks='))?.split('=')[1] ?? 1200);
  const CONFIGS = [['饥馑', 0, 0], ['常态', 6, 3], ['宽裕', 8, 5]];
  const rows = [];
  for (const seed of SEEDS) {
    for (const [name, pantry, stash] of CONFIGS) {
      const { agents } = await simulate({ seed, ticks, condition: 'C2', pantry, stash, group: `装置-${name}` });
      rows.push({ seed, 配置: name, ...influenceFromTrace(agents), 旧口径: Object.values(agents).map((a) => Number((a.viab.usage().habit).toFixed(3))).join('/') });
    }
  }
  console.log(`# O1-M 装置先验：memory/habit 的反事实改变率（seeds=${SEEDS.join(',')} ticks=${ticks}）`);
  console.table(rows);
  const mean = (k) => Number((rows.reduce((s, r) => s + (r[k] ?? 0), 0) / rows.length).toFixed(3));
  console.log(`均值：记忆改变率 ${mean('记忆改变率')}；习惯改变率 ${mean('习惯改变率')}`);
  // 负控：④ 关掉后记忆改变率必须为 0
  const off = await simulate({ seed: SEEDS[0], ticks, condition: 'C2', channelMask: { mem: 0 }, group: '装置-mem关' });
  const offStat = influenceFromTrace(off.agents);
  console.log(`负控（④ 检索关）：记忆改变 ${offStat.记忆改变}/${offStat.非反射决策} ⇒ 改变率 ${offStat.记忆改变率}（必须为 0，否则"改变"不是由检索加成造成的）`);

}
