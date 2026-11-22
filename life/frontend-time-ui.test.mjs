// 1.1 第 4 项：前端世界分钟插值闸门。
//
// 这层只钉"显示"，不碰世界：
//   · 纯函数：两次 /world 之间按 rate/msPerGameMinute 外推，暂停不漂，离线封顶；
//   · 来源契约：前端复用 survival.gameMinutes/serverNow/clock，不造第二套时间；
//   · 接口契约：/world 与 /healthz 都从同一个 simClock 读数（healthz 只给最小投影）；
//   · 浏览器行为由 scripts/pace-1to10-browser.mjs 采集截图与数值，这里不重复起 Chrome。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GAME_MINUTES_PER_DAY, MAX_EXTRAPOLATION_MS, FALLBACK_MS_PER_GAME_MINUTE, FALLBACK_TICK_MS,
  interpolateGameMinutes, gameMinuteOfDay, formatGameClock,
  gameMinutesLeftToday, busyRemainMinutes, clockReadout, clockAnchorFromView, tickMsFromView,
} from '../web/time-view.mjs';

const APP = readFileSync('web/app.js', 'utf8');
const HOST = readFileSync('life/host.mjs', 'utf8');
const TIME_VIEW = readFileSync('web/time-view.mjs', 'utf8');

const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const anchor = (over = {}) => ({
  gameMinutes: 360, at: 1000, rate: 1, msPerGameMinute: 6000, paused: false, ...over,
});

test('FTIME-T1 两次轮询之间按 rate/msPerGameMinute 插值（默认 6000ms/游戏分 = 1:10）', () => {
  assert.equal(FALLBACK_MS_PER_GAME_MINUTE, 6000);
  assert.equal(FALLBACK_TICK_MS, 360000);
  assert.equal(interpolateGameMinutes(anchor(), 0), 360, '同一时刻不得凭空跳分钟');
  assert.equal(interpolateGameMinutes(anchor(), 3000), 360.5, '3s 应走 0.5 游戏分钟');
  assert.ok(close(interpolateGameMinutes(anchor(), 5000), 360 + 5 / 6), '5s 应走 5/6 游戏分钟');
  assert.ok(close(interpolateGameMinutes(anchor(), 6000), 360 + 5 / 6), '显示外推封顶 5s（服务端仍是 1:10 真值）');
  const read = clockReadout(anchor(), 5000);
  assert.equal(formatGameClock(read.minutes), '06:00');
  assert.equal(Math.round(read.minuteOfDay), 361);
  assert.equal(read.leftToday, GAME_MINUTES_PER_DAY - 361, '今日剩余=1440-当日已过分钟');
});

test('FTIME-T2 暂停/零倍速不漂移', () => {
  assert.equal(interpolateGameMinutes(anchor({ paused: true }), 6000), 360);
  assert.ok(close(interpolateGameMinutes(anchor(), 1000), 360 + 1 / 6), '1s 应走 1/6 游戏分钟');
  assert.equal(interpolateGameMinutes(anchor({ rate: 0 }), 60_000), 360, 'rate=0 等同于冻结');
});

test('FTIME-T3 倍速严格按 rate 缩放', () => {
  assert.equal(interpolateGameMinutes(anchor({ rate: 2 }), 3000), 361, '2×：3s=1 游戏分钟');
  assert.ok(close(interpolateGameMinutes(anchor({ rate: 0.5 }), 4000), 360 + 1 / 3), '0.5×：4s=1/3 游戏分钟');
  assert.equal(interpolateGameMinutes(anchor({ rate: 4 }), 3000), 362, '4×：3s=2 游戏分钟');
});

test('T7b HUD 锚点只读服务端 clock：不抖动、缺失回退 6000、暂停/零倍速冻结', () => {
  const view = (clock, over = {}) => ({
    timeMode: 'continuous', gameMinutes: 360, serverNow: 1_000, clock, ...over,
  });
  // 相邻两次 /world 的 serverNow 差再离谱（任何历史抖动），锚点数值必须逐位相同。
  const a = clockAnchorFromView(view({ msPerGameMinute: 6000, rate: 1, paused: false }, { serverNow: 1_000 }), 10);
  const b = clockAnchorFromView(view({ msPerGameMinute: 6000, rate: 1, paused: false }, { serverNow: 9_999_999 }), 20);
  assert.deepEqual({ ...a, at: 0 }, { ...b, at: 0 }, 'serverNow 不得参与速度估计');
  assert.equal(a.msPerGameMinute, 6000);
  assert.equal(a.rate, 1);
  // 服务端给了非标称速率就用它；只有 clock 缺失/字段缺失才回退 6000。
  assert.equal(clockAnchorFromView(view({ msPerGameMinute: 250, rate: 1 })).msPerGameMinute, 250);
  assert.equal(clockAnchorFromView(view(undefined)).msPerGameMinute, FALLBACK_MS_PER_GAME_MINUTE);
  assert.equal(clockAnchorFromView(view({ rate: 1 })).msPerGameMinute, 6000);
  assert.equal(clockAnchorFromView(view(undefined)).rate, 1);
  // 暂停与 rate=0 都冻结；rate=0 即使 clock 缺 msPerGameMinute 也不得回退成继续走。
  for (const clock of [{ msPerGameMinute: 6000, rate: 1, paused: true }, { msPerGameMinute: 6000, rate: 0 }]) {
    const frozen = clockAnchorFromView(view(clock));
    const read = clockReadout(frozen, 60_000);
    assert.equal(read.minutes, 360, `clock=${JSON.stringify(clock)} 必须冻结`);
  }
  assert.equal(clockAnchorFromView(view(undefined)).paused, false);
  assert.equal(clockAnchorFromView({ ...view(undefined), timeMode: 'legacy' }), null);
});

test('FTIME-T4 离线/掉轮询时外推封顶 5s，不无限漂', () => {
  assert.equal(MAX_EXTRAPOLATION_MS, 5000);
  assert.ok(close(interpolateGameMinutes(anchor(), 4000), 360 + 4 / 6), '4s 内仍按 rate 走');
  assert.ok(close(interpolateGameMinutes(anchor(), 60_000), 360 + 5 / 6), '超过 5s 只算 5s（+0.833 分）');
  assert.equal(interpolateGameMinutes(anchor(), -1000), 360, '负 elapsed 不得倒流');
});

test('FTIME-T5 busy 进度按分钟插值，只显示不提前结算', () => {
  assert.equal(busyRemainMinutes({ endMin: 500, remainMin: 120 }, 430, 360), 70, '连续路径用 endMin 精确插值');
  assert.equal(busyRemainMinutes({ endMin: 500, remainMin: 120 }, 500, 360), 0, '到点只显示 0，完成仍等 /world');
  assert.equal(busyRemainMinutes({ endMin: 500, remainMin: 120 }, 560, 360), 0, '越界钳到 0，不出现负数');
  assert.equal(busyRemainMinutes({ remainMin: 30 }, 370, 360), 20, '旧路径无 endMin 时按锚点差插值');
  assert.equal(busyRemainMinutes(null, 400, 360), null);
});

test('FTIME-T6 今日剩余与时刻格式可读、跨日归零', () => {
  assert.equal(formatGameClock(0), '00:00');
  assert.equal(formatGameClock(390), '06:30');
  assert.equal(formatGameClock(1439), '23:59');
  assert.equal(gameMinutesLeftToday(390), 1050);
  assert.equal(gameMinutesLeftToday(1439), 1);
  assert.equal(gameMinutesLeftToday(1440), GAME_MINUTES_PER_DAY, '跨日回到 1440，不出现 0 或负数');
  assert.equal(gameMinutesLeftToday(-1), 1, '负分钟按模归一到当日');
  assert.equal(gameMinuteOfDay(1440 + 390), 390);
});

test('T7 前端复用 /world 的同一时钟字段，rAF 只改显示', () => {
  assert.match(APP, /from '\.\/time-view\.mjs'/, '插值函数必须是可单测的独立模块');
  assert.match(APP, /function setClockAnchor\(view\)/, '缺少每次轮询重锚');
  assert.match(APP, /view\?\.timeMode === 'continuous'|view\?\.timeMode !== 'continuous'/, '只对连续世界启用插值');
  assert.match(APP, /view\?\.gameMinutes/, '时间来源必须是 /world 的 gameMinutes');
  assert.match(TIME_VIEW, /view\.clock \?\? \{\}/, '必须复用服务端 clock，不能造第二套');
  assert.match(TIME_VIEW, /clock\.msPerGameMinute/, 'msPerGameMinute 必须复用服务端 clock');
  assert.match(APP, /clockAnchorFromView\(view, performance\.now\(\)\)/, 'HUD 锚点必须走纯函数、只读服务端 clock');
  assert.match(APP, /paintClockHud\(now\)/, 'rAF 主循环没有驱动 HUD 时钟');
  assert.match(APP, /requestAnimationFrame\(animate\)/, '必须用 rAF 而不是新定时器');
  assert.match(APP, /data-hud="dayleft"/, '今日剩余缺少稳定更新锚点');
  assert.match(APP, /data-hud="busy"/, 'busy 进度缺少稳定更新锚点');
  assert.match(APP, /hudClockHiddenAt/, '页面隐藏时必须冻结显示而不是跨隐藏补时间');
  const paint = APP.slice(APP.indexOf('function paintClockHud('), APP.indexOf('// 页面隐藏：'));
  assert.ok(paint.length > 100, 'paintClockHud 不存在或位置变了');
  assert.doesNotMatch(paint, /fetch\(|postJson|Math\.random|\bapi\(|\/act/, '插值只读显示：不得请求、不得消费 RNG、不得写世界');
  const anchorFn = APP.slice(APP.indexOf('function setClockAnchor('), APP.indexOf('function hudClockReadout('));
  assert.ok(anchorFn.length > 50, 'setClockAnchor 不存在或位置变了');
  assert.doesNotMatch(anchorFn, /serverNow|deltaMinutes|deltaMs|observed|delta\s*Minutes/,
    'setClockAnchor 不得用相邻轮询差分自估速度');
  assert.doesNotMatch(APP, /hudLastClockSample/, 'HUD 自估速度的样本状态必须删除');
});

test('T7c 表现层一刻长度：连续世界读 clock（60×6000），旧/冻结路径才回落 tickMs', () => {
  assert.equal(tickMsFromView({ timeMode: 'continuous', clock: { msPerGameMinute: 6000 } }), 360000,
    '正式 1:10 下一刻=60×6000ms，不得再假设 7500');
  assert.equal(tickMsFromView({ timeMode: 'continuous', clock: { msPerGameMinute: 6000, rate: 2 } }), 360000,
    '倍速不改变一刻的真实长度基数');
  assert.equal(tickMsFromView({ tickMs: 7500 }), 7500, '研究态/旧路径保留自己的整拍');
  assert.equal(tickMsFromView({ tickMs: 10_000_000 }), 10_000_000, '冻结世界读数原样保留；只在玩家步长处归一');
  assert.equal(tickMsFromView(undefined), 7500);
});

test('T8 玩家 timeLeft 在连续世界是日统计、不是配额，HUD 不得把它当资源', () => {
  assert.match(APP, /今日动作已用/, '日统计必须以"已用"呈现');
  assert.doesNotMatch(APP, /今日剩余[\s\S]{0,80}timeLeft/, '不得把 timeLeft 显示成今日剩余资源');
});

test('T9 /healthz 只投影最小时钟（同一 simClock，不暴露 anchor/路径/密钥）', () => {
  assert.match(HOST, /function statusClock\(\)/, '缺少 healthz 时钟投影');
  assert.match(HOST, /clock: statusClock\(\)/, 'status 没有挂 clock');
  const body = HOST.slice(HOST.indexOf('function statusClock('), HOST.indexOf('function statusClock(') + 700);
  for (const key of ['gameMinutes', 'msPerGameMinute', 'rate', 'paused']) {
    assert.ok(body.includes(key), `healthz clock 缺 ${key}`);
  }
  assert.doesNotMatch(body, /anchorMs|pausedAtMs|DATA_DIR|API_KEY|TOKEN/, 'healthz 不得暴露内部锚点/路径/密钥');
});

// ───────────────────────── 真 HTTP：/world 与 /healthz 同源 ─────────────────────────

function bootServer() {
  // 端口按进程号取，避免测试里出现 Math.random（lint 要求测试也可复现）。
  const port = 17000 + (process.pid % 800);
  const dir = mkdtempSync(join(tmpdir(), 'ambrace-v11-time-'));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['serve.mjs'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir,
        SEED_FILE: join(dir, 'no-seed.json'),
        GAME_MODE: 'game', GAME_RULES: '1', SIM_TIME: '1',
        GAME_MS_PER_MINUTE: '6000', TICK_MS: '360000',
        BRAIN: 'local', MODEL_PROVIDERS: '', MODEL_KEYS: '', MODEL_KEY: '', MODEL_NAME: '', CHAT_TOKEN: '',
        MODEL_UNATTENDED: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('服务器 15s 内没起来：' + out)); }, 15000);
    const onData = (d) => {
      out += d.toString();
      if (out.includes('就绪')) { clearTimeout(timer); resolve({ child, base: `http://127.0.0.1:${port}`, dir }); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`服务器提前退出 ${code}：${out}`)); });
  });
}

const post = (base, path, body) => fetch(`${base}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
});

test('FTIME-T10 真 HTTP：/world 与 /healthz 暴露同一世界分钟，暂停/倍速可见', async () => {
  const { child, base } = await bootServer();
  try {
    const world = await (await fetch(`${base}/world?mode=survival`)).json();
    const s = world.survival;
    assert.ok(s, '/world 没有 survival 视图');
    assert.equal(s.timeMode, 'continuous', '正式生存世界必须走连续时钟');
    assert.ok(Number.isFinite(s.gameMinutes), '/world 缺 gameMinutes');
    assert.ok(Number.isFinite(s.serverNow), '/world 缺 serverNow');
    assert.equal(s.clock?.msPerGameMinute, 6000, '正式默认必须是 6000ms/游戏分');
    assert.equal(s.clock?.rate, 1);
    assert.equal(s.clock?.paused, false);

    let health = await (await fetch(`${base}/healthz`)).json();
    assert.ok(health.world?.clock, '/healthz 缺 world.clock');
    assert.ok(Number.isFinite(health.world.clock.gameMinutes), 'healthz clock.gameMinutes 不是数字');
    assert.equal(health.world.clock.msPerGameMinute, s.clock.msPerGameMinute, '两个端点的 msPerGameMinute 必须同源');
    for (const leaked of ['anchorMs', 'pausedAtMs', 'DATA_DIR', 'secret']) {
      assert.ok(!JSON.stringify(health.world.clock).includes(leaked), `healthz clock 泄露 ${leaked}`);
    }
    assert.ok(Math.abs(health.world.clock.gameMinutes - s.gameMinutes) < 5, '两个端点读到的世界分钟应基本一致');

    // 1:10：同一段真实时间在服务端走 1/6000 游戏分每毫秒（这里只取 1.2s，约 0.2 分）。
    const before = await (await fetch(`${base}/healthz`)).json();
    const t0 = Date.now();
    await new Promise((r) => setTimeout(r, 1200));
    const after = await (await fetch(`${base}/healthz`)).json();
    const realMin = (Date.now() - t0) / 60000;
    const gameMin = after.world.clock.gameMinutes - before.world.clock.gameMinutes;
    assert.ok(Math.abs(gameMin / realMin - 10) < 0.6, `现实/游戏分钟比应≈1:10，实测 1:${(gameMin / realMin).toFixed(2)}`);

    assert.equal((await post(base, '/ctl', { action: 'pause', confirm: true })).status, 200);
    await new Promise((r) => setTimeout(r, 150));
    const paused = await (await fetch(`${base}/healthz`)).json();
    assert.equal(paused.world.clock.paused, true, '暂停后 healthz 必须报 paused:true');
    const p0 = paused.world.clock.gameMinutes;
    await new Promise((r) => setTimeout(r, 700));
    const p1 = await (await fetch(`${base}/healthz`)).json();
    assert.equal(p1.world.clock.gameMinutes, p0, '暂停期间世界分钟不得前进');

    assert.equal((await post(base, '/ctl', { action: 'rate', rate: 2, confirm: true })).status, 200);
    await new Promise((r) => setTimeout(r, 150));
    const fast = await (await fetch(`${base}/healthz`)).json();
    assert.equal(fast.world.clock.rate, 2, '倍速后 healthz 必须报 rate:2');
    assert.equal(fast.world.clock.paused, true, '换挡不得自己恢复世界');

    assert.equal((await post(base, '/ctl', { action: 'resume', confirm: true })).status, 200);
    await new Promise((r) => setTimeout(r, 500));
    const moved = await (await fetch(`${base}/healthz`)).json();
    assert.equal(moved.world.clock.paused, false);
    assert.ok(moved.world.clock.gameMinutes > fast.world.clock.gameMinutes, 'rate=2 恢复后 500ms 内世界分钟应前进');
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 400));
  }
});
