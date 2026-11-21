// 音频面闸门：表现层的音效应可核对、确定性、且不碰世界。
//
// 这里的"负向对照"写法沿用仓库惯例：每条都注明怎么打红，改错就红。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  renderSfx, sfxNames, renderMusicBar, musicMeta, renderAmbience, SFX_BY_CODE, SFX_BY_KIND, themeForSeason,
} from '../web/audio-data.mjs';
import { SOUND_INVENTORY } from '../web/audio-inventory.mjs';
import { readWorld, diffAudioEvents, sceneSignature, musicWindow, windowSignature, proximity, PLAY_TICKS, musicTarget, MUSIC_LEVEL, MUSIC_LEVEL_CRISIS, MUSIC_LEVEL_NIGHT, MUSIC_LEVEL_DEATH, MUSIC_LEVEL_EXTINCT, MUSIC_LEVEL_GHOST } from '../web/audio-events.mjs';
import {
  BED_SLOTS, AMBIENCE_MATERIALS, AMBIENCE_LUFS, BED_TARGET_LUFS, BED_GAIN, bedGain,
  weatherBed, dayNightBed, CAMP_REGION, inCampRegion, playerInCamp, musicDuck, MUSIC_DUCK_WEATHER,
} from '../web/audio-events.mjs';
import { TOWN_SIZE } from '../shared/camp-layout.mjs';
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
  // 天气床按 climate 选素材：灾害/干旱必须触发重排，否则雨停、寒潮、干旱时床不换。
  assert.notEqual(sceneSignature(base), sceneSignature({ ...base, disasterToday: 'coldsnap' }));
  assert.notEqual(sceneSignature(base), sceneSignature({ ...base, drought: true }));
  // 天数、人口这些不该重排环境声（它们走事件音），签名必须相同。
  assert.equal(sceneSignature(base), sceneSignature({ ...base, day: 9, births: 4 }));
});

// ───────────────── BGM 播放窗口（不全局连播） ─────────────────

const inVillage = { t: 100, season: '春', phase: '昼', settlement: 'active', playerPos: [60, 40], sites: [], coop: {} };
const win = (over = {}) => musicWindow({ ...inVillage, ...over }, { now: over.t ?? inVillage.t });

test('A-17 播放窗口：夜与灭绝各用自己的曲目；远征仍不放；晨暮照旧', () => {
  // 2026-11-21：所有者补齐夜曲/灭绝曲后，明确改掉了 11-15 的"夜里不放、灭绝静默"。
  const night = win({ phase: '夜' });
  assert.equal(night.play, true, '夜里现在有曲（夜曲素材已到位）');
  assert.equal(night.theme, 'spring-night', '夜间必须用季节夜曲，不能混进日曲');
  const ex = win({ settlement: 'extinct' });
  assert.equal(ex.play, true, '灭绝有了自己的曲目');
  assert.equal(ex.theme, 'extinct');
  assert.equal(win({ player: { dead: true } }).play, false, '玩家倒下不走这个窗口：audio.scene 直接切 death 曲');
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
  assert.equal(musicTarget({ play: true, theme: 'spring' }, 'active'), MUSIC_LEVEL);
  assert.equal(musicTarget({ play: true, theme: 'crisis' }, 'crisis'), MUSIC_LEVEL_CRISIS, '危机时给心跳让路');
  assert.equal(musicTarget(null, 'active'), 0, '没有窗口读数时不响');
  // 所有者裁决：BGM 整体压在音效之下，不许再回到"音乐最响"。
  assert.ok(MUSIC_LEVEL <= 0.65, `BGM 常规电平 ${MUSIC_LEVEL} 偏高（要求整体压低）`);
  assert.ok(MUSIC_LEVEL_CRISIS < MUSIC_LEVEL, '危机档必须比常规更低');
  assert.equal(musicTarget({ play: true, theme: 'spring-night' }, 'active'), MUSIC_LEVEL_NIGHT, '夜曲必须比日曲低一档');
  assert.equal(musicTarget({ play: true, theme: 'death' }, 'active'), MUSIC_LEVEL_DEATH);
  assert.equal(musicTarget({ play: true, theme: 'extinct' }, 'active'), MUSIC_LEVEL_EXTINCT);
  assert.ok(MUSIC_LEVEL_NIGHT < MUSIC_LEVEL && MUSIC_LEVEL_EXTINCT < MUSIC_LEVEL_NIGHT);
  // 接线侧的同一类错误：布尔当电平用会让"停播"永远不生效。
  const wired = readFileSync(resolve(process.cwd(), 'web', 'audio.mjs'), 'utf8');
  assert.equal(/fadeMusic\(\s*(true|false)\s*\)/.test(wired), false,
    'audio.mjs 里还有 fadeMusic(true/false)：电平必须来自 musicTarget');
  assert.equal(/fadeMusic\(0\.\d/.test(wired), false, '电平不许在接线处硬写小数，必须走 musicTarget');
});

// ───────────────── 原先"待做"的三条：现在靠现有载荷做，不为声音改规则 ─────────────────

test('A-23 树再生、丧偶、工人退出各自在事实发生的那一刻触发', () => {
  assert.deepEqual(step({}, { camp: { timber: { grove1: { stage: 'mature' } } } }), [],
    '第一次接手不算"刚长好"');
  assert.deepEqual(step({ camp: { timber: { grove1: { stage: 'sapling' } } } },
    { camp: { timber: { grove1: { stage: 'mature' } } } }), ['regrow']);
  assert.deepEqual(step({ camp: { timber: { grove1: { stage: 'mature' } } } },
    { camp: { timber: { grove1: { stage: 'mature' } } } }), [], '没变化不该响');
  assert.deepEqual(step({ households: { widowed: {} } }, { households: { widowed: { a3: { spouse: 'a1', t: 72 } } } }), ['widow']);
  assert.deepEqual(step({ coop: { exits: 4 } }, { coop: { exits: 5 } }), ['coopExit']);
  assert.deepEqual(step({ coop: { exits: 5 } }, { coop: { exits: 5 } }), [], '计数没涨不该响');
});

test('A-24 丧偶优先于死亡，且同一次只播一条', () => {
  const both = step({ deaths: [], households: { widowed: {} } },
    { deaths: [{}], households: { widowed: { a3: { spouse: 'a1', t: 72 } } } });
  assert.deepEqual(both, ['widow'], '同一刻既死人又有人丧偶，该听见的是活着的那个');
  const plain = step({ deaths: [], households: { widowed: {} } }, { deaths: [{}], households: { widowed: {} } });
  assert.deepEqual(plain, ['death'], '无配偶的死亡仍是死亡音');
  assert.equal(both.length, 1);
});

test('A-25 三条依赖的载荷字段真的在 survView 里（防止差分对着空气算）', async () => {
  const { createSurvPlay, tickSurvPlay, survView } = await import('../life/survplay.mjs');
  const sp = createSurvPlay(7, { residentialDecisions: true, eventRulesVersion: 2, ecosystem: true,
    unifiedCooperation: true, independentWorld: true, wildFood: true, autonomousGoals: true,
    settlementLife: true, regionalWork: true });
  for (let i = 0; i < 240; i++) tickSurvPlay(sp);
  const v = survView(sp);
  assert.ok(v.camp?.timber, '载荷缺 camp.timber ⇒ regrow 永远不触发');
  assert.ok(Object.hasOwn(v.coop ?? {}, 'exits'), '载荷缺 coop.exits ⇒ coopExit 永远不触发');
  // widowed 是懒创建的键：世界里有记录时载荷必须带出来，没有时不该凭空出现。
  const widowed = sp.world.survival.households?.widowed;
  if (widowed) assert.deepEqual(v.households.widowed, widowed, '世界里有丧偶记录但载荷没带出来');
  else assert.equal(v.households.widowed, undefined, '世界里没有丧偶记录，载荷不该造一个');
  const sample = readWorld(v);
  assert.ok(typeof sample.exits === 'number' && typeof sample.timber === 'object' && typeof sample.widowed === 'string',
    'readWorld 必须把三条事实读成可比对的形状');
});

// ───────────────────────── 成品曲 BGM（web/music/*.ogg） ─────────────────────────
// 所有者口径（2026-11-19）：每首都要听得到不同段落，所以**不做强制循环**——
// 每次窗口开时按世界刻换一个起播点，渐入渐出照旧。这几条钉的就是这套约定不被改回"整首循环"。
import { MUSIC_TRACKS, MUSIC_BYTE_BUDGET } from '../web/music-tracks.mjs';
import { musicStartFor, MUSIC_STINT_TICKS } from '../web/audio-events.mjs';

const PLAYING_SLOTS = ['menu', 'spring', 'summer', 'autumn', 'winter', 'crisis', 'recovering',
  'spring-night', 'summer-night', 'autumn-night', 'winter-night', 'death', 'extinct'];

test('A-26 清单只覆盖会响的槽位，不播的不许占体积', () => {
  assert.deepEqual(Object.keys(MUSIC_TRACKS).sort(), [...PLAYING_SLOTS].sort(),
    '清单槽位必须与 musicWindow 真会播的槽位一一对应');
  // 2026-11-21：灭绝改为会播（第二批素材），所以它必须在清单里；反向断言随之翻转。
  assert.ok(MUSIC_TRACKS.extinct, '灭绝现在会播，必须有素材');
  for (const t of PLAYING_SLOTS) {
    const tr = MUSIC_TRACKS[t];
    assert.ok(Array.isArray(tr.starts) && tr.starts.length >= 1, `${t} 没有可用起播点`);
    assert.ok(typeof tr.seconds === 'number' && typeof tr.bytes === 'number', `${t} 缺时长或字节`);
  }
});

test('A-27 起播点必须实测合法：不吃音头、后面够放、彼此隔得开', () => {
  for (const t of PLAYING_SLOTS) {
    const tr = MUSIC_TRACKS[t];
    let prev = -Infinity;
    for (const s of tr.starts) {
      assert.ok(s >= 3, `${t}@${s}：淡入 2.5s 会吃掉没成形的音头`);
      assert.ok(s - prev >= 40 || prev === -Infinity, `${t}@${s}：与上一个起点隔得不够（${(s - prev).toFixed(1)}s），换了等于没换`);
      assert.ok(tr.seconds - s >= 45, `${t}@${s}：只剩 ${(tr.seconds - s).toFixed(1)}s，撑不满一截播放窗口`);
      prev = s;
    }
    const file = resolve(process.cwd(), 'web', tr.file);
    assert.ok(existsSync(file), `${t} 的素材文件不存在：${tr.file}`);
    assert.equal(statSync(file).size, tr.bytes, `${t} 素材字节与清单不符：清单改过还是文件换过？`);
  }
  const sum = PLAYING_SLOTS.reduce((a, t) => a + MUSIC_TRACKS[t].bytes, 0);
  assert.ok(sum <= MUSIC_BYTE_BUDGET, `BGM 素材合计 ${(sum / 1048576).toFixed(1)}MB 超预算 ${(MUSIC_BYTE_BUDGET / 1048576).toFixed(0)}MB`);
});

test('A-28 轮转只看世界刻：同刻同曲必同一段，跨一截必须换段', () => {
  const three = { spring: { starts: [33, 73, 113], seconds: 168 } };
  const base = 0;
  const seen = new Set();
  for (let k = 0; k < 6; k += 1) {
    const a = musicStartFor('spring', base + k * MUSIC_STINT_TICKS, three);
    const b = musicStartFor('spring', base + k * MUSIC_STINT_TICKS, three);
    assert.equal(a, b, '同一输入两次调用不同值 ⇒ 里面掺了随机，同营地观众会听到不同段落');
    seen.add(a);
  }
  assert.equal(seen.size, 3, '三起点应被轮换到三次');
  assert.equal(musicStartFor('menu', 4 * MUSIC_STINT_TICKS, three), musicStartFor('menu', 4 * MUSIC_STINT_TICKS, three));
  assert.equal(musicStartFor('nope', 0, three), null, '没登记素材的槽位要返回 null，让接线退回合成版');
});

test('A-29 世界刻随窗口返回，但绝不进窗口签名（否则每轮询都重排音乐）', () => {
  const inVillage2 = { ...inVillage, phase: '昼', settlement: 'active' };
  const a = musicWindow({ ...inVillage2, t: 12 }, { now: 12 });
  assert.equal(a.t, 12, '窗口要把判定用的世界刻带回去，接线才不用向 app.js 多要一个参数');
  assert.equal(windowSignature(musicWindow({ ...inVillage2, t: 12 }, { now: 12 })),
    windowSignature(musicWindow({ ...inVillage2, t: 108 }, { now: 108 })),
    '签名里不许含 t：淡入淡出只能由"该不该播/哪首/昼夜"触发');
  assert.ok(!String(a.t).includes('undefined'));
});

test('A-30 成品曲接进 musicBus，且不许再出现强制循环', () => {
  const wired = readFileSync(resolve(process.cwd(), 'web', 'audio.mjs'), 'utf8');
  assert.match(wired, /src\.connect\(state\.musicBus/, '成品曲必须走 musicBus，否则 2.5/3.5 秒淡入淡出与电平裁决全部失效');
  assert.equal(/\.loop\s*=\s*true/.test(wired.split('// 环境声床')[0]), false,
    'BGM 不许设 loop=true：所有者口径是每截换段落，不是无缝循环');
  assert.match(wired, /musicStartFor\(/, '接线必须按世界刻取起播点，而不是固定从 0 秒放');
});

// A-31（所有者 2026-11-19）：「不要这种兜底，很破坏统一性」——BGM 只放成品曲。
// 钉两件事：合成器 BGM 的代码彻底离开运行期；没素材时唯一允许的降级是静音。
test('A-31 BGM 不再有合成器兜底：没有素材就静音，绝不回落到代码音乐', () => {
  const wired = readFileSync(resolve(process.cwd(), 'web', 'audio.mjs'), 'utf8');
  for (const sym of ['renderMusicBar', 'scheduleMusic', 'barBuffer', 'startSynth']) {
    assert.equal(new RegExp('\\b' + sym + '\\b').test(wired), false, `audio.mjs 仍在用 ${sym}：合成器 BGM 应已移除`);
  }
  assert.match(wired, /if \(start === null\) \{ m\.playing = false; return; \}/, '没素材的槽位必须静音退出，不许找替身');
  assert.match(wired, /loadTrack\('menu'\)/, '开始屏要预取菜单曲，否则解锁后第一段是静音');
  for (const t of PLAYING_SLOTS) {
    assert.ok(MUSIC_TRACKS[t] && MUSIC_TRACKS[t].starts.length >= 1, `${t} 缺素材却仍会被窗口选中`);
  }
});

// ───────────────── 2026-11-21：环境床接线 / LUFS 平衡 / BGM 边界 ─────────────────
// 这一组直接针对体验审计的 P0/P1：光调函数不算数，必须看到 AudioBuffer 与层真的建起来。

test('A-32 环境床槽位→素材映射闭合：清单 ready、可渲染、增益、目标 LUFS 四处一致', () => {
  assert.deepEqual({ ...CAMP_REGION }, { west: 0, north: 0, east: TOWN_SIZE.width, south: TOWN_SIZE.depth },
    'BGM 边界必须与聚落矩形同源，不能各自写死');
  const materials = Object.values(BED_SLOTS).flat();
  assert.equal(AMBIENCE_MATERIALS.length, new Set(AMBIENCE_MATERIALS).size, 'AMBIENCE_MATERIALS 有重复');
  assert.equal(new Set(materials).size, AMBIENCE_MATERIALS.length, 'BED_SLOTS 与素材清单不同步');
  for (const material of new Set(materials)) {
    assert.ok(AMBIENCE_MATERIALS.includes(material), `${material} 没登记为环境床素材`);
    assert.ok(renderAmbience(material), `${material} 渲染不出来`);
    assert.ok(bedGain(material) > 0, `${material} 的归一化增益必须是正数`);
    const effective = AMBIENCE_LUFS[material] + 20 * Math.log10(0.7 * bedGain(material));
    assert.ok(Math.abs(effective - BED_TARGET_LUFS[material]) < 1e-9,
      `${material} 实际有效 ${effective.toFixed(2)}LUFS ≠ 目标 ${BED_TARGET_LUFS[material]}LUFS`);
  }
  // 清单的 bed 条目必须指向真实槽位；否则"ready"又会变成文档里的好听话。
  for (const item of SOUND_INVENTORY.filter((x) => x.bed)) {
    if (item.status !== 'ready') continue;
    assert.ok(item.slot, `环境床 ${item.id} 没写 slot`);
    assert.ok((BED_SLOTS[item.slot] ?? []).includes(item.id), `清单 ${item.id} 不在槽位 ${item.slot} 的可选素材里`);
    assert.ok(renderAmbience(item.id), `清单标 ready 的 ${item.id} 渲染失败`);
  }
  // weather 槽按 climate 选素材；daynight 槽只认昼夜。
  assert.equal(weatherBed(null, 'rain'), 'rain');
  assert.equal(weatherBed({ storm: true }, 'clear'), 'rain', '风暴按雨声底处理');
  assert.equal(weatherBed(null, 'cold'), 'cold');
  assert.equal(weatherBed({ frost: true }, 'clear'), 'cold');
  assert.equal(weatherBed({ snow: true }, 'clear'), 'cold');
  assert.equal(weatherBed({ drought: true }, 'clear'), 'wind');
  assert.equal(weatherBed(null, 'clear'), null);
  assert.equal(dayNightBed('夜'), 'night');
  for (const phase of ['晨', '昼', '暮', undefined]) assert.equal(dayNightBed(phase), 'day');
  // 显式 ducking 只压常规日曲；危机/夜曲已经低于常规，不再压。
  assert.equal(musicDuck(null, MUSIC_LEVEL), 1);
  assert.equal(musicDuck('rain', MUSIC_LEVEL_CRISIS), 1);
  assert.equal(musicDuck('rain', MUSIC_LEVEL), MUSIC_DUCK_WEATHER);
  assert.ok(MUSIC_DUCK_WEATHER < 1 && MUSIC_DUCK_WEATHER > 0.7);
});

test('A-33 BGM 边界按聚落矩形：镇角在镇内要播，矩形外算村外；灭绝/倒下例外不变', () => {
  assert.equal(inCampRegion([119, 79]), true, '镇角 (119,79) 在 120×80 镇内');
  assert.equal(inCampRegion([119.99, 79.99]), true);
  assert.equal(inCampRegion([120, 40]), false, 'x=120 是镇外');
  assert.equal(inCampRegion([130, 40]), false, '距核心 70 但已在镇矩形外');
  assert.equal(inCampRegion([0, 0]), true);
  assert.equal(inCampRegion([0, 80]), false);
  assert.equal(playerInCamp({ playerPos: [119, 79] }), true);
  assert.equal(playerInCamp({ locs: { house1: [119, 79] }, loc: { p1: 'house1' } }), true, '旧档退回 loc 坐标');
  assert.equal(playerInCamp({ playerPos: [130, 40] }), false);
  assert.equal(playerInCamp({}), true, '没有位置读数时按村内兜底');

  const corner = win({ playerPos: [119, 79], sites: [{ loc: 'yard', type: 'shelter', phase: 'frame' }] });
  assert.equal(corner.play, true, '镇角在镇内，忙碌日必须播');
  assert.equal(corner.reason, 'busy-day');
  const outside = win({ playerPos: [130, 40] });
  assert.equal(outside.play, false);
  assert.equal(outside.reason, 'away', '矩形外即村外');
  assert.equal(win({ playerPos: [130, 40], settlement: 'extinct' }).play, true,
    '灭绝例外不受矩形边界影响');
  const dead = win({ playerPos: [130, 40], player: { dead: true } });
  assert.equal(dead.play, false);
  assert.equal(dead.theme, 'death');
  assert.equal(dead.reason, 'player-dead', '倒下仍由 audio.scene 播送别曲，语义不变');
  const night = win({ playerPos: [119, 79], phase: '夜' });
  assert.equal(night.play, true);
  assert.equal(night.theme, 'spring-night');
});

test('A-34 菜单/村外/夜间/恢复规则明确：恢复与危机覆盖夜曲，村外不因时段例外', () => {
  const night = win({ phase: '夜' });
  assert.equal(night.theme, 'spring-night');
  assert.equal(musicTarget(night, 'active'), MUSIC_LEVEL_NIGHT);
  const nightCrisis = win({ phase: '夜', settlement: 'crisis' });
  assert.equal(nightCrisis.theme, 'crisis', '危机主题覆盖夜曲');
  assert.equal(musicTarget(nightCrisis, 'crisis'), MUSIC_LEVEL_CRISIS);
  const nightRecover = win({ phase: '夜', settlement: 'recovering' });
  assert.equal(nightRecover.theme, 'recovering', '恢复主题覆盖夜曲');
  assert.equal(musicTarget(nightRecover, 'recovering'), MUSIC_LEVEL,
    '恢复主题不是 -night 结尾，保持常规电平（本轮明确口径，未改）');

  // 村外：任何时段都不播；晨/暮也不是距离豁免。
  const busy = [{ loc: 'yard', type: 'shelter', phase: 'frame' }];
  for (const phase of ['晨', '昼', '夜', '暮']) {
    const w = win({ phase, playerPos: [130, 40], sites: busy });
    assert.equal(w.play, false, `村外 ${phase} 不该播`);
    assert.equal(w.reason, 'away');
  }
  // 恢复白天：照常按忙碌/时段播，不获得额外距离或时段豁免。
  const recovering = win({ settlement: 'recovering', sites: busy });
  assert.equal(recovering.play, true);
  assert.equal(recovering.theme, 'recovering');
  // 菜单：独立主题，musicTarget 不读位置；世界场景有 ui.menu 守卫。
  assert.equal(musicTarget({ play: true, theme: 'menu' }, 'active'), MUSIC_LEVEL);
  const app = readFileSync(resolve(process.cwd(), 'web', 'app.js'), 'utf8');
  assert.match(app, /if \(ui\.menu\) \{[\s\S]{0,120}audioSceneSig = null;[\s\S]{0,120}return; \}/,
    '菜单期间世界场景音频必须让路');
});

// mock 只替代 Web Audio 节点；audio.mjs 的槽位/素材选择、缓存、增益与层管理是产品代码原样执行。
class MockParam {
  constructor(value) { this.value = value; this.events = []; }
  setTargetAtTime(v, t, c) { this.events.push({ type: 'target', v, t, c }); this.value = v; return this; }
  setValueAtTime(v, t) { this.events.push({ type: 'set', v, t }); this.value = v; return this; }
  linearRampToValueAtTime(v, t) { this.events.push({ type: 'ramp', v, t }); this.value = v; return this; }
  cancelScheduledValues(t) { this.events.push({ type: 'cancel', t }); return this; }
}
class MockNode {
  connect(target) { this.target = target; return target; }
  disconnect() { this.disconnected = true; }
}
class MockGain extends MockNode {
  constructor(ctx) { super(); this.ctx = ctx; this.gain = new MockParam(1); }
}
class MockSource extends MockNode {
  constructor(ctx) { super(); this.ctx = ctx; this.buffer = null; this.loop = false; this.onended = null; this.stopCount = 0; }
  start(...args) { this.startArgs = args; }
  stop() { this.stopCount += 1; }
}
class MockBuffer {
  constructor(channels, length, sampleRate) {
    this.numberOfChannels = channels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.duration = length / sampleRate;
    this.channels = Array.from({ length: channels }, () => null);
  }
  copyToChannel(data, channel) { this.channels[channel] = data; }
}
class MockCtx {
  constructor() {
    this.sampleRate = 44100;
    this.currentTime = 0;
    this.state = 'running';
    this.destination = new MockNode();
    this.gains = []; this.sources = []; this.buffers = [];
    globalThis.__audioMockCtx = this;
  }
  createGain() { const g = new MockGain(this); this.gains.push(g); return g; }
  createBufferSource() { const s = new MockSource(this); this.sources.push(s); return s; }
  createDynamicsCompressor() {
    const c = new MockNode();
    for (const [name, value] of [['threshold', -16], ['knee', 24], ['ratio', 3], ['attack', 0.004], ['release', 0.22]]) {
      c[name] = new MockParam(value);
    }
    return c;
  }
  createBuffer(channels, length, sampleRate) {
    const b = new MockBuffer(channels, length, sampleRate);
    this.buffers.push(b);
    return b;
  }
  decodeAudioData() {
    return Promise.resolve(new MockBuffer(2, 44100 * 168, 44100));
  }
  resume() { return Promise.resolve(); }
}

let audioCase = 0;
async function mountAudio() {
  globalThis.window = { AudioContext: MockCtx };
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  globalThis.fetch = async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(16) });
  const href = new URL('../web/audio.mjs', import.meta.url).href;
  const mod = await import(`${href}?bed-case=${++audioCase}`);
  assert.equal(mod.unlock(), true, '解锁失败：mock AudioContext 没被接上');
  return { mod, ctx: globalThis.__audioMockCtx };
}

const lastMusicRamp = (gain) => [...gain.gain.events].reverse().find((e) => e.type === 'ramp')?.v;

test('A-35 真实接线：雨天建 2 层真 AudioBuffer、夜建 night、rain→cold 换缓冲，倒下只留心跳', async () => {
  const clear = await mountAudio();
  clear.mod.scene(sceneArgs());
  const clearSnap = clear.mod.audioDebug();
  assert.deepEqual(clearSnap.beds.map((b) => b.slot), ['daynight'], '晴天村内只应有昼夜床');
  assert.equal(clearSnap.beds[0].material, 'day');
  assert.ok(clearSnap.beds[0].gain > 0);
  const clearBus = lastMusicRamp(clear.ctx.gains[1]);
  assert.equal(clearBus, MUSIC_LEVEL);

  const rainy = await mountAudio();
  rainy.mod.scene(sceneArgs({ weather: 'rain', climate: { rain: true } }));
  const rainSnap = rainy.mod.audioDebug();
  assert.deepEqual(rainSnap.beds.map((b) => b.slot).sort(), ['daynight', 'weather'], '雨天必须建起天气+昼夜两层');
  assert.equal(rainSnap.beds.find((b) => b.slot === 'weather').material, 'rain');
  assert.equal(rainSnap.beds.find((b) => b.slot === 'daynight').material, 'day');
  assert.ok(rainSnap.beds.every((b) => b.gain > 0), '两层床的增益必须非 0');
  assert.ok(rainSnap.buffers.includes('amb:rain') && rainSnap.buffers.includes('amb:day'));
  assert.equal(rainy.ctx.sources.filter((s) => s.loop).length, 2, '两层循环床必须真的起播');
  const real = rainy.ctx.buffers.filter((b) => b.channels.some((c) => c && c.length));
  assert.ok(real.length >= 2, 'createBuffer 必须真的被调用');
  for (const b of real) {
    assert.equal(b.numberOfChannels, 2, '环境床是交织立体声');
    assert.ok(b.length > 0, 'AudioBuffer 长度必须非 0');
    assert.ok(b.channels.some((c) => c && c.some((v) => v !== 0)), '缓冲必须是真实采样，不能是空数组');
  }
  const rainBus = lastMusicRamp(rainy.ctx.gains[1]);
  assert.ok(rainBus < clearBus, '天气床在场时 BGM 必须被显式 ducking 压低');
  assert.ok(Math.abs(rainBus - MUSIC_LEVEL * MUSIC_DUCK_WEATHER) < 1e-9);

  // 同一 weather 槽换素材：缓存键必须跟着素材走，不能复用 amb:weather。
  rainy.mod.scene(sceneArgs({ weather: 'cold', climate: { snow: true } }));
  const coldSnap = rainy.mod.audioDebug();
  assert.equal(coldSnap.beds.find((b) => b.slot === 'weather').material, 'cold');
  assert.ok(coldSnap.buffers.includes('amb:rain') && coldSnap.buffers.includes('amb:cold'),
    'rain→cold 必须各自建缓冲，不能复用槽位名缓存');
  assert.ok(coldSnap.beds.every((b) => b.gain > 0));

  const night = await mountAudio();
  night.mod.scene(sceneArgs({ phase: '夜', window: { play: true, theme: 'spring-night', day: false, t: 0 } }));
  const nightSnap = night.mod.audioDebug();
  assert.deepEqual(nightSnap.beds.map((b) => b.slot), ['daynight']);
  assert.equal(nightSnap.beds[0].material, 'night');
  assert.ok(nightSnap.buffers.includes('amb:night'));
  assert.ok(night.ctx.buffers.some((b) => b.channels.some((c) => c && c.some((v) => v !== 0))));

  const crisis = await mountAudio();
  crisis.mod.scene(sceneArgs({
    settlement: 'crisis', weather: 'rain', climate: { rain: true },
    window: { play: true, theme: 'crisis', day: true, t: 0 },
  }));
  const crisisSnap = crisis.mod.audioDebug();
  assert.deepEqual(crisisSnap.beds.map((b) => b.slot).sort(), ['crisis', 'daynight', 'weather']);
  assert.equal(lastMusicRamp(crisis.ctx.gains[1]), MUSIC_LEVEL_CRISIS, '危机曲已低于常规，不再叠加 ducking');

  const dead = await mountAudio();
  dead.mod.scene(sceneArgs({ dead: true, proximity: 1, window: { play: false, theme: 'death', day: true, t: 0 } }));
  const deadSnap = dead.mod.audioDebug();
  assert.deepEqual(deadSnap.beds.map((b) => b.slot), ['crisis'], '倒下时只留心跳，天气/昼夜/风停');
  assert.equal(deadSnap.beds[0].material, 'crisis');

  const muted = await mountAudio();
  muted.mod.scene(sceneArgs({
    proximity: 0.4, settlement: 'crisis', weather: 'rain', climate: { rain: true },
    window: { play: true, theme: 'crisis', day: true, t: 0 },
  }));
  assert.equal(muted.mod.audioDebug().beds.length, 4, '静音前应有 weather/daynight/wind/crisis 四层');
  muted.mod.toggleMute();
  assert.deepEqual(muted.mod.audioDebug().beds, [], '静音必须停掉全部四层（wind 不再漏）');
});

function sceneArgs(over = {}) {
  return {
    season: '春', phase: '昼', weather: 'clear', settlement: 'active', crisisDays: 0, dead: false,
    window: { play: true, theme: 'spring', day: true, t: 0 }, proximity: 0, climate: {},
    ...over,
  };
}

// A-36（2026-11-21，1.3 幽魂观察）：人死了但世界还在看。死那一下由 audio.scene 播送别曲，
// 幽魂观察期间必须回到季节曲（夜里就是夜曲），并且压到 GHOST 档——不能一路静音。
test('A-36 幽魂观察不静音：回到季节曲并压到 GHOST 档', () => {
  const dead = win({ player: { dead: true } });
  assert.equal(dead.play, false, '刚死那一下由 audio.scene 播 death，不走窗口');
  // 用晨间取样：白天闲散本来就'不放'，不能拿它证明幽魂静音。
  const gDay = musicWindow({ ...inVillage, phase: '晨', player: { dead: true } }, { now: inVillage.t, ghost: true });
  assert.equal(gDay.play, true, '幽魂观察期必须有曲，否则 1.3 的观察会一路静音');
  assert.equal(gDay.theme, 'spring');
  assert.equal(gDay.ghost, true);
  const gNight = musicWindow({ ...inVillage, phase: '夜', player: { dead: true } }, { now: inVillage.t, ghost: true });
  assert.equal(gNight.theme, 'spring-night', '幽魂在夜里也该是夜曲');
  assert.equal(musicTarget(gDay, 'active'), MUSIC_LEVEL_GHOST);
  assert.ok(MUSIC_LEVEL_GHOST < MUSIC_LEVEL_NIGHT, '幽魂档应低于夜曲档');
  const app = readFileSync(resolve(process.cwd(), 'web', 'app.js'), 'utf8');
  assert.match(app, /musicWindow\(sv, \{ now: sv\.t \?\? 0, ghost \}\)/, 'app.js 必须把 ghost 传给窗口');
  assert.match(app, /proximity: proximity\(sv\), ghost \}\)/, 'app.js 必须把 ghost 传给 audio.scene');
});
