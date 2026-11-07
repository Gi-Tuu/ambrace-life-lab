// O18：可运行的事前特征分类器。旧 P3 保留原样；本模块衡量留出准确率，不是旧覆盖率。
// 调用方必须在 agent.tick(world) 之前拍快照；它比本轮反射和审议更早，不含后续到达的信息。
const bin = v => v < 0.35 ? 'low' : v < 0.6 ? 'mid' : 'high';
const FIELDS = ['energy', 'social', 'loc'];

export function snapshotBeforeTick(agent, world) {
  if (!Number.isFinite(agent?.drives?.v?.energy) || !Number.isFinite(agent?.drives?.v?.social) || typeof world?.loc?.[agent?.id] !== 'string') {
    throw new TypeError('事前快照缺少能量、社交或角色位置');
  }
  return Object.freeze({ energy: bin(agent.drives.v.energy), social: bin(agent.drives.v.social), loc: world.loc[agent.id] });
}

function validateRows(rows) {
  if (!Array.isArray(rows) || !rows.length) throw new TypeError('训练集和测试集均不能为空');
  for (const r of rows) {
    if (!Number.isFinite(r?.t) || typeof r?.y !== 'string' || !r.y || !r.x || FIELDS.some(k => typeof r.x[k] !== 'string')) {
      throw new TypeError('样本须含刻度、动作标签及完整事前特征');
    }
  }
}

function majority(labels) {
  const counts = new Map();
  for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
}

// 规则仅用训练数据拟合，按相对训练多数类正确数的增益排序，冲突时第一条获胜。
// 没有匹配规则使用训练集多数类。返回模型只含原始值，不保留训练行引用。
export function fitDecisionRules(train, { maxRules = 20 } = {}) {
  validateRows(train);
  if (!Number.isInteger(maxRules) || maxRules < 0) throw new RangeError('规则数须为非负整数');
  const fallback = majority(train.map(r => r.y)), groups = new Map();
  for (const r of train) for (const field of FIELDS) {
    const value = r.x[field], key = JSON.stringify([field, value]), labels = groups.get(key) ?? [];
    labels.push(r.y); groups.set(key, labels);
  }
  const rules = [...groups].map(([key, labels]) => {
    const [field, value] = JSON.parse(key), label = majority(labels);
    const wins = labels.filter(y => y === label).length, base = labels.filter(y => y === fallback).length;
    return { field, value, label, support: labels.length, gain: wins - base };
  }).filter(r => r.gain > 0).sort((a, b) => b.gain - a.gain || b.support - a.support || a.field.localeCompare(b.field) || a.value.localeCompare(b.value)).slice(0, maxRules);
  return { fallback, rules };
}

export function predictDecision(model, features) {
  for (const rule of model.rules) if (features[rule.field] === rule.value) return rule.label;
  return model.fallback;
}

export function scoreDecisions(model, rows) {
  validateRows(rows);
  let correct = 0, matched = 0;
  for (const row of rows) {
    if (model.rules.some(rule => row.x[rule.field] === rule.value)) matched++;
    if (predictDecision(model, row.x) === row.y) correct++;
  }
  return { n: rows.length, correct, accuracy: correct / rows.length, matched, fallbackCount: rows.length - matched };
}

// 严格按时间拆分，边界不能同时出现在训练和测试；每次评估生成独立冻结模型。
export function evaluateTemporal(rows, { after, split, until, maxRules = 20 }) {
  validateRows(rows);
  if (![after, split, until].every(Number.isFinite) || !(after < split && split < until)) throw new RangeError('时间边界必须严格递增');
  const train = rows.filter(r => r.t > after && r.t <= split);
  const test = rows.filter(r => r.t > split && r.t <= until);
  const model = fitDecisionRules(train, { maxRules });
  const trainScore = scoreDecisions(model, train), testScore = scoreDecisions(model, test);
  const baseline = scoreDecisions({ fallback: model.fallback, rules: [] }, test);
  return { model, train: trainScore, test: testScore, baseline };
}
