// 场景适配器接口（引擎 ↔ 场景的边界）。
// 目的：引擎（Organism / 评分 / 规则调度 / 宿主 / 判据方法）只依赖这一组字段，换题材时替换实现而不是改引擎。
// 现状（赛期）：默认场景 = 现有 body.mjs / rules.mjs / clock.mjs 的实现，以**同一引用**挂上来，保证零漂移；
// 冻结后再把默认实现搬进 scenes/，并让 Organism 持有场景实例（那一步要动 agent.mjs，赛期与并行工作冲突）。
import { LOCS, BASE_KINDS, makeWorld, spawn, move, perceptsAt, affordancesFor, actuate, addSecret, scanSecrets, hail, isHailed } from './body.mjs';
import { validate, impulseOf, canTell, markKnown, actionId } from './rules.mjs';
import { phaseOf, dayOf, isNight, scheduledLoc, SCHEDULE } from './clock.mjs';

// 引擎真正用到的字段：缺一个，世界/动作闭环就断，因此契约要逐项点名
export const SCENE_FIELDS = [
  'id',
  'locs', 'kinds',
  'makeWorld', 'spawn', 'move', 'perceptsAt',
  'affordancesFor', 'actuate',
  'addSecret', 'scanSecrets',
  'validate', 'impulseOf', 'canTell', 'markKnown', 'actionId',
  'phaseOf', 'dayOf', 'isNight',
  'schedule', 'scheduledLoc',
  'hail', 'isHailed',
];

export function assertScene(scene, label = 'scene') {
  const missing = SCENE_FIELDS.filter((k) => scene?.[k] === undefined || scene?.[k] === null);
  if (missing.length) throw new Error(`场景「${label}」缺字段：${missing.join(', ')}`);
  return scene;
}

// 定义/变体：overrides 只覆盖差异项，其余沿用默认场景
export function defineScene(scene, label = scene?.id ?? 'scene') {
  return assertScene(scene, label);
}

export function extendScene(overrides = {}) {
  return defineScene({ ...DEFAULT_SCENE, ...overrides }, overrides.id ?? `${DEFAULT_SCENE.id}+variant`);
}

export const DEFAULT_SCENE = defineScene({
  id: 'four-rooms',
  locs: LOCS,
  kinds: BASE_KINDS,
  makeWorld,
  spawn,
  move,
  perceptsAt,
  affordancesFor,
  actuate,
  addSecret,
  scanSecrets,
  validate,
  impulseOf,
  canTell,
  markKnown,
  actionId,
  phaseOf,
  dayOf,
  isNight,
  schedule: SCHEDULE,
  scheduledLoc,
  hail,
  isHailed,
}, 'four-rooms');
