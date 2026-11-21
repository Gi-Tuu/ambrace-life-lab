// 1.3 幽魂观察状态（玩家死亡 → 观察者，不是终局）。
//
// 语义边界：
//   · 正式世界（world.independentWorld === true）里，玩家存续归零后仍留在世界里，只是失去身体：
//     不能再采集/建造/攻击/吃/睡/交易/移动实体；世界照常 tick，居民继续生活。
//   · 真正的结局只有聚落灭绝（livingResidents(world).length === 0），由 worldstate.advanceSurvival 判定。
//   · 研究/对照态（!independentWorld）保持 1.2 原行为（玩家死亡＝failed/endReason 'player'），
//     这里的状态只由正式世界的 reapDeaths / loadSurv 调用，不写研究态字段。
//
// 状态只读投影给客户端（camera 锚点 / HUD），不参与任何裁决；位置仍是 w.pos 的派生读法。
import { dayOf } from './clock.mjs';

const finite = (v) => Number.isFinite(v);
const worldSpace = (pos) => {
  if (!pos || !finite(pos.x) || !finite(pos.z)) return null;
  return (pos.space ?? 'world') === 'world' ? { x: pos.x, z: pos.z } : null;
};

// 幽魂镜头锚点：死亡时的室外脚点优先；室内死亡由 reapDeaths 传门外的世界点。
export function ghostAnchor(world, fallback = null) {
  return worldSpace(world?.pos?.p1)
    ?? (fallback && finite(fallback.x) && finite(fallback.z) ? { x: fallback.x, z: fallback.z } : null)
    ?? worldSpace(world?.survival?.playerPos);
}

// 死亡瞬间写状态（只由 reapDeaths 调）。cause/at 由收尸逻辑给出，保持可复现。
export function markGhost(world, { cause = null, at = null } = {}) {
  const s = world?.survival;
  if (!s) return null;
  const anchor = at && finite(at.x) && finite(at.z) ? { x: at.x, z: at.z } : ghostAnchor(world);
  s.playerDead = true;
  s.ghost = { active: true, since: world.t, day: dayOf(world.t), cause, at: anchor };
  return s.ghost;
}

// 读档兼容：旧档可能只有 minds.p1.dead / playerDead，没有 ghost 字段；补齐但不伪造死亡时间。
export function restoreGhost(world, { cause = null, at = null } = {}) {
  const s = world?.survival;
  if (!s) return null;
  const dead = Boolean(s.playerDead) || Boolean(world?.agents?.p1?.dead);
  if (!dead) {
    if (s.ghost) s.ghost = { ...s.ghost, active: false };
    return s.ghost ?? null;
  }
  const prev = s.ghost ?? {};
  const death = world?.agents?.p1?.death ?? null;
  const anchor = (prev.at && finite(prev.at.x) && finite(prev.at.z) ? { x: prev.at.x, z: prev.at.z } : null)
    ?? (at && finite(at.x) && finite(at.z) ? { x: at.x, z: at.z } : null)
    ?? ghostAnchor(world);
  s.playerDead = true;
  s.ghost = {
    active: true,
    since: prev.since ?? death?.t ?? world.t,
    day: prev.day ?? death?.day ?? dayOf(world.t),
    cause: prev.cause ?? cause ?? death?.cause ?? null,
    at: anchor,
  };
  return s.ghost;
}

// 只读视图：active=已死（状态持久）；observing=已死且聚落未灭绝（可以观察）。
export function ghostView(world) {
  const s = world?.survival;
  if (!s) return { active: false, observing: false, since: null, day: null, cause: null, at: null };
  const death = world?.agents?.p1?.death ?? null;
  const active = Boolean(s.playerDead) || Boolean(world?.agents?.p1?.dead);
  const anchor = (s.ghost?.at && finite(s.ghost.at.x) && finite(s.ghost.at.z))
    ? { x: s.ghost.at.x, z: s.ghost.at.z }
    : ghostAnchor(world);
  return {
    active,
    observing: active && !s.ended,
    since: s.ghost?.since ?? death?.t ?? null,
    day: s.ghost?.day ?? death?.day ?? null,
    cause: s.ghost?.cause ?? death?.cause ?? null,
    at: anchor,
  };
}
