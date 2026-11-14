// 音频面闸门：表现层的音效应可核对、确定性、且不碰世界。
//
// 这里的"负向对照"写法沿用仓库惯例：每条都注明怎么打红，改错就红。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  renderSfx, sfxNames, renderMusicBar, musicMeta, renderAmbience, SFX_BY_CODE, SFX_BY_KIND,
} from '../web/audio-data.mjs';
import { analyze } from '../web/audio-synth.mjs';

const SR = 44100;
const names = new Set(sfxNames());

test('A-01 音效映射表里的名字全都存在（拼错必须红）', () => {
  for (const [code, name] of Object.entries(SFX_BY_CODE)) {
    if (name) assert.ok(names.has(name), `反馈码 ${code} 指向不存在的音效 ${name}`);
    assert.ok(renderSfx(name ?? 'deny'), `${code} 渲染不出声音`);
  }
  for (const [kind, name] of Object.entries(SFX_BY_KIND)) {
    if (name === null) continue;   // move 故意静音：脚步会盖住劳动声
    assert.ok(names.has(name), `动作 ${kind} 指向不存在的音效 ${name}`);
  }
});

test('A-02 每条音效都响、不削顶、不超过 2.5 秒', () => {
  for (const name of names) {
    const clip = renderSfx(name);
    const info = analyze(clip);
    assert.ok(info.rms > 0.002, `${name} 近乎静音`);
    assert.ok(info.peak <= 0.62, `${name} 峰值 ${info.peak} 越界（会盖过 BGM）`);
    assert.equal(info.clippedSamples, 0, `${name} 有削顶样本`);
    assert.ok(clip.length / 2 / SR <= 2.5, `${name} 长 ${info.seconds}s，太长了`);
  }
});

test('A-03 同参数两次渲染逐位相同，且小节时长与元数据一致', () => {
  for (const theme of ['warm', 'cool']) {
    for (const day of [true, false]) {
      const a = renderMusicBar({ theme, day, bar: 3 });
      const b = renderMusicBar({ theme, day, bar: 3 });
      assert.equal(a.length, b.length, `${theme}/${day} 小节长度不稳定`);
      for (let i = 0; i < a.length; i += 997) assert.equal(a[i], b[i], `${theme}/${day} 小节内容变了`);
      const meta = musicMeta({ theme });
      assert.ok(Math.abs(a.length / 2 / SR - meta.secondsPerBar) < 1 / SR,
        `${theme} 小节 ${a.length / 2 / SR}s ≠ 元数据 ${meta.secondsPerBar}s`);
    }
  }
});

test('A-04 六个环境声循环可渲染、不削顶；未知名字返回 null', () => {
  for (const name of ['day', 'night', 'rain', 'wind', 'cold', 'crisis']) {
    const clip = renderAmbience(name);
    assert.ok(clip, `${name} 渲染失败`);
    const info = analyze(clip);
    assert.ok(info.rms > 0.002, `${name} 近乎静音`);
    assert.equal(info.clippedSamples, 0, `${name} 削顶`);
  }
  assert.equal(renderAmbience('nope'), null);
});

test('A-05 危机档与正常档真的不同（声音跟着世界状态走，不是循环播放）', () => {
  const normal = renderMusicBar({ theme: 'warm', day: true, bar: 0 });
  const crisis = renderMusicBar({ theme: 'warm', day: true, crisis: true, bar: 0 });
  assert.notEqual(normal.length, crisis.length, '危机档与小节长度相同 ⇒ 变体没生效');
  const info = analyze(crisis);
  assert.ok(info.approxCentroidHz < analyze(normal).approxCentroidHz, '危机档应当更低沉');
});

test('A-06 音频层不读世界、不引引擎：三个模块都不 import life/*', () => {
  for (const file of ['web/audio.mjs', 'web/audio-data.mjs', 'web/audio-synth.mjs']) {
    const text = readFileSync(resolve(process.cwd(), file), 'utf8');
    assert.equal(/from\s+['"][^'"]*\/life\//.test(text), false, `${file} 引入了引擎模块`);
    assert.equal(/world\.|survival\./.test(text), false, `${file} 直接读写世界状态`);
  }
});
