// 1.4 玩家主动对话：居民注意力（纯状态 + 生命周期）。
//
// 口径：
//   · 一次成功交谈只买"当拍"：`attention.until = world.t + 1`（旧刻语义），
//     连续世界再带 `untilMin = 当前游戏分钟 + 1`（分钟等价）。
//   · 当拍里该居民不推进手中劳动进度、不继续远行、不派发新决策；
//     busy/travel 本身不取消，已落账的施工进度/体力不回收。
//   · 连续世界：下一分钟仍算"当拍"（居民停一下），该分钟末统一清掉；
//     再下一分钟进度自动恢复。旧刻语义：下一整刻开头清掉。
//   · 过期判定只读；清理只在 expireResidentAttention() 里发生。
import { simMinuteNow } from './sim-clock.mjs';

const ATTENTION_MINUTES = 1;

// 窗口是否仍然生效（advanceResidentBusy/advanceTravels/决策派发读这个）。
export function attentionActive(world, attention) {
  if (!attention) return false;
  if (world?.simClock) return simMinuteNow(world) <= attention.untilMin;
  return Number(world.t) < attention.until;
}

// 是否已经可以清掉（连续世界在"当拍那一分钟"的末尾清）。
export function attentionExpired(world, attention) {
  if (!attention) return true;
  if (world?.simClock) return simMinuteNow(world) >= attention.untilMin;
  return Number(world.t) >= attention.until;
}

export function markResidentAttention(world, id, { about = 'p1', minutes = ATTENTION_MINUTES } = {}) {
  const agent = world?.agents?.[id];
  if (!agent || agent.isPlayer || agent.dead) return null;
  const nowMin = simMinuteNow(world);
  const attention = {
    about,
    until: Number(world.t) + 1,
    untilMin: nowMin + Math.max(1, Number(minutes) || ATTENTION_MINUTES),
    since: Number(world.t),
    sinceMin: nowMin,
  };
  agent.attention = attention;
  return attention;
}

// 只读：当前是否处于注意力窗口。不做清理。
export function residentAttention(world, id) {
  const attention = world?.agents?.[id]?.attention;
  return attentionActive(world, attention) ? attention : null;
}

// 每拍/每分钟末调用：把过期注意力清掉（下一刻自动清掉）。
export function expireResidentAttention(world) {
  let cleared = 0;
  for (const agent of Object.values(world?.agents ?? {})) {
    if (agent?.attention && attentionExpired(world, agent.attention)) {
      delete agent.attention;
      cleared += 1;
    }
  }
  return cleared;
}

// 视图投影：只在窗口内出现；研究态/无注意力时字段不出现。
export function residentAttentionView(world, agent) {
  const attention = residentAttention(world, agent?.id);
  if (!attention) return null;
  return { about: attention.about, until: attention.until, untilMin: attention.untilMin };
}
