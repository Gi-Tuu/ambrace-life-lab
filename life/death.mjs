// 死亡收尸与死亡史封顶（1.3 从 survplay.mjs 拆出，避免世界推进模块职责回流）。
//
// 口径与 1.2 完全相同：存续归零 → dead/death/死亡史、移出占位、婚姻/住房结算；
// 唯一新增是正式世界里玩家死亡时写幽魂状态（markGhost），研究/对照态保持 failed/endReason='player'。
import { dayOf } from './clock.mjs';
import { clearTravel, detachPlayerRoom, removeActor } from './actor-pos.mjs';
import { settleMarriages, settleHousing } from './households.mjs';
import { roomDoorPoint } from './construction-access.mjs';
import { markGhost } from './ghost.mjs';

// DATA5-13：deaths 随 survival 整块入档，长期运行必须封顶；总死亡数单独累计。
export const DEATHS_CAP = 200;
export function trimDeaths(deaths, cap = DEATHS_CAP) {
  if (!Array.isArray(deaths)) return deaths;
  if (deaths.length > cap) deaths.splice(0, deaths.length - cap);
  return deaths;
}

// P0-1 统一收尸：每拍末调用一次，覆盖代谢/动作/饥饿/伤害所有致死路径。
// 死亡不可逆：dead 一旦置位，决策环/配给/繁衍/施工/床位全部排除；历史保留可查询。
export function reapDeaths(w, log) {
  const s = w.survival;
  let changed = false;
  for (const a of Object.values(w.agents)) {
    if (a.dead || !a.viab || a.viab.v > 0) continue;
    if (s.districtTravel) clearTravel(w, a.id);
    changed = true;
    a.dead = true;
    const cause = a.hurtBy ?? '衰竭';
    a.death = { t: w.t, day: dayOf(w.t), cause };
    (s.deaths ??= []).push({ id: a.id, name: a.name, t: w.t, day: dayOf(w.t), cause });
    s.deathTotal = (s.deathTotal ?? 0) + 1;
    trimDeaths(s.deaths);
    removeActor(w, a.id);
    log.push({ t: w.t, kind: 'death', ok: true, code: `${a.name}死亡（${cause}）` });
    if (a.isPlayer) {
      s.playerDead = true;
      // 1.3：正式世界里玩家死亡不是终局，而是转入幽魂观察（否则“个人死亡/聚落灭绝”两种结局会混在一起）。
      // 镜头锚点取死时的室外脚点；室内死亡取这扇门外的世界点，避免把 16×12 房间坐标当世界坐标。
      if (w.independentWorld) {
        const room = w.campPlayerRoom;
        const door = room ? roomDoorPoint(w, room) : null;
        markGhost(w, { cause, at: door ? { x: door[0], z: door[1] } : null });
      }
      // 幽魂不能把死前排进时间轴的长动作做完：死亡当刻取消 busy（不结算效果、不扣体力）。
      if (s.actClock?.p1?.busy) s.actClock.p1.busy = null;
      // P2c：死亡 = 从室内镜像回到世界空间；位置仍由 w.pos 保留（幽魂镜头锚点要用）。
      detachPlayerRoom(w);
      // 研究/对照态保持 1.2 原语义（这一层是研究 md5 与历史闸门的基线）。
      if (!w.independentWorld) { s.failed = true; s.endReason = 'player'; }
      s.talk = null;
    }
  }
  if (changed) {
    settleMarriages(w);
    settleHousing(w, log);
  }
  return changed;
}
