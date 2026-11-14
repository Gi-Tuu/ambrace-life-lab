// 世界读数差分 → 该播哪条事件音。纯函数，不碰 DOM、不碰世界、不读时间。
//
// 单独成模块的原因：差分规则（谁盖过谁、一次只播一条）是"声音语义"，
// 必须能被闸门钉住；留在 app.js 里就只能靠手点验证，改坏了没人知道。

const stages = (sv) => Object.fromEntries(Object.entries(sv.households?.residents ?? {}).map(([id, r]) => [id, r.stage]));
const sitePhases = (sv) => Object.fromEntries((sv.sites ?? []).map((s) => [`site:${s.loc}:${s.type}`, s.phase ?? 'complete']));
const damageTiers = (sv) => Object.fromEntries((sv.buildings ?? []).map((b) => {
  const integrity = b.integrity ?? 1;
  return [`bld:${b.loc}:${b.type}`, integrity >= 0.99 ? 0 : integrity >= 0.5 ? 1 : 2];
}));

export const readWorld = (sv) => ({
  day: sv.day ?? 0,
  births: sv.births ?? 0,
  deaths: (sv.deaths ?? []).length,
  won: Boolean(sv.won),
  dead: Boolean(sv.player?.dead),
  settlement: sv.settlement ?? 'active',
  disaster: sv.disasterToday ?? null,
  drought: Boolean(sv.drought),
  chickens: sv.livestock?.chickens ?? 0,
  cows: sv.livestock?.cows ?? 0,
  sheep: sv.livestock?.sheep ?? 0,
  stages: stages(sv),
  sites: sitePhases(sv),
  tiers: damageTiers(sv),
  shortfall: (sv.history ?? [])[Math.max(0, (sv.history ?? []).length - 1)]?.shortfall ?? 0,
});

// 返回本轮该播的事件音（最多一条）；prev 为 null 表示刚接手这个世界，不补播历史。
export function diffAudioEvents(prev, next) {
  if (!prev || next.dead) return [];

  if (next.settlement !== prev.settlement) {
    if (next.settlement === 'crisis') return ['crisisEnter'];
    if (next.settlement === 'extinct') return ['extinct'];
    if (next.settlement === 'recovering' || prev.settlement === 'crisis' || prev.settlement === 'recovering') return ['recover'];
  }
  if (next.disaster && next.disaster !== prev.disaster) return [next.disaster === 'storm' ? 'storm' : 'cold'];
  if (next.drought && !prev.drought) return ['drought'];

  // 死亡盖过出生：同一天既有人走又有人来，先听见的是失去。
  if (next.deaths > prev.deaths) return ['death'];
  if (next.births > prev.births) return ['birth'];
  if (next.won && !prev.won) return ['milestone'];

  for (const [id, stage] of Object.entries(next.stages)) {
    if (prev.stages[id] === 'child' && stage === 'adult') return ['adult'];
    if (prev.stages[id] === 'adult' && stage === 'elder') return ['elder'];
  }

  for (const [key, phase] of Object.entries(next.sites)) {
    if (!Object.hasOwn(prev.sites, key)) return ['foundation'];
    if (prev.sites[key] === 'foundation' && phase === 'frame') return ['frameUp'];
    if (prev.sites[key] === 'frame' && phase === 'complete') return ['complete'];
  }
  for (const [key, tier] of Object.entries(next.tiers)) {
    if ((prev.tiers[key] ?? 0) < tier) return ['damaged'];
  }

  if (next.day > prev.day) return [next.shortfall > 0 ? 'shortfall' : 'ration'];

  if (next.chickens > prev.chickens) return ['chicken'];
  if (next.cows > prev.cows) return ['cow'];
  if (next.sheep > prev.sheep) return ['sheep'];
  return [];
}

// 环境声与 BGM 的切换判据：只有这些读数变了才重排，避免每 900ms 抖一次。
export const sceneSignature = (sv) => [sv.season, sv.phase, sv.weather, sv.settlement,
  (sv.crisisDays ?? 0) > 0 ? 1 : 0, sv.player?.dead ? 1 : 0].join('|');
