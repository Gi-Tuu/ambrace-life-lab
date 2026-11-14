// 浏览器侧音频接线：解锁、音量、音效触发、环境声与 BGM 调度。
//
// 表现层约定：只读世界差分与本地 UI 事件，不写世界、不消费 rng、不进世界 tick。
// 采样一律来自 audio-data.mjs 的纯函数渲染 ⇒ 与 scripts/render-audio-preview.mjs 出的 WAV 逐位一致。

import { renderSfx, renderMusicBar, musicMeta, renderAmbience, SFX_BY_CODE, SFX_BY_KIND } from './audio-data.mjs';

const STORE_KEY = 'ambrace.audio';
const SR = 44100;
const VOICE_LIMIT = 10;          // 同时发声上限：超了直接丢，保护移动端
const THROTTLE_MS = 55;          // 同名音效最小间隔，避免连点成机枪
const LOOKAHEAD_S = 0.6;         // BGM 提前排程窗口

const state = {
  ctx: null, master: null, ready: false,
  volume: 0.7, muted: false,
  buffers: new Map(),            // 音效名 → AudioBuffer
  beds: new Map(),               // 环境声名 → {source, gain}
  music: { key: null, bars: [], nextBar: 0, source: null, timer: 0, playing: false },
  voices: 0, lastAt: new Map(),
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
  master.connect(bus); bus.connect(ctx.destination);
  state.ctx = ctx; state.master = master;
  applyGain();
  state.ready = true;
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

const seasonTheme = (season) => (season === '春' || season === '夏' ? 'warm' : 'cool');

function sceneKey({ season, day, crisis }) {
  return `${crisis ? 'crisis' : `${seasonTheme(season)}:${day ? 'day' : 'night'}`}`;
}

// 一小节的缓冲：变体切换时才渲染，单节约 15–25ms，且只在换季节/昼夜时发生。
function barBuffer(key, bar) {
  const crisis = key === 'crisis';
  const [theme = 'warm', dayFlag = 'day'] = crisis ? [] : key.split(':');
  return stereoBuffer(`music:${key}:${bar}`, () => renderMusicBar({
    theme: crisis ? 'warm' : theme, day: !crisis && dayFlag === 'day', crisis, bar,
  }));
}

function scheduleMusic() {
  const m = state.music;
  if (!m.playing || !state.ctx) return;
  const meta = musicMeta({ theme: m.key === 'crisis' ? 'warm' : m.key.split(':')[0], crisis: m.key === 'crisis' });
  const now = state.ctx.currentTime;
  while (m.nextAt < now + LOOKAHEAD_S) {
    const buf = barBuffer(m.key, m.bar % m.bars);
    m.bar++;
    if (buf) {
      const src = state.ctx.createBufferSource();
      src.buffer = buf;
      const g = state.ctx.createGain();
      g.gain.setValueAtTime(0.0001, m.nextAt);
      g.gain.exponentialRampToValueAtTime(0.9, m.nextAt + 0.06);
      src.connect(g); g.connect(state.master);
      src.start(m.nextAt);
      src.onended = () => src.disconnect();
    }
    m.nextAt += meta.secondsPerBar;
  }
  m.timer = setTimeout(scheduleMusic, 220);
}

function startMusic(key) {
  const m = state.music;
  if (m.key === key && m.playing) return;
  const meta = musicMeta({ theme: key === 'crisis' ? 'warm' : key.split(':')[0], crisis: key === 'crisis' });
  m.key = key; m.bars = meta.bars; m.bar = 0;
  m.nextAt = state.ctx.currentTime + 0.15;
  m.playing = true;
  clearTimeout(m.timer);
  scheduleMusic();
}

function stopMusic() {
  state.music.playing = false;
  clearTimeout(state.music.timer);
  state.music.key = null;
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
export function scene({ season = '春', phase = 'day', weather = 'clear', settlement = 'active', crisisDays = 0, dead = false } = {}) {
  if (!state.ready || state.muted) return;
  const crisis = settlement === 'crisis' || settlement === 'extinct' || crisisDays > 0 || dead;
  if (dead) {
    stopMusic();
    setBed('crisis', true, 0.5);
    setBed('weather', false, 0);
    setBed('daynight', false, 0);
    return;
  }
  startMusic(sceneKey({ season, day: phase === 'day', crisis }));
  const weatherBed = weather === 'rain' ? 'rain' : weather === 'cold' ? 'cold' : weather === 'storm' ? 'wind' : null;
  setBed('weather', weatherBed, weather === 'storm' ? 0.9 : 0.6);
  setBed('daynight', phase === 'night' ? 'night' : 'day', phase === 'night' ? 0.7 : 0.4);
  setBed('crisis', crisis && settlement !== 'extinct', 0.55);
}

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
