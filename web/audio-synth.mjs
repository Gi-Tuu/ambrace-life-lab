// 音频合成内核（纯函数，零依赖）。
//
// 为什么写成纯 JS 而不是直接用 Web Audio 节点：同一份实现要能在 Node 里离线渲染成 WAV，
// 让所有者不用上线就能试听；浏览器侧只负责把渲染好的采样塞进 AudioBuffer 播放。
// 因此这里所有噪声都走带种子的确定性序列 ⇒ 浏览器与离线渲染逐位一致。
// 本模块不读世界状态、不消费 life/rng、不写任何游戏数据。

export const SR = 44100;

// 确定性噪声源：xorshift32，独立于引擎 rng（音频不参与世界复现）。
export function noiseSeed(seed = 7) {
  let a = (seed >>> 0) || 1;
  return () => {
    a ^= a << 13; a >>>= 0; a ^= a >>> 17; a ^= a << 5; a >>>= 0;
    return a / 4294967296 * 2 - 1;
  };
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const midiHz = (m) => 440 * 2 ** ((m - 69) / 12);
const env = (i, n, attack, release) => {
  const a = Math.max(1, Math.round(attack * SR));
  const r = Math.max(1, Math.round(release * SR));
  const t = i < a ? i / a : i > n - r ? (n - i) / r : 1;
  return t < 0 ? 0 : t;
};

// 二阶双二阶（RBJ 系数），低通/高通/带通。
export function biquad(input, { type = 'lowpass', hz, q = 0.7071 }) {
  const out = new Float32Array(input.length);
  const w = 2 * Math.PI * clamp(hz, 20, SR / 2 - 1) / SR, cw = Math.cos(w), sw = Math.sin(w);
  const alpha = sw / (2 * q);
  let b0, b1, b2, a0, a1, a2;
  if (type === 'highpass') {
    b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
  } else if (type === 'bandpass') {
    b0 = alpha; b1 = 0; b2 = -alpha; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
  } else {
    b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
  }
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < input.length; i++) {
    const x = input[i];
    const y = (b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    out[i] = y; x2 = x1; x1 = x; y2 = y1; y1 = y;
  }
  return out;
}

// 4 阶低通（级联），斜率更柔，避免单级的"电子味"。
const lowpass4 = (input, hz, q = 0.9) =>
  [1, 2, 3, 4].reduce((x) => biquad(x, { hz, q }), input);

export function osc({ freq = 220, dur = 0.2, type = 'sine', gain = 0.3, attack = 0.004,
  release = 0.05, glideTo = null, vibHz = 0, vibDepth = 0, detune = 0, seed = 7 }) {
  const n = Math.max(1, Math.round(dur * SR));
  const out = new Float32Array(n);
  const rand = noiseSeed(seed);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR, k = i / n;
    const f = glideTo ? freq * (1 + (glideTo / freq - 1) * k) : freq;
    const vibr = vibHz ? 1 + Math.sin(2 * Math.PI * vibHz * t) * vibDepth : 1;
    phase += 2 * Math.PI * f * vibr / SR;
    const p = phase % (2 * Math.PI);
    let s;
    if (type === 'square') s = p < Math.PI ? 1 : -1;
    else if (type === 'saw') s = p / Math.PI - 1;
    else if (type === 'pulse') s = p < Math.PI * 0.35 ? 1 : -1;
    else if (type === 'noise') s = rand();
    else s = Math.sin(p);
    const e = env(i, n, attack, release) * (type === 'noise' ? 1 : Math.exp(-1.2 * k));
    out[i] = s * e * gain * (1 + detune * 0.001);
  }
  return out;
}

export function noise({ dur = 0.15, gain = 0.3, lp = 8000, hp = 0, decay = 6, seed = 11 }) {
  const n = Math.max(1, Math.round(dur * SR));
  const out = new Float32Array(n);
  const rand = noiseSeed(seed);
  for (let i = 0; i < n; i++) out[i] = rand() * Math.exp(-decay * i / n) * gain;
  let x = lowpass4(out, lp);
  if (hp) x = biquad(x, { type: 'highpass', hz: hp });
  return x;
}

// Karplus-Strong 拨弦：木质感比纯振荡器自然，BGM 的琶音与"叮"用它。
export function pluck({ freq = 330, dur = 0.6, gain = 0.3, decay = 0.996, bright = 0.5, seed = 5 }) {
  const n = Math.max(1, Math.round(dur * SR));
  const out = new Float32Array(n);
  const period = Math.max(2, Math.round(SR / freq));
  const rand = noiseSeed(seed);
  const buffer = new Float32Array(period);
  for (let i = 0; i < period; i++) buffer[i] = rand();
  let idx = 0;
  for (let i = 0; i < n; i++) {
    const cur = buffer[idx], next = buffer[(idx + 1) % period];
    const v = (bright * cur + (1 - bright) * next) * decay;
    buffer[idx] = v;
    out[i] = v * gain * env(i, n, 0.002, 0.08);
    idx = (idx + 1) % period;
  }
  return out;
}

// FM 铃/金属：工具敲击与提示音。
export function fm({ freq = 600, dur = 0.4, gain = 0.25, ratio = 3.51, index = 6, decay = 5, release = 0.05 }) {
  const n = Math.max(1, Math.round(dur * SR));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const mod = Math.sin(2 * Math.PI * freq * ratio * t) * index * Math.exp(-decay * t / dur * 3);
    out[i] = Math.sin(2 * Math.PI * freq * t + mod) * Math.exp(-decay * t / dur * 2) * gain *
      env(i, n, 0.002, release);
  }
  return out;
}

export const silence = (dur) => new Float32Array(Math.max(0, Math.round(dur * SR)));

// 单声道叠加：音效配方全部先按 mono 组合，最后一步才转立体声，避免"立体声再当单声道"的变速伪影。
export function mixMono(clips, total = 0) {
  const end = clips.reduce((m, c) => Math.max(m, c.at + c.data.length), Math.round((total || 0) * SR));
  const out = new Float32Array(Math.max(1, end));
  for (const { at, data, gain = 1 } of clips) {
    const start = Math.round(at * SR);
    for (let i = 0; i < data.length; i++) {
      const o = start + i;
      if (o >= out.length) break;
      out[o] += data[i] * gain;
    }
  }
  return out;
}

// 叠加：clips = [{ at, data, gain, pan }]，pan -1 左 / +1 右；返回交织立体声。
export function mix(clips, total = 0) {
  const end = clips.reduce((m, c) => Math.max(m, c.at + c.data.length), Math.round((total || 0) * SR));
  const out = new Float32Array(Math.max(2, end) * 2);
  for (const { at, data, gain = 1, pan = 0 } of clips) {
    const gl = Math.cos((pan + 1) * Math.PI / 4), gr = Math.sin((pan + 1) * Math.PI / 4);
    const start = Math.round(at * SR);
    for (let i = 0; i < data.length; i++) {
      const o = (start + i) * 2;
      if (o + 1 >= out.length) break;
      out[o] += data[i] * gl * gain;
      out[o + 1] += data[i] * gr * gain;
    }
  }
  return out;
}

export const concat = (list) => {
  const n = list.reduce((s, x) => s + x.length, 0);
  const out = new Float32Array(n);
  let o = 0;
  for (const x of list) { out.set(x, o); o += x.length; }
  return out;
};

// 简易混响：4 条 comb + 预低通。参数以秒计，成本 O(n·taps)。
export function reverb(input, { time = 1.6, mix: amount = 0.22, seed = 3 } = {}) {
  const out = new Float32Array(input.length);
  const rand = noiseSeed(seed);
  const times = [0.0297, 0.0411, 0.0437, 0.0563].map((t) => t * (1 + time / 2));
  const feedback = times.map((t) => Math.pow(0.79, 1 / (t * SR)) * Math.min(0.97, time / 2));
  const buffers = times.map((t) => new Float32Array(Math.max(1, Math.round(t * SR))));
  const idx = times.map(() => 0);
  for (let i = 0; i < input.length; i++) {
    let sum = 0;
    for (let c = 0; c < times.length; c++) {
      const buf = buffers[c], k = idx[c];
      sum += buf[k];
      buf[k] = input[i] + buf[k] * feedback[c];
      idx[c] = (k + 1) % buf.length;
    }
    out[i] = input[i] * (1 - amount) + (sum / times.length) * amount * (1 + rand() * 0.02);
  }
  return lowpass4(out, 5200);
}

export function normalize(input, target = 0.85) {
  let peak = 0;
  for (let i = 0; i < input.length; i++) peak = Math.max(peak, Math.abs(input[i]));
  return peak > 1e-6 ? input.map((v) => v / peak * target) : input;
}

// 软限幅：比硬削波耐听，多轨叠加后用它兜底。
export function softClip(input, drive = 1.2) {
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) out[i] = Math.tanh(input[i] * drive) * 0.92;
  return out;
}

export const gainOf = (input, g) => input.map((v) => v * g);

// 16-bit PCM WAV（交织立体声），离线试听与视频配乐直接用。
export function toWav(interleaved, { sr = SR, channels = 2 } = {}) {
  const frames = Math.floor(interleaved.length / channels);
  const bytes = frames * channels * 2;
  const buf = Buffer.alloc(44 + bytes);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + bytes, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22); buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * channels * 2, 28); buf.writeUInt16LE(channels * 2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(bytes, 40);
  for (let i = 0; i < bytes / 2; i++) {
    const v = clamp(interleaved[i], -1, 1);
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return buf;
}

// 自检读数：试听之外，用数字证明"不是静音、也没削顶"。
export function analyze(interleaved) {
  let peak = 0, sum = 0, clipped = 0;
  for (let i = 0; i < interleaved.length; i++) {
    const a = Math.abs(interleaved[i]);
    peak = Math.max(peak, a); sum += a * a; if (a >= 0.999) clipped++;
  }
  const seconds = interleaved.length / 2 / SR;
  let crossings = 0;
  for (let i = 2; i < interleaved.length; i += 2) if (interleaved[i - 2] * interleaved[i] < 0) crossings++;
  return {
    seconds: Number(seconds.toFixed(2)),
    peak: Number(peak.toFixed(3)),
    rms: Number(Math.sqrt(sum / Math.max(1, interleaved.length)).toFixed(4)),
    clippedSamples: clipped,
    approxCentroidHz: Math.round(crossings / seconds),
  };
}
