// 浏览器侧音频接线：解锁、音量、音效触发、环境声与 BGM 调度。
//
// 表现层约定：只读世界差分与本地 UI 事件，不写世界、不消费 rng、不进世界 tick。
// 采样一律来自 audio-data.mjs 的纯函数渲染 ⇒ 与 scripts/render-audio-preview.mjs 出的 WAV 逐位一致。

import { renderSfx, renderAmbience, themeForSeason, SFX_BY_CODE, SFX_BY_KIND } from './audio-data.mjs';
import { musicTarget, musicStartFor, MUSIC_STINT_TICKS } from './audio-events.mjs';
import { MUSIC_TRACKS } from './music-tracks.mjs';

const STORE_KEY = 'ambrace.audio';
const SR = 44100;
const VOICE_LIMIT = 10;          // 同时发声上限：超了直接丢，保护移动端
const THROTTLE_MS = 55;          // 同名音效最小间隔，避免连点成机枪
const FADE_IN = 2.5;             // 音乐淡入秒数
const FADE_OUT = 3.5;            // 音乐淡出秒数：比淡入长，收尾不像被掐断

const state = {
  ctx: null, master: null, ready: false,
  volume: 0.7, muted: false,
  buffers: new Map(),            // 音效名 → AudioBuffer
  beds: new Map(),               // 环境声名 → {source, gain}
  music: { key: null, bar: 0, nextAt: 0, timer: 0, playing: false, want: false, src: null, tick: 0, fileTheme: null }, musicBus: null,
  tracks: new Map(), loading: new Map(),
  voices: 0, lastAt: new Map(), menu: false,
};

function loadPrefs() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (typeof saved.volume === 'number') state.volume = Math.min(1, Math.max(0, saved.volume));
    if (typeof saved.muted === 'boolean') state.muted = saved.muted;
  } catch { /* 偏好读不出来就用默认，不打断游戏 */ }
}

function savePrefs() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify({ volume: state.volume, muted: state.muted })); } catch { /* 无痕模式下写失败无所谓 */ }
}

function applyGain() {
  if (!state.master) return;
  const target = state.muted ? 0 : state.volume;
  state.master.gain.setTargetAtTime(target, state.ctx.currentTime, 0.05);
}

export function unlock() {
  if (state.ctx) { if (state.ctx.state === 'suspended') void state.ctx.resume(); return state.ready; }
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return false;
  const ctx = new Ctor({ sampleRate: SR });
  const master = ctx.createGain();
  const bus = ctx.createDynamicsCompressor();
  bus.threshold.value = -16; bus.knee.value = 24; bus.ratio.value = 3;
  bus.attack.value = 0.004; bus.release.value = 0.22;
  const musicBus = ctx.createGain();
  musicBus.gain.value = 0.0001;
  musicBus.connect(master);
  state.musicBus = musicBus;
  master.connect(bus); bus.connect(ctx.destination);
  state.ctx = ctx; state.master = master;
  applyGain();
  state.ready = true;
  loadTrack('menu');   // 开始屏放的就是它：先预取，免得解锁后的第一段是静音
  return true;
}

// 音效是单声道（renderSfx），音乐与环境声是交织立体声 ⇒ 两条缓冲路径，别混用。
function cache(key, data, channels) {
  if (!data) return null;
  const buf = state.ctx.createBuffer(channels, channels === 1 ? data.length : data.length / 2, SR);
  if (channels === 1) buf.copyToChannel(data, 0);
  else { buf.copyToChannel(interleave(data, 0), 0); buf.copyToChannel(interleave(data, 1), 1); }
  state.buffers.set(key, buf);
  return buf;
}

function monoBuffer(key, render) {
  return state.buffers.get(key) ?? cache(key, render(), 1);
}

function stereoBuffer(key, render) {
  return state.buffers.get(key) ?? cache(key, render(), 2);
}

// 交织立体声 → 单声道 Float32（AudioBuffer 要分声道）。
function interleave(stereo, channel) {
  const n = stereo.length / 2, out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = stereo[i * 2 + channel];
  return out;
}

function play(buf, { gain = 1, at = 0, loop = false } = {}) {
  if (!state.ctx || !buf) return null;
  const src = state.ctx.createBufferSource();
  src.buffer = buf; src.loop = loop;
  const g = state.ctx.createGain();
  g.gain.value = gain;
  src.connect(g); g.connect(state.master);
  src.start(Math.max(state.ctx.currentTime, state.ctx.currentTime + at));
  if (!loop) {
    state.voices++;
    src.onended = () => { state.voices--; };
  }
  return { src, gain: g };
}

export function sfx(name, { gain = 1 } = {}) {
  if (!state.ready || state.muted || !name) return;
  const now = performance.now();
  const last = state.lastAt.get(name) ?? -1e9;
  if (now - last < THROTTLE_MS) return;
  if (state.voices >= VOICE_LIMIT) return;
  state.lastAt.set(name, now);
  const buf = monoBuffer(`sfx:${name}`, () => renderSfx(name));
  if (buf) play(buf, { gain });
}

// 动作结果 → 音效：成功按动作族，失败统一一声"被拒"，个别码另有专属音。
export function result(body, res) {
  if (!res || !state.ready) return;
  const code = res.code ?? res.error;
  if (res.ok === false) { sfx(SFX_BY_CODE[code] ?? 'deny', { gain: 0.8 }); return; }
  const named = SFX_BY_CODE[code];
  if (named) { sfx(named); return; }
  const kind = SFX_BY_KIND[body?.kind];
  if (kind) sfx(kind);
}

export const click = () => sfx('click', { gain: 0.5 });

// ───────────────────────── 世界状态 → 声音 ─────────────────────────

// 聚落状态直接决定主题：危机/恢复/灭绝各有自己的曲子，不是同一首变音量。
function musicTheme({ season, settlement }) {
  if (settlement === 'extinct') return 'extinct';
  if (settlement === 'crisis') return 'crisis';
  if (settlement === 'recovering') return 'recovering';
  return themeForSeason(season);
}


// BGM 只放成品曲，没有合成器兜底（所有者 2026-11-19：「不要这种兜底，很破坏统一性」）。
// 素材还没解码好时，这一截保持安静，下一截再进；静音是可接受的降级，音色不统一不是。

// ───────────────────────── 成品曲音源（web/music/*.ogg） ─────────────────────────
// 每首只在第一次要用时拉取并解码（约 2MB / 首）：菜单页不该顺带下载四季。
function loadTrack(theme) {
  if (state.tracks.has(theme) || state.loading.has(theme)) return;
  const p = fetch(`/web/${MUSIC_TRACKS[theme].file}`)
    .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((b) => state.ctx.decodeAudioData(b))
    .then((buf) => { state.tracks.set(theme, buf); state.loading.delete(theme); })
    .catch(() => { state.loading.delete(theme); });   // 拉不到就静音、下截再试：不回落合成器、不刷屏
  state.loading.set(theme, p);
}

function stopFile() {
  const src = state.music.src;
  if (!src) return;
  state.music.src = null;
  src.onended = null;
  try { src.stop(); } catch { /* 已经放完 */ }
  src.disconnect();
}

// 从起播点放到曲终。淡入淡出全部由 musicBus 负责，所以这里一条包络都不写。
function playFile(theme, offset) {
  const buf = state.tracks.get(theme);
  if (!buf) return false;
  stopFile();
  const src = state.ctx.createBufferSource();
  src.buffer = buf;
  src.connect(state.musicBus ?? state.master);
  src.onended = () => {
    state.music.src = null;
    if (!state.music.playing || state.music.fileTheme !== theme) return;
    state.music.tick += MUSIC_STINT_TICKS;              // 窗口还没关但曲子放完了：换下一段起播点
    const next = musicStartFor(theme, state.music.tick);
    if (next !== null) playFile(theme, next);
  };
  src.start(state.ctx.currentTime + 0.12, Math.max(0, offset), Math.max(0, buf.duration - offset));
  state.music.src = src;
  state.music.fileTheme = theme;
  return true;
}

// tick 是世界刻：起播点序号由它算，所以同营地的两个观众听到同一段，录屏也能复现。
function startMusic(key, tick = 0) {
  const m = state.music;
  if (m.key === key && m.playing) return;
  const [theme] = key.split(':');
  stopMusic();
  m.key = key; m.tick = Math.max(0, Number(tick) || 0); m.playing = true;
  const start = musicStartFor(theme, m.tick);
  if (start === null) { m.playing = false; return; }   // 没有素材的槽位就静音，不合成
  if (!playFile(theme, start)) loadTrack(theme);       // 还没解码好：这一截静音，下一截再进
}

function stopMusic() {
  const m = state.music;
  m.playing = false;
  clearTimeout(m.timer);
  m.timer = 0;
  m.key = null;
  m.fileTheme = null;
  stopFile();
}

// 开始菜单用独立主题：进游戏前不该听到营地四季。
export function menu(on) {
  if (!state.ready) return;
  if (!on) { state.menu = false; return; }
  state.menu = true;
  startMusic('menu:day', 0);
  fadeMusic(musicTarget({ play: true, theme: 'menu' }, 'active'));
}

// 环境声床：最多三层（天气 / 昼夜 / 危机），换状态时 1.5 秒交叉淡入淡出。
function setBed(name, want, gain) {
  const current = state.beds.get(name);
  if (!want && current) {
    current.gain.gain.setTargetAtTime(0.0001, state.ctx.currentTime, 0.5);
    setTimeout(() => { try { current.src.stop(); } catch { /* 已停 */ } }, 1600);
    state.beds.delete(name);
    return;
  }
  if (want && !current) {
    const buf = stereoBuffer(`amb:${name}`, () => renderAmbience(name));
    const voice = play(buf, { gain: 0.0001, loop: true });
    if (!voice) return;
    voice.gain.gain.setTargetAtTime(gain, state.ctx.currentTime, 0.8);
    state.beds.set(name, voice);
    return;
  }
  if (want && current) current.gain.gain.setTargetAtTime(gain, state.ctx.currentTime, 0.8);
}

// 世界差分进来就调这里；调用方只在"状态真的变了"时才调，避免每刻重算。
export function scene({ season = '春', phase = '昼', weather = 'clear', settlement = 'active', crisisDays = 0, dead = false,
  window = null, proximity = 0 } = {}) {
  if (!state.ready || state.muted) return;
  const day = phase !== '夜';
  if (dead) {
    // 玩家倒下：换一首送别曲（2026-11-21 素材到位后，所有者改了"只留心跳"的旧口径）。
    startMusic('death', window?.t ?? 0);
    fadeMusic(musicTarget({ play: true, theme: 'death' }, settlement));
    setBed('crisis', true, 0.5);
    setBed('weather', false, 0);
    setBed('daynight', false, 0);
    return;
  }
  state.menu = false;
  // BGM 由 audio-events.mjs 的窗口规则决定：夜、村外、灭绝、闲日不播，播也有间歇。
  const win = window ?? { play: true, theme: musicTheme({ season, settlement }), day };
  setBed('weather', weather === 'rain' ? 'rain' : weather === 'cold' ? 'cold' : null, 0.5 * (1 - proximity * 0.5));
  setBed('daynight', day ? 'day' : 'night', (day ? 0.4 : 0.7) * (1 - proximity * 0.7));
  // 出村后风声接管；危机心跳只在村内听得见（远征时不叠加）。
  setBed('wind', proximity > 0.15 ? 'wind' : null, 0.25 + proximity * 0.55);
  setBed('crisis', (settlement === 'crisis' || settlement === 'recovering' || crisisDays > 0)
    && settlement !== 'extinct' && proximity < 0.5, 0.55);
  // 世界刻从窗口读数里带出来（musicWindow 已算过），所以轮转序号与 app.js 的传参无关。
  if (win.play) startMusic(`${win.theme}:${win.day ? 'day' : 'night'}`, win.t ?? 0);
  // 单一出口：窗口说停就淡到 0，不留"算对了但没接线"的余地。
  fadeMusic(musicTarget(win, settlement));
}

// 音乐淡入淡出：淡入 2.5 秒、淡出 3.5 秒，且淡出期间已排程的小节照常放完 ⇒ 听不到硬切。
function fadeMusic(level) {
  if (!state.musicBus) return;
  const now = state.ctx.currentTime;
  const bus = state.musicBus.gain;
  bus.cancelScheduledValues(now);
  bus.setValueAtTime(bus.value, now);
  if (level > 0) {
    state.music.want = true;
    bus.linearRampToValueAtTime(level, now + FADE_IN);
    return;
  }
  state.music.want = false;
  bus.linearRampToValueAtTime(0.0001, now + FADE_OUT);
  // 淡出结束后停排程，省 CPU；下次 play 窗口到来时重新起。
  clearTimeout(state.music.timer);
  state.music.timer = setTimeout(() => { if (!state.music.want) { state.music.playing = false; state.music.key = null; } }, FADE_OUT * 1000 + 400);
}

// 一次性世界事件音（出生/死亡/竣工/灾害…）：由 app.js 的世界差分触发，不在这里读世界。
export const cue = (id, opts) => sfx(id, opts);

export function setVolume(v) {
  state.volume = Math.min(1, Math.max(0, Number(v) || 0));
  applyGain(); savePrefs();
  if (state.volume > 0 && state.muted) { state.muted = false; applyGain(); savePrefs(); }
}

export function toggleMute() {
  state.muted = !state.muted;
  applyGain(); savePrefs();
  if (state.muted) { stopMusic(); ['weather', 'daynight', 'crisis'].forEach((b) => setBed(b, false, 0)); }
  return state.muted;
}

export const status = () => ({ ready: state.ready, volume: state.volume, muted: state.muted });

loadPrefs();
