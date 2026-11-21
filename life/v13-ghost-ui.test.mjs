// 1.3 幽魂 · 客户端接线静态闸门（真实行为由 scripts/v13-ghost-browser.mjs 验）。
// 只钉“必须有这条接线、且不能退回 1.2 的终局文案/操作入口”，防止后续重构把幽灵玩家又锁回原地。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const APP = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('../web/app.css', import.meta.url), 'utf8');

test('V13-UI-01 幽魂状态只从 solo 的 player.dead 推导，viewport 加 ghost-mode', () => {
  assert.match(APP, /function ghostActive\(\)[\s\S]{0,220}v\.player\?\.dead/);
  assert.match(APP, /document\.body\.classList\.toggle\('ghost-mode', on\)/);
  assert.match(CSS, /body\.ghost-mode #hotbar/);
});

test('V13-UI-02 死亡横幅是“你已化为幽魂，聚落仍在继续”，旧“你倒下了…结束了”不得回流', () => {
  assert.match(APP, /你已化为幽魂，聚落仍在继续/);
  assert.doesNotMatch(APP, /你倒下了。营地还在，但这一局属于你结束了/);
  // 先判 ended（灭绝终局），再判幽魂。
  assert.match(APP, /const banner = s\.ended[\s\S]{0,600}: ghost[\s\S]{0,300}你已化为幽魂/);
});

test('V13-UI-03 幽魂镜头：独立 ghostCam + WASD 平移 + 滚轮缩放 + 跟随时不写玩家', () => {
  assert.match(APP, /let ghostCam = null/);
  assert.match(APP, /function ghostClamp\(/);
  assert.match(APP, /const ghost=!historical && !right && ghostActive\(\)/);
  assert.match(APP, /ghost\?ghostSpanNow\(\):Math\.min\(29/);
  assert.match(APP, /ghostCam\.span = Math\.max\(GHOST_SPAN_MIN/);
  assert.match(APP, /if \(player && ghost\) \{ walker\.moving=false; continue; \}/);
  assert.match(APP, /if \(ghostActive\(\)\) return; \/\/ 1\.3：幽魂不移动实体/);
});

test('V13-UI-04 幽魂雾视野关闭、p1 不画、动作入口在前端先拒', () => {
  assert.match(APP, /!overview && !ghost && pTile/);
  assert.match(APP, /if \(ghost && slots\.p1\) delete slots\.p1/);
  assert.match(APP, /if \(!compare && typeof ghostActive === 'function' && ghostActive\(\)\)/);
  assert.match(APP, /你已化为幽魂，无法触碰活人的世界/);
});

test('V13-UI-05 观察控制复用世界暂停/倍速，跟随/全景可用', () => {
  assert.match(APP, /function runGhostControl/);
  assert.match(APP, /action: S\.running \? 'pause' : 'resume'/);
  assert.match(APP, /action: 'rate', rate: next/);
  assert.match(APP, /data-ghost="follow"/);
  assert.match(APP, /data-ghost="overview"/);
});

test('V13-UI-06 HUD 不再显示体力/行动，改“幽魂观察”', () => {
  assert.match(APP, /if \(!ui\.compare && view\.player\?\.dead\) \{\s*ph\.innerHTML = `[^`]*幽魂观察/);
  assert.match(APP, /幽魂 · 观察中/);
});
