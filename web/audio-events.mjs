// 世界读数差分 → 该播哪条事件音。纯函数，不碰 DOM、不碰世界、不读时间。
//
import { themeForSeason } from './audio-data.mjs';

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

// ───────────────── BGM 播放窗口：音乐不是背景板，是"村子在热闹"的信号 ─────────────────
//
// 为什么不全局连播：一首曲子 24 小时循环会把劳动声、风声、畜叫全压成底噪，
// 玩家很快就不听了；反过来"该响的时候响、该停的时候停"才有叙事感。
// 规则一律由世界读数决定（不读 Date.now），所以可测、可复现、也解释得清。
//
// 夜不播；灭绝与玩家倒下不播；走到村外（远征）不播，改由风与林鸟承担；
// 晨（开工）整段播；昼只在"有工地或有人协作"时播；暮收工前播一小段；
// 播的时候也有节拍：连续 6 刻后歇 6 刻，留出听劳动声的空隙。

export const CORE_CENTER = [60, 40];      // 聚落核心 = 120×80 地块的几何中心
export const FAR_RADIUS = 70;             // ≈ 核心到村界对角距离，超过即算"出村"
export const PLAY_TICKS = 6;              // 连续播放刻数
export const REST_TICKS = 6;              // 间歇刻数

export const distanceFromCore = (pos, center = CORE_CENTER) =>
  Array.isArray(pos) ? Math.hypot(pos[0] - center[0], pos[1] - center[1])
    : pos && Number.isFinite(pos.x) ? Math.hypot(pos.x - center[0], pos.z - center[1]) : 0;

// 玩家离核心多远：优先用服务端拥有的 playerPos（外围同权后的事实来源），
// 没有（旧档/内核内）再退回 loc 的坐标，最后算"在村内"。
export function playerDistance(sv) {
  const pos = sv.playerPos ?? sv.locs?.[sv.loc?.p1];
  return distanceFromCore(pos);
}

const busyVillage = (sv) => (sv.coop?.task?.workers?.length ?? 0) > 0 || (sv.sites ?? []).length > 0;

// 返回 { play, theme, day, reason }；reason 是给闸门与报告看的，不是给玩家看的。
export function musicWindow(sv, { center = CORE_CENTER, far = FAR_RADIUS, now = 0 } = {}) {
  if (!sv) return { play: false, theme: 'menu', day: true, reason: 'no-world' };
  const day = sv.phase !== '夜';
  if (sv.player?.dead) return { play: false, theme: 'menu', day, reason: 'player-dead' };
  if (sv.settlement === 'extinct') return { play: false, theme: 'extinct', day, reason: 'extinct' };
  if (!day) return { play: false, theme: 'menu', day: false, reason: 'night' };
  if (playerDistance(sv) > far) return { play: false, theme: 'menu', day, reason: 'away' };

  const crisis = sv.settlement === 'crisis' || (sv.crisisDays ?? 0) > 0;
  const theme = crisis ? 'crisis' : sv.settlement === 'recovering' ? 'recovering' : themeForSeason(sv.season);
  if (sv.phase === '晨') return { play: true, theme, day, reason: 'morning' };
  if (sv.phase === '暮') return { play: true, theme, day, reason: 'dusk' };
  if (!busyVillage(sv)) return { play: false, theme, day, reason: 'idle-day' };
  // 白天热闹时才播，且按"6 刻播 / 6 刻歇"留出空隙；now 用世界刻，不用墙钟。
  const slot = Math.floor((now ?? sv.t ?? 0) / PLAY_TICKS) % 2;
  return { play: slot === 0, theme, day, reason: slot === 0 ? 'busy-day' : 'busy-rest' };
}

// 窗口签名：只有它变了才做淡入/淡出，避免同一秒内反复接管。
export const windowSignature = (w) => `${w.play ? 1 : 0}|${w.theme}|${w.day ? 1 : 0}`;

// 音乐总线的目标电平：窗口说"不播"就必须是 0，否则"挑时段播"只是一句空话。
// 危机档压低三成，让心跳与劳动声出头。
export const musicTarget = (win, settlement) => {
  if (!win || !win.play) return 0;
  return win.theme === 'crisis' || settlement === 'crisis' ? 0.7 : 0.9;
};

// 远近程度 0（村内）→ 1（村外远征），用于环境声的连续 ducking。
export function proximity(sv, { center = CORE_CENTER, far = FAR_RADIUS } = {}) {
  const d = playerDistance(sv);
  return Math.max(0, Math.min(1, (d - far * 0.55) / (far * 0.9)));
}

