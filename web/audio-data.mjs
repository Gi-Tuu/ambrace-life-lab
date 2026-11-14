// 音频素材表：音效配方 + 手写音符数据。
//
// 全部是仓库内的数据与代码，不含任何第三方音频文件；音色由 audio-synth.mjs 合成。
// 音效按"族"归并（木/石/草/金属/被拒/提示…），不是每个动作一条，避免音量与认知负担失控。
// 约定：配方一律输出单声道采样，renderSfx 才转立体声；BGM 直接输出立体声。

import { SR, osc, noise, pluck, fm, mix, mixMono, reverb, normalize } from './audio-synth.mjs';

const beatSec = (bpm) => 60 / bpm;
const midiSafe = (m) => 440 * 2 ** ((Math.round(m) - 69) / 12);

// ───────────────────────── 音效族 ─────────────────────────

// 木：短促宽谱瞬态 + 低频共鸣体同时发声（斧、锤、木工共用这一族，靠参数变调）。
const woodHit = ({ seed = 21, gain = 0.9, body = 190, drop = 0.5 } = {}) => mixMono([
  { at: 0, data: noise({ dur: 0.035, gain: 0.5 * gain, lp: 2600, hp: 300, decay: 12, seed }) },
  { at: 0, data: osc({ freq: body * (1 + drop), glideTo: body, dur: 0.11, type: 'sine', gain: 0.45 * gain, release: 0.08 }) },
]);

const stoneHit = ({ seed = 33, gain = 0.9 } = {}) => mixMono([
  { at: 0, data: noise({ dur: 0.02, gain: 0.5 * gain, lp: 9000, hp: 2200, decay: 18, seed }) },
  { at: 0.004, data: fm({ freq: 1180, dur: 0.09, gain: 0.15 * gain, ratio: 2.71, index: 4, decay: 7 }) },
]);

const leafRustle = ({ seed = 41, gain = 1 } = {}) =>
  noise({ dur: 0.22, gain: 0.22 * gain, lp: 6200, hp: 900, decay: 4.5, seed });

const soilPat = ({ seed = 57 } = {}) => mixMono([
  { at: 0, data: noise({ dur: 0.09, gain: 0.3, lp: 1100, hp: 120, decay: 8, seed }) },
  { at: 0.02, data: osc({ freq: 96, dur: 0.07, type: 'sine', gain: 0.26, release: 0.05 }) },
]);

const containerTick = ({ seed = 91 } = {}) => mixMono([
  { at: 0, data: noise({ dur: 0.03, gain: 0.24, lp: 4200, hp: 700, decay: 14, seed }) },
  { at: 0.01, data: osc({ freq: 420, dur: 0.05, type: 'triangle', gain: 0.15, release: 0.04 }) },
]);

const coinClink = ({ seed = 103 } = {}) => mixMono([
  { at: 0, data: fm({ freq: 1320, dur: 0.22, gain: 0.13, ratio: 3.03, index: 8, decay: 5 }) },
  { at: 0.03, data: noise({ dur: 0.05, gain: 0.11, lp: 9000, hp: 3000, decay: 12, seed }) },
]);

const chime = (freqs, { gain = 0.2, spread = 0.09 } = {}) => mixMono(
  freqs.map((f, i) => ({ at: i * spread, data: pluck({ freq: f, dur: 0.9, gain, decay: 0.9975, bright: 0.36, seed: 111 + i }) })),
);

const deny = () => mixMono([
  { at: 0, data: osc({ freq: 148, dur: 0.05, type: 'square', gain: 0.15, release: 0.02 }) },
  { at: 0.07, data: osc({ freq: 112, dur: 0.06, type: 'square', gain: 0.13, release: 0.02 }) },
]);

const uiTick = () => osc({ freq: 1500, dur: 0.02, type: 'sine', gain: 0.09, release: 0.012 });

const speechBlip = ({ seed = 151 } = {}) => mixMono([
  { at: 0, data: noise({ dur: 0.018, gain: 0.12, lp: 3200, hp: 500, decay: 20, seed }) },
  { at: 0.005, data: osc({ freq: 300 + (seed % 7) * 26, dur: 0.05, type: 'triangle', gain: 0.08, release: 0.04 }) },
]);

const thunderCrack = ({ seed = 173 } = {}) => mixMono([
  { at: 0, data: noise({ dur: 0.5, gain: 0.45, lp: 900, hp: 40, decay: 3.2, seed }) },
  { at: 0.02, data: osc({ freq: 62, glideTo: 34, dur: 0.9, type: 'sine', gain: 0.3, release: 0.5 }) },
]);

const icyShimmer = () => mixMono([0, 0.05, 0.11].map((at, i) => ({
  at, data: fm({ freq: 2100 + i * 340, dur: 0.5, gain: 0.07, ratio: 1.19, index: 2.5, decay: 4 }),
})));

// 通用"动物发声"：一条滑音 + 呼吸噪声 + 共振带通，参数决定它是鸡还是牛。
// 不做采样拟音是为了零素材；代价是"像不像"要靠耳朵验收，所以每种都单独可调。
const vocal = ({ base = 800, sweep = 0.8, dur = 0.2, vib = 0, vibHz = 8, breath = 0.1,
  lp = 4000, type = 'sine', gain = 0.3, repeats = 1, spread = 0.16, seed = 901 }) =>
  mixMono(Array.from({ length: repeats }, (_, i) => ({
    at: i * spread,
    data: mixMono([
      { at: 0, data: osc({ freq: base, glideTo: base * sweep, dur, type, gain, vibHz: vib ? vibHz : 0, vibDepth: vib, release: dur * 0.4 }) },
      { at: 0, data: noise({ dur: dur * 0.8, gain: breath, lp, hp: Math.max(80, lp * 0.06), decay: 5, seed: seed + i }) },
    ]),
  })));

const thump = ({ seed = 921, gain = 0.4 } = {}) => mixMono([
  { at: 0, data: osc({ freq: 96, glideTo: 42, dur: 0.12, type: 'sine', gain, release: 0.08 }) },
  { at: 0, data: noise({ dur: 0.05, gain: gain * 0.4, lp: 900, hp: 60, decay: 16, seed }) },
]);

const knockHollow = ({ seed = 931 } = {}) => mixMono([
  { at: 0, data: osc({ freq: 300, glideTo: 190, dur: 0.13, type: 'triangle', gain: 0.24, release: 0.09 }) },
  { at: 0.01, data: noise({ dur: 0.05, gain: 0.14, lp: 2600, hp: 500, decay: 14, seed }) },
]);

const crackFall = ({ seed = 941 } = {}) => mixMono([
  { at: 0, data: noise({ dur: 0.5, gain: 0.2, lp: 3000, hp: 300, decay: 2.2, seed }) },
  { at: 0.52, data: thump({ seed: seed + 3, gain: 0.5 }) },
  { at: 0.6, data: noise({ dur: 0.35, gain: 0.12, lp: 1600, hp: 200, decay: 3, seed: seed + 7 }) },
]);

const dryCrackle = ({ seed = 951 } = {}) => mixMono(
  [0, 0.05, 0.13, 0.2, 0.31, 0.44].map((at, i) => ({
    at, data: noise({ dur: 0.03, gain: 0.16 - i * 0.015, lp: 7000, hp: 1800, decay: 26, seed: seed + i }),
  })),
);

const rising = (freqs, { gain = 0.16, spread = 0.11, type = 'triangle' } = {}) => mixMono(
  freqs.map((f, i) => ({ at: i * spread, data: osc({ freq: f, dur: 0.34, type, gain, release: 0.2 }) })),
);

const falling = (freqs, { gain = 0.16, spread = 0.13, type = 'triangle' } = {}) => mixMono(
  [...freqs].reverse().map((f, i) => ({ at: i * spread, data: osc({ freq: f, dur: 0.4, type, gain, release: 0.26 }) })),
);

const recipes = {
  chop: () => woodHit({ seed: 21, body: 176, drop: 0.6 }),
  quarry: () => stoneHit({ seed: 33 }),
  gather: () => leafRustle({ seed: 41 }),
  forage: () => leafRustle({ seed: 47, gain: 0.8 }),
  plant: () => soilPat({ seed: 57 }),
  water: () => mixMono([
    { at: 0, data: noise({ dur: 0.3, gain: 0.16, lp: 3600, hp: 700, decay: 2.6, seed: 61 }) },
    { at: 0.12, data: osc({ freq: 640, glideTo: 420, dur: 0.14, type: 'sine', gain: 0.08, release: 0.1 }) },
  ]),
  harvest: () => containerTick({ seed: 71 }),
  build: () => mixMono([
    { at: 0, data: woodHit({ seed: 73, gain: 0.85 }) },
    { at: 0.17, data: woodHit({ seed: 77, gain: 0.6, body: 168, drop: 0.4 }) },
  ]),
  repair: () => mixMono([
    { at: 0, data: woodHit({ seed: 83, gain: 0.7, body: 210 }) },
    { at: 0.12, data: stoneHit({ seed: 87, gain: 0.5 }) },
  ]),
  craft: () => mixMono([
    { at: 0, data: woodHit({ seed: 231, gain: 0.7 }) },
    { at: 0.2, data: fm({ freq: 880, dur: 0.16, gain: 0.13, ratio: 3.51, index: 5, decay: 6 }) },
  ]),
  eat: () => mixMono([
    { at: 0, data: containerTick({ seed: 241 }) },
    { at: 0.14, data: osc({ freq: 330, dur: 0.12, type: 'sine', gain: 0.1, release: 0.09 }) },
  ]),
  store: () => containerTick({ seed: 93 }),
  withdraw: () => containerTick({ seed: 95 }),
  exchange: () => coinClink({ seed: 103 }),
  expand: () => mixMono([
    { at: 0, data: woodHit({ seed: 121, gain: 0.9 }) },
    { at: 0.2, data: woodHit({ seed: 127, gain: 0.7, body: 150, drop: 0.7 }) },
    { at: 0.42, data: coinClink({ seed: 131, gain: 0.7 }) },
  ]),
  birth: () => chime([523.25, 659.25, 783.99, 1046.5], { gain: 0.17, spread: 0.11 }),
  death: () => osc({ freq: 220, glideTo: 82, dur: 1.5, type: 'triangle', gain: 0.2, release: 0.9 }),
  playerDown: () => mixMono([
    { at: 0, data: osc({ freq: 110, glideTo: 41, dur: 2.4, type: 'sine', gain: 0.28, release: 1.6 }) },
    { at: 0.3, data: noise({ dur: 1.2, gain: 0.09, lp: 400, hp: 30, decay: 2.2, seed: 199 }) },
  ]),
  storm: () => mixMono([
    { at: 0, data: thunderCrack({ seed: 173 }) },
    { at: 1.15, data: thunderCrack({ seed: 179, gain: 0.6 }) },
  ]),
  cold: () => icyShimmer(),
  deny, click: uiTick,
  talk: speechBlip,

  // 设施与场地
  facility: () => mixMono([
    { at: 0, data: noise({ dur: 0.09, gain: 0.16, lp: 1800, hp: 300, decay: 9, seed: 251 }) },
    { at: 0.07, data: osc({ freq: 392, dur: 0.12, type: 'triangle', gain: 0.12, release: 0.09 }) },
  ]),
  road: () => mixMono([
    { at: 0, data: noise({ dur: 0.16, gain: 0.2, lp: 3400, hp: 900, decay: 7, seed: 261 }) },
    { at: 0.1, data: stoneHit({ seed: 263, gain: 0.5 }) },
  ]),
  lookout: () => mixMono([
    { at: 0, data: noise({ dur: 0.7, gain: 0.1, lp: 1400, hp: 180, decay: 1.6, seed: 271 }) },
    { at: 0.2, data: osc({ freq: 660, glideTo: 880, dur: 0.4, type: 'sine', gain: 0.07, release: 0.3 }) },
  ]),
  rest: () => mixMono([
    { at: 0, data: thump({ seed: 281, gain: 0.24 }) },
    { at: 0.04, data: noise({ dur: 0.18, gain: 0.08, lp: 2200, hp: 400, decay: 6, seed: 283 }) },
  ]),

  // 生物
  chicken: () => vocal({ base: 1250, sweep: 0.72, dur: 0.09, repeats: 3, spread: 0.14, vib: 0.02, gain: 0.2, breath: 0.06, lp: 5200, seed: 301 }),
  cow: () => vocal({ base: 176, sweep: 0.62, dur: 0.75, type: 'saw', vib: 0.012, vibHz: 4.4, gain: 0.2, breath: 0.14, lp: 900, seed: 311 }),
  sheep: () => vocal({ base: 520, sweep: 0.82, dur: 0.45, type: 'triangle', vib: 0.05, vibHz: 13, repeats: 2, spread: 0.5, gain: 0.17, breath: 0.08, lp: 2600, seed: 321 }),
  bird: () => vocal({ base: 2600, sweep: 1.28, dur: 0.11, repeats: 3, spread: 0.1, gain: 0.11, breath: 0.02, lp: 9000, seed: 331 }),
  deer: () => vocal({ base: 420, sweep: 0.8, dur: 0.2, gain: 0.14, breath: 0.2, lp: 1400, seed: 341 }),
  rabbit: () => thump({ seed: 351, gain: 0.34 }),
  fox: () => vocal({ base: 1500, sweep: 0.45, dur: 0.32, type: 'saw', gain: 0.16, breath: 0.1, lp: 5200, seed: 361 }),
  alarm: () => mixMono([
    { at: 0, data: vocal({ base: 1400, sweep: 0.66, dur: 0.08, repeats: 5, spread: 0.1, gain: 0.22, lp: 6000, seed: 371 }) },
    { at: 0.05, data: leafRustle({ seed: 373, gain: 1.4 }) },
  ]),
  slaughter: () => mixMono([
    { at: 0, data: vocal({ base: 1100, sweep: 0.5, dur: 0.26, type: 'saw', gain: 0.14, lp: 4200, seed: 381 }) },
    { at: 0.1, data: thump({ seed: 383, gain: 0.45 }) },
  ]),
  feed: () => mixMono(
    [0, 0.06, 0.11, 0.19, 0.24].map((at, i) => ({
      at, data: noise({ dur: 0.04, gain: 0.12 - i * 0.012, lp: 6500, hp: 2200, decay: 22, seed: 391 + i }),
    })),
  ),
  treeFall: () => crackFall({ seed: 401 }),

  // 生命周期
  adult: () => rising([523.25, 659.25], { gain: 0.14 }),
  elder: () => falling([392, 293.66], { gain: 0.14 }),
  marriage: () => mixMono([
    { at: 0, data: pluck({ freq: 523.25, dur: 0.9, gain: 0.16, bright: 0.4, seed: 411 }) },
    { at: 0.16, data: pluck({ freq: 659.25, dur: 0.9, gain: 0.16, bright: 0.4, seed: 413 }) },
    { at: 0.5, data: chime([783.99, 1046.5], { gain: 0.12 }) },
  ]),
  milestone: () => chime([523.25, 659.25, 783.99, 1046.5], { gain: 0.16 }),
  sleep: () => mixMono([
    { at: 0, data: osc({ freq: 294, glideTo: 147, dur: 0.9, type: 'sine', gain: 0.14, release: 0.7 }) },
    { at: 0.1, data: noise({ dur: 0.7, gain: 0.07, lp: 1200, hp: 200, decay: 3.4, seed: 421 }) },
  ]),

  // 聚落与配给
  crisisEnter: () => mixMono([
    { at: 0, data: falling([220, 164.81, 110], { gain: 0.18, spread: 0.2, type: 'sine' }) },
    { at: 0.3, data: osc({ freq: 55, dur: 1.1, type: 'sine', gain: 0.2, release: 0.8 }) },
  ]),
  recover: () => rising([329.63, 392, 493.88], { gain: 0.13 }),
  extinct: () => mixMono([
    { at: 0, data: osc({ freq: 82, glideTo: 62, dur: 2.4, type: 'sine', gain: 0.18, release: 1.8 }) },
    { at: 0.4, data: noise({ dur: 1.6, gain: 0.05, lp: 600, hp: 60, decay: 1.4, seed: 431 }) },
  ]),
  ration: () => mixMono([
    { at: 0, data: noise({ dur: 0.12, gain: 0.12, lp: 3200, hp: 700, decay: 9, seed: 441 }) },
    { at: 0.08, data: containerTick({ seed: 443, gain: 0.7 }) },
  ]),
  shortfall: () => knockHollow({ seed: 451 }),
  drought: () => dryCrackle({ seed: 461 }),

  // 建造状态
  foundation: () => mixMono([
    { at: 0, data: woodHit({ seed: 471, gain: 0.8, body: 150, drop: 0.7 }) },
    { at: 0.12, data: soilPat({ seed: 473 }) },
  ]),
  frameUp: () => mixMono([
    { at: 0, data: woodHit({ seed: 481, gain: 0.8, body: 170 }) },
    { at: 0.2, data: woodHit({ seed: 483, gain: 0.9, body: 214 }) },
  ]),
  complete: () => mixMono([
    { at: 0, data: woodHit({ seed: 491, gain: 0.9, body: 180 }) },
    { at: 0.22, data: chime([392, 523.25, 659.25], { gain: 0.15 }) },
  ]),
  damaged: () => mixMono([
    { at: 0, data: noise({ dur: 0.22, gain: 0.26, lp: 4200, hp: 800, decay: 8, seed: 501 }) },
    { at: 0.18, data: thump({ seed: 503, gain: 0.36 }) },
    { at: 0.3, data: dryCrackle({ seed: 507 }) },
  ]),

  // 合作与交谈
  coopAccept: () => rising([392, 523.25], { gain: 0.13, spread: 0.09 }),
  coopRefuse: () => mixMono([
    { at: 0, data: osc({ freq: 196, dur: 0.1, type: 'triangle', gain: 0.13, release: 0.06 }) },
    { at: 0.12, data: osc({ freq: 164.81, dur: 0.14, type: 'triangle', gain: 0.11, release: 0.1 }) },
  ]),
  coopAlt: () => mixMono([
    { at: 0, data: osc({ freq: 330, dur: 0.09, type: 'triangle', gain: 0.11, release: 0.06 }) },
    { at: 0.11, data: osc({ freq: 294, dur: 0.12, type: 'triangle', gain: 0.1, release: 0.08 }) },
  ]),
  talkIgnore: () => osc({ freq: 220, dur: 0.1, type: 'sine', gain: 0.1, release: 0.08 }),
  talkLeave: () => mixMono([
    { at: 0, data: falling([392, 293.66], { gain: 0.11, spread: 0.1 }) },
    { at: 0.24, data: thump({ seed: 511, gain: 0.22 }) },
  ]),
  insult: () => mixMono([
    { at: 0, data: fm({ freq: 330, dur: 0.22, gain: 0.16, ratio: 1.41, index: 14, decay: 4 }) },
    { at: 0.02, data: noise({ dur: 0.18, gain: 0.12, lp: 3600, hp: 700, decay: 6, seed: 521 }) },
  ]),
  attack: () => mixMono([
    { at: 0, data: thump({ seed: 531, gain: 0.5 }) },
    { at: 0.06, data: stoneHit({ seed: 533, gain: 0.8 }) },
    { at: 0.2, data: osc({ freq: 147, glideTo: 110, dur: 0.3, type: 'sine', gain: 0.14, release: 0.2 }) },
  ]),

  // 界面
  dlgOpen: () => mixMono([
    { at: 0, data: osc({ freq: 880, dur: 0.05, type: 'sine', gain: 0.08, release: 0.03 }) },
    { at: 0.04, data: osc({ freq: 1174.66, dur: 0.06, type: 'sine', gain: 0.07, release: 0.04 }) },
  ]),
  dlgClose: () => osc({ freq: 587.33, dur: 0.06, type: 'sine', gain: 0.07, release: 0.04 }),
  bagOpen: () => mixMono([
    { at: 0, data: noise({ dur: 0.14, gain: 0.12, lp: 4200, hp: 800, decay: 7, seed: 541 }) },
    { at: 0.06, data: uiTick(), gain: 0.8 },
  ]),
  modeSwitch: () => mixMono([
    { at: 0, data: osc({ freq: 523.25, glideTo: 783.99, dur: 0.14, type: 'triangle', gain: 0.09, release: 0.1 }) },
  ]),
  audioToggle: () => uiTick(),
};

// 世界反馈码 → 音效族（前端只认这张表，不在业务代码里散写音色）。
export const SFX_BY_CODE = {
  NEED_TOOL: 'deny', NO_MATERIAL: 'deny', NO_SITE: 'deny', OCCUPIED: 'deny', NO_LOT: 'deny',
  NO_FACILITY: 'deny', OUT_OF_REACH: 'deny', ACTION_BUDGET: 'deny', CONTAINER_FULL: 'deny',
  EMPTY: 'deny', BAD_ITEM: 'deny', NO_WATER: 'deny', NO_RESOURCE: 'deny', NO_AUTHORITY: 'deny',
  INVITE_DECLINED: 'coopRefuse', NO_DISCUSSION: 'deny', TREE_GROWING: 'deny', RESIDENT_COOLDOWN: 'deny',
  RESIDENT_OUT_OF_REACH: 'deny', RESIDENT_NEED_HAND: 'deny', NO_RESIDENT: 'deny', CAMP_ENDED: 'deny',
  NEED_TRAY: 'deny', RESIDENT_HURT: 'deny', UNKNOWN_KIND: 'deny', BAD_PLOT: 'deny',
  WRONG_SOURCE: 'deny', NOT_GARDEN: 'deny', NOT_WELL: 'deny', NOT_WORKBENCH: 'deny',
  BUCKET_FULL: 'deny', WATER_FULL: 'deny', NOT_HOME: 'deny',
  RESIDENT_TALKED: 'talk', PLAYER_DEAD: 'playerDown',
};

export const SFX_BY_KIND = {
  camp_chop: 'chop', camp_collect: 'gather', camp_plant: 'plant', camp_water: 'water',
  camp_craft: 'craft', camp_eat: 'eat', camp_store: 'store', camp_take: 'withdraw',
  camp_resident: 'talk', camp_sleep: 'sleep', camp_exit: 'dlgClose',
  gather: 'chop', forage: 'forage', harvest: 'harvest', plant: 'plant',
  build: 'build', repair: 'repair', plan: 'foundation',
  exchange: 'exchange', expand: 'expand', deposit: 'store', withdraw: 'withdraw',
  coop_request: 'click', talk_say: 'talk', move: null, move_to: null, player_sync: null,
  facility_use: 'facility', road_lay: 'road', road_remove: 'road', look_out: 'lookout',
  rest: 'rest', house_work: 'rest', animal_feed: 'feed', animal_slaughter: 'slaughter',
  home_grant: 'foundation', home_break: 'damaged', take_shared: 'ration',
};

export const sfxNames = () => Object.keys(recipes);

// 单声道 → 交织立体声：右声道轻微延迟与衰减，做出不晕的宽度。
function widen(mono, { offset = 0.0006, level = 0.92 } = {}) {
  const shift = Math.round(offset * SR);
  const out = new Float32Array((mono.length + shift) * 2);
  for (let i = 0; i < mono.length; i++) {
    out[i * 2] += mono[i];
    out[(i + shift) * 2 + 1] += mono[i] * level;
  }
  return out;
}

export function renderSfx(name) {
  const recipe = recipes[name];
  if (!recipe) return null;
  // 峰值归一到 0.5：一族之间响度一致，主音量旋钮才有统一意义；留出与 BGM 叠加的余量。
  return normalize(reverb(recipe(), { time: 1.1, mix: 0.16, seed: 7 }), 0.5);
}

// ───────────────────────── BGM ─────────────────────────

const PENTA = [0, 2, 4, 7, 9];
const deg = (root, d) => root + 12 * Math.floor(d / 5) + PENTA[((d % 5) + 5) % 5];

// 八套主题：四季 ×（昼/夜配器）+ 危机 + 恢复中 + 灭绝 + 开始菜单。
// 每套都是手写音符数据（不是规则生成），换季/换状态时小节边界接管，不硬切。
// 可选字段：arp=false 撤掉琶音、perc='soft'|'none' 减打击、ornament='bird' 加林鸟点缀。
const THEMES = {
  spring: {
    bpm: 100, root: 60, bars: 8, ornament: 'bird',
    chords: [[0, 4, 7], [9, 12, 16], [5, 9, 12], [7, 11, 14], [0, 4, 7], [4, 7, 11], [9, 12, 16], [5, 9, 12]],
    leadDay: [
      [0, 4, 1], [1, 5, 0.5], [1.5, 6, 0.5], [2, 5, 1], [3, 4, 1],
      [4, 2, 1.5], [5.5, 3, 0.5], [6, 4, 2],
      [8, 5, 1], [9, 6, 1], [10, 7, 2],
      [12, 6, 1], [13, 5, 1], [14, 4, 2],
      [16, 5, 1.5], [17.5, 6, 0.5], [18, 7, 1], [19, 8, 1],
      [20, 7, 2], [22, 5, 2],
      [24, 4, 1], [25, 5, 1], [26, 6, 2],
      [28, 5, 1], [29, 4, 1], [30, 2, 2],
    ],
    leadNight: [
      [0, 2, 2], [2, 3, 2], [4, 1, 4],
      [8, 4, 2], [10, 2, 2], [12, 1, 4],
      [16, 3, 3], [19, 2, 1], [20, 1, 4],
      [24, 0, 4], [28, 1, 4],
    ],
  },
  summer: {
    bpm: 112, root: 57, bars: 8,
    chords: [[0, 4, 7], [5, 9, 12], [7, 10, 14], [9, 12, 16], [0, 4, 7], [7, 10, 14], [5, 9, 12], [9, 12, 16]],
    leadDay: [
      [0, 4, 0.5], [0.5, 5, 0.5], [1, 7, 1], [2, 6, 1], [3, 5, 1],
      [4, 4, 1], [5, 2, 1], [6, 4, 2],
      [8, 7, 0.5], [8.5, 6, 0.5], [9, 5, 1], [10, 4, 2],
      [12, 5, 1], [13, 6, 1], [14, 7, 2],
      [16, 9, 1], [17, 7, 1], [18, 6, 1], [19, 5, 1],
      [20, 4, 2], [22, 5, 2],
      [24, 7, 1], [25, 6, 1], [26, 5, 1], [27, 4, 1],
      [28, 2, 2], [30, 4, 2],
    ],
    leadNight: [
      [0, 4, 2], [2, 2, 2], [4, 1, 4],
      [8, 2, 2], [10, 4, 2], [12, 5, 4],
      [16, 4, 2], [18, 2, 2], [20, 1, 4],
      [24, 2, 4], [28, 0, 4],
    ],
  },
  autumn: {
    bpm: 92, root: 55, bars: 8, perc: 'soft',
    chords: [[0, 3, 7], [7, 10, 14], [5, 8, 12], [3, 7, 10], [0, 3, 7], [10, 14, 17], [7, 10, 14], [5, 8, 12]],
    leadDay: [
      [0, 5, 1.5], [1.5, 4, 0.5], [2, 3, 2],
      [4, 4, 1], [5, 5, 1], [6, 6, 2],
      [8, 7, 2], [10, 5, 2],
      [12, 4, 2], [14, 3, 2],
      [16, 5, 1.5], [17.5, 4, 0.5], [18, 3, 2],
      [20, 2, 2], [22, 4, 2],
      [24, 3, 2], [26, 2, 2],
      [28, 1, 2], [30, 0, 2],
    ],
    leadNight: [
      [0, 3, 3], [3, 2, 1], [4, 1, 4],
      [8, 2, 4], [12, 1, 4],
      [16, 3, 4], [20, 2, 4],
      [24, 1, 4], [28, 0, 4],
    ],
  },
  winter: {
    bpm: 76, root: 53, bars: 8, arp: false, perc: 'soft',
    chords: [[0, 3, 7], [5, 8, 12], [0, 3, 7], [-2, 3, 8], [0, 3, 7], [3, 7, 10], [5, 8, 12], [0, 3, 7]],
    leadDay: [
      [0, 4, 2], [2, 3, 2],
      [4, 2, 3], [7, 1, 1],
      [8, 3, 2], [10, 4, 2],
      [12, 2, 4],
      [16, 1, 2], [18, 2, 2],
      [20, 3, 4],
      [24, 2, 2], [26, 1, 2],
      [28, 0, 4],
    ],
    leadNight: [
      [0, 1, 4], [4, 0, 4],
      [8, 2, 4], [12, 1, 4],
      [16, 0, 4], [20, 1, 4],
      [24, 0, 8],
    ],
  },
  crisis: { bpm: 72, root: 45, bars: 4, arp: false, perc: 'none',
    chords: [[0, 7], [0, 7], [-5, 2], [-5, 2]] },
  recovering: {
    bpm: 96, root: 60, bars: 8, perc: 'soft',
    chords: [[0, 4, 7], [9, 12, 16], [5, 9, 12], [7, 11, 14], [0, 4, 7], [5, 9, 12], [7, 11, 14], [0, 4, 7]],
    leadDay: [
      [0, 2, 2], [2, 3, 2], [4, 4, 4],
      [8, 5, 2], [10, 4, 2], [12, 5, 4],
      [16, 6, 2], [18, 5, 2], [20, 4, 4],
      [24, 5, 4], [28, 7, 4],
    ],
    leadNight: [
      [0, 2, 4], [4, 1, 4], [8, 3, 4], [12, 2, 4],
      [16, 1, 4], [20, 2, 4], [24, 0, 8],
    ],
  },
  extinct: { bpm: 58, root: 43, bars: 4, arp: false, perc: 'none',
    chords: [[0, 7], [-2, 5], [0, 7], [-5, 2]],
    leadNight: [[0, 0, 4], [4, -1, 4], [8, 0, 4], [12, -1, 8]] },
  menu: {
    bpm: 92, root: 60, bars: 4, perc: 'soft',
    chords: [[0, 4, 7], [9, 12, 16], [5, 9, 12], [7, 11, 14]],
    leadDay: [
      [0, 4, 1], [1, 5, 1], [2, 6, 2],
      [4, 5, 1], [5, 4, 1], [6, 2, 2],
      [8, 4, 1], [9, 6, 1], [10, 7, 2],
      [12, 6, 2], [14, 5, 2],
    ],
    leadNight: [[0, 2, 2], [2, 4, 2], [4, 5, 4], [8, 4, 4], [12, 2, 4]],
  },
};

const SEASON_THEME = { 春: 'spring', 夏: 'summer', 秋: 'autumn', 冬: 'winter' };
export const themeForSeason = (season) => SEASON_THEME[season] ?? 'spring';
const CRISIS = THEMES.crisis;

export const musicMeta = ({ theme = 'spring', crisis = false } = {}) => {
  const t = THEMES[crisis ? 'crisis' : theme] ?? THEMES.spring;
  return { bpm: t.bpm, bars: t.bars, secondsPerBar: beatSec(t.bpm) * 4 };
};

// 渲染一小节（4 拍）为交织立体声；按小节渲染便于换季/换状态时平滑接管，也便于内存回收。
export function renderMusicBar({ theme = 'spring', day = true, crisis = false, bar = 0 } = {}) {
  const t = THEMES[crisis ? 'crisis' : theme] ?? THEMES.spring;
  const spb = beatSec(t.bpm);
  const total = spb * 4;
  const chord = t.chords[bar % t.chords.length];
  const at = (beat) => beat * spb;
  const clips = [];

  // 低音：根音 + 五音。灭绝/危机只留这一层。
  for (let i = 0; i < Math.min(2, chord.length); i++) {
    for (let b = 0; b < 4; b += 2) {
      clips.push({
        at: at(b + (i ? 1.5 : 0)),
        data: osc({ freq: midiSafe(deg(t.root - 12, chord[i])), type: 'triangle', gain: 0.2, release: 0.1 }),
      });
    }
  }

  if (t.arp !== false) {
    for (let b = 0; b < 8; b++) {
      const note = deg(t.root, chord[b % chord.length] + (b % 6 === 4 ? 5 : 0));
      clips.push({
        at: at(b / 2),
        data: pluck({ freq: midiSafe(note), dur: spb * 1.4, gain: day ? 0.12 : 0.085, decay: 0.9965, bright: day ? 0.52 : 0.34, seed: 400 + bar * 8 + b }),
        pan: b % 2 ? 0.25 : -0.25,
      });
    }
  }

  // 旋律：灭绝档没有白天版，统一落到 leadNight。
  const table = day && t.leadDay ? t.leadDay : t.leadNight ?? t.leadDay ?? [];
  for (const [beat, d, len] of table.filter(([b]) => b >= bar * 4 && b < (bar + 1) * 4)) {
    clips.push({
      at: at(beat - bar * 4),
      data: osc({
        freq: midiSafe(deg(t.root + (day && t.leadDay ? 12 : 0), d)),
        dur: spb * len, type: day ? 'pulse' : 'sine', gain: day ? 0.1 : 0.12,
        vibHz: 5.2, vibDepth: day ? 0.006 : 0.003, release: spb * 0.25,
      }),
      pan: 0.05,
    });
  }

  if (t.perc !== 'none') {
    const soft = t.perc === 'soft';
    for (const b of soft ? [0] : [0, 2]) {
      clips.push({ at: at(b), data: osc({ freq: 128, glideTo: 48, dur: spb * 0.4, type: 'sine', gain: soft ? 0.18 : 0.26, release: 0.06 }) });
    }
    for (const b of soft ? [2] : [1, 3]) {
      clips.push({ at: at(b), data: noise({ dur: spb * 0.22, gain: day ? 0.09 : 0.055, lp: 5200, hp: 1200, decay: 12, seed: 500 + bar * 4 + b }), pan: -0.2 });
    }
    if (!soft) for (let b = 0; b < 16; b += 2) {
      clips.push({ at: at(b / 4), data: noise({ dur: 0.02, gain: day ? 0.04 : 0.026, lp: 11000, hp: 6000, decay: 30, seed: 600 + bar * 16 + b }), pan: 0.3 });
    }
  }

  // 春天的白天加两声林鸟：季节要听得出季节。
  if (t.ornament === 'bird' && day) {
    for (const [b, seed] of [[0.7, 701], [2.6, 709]]) {
      clips.push({ at: at(b), data: vocal({ base: 2700, sweep: 1.3, dur: 0.1, repeats: 2, spread: 0.12, gain: 0.07, lp: 9000, seed }), pan: 0.55 });
    }
  }

  const target = crisis ? 0.4 : theme === 'extinct' ? 0.34 : day ? 0.5 : 0.42;
  return finish(mix(clips, total), target);
}

// ───────────────────────── 环境声（可循环） ─────────────────────────

export function renderAmbience(name) {
  // 环境声是"底"，峰值目标一律低于 BGM，避免一进场就盖住动作音效。
  if (name === 'rain') return noiseLoop(noise({ dur: 3.2, gain: 0.15, lp: 5200, hp: 500, decay: 1.1, seed: 711 }), 0.34);
  if (name === 'wind') return noiseLoop(noise({ dur: 4, gain: 0.11, lp: 1200, hp: 90, decay: 1.4, seed: 733 }), 0.24);
  if (name === 'cold') return noiseLoop(mixMono([
    { at: 0, data: noise({ dur: 3, gain: 0.08, lp: 700, hp: 60, decay: 1.6, seed: 781 }) },
    { at: 0.6, data: icyShimmer(), gain: 0.5 },
  ]), 0.22);
  if (name === 'night') return noiseLoop(mixMono([
    { at: 0, data: noise({ dur: 3.5, gain: 0.045, lp: 900, hp: 200, decay: 1.2, seed: 771 }) },
    ...[0.4, 1.3, 2.1, 2.9].map((at, i) => ({
      at, data: osc({ freq: 4200 + i * 180, dur: 0.05, type: 'sine', gain: 0.03, release: 0.03 }),
    })),
  ]), 0.2);
  if (name === 'crisis') return noiseLoop(mixMono([
    { at: 0, data: osc({ freq: 54, dur: 1, type: 'sine', gain: 0.24, release: 0.3 }) },
    { at: 0.55, data: osc({ freq: 50, dur: 0.7, type: 'sine', gain: 0.16, release: 0.3 }) },
  ]), 0.3);
  if (name === 'day') return noiseLoop(mixMono([
    { at: 0, data: noise({ dur: 3, gain: 0.03, lp: 2600, hp: 400, decay: 1.3, seed: 791 }) },
    ...[0.9, 2.2].map((at, i) => ({ at, data: leafRustle({ seed: 801 + i, gain: 0.5 }) })),
  ]), 0.18);
  return null;
}

export const ambienceNames = () => ['day', 'night', 'rain', 'wind', 'cold', 'crisis'];

// 循环体接缝处理：首尾 0.25 秒交叉，避免每循环"哒"一声。
function noiseLoop(mono, level) {
  const n = mono.length, fade = Math.round(SR * 0.25);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const k = i / n;
    const edge = k < 0.25 ? k / 0.25 : k > 0.75 ? (1 - k) / 0.25 : 1;
    out[i] = mono[i] * (0.55 + 0.45 * edge);
  }
  return normalize(widen(out), level);
}

// 峰值归一：小节之间、循环之间响度一致，主音量旋钮才有统一意义；target 留出头量给音效叠加。
function finish(stereo, target) {
  return normalize(stereo, target);
}
