// 生存营地动作入口：玩家在聚落/外围的建造、住房、设施、家庭、营地与规则层动作。
// 这里只裁决“能不能、做了什么”并结算世界侧后果；时间/体力预算与账本在 survplay-actions。
import { move, actuate, isAlive, SURV_COST } from './body.mjs';
import { validate, validateCamp } from './rules.mjs';
import { noteWorkMotion } from './work-motion.mjs';
import { regionPoint } from '../shared/camp-region-entities.mjs';
import { inCamp } from '../shared/wild-landscape.mjs';
import { animalAction } from './camp-animals.mjs';
import { changeRoad } from './home-roads.mjs';
import { facilityGate, facilityOf } from '../shared/camp-facility.mjs';
import { changeHomeAccess, doorWork, homeEntry, householdAccess } from './home-access.mjs';
import { campEntrance, distanceToRect } from '../shared/camp-interaction.mjs';
import { worldSite } from './geometry.mjs';
import { campAction, campSleepTicks, residentContact } from './camp-play.mjs';
import { CAMP_REST_MINUTES, campRestRule, SHELTER_REST_AMOUNT } from './rest-energy.mjs';
import { residentialSite } from '../shared/camp-layout.mjs';
import { buildLot, doBuild, doRepair, effectiveMods, addFood, takeFood, takeFoodKind } from './production.mjs';
import { COOP, willingness } from './cooperation.mjs';
import { recordSettlementEvent } from './settlement-events.mjs';
import { constructionAccess, constructionAccessEnabled, constructionSpace, recordConstructionBlock, residentConstructionAccess, sceneSpace, siteRecord, roomSpaceOf, roomDoorPoint } from './construction-access.mjs';
import { CONSTRUCTION_CODES } from '../shared/camp-construction-access.mjs';
import { houseAction, claimWildPlot, playerHouseWork } from './households.mjs';
import { respondRequest } from './resident-requests.mjs';
import { GAME_BASE_UNITS_PER_TICK, GAME_PLAYER_UNITS_PER_TICK, reachAllowanceForRealMs, roomContains } from './space.mjs';
import { LEGACY_RESEARCH_UNITS_PER_TICK } from './research-policy.mjs';
import { CAMP_BODY_RADIUS } from '../shared/camp-physics.mjs';
import { detachPlayerRoom, isRoomSpace, placeActor, posOf, roomOfSpace, roomSpaceId, WORLD_SPACE } from './actor-pos.mjs';

// P0-1：玩家外围位置 w.survival.playerPos={x,z,t}。带 from 的外围动作先做连续性校验。
// 村内额度另行放宽：客户端在村里保留冲刺（SPEED 0.5×6fps=3.0 格/秒，冲刺 ×1.75=5.25），
// 而原先全村一律按 10/刻（6 秒刻下只有 1.67 格/秒）⇒ 正常走路就超 1.8 倍、
// 冲刺超 3.15 倍，每次上报被判 TELEPORT 再被拉回（线上“像高延迟”的真因）。
// 外围同权（V4-03）只针对外围同程，这里不动它；40 单位/刻 同时盖住 7.5 秒刻的冲刺 39.4。
// 这三个旧预算是 space.mjs 的 legacy speed-budget 行（同一张每刻预算表，不是第二套空间）。
// 只有“位置上报”这一种动作享受村内宽带：它是技术同步，不是劳动。采集/进出等动作仍按 10/刻 判连续，
// 这样 A/B 对照那条闸门（from=[0,0] 离采集点 28.1 单位 ⇒ TELEPORT）保持原意不变。
// inCamp 只在合法坐标上有意义；越界坐标（哨兵值）按“村外”从严处理，绝不因探测地形抛错而改变拒绝码。
const syncBudget = (from, kind, w) => {
  // 无连续时钟（研究态 / 夹具 / SIM_TIME=0 的旧时间模型）仍走旧的每刻预算：
  // 玩家移动上报用 sprint 行，非移动动作用基础步行行。研究 md5 与旧轨迹逐位不动。
  if (w?.survival?.actTimeModel === true) {
    return kind === 'player_sync' ? GAME_PLAYER_UNITS_PER_TICK : GAME_BASE_UNITS_PER_TICK;
  }
  let inside = false;
  try { inside = kind === "player_sync" && inCamp(from[0], from[1]); } catch { inside = false; }
  return inside ? LEGACY_RESEARCH_UNITS_PER_TICK.playerSyncInCamp : LEGACY_RESEARCH_UNITS_PER_TICK.player;
};
// 2026-11-21 位移修复：正式连续世界（有 simClock）按**真实经过毫秒**给位移额度，
// 不再按“刻”发预算——1:10 下一秒真实位移 3 tile，而旧额度 39.375/刻（360s）会在持续
// 行走 13s 后把正常移动判成 TELEPORT 再拉回。
// 额度公式唯一来源是 space.mjs 的 reachAllowanceForRealMs：
//   真实经过毫秒 × 真实速度 × 1.5 + 1 tile
// 1.5/1 tile 的余量含义见该函数注释；超额度仍然 TELEPORT（伪造远端坐标的负控保留）。
const SYNC_REAL_FLOOR_MS = 1000;
const realNowMs = (w) => {
  const n = Number(w?.simClock?.nowMs?.());
  return Number.isFinite(n) ? n : Date.now();
};
const realSyncAllowance = (w, kind, st, nowMs) => {
  const elapsedMs = st && Number.isFinite(st.atMs) ? Math.max(0, nowMs - st.atMs) : SYNC_REAL_FLOOR_MS;
  return reachAllowanceForRealMs(elapsedMs, kind === 'player_sync' ? 'sprint' : 'walk');
};
// P2b：位置权威不再只校验速度。正式游戏的室外脚点必须落在 space 的可走面内（含实体半径），
// 室内位置（campPlayerRoom + 房间 16×12 坐标）是显式房间空间，不做室外几何判定。
// 返回 false 时调用方给 OUT_OF_REACH：它不是"瞬移"（距离已在前面判过），而是"这里站不住"。
function geometryAllows(w, from) {
  if (w.survival?.actTimeModel !== true) return true; // 研究态/旧时间模型无连续地形，保持原口径
  if (w.campPlayerRoom) {
    // P2c：室内按房间自己的 16×12 空间校验（家具/墙/门），不再只判 0..16/0..12。
    if (!roomContains(from[0], from[1])) return false;
    const room = roomSpaceOf(w, w.campPlayerRoom);
    return !room || room.walkable(from[0], from[1], CAMP_BODY_RADIUS);
  }
  const space = constructionSpace(w) ?? sceneSpace(w);
  if (!space) return true;
  return space.walkable(from[0], from[1], CAMP_BODY_RADIUS);
}
function commitPlayerPos(w, from) {
  const space = w.campPlayerRoom ? roomSpaceId(w.campPlayerRoom) : WORLD_SPACE;
  placeActor(w, 'p1', { x: from[0], z: from[1], space }, { mirror: true });
}
export function playerReach(w, from, kind = '') {
    // 1.3 第二道闸门：幽魂不能移动实体。即使有调用方绕过 survAct 的顶部闸门，
    // 位置写入口仍然拒绝；研究/对照态（!independentWorld）不受这条影响。
    if (w.independentWorld && w.survival && (w.survival.playerDead === true || !isAlive(w.agents?.p1))) {
      return { ok: false, code: 'PLAYER_DEAD' };
    }
    if (!regionPoint(from)) return { ok: false, code: 'OUT_OF_REACH' };
  const s = w.survival;
  // 正式连续世界（simClock）的位移额度按真实毫秒；研究态/夹具保持旧刻预算。
  const continuous = Boolean(w.simClock);
  const last = s.playerPos;
  const first = !last || !Number.isFinite(last.x) || !Number.isFinite(last.z);
  if (first) {
    const at = worldSite(w, w.loc.p1);
    if (!at) return { ok: false, code: 'OUT_OF_REACH' };
    // 首次定位只容许出生槽与地点中心的小幅偏移（旧口径一致），不接受任意远点。
    // 出生点是服务端给的槽位，客户端还没走过一步；几何校验从"已确立位置之后"才生效。
    const d0 = Math.hypot(from[0] - at[0], from[1] - at[1]);
    if (d0 > 2 + 1e-6) return { ok: false, code: 'TELEPORT' };
    commitPlayerPos(w, from);
    s.playerReachState = continuous
      ? { atMs: realNowMs(w) }
      : { t: w.t, allowance: syncBudget(from, kind, w), sub: 0 };
    return { ok: true };
  }
  const dist = Math.hypot(from[0] - last.x, from[1] - last.z);
  if (continuous) {
    // 真实时间预算：额度只随真实毫秒增长，与 1:10 的刻长/倍速/暂停无关。
    const nowMs = realNowMs(w);
    const allowance = realSyncAllowance(w, kind, s.playerReachState, nowMs);
    if (dist > allowance + 1e-6) return { ok: false, code: 'TELEPORT' };
    if (!geometryAllows(w, from)) return { ok: false, code: w.campPlayerRoom || dist <= 2 + 1e-6 ? 'OUT_OF_REACH' : 'TELEPORT' };
    commitPlayerPos(w, from);
    s.playerReachState = { atMs: nowMs };
    return { ok: true };
  }
  // V7.3 §7：子刻精度——同一世界刻内的多次上报共用本刻速度额度（旧路径 walk 22.5 / 研究态 10），
  // 不再用 dt=0 ⇒ 允许距离 0 把正常连续行走判成瞬移；跨刻按经过刻数换一份新额度。
  const ticks = Math.max(0, w.t - (Number.isFinite(last.t) ? last.t : w.t));
  const st = s.playerReachState;
  const sameTick = Boolean(st) && st.t === w.t;
  const base = Math.max(syncBudget(from, kind, w), sameTick ? st.allowance : 0);
  const allowanceBase = sameTick ? base : base * Math.max(1, ticks);
  const used = sameTick ? st.sub : 0;
  if (dist > allowanceBase - used + 1e-6) return { ok: false, code: 'TELEPORT' };
    if (!geometryAllows(w, from)) return { ok: false, code: w.campPlayerRoom || dist <= 2 + 1e-6 ? 'OUT_OF_REACH' : 'TELEPORT' };
  commitPlayerPos(w, from);
  s.playerReachState = { t: w.t, allowance: allowanceBase, sub: used + dist };
  return { ok: true };
}

// V7.3：正式游戏普通劳动不再伤长期存续；viab 只承担饥饿/疾病/长期损耗。
export function playerViabSpend(w, amount) {
  if (w.survival?.actTimeModel === true) return;
  w.agents.p1?.viab?.spend?.(amount);
}

export function survActInner(sp, body) {
  const w = sp.world;
  const kind = String(body?.kind ?? '');
  if (w.independentWorld && !isAlive(w.agents.p1)) return { ok: false, code: 'PLAYER_DEAD', error: 'GAME_OVER' };
  if (!w.independentWorld && (w.survival.failed || w.survival.ended)) return { ok: false, code: 'CAMP_ENDED', error: 'GAME_OVER' };
  if (kind === 'respond_request') return respondRequest(w, body); // SOC-01：免费的社交回应
  if (kind === 'camp_exit') {
    // P2c：出门 = portal 迁移，把唯一位置从房间空间原子切到门外世界点；
    // 否则下一次 player_sync 会拿室内坐标和世界位置比距离，被判 TELEPORT。
    const leaving = w.campPlayerRoom;
    const door = leaving ? roomDoorPoint(w, leaving) : null;
    if (door) {
      w.survival.playerReachState = null;
      placeActor(w, 'p1', { x: door[0], z: door[1], space: WORLD_SPACE }, { mirror: true });
    } else detachPlayerRoom(w);
    if (w.survival.talk?.contact?.room) w.survival.talk=null;
    return {ok:true};
  }
  if (kind === 'player_sync') {
    // P0-1：客户端行走器持续上报真实位置（表现层），服务端做连续性校验并拥有 playerPos。
    // 返回服务端认可位置，供客户端被拒时把可视位置钳回（要求3）。
    const reach=playerReach(w,body.from,kind);
    return reach.ok ? {ok:true,code:'OK',playerPos:w.survival.playerPos} : {...reach,playerPos:w.survival.playerPos??null};
  }
  if (kind==='animal_feed' || kind==='animal_slaughter') {
    const r=animalAction(w,body);
    if (r.ok) playerViabSpend(w, kind==='animal_feed'?.015:.1);
    return r;
  }
  if (kind==='road_lay' || kind==='road_remove') {
    const r=changeRoad(w,'p1',body);
    if (r.ok) playerViabSpend(w, SURV_COST[kind]);
    return r;
  }
  if (kind==='home_request') {
    const host=w.agents[body.target], room=body.home;
    const failure=residentContact(w,body);
    if (failure) return {ok:false,code:failure};
    if (!w.survival.settlementLife || !residentialSite(room,w.peripheralHomes) || !householdAccess(w,host.id,room))
      return {ok:false,code:'NO_AUTHORITY'};
    const trust=host.relations.map.get('p1')?.trust??30;
    if (trust < 40 + host.traits.goals.safety*16 || host.drives.v.energy<.3 || w.survival.disasterToday)
      return {ok:false,code:'INVITE_DECLINED'};
    return changeHomeAccess(w,host.id,{room,target:'p1',type:'invite',kind:'home_grant'});
  }
  if (kind === 'home_grant' || kind === 'home_revoke') return changeHomeAccess(w,'p1',body);
  if (kind === 'home_break' || kind === 'home_fix') {
    const gate=campEntrance(body.room,worldSite(w,body.room),w.peripheralHomes);
    if (w.campPlayerRoom || !gate || !regionPoint(body.from) ||
        distanceToRect(body.from,gate)>.12) return {ok:false,code:'OUT_OF_REACH'};
    const result=doorWork(w,'p1',body.room,kind,body.tool);
    if (result.ok) playerViabSpend(w, kind==='home_break'?.15:.08);
    return result;
  }
  if (kind==='facility_use') {
    const s=w.survival, building=facilityOf(w,body.target);
    if (!s.settlementLife || !building || building.integrity<=0) return {ok:false,code:'NO_FACILITY'};
    if (building.type==='wall') {
      const lot=building.lot??buildLot(w,building.loc);
      if (w.campPlayerRoom || !lot || !regionPoint(body.from) ||
          distanceToRect(body.from,lot)>1.15) return {ok:false,code:'OUT_OF_REACH'};
      return {ok:true,code:'OK',integrity:building.integrity,shield:effectiveMods(w).shield};
    }
    if (w.campPlayerRoom!==body.target) return {ok:false,code:'OUT_OF_REACH'};
    if (building.type==='granary') {
      const bag=w.pinv.p1, toStore=body.type==='deposit', take=body.type==='withdraw';
      if (!toStore && !take) return {ok:false,code:'BAD_ITEM'};
      if (s.food) {
        // 分类粮仓：存取都带品类，品类为 0 时自动挑存量最多的一种
        const want = body.item ?? null;
        if (toStore) {
          const kind = want && (bag[want] ?? 0) >= 1 ? want
            : ['crop','berry','fruit','egg','milk','meat'].find((k) => (bag[k] ?? 0) >= 1);
          if (!kind) return {ok:false,code:'EMPTY'};
          if (s.store+1>effectiveMods(w).storeCap) return {ok:false,code:'CONTAINER_FULL'};
          bag[kind]-=1; addFood(s, kind, 1);
          return {ok:true,code:'OK',item:kind};
        }
        if (s.store<1) return {ok:false,code:'EMPTY'};
        const kind = takeFoodKind(s, want);
        if (!kind) return {ok:false,code:'EMPTY'};
        bag[kind]=(bag[kind]??0)+1;
        return {ok:true,code:'OK',item:kind};
      }
      if (toStore && !(bag.crop>=1) || take && s.store<1) return {ok:false,code:'EMPTY'};
      if (toStore && s.store+1>effectiveMods(w).storeCap) return {ok:false,code:'CONTAINER_FULL'};
      s.store+=toStore?1:-1;
      bag.crop=(bag.crop??0)+(toStore?-1:1);
    } else if (building.type==='workshop') {
      if (body.tool!=='hammer') return {ok:false,code:'NEED_TOOL'};
      const bag=w.pinv.p1;
      if (!(bag.wood>=2)) return {ok:false,code:'NO_MATERIAL'};
      bag.wood-=2;
      bag.tray=(bag.tray??0)+1;
      noteWorkMotion(w,'p1','hammer',{prop:'workbench'});
      w.observeProduction?.('materialSpent','craftWood',2);
    } else if (building.type==='shelter') {
      if (s.lastShelterRest===w.t) return {ok:false,code:'ACTION_BUDGET'};
      s.lastShelterRest=w.t;
      const before=w.agents.p1.drives.v.energy;
      w.agents.p1.drives.reward('energy',SHELTER_REST_AMOUNT);
      const gain=Number((w.agents.p1.drives.v.energy-before).toFixed(4));
      playerViabSpend(w, .01);
      return {ok:true,code:'OK',energyGain:gain,source:'shelter'};
    }
    playerViabSpend(w, .01);
    return {ok:true,code:'OK'};
  }
  if (kind === 'move') {
    const room = String(body?.room ?? '');
    const building=w.survival.settlementLife && facilityOf(w,room);
    if (building) {
      const gate=facilityGate(building,w.campLayout);
      if (building.type==='wall' || building.integrity<=0) return {ok:false,code:'NO_FACILITY'};
      if (w.campPlayerRoom || !body.entrance || !gate || !regionPoint(body.from) ||
          distanceToRect(body.from,gate)>.12) return {ok:false,code:'OUT_OF_REACH'};
      const access = constructionAccess(w,siteRecord(w,building.loc,building.type,building.lot),
        {from:body.from,entrance:true});
      if (!access.ok) return access;
      if (constructionAccessEnabled(w) && w.districts?.[building.loc]) {
        const reach = playerReach(w,body.from);
        if (!reach.ok) return reach;
      }
      move(w,'p1',building.loc);
      // 房间空间与室内门：唯一位置写成 room:<facility id>，玩家镜像同步。
      w.survival.playerReachState=null;
      placeActor(w,'p1',{x:8,z:11.5,space:roomSpaceId(room)},{mirror:true});
      playerViabSpend(w, SURV_COST.move_to);
      return {ok:true,code:'OK'};
    }
    if (!Object.hasOwn(w.locs,room) && !Object.values(w.housing).includes(room)) return {ok:false,error:'NO_LOC'};
    const district=w.districts?.[room];
    if (district) {
      if (body.entrance || w.campPlayerRoom) return {ok:false,code:'OUT_OF_REACH'};
      const reach=playerReach(w,body.from); // P0-1：跨区进入也须连续步行，不能瞬移进区
      if (!reach.ok) return reach;
      if (distanceToRect(body.from,district.pad)>1.15) return {ok:false,code:'OUT_OF_REACH'};
    }
    const access=homeEntry(w,'p1',room);
    if (!access.ok) return access;
    if (w.survival.settlementLife && residentialSite(room,w.peripheralHomes) && !body.entrance) return {ok:false,code:'OUT_OF_REACH'};
    if (body.entrance) {
      const previous=w.campPlayerRoom;
      const adjacent=previous && (previous==='hall' && ['home','store'].includes(room));
      const gate=campEntrance(room,worldSite(w,room),w.peripheralHomes);
      if (!adjacent && (previous || !gate || !regionPoint(body.from) ||
          distanceToRect(body.from,gate)>.12)) return {ok:false,code:'OUT_OF_REACH'};
      if (constructionAccessEnabled(w) && residentialSite(room,w.peripheralHomes)) {
        const approach = constructionAccess(w,siteRecord(w,room,'house'),{from:body.from,entrance:true});
        if (!approach.ok) return approach;
        if (w.peripheralHomes?.[room]) {
          const reach = playerReach(w,body.from);
          if (!reach.ok) return reach;
        }
      }
    }
    // P2c：地点/占用由唯一写入口同步；进门时位置切到房间空间的门口，
    // 非 entrance（旧 2D/抽象地点）留在世界空间，campPlayerRoom 保持旧语义(null)。
    if (body.entrance) {
      w.survival.playerReachState = null;
      move(w,'p1',room);
      placeActor(w,'p1',{x:8,z:11.5,space:roomSpaceId(room)},{mirror:true});
    } else {
      move(w,'p1',room);
      const at=worldSite(w,room);
      if (at) placeActor(w,'p1',{x:at[0]-1,z:at[1],space:WORLD_SPACE});
      detachPlayerRoom(w);
    }
    playerViabSpend(w, SURV_COST.move_to); // P0-2：移动与 AI move_to 同价
    return { ok: true };
  }
  if ((kind==='build'||kind==='repair') && Object.hasOwn(body,'from')) {
    const records=kind==='build'?w.survival.sites:w.survival.buildings;
    const building=records.find(b=>`work:${b.loc}:${b.type}`===body.target);
    if (!building) return {ok:false,code:kind==='build'?'NO_SITE':'NO_REPAIR'};
    const lot=building.lot??buildLot(w,building.loc);
    if (w.campPlayerRoom || !lot) return {ok:false,code:'OUT_OF_REACH'};
    // P0-1：仅外围工地需连续性校验；核心营地保持现行为（§三.5）
    if (w.districts?.[building.loc] || w.peripheralHomes?.[building.loc]) {
      const reach=playerReach(w,body.from); if (!reach.ok) return reach;
    } else if (!regionPoint(body.from)) return {ok:false,code:'OUT_OF_REACH'};
    if (distanceToRect(body.from,lot)>1.15) return {ok:false,code:'OUT_OF_REACH'};
    if (kind==='build') {
      const access = constructionAccess(w,siteRecord(w,building.loc,building.type,lot),{from:body.from});
      if (!access.ok) return access;
    }
    const result=(kind==='build'?doBuild:doRepair)(w,'p1',building.loc);
    if (result.ok) playerViabSpend(w, SURV_COST[kind]);
    sp.log.push({t:w.t,kind,ok:result.ok,code:result.code});
    return result;
  }
  if (kind === 'home_claim') {
    // 1.2 A：荒野宅基地开工（服务端原子裁决；客户端只发意图，不本地先占）。
    const r = claimWildPlot(w, 'p1', String(body.type ?? body.plot ?? ''), { from: body.from ?? null });
    if (r.ok) playerViabSpend(w, .1);
    sp.log.push({ t: w.t, kind, ok: r.ok, code: r.code });
    if (sp.log.length > 40) sp.log.shift();
    return r;
  }
  if (kind === 'house_work') {
    // 1.2 A：在自己认领的地块上施工；每次 15 游戏分（长动作，到点才落进度）。
    const r = playerHouseWork(w, 'p1', { from: body.from ?? null });
    if (r.ok) playerViabSpend(w, SURV_COST.house_work);
    sp.log.push({ t: w.t, kind, ok: r.ok, code: r.code });
    if (sp.log.length > 40) sp.log.shift();
    return r;
  }
  if (kind.startsWith('family_')) {
    const result = houseAction(w, 'p1', body);
    sp.log.push({ t: w.t, kind, ...result });
    if (sp.log.length > 40) sp.log.shift();
    return result;
  }
  if (kind === 'camp_sleep') {
    const slept = campSleepTicks(w);
    if (!slept.ok) return slept;
    return { ok: true, code: 'OK', ticks: slept.ticks, observation: '睡了一觉' };
  }
  // 1.6 C：通用休息。位置/冷却/日上限/满能量在 rest-energy.mjs 一处裁决；
  // 这里只把结果接进动作账（时间成本走 action-cost 的 camp_rest=30 分）。
  if (kind === 'camp_rest') {
    const rested = campRestRule(w);
    if (!rested.ok) return rested;
    return { ...rested, observation: `在${rested.site}歇了 ${CAMP_REST_MINUTES} 分钟`, source: 'rest' };
  }
  if (kind.startsWith('camp_')) {
    // ARCH4-07：营地动作先过规则层 validateCamp（kind/成本/reach），campAction 只做效果结算。
    const invalid = validateCamp(w, { ...body, kind }, playerReach);
    if (invalid) return invalid;
    const result=campAction(w,body);
    sp.log.push({t:w.t,kind,ok:result.ok,code:result.code});
    if (sp.log.length>40) sp.log.shift();
    return result;
  }
  // P0-5：玩家在当前工地向指定居民请求协助。AI 按自身需求/关系/天气/任务价值裁决接受/替代/拒绝。
  if (kind === 'coop_request') {
    const s = w.survival;
    if (!s.coop?.enabled) return { ok: false, code: 'COOP_OFF' };
    const target = String(body?.target ?? '');
    const a = w.agents[target];
    if (!a || a.isPlayer || !isAlive(a) || (w.unifiedCooperation && !laborStage(w, target))) return { ok: false, code: 'NO_RESIDENT' };
    const positioned=Object.hasOwn(body,'from');
    const site=s.sites.find(x=>positioned ? body.site==='work:'+x.loc+':'+x.type : x.loc===w.loc.p1);
    if (!site) return {ok:false,code:'NO_SITE'};
    if (positioned || w.districts?.[site.loc]) {
      const lot=site.lot??buildLot(w,site.loc);
      if (!lot || w.campPlayerRoom) return {ok:false,code:'OUT_OF_REACH'};
      if (w.districts?.[site.loc] || w.peripheralHomes?.[site.loc]) {
        const reach=playerReach(w,body.from); if (!reach.ok) return reach; // P0-1：外围工地连续性校验
      } else if (!regionPoint(body.from)) return {ok:false,code:'OUT_OF_REACH'};
      if (distanceToRect(body.from,lot)>1.15) return {ok:false,code:'OUT_OF_REACH'};
    }
    const work = siteRecord(w,site.loc,site.type,site.lot);
    const access = constructionAccess(w,work,positioned ? {from:body.from} : {});
    if (!access.ok) return access;
    const travel = residentConstructionAccess(w,target,work);
    if (!travel.ok) return travel;
    const wl = willingness(w, target, { type: site.type, severity: 0.7, requester: 'p1', loc: site.loc });
    if (wl.decision === 'refuse') {
      s.coop.refusals += 1;
      sp.log.push({ t: w.t, kind, ok: false, code: 'REFUSED' });
      if (sp.log.length > 40) sp.log.shift();
      recordSettlementEvent(w, 'cooperation_reply', {
        actor: target, target: 'p1', loc: site.loc, type: site.type, result: wl.decision, reason: wl.reason,
      });
      return { ok: false, code: 'REFUSED', decision: 'refuse', score: wl.score, reason: wl.reason };
    }
    let ct = s.coop.task;
    if (!ct || ct.loc !== site.loc) ct = s.coop.task = { type: site.type, loc: site.loc, phase: 'build', workers: [], startedAt: w.t, severity: 0.7, requester: 'p1' };
    if (!ct.workers.includes(target)) {
      if (w.unifiedCooperation && ct.workers.length >= COOP.maxWorkers) return { ok: false, code: 'TEAM_FULL' };
      ct.workers.push(target);
    }
    (ct.commit ??= {})[target] = wl.decision; // assist＝稳定承诺；alternative＝每拍重评，可中途退出
    recordSettlementEvent(w, 'cooperation_reply', {
      actor: target, target: 'p1', loc: site.loc, type: site.type, result: wl.decision, taskStartedAt: ct.startedAt,
    });
    sp.log.push({ t: w.t, kind, ok: true, code: wl.decision });
    if (sp.log.length > 40) sp.log.shift();
    return { ok: true, code: 'OK', decision: wl.decision, score: wl.score, reason: wl.reason };
  }
  // 同权：玩家与 AI 的这些动作都走 validate → actuate，规则层是唯一"能不能"的裁决者。
  // （旧实现只调 actuate，地点/材料门槛只作用于 AI，构造 POST 可在任意地点收种存取。）
  if (!['harvest', 'plant', 'gather', 'plan', 'build', 'repair', 'deposit', 'withdraw', 'forage', 'exchange', 'expand', 'till'].includes(kind)) return { ok: false, error: 'UNKNOWN_KIND' };
  let actionLoc=w.loc.p1;
  if ((kind==='plan' || kind==='gather') && (Object.hasOwn(body,'from') || w.districts?.[actionLoc])) {
    const district=w.districts?.[body.target];
    const lot=kind==='plan'?buildLot(w,body.target):district && {x:district.source[0]-.42,z:district.source[1]-.42,w:.84,d:.84};
    if (!lot || w.campPlayerRoom) return {ok:false,code:'OUT_OF_REACH'};
    // playerReach 会更新"已确立位置"；先记下它，用来区分"被挪过来的"与"本来就站错地方"。
    const before = w.survival.playerPos;
    if (district) {
      const reach=playerReach(w,body.from);
      if (!reach.ok) return reach;
    }
    else if (!regionPoint(body.from)) return {ok:false,code:'OUT_OF_REACH'};
    if (distanceToRect(body.from,lot)>1.15) {
      // P0-1/P2b：外围采集（gather）一次上报搬动 >20 且仍不在工点 ⇒ 连续性拒绝（TELEPORT，
      // 对齐 camp-compare-entry 的 otherContact 伪造）；奠基与小幅修正仍按“到不了”OUT_OF_REACH
      // （对齐 camp-districts 的地块用例）。真实行走者只会遇到后者。
      const unset = !before || (before.x === 0 && before.z === 0);
      const moved = unset || Math.hypot(body.from[0]-before.x, body.from[1]-before.z) > 20;
      return {ok:false,code:kind==='gather'&&moved?'TELEPORT':'OUT_OF_REACH'};
    }
    const tool=kind==='plan'?'hammer':district.resource==='wood'?'axe':'pick';
    if (body.tool!==tool) return {ok:false,code:'NEED_TOOL'};
    actionLoc=body.target;
  }
  if ((kind==='build' || kind==='repair') && w.districts?.[actionLoc]) return {ok:false,code:'OUT_OF_REACH'};
  if (constructionAccessEnabled(w) && (kind==='plan' || kind==='build')) {
    const site = w.survival.sites.find(b=>b.loc===actionLoc);
    if (kind==='build' && !site) return {ok:false,code:'NO_SITE'};
    if (!regionPoint(body.from) || w.campPlayerRoom) return {ok:false,code:'BUILD_NOT_ARRIVED'};
    const record = siteRecord(w,actionLoc,kind==='plan' ? body.type : site.type,kind==='build' ? site.lot : undefined);
    if (!record.lot) return {ok:false,code:'NO_LOT'};
    if (distanceToRect(body.from,record.lot)>1.15) return {ok:false,code:'BUILD_NOT_ARRIVED'};
    const access = constructionAccess(w,record,{from:body.from,proposed:kind==='plan'});
    if (!access.ok) return access;
  }
  const gate = validate(w, 'p1', { kind, type: body?.type, plot: body?.plot }, actionLoc); // RES-03：till 需要 plot，不能只带 kind/type
  if (!gate.ok) {
    sp.log.push({ t: w.t, kind, ok: false, code: gate.code });
    if (sp.log.length > 40) sp.log.shift();
    return gate;
  }
  const r = actuate(w, 'p1', { kind, type: body?.type, plot: body?.plot }, actionLoc);
  if (r.ok) playerViabSpend(w, SURV_COST[kind]); // P0-2：与 AI execute 同表结算，成功才扣，不重复扣
  sp.log.push({ t: w.t, kind, ok: r.ok, code: r.code });
  if (sp.log.length > 40) sp.log.shift();
  return r;
}
