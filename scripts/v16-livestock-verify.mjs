#!/usr/bin/env node
// 1.6 浏览器验收：圈舍实体/门洞/碰撞/淡出、HUD 体力来源、休息与睡眠的真实数值。
// 动作走页面同源 /act；几何读客户端 buildWorld().space；结果写 evidence/v16-livestock/browser.json。
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCdpHarness } from './lib/cdp-harness.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'evidence', 'v16-livestock');
mkdirSync(OUT, { recursive: true });
const h = createCdpHarness({
  root: ROOT,
  port: 9800 + (process.pid % 90),
  dataPrefix: 'v16-livestock-data-',
  profilePrefix: 'v16-livestock-chrome-',
  serverEnv: {
    GAME_MODE: 'game', GAME_RULES: '1', BRAIN: 'local',
    GAME_MS_PER_MINUTE: '6000', TICK_MS: '360000',
    MODEL_UNATTENDED: '0', V73_TEST: '1',
  },
});
const assert = (cond, message) => { if (!cond) throw new Error(message); };
const post = (path, body) => h.post(path, body);
const act = async (body) => (await post('/act', { mode: 'survival', ...body })).body;
const ctl = async (body) => (await post('/ctl', { confirm: true, ...body })).body;
const result = { at: new Date().toISOString(), checks: {}, geometry: {}, energy: {} };

try {
  await h.startServer();
  h.startChrome();
  const sid = await h.openPage({ url: `${h.origin}/` });
  assert(await h.waitFor(async () => Boolean(await h.evaluate('!!window.__lifeDebug?.S', sid))), '页面未就绪');
  await h.wait(700);
  await h.evaluate(`document.querySelector('#startSurvival').click()`, sid);
  assert(await h.waitFor(async () => await h.evaluate('window.__lifeDebug.S.playing === true', sid)), '没有进入生存');
  await h.wait(900);

  // ── 1. 圈舍几何/门洞/淡出 ───────────────────────────────────────────────
  result.geometry = await h.evaluate(`(() => {
    const S = window.__lifeDebug.S, w = window.__lifeDebug.buildWorld(S.view);
    const own = w.scene3d.boxes.filter((b) => b.occluder?.startsWith('livestock:'));
    const pens = w.scene3d.boxes.filter((b) => b.occluder?.startsWith('pen:'));
    const doors = Object.fromEntries(['yard','chickens','cows','sheep','fodder'].map((id) => {
      const p = { yard:[20.5,34.0], chickens:[7.5,31.5], cows:[14.0,31.5], sheep:[7.5,33.0], fodder:[14.0,33.0] }[id];
      return [id, p];
    }));
    return {
      livestock: S.view.livestock,
      layout: S.view.layout ?? null,
      ownBoxes: own.length,
      ownSolid: own.filter((b) => b.solid).length,
      fenceBoxes: pens.length,
      penGroups: [...new Set(w.scene3d.boxes.filter((b) => b.occluder?.startsWith('livestock:')).map((b) => b.occluder))],
      fade: {
        roof: window.__lifeDebug.fadesOccluder('livestock:chickens:roof'),
        wall: window.__lifeDebug.fadesOccluder('livestock:cows'),
        fence: window.__lifeDebug.fadesOccluder('pen:north'),
      },
      gates: Object.fromEntries(Object.entries(doors).map(([id, p]) => [id, w.space.walkable(p[0], p[1], .33)])),
    };
  })()`, sid);
  assert(result.geometry.ownBoxes >= 120, `圈舍实体不足：${result.geometry.ownBoxes}`);
  assert(result.geometry.ownSolid >= 20, `圈舍实体碰撞不足：${result.geometry.ownSolid}`);
  assert(result.geometry.penGroups.some((x) => x === 'livestock:chickens:roof'), '鸡舍屋顶没有独立淡出组');
  assert(result.geometry.fade.roof === true && result.geometry.fade.wall === true, '牲畜圈舍未纳入遮挡淡出');
  assert(result.geometry.fade.fence === false, '围栏不应整圈淡出');

  // ── 2. HUD 写清四条恢复来源 ─────────────────────────────────────────────
  await h.wait(900);
  const hud = await h.evaluate(`(() => {
    const panel = document.querySelector('#survPanel')?.textContent ?? '';
    const title = document.querySelector('#playerHud .stat')?.getAttribute('title') ?? '';
    return { panel, title, restButton: Boolean(document.querySelector('#btnCampRest')),
      rules: window.__lifeDebug.S.view.energyRules ?? null };
  })()`, sid);
  result.checks.hud = { hasSleep: /睡觉 \+0\.15/.test(hud.panel), hasRest: /休息 30 分 \+0\.06/.test(hud.panel),
    hasShelter: /棚下休息 \+0\.15/.test(hud.panel), hasEat: /吃饭 \+0\.5/.test(hud.panel), title: hud.title, rules: hud.rules };
  assert(hud.rules && hud.rules.sleepPerHour === .15 && hud.rules.restAmount === .06, 'survView 未下发体力规则');
  assert(result.checks.hud.hasSleep && result.checks.hud.hasRest && result.checks.hud.hasShelter && result.checks.hud.hasEat,
    `HUD 没有写清四条恢复来源：${JSON.stringify(hud.panel.slice(0, 300))}`);

  // ── 3. 休息：30 分 +0.06、同小时冷却；真实 /act ──────────────────────────
  const mvHall = await act({ kind: 'move', room: 'hall' });
  assert(mvHall?.ok, `走连廊失败：${JSON.stringify(mvHall)}`);
  const beforeRest = (await ctl({ action: 'v73_state' })).energy;
  const rest = await act({ kind: 'camp_rest' });
  const afterRest = (await ctl({ action: 'v73_state' })).energy;
  const restAgain = await act({ kind: 'camp_rest' });
  result.energy.rest = { before: beforeRest, after: afterRest, gain: rest?.gain, code: rest?.code,
    secondCode: restAgain?.code, minutes: (await ctl({ action: 'v73_state' })).usedMin };
  assert(rest?.ok && rest.gain === .06, `休息没有 +0.06：${JSON.stringify(rest)}`);
  assert(afterRest > beforeRest, '休息后体力没有上升');
  assert(restAgain?.code === 'REST_COOLDOWN', `同小时可重复休息：${restAgain?.code}`);

  // ── 4. 睡眠：按实际小时结算；HUD 提示 + 恢复 ────────────────────────────
  const mvHome = await act({ kind: 'move', room: 'home' });
  assert(mvHome?.ok, `走回家失败：${JSON.stringify(mvHome)}`);
  const beforeSleep = (await ctl({ action: 'v73_state' })).energy;
  const sleep = await act({ kind: 'camp_sleep' });
  const afterSleep = (await ctl({ action: 'v73_state' })).energy;
  result.energy.sleep = { before: beforeSleep, after: afterSleep, ticks: sleep?.ticks,
    recovery: sleep?.recovery, code: sleep?.code };
  assert(sleep?.ok, `睡眠失败：${JSON.stringify(sleep)}`);
  assert(sleep.recovery && sleep.recovery.gain > 0, `睡眠没有恢复体力：${JSON.stringify(sleep)}`);
  assert(afterSleep > beforeSleep, `睡眠后体力没有上升：${beforeSleep} → ${afterSleep}`);

  // ── 5. 截图（标题全景能看到院落） ───────────────────────────────────────
  await h.screenshot(sid, join(OUT, 'survival.png'));
  const title = await h.newPage({});
  await h.navigate(title, `${h.origin}/`);
  await h.waitFor(async () => Boolean(await h.evaluate('Boolean(document.getElementById("startScene")?.dataset.renderer)', title)), 40000);
  await h.wait(800);
  await h.screenshot(title, join(OUT, 'title-pens.png'));

  result.ok = true;
  writeFileSync(join(OUT, 'browser.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} finally {
  await h.close({ settleMs: 300 });
}
