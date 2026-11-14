// 音频面闸门：表现层的音效应可核对、确定性、且不碰世界。
//
// 这里的"负向对照"写法沿用仓库惯例：每条都注明怎么打红，改错就红。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  renderSfx, sfxNames, renderMusicBar, musicMeta, renderAmbience, SFX_BY_CODE, SFX_BY_KIND, themeForSeason,
} from '../web/audio-data.mjs';
import { SOUND_INVENTORY } from '../web/audio-inventory.mjs';
import { readWorld, diffAudioEvents, sceneSignature, musicWindow, windowSignature, proximity, PLAY_TICKS, musicTarget } from '../web/audio-events.mjs';
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

test('A-07 清单里每条 ready 都有对应声音（有主必有音）', () => {
  for (const item of SOUND_INVENTORY) {
    if (item.status !== 'ready') continue;
    if (item.bed) {
      assert.ok(renderAmbience(item.id), `环境床 ${item.id} 渲染不出来`);
      continue;
    }
    assert.ok(names.has(item.id), `清单条目 ${item.id}（${item.zh}）还没有配方`);
    assert.ok(renderSfx(item.id), `${item.id} 配方渲染失败`);
  }
});

test('A-08 每个配方都登记在清单里（有音必有主，不许偷偷加）', () => {
  const listed = new Set(SOUND_INVENTORY.map((x) => x.id));
  for (const name of names) {
    assert.ok(listed.has(name), `配方 ${name} 不在声音清单里 ⇒ 清单统计会失真`);
  }
});

test('A-09 silent 与 planned 都必须写明理由', () => {
  for (const item of SOUND_INVENTORY) {
    if (item.status === 'ready') continue;
    assert.ok(['silent', 'planned'].includes(item.status), `${item.id} 状态 ${item.status} 不合法`);
    assert.ok((item.reason ?? '').length >= 8, `${item.id} 标了 ${item.status} 却没写原因`);
  }
});

test('A-10 四季 + 危机 + 恢复 + 灭绝 + 菜单八套主题齐备且互不相同', () => {
  const themes = ['spring', 'summer', 'autumn', 'winter', 'crisis', 'recovering', 'extinct', 'menu'];
  const seen = new Map();
  for (const theme of themes) {
    const clip = renderMusicBar({ theme, day: true, bar: 0 });
    const meta = musicMeta({ theme });
    assert.ok(Math.abs(clip.length / 2 / SR - meta.secondsPerBar) < 1 / SR, `${theme} 小节时长不符`);
    const fingerprint = `${meta.bpm}|${clip.length}`;
    // 指纹相同不代表一定错（同速同长是可能的），所以再比一次实际内容。
    if (seen.has(fingerprint)) {
      const other = seen.get(fingerprint);
      const a = renderMusicBar({ theme, day: true, bar: 1 });
      const b = renderMusicBar({ theme: other, day: true, bar: 1 });
      assert.notEqual(a.join(','), b.join(','), `${theme} 与 ${other} 的 BGM 完全相同`);
    } else seen.set(fingerprint, theme);
  }
  assert.equal(themeForSeason('春'), 'spring');
  assert.equal(themeForSeason('冬'), 'winter');
  assert.equal(themeForSeason(undefined), 'spring', '坏季节值必须退回一个可用主题，不能崩');
});

test('A-11 映射表里没有过期键：每个 kind/code 都能在世界侧找到出处', () => {
  // kind 由引擎执行、也可能由前端发起 ⇒ 两侧都要算出处；code 只在引擎里生成。
  const engineFiles = readdirSync(resolve(process.cwd(), 'life')).filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs'));
  const sources = [...engineFiles.map((f) => readFileSync(resolve(process.cwd(), 'life', f), 'utf8')),
    readFileSync(resolve(process.cwd(), 'web', 'app.js'), 'utf8')].join('\n');
  for (const kind of Object.keys(SFX_BY_KIND)) {
    const appears = new RegExp(`'${kind}'|"${kind}"`).test(sources);
    assert.ok(appears, `SFX_BY_KIND 里的 ${kind} 在引擎与前端里都已不存在 ⇒ 映射表过期`);
  }
  const codes = new Set([...sources.matchAll(/'([A-Z][A-Z_]{2,})'/g)].map((m) => m[1]));
  for (const code of Object.keys(SFX_BY_CODE)) {
    assert.ok(codes.has(code), `SFX_BY_CODE 里的 ${code} 在引擎里已不存在 ⇒ 映射表过期`);
  }
});

// ───────────────── 世界差分规则（web/audio-events.mjs） ─────────────────

const world = (over = {}) => readWorld({
  day: 3, births: 1, deaths: [], won: false, settlement: 'active', disaster: null, drought: false,
  livestock: { chickens: 3, cows: 2, sheep: 2 }, households: { residents: { a1: { stage: 'adult' } } },
  sites: [], buildings: [], history: [], ...over,
});
const step = (before, after) => diffAudioEvents(world(before), world(after));

test('A-12 差分规则：状态跃迁各自对应唯一一条音', () => {
  assert.deepEqual(step({}, { settlement: 'crisis' }), ['crisisEnter']);
  assert.deepEqual(step({ settlement: 'crisis' }, { settlement: 'recovering' }), ['recover']);
  assert.deepEqual(step({ settlement: 'crisis' }, { settlement: 'active' }), ['recover']);
  assert.deepEqual(step({}, { settlement: 'extinct' }), ['extinct']);
  assert.deepEqual(step({}, { disasterToday: 'storm' }), ['storm']);
  assert.deepEqual(step({}, { disasterToday: 'coldsnap' }), ['cold']);
  assert.deepEqual(step({}, { drought: true }), ['drought']);
  assert.deepEqual(step({ births: 2 }, { births: 3 }), ['birth']);
  assert.deepEqual(step({}, { won: true }), ['milestone']);
  assert.deepEqual(step({}, { households: { residents: { a1: { stage: 'child' } } } }), []);
  assert.deepEqual(step({ households: { residents: { a1: { stage: 'child' } } } },
    { households: { residents: { a1: { stage: 'adult' } } } }), ['adult']);
  assert.deepEqual(step({ sites: [{ loc: 'yard', type: 'shelter', phase: 'frame' }] },
    { sites: [{ loc: 'yard', type: 'shelter', phase: 'complete' }] }), ['complete']);
  assert.deepEqual(step({ buildings: [{ loc: 'yard', type: 'wall', integrity: 1 }] },
    { buildings: [{ loc: 'yard', type: 'wall', integrity: 0.4 }] }), ['damaged']);
  assert.deepEqual(step({ day: 4 }, { day: 5 }), ['ration']);
  assert.deepEqual(step({ day: 4 }, { day: 5, history: [{ shortfall: 3 }] }), ['shortfall']);
  assert.deepEqual(step({ livestock: { chickens: 3 } }, { livestock: { chickens: 4 } }), ['chicken']);
});

test('A-13 一次只播一条，且死亡优先于出生', () => {
  const sameTick = step({ deaths: [], births: 1 }, { deaths: [{}], births: 2 });
  assert.equal(sameTick.length, 1, '一轮轮询最多一条事件音');
  assert.deepEqual(sameTick, ['death']);
});

test('A-14 刚接手世界不补播历史；玩家倒下后不再播事件音', () => {
  assert.deepEqual(diffAudioEvents(null, world({ settlement: 'crisis' })), [], 'prev=null 不该把存档里的事重演一遍');
  const dead = step({ player: { dead: false } }, { player: { dead: true }, deaths: [{}] });
  assert.deepEqual(dead, [], '玩家死亡由场景音负责，差分不再补一条');
});

test('A-15 差分规则指向的音都必须存在（防止规则与配方表分家）', () => {
  const probes = [
    [{}, { settlement: 'crisis' }], [{}, { disaster: 'storm' }], [{}, { won: true }],
    [{ day: 4 }, { day: 5 }], [{ livestock: { chickens: 3 } }, { livestock: { chickens: 4 } }],
    [{ sites: [] }, { sites: [{ loc: 'yard', type: 'shelter', phase: 'frame' }] }],
    [{ buildings: [{ loc: 'yard', type: 'wall', integrity: 1 }] }, { buildings: [{ loc: 'yard', type: 'wall', integrity: 0.4 }] }],
  ];
  for (const [before, after] of probes) {
    for (const id of step(before, after)) {
      assert.ok(names.has(id), `差分规则要播 ${id}，但配方表里没有`);
      assert.ok(renderSfx(id), `${id} 渲染不出来`);
    }
  }
});

test('A-16 场景签名只在真会换音的读数上变化', () => {
  const base = { season: '春', phase: '昼', weather: 'clear', settlement: 'active', crisisDays: 0, player: { dead: false } };
  assert.equal(sceneSignature(base), sceneSignature({ ...base }), '同样的读数不该算出不同签名');
  assert.notEqual(sceneSignature(base), sceneSignature({ ...base, season: '冬' }));
  assert.notEqual(sceneSignature(base), sceneSignature({ ...base, phase: '夜' }));
  assert.notEqual(sceneSignature(base), sceneSignature({ ...base, settlement: 'crisis' }));
  assert.notEqual(sceneSignature(base), sceneSignature({ ...base, player: { dead: true } }));
  // 天数、人口这些不该重排环境声（它们走事件音），签名必须相同。
  assert.equal(sceneSignature(base), sceneSignature({ ...base, day: 9, births: 4 }));
});

// ───────────────── BGM 播放窗口（不全局连播） ─────────────────

const inVillage = { t: 100, season: '春', phase: '昼', settlement: 'active', playerPos: [60, 40], sites: [], coop: {} };
const win = (over = {}) => musicWindow({ ...inVillage, ...over }, { now: over.t ?? inVillage.t });

test('A-17 夜、灭绝、玩家倒下、走到村外都不该有 BGM；晨与暮该有', () => {
  assert.equal(win({ phase: '夜' }).play, false, '夜里不播旋律，只留虫鸣与风');
  assert.equal(win({ settlement: 'extinct' }).play, false, '村子没了不该有曲子');
  assert.equal(win({ player: { dead: true } }).play, false, '玩家倒下由场景音负责');
  assert.equal(win({ playerPos: [190, 60] }).play, false, '远征途中不播村内主题');
  assert.equal(win({ phase: '晨' }).play, true, '晨是开工曲');
  assert.equal(win({ phase: '暮' }).play, true, '暮是收工段');
});

test('A-18 白天只在村子真的在忙时播：有工地或有协作', () => {
  assert.equal(win({}).play, false, '闲日不该有 BGM 顶着劳动声');
  assert.equal(win({ sites: [{ loc: 'yard', type: 'shelter', phase: 'frame' }] }).play, true);
  assert.equal(win({ coop: { task: { workers: ['a1', 'a2'] } } }).play, true);
  assert.equal(win({ coop: { task: { workers: [] } } }).play, false, '挂名无人不算热闹');
});

test('A-19 播也有节拍：热闹的一整天里必须出现静默段，且连续播不超过 PLAY_TICKS', () => {
  const busy = { sites: [{ loc: 'yard', type: 'shelter', phase: 'frame' }] };
  const day = Array.from({ length: 24 }, (_, h) => win({ ...busy, t: 100 + h }));
  assert.ok(day.some((w) => w.play), '热闹时总得响几次');
  assert.ok(day.some((w) => !w.play), '24 小时连播就是背景板，必须歇');
  let run = 0, longest = 0;
  for (const w of day) { run = w.play ? run + 1 : 0; longest = Math.max(longest, run); }
  assert.ok(longest <= PLAY_TICKS, `连续播 ${longest} 刻 > 上限 ${PLAY_TICKS}`);
});

test('A-20 窗口规则确定性：同一份读数两次调用结果相同，且不靠墙钟', () => {
  const a = win({ phase: '晨' }), b = win({ phase: '晨' });
  assert.deepEqual(a, b);
  assert.equal(windowSignature(a), windowSignature(b));
  // 只随世界刻走：t 变了才可能换段，same t ⇒ same answer
  assert.equal(windowSignature(win({ t: 100 })), windowSignature(win({ t: 100 })));
});

test('A-21 远近程度单调且钳在 0..1：村内 0，村外 1', () => {
  const near = proximity({ playerPos: [60, 40] });
  const edge = proximity({ playerPos: [100, 60] });
  const far = proximity({ playerPos: [190, 60] });
  assert.equal(near, 0, '村内不该听到旷野风');
  assert.ok(far > edge && edge >= 0, `远近必须单调：${near} ${edge} ${far}`);
  assert.ok(far <= 1, 'proximity 必须钳在 0..1');
  assert.equal(proximity({}), 0, '没有位置读数时算在村内');
});

test('A-22 窗口说停，目标电平必须是 0（不是"算对了但没接线"）', () => {
  assert.equal(musicTarget({ play: false, theme: 'spring' }, 'active'), 0, '不播时电平必须归零');
  assert.equal(musicTarget({ play: true, theme: 'spring' }, 'active'), 0.9);
  assert.equal(musicTarget({ play: true, theme: 'crisis' }, 'crisis'), 0.7, '危机时给心跳让路');
  assert.equal(musicTarget(null, 'active'), 0, '没有窗口读数时不响');
  // 接线侧的同一类错误：布尔当电平用会让"停播"永远不生效。
  const wired = readFileSync(resolve(process.cwd(), 'web', 'audio.mjs'), 'utf8');
  assert.equal(/fadeMusic\(\s*(true|false)\s*\)/.test(wired), false,
    'audio.mjs 里还有 fadeMusic(true/false)：电平必须来自 musicTarget');
  assert.equal(/fadeMusic\(true[,)]/.test(wired), false, '同上：淡出分支不能写成 true');
});
