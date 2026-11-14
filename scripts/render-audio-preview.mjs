// 离线渲染音频试听包：与浏览器用的是同一份合成代码，所以听到的就是游戏里会响的。
//
//   node scripts/render-audio-preview.mjs            # 输出到 docs/audio-preview/
//   node scripts/render-audio-preview.mjs <目录>      # 指定输出目录
//
// 每个文件都会打印 peak / rms / 时长 / 削顶样本数：静音和削顶在这一步就会被发现，不用靠耳朵兜底。
// 清单（web/audio-inventory.mjs）是唯一的分类依据 ⇒ 统计数字与试听包不会和实现漂移。
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { toWav, analyze, mixMono } from '../web/audio-synth.mjs';
import { renderSfx, renderMusicBar, musicMeta, renderAmbience, themeForSeason } from '../web/audio-data.mjs';
import { SOUND_INVENTORY } from '../web/audio-inventory.mjs';

const OUT = resolve(process.argv[2] ?? 'docs/audio-preview');
mkdirSync(OUT, { recursive: true });

const SR = 44100;
const problems = [];
const toStereo = (mono) => {
  const out = new Float32Array(mono.length * 2);
  for (let i = 0; i < mono.length; i++) { out[i * 2] = mono[i]; out[i * 2 + 1] = mono[i]; }
  return out;
};

function write(name, stereo) {
  const info = analyze(stereo);
  writeFileSync(join(OUT, name), toWav(stereo));
  console.log(`${name.padEnd(28)} ${String(info.seconds).padStart(6)}s  peak ${String(info.peak).padStart(5)}  rms ${String(info.rms).padStart(6)}  削顶 ${info.clippedSamples}`);
  if (info.rms < 0.005) problems.push(`${name} 近乎静音`);
  if (info.clippedSamples > 200) problems.push(`${name} 削顶样本过多`);
  return info;
}

// 1) 音效：按清单分类各出一条巡游，间隔 0.4 秒，并打印「秒 → 条目」对照。
const cats = [...new Set(SOUND_INVENTORY.filter((x) => x.status === 'ready' && !x.bed).map((x) => x.cat))];
let totalSfx = 0;
for (const cat of cats) {
  const items = SOUND_INVENTORY.filter((x) => x.cat === cat && x.status === 'ready' && !x.bed);
  const clips = [];
  const labels = [];
  let cursor = 0;
  for (const item of items) {
    const clip = renderSfx(item.id);
    if (!clip) { problems.push(`${item.id} 渲染失败`); continue; }
    clips.push({ at: cursor, data: clip });
    labels.push(`${(cursor / SR).toFixed(2)}s ${item.id}｜${item.zh}`);
    cursor += clip.length + 0.4 * SR;
  }
  totalSfx += items.length;
  write(`sfx-${cat}.wav`, toStereo(mixMono(clips, cursor / SR)));
  console.log(`  ${cat}（${items.length} 条）：\n    ` + labels.join('\n    '));
}

// 2) BGM：四季出昼/夜两版，其余状态各出一版。
const themes = ['spring', 'summer', 'autumn', 'winter', 'crisis', 'recovering', 'extinct', 'menu'];
for (const theme of themes) {
  const variants = themes.slice(0, 4).includes(theme) ? [true, false] : [true];
  for (const day of variants) {
    const { bars, secondsPerBar } = musicMeta({ theme });
    const clips = [];
    for (let bar = 0; bar < bars; bar++) clips.push({ at: bar * secondsPerBar, data: renderMusicBar({ theme, day, bar }) });
    const stereo = new Float32Array(Math.round(bars * secondsPerBar * SR) * 2);
    for (const { at, data } of clips) {
      const start = Math.round(at * SR) * 2;
      for (let i = 0; i + start < stereo.length && i < data.length; i++) stereo[start + i] += data[i];
    }
    write(`bgm-${theme}${day ? '-day' : '-night'}.wav`, stereo);
  }
}

// 3) 环境声床（清单里标 bed 的条目）。
for (const item of SOUND_INVENTORY.filter((x) => x.bed)) write(`amb-${item.id}.wav`, renderAmbience(item.id));

// 4) 统计汇总：与清单同一来源，报告里直接抄这段。
const byStatus = SOUND_INVENTORY.reduce((m, x) => (m[x.status] = (m[x.status] ?? 0) + 1, m), {});
console.log('\n声音清单统计');
console.log(`  条目合计 ${SOUND_INVENTORY.length}：已发声 ${byStatus.ready ?? 0} · 刻意静音 ${byStatus.silent ?? 0} · 待做 ${byStatus.planned ?? 0}`);
console.log(`  音效 ${totalSfx} 条（分 ${cats.length} 类）· 环境声床 ${SOUND_INVENTORY.filter((x) => x.bed).length} 条 · BGM 主题 ${themes.length} 套（四季各出昼夜，共 ${themes.slice(0, 4).length * 2 + 4} 版）`);
console.log(`  季节→主题：${['春', '夏', '秋', '冬'].map((s) => `${s}=${themeForSeason(s)}`).join(' ')}`);
for (const cat of cats) {
  const items = SOUND_INVENTORY.filter((x) => x.cat === cat);
  console.log(`  ${cat}：${items.length} 条（ready ${items.filter((x) => x.status === 'ready').length} / silent ${items.filter((x) => x.status === 'silent').length} / planned ${items.filter((x) => x.status === 'planned').length}）`);
}
for (const item of SOUND_INVENTORY.filter((x) => x.status !== 'ready')) {
  console.log(`  未发声 ${item.id}（${item.zh}｜${item.status}）：${item.reason}`);
}

console.log(problems.length ? `\n✖ 自检发现问题：\n  ${problems.join('\n  ')}` : '\n✔ 自检通过：无静音、无削顶');
process.exit(problems.length ? 1 : 0);
