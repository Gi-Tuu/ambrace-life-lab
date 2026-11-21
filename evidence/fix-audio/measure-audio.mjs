// 音频修复前后测量（2026-11-21）：环境床接线 / LUFS 平衡 / BGM 边界 / SFX 峰值余量。
// 运行：node evidence/fix-audio/measure-audio.mjs
// 依赖：ffmpeg（PATH 中）做 EBU R128 / volumedetect；缺失时素材响度标 SKIP。
//
// 口径：
//   · 素材级 LUFS 用 ffmpeg ebur128 实测（压缩器之前、master=1）；
//   · 有效电平 = 素材 LUFS + 20log10(master 0.7 × 代码增益)，未模拟总线压缩器的非线性；
//   · 接线用 mock WebAudio 跑**真实的 web/audio.mjs**，记录 AudioBuffer、层与增益；
//   · “修复前”层数直接读 2026-11-21 审计的 measurements.json（同一 HEAD b66f88a）。

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

import * as E from '../../web/audio-events.mjs';
import { renderAmbience, renderSfx, sfxNames } from '../../web/audio-data.mjs';
import { toWav, analyze } from '../../web/audio-synth.mjs';
import { MUSIC_TRACKS } from '../../web/music-tracks.mjs';

const OUT = resolve('evidence/fix-audio');
const WAV = join(tmpdir(), 'ambrace-fix-audio-wav');
mkdirSync(OUT, { recursive: true });
mkdirSync(WAV, { recursive: true });
const lines = [];
const log = (...a) => { const s = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '); lines.push(s); console.log(s); };
const f = (x, d = 2) => (Number.isFinite(x) ? Number(x).toFixed(d) : String(x));
const db = (g) => (g > 0 ? 20 * Math.log10(g) : -Infinity);
const dbToAmp = (d) => 10 ** (d / 20);
const MASTER = 0.7;
const BUSY = [{ loc: 'yard', type: 'shelter', phase: 'frame' }];

// ───────────────────────── ffmpeg 响度 ─────────────────────────
const ffOk = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }).status === 0;
const ff = (args) => spawnSync('ffmpeg', args, { encoding: 'utf8' }).stderr ?? '';
function measure(file) {
  if (!ffOk) return { I: NaN, peak: NaN, mean: NaN };
  const a = ff(['-hide_banner', '-nostats', '-i', file, '-af', 'ebur128=peak=true', '-f', 'null', '-']);
  const Is = [...a.matchAll(/I:\s*(-?[\d.]+)\s*LUFS/g)].map((m) => Number(m[1]));
  const Ps = [...a.matchAll(/Peak:\s*(-?[\d.]+)\s*dBFS/g)].map((m) => Number(m[1]));
  const b = ff(['-hide_banner', '-nostats', '-i', file, '-af', 'volumedetect', '-f', 'null', '-']);
  const mean = /mean_volume:\s*(-?[\d.]+) dB/.exec(b);
  const maxv = /max_volume:\s*(-?[\d.]+) dB/.exec(b);
  return { I: Is.length ? Is[Is.length - 1] : NaN, peak: Ps.length ? Ps[Ps.length - 1] : NaN,
    mean: mean ? Number(mean[1]) : NaN, max: maxv ? Number(maxv[1]) : NaN };
}

log('# 0. 环境');
log(`node ${process.version} · ffmpeg ${ffOk ? '可用' : '不可用 → LUFS SKIP'} · git ${spawnSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).stdout.trim()}`);
log(`master=${MASTER} · MUSIC_LEVEL=${E.MUSIC_LEVEL} · duck=${f(E.MUSIC_DUCK_WEATHER, 4)} (${f(db(E.MUSIC_DUCK_WEATHER), 2)}dB)`);
log('');

// ───────────────────────── A. 修复前的层数（审计数据） ─────────────────────────
let beforeAudit = null;
const auditPath = resolve('evidence/exp-audit-audio/measurements.json');
if (existsSync(auditPath)) beforeAudit = JSON.parse(readFileSync(auditPath, 'utf8'));
log('# A. 修复前（审计 b66f88a）：weather/daynight 槽把槽位名当素材名 ⇒ renderAmbience(null)');
if (beforeAudit) {
  for (const [k, v] of Object.entries(beforeAudit.bedTrace)) {
    log(`  ${k.padEnd(10)} 层=${v.beds.length} buffers=${v.buffers} ${v.beds.length ? `[${v.beds.join(' | ')}]` : '（静音）'}`);
  }
} else log('  未找到 evidence/exp-audit-audio/measurements.json → 跳过');
log('');

// ───────────────────────── B. 素材响度与修复前后增益 ─────────────────────────
const materialRows = [];
for (const name of ['rain', 'wind', 'cold', 'day', 'night', 'crisis']) {
  const stereo = renderAmbience(name);
  const info = analyze(stereo);
  const file = join(WAV, `amb-${name}.wav`);
  writeFileSync(file, toWav(stereo));
  const m = measure(file);
  materialRows.push({ name, info, ...m });
}
const musicRows = [];
for (const [theme, tr] of Object.entries(MUSIC_TRACKS)) {
  const m = measure(resolve('web', tr.file));
  const bus = E.musicTarget({ play: true, theme }, theme === 'crisis' ? 'crisis' : 'active');
  musicRows.push({ theme, ...m, bus });
}
const M = (t) => musicRows.find((r) => r.theme === t);
const A = (n) => materialRows.find((r) => r.name === n);
const oldGain = (name, prox = 0) => name === 'rain' || name === 'cold' ? 0.5 * (1 - prox * 0.5)
  : name === 'day' ? 0.4 * (1 - prox * 0.7)
    : name === 'night' ? 0.7 * (1 - prox * 0.7)
      : name === 'wind' ? 0.25 + prox * 0.55
        : name === 'crisis' ? 0.55 : 0;
const newGain = (name, prox = 0) => name === 'wind' ? E.bedGain('wind') * (0.35 + prox * 0.65)
  : E.bedGain(name) * (1 - prox * (name === 'rain' || name === 'cold' ? 0.5 : 0.7));
const effBed = (row, gain) => row.I + db(MASTER * gain);
const effMusic = (row, weatherDuck = false) => {
  const duck = weatherDuck ? E.musicDuck('rain', row.bus) : 1;
  return row.I + db(MASTER * row.bus * duck);
};

log('# B. 环境床：素材响度 / 修复前增益 / 修复后 LUFS 归一 + 显式 ducking');
log('material | 素材 I / peak | 旧增益(prox0) | 旧有效 LUFS | 新增益(prox0) | 新有效 LUFS | 旧→新');
for (const row of materialRows) {
  const name = row.name;
  const g0 = oldGain(name);
  const g1 = name === 'wind' ? E.bedGain('wind') : E.bedGain(name);
  const oldEff = effBed(row, g0);
  const newEff = effBed(row, g1);
  log(`  ${name.padEnd(6)} | ${f(row.I, 1)}LUFS / ${f(row.peak, 1)}dBFS | ${f(g0, 4)} | ${f(oldEff, 1)} | ${f(g1, 4)} | ${f(newEff, 1)} | ${f(newEff - oldEff, 1)}dB`);
}
log('  （旧有效电平是“若该床发声”的假设值；审计实测 rain/cold/day/night 从未建层。）');
log('');

log('# C. BGM 有效电平：无天气床 / 雨天（ducking 只压常规日曲）');
log('theme | 素材 I / peak | bus | 无天气 I | 雨天 I | 雨天 peak');
for (const row of musicRows) {
  log(`  ${row.theme.padEnd(13)} | ${f(row.I, 1)}LUFS / ${f(row.peak, 1)}dBFS | ${f(row.bus, 2)} | ${f(effMusic(row), 1)} | ${f(effMusic(row, true), 1)} | ${f(row.peak + db(MASTER * row.bus * E.musicDuck('rain', row.bus)), 1)}`);
}
log('');

log('# D. 同场景相对电平（修复后；Δ=BGM−床，负值=床更响）');
const pairs = [
  ['村内 昼·春 BGM vs rain 床', M('spring'), A('rain'), E.bedGain('rain'), true],
  ['村内 昼·春 BGM vs day 床', M('spring'), A('day'), E.bedGain('day'), false],
  ['村内 夜·春 BGM vs night 床', M('spring-night'), A('night'), E.bedGain('night'), false],
  ['村内 危机 BGM vs crisis 床', M('crisis'), A('crisis'), E.bedGain('crisis'), false],
  ['村内 危机 BGM vs rain 床', M('crisis'), A('rain'), E.bedGain('rain'), false],
  ['村外 prox=1 BGM(不播) vs wind 床', null, A('wind'), E.bedGain('wind'), false],
];
for (const [label, mrow, arow, gain, duck] of pairs) {
  const bed = effBed(arow, gain);
  const music = mrow ? effMusic(mrow, duck) : null;
  log(`  ${label}: BGM ${mrow ? `${f(music, 1)}LUFS` : '不播'} / 床 ${f(bed, 1)}LUFS → Δ=${mrow ? `${f(music - bed, 1)}dB` : 'n/a'}`);
}
log('');

// ───────────────────────── E. 真实接线（mock WebAudio 跑 audio.mjs） ─────────────────────────
class Param {
  constructor(value) { this.value = value; this.events = []; }
  setTargetAtTime(v, t, c) { this.events.push({ type: 'target', v, t, c }); this.value = v; return this; }
  setValueAtTime(v, t) { this.events.push({ type: 'set', v, t }); this.value = v; return this; }
  linearRampToValueAtTime(v, t) { this.events.push({ type: 'ramp', v, t }); this.value = v; return this; }
  cancelScheduledValues(t) { this.events.push({ type: 'cancel', t }); return this; }
}
class Node { connect(t) { this.target = t; return t; } disconnect() { this.disconnected = true; } }
class Gain extends Node { constructor() { super(); this.gain = new Param(1); } }
class Source extends Node {
  constructor() { super(); this.buffer = null; this.loop = false; this.onended = null; this.stopCount = 0; }
  start(...a) { this.startArgs = a; } stop() { this.stopCount += 1; }
}
class Buffer {
  constructor(ch, len, sr) { this.numberOfChannels = ch; this.length = len; this.sampleRate = sr; this.duration = len / sr; this.channels = Array.from({ length: ch }, () => null); }
  copyToChannel(data, ch) { this.channels[ch] = data; }
}
class Ctx {
  constructor() { this.sampleRate = 44100; this.currentTime = 0; this.state = 'running'; this.destination = new Node(); this.gains = []; this.sources = []; this.buffers = []; globalThis.__ctx = this; }
  createGain() { const g = new Gain(); this.gains.push(g); return g; }
  createBufferSource() { const s = new Source(); this.sources.push(s); return s; }
  createDynamicsCompressor() { const c = new Node(); for (const [k, v] of [['threshold', -16], ['knee', 24], ['ratio', 3], ['attack', 0.004], ['release', 0.22]]) c[k] = new Param(v); return c; }
  createBuffer(ch, len, sr) { const b = new Buffer(ch, len, sr); this.buffers.push(b); return b; }
  decodeAudioData() { return Promise.resolve(new Buffer(2, 44100 * 168, 44100)); }
  resume() { return Promise.resolve(); }
}
globalThis.window = { AudioContext: Ctx };
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
globalThis.fetch = async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(16) });
const audioHref = pathToFileURL(resolve('web/audio.mjs')).href;
let caseNo = 0;
const S = (over = {}) => ({
  season: '春', phase: '昼', weather: 'clear', settlement: 'active', crisisDays: 0, dead: false,
  window: { play: true, theme: 'spring', day: true, t: 0 }, proximity: 0, climate: {}, ...over,
});
async function runScene(label, args) {
  const mod = await import(`${audioHref}?measure=${++caseNo}`);
  mod.unlock();
  const ctx = globalThis.__ctx;
  mod.scene(args);
  const snap = mod.audioDebug();
  const musicRamps = ctx.gains[1].gain.events.filter((e) => e.type === 'ramp').map((e) => e.v);
  const realBuffers = ctx.buffers.filter((b) => b.channels.some((c) => c && c.length));
  const row = {
    label, beds: snap.beds, buffers: snap.buffers, musicRamp: musicRamps.at(-1) ?? null,
    sources: ctx.sources.filter((s) => s.loop).length,
    bufferDetail: realBuffers.map((b) => ({ channels: b.numberOfChannels, length: b.length, nonzero: b.channels.some((c) => c && c.some((v) => v !== 0)) })),
  };
  log(`  ${label.padEnd(20)} 层=${row.sources} [${row.beds.map((b) => `${b.slot}:${b.material}@${f(b.gain, 3)}`).join(', ') || '无'}] buffers=[${row.buffers.join(',') || '无'}] music=${f(row.musicRamp, 3)}`);
  return row;
}
log('# E. 真实接线（mock WebAudio；AudioBuffer 为真实渲染采样，层数为实际 loop 源）');
const trace = {};
trace.clear = await runScene('村内 昼 clear', S({}));
trace.rain = await runScene('村内 昼 rain', S({ weather: 'rain', climate: { rain: true } }));
trace.cold = await runScene('村内 昼 cold', S({ weather: 'cold', climate: { snow: true } }));
trace.drought = await runScene('村内 昼 干旱', S({ climate: { drought: true } }));
trace.night = await runScene('村内 夜 clear', S({ phase: '夜', window: { play: true, theme: 'spring-night', day: false, t: 0 } }));
trace.crisis = await runScene('村内 危机 rain', S({ settlement: 'crisis', weather: 'rain', climate: { rain: true }, window: { play: true, theme: 'crisis', day: true, t: 0 } }));
trace.farRain = await runScene('村外 prox=1 rain', S({ weather: 'rain', climate: { rain: true }, proximity: 1, window: { play: false, theme: 'menu', day: true, t: 0 } }));
trace.dead = await runScene('野外 prox=1 倒下', S({ dead: true, proximity: 1, window: { play: false, theme: 'death', day: true, t: 0 } }));
trace.corner = await runScene('镇角 (119,79) 忙', S({ proximity: E.proximity({ playerPos: [119, 79] }) }));
log('  对照：clear=1 层；rain/cold/干旱=2 层；night=1 层；crisis rain=3 层；倒下只留 crisis；镇角在镇内正常建层。');
log('');

// ───────────────────────── F. BGM 边界矩阵 ─────────────────────────
log('# F. BGM 边界（聚落矩形 120×80，不再用半径 70）');
const base = { t: 100, season: '春', phase: '昼', settlement: 'active', weather: 'clear', sites: BUSY, coop: {}, player: { dead: false }, loc: { p1: 'house1' }, locs: { house1: [60, 40] } };
const dist = (p) => Math.hypot(p[0] - 60, p[1] - 40);
const cases = [
  ['村中心', { ...base, playerPos: [60, 40] }],
  ['镇角 (119,79)', { ...base, playerPos: [119, 79] }],
  ['x=120 镇外', { ...base, playerPos: [120, 40] }],
  ['x=130 距核心70但镇外', { ...base, playerPos: [130, 40] }],
  ['村外 夜', { ...base, playerPos: [130, 40], phase: '夜' }],
  ['村外 晨', { ...base, playerPos: [130, 40], phase: '晨' }],
  ['村外 灭绝', { ...base, playerPos: [130, 40], settlement: 'extinct' }],
  ['村外 倒下', { ...base, playerPos: [130, 40], player: { dead: true } }],
  ['村内 夜', { ...base, playerPos: [60, 40], phase: '夜' }],
  ['村内 夜+危机', { ...base, playerPos: [60, 40], phase: '夜', settlement: 'crisis' }],
  ['村内 夜+恢复', { ...base, playerPos: [60, 40], phase: '夜', settlement: 'recovering' }],
  ['村内 恢复·昼·忙', { ...base, playerPos: [60, 40], settlement: 'recovering' }],
];
const windowRows = [];
for (const [label, sv] of cases) {
  const w = E.musicWindow(sv, { now: sv.t });
  const level = E.musicTarget(w, sv.settlement);
  const row = { label, dist: dist(sv.playerPos), ...w, level, inCamp: E.playerInCamp(sv) };
  windowRows.push(row);
  log(`  ${label.padEnd(20)} | 距核心 ${f(row.dist, 1)} | inCamp=${row.inCamp} | play=${row.play} | ${row.theme.padEnd(13)} | ${row.reason.padEnd(12)} | level=${f(level, 2)}`);
}
log('  菜单：musicTarget({theme:menu})=0.6，不读位置；app.js 有 ui.menu 守卫（A-34 钉住）。');
log('');

// ───────────────────────── G. SFX 峰值与总混音余量 ─────────────────────────
const sfxPeaks = sfxNames().map((name) => ({ name, peak: analyze(renderSfx(name)).peak }));
const maxSfx = sfxPeaks.reduce((a, b) => (b.peak > a.peak ? b : a), sfxPeaks[0]);
const maxMusicPeak = musicRows.reduce((a, b) => (b.peak > a.peak ? b : a), musicRows[0]);
const worstMusicLevel = Math.max(...musicRows.map((r) => r.bus * E.musicDuck('rain', r.bus)));
const maxBedPeak = materialRows.reduce((best, row) => {
  const amp = row.info.peak * E.bedGain(row.name) * MASTER;
  return amp > best.amp ? { name: row.name, amp } : best;
}, { name: null, amp: 0 });
const bgmAmp = dbToAmp(maxMusicPeak.peak) * worstMusicLevel * MASTER;
const bedAmp = maxBedPeak.amp;
const sfxAmp = maxSfx.peak * 0.8 * MASTER;
const sum = bgmAmp + bedAmp + sfxAmp;
log('# G. 峰值余量（最响 BGM 峰值 + 最响床峰值 + 最响单条 SFX@0.8，经 master 0.7）');
log(`  最响 SFX：${maxSfx.name} peak=${f(maxSfx.peak, 4)}（A-02 上限 0.62）→ ${f(sfxAmp, 4)}`);
log(`  最响 BGM：${maxMusicPeak.theme} peak=${f(maxMusicPeak.peak, 1)}dBFS · bus=${f(maxMusicPeak.bus, 2)} · duck 后有效=${f(worstMusicLevel, 3)} → ${f(bgmAmp, 4)}`);
log(`  最响床：${maxBedPeak.name} → ${f(bedAmp, 4)}`);
log(`  三者峰值相加=${f(sum, 4)}（${f(db(sum), 2)}dBFS）→ 余量 ${f(-db(sum), 2)}dB；${sum < 1 ? '不削顶' : '会削顶'}`);
log(`  注：总线还有 DynamicsCompressor(-16dB, knee24, ratio3, attack4ms, release0.22s)，总和越阈值时整体轻压；这里给的是压缩器之前的保守峰值和。`);
log('');

// ───────────────────────── 产出 ─────────────────────────
const summary = {
  generatedAt: new Date().toISOString(),
  gitHead: spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
  master: MASTER,
  musicDuck: E.MUSIC_DUCK_WEATHER,
  before: beforeAudit ? {
    bedTrace: beforeAudit.bedTrace,
    slotMaterials: beforeAudit.slotMaterials,
    ambRows: beforeAudit.ambRows,
    musicRows: beforeAudit.musicRows,
  } : null,
  after: {
    bedSlots: E.BED_SLOTS,
    ambienceLufs: E.AMBIENCE_LUFS,
    bedTargetLufs: E.BED_TARGET_LUFS,
    bedGain: E.BED_GAIN,
    materialRows,
    musicRows,
    trace,
    windowRows,
  },
  effective: {
    beds: materialRows.map((row) => ({ name: row.name, oldGain: oldGain(row.name), oldLufs: effBed(row, oldGain(row.name)),
      newGain: E.bedGain(row.name), newLufs: effBed(row, E.bedGain(row.name)) })),
    bgm: musicRows.map((row) => ({ theme: row.theme, bus: row.bus, noWeatherLufs: effMusic(row),
      rainLufs: effMusic(row, true), peak: row.peak })),
  },
  headroom: { maxSfx, maxMusicPeak, worstMusicLevel, maxBedPeak, bgmAmp, bedAmp, sfxAmp, sum, headroomDb: -db(sum) },
};
writeFileSync(join(OUT, 'measurements-after.json'), JSON.stringify(summary, null, 2));
writeFileSync(join(OUT, 'measure.log'), `${lines.join('\n')}\n`);
log(`已写出 ${join(OUT, 'measurements-after.json')} 与 measure.log`);
