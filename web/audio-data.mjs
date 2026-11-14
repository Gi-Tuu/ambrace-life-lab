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
  goal: () => chime([523.25, 659.25, 783.99]),
  levelup: () => chime([392, 523.25, 659.25, 880]),
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
  talk: () => speechBlip({ seed: 151 }),
  refuse: () => speechBlip({ seed: 163 }),
};

// 世界反馈码 → 音效族（前端只认这张表，不在业务代码里散写音色）。
export const SFX_BY_CODE = {
  NEED_TOOL: 'deny', NO_MATERIAL: 'deny', NO_SITE: 'deny', OCCUPIED: 'deny', NO_LOT: 'deny',
  NO_FACILITY: 'deny', OUT_OF_REACH: 'deny', ACTION_BUDGET: 'deny', CONTAINER_FULL: 'deny',
  EMPTY: 'deny', BAD_ITEM: 'deny', NO_WATER: 'deny', NO_RESOURCE: 'deny', NO_AUTHORITY: 'deny',
  INVITE_DECLINED: 'refuse', NO_DISCUSSION: 'deny', TREE_GROWING: 'deny', RESIDENT_COOLDOWN: 'deny',
  RESIDENT_OUT_OF_REACH: 'deny', RESIDENT_NEED_HAND: 'deny', NO_RESIDENT: 'deny', CAMP_ENDED: 'deny',
  NEED_TRAY: 'deny', RESIDENT_HURT: 'deny', UNKNOWN_KIND: 'deny', BAD_PLOT: 'deny',
  WRONG_SOURCE: 'deny', NOT_GARDEN: 'deny', NOT_WELL: 'deny', NOT_WORKBENCH: 'deny',
  BUCKET_FULL: 'deny', WATER_FULL: 'deny', NOT_HOME: 'deny',
  RESIDENT_TALKED: 'talk', PLAYER_DEAD: 'playerDown',
};

export const SFX_BY_KIND = {
  camp_chop: 'chop', camp_collect: 'gather', camp_plant: 'plant', camp_water: 'water',
  camp_craft: 'craft', camp_eat: 'eat', camp_store: 'store', camp_take: 'withdraw',
  camp_resident: 'talk', camp_sleep: 'click',
  gather: 'chop', forage: 'forage', harvest: 'harvest', plant: 'plant',
  build: 'build', repair: 'repair', plan: 'click', craft: 'craft',
  exchange: 'exchange', expand: 'expand', deposit: 'store', withdraw: 'withdraw',
  coop_request: 'click', talk_say: 'talk', move: null,
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

const THEMES = {
  warm: {
    bpm: 104, root: 60, bars: 8,
    chords: [[0, 4, 7], [7, 11, 14], [9, 12, 16], [5, 9, 12], [0, 4, 7], [7, 11, 14], [4, 7, 11], [5, 9, 12]],
    // [绝对拍位（0–31）, 五声级数, 时长(拍)]
    leadDay: [
      [0, 4, 1], [1, 5, 0.5], [1.5, 4, 0.5], [2, 2, 1], [3, 3, 1],
      [4, 5, 1.5], [5.5, 6, 0.5], [6, 7, 2],
      [8, 6, 1], [9, 5, 1], [10, 4, 2],
      [12, 3, 1], [13, 4, 1], [14, 5, 2],
      [16, 7, 1], [17, 6, 1], [18, 5, 1], [19, 4, 1],
      [20, 5, 1.5], [21.5, 6, 0.5], [22, 7, 2],
      [24, 8, 1], [25, 7, 1], [26, 5, 2],
      [28, 6, 1], [29, 5, 1], [30, 4, 2],
    ],
    leadNight: [
      [0, 2, 2], [2, 1, 2], [4, 3, 2], [6, 2, 2],
      [8, 0, 3], [11, 1, 1], [12, 2, 4],
      [16, 4, 2], [18, 3, 2], [20, 2, 4],
      [24, 1, 2], [26, 2, 2], [28, 0, 4],
    ],
  },
  cool: {
    bpm: 88, root: 57, bars: 8,
    chords: [[0, 3, 7], [5, 8, 12], [7, 10, 14], [3, 7, 10], [0, 3, 7], [10, 14, 17], [5, 8, 12], [7, 10, 14]],
    leadDay: [
      [0, 3, 1.5], [1.5, 2, 0.5], [2, 1, 2],
      [4, 2, 1], [5, 3, 1], [6, 4, 2],
      [8, 5, 2], [10, 4, 1], [11, 3, 1],
      [12, 2, 4],
      [16, 3, 2], [18, 4, 2], [20, 5, 4],
      [24, 6, 1.5], [25.5, 5, 0.5], [26, 4, 2],
      [28, 3, 1], [29, 2, 1], [30, 1, 2],
    ],
    leadNight: [
      [0, 1, 3], [3, 0, 1], [4, 1, 4],
      [8, 2, 3], [11, 1, 1], [12, 0, 4],
      [16, 1, 4], [20, 2, 4],
      [24, 0, 4], [28, 1, 2], [30, 0, 2],
    ],
  },
};

const CRISIS = { bpm: 72, root: 45, bars: 4, chords: [[0, 7], [0, 7], [-5, 2], [-5, 2]] };

export const musicMeta = ({ theme = 'warm', crisis = false } = {}) => {
  const t = crisis ? CRISIS : THEMES[theme] ?? THEMES.warm;
  return { bpm: t.bpm, bars: t.bars, secondsPerBar: beatSec(t.bpm) * 4 };
};

// 渲染一小节（4 拍）为交织立体声；按小节渲染便于换季节/昼夜时平滑接管，也便于内存回收。
export function renderMusicBar({ theme = 'warm', day = true, crisis = false, bar = 0 } = {}) {
  const t = crisis ? CRISIS : THEMES[theme] ?? THEMES.warm;
  const spb = beatSec(t.bpm);
  const total = spb * 4;
  const chord = t.chords[bar % t.chords.length];
  const at = (beat) => beat * spb;
  const clips = [];

  if (crisis) {
    // 危机：只留低音脉冲 + 稀疏高音，旋律与琶音全部撤走。
    for (let b = 0; b < 4; b++) {
      clips.push({ at: at(b), data: osc({ freq: midiSafe(deg(t.root, chord[0])), dur: spb * 0.5, type: 'sine', gain: 0.3, release: 0.12 }) });
    }
    clips.push({ at: at(2.5), data: noise({ dur: 0.05, gain: 0.05, lp: 8000, hp: 4000, decay: 24, seed: 300 + bar }) });
    return finish(mix(clips, total), 0.4);
  }

  for (let i = 0; i < 2; i++) {
    for (let b = 0; b < 4; b += 2) {
      clips.push({
        at: at(b + (i ? 1.5 : 0)),
        data: osc({ freq: midiSafe(deg(t.root - 12, chord[i] ?? chord[0])), type: 'triangle', gain: 0.2, release: 0.1 }),
      });
    }
  }

  for (let b = 0; b < 8; b++) {
    const note = deg(t.root, chord[b % chord.length] / 1 + (b % 6 === 4 ? 5 : 0));
    clips.push({
      at: at(b / 2),
      data: pluck({ freq: midiSafe(note), dur: spb * 1.4, gain: day ? 0.12 : 0.085, decay: 0.9965, bright: day ? 0.52 : 0.34, seed: 400 + bar * 8 + b }),
      pan: b % 2 ? 0.25 : -0.25,
    });
  }

  const lead = (day ? t.leadDay : t.leadNight).filter(([beat]) => beat >= bar * 4 && beat < (bar + 1) * 4);
  for (const [beat, d, len] of lead) {
    clips.push({
      at: at(beat - bar * 4),
      data: osc({
        freq: midiSafe(deg(t.root + (day ? 12 : 0), d)),
        dur: spb * len, type: day ? 'pulse' : 'sine', gain: day ? 0.1 : 0.12,
        vibHz: 5.2, vibDepth: day ? 0.006 : 0.003, release: spb * 0.25,
      }),
      pan: 0.05,
    });
  }

  for (const b of [0, 2]) {
    clips.push({ at: at(b), data: osc({ freq: 128, glideTo: 48, dur: spb * 0.4, type: 'sine', gain: 0.26, release: 0.06 }) });
  }
  for (const b of [1, 3]) {
    clips.push({ at: at(b), data: noise({ dur: spb * 0.22, gain: day ? 0.09 : 0.055, lp: 5200, hp: 1200, decay: 12, seed: 500 + bar * 4 + b }), pan: -0.2 });
  }
  for (let b = 0; b < 16; b += 2) {
    clips.push({ at: at(b / 4), data: noise({ dur: 0.02, gain: day ? 0.04 : 0.026, lp: 11000, hp: 6000, decay: 30, seed: 600 + bar * 16 + b }), pan: 0.3 });
  }

  return finish(mix(clips, total), day ? 0.5 : 0.42);
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
