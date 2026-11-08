// 决策量纲参数表 + 参数冻结校验。
// §27 的实测：78.5% 的动作第一贡献者是成本 ⇒ 角色大部分时候在选最省事的，需求与状态无处落脚。
// 修法不是把需求调大（那是标定作弊），而是把「努力折扣」显式化成一个可调、可关的参数，
// 让它进入比较但不支配比较。
// 本文件不 import 其他模块：drives/model 都要读 PARAMS，反向依赖会造出循环。
export const PARAMS = {
  // 努力折扣：0 = 完全不考虑省力；1 = 回到 §27 的旧行为（成本支配 78.5%）
  // 定到 0.1 是扫出来的（§28）：这一档下「需求主导 66% / 努力折扣主导 19%」，
  // 成本进入比较但不支配比较；0.3 以上成本又反超，0 则这个参数变成装饰。
  effortWeight: Number(process.env.EFFORT_WEIGHT ?? 0.1),
  // O17：越轨取食的收益侧定价。规范代价沿用既有机制（自制压高冲动、order 决定信任罚、秘密可被传话），
  // 这里只把「去别人门口拿一份」从低于正餐改成高于正餐，让"能不能稳住"成为角色的选择而非常数判决。
  // 份量 0.45 且 expectedYield 关闭时恢复旧评分；开启且接近饱和时仍按可用量裁剪。
  risky: { portion: Number(process.env.RISKY_PORTION ?? 1.1), referencePortion: 0.45 }, // 0.45 是原有 0.9 energy 系数所对应的旧份量
  // O10 日程：昼夜节律进入行动比较的权重。0 = 精确退回旧评分（等价性闸门用 SCHEDULE_WEIGHT=0 复现旧读数）
  // 当前默认关：0.06 档实测撞四道判据（残差 0.083 未记账通道 / 饥馑=宽裕 / 需求主导 0.369 / order 分化反号），见 PLAN O10 交接块
  schedule: { weight: Number(process.env.SCHEDULE_WEIGHT ?? 0) },
  // M7 自发转述（第三人声誉）：0=关（默认），1=开启。世界级参数，进冻结指纹
  socialGossip: Number(process.env.SOCIAL_GOSSIP ?? 0),
  // M3 行为状态（第二候选：两步后果规划 + 目标承诺）。默认关：channelMask {m3:1} 才启用。
  // N 按「非反射决策机会」计数而不是按 tick：反射那一支提前 return，不算一次承诺机会。
  m3: { commitment: Number(process.env.M3_COMMITMENT ?? 4), discount: Number(process.env.M3_DISCOUNT ?? 0.8) },
  // M5 逐事件慢仓：开关走 channelMask；参数进冻结指纹。
  m5: { slowScale: 0.2, slowTau: 80, loadTau: 160, delay: 8, feedback: 0.02, loadGain: 4 },
  // M6-L（PLAN §25.6）：learning progress → 探索预算。开关走 channelMask {lpExplore:1}；
  // fast/slow 是误差 EMA 刻度、weight 是探索加成分额、noveltyMax 是"还算新"的动作计数上限——都是预登记刻度，非拟合。
  lp: { weight: 0.05, fast: 1 / 20, slow: 1 / 120, noveltyMax: 2 },
  // M4 耦合调制权（预登记 §16）。开不开由 channelMask {coupling:1} 决定，这里只放量纲。
  // τ=40：与"一次社交过载自己平复"的时间同量级，所以断开耦合是一次性自我调节而不是长期状态（P6c 验这条）。
  // minInput=0.55 借 ⑥ 侵蚀因子的同一量级：变聋是"把增益调低"，不是把感官关掉；
  // "终止耦合"的极端实例交给 seclude（available→0），也就是 S3 要看的那个极端。
  // 断开耦合的**收益**：`relief` 是"兑现比例"，不是手写常数乘子。1 = 把 `COUPLING_EFFECTS[kind].relief`
  // 标价的减刺激**全额换算成评价目标**（换算线只用 rest / relocate 两个既有锚点，见 appraisal.mjs 与 §17.2）；
  // 0 = 三条动作回落到 relocate 兜底＝不发放缓解，正是 §45 那个负结果的档位，也是 §17.4 的零缓解对照。
  // 为什么必须有这一档：`drives.reward()` 结构上拒绝 stimulation（被调量，§L4 修订① 的吸收不动点），
  // 所以"减刺激"只能通过评价目标发出，不能靠给需求加分——单独立一个常数乘子才是 §26/§27 反对的做法。
  coupling: { tau: Number(process.env.COUPLE_TAU ?? 40), minInput: Number(process.env.COUPLE_MIN_INPUT ?? 0.55), relief: Number(process.env.COUPLE_RELIEF ?? 1) },
  // 需求紧迫度曲线指数（>1 让「小偏差」更不紧迫、「大偏差」更急），由 drives.errors() 使用
  urgencyExponent: Number(process.env.URGENCY_EXP ?? 1.5),
  // L13 自我维持：存续量、代谢与侵蚀阈值。全部走这里，便于冻结校验
  // 校准是**推出来的**，不是手调的（§30）：定两条常识——
  //   ① 一直吃不到东西的个体，大约 300~500 tick 内该逐级掉档；
  //   ② 每约 50 tick 能吃上一顿的个体，收支大致打平。
  // 由 ① 得净消耗 ≈ 0.0018/tick（upkeep 0.0012 + 行动代谢 0.01×cost≈0.0006），
  // 由 ② 得一顿饭要补回 ≈ 50×0.0018=0.09 ⇒ mealYield×0.5=0.09 ⇒ mealYield≈0.18。
  viab: {
    upkeep: 0.0012, // 每 tick 基础代谢：维持自身组织要花钱
    costScale: 0.01, // 行动代谢代价 = costScale × act.cost（贵动作更耗存续）
    mealYield: 0.18, // 单位进食量折算成存续
    mealMin: 0.2, // 低于这个量的是"歇一会儿"，不算吃到东西——否则躺着就能回本，稀缺是假的
    reserveMax: 0.6, // 储能上限（肝糖）：吃饱时补不进 v 的部分存这里，满了才算真浪费
    // 餐后扣存比例（§39 / D7）：每顿饭先按这个比例扣进储能，剩下的才补当下。
    // 0 = 旧的单向门（只有 v>0.91 才攒得下缓冲，垮掉的人摸不到自己的储能账户）；
    // 它不改变收支总量，只改变"能量存在哪里"——谷底抬高、峰头削平，跌破侵蚀阈值的次数随之减少。
    spill: Number(process.env.VIAB_SPILL ?? 0),
    refill: 0.006, // 每 tick 最多从储能抽回多少（换算力速率）
    crit: 0.6, // 操作点基准：低于它，风险开始起作用
    setpointShift: 0.25, // 风险=1 时把"能量吃饱"的标准从 0.55 抬到 0.80（移动操作点，不是放大增益）
    riskGain: 1.4, // 已存在的亏空被放大多少倍，且**只作用于亏空型需求**（否则会整体抬高而不进比较）
    thresholds: [0.5, 0.32, 0.15], // 每跌过一档，永久侵蚀一个部件
    erode: { habit: 0.55, memory: 0.55, social: 0.75 }, // 各自的乘性衰减（不可逆）
  },
};

const stable = (v) => (v && typeof v === 'object' ? JSON.stringify(v, Object.keys(v).sort()) : String(v));

// 指纹只收「各组必须共用的量」：决策量纲 + 需求表 + 动作表 + 世界供给（配给/库存）。
// seed / ticks / condition / channelMask / pin / traitsOverride 是实验自变量，不进指纹，
// 否则每个合法的对照差异都会被判成漂移 ⇒ 闸门恒红，等于没有闸门。
export function paramsFingerprint(tables = {}) {
  return [
    'effort=' + PARAMS.effortWeight,
    'risky=' + (tables.risky ?? PARAMS.risky.portion) + ',ref=' + PARAMS.risky.referencePortion, // 收益侧定价也是量纲：同组里一半人拿整份、一半人拿半份，存续就没法比
    'sched=' + (tables.schedule ?? PARAMS.schedule.weight), // 日程权重同进量纲：一半人有节律一半人没有，位置分布就没法比
    'm3N=' + (tables.m3 ?? PARAMS.m3.commitment), // 承诺长度同进量纲：一半人承诺 4 次一半人承诺 1 次，行为轨迹就没法比
    'ctau=' + (tables.couplingTau ?? PARAMS.coupling.tau) + ',cmin=' + (tables.couplingMinInput ?? PARAMS.coupling.minInput) + ',crel=' + PARAMS.coupling.relief, // M4：一半人断开 40 刻、一半人断开 200 刻，耦合时长就没法比（§16.4）；crel= 是缓解兑现比例（§17.4 零缓解档）
    'm5=' + stable(tables.m5 ?? PARAMS.m5), // 独立开关是自变量，慢仓量纲必须冻结
    'lp=' + stable(tables.lp ?? PARAMS.lp), // M6-L：探索加成分额与 EMA 刻度是决策量纲（§25.6 披露指纹变化）
    'social=' + (tables.social ?? PARAMS.socialGossip), // 一半人互相传话一半人不传，关系分布就没法比
    'urg=' + PARAMS.urgencyExponent,
    'spill=' + PARAMS.viab.spill, // 代谢分配也是量纲：同组里一半人餐后扣存、一半人不扣，掉档数就没法比
    'sp=' + stable(tables.setpoint ?? null),
    'needs=' + stable(tables.needs ?? null),
    'kinds=' + stable(tables.kinds ?? null),
    'supply=' + stable({ pantry: tables.pantry ?? null, stash: tables.stash ?? null }),
  ].join('|');
}

export function assertFrozen(label, fp) {
  assertFrozen.seen ??= new Map();
  if (!label) return fp;
  const prev = assertFrozen.seen.get(label);
  if (prev && prev !== fp) throw new Error(`参数漂移：组「${label}」的决策量纲被单独改动过\n  先前 ${prev}\n  现在 ${fp}`);
  assertFrozen.seen.set(label, fp);
  return fp;
}
