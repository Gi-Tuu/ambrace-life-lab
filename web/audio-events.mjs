// 世界读数差分 → 该播哪条事件音。纯函数，不碰 DOM、不碰世界、不读时间。
//
import { themeForSeason } from './audio-data.mjs';
import { MUSIC_TRACKS } from './music-tracks.mjs';
import { TOWN_SIZE } from '../shared/camp-layout.mjs';

// 单独成模块的原因：差分规则（谁盖过谁、一次只播一条）是"声音语义"，
// 必须能被闸门钉住；留在 app.js 里就只能靠手点验证，改坏了没人知道。

const stages = (sv) => Object.fromEntries(Object.entries(sv.households?.residents ?? {}).map(([id, r]) => [id, r.stage]));
const timberStages = (sv) => Object.fromEntries(Object.entries(sv.camp?.timber ?? {}).map(([id, t]) => [id, t.stage]));
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
  // 三条原先"待做"的声音所依赖的事实：丧偶结算、协作退出计数、树木再生阶段。
  widowed: Object.keys(sv.households?.widowed ?? {}).sort().join(','),
  exits: sv.coop?.exits ?? 0,
  timber: timberStages(sv),
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
  // 但丧偶更具体：同一刻里"有人死了"和"有人失去配偶"，后者才是该听的那一声。
  if (next.deaths > prev.deaths) return [next.widowed && next.widowed !== prev.widowed ? 'widow' : 'death'];
  if (next.widowed && next.widowed !== prev.widowed) return ['widow'];
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

  // 工人中途退出：exits 是累计计数，计数涨了就是这一轮有人走了。
  if (next.exits > prev.exits) return ['coopExit'];
  // 树木再生完成：从 sapling 回到 mature 的那一刻（原来"待做"是因为没找到这个时刻，
  // 其实载荷里的 camp.timber 每棵树都带 stage，不需要为声音改规则）。
  for (const [id, stage] of Object.entries(next.timber)) {
    if (prev.timber[id] === 'sapling' && stage === 'mature') return ['regrow'];
  }

  if (next.day > prev.day) return [next.shortfall > 0 ? 'shortfall' : 'ration'];

  if (next.chickens > prev.chickens) return ['chicken'];
  if (next.cows > prev.cows) return ['cow'];
  if (next.sheep > prev.sheep) return ['sheep'];
  return [];
}

// 环境声与 BGM 的切换判据：只有这些读数变了才重排，避免每 900ms 抖一次。
// disasterToday / drought 也要进签名：天气床按 climate 选素材，暴雨/寒潮/干旱会换层。
export const sceneSignature = (sv) => [sv.season, sv.phase, sv.weather, sv.disasterToday ?? '',
  sv.drought ? 1 : 0, sv.settlement, (sv.crisisDays ?? 0) > 0 ? 1 : 0, sv.player?.dead ? 1 : 0].join('|');

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
export const FAR_RADIUS = 70;             // 环境声 proximity 的参考半径；BGM 边界已改用聚落矩形
export const PLAY_TICKS = 6;              // 连续播放刻数
export const REST_TICKS = 6;              // 间歇刻数

// BGM 的"村内"以聚落矩形为准，不再用半径 70 的圆：
// 圆半径 70 会让镇角 (119,79)（距核心 70.7）在镇内却不播，也会让矩形外的点误判为村内。
export const CAMP_REGION = Object.freeze({ west: 0, north: 0, east: TOWN_SIZE.width, south: TOWN_SIZE.depth });

const positionOf = (pos) => Array.isArray(pos) && Number.isFinite(pos[0]) && Number.isFinite(pos[1])
  ? pos
  : pos && Number.isFinite(pos.x) && Number.isFinite(pos.z) ? [pos.x, pos.z] : null;

export const inCampRegion = (pos, region = CAMP_REGION) => {
  const p = positionOf(pos);
  // 没有位置读数（旧档 / 内核内）按"在村内"处理，与 playerDistance 的兜底口径一致。
  if (!p) return true;
  const [x, z] = p;
  return x >= region.west && x < region.east && z >= region.north && z < region.south;
};

// 玩家是否在聚落矩形内：优先服务端 playerPos，旧档退回 loc 坐标，最后算"在村内"。
export function playerInCamp(sv) {
  return inCampRegion(sv?.playerPos ?? sv?.locs?.[sv?.loc?.p1]);
}

export const distanceFromCore = (pos, center = CORE_CENTER) =>
  Array.isArray(pos) ? Math.hypot(pos[0] - center[0], pos[1] - center[1])
    : pos && Number.isFinite(pos.x) ? Math.hypot(pos.x - center[0], pos.z - center[1]) : 0;

// 玩家离核心多远：只用于环境声的风床远近（proximity），不再决定 BGM 是否播放。
export function playerDistance(sv) {
  const pos = sv.playerPos ?? sv.locs?.[sv.loc?.p1];
  return distanceFromCore(pos);
}

const busyVillage = (sv) => (sv.coop?.task?.workers?.length ?? 0) > 0 || (sv.sites ?? []).length > 0;

// 返回 { play, theme, day, reason, t }；reason 是给闸门与报告看的，不是给玩家看的。
// t 是这次判定用的世界刻：调用方已经把 sv.t 传进来了，顺手带回去，
// 免得起播点轮转要额外从 app.js 传参数（那文件此刻由另一路在改）。
function computeWindow(sv, { region = CAMP_REGION, now = 0, ghost = false } = {}) {
  if (!sv) return { play: false, theme: 'menu', day: true, reason: 'no-world' };
  const day = sv.phase !== '夜';
  // 1.3 幽魂观察：人死了但世界还在看——那时不再按死亡处理，回到正常窗口（压低一档）。
  if (sv.player?.dead && !ghost) return { play: false, theme: 'death', day, reason: 'player-dead' };
  // 第二批素材到位后（所有者 2026-11-21）：灭绝与夜不再整段静音，各用自己的曲目；
  // 村外与闲日白天仍不放——那是 2026-11-15 定的「挑部分时段播放」。死人不在这里播，由 audio.scene 处理。
  if (sv.settlement === 'extinct') return { play: true, theme: 'extinct', day, reason: 'extinct' };
  if (!inCampRegion(sv.playerPos ?? sv.locs?.[sv.loc?.p1], region)) {
    return { play: false, theme: 'menu', day, reason: 'away' };
  }

  const crisis = sv.settlement === 'crisis' || (sv.crisisDays ?? 0) > 0;
  const dayTheme = themeForSeason(sv.season);
  const theme = crisis ? 'crisis' : sv.settlement === 'recovering' ? 'recovering' : (day ? dayTheme : `${dayTheme}-night`);
  if (!day) return { play: true, theme, day: false, reason: 'night' };
  if (sv.phase === '晨') return { play: true, theme, day, reason: 'morning' };
  if (sv.phase === '暮') return { play: true, theme, day, reason: 'dusk' };
  if (!busyVillage(sv)) return { play: false, theme, day, reason: 'idle-day' };
  // 白天热闹时才播，且按"6 刻播 / 6 刻歇"留出空隙；now 用世界刻，不用墙钟。
  const slot = Math.floor((now ?? sv.t ?? 0) / PLAY_TICKS) % 2;
  return { play: slot === 0, theme, day, reason: slot === 0 ? 'busy-day' : 'busy-rest' };
}

export function musicWindow(sv, opts = {}) {
  const w = computeWindow(sv, opts);
  return { ...w, t: Math.max(0, Number(opts.now ?? sv?.t ?? 0) || 0), ...(opts.ghost ? { ghost: true } : {}) };
}

// 窗口签名：只有它变了才做淡入/淡出，避免同一秒内反复接管。
export const windowSignature = (w) => `${w.play ? 1 : 0}|${w.theme}|${w.day ? 1 : 0}`;

// 音乐总线的目标电平：窗口说"不播"就必须是 0，否则"挑时段播"只是一句空话。
// 所有者裁决（2026-11-15）：整体压低 BGM ⇒ 常规 0.6、危机 0.45，都低于音效峰值 0.5 的听感占位，
// 让劳动声、畜叫、风声始终在音乐之上；危机时再给心跳让路。
export const MUSIC_LEVEL = 0.6;
export const MUSIC_LEVEL_CRISIS = 0.45;
// 夜曲比日曲更低（夜里环境声本该更清楚）；倒下与灭绝再压一档，让它们只是底色。
export const MUSIC_LEVEL_NIGHT = 0.42;
export const MUSIC_LEVEL_DEATH = 0.5;
export const MUSIC_LEVEL_EXTINCT = 0.35;
// 幽魂观察：人在看，但世界不再属于他——比夜曲再低一点。
export const MUSIC_LEVEL_GHOST = 0.4;
export const musicTarget = (win, settlement) => {
  if (!win || !win.play) return 0;
  if (win.ghost) return MUSIC_LEVEL_GHOST;
  const theme = String(win.theme || '');
  if (theme === 'crisis' || settlement === 'crisis') return MUSIC_LEVEL_CRISIS;
  if (theme === 'death') return MUSIC_LEVEL_DEATH;
  if (theme === 'extinct') return MUSIC_LEVEL_EXTINCT;
  if (/-night$/.test(theme)) return MUSIC_LEVEL_NIGHT;
  return MUSIC_LEVEL;
};

// ───────────────── 环境床：槽位名 ≠ 素材名 ─────────────────
// setBed 的第一参数是槽位（weather/daynight/wind/crisis），实际播放的素材来自
// audio-data.mjs 的 rain/wind/cold/day/night/crisis。两者不是同一个命名空间，
// 混用会让 renderAmbience 返回 null、整层床静默——2026-11-21 审计的 P0。
export const BED_SLOTS = Object.freeze({
  weather: Object.freeze(['rain', 'wind', 'cold']),
  daynight: Object.freeze(['day', 'night']),
  wind: Object.freeze(['wind']),
  crisis: Object.freeze(['crisis']),
});
export const AMBIENCE_MATERIALS = Object.freeze(
  Object.values(BED_SLOTS).flat().filter((v, i, a) => a.indexOf(v) === i),
);

// 2026-11-21 ffmpeg ebur128 实测（压缩器之前、master=1 的素材级 LUFS）；
// 素材换了就必须重测，否则下面的增益表会把新素材推到错误的电平。
export const AMBIENCE_LUFS = Object.freeze({
  rain: -18.6, wind: -24.0, cold: -27.4, day: -34.0, night: -28.4, crisis: -19.2,
});
// 目标有效 LUFS（含 master 0.7）。天气/昼夜床压到常规 BGM（约 -31.6…-33.6）之下，
// 但不再像修复前那样低 13dB；crisis 心跳保持比 BGM 高约 2dB，仍是最突出的那一层。
export const BED_TARGET_LUFS = Object.freeze({
  rain: -39.5, wind: -33.0, cold: -39.5, day: -39.5, night: -40.0, crisis: -30.0,
});
const MASTER_REFERENCE = 0.7;
// gain = 10^((目标 LUFS − 素材 LUFS)/20) / master ⇒ 换成素材再照表复核。
export const BED_GAIN = Object.freeze(Object.fromEntries(Object.entries(BED_TARGET_LUFS)
  .map(([name, target]) => [name, 10 ** ((target - AMBIENCE_LUFS[name]) / 20) / MASTER_REFERENCE])));
export const bedGain = (material) => (Number.isFinite(BED_GAIN[material]) ? BED_GAIN[material] : 0);

// 天气槽按气候选素材：雨/风暴 → rain，寒潮/雪 → cold，干旱 → wind。
export function weatherBed(climate = null, weather = null) {
  if (climate?.storm || climate?.rain || weather === 'rain') return 'rain';
  if (climate?.frost || climate?.snow || weather === 'cold') return 'cold';
  if (climate?.drought) return 'wind';
  return null;
}
export const dayNightBed = (phase) => (phase === '夜' ? 'night' : 'day');

// 显式 ducking：天气床在场时，常规日曲让 2dB 给天气；危机/夜曲/送别/灭绝本来就更低，
// 不再压，否则恢复期的雨声会反超 BGM。
export const MUSIC_DUCK_WEATHER = 10 ** (-2 / 20);
export const musicDuck = (weatherMaterial, level = 0) =>
  (weatherMaterial && level >= MUSIC_LEVEL ? MUSIC_DUCK_WEATHER : 1);

// 一截 = 6 刻播 + 6 刻歇，所以每过一整循环换一段起播点：同一首听久了也不腻。
// 关键是这个序号取自**世界刻**而不是本地历史，于是同一营地的所有观众、以及录屏回放
// 听到的都是同一段（外围同权的口径到这里同样成立）。
export const MUSIC_STINT_TICKS = PLAY_TICKS * 2;
export function musicStartFor(theme, tick, tracks = MUSIC_TRACKS) {
  const t = tracks?.[theme];
  if (!t || !Array.isArray(t.starts) || !t.starts.length) return null;
  if (t.starts.length === 1) return t.starts[0];
  const i = Math.floor(Math.max(0, Number(tick) || 0) / MUSIC_STINT_TICKS) % t.starts.length;
  return t.starts[i];
}

// 远近程度 0（村内）→ 1（村外远征），用于风床与天气/昼夜床的连续衰减。
export function proximity(sv, { center = CORE_CENTER, far = FAR_RADIUS } = {}) {
  const d = playerDistance(sv);
  return Math.max(0, Math.min(1, (d - far * 0.55) / (far * 0.9)));
}

