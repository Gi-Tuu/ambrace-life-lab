#!/usr/bin/env node
// 真实浏览器验收（CDP pipe + headless Chrome）。
//
// 覆盖两件 Node 侧证明不了的事：
//   1) 遮挡淡出真的作用在画面上：把 p1 放到居所正后方，同一机位拍两张
//      —— 正常帧（整栋建筑 28% 半透明，人物可见）与 `?cover=none` 对照帧（关掉淡出，人物被挡住）。
//      DOM 断言读 cvA._cam.covered / cvA._debug.occluded；像素断言对比人物胸口处两帧颜色。
//   2) 天气过渡真的接进了渲染：拦掉 /world 轮询把服务端快照冻住、只改客户端 S.view 的天气目标，
//      按 100ms 采样 cvA._debug.climateView，验证 wetness/wind/光照是 10–30s 斜坡而不是一帧阶跃。
//
// 用法：node evidence/fix-world-view/browser-world-view.mjs
// 产物：evidence/fix-world-view/browser-world-view.log、*.png
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCdpHarness } from '../../scripts/lib/cdp-harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(ROOT, 'evidence', 'fix-world-view');
const log = [];
const note = (kind, data = {}) => { log.push({ at: new Date().toISOString(), kind, ...data }); console.log(kind, JSON.stringify(data)); };
const assert = (cond, message) => { if (!cond) throw new Error('ASSERT: ' + message); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (h, sid, name) => h.screenshot(sid, join(OUT, name));

const h = createCdpHarness({
  root: ROOT,
  port: 8900 + (process.pid % 90),
  dataPrefix: 'fix-world-view-data-',
  profilePrefix: 'fix-world-view-chrome-',
  serverEnv: { GAME_MODE: 'game', GAME_RULES: '1', BRAIN: 'local', TICK_MS: '10000000', MODEL_UNATTENDED: '0', V73_TEST: '1' },
  readyAttempts: 160,
  waitMs: 40000,
});

// 把 p1 摆到指定 tile（纯表现位置；不按键，不触发 player_sync）。
const placePlayer = (x, z) => `(() => {
  const W = window.__lifeDebug.WALK;
  const key = Object.keys(W).find((k) => k.endsWith(':p1')) ?? Object.keys(W)[0];
  const walker = W[key];
  walker.x = ${x}; walker.y = ${z}; walker.path = []; walker.pi = 0; walker.moving = false;
  return { key, x: walker.x, y: walker.y };
})()`;

const readState = `(() => {
  const cv = document.getElementById('cvA');
  const d = cv?._debug ?? null;
  if (!d) return null;
  const cam = cv._cam?.project3d;
  const p = d.p1;
  let pixel = null, head = null;
  if (cam && p) {
    const [u, v] = cam.project(p[0], p[1] + 1.15, p[2]);
    head = [Math.round(u), Math.round(v)];
    const g = cv.getContext('2d');
    if (u >= 0 && v >= 0 && u < cv.width && v < cv.height) pixel = [...g.getImageData(Math.round(u), Math.round(v), 1, 1).data];
  }
  return {
    tick: d.tick, renderer: d.renderer, coverControl: d.coverControl ?? null,
    covered: d.covered ?? [], occluded: d.occluded ?? [],
    p1: p ?? null, head, pixel,
    climateView: d.climateView ?? null, climateTarget: d.climateTarget ?? null,
    wetness: d.wetness ?? null,
    fadesWallHome: window.__lifeDebug.fadesOccluder('wall:home'),
    fadesRoofHome: window.__lifeDebug.fadesOccluder('roof:home'),
    fadesPen: window.__lifeDebug.fadesOccluder('pen:0'),
    fadesPlot: window.__lifeDebug.fadesOccluder('plot:bed-0'),
    fadesTree: window.__lifeDebug.fadesOccluder('tree:1:2'),
  };
})()`;

const ready = async (sid) => {
  // 截图只抓前台标签页：新开的 page 必须 bringToFront，否则两张 png 会是同一张。
  try { await h.send('Page.bringToFront', {}, sid); } catch { /* 老版本 Chrome 忽略 */ }
  // 默认 800×600 会把 3D 画布挤到折叠线以下：放大视口并把画布滚进视野，截图才拍得到世界。
  await h.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, sid);
  assert(await h.waitFor(async () => Boolean(await h.evaluate('!!window.__lifeDebug?.S', sid))), '页面未就绪');
  assert(await h.waitFor(async () => (await h.evaluate("document.getElementById('cvA')?.dataset.renderer", sid)) === '3d'), '3D 首帧未渲染');
  await h.evaluate("document.getElementById('cvA')?.scrollIntoView({ block: 'center' })", sid);
  await wait(300);
};
// 只存画布本身：与整页截图互补，排除 HUD/滚动位置的影响。
const shotCanvas = async (sid, name) => {
  const dataUrl = await h.evaluate("document.getElementById('cvA').toDataURL('image/png')", sid);
  writeFileSync(join(OUT, name), Buffer.from(String(dataUrl).split(',')[1], 'base64'));
};

try {
  await h.startServer();
  h.startChrome();

  // ── 1) 遮挡：同一机位，淡出开 / 关两张 ────────────────────────────────────
  const frames = {};
  for (const control of ['on', 'off']) {
    const sid = await h.openPage({ url: `${h.origin}/?mode=survival${control === 'off' ? '&cover=none' : ''}`, reducedMotion: true });
    await ready(sid);
    await wait(1200);
    const placed = await h.evaluate(placePlayer(22, 15), sid);   // 居所正后方（北侧）
    await wait(1500);
    const state = await h.evaluate(readState, sid);
    note(`occlusion.${control}`, {
      placed, tick: state.tick, coverControl: state.coverControl, p1: state.p1,
      covered: state.covered, occluded: state.occluded, head: state.head, pixel: state.pixel,
      fades: { wall: state.fadesWallHome, roof: state.fadesRoofHome, pen: state.fadesPen, plot: state.fadesPlot, tree: state.fadesTree },
    });
    frames[control] = state;
    await shot(h, sid, `occlusion-home-north-${control}.png`);
    await shotCanvas(sid, `occlusion-home-north-${control}.canvas.png`);
    if (control === 'on') {
      // 浏览器侧再核一遍桥：默认存档空间里 bridge portal 存在、桥心可站
      const bridge = await h.evaluate(`(() => {
        const world = window.__lifeDebug.buildWorld(window.__lifeDebug.S.view);
        const portal = world.space.camp.portals.find((p) => p.kind === 'bridge') ?? null;
        // 寻路索引（world.walk / movementWalk）与 space 必须同时认这座桥：
        // 桥带 x 39..46, z 33..36 ⇒ 取桥心格 (42,34)；WORLD_TW=120。
        const tile = 34 * 120 + 42;
        // pathGrid 是像素基图对象 {tw,th,walk}（1 tile = 16px）：桥心像素 (42.5,34.5)*16。
        const px = Math.floor(42.5 * 16), pz = Math.floor(34.5 * 16);
        const gridW = world.pathGrid?.tw ?? 0;
        return { crossing: world.space.camp.crossing, bridgeList: world.space.camp.bridgeList, portal,
          walkable: world.space.walkable(42.5, 34.5, ${0.33}), classify: world.space.camp.classify(42.5, 34.5),
          pathWalk: world.walk?.[tile] ?? null, movementWalk: world.movementWalk?.[tile] ?? null,
          pathGridAllows: world.pathGrid ? Boolean(world.pathGrid.walk[pz * gridW + px]) : null };
      })()`, sid);
      note('bridge.browser', bridge);
      assert(bridge.portal, '浏览器里 space 必须有 bridge portal');
      assert(bridge.walkable === true, '浏览器里桥心必须可站');
      assert(bridge.crossing === 34, '浏览器里 crossing 必须由桥带反推为 34');
      assert(bridge.pathWalk === 1 && bridge.movementWalk === 1, '寻路栅格（walk/movementWalk）必须同样认桥');
      assert(bridge.pathGridAllows === true, 'A* 的像素 pathGrid 也必须认桥心');
    }
    await h.cdp.send('Target.closeTarget', { targetId: h.cdp.targets.at(-1) });
  }
  const on = frames.on, off = frames.off;
  assert(on.coverControl === null && off.coverControl === 'none', 'cover=none 对照帧参数未生效');
  assert(on.fadesWallHome === true && on.fadesRoofHome === true, '白名单必须放行 wall:/roof:');
  assert(on.fadesPen === false && on.fadesPlot === false && on.fadesTree === false, '栅栏/田地/树不得淡出');
  assert(on.covered.includes('wall:home') && on.covered.includes('roof:home'),
    `正常帧必须命中墙+屋顶：${JSON.stringify(on.covered)}`);
  assert(on.occluded.includes('wall:home') && on.occluded.includes('roof:home'),
    `正常帧真正淡出集合必须含墙+屋顶：${JSON.stringify(on.occluded)}`);
  assert(off.covered.length === 0 && off.occluded.length === 0, `对照帧的遮挡集合必须为空：${JSON.stringify(off.covered)}`);
  // 像素断言：同一人物位置，淡出帧能看到人物（与遮挡物混色），对照帧只剩不透明建筑。
  assert(on.pixel && off.pixel, '两帧都必须采到人物胸口像素');
  const delta = Math.max(...on.pixel.slice(0, 3).map((v, i) => Math.abs(v - off.pixel[i])));
  note('occlusion.pixel', { on: on.pixel, off: off.pixel, maxChannelDelta: delta });
  assert(delta >= 12, `淡出前后人物胸口像素几乎一样（Δ=${delta}）：人物在正常帧里没有透出来`);

  // ── 2) 天气：拦掉 /world 轮询把服务端状态冻住，只改客户端的 S.view.weather 目标 ──
  // 这正是本条的边界：服务端状态不变，客户端 10–30s 跨 fade。按 100ms 采样 cvA._debug.climateView。
  const wid = await h.openPage({ url: `${h.origin}/?mode=survival`, reducedMotion: false });
  await ready(wid);
  await wait(1200);
  const frozen = await h.evaluate(`(() => {
    // 纯表现层验收：拦掉 /world 轮询，让 S.view 停在当前快照（服务端状态不变）。
    const S = window.__lifeDebug.S;
    if (!window.__worldFetchPatched) {
      const original = window.fetch.bind(window);
      window.__worldFetchPatched = true;
      window.fetch = (url, opts) => String(url).includes('/world') ? new Promise(() => {}) : original(url, opts);
    }
    return { t: S.view?.t, weather: S.view?.weather, season: S.view?.season, disasterToday: S.view?.disasterToday ?? null };
  })()`, wid);
  note('weather.frozen-view', frozen);
  const setWeather = (weather) => h.evaluate(`(() => {
    const S = window.__lifeDebug.S;
    S.view.weather = ${JSON.stringify(weather)};
    S.view.disasterToday = null;   // 只驱动 campClimate 的 rain/cold 两条，不造灾害
    return { weather: S.view.weather, season: S.view.season };
  })()`, wid);
  const collect = async (label, ms, shotAt = []) => {
    const rows = [];
    const began = Date.now();
    const shotDone = new Set();
    while (Date.now() - began < ms) {
      const s = await h.evaluate(readState, wid);
      if (s && s.climateView && s.climateTarget) {
        rows.push({ ms: Date.now() - began, target: s.climateTarget, view: s.climateView, wetness: s.wetness });
        for (const [at, name] of shotAt) if (!shotDone.has(name) && Date.now() - began >= at) { shotDone.add(name); await shot(h, wid, name); }
      }
      await wait(100);
    }
    let maxStep = 0;
    for (let i = 1; i < rows.length; i += 1) maxStep = Math.max(maxStep, Math.abs(rows[i].view.wetness - rows[i - 1].view.wetness));
    const first = rows[0], last = rows.at(-1);
    note(`weather.${label}`, {
      target: first.target, first: first.view, last: last.view,
      firstWetness: first.wetness, lastWetness: last.wetness,
      maxPerSampleWetnessStep: +maxStep.toFixed(4),
      maxPerSampleWindStep: +rows.slice(1).reduce((m, r, i) => Math.max(m, Math.abs(r.view.wind - rows[i].view.wind)), 0).toFixed(4),
      samples: rows.length,
      summary: rows.filter((_, i) => i % 10 === 0 || i === rows.length - 1)
        .map((r) => [r.ms, +r.target.wet.toFixed(3), +r.view.wetness.toFixed(3), +r.view.wind.toFixed(3), +r.view.rain.toFixed(3), +r.view.frost.toFixed(3)]),
    });
    return { rows, first, last, maxStep };
  };

  const before = await h.evaluate(readState, wid);
  const preWetness = before.climateView?.wetness ?? 0;
  note('weather.before', { weather: frozen.weather, wetness: preWetness, view: before.climateView });

  await setWeather('clear');
  const fall = await collect('fall', 24000, [[2500, 'weather-clear-ramp.png'], [23000, 'weather-clear-settled.png']]);
  assert(Math.abs(fall.first.view.wetness - preWetness) < .03, `收雨第一帧 wetness 从 ${preWetness} 直接跳到 ${fall.first.view.wetness}（硬切）`);
  // 单帧上限按"最长 0.5s 帧"给（客户端把 dt 夹在 0.5s 内）：.5/14 ≈ .036；
  // 硬切是 .65 一步到位，两者差一个数量级。
  assert(fall.maxStep < .04, `收雨阶段单个 100ms 采样跳变 ${fall.maxStep}，仍像硬切`);
  assert(Math.abs(fall.last.view.wetness) < .01, `收雨 24s 后 wetness=${fall.last.view.wetness}，应回到 0`);
  assert(Math.abs(fall.last.view.wind - .55) < .01, `收雨后风力=${fall.last.view.wind}，应回到 0.55`);

  await setWeather('rain');
  const rise = await collect('rise', 14000, [[2500, 'weather-rain-ramp.png'], [13000, 'weather-rain-settled.png']]);
  assert(fall.last.view.wetness === rise.first.view.wetness, '收雨/起雨之间不应有跳变');
  assert(rise.maxStep < .04, `起雨阶段单个 100ms 采样跳变 ${rise.maxStep}，仍像硬切`);
  assert(Math.abs(rise.last.view.wetness - .65) < .01, `起雨 14s 后 wetness=${rise.last.view.wetness}，应到 .65`);
  assert(Math.abs(rise.last.view.wind - 1.15) < .01, `起雨 14s 后风力=${rise.last.view.wind}，应到 1.15`);
  // 接线证明：渲染用的 wetness 必须等于过渡层输出
  const consistency = await h.evaluate(readState, wid);
  assert(Math.abs(consistency.wetness - consistency.climateView.wetness) < 1e-9, '渲染 wetness ≠ 过渡层输出');
  note('weather.consistency', { rendered: consistency.wetness, view: consistency.climateView });

  note('gate', { EXP_RENDER_BROWSER: 'ok' });
  writeFileSync(join(OUT, 'browser-world-view.log'), log.map((l) => JSON.stringify(l)).join('\n') + '\n');
  console.log('✔ browser-world-view PASS');
} finally {
  await h.close({ settleMs: 500 });
}
