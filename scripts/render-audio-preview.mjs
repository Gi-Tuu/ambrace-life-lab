// 离线渲染音频试听包：与浏览器用的是同一份合成代码，所以听到的就是游戏里会响的。
//
//   node scripts/render-audio-preview.mjs            # 输出到 docs/audio-preview/
//   node scripts/render-audio-preview.mjs <目录>      # 指定输出目录
//
// 每个文件都会打印 peak / rms / 时长 / 削顶样本数：静音和削顶在这一步就会被发现，不用靠耳朵兜底。
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { toWav, analyze, mixMono, silence } from '../web/audio-synth.mjs';
import { renderSfx, sfxNames, renderMusicBar, musicMeta, renderAmbience } from '../web/audio-data.mjs';

const OUT = resolve(process.argv[2] ?? 'docs/audio-preview');
mkdirSync(OUT, { recursive: true });

const SR = 44100;
const write = (name, stereo) => {
  const info = analyze(stereo);
  writeFileSync(join(OUT, name), toWav(stereo));
  console.log(`${name.padEnd(26)} ${String(info.seconds).padStart(6)}s  peak ${String(info.peak).padStart(5)}  rms ${String(info.rms).padStart(6)}  削顶 ${info.clippedSamples}  ≈${info.approxCentroidHz}Hz`);
  if (info.rms < 0.005) problems.push(`${name} 近乎静音`);
  if (info.clippedSamples > 200) problems.push(`${name} 削顶样本过多`);
};

const problems = [];
const toStereo = (mono) => {
  const out = new Float32Array(mono.length * 2);
  for (let i = 0; i < mono.length; i++) { out[i * 2] = mono[i]; out[i * 2 + 1] = mono[i]; }
  return out;
};

// 1) 音效巡游：按族顺序排一条，间隔 0.45 秒，名字写在控制台对应位置。
const names = sfxNames();
const tour = [];
const labels = [];
let cursor = 0;
for (const name of names) {
  const clip = renderSfx(name);
  if (!clip) continue;
  tour.push({ at: cursor, data: clip });
  labels.push(`${(cursor / SR).toFixed(2)}s ${name}`);
  cursor += clip.length / SR * SR + 0.45 * SR;
}
write('sfx-tour.wav', toStereo(mixMono(tour, cursor / SR)));
console.log('音效巡游对照（秒 → 音效）：\n  ' + labels.join('\n  '));

// 2) BGM：主题 × 昼夜 × 危机，各渲染整段循环。
for (const theme of ['warm', 'cool']) {
  for (const day of [true, false]) {
    const { bars, secondsPerBar } = musicMeta({ theme });
    const clips = [];
    for (let bar = 0; bar < bars; bar++) clips.push({ at: bar * secondsPerBar, data: renderMusicBar({ theme, day, bar }) });
    const total = Math.round(bars * secondsPerBar * SR) * 2;
    const stereo = new Float32Array(total);
    for (const { at, data } of clips) {
      const start = Math.round(at * SR) * 2;
      for (let i = 0; i + start < total && i < data.length; i++) stereo[start + i] += data[i];
    }
    write(`bgm-${theme}-${day ? 'day' : 'night'}.wav`, stereo);
  }
}
{
  const { bars, secondsPerBar } = musicMeta({ crisis: true });
  const stereo = new Float32Array(Math.round(bars * secondsPerBar * SR) * 2);
  for (let bar = 0; bar < bars; bar++) {
    const data = renderMusicBar({ crisis: true, bar });
    const start = Math.round(bar * secondsPerBar * SR) * 2;
    for (let i = 0; i + start < stereo.length && i < data.length; i++) stereo[start + i] += data[i];
  }
  write('bgm-crisis.wav', stereo);
}

// 3) 环境声循环。
for (const name of ['day', 'night', 'rain', 'wind', 'cold', 'crisis']) {
  const clip = renderAmbience(name);
  if (clip) write(`amb-${name}.wav`, clip);
}

console.log(problems.length ? `✖ 自检发现问题：\n  ${problems.join('\n  ')}` : '✔ 自检通过：无静音、无削顶');
process.exit(problems.length ? 1 : 0);
