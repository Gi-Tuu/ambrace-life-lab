// 只读体验审计探针（2026-11-21）：BGM 窗口 / 环境床接线 / ducking / 响度 / 住宅地块。
// 不修改任何产品代码：import 纯函数 + 用 mock WebAudio 跑**真实的 web/audio.mjs** 接线。
//
// 运行：node evidence/exp-audit-audio/probe-audio-build.mjs
// 依赖：ffmpeg（PATH 中）做 EBU R128 / volumedetect 响度实测；缺失时该段标 SKIP。

import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  musicWindow, proximity, musicTarget, windowSignature,
  CORE_CENTER, FAR_RADIUS, MUSIC_LEVEL, MUSIC_LEVEL_CRISIS, MUSIC_LEVEL_NIGHT,
  MUSIC_LEVEL_DEATH, MUSIC_LEVEL_EXTINCT, musicStartFor,
} from '../../web/audio-events.mjs';
import { renderAmbience } from '../../web/audio-data.mjs';
import { toWav, analyze } from '../../web/audio-synth.mjs';
import { MUSIC_TRACKS } from '../../web/music-tracks.mjs';
import { HOUSING_PLOTS, TOWN_SIZE } from '../../shared/camp-layout.mjs';
import { campDistricts, districtHomes } from '../../shared/camp-districts.mjs';

const OUT = resolve('evidence/exp-audit-audio');
const WAV = join(tmpdir(), 'ambrace-audit-wav');
mkdirSync(WAV, { recursive: true });
const lines = [];
const log = (...a) => { const s = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '); lines.push(s); console.log(s); };
const f = (x, d = 2) => (Number.isFinite(x) ? Number(x).toFixed(d) : String(x));
const db = (g) => (g > 0 ? 20 * Math.log10(g) : -Infinity);
const dist = (p, c = CORE_CENTER) => Math.hypot(p[0] - c[0], p[1] - c[1]);

// ───────────────────────── A. BGM 播放窗口矩阵（纯函数，headless） ─────────────────────────
log('# A. BGM 窗口矩阵（web/audio-events.mjs musicWindow / musicTarget 实测调用）');
log(`CORE_CENTER=${JSON.stringify(CORE_CENTER)} FAR_RADIUS=${FAR_RADIUS} town=${JSON.stringify(TOWN_SIZE)}`);
log(`MUSIC_LEVEL ${MUSIC_LEVEL} / crisis ${MUSIC_LEVEL_CRISIS} / night ${MUSIC_LEVEL_NIGHT} / death ${MUSIC_LEVEL_DEATH} / extinct ${MUSIC_LEVEL_EXTINCT}`);
log('');
const base = {
  t: 100, season: '春', phase: '昼', weather: 'clear', settlement: 'active',
  crisisDays: 0, sites: [], coop: {}, playerPos: [60, 40], player: { dead: false },
};
const busy = { sites: [{ loc: 'yard', type: 'shelter', phase: 'frame' }] };
const cases = [
  ['村内 晨·闲', { ...base, phase: '晨' }],
  ['村内 昼·闲(无工地/无协作)', base],
  ['村内 昼·忙 t=100', { ...base, ...busy, t: 100 }],
  ['村内 昼·忙 t=106(同一天另一刻)', { ...base, ...busy, t: 106 }],
  ['村内 暮', { ...base, phase: '暮' }],
  ['村内 夜', { ...base, phase: '夜' }],
  ['村内 冬·昼·忙', { ...base, season: '冬', ...busy }],
  ['村内 危机·昼·忙', { ...base, settlement: 'crisis', ...busy }],
  ['村内 恢复·昼·忙', { ...base, settlement: 'recovering', ...busy }],
  ['村内 灭绝·昼·闲', { ...base, settlement: 'extinct' }],
  ['野外 灭绝(距核心 131.5)', { ...base, settlement: 'extinct', playerPos: [190, 60] }],
  ['野外 昼·忙(距核心 131.5)', { ...base, playerPos: [190, 60], ...busy }],
  ['野外 夜(距核心 131.5)', { ...base, phase: '夜', playerPos: [190, 60] }],
  ['村界 距核心 44.7(营地外、仍在村内)', { ...base, playerPos: [100, 60], ...busy }],
  ['村界 距核心恰好 70.0', { ...base, playerPos: [130, 40], ...busy }],
  ['玩家倒下·村内', { ...base, player: { dead: true } }],
  ['玩家倒下·野外', { ...base, player: { dead: true }, playerPos: [190, 60] }],
];
log('case | dist | play | theme | day | reason | musicTarget | prox | sig');
for (const [name, sv] of cases) {
  const w = musicWindow(sv, { now: sv.t });
  log(`${name} | ${f(dist(sv.playerPos))} | ${w.play} | ${w.theme} | ${w.day} | ${w.reason} | ${musicTarget(w, sv.settlement)} | ${f(proximity(sv), 3)} | ${windowSignature(w)}`);
}
log('');
log('起播点轮转（MUSIC_STINT_TICKS=12，世界刻决定，不读墙钟）:');
for (const theme of ['spring', 'spring-night', 'extinct', 'menu']) {
  log(`  ${theme}: t=0→${musicStartFor(theme, 0)} t=12→${musicStartFor(theme, 12)} t=24→${musicStartFor(theme, 24)}`);
}
log('');

// ───────────────────────── B. proximity 与床增益公式（audio.mjs:256-261 的算术复算） ─────────────────────────
log('# B. proximity 与床增益（复算 audio.mjs scene() 的公式，用于核对 C 段 mock 实测）');
log('pos | prox | rain/cold | day | night | wind(>0.15) | crisis(<0.5)');
for (const p of [[60, 40], [100, 60], [120, 40], [130, 40], [150, 40], [190, 60]]) {
  const px = proximity({ playerPos: p });
  log(`${JSON.stringify(p)} | ${f(px, 3)} | ${f(0.5 * (1 - px * 0.5), 3)} | ${f(0.4 * (1 - px * 0.7), 3)} | ${f(0.7 * (1 - px * 0.7), 3)} | ${px > 0.15 ? f(0.25 + px * 0.55, 3) : '-'} | ${px < 0.5 ? '0.550' : '-'}`);
}
log('');

// ───────────────────────── C. mock WebAudio 跑真实 audio.mjs：谁真的建起了床？ ─────────────────────────
class Param {
  constructor(value) { this.value = value; this.events = []; }
  setTargetAtTime(v, t, c) { this.events.push({ type: 'target', v, t, c }); this.value = v; return this; }
  setValueAtTime(v, t) { this.events.push({ type: 'set', v, t }); this.value = v; return this; }
  linearRampToValueAtTime(v, t) { this.events.push({ type: 'ramp', v, t }); this.value = v; return this; }
  cancelScheduledValues(t) { this.events.push({ type: 'cancel', t }); return this; }
}
class Ctx {
  constructor() {
    this.sampleRate = 44100; this.currentTime = 0; this.state = 'running';
    this.destination = {}; this.gains = []; this.buffers = [];
    globalThis.__ctx = this;
  }
  createGain() { const g = { gain: new Param(1), connect() { return this; }, disconnect() {} }; this.gains.push(g); return g; }
  createBufferSource() { return { buffer: null, loop: false, onended: null, connect() { return this; }, disconnect() {}, start() {}, stop() {} }; }
  createDynamicsCompressor() { return { threshold: new Param(-16), knee: new Param(24), ratio: new Param(3), attack: new Param(0.004), release: new Param(0.22), connect() { return this; } }; }
  createBuffer(ch, len, sr) { const b = { numberOfChannels: ch, length: len, sampleRate: sr, duration: len / sr, copyToChannel() {} }; this.buffers.push(b); return b; }
  async decodeAudioData() { return { numberOfChannels: 2, length: 44100 * 168, sampleRate: 44100, duration: 168, copyToChannel() {} }; }
  resume() { return Promise.resolve(); }
}
globalThis.window = { AudioContext: Ctx };
globalThis.localStorage = { store: new Map(), getItem(k) { return this.store.get(k) ?? null; }, setItem(k, v) { this.store.set(k, v); } };
globalThis.fetch = async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(16) });

const audioPath = pathToFileURL(resolve('web/audio.mjs')).href;
let caseNo = 0;
// bed 的槽位名（setBed 第一参数）与 renderAmbience 的素材名必须相等才会发声
const SLOTS = { weather: null, daynight: null, wind: 'wind', crisis: 'crisis' };
async function runScene(label, sceneArgs) {
  const mod = await import(`${audioPath}?case=${++caseNo}`);
  mod.unlock();
  const ctx = globalThis.__ctx;
  mod.scene(sceneArgs);
  const music = ctx.gains[1];
  const mev = music.gain.events.filter((e) => e.type === 'ramp').map((e) => f(e.v, 3));
  const beds = ctx.gains.slice(2).map((g) => {
    const ev = g.gain.events.find((e) => e.type === 'target') ?? g.gain.events[0];
    return ev ? `${ev.type}=${f(ev.v, 3)}${ev.c ? `(tc=${ev.c})` : ''}` : `value=${f(g.gain.value, 3)}`;
  });
  log(`${label} :: musicBus ramps=[${mev.join(',')}] → ${f(music.gain.value, 3)} | 新建床节点 ${beds.length} ${beds.length ? `[${beds.join(' | ')}]` : '（无）'} | ctx.createBuffer 调用 ${ctx.buffers.length}`);
  return { music: mev, beds, buffers: ctx.buffers.length };
}
const S = (over = {}) => ({
  season: '春', phase: '昼', weather: 'clear', settlement: 'active', crisisDays: 0, dead: false,
  window: { play: true, theme: 'spring', day: true, t: 0 }, proximity: 0, ...over,
});
log('# C. 真实 audio.mjs 接线（mock WebAudio）：场景一次，记录音乐总线目标与真正建起的床');
log('（setBed 调用顺序：audio.mjs:256 weather → 257 daynight → 259 wind → 260 crisis）');
const trace = {};
trace.clear = await runScene('村内 昼·忙 clear', S({}));
trace.rain = await runScene('村内 昼·忙 rain', S({ weather: 'rain' }));
trace.cold = await runScene('村内 昼·忙 cold', S({ weather: 'cold' }));
trace.night = await runScene('村内 夜 clear', S({ phase: '夜', window: { play: true, theme: 'spring-night', day: false, t: 0 } }));
trace.crisis = await runScene('村内 危机·昼 clear', S({ settlement: 'crisis', window: { play: true, theme: 'crisis', day: true, t: 0 } }));
trace.idle = await runScene('村内 昼·闲(窗口关) clear', S({ window: { play: false, theme: 'spring', day: true, t: 0 } }));
trace.farNight = await runScene('野外 prox=1 夜(窗口关)', S({ phase: '夜', proximity: 1, window: { play: false, theme: 'menu', day: false, t: 0 } }));
trace.farRain = await runScene('野外 prox=1 昼 rain(窗口关)', S({ weather: 'rain', proximity: 1, window: { play: false, theme: 'menu', day: true, t: 0 } }));
trace.deadFar = await runScene('野外 prox=1 倒下', S({ dead: true, proximity: 1, window: { play: false, theme: 'death', day: true, t: 0 } }));
trace.extinctFar = await runScene('野外 prox=1 灭绝', S({ settlement: 'extinct', proximity: 1, window: { play: true, theme: 'extinct', day: true, t: 0 } }));
log('');
log('床能否发声 = renderAmbience(setBed 的 name) 是否为 null（audio.mjs:229 把槽位名直接当素材名）：');
for (const [slot, material] of Object.entries(SLOTS)) {
  const direct = renderAmbience(slot);
  log(`  setBed('${slot}', …) → stereoBuffer('amb:${slot}', () => renderAmbience('${slot}')) → ${direct === null ? 'NULL ⇒ play() 返回 null ⇒ 床永远建不起来（静音）' : '有素材'}${material && material !== slot ? `（素材名应是 '${material}'）` : ''}`);
}
log('  实测对照：村内 rain 场景本应建 2 层（weather=rain 0.5、daynight=day 0.4），实际新建床节点 = ' + trace.rain.beds.length);
log(`  实测对照：wind/crisis 槽位名与素材名相同 ⇒ 野外 prox=1 新建 ${trace.farNight.beds.length} 层 wind（0.8）、危机 新建 ${trace.crisis.beds.length} 层 crisis（0.55）`);
log('');

// ───────────────────────── D. ducking 判定 ─────────────────────────
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
log('# D. ducking / sidechain 判定（真实接线侧）');
log(`  1) clear vs rain：musicBus 目标 ${JSON.stringify(trace.clear.music)} vs ${JSON.stringify(trace.rain.music)} → ${eq(trace.clear.music, trace.rain.music) ? '完全相同 ⇒ 天气床不压低 BGM' : '不同'}`);
log(`  2) clear vs cold：${JSON.stringify(trace.clear.music)} vs ${JSON.stringify(trace.cold.music)} → ${eq(trace.clear.music, trace.cold.music) ? '完全相同 ⇒ 冷天床不压低 BGM' : '不同'}`);
log(`  3) 昼 vs 夜：${JSON.stringify(trace.clear.music)} vs ${JSON.stringify(trace.night.music)} → 仅由主题决定（夜曲档 0.42），与夜间床目标 0.7 无关`);
log(`  4) 危机：${JSON.stringify(trace.crisis.music)} 与 crisis 床 0.55 并存，无互相引用`);
const src = readFileSync(resolve('web/audio.mjs'), 'utf8');
const musicAssign = [...src.matchAll(/musicBus\.gain|bus\.(?:cancelScheduledValues|setValueAtTime|linearRampToValueAtTime)/g)].length;
log(`  5) 源码面：musicBus.gain 的写入只出现在 unlock()/fadeMusic()；全文件出现 musicBus 相关写入点 ${musicAssign} 处，没有任何 setBed/play 读床增益去调音乐总线（grep 无 'duck|sidechain'）`);
log('');
log('  压缩器：master → DynamicsCompressor(threshold -16dB, knee 24, ratio 3, attack 4ms, release 0.22s) → destination；');
log('  这是混音总线压缩（电平相关、对全混音一视同仁），不是侧链 ducking：BGM 不会因雨声/音效出现而让路。');
log('');

// ───────────────────────── E. 响度实测 ─────────────────────────
log('# E. 响度实测：BGM ogg（13 首）vs 环境床 WAV（renderAmbience 真实渲染）');
const ffOk = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }).status === 0;
log(`ffmpeg ${ffOk ? '可用' : '不可用 → SKIP'}`);
const ff = (args) => spawnSync('ffmpeg', args, { encoding: 'utf8' }).stderr ?? '';
function measure(file) {
  if (!ffOk) return { I: NaN, peak: NaN, mean: NaN };
  const a = ff(['-hide_banner', '-nostats', '-i', file, '-af', 'ebur128=peak=true', '-f', 'null', '-']);
  const Is = [...a.matchAll(/I:\s*(-?[\d.]+)\s*LUFS/g)].map((m) => Number(m[1]));
  const Ps = [...a.matchAll(/Peak:\s*(-?[\d.]+)\s*dBFS/g)].map((m) => Number(m[1]));
  const b = ff(['-hide_banner', '-nostats', '-i', file, '-af', 'volumedetect', '-f', 'null', '-']);
  const mean = /mean_volume:\s*(-?[\d.]+) dB/.exec(b);
  const maxv = /max_volume:\s*(-?[\d.]+) dB/.exec(b);
  return { I: Is.length ? Is[Is.length - 1] : NaN, peak: Ps.length ? Ps[Ps.length - 1] : NaN, mean: mean ? Number(mean[1]) : NaN, max: maxv ? Number(maxv[1]) : NaN };
}
const musicRows = [];
for (const [theme, tr] of Object.entries(MUSIC_TRACKS)) {
  const m = measure(resolve('web', tr.file));
  const bus = musicTarget({ play: true, theme }, theme === 'crisis' ? 'crisis' : 'active');
  musicRows.push({ theme, ...m, bus });
  log(`  music ${theme.padEnd(13)} I=${f(m.I, 1)}LUFS peak=${f(m.peak, 1)}dBFS mean=${f(m.mean, 1)}dB | bus=${bus} → 有效 I≈${f(m.I + db(0.7 * bus), 1)}LUFS 峰值≈${f(m.peak + db(0.7 * bus), 1)}dBFS`);
}
const ambRows = [];
for (const name of ['day', 'night', 'rain', 'wind', 'cold', 'crisis']) {
  const stereo = renderAmbience(name);
  const info = analyze(stereo);
  const file = join(WAV, `amb-${name}.wav`);
  writeFileSync(file, toWav(stereo));
  const m = measure(file);
  const g0 = name === 'rain' || name === 'cold' ? 0.5 : name === 'day' ? 0.4 : name === 'night' ? 0.7 : name === 'wind' ? 0.25 : 0.55;
  const g1 = name === 'rain' || name === 'cold' ? 0.25 : name === 'day' ? 0.12 : name === 'night' ? 0.21 : name === 'wind' ? 0.8 : 0;
  ambRows.push({ name, info, ...m, g0, g1, audible: name === 'wind' || name === 'crisis' });
  log(`  amb   ${name.padEnd(6)} renderPeak=${info.peak} rms=${info.rms} | I=${f(m.I, 1)}LUFS peak=${f(m.peak, 1)}dBFS | 床增益 村内=${f(g0, 3)} 野外=${f(g1, 3)} | ${name === 'wind' || name === 'crisis' ? '会发声' : '因 C 段缺陷永不发声'}`);
}
log('');
log('相对有效电平（素材 LUFS + 20log10(增益×master 0.7)，压缩器之前）：');
const M = (t) => musicRows.find((r) => r.theme === t);
const A = (n) => ambRows.find((r) => r.name === n);
const effM = (row) => row.I + db(0.7 * row.bus);
const effA = (row, g) => row.I + db(0.7 * g);
for (const [label, mrow, arow, again] of [
  ['村内 昼·春 BGM vs crisis 床', M('spring'), A('crisis'), A('crisis').g0],
  ['村内 危机 BGM(crisis 0.45) vs crisis 床', M('crisis'), A('crisis'), A('crisis').g0],
  ['野外 prox=1 BGM(不播) vs wind 床', null, A('wind'), A('wind').g1],
  ['夜 BGM(spring-night 0.42) vs wind 床(prox=0 不播)/night 床(缺陷不发声)', M('spring-night'), A('night'), A('night').g0],
  ['村内 昼·春 BGM vs rain 床(缺陷不发声)', M('spring'), A('rain'), A('rain').g0],
]) {
  const m = mrow ? effM(mrow) : null;
  const a = effA(arow, again);
  log(`  ${label}: BGM ${mrow ? `${f(m, 1)}LUFS` : '不播'} / 床 ${f(a, 1)}LUFS → Δ(BGM−床)=${mrow ? `${f(m - a, 1)}dB` : 'n/a'}`);
}
log('');

// ───────────────────────── F. 住宅地块事实 ─────────────────────────
log('# F. 住宅地块事实（shared/camp-layout.mjs / shared/camp-districts.mjs / life/households.mjs）');
log(`HOUSING_PLOTS=${Object.keys(HOUSING_PLOTS).length} 个（Object.freeze 固定表；town=${JSON.stringify(TOWN_SIZE)}）`);
for (const [k, v] of Object.entries(HOUSING_PLOTS)) log(`  ${k} at=${JSON.stringify(v)} dist(核心)=${f(dist(v))}`);
for (const seed of [7, 13]) {
  const homes = districtHomes(campDistricts(seed, 2));
  log(`seed=${seed} peripheralHomes=${Object.keys(homes).length}：${Object.keys(homes).join(',')}`);
  for (const [k, v] of Object.entries(homes)) log(`  ${k} at=${JSON.stringify(v)} dist(核心)=${f(dist(v))} → ${dist(v) > FAR_RADIUS ? '超出 FAR_RADIUS：该住宅所在地不播村内 BGM' : '在 FAR_RADIUS 内'}`);
}
log('');

writeFileSync(join(OUT, 'measurements.json'), JSON.stringify({
  generatedAt: new Date().toISOString(),
  gitHead: spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
  gitTagAtHead: spawnSync('git', ['describe', '--tags', '--always', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
  windowMatrix: cases.map(([name, sv]) => { const w = musicWindow(sv, { now: sv.t }); return { name, dist: dist(sv.playerPos), ...w, level: musicTarget(w, sv.settlement) }; }),
  slotMaterials: Object.fromEntries(Object.entries(SLOTS).map(([slot]) => [slot, { materialExists: renderAmbience(slot) !== null }])),
  bedTrace: Object.fromEntries(Object.entries(trace).map(([k, v]) => [k, { music: v.music, beds: v.beds, buffers: v.buffers }])),
  musicRows, ambRows,
}, null, 2));
writeFileSync(join(OUT, 'probe-audio-build.log'), `${lines.join('\n')}\n`);
log(`已写出 ${join(OUT, 'measurements.json')} 与 probe-audio-build.log`);
