import { findRegionEntity, regionPoint, regionReady } from '../shared/camp-region-entities.mjs';
import { recordResidentHit } from './resident-injury.mjs';
import { householdAccess } from './home-access.mjs';
import { sourceView, takeProduce } from './source-produce.mjs';
import { ANIMAL_ITEMS, ANIMAL_LIMITS, CAMP_TOOLS, HEAVY_CAMP_TOOLS, REACH, campPen, campPlants, campSite, distanceTo, distanceToRect, pointIn } from '../shared/camp-interaction.mjs';
import { WORLD_TW, WORLD_TH } from './geometry.mjs';
import { residentContact } from './camp-contact.mjs';
import { speechLine } from './speech.mjs';
import { DAY_TICKS, dayOf } from './clock.mjs';
import { TIMBER_GROVE } from '../shared/camp-layout.mjs';
import { doForage, doGather, takeFoodKind } from './production.mjs';
import { FOREST_CHOP_WOOD, chopBlocked, forestRegrowTicks, forestTree } from './forest.mjs';
import { activeForestCuts, isForestTreeId, parseForestTreeId } from '../shared/camp-forest.mjs';
import { SURV_COST, isAlive } from './body.mjs';
import { doHarvest, doPlant } from './worldstate.mjs';
import { noteRes, noteConsumed } from './resource-ledger.mjs';
import { campStaticPrecheck } from './camp-precheck.mjs';
import { markResidentAttention } from './resident-attention.mjs';
import { closeResidentDialogue, openResidentDialogue, sayInResidentDialogue } from './resident-dialogue.mjs';
import { playerReach } from './survplay-camp.mjs';

import { noteWorkMotion } from './work-motion.mjs';
// P4：房间区域只有显式世界单位（16×12）判定；旧的隐式 16.01/12.01 回退开关已退役。
const STORAGE = Object.freeze({
  home:['4'], store:['0','1','2','3','4','5'], workshop:['3','4'],
  watch:['1','3'], garden:['0'], well:['2','3'], yard:['0','1','2'],
});
const TOOLS=CAMP_TOOLS;
const ITEMS=new Set(['wood','stone','tray','meat',...Object.keys(TOOLS)]);
const FOOD=new Set(['berry','fruit','crop','egg','milk','meat']);
const ok=()=>({ok:true,code:'OK'});
const fail=code=>({ok:false,code});
const amount=(bag,item)=>bag?.[item]??0;
const setCount=(bag,item,n)=>{bag[item]=n;};

const playerHome=(world,site)=>site==='home' || (Boolean(site) && (world.survival.settlementLife ? householdAccess(world,'p1',site) : site===world.housing?.p1));
// P0-3：玩家动作与居民同权，也付存续代价（只在动作成功时扣）。
const pay=(world,cost)=>{ if(world.survival?.actTimeModel===true) return; /* V7.3：正式游戏走共享体力表，不再伤 viab */ world.agents.p1?.viab?.spend?.(cost); };
export function campTimberView(world) {
  const cut=world.survival.campTrees??{};
  return Object.fromEntries((world.campLayout?.grove??TIMBER_GROVE).map(tree=>{
    const regrowAt=cut[tree.id]??0;
    return [tree.id,{stage:regrowAt>world.t?'sapling':'mature',regrowAt}];
  }));
}
// 森林（camp-scene 的 world.trees）只有“还在树桩期”的条目；条目消失 = 已再生、树回到场景。
// key 用 forest:tx:tz 命名空间，与 grove 的 campTimberView 共用 survival.campTrees 但互不干扰。
export function campForestView(world) {
  const cut=world.survival?.campTrees, ids=activeForestCuts(cut, world.t);
  if (!ids.length) return {};
  const out={};
  for (const id of ids) {
    const at=parseForestTreeId(id);
    if (!at) continue;
    out[id]={stage:'stump', regrowAt:Number(cut[id])||0, at:[at.x,at.z]};
  }
  return out;
}
export function campSleepTicks(world) {
  if (!playerHome(world,world.loc.p1) || world.survival.settlementLife && world.loc.p1!=='home' && world.campPlayerRoom!==world.loc.p1) return fail('NOT_HOME');
  if (!isAlive(world.agents.p1) || (!world.independentWorld && (world.survival.ended || world.survival.failed))) return fail('CAMP_ENDED');
  const hour=world.t%DAY_TICKS;
  return {...ok(),ticks:Math.min(24,hour>=12?DAY_TICKS-hour:4)};
}

// residentContact 的唯一实现在 life/camp-contact.mjs；这里 re-export 保持旧调用面。
export { residentContact };

function interactWithResident(world,body) {
  const {target,tool}=body, failure=residentContact(world,body);
  if (failure) return fail(failure==='RESIDENT_GONE'?'RESIDENT_OUT_OF_REACH':failure);
  const npc=world.agents[target], s=world.survival;
  if (HEAVY_CAMP_TOOLS.includes(tool)) {
    const wounds=s.campWounds??={};
    if (world.t-(wounds[target]?.t??-Infinity)<2) return fail('RESIDENT_COOLDOWN');
    const before=npc.viab.v;
    npc.hurtBy='受伤'; // P0-1：致死原因可追溯
    npc.viab.v=Math.max(0,before-.14);
    const damage=before-npc.viab.v;
    recordResidentHit(world,npc,before);
    npc.relations.meet('p1',world.t,{delta:{trust:-15}});
    world.pending.push({for:target,evt:{kind:'injury',valence:-.8,about:'p1',selfCaused:false,serves:'safety'}});
    return {...ok(),code:'RESIDENT_HURT',damage,name:npc.name};
  }
  if (tool!=='hand') return fail('RESIDENT_NEED_HAND');
  const chats=s.residentChats??={}, day=dayOf(world.t);
  if (chats[target]!==day) {
    chats[target]=day;
    npc.relations.meet('p1',world.t,{delta:{trust:4,familiarity:.09}});
    world.pending.push({for:target,evt:{kind:'contact',valence:.35,about:'p1',selfCaused:false,serves:'social'}});
  }
  const attention=markResidentAttention(world,target,{about:'p1'});
  return {...ok(),code:'RESIDENT_TALKED',name:npc.name,attention,line:speechLine(npc,{world,kind:'talk',actionId:'talk:p1',t:world.t})};
}

function outdoorSource(world, body) {
  const { kind,type:item,target,plot,from,to }=body;
  const s=world.survival, layout=world.campLayout;
  if (world.campPlayerRoom || !regionPoint(from)) return fail('OUT_OF_REACH');
  if (kind==='camp_collect' && typeof target==='string' && target.startsWith('region:')) {
    const node=findRegionEntity(world,target,'plants');
    if (!node || node.item!==item) return fail('NO_PLANT');
    return distanceTo(from,[node.x,node.z])<=REACH.plant ? {node} : fail('OUT_OF_REACH');
  }
  if (!pointIn(from,WORLD_TW,WORLD_TH)) return fail('OUT_OF_REACH');
  if (kind==='camp_chop') {
    // 森林树（world.trees）：同一张图上营地内/外同一套规则——距离 + 水/岸 + 硬实体隔挡。
    if (isForestTreeId(target)) {
      const tree=forestTree(world,target);
      if (!tree) return fail('NO_TREE');
      const blocked=chopBlocked(world,from,tree);
      if (blocked) return fail(blocked);
      return {site:world.loc.p1,tree};
    }
    const tree=(layout?.grove??TIMBER_GROVE).find(t=>t.id===target);
    if (!tree) return fail('NO_TREE');
    return distanceTo(from,[tree.x,tree.z])<=REACH.timber ? {site:tree.site} : fail('OUT_OF_REACH');
  }
  if (item==='crop' || kind==='camp_plant' || kind==='camp_water') {
    const bed=Number.isInteger(plot) && s.plots.find(p=>p.id===plot)?.bed;
    if (!bed) return fail('BAD_PLOT');
    return bed && distanceToRect(from,bed)<=REACH.plot ? {site:'garden'} : fail('OUT_OF_REACH');
  }
  const sources=sourceView(world);
  if (item==='fruit' || item==='berry') {
    const plant=campPlants(layout,s.livestock?.orchards,world.mapSeed,world.layoutVersion,sources).find(p=>p.id===target && p.item===item);
    if (!plant) return fail('NO_PLANT');
    return distanceTo(from,[plant.x,plant.z])<=REACH.plant ? {site:plant.site} : fail('OUT_OF_REACH');
  }
  const [animal,index,extra]=typeof target==='string'?target.split(':'):[];
  if (extra!==undefined || !Object.hasOwn(ANIMAL_ITEMS,animal) || ANIMAL_ITEMS[animal]!==item) return fail('NO_ANIMAL');
  const exists = sources ? sources[item]?.some(row => row.id === target)
    : /^[0-9]+$/.test(index??'') && Number(index)<Math.min(s.livestock?.[animal]??0,ANIMAL_LIMITS[animal]);
  if (!exists) return fail('NO_ANIMAL');
  const pen=campPen(campSite('yard',layout));
  return pointIn(to,WORLD_TW,WORLD_TH) && distanceToRect(to,pen)===0 && distanceTo(from,to)<=REACH.animal
    ? {site:'yard'} : fail('OUT_OF_REACH');
}

// V4-09：对话与 camp_resident 同一套连续性门。用 `player_sync` 档（玩家渲染位置＝玩家速度预算），
// 不用 base 档——跑过去立刻说话是正常操作，base 档会把 11-19 那类正常移动误判成瞬移。
// 失败统一 RESIDENT_OUT_OF_REACH：客户端已有对应文案，不新造 TELEPORT 这类没人处理的码。
export function talkContinuity(world, body) {
  if (!body || !Object.hasOwn(body, 'from')) return null;
  const reach = playerReach(world, body.from, 'player_sync');
  return reach.ok ? null : 'RESIDENT_OUT_OF_REACH';
}

export function campAction(world,body,{fromSpeech=false}={}) {
  const {kind,type:item,target,tool,plot}=body, s=world.survival;
  let site=world.loc.p1, node;
  if (!isAlive(world.agents.p1) || (!world.independentWorld && (s.ended || s.failed))) return fail('CAMP_ENDED');
  // 静态前置（工具/品类）与 validateCamp 共用同一实现；位置/容器/库存仍在这里按解析后的 site 判断。
  const pre = campStaticPrecheck(world, body);
  if (pre) return pre;
  // 1.4 主动对话：camp_talk* 是零成本轻动作，但位置/房间/存活门与 camp_resident 同一套。
  if (kind==='camp_talk' || kind==='camp_talk_say' || kind==='camp_talk_close') {
    if (kind==='camp_talk_close') return closeResidentDialogue(world,body);
    // V4-10：气泡来源是服务端内部事实（fromSpeech 形参），客户端 body 上的同名字段一律不读。
    // 打开气泡只认 survplay-camp 注入的内部标记；续聊只认会话上的 fromSpeech。
    const wanted=String(target ?? ''), session=s.residentDialogue;
    const bubbleOpen=kind==='camp_talk' && fromSpeech===true;
    const continueSpeech=kind==='camp_talk_say' && session?.fromSpeech===true && session.target===wanted;
    if (!bubbleOpen && !continueSpeech) {
      // V4-09：普通入口先做服务端位置的连续性校验，再做 1.6 接触门；失败不得写会话。
      const continuity=talkContinuity(world,body);
      if (continuity) return fail(continuity);
      const failure=residentContact(world,body);
      if (failure) return fail(failure==='RESIDENT_GONE'?'RESIDENT_OUT_OF_REACH':failure);
    }
    return kind==='camp_talk'
      ? openResidentDialogue(world,body,{fromSpeech:bubbleOpen})
      : sayInResidentDialogue(world,body);
  }
  if (kind==='camp_resident') return interactWithResident(world,body);
  const positioned = ['camp_chop','camp_plant','camp_water','camp_collect'].includes(kind);
  if (s.farmLife && kind==='camp_collect' && item!=='water' && !Object.hasOwn(body,'from')) return fail('OUT_OF_REACH');
  if (positioned && Object.hasOwn(body,'from')) {
    const source=outdoorSource(world,body);
    if (!source.site && !source.node) return source;
    site=source.site;
    node=source.node;
  }
  const bag=world.pinv.p1;
  if (kind==='camp_store' || kind==='camp_take') {
    const [room,slot]=typeof target==='string'?target.split(':'):[], table=slot==='meal' && playerHome(world,room);
    const shelf=room!=='home' && playerHome(world,room) && slot==='2';
    if (s.settlementLife && (table || shelf) && world.campPlayerRoom!==room) return fail('NO_CONTAINER');
    if (room!==site || (!table && !shelf && !STORAGE[room]?.includes(slot)) || target!==`${room}:${slot}`) return fail('NO_CONTAINER');
    if (!ITEMS.has(item) || (table && !FOOD.has(item) && item!=='tray')) return fail('BAD_ITEM');
    const all=(s.campContainers??={}), stored=(all[target]??={});
    const [from,to]=kind==='camp_store'?[bag,stored]:[stored,bag];
    if (!amount(from,item)) return fail('EMPTY');
    if (to===stored && Object.values(stored).reduce((sum,n)=>sum+n,0)>=(table?6:24)) return fail('CONTAINER_FULL');
    setCount(from,item,amount(from,item)-1);
    setCount(to,item,amount(to,item)+1);
    pay(world,0.005);
    return ok();
  }
  if (kind==='camp_eat') {
    // RES-02 余项（B-a）：人在公共粮仓里，允许直接吃一份公仓的粮——与居民日界一次配给同权。
    // 与家里餐桌共用同一个"今日已吃"计数（上限 1），避免家里两餐＋谷仓一份变成三倍收益。
    if (world.gameRules && world.loc.p1 === 'store') {
      const pl0 = world.agents.p1;
      const day = Math.floor(world.t / (world.dayTicks ?? 24));
      if (s.mealsDay !== day) { s.mealsDay = day; s.mealsToday = 0; }
      if ((s.mealsToday ?? 0) >= 1) return fail('MEAL_LIMIT');
      if ((pl0?.drives?.v?.energy ?? 1) > 0.6) return fail('NOT_HUNGRY');
      const kindEaten = takeFoodKind(s);
      if (!kindEaten) return fail('EMPTY');
      noteConsumed(world, kindEaten, 'player'); // D1/D2：这一份只在这里消费一次
      s.mealsToday = (s.mealsToday ?? 0) + 1;
      s.mealsEaten = (s.mealsEaten ?? 0) + 1;
      pl0?.viab?.regen?.(s.feedViab ?? 0.5);
      pl0?.drives?.reward?.('energy', s.feedReward ?? 0.5);
      return ok();
    }
    if (!playerHome(world,site) || s.settlementLife && world.campPlayerRoom!==site) return fail('NOT_HOME');
    if (amount(bag,'tray')<1) return fail('NEED_TRAY'); // 托盘是餐具：没有它只能看着饭
    const meal=s.campContainers?.[`${site}:meal`];
    if (!FOOD.has(item) || !amount(meal,item)) return fail('EMPTY');
    // AUD-05 / B-a：同一游戏日只吃一份（与居民日界一次配给严格同权；家里与谷仓共用计数）。
    const pl0 = world.agents.p1;
    const day = Math.floor(world.t / (world.dayTicks ?? 24));
    if (s.mealsDay !== day) { s.mealsDay = day; s.mealsToday = 0; }
    if ((s.mealsToday ?? 0) >= (world.gameRules ? 1 : 2)) return fail('MEAL_LIMIT');
    // RES-02：不饿就不吃——居民只有日界一次配给，玩家不能把进食当存续药水。
    if ((pl0?.drives?.v?.energy ?? 1) > 0.6) return fail('NOT_HUNGRY');
    setCount(meal,item,amount(meal,item)-1);
    noteConsumed(world, item, 'player:meal');
    s.mealsToday = (s.mealsToday ?? 0) + 1;
    const pl=world.agents.p1;
    // V7.1：一份饭与居民日界配给同一折算（feedViab/feedReward），不是玩家专属的 1.0/0.35。
    pl?.viab?.regen?.(s.feedViab ?? 0.5);
    pl?.drives?.reward?.('energy', s.feedReward ?? 0.5);
    s.mealsEaten=(s.mealsEaten??0)+1;
    return ok();
  }
  if (kind==='camp_chop') {
    if (isForestTreeId(target)) {
      // 森林树：位置/隔挡必须来自真实脚点（没有 from 的旧调用不放行，避免绕过距离门）。
      const tree=forestTree(world,target);
      if (!tree) return fail('NO_TREE');
      if (!Object.hasOwn(body,'from')) return fail('OUT_OF_REACH');
      const blocked=chopBlocked(world,body.from,tree);
      if (blocked) return fail(blocked);
      const trees=(s.campTrees??={});
      if ((trees[target]??0)>world.t) return fail('TREE_GROWING');
      // 产出走与采集同一本资源账：个人包 +2，gross/personal 分开记，不碰 grove 的 resStock。
      bag.wood=(bag.wood??0)+FOREST_CHOP_WOOD;
      noteRes(world,'gross','wood',FOREST_CHOP_WOOD);
      noteRes(world,'personal','wood',FOREST_CHOP_WOOD);
      world.observeProduction?.('gather','wood',FOREST_CHOP_WOOD);
      noteWorkMotion(world,'p1','chop',{at:[tree.x,tree.z]});
      trees[target]=world.t+forestRegrowTicks(world);
      pay(world,SURV_COST.gather); // 与 grove 砍伐/居民 gather 同一价
      return {...ok(),res:'wood',amount:FOREST_CHOP_WOOD};
    }
    const tree=(world.campLayout?.grove??TIMBER_GROVE).find(t=>t.id===target);
    if (!tree || tree.site!==site) return fail('NO_TREE');
    const trees=(s.campTrees??={});
    if ((trees[target]??0)>world.t) return fail('TREE_GROWING');
    const cut=doGather(world,'p1',site,[tree.x,tree.z]);
    if (!cut.ok) return cut; // P0-3：储量采空不能砍，树不标记（与资源账同步，等再生）
    trees[target]=world.t+3*DAY_TICKS;
    pay(world,SURV_COST.gather); // P0-2：与 AI gather 同价
    return cut;
  }
  if (kind==='camp_craft') {
    if (!['workshop','yard'].includes(site)) return fail('NOT_WORKBENCH');
    if (amount(bag,'wood')<2) return fail('NO_MATERIAL');
    bag.wood-=2;
    world.observeProduction?.('materialSpent', 'craftWood', 2);
    bag.tray=amount(bag,'tray')+1;
    noteWorkMotion(world,'p1','hammer',{prop:'workbench'});
    pay(world,0.01);
    return ok();
  }
  if (kind==='camp_plant') {
    if (site!=='garden') return fail('NOT_GARDEN');
    if (!Number.isInteger(plot)) return fail('BAD_PLOT');
    const done=doPlant(world,'p1',plot);
    if (done.ok) pay(world,SURV_COST.plant); // P0-2：与 AI plant 同价
    return done;
  }
  if (kind==='camp_water') {
    if (site!=='garden') return fail('NOT_GARDEN');
    const field = s.plots.find(p => p.id === plot);
    if (plot!==undefined && !field) return fail('BAD_PLOT');
    // 井水/河水都可直接浇地：不再强制先装桶；身上有井水时优先用掉。
    if (field && s.farmLife) {
      if ((field.moisture ?? 0) >= 1) return fail('WATER_FULL');
      field.moisture = Math.min(1, (field.moisture ?? 0) + .4);
    } else {
      if (s.water>=1) return fail('WATER_FULL');
      s.water=Math.min(1,s.water+.12);
    }
    if (amount(bag,'water')) bag.water-=1;
    noteWorkMotion(world,'p1','water',{plot,rect:field?.bed});
    pay(world,0.01);
    return ok();
  }
  if (kind!=='camp_collect') return fail('UNKNOWN_KIND');
  let cost=0.02; // P0-2：与 AI 基础动作同表；crop/berry 分别对齐 harvest/forage，其余营地采集保留小成本
  if (node) {
    const picked=s.regionHarvest??={};
    if (!regionReady(node,world.t,picked[node.id],DAY_TICKS)) return fail('NO_PRODUCE');
    picked[node.id]=world.t;
    world.observeProduction?.('collected',item,1);
    cost=item==='berry'?SURV_COST.forage:SURV_COST.harvest;
  } else if (item==='water') {
    if (site!=='well') return fail('NOT_WELL');
    if (amount(bag,'water')>=3) return fail('BUCKET_FULL');
  } else if (item==='crop') {
    if (site!=='garden') return fail('NOT_GARDEN');
    if (!Number.isInteger(plot)) return fail('BAD_PLOT');
    const result=doHarvest(world,'p1',plot,1);
    if (!result.ok) return result;
    world.observeProduction?.('collected', 'crop', 1);
    cost=SURV_COST.harvest;
  } else if (item==='berry') {
    const result=doForage(world,'p1',site,target);
    if (!result.ok) return result;
    s.produce.berry-=1;
    world.observeProduction?.('collected', 'berry', 1);
    cost=SURV_COST.forage;
  } else {
    if (target && (s.frightenedAnimals?.[target]??0)>world.t) return fail('ANIMAL_AFRAID');
    if (site!==(item==='fruit'?'garden':'yard')) return fail('WRONG_SOURCE');
    if (s.farmLife && !target) return fail('NO_PRODUCE');
    if (!takeProduce(s,item,1,target)) return fail('NO_PRODUCE');
    world.observeProduction?.('collected', item, 1);
  }
  // Local berries and crops already emit at the shared harvest settlement.
  if (node || ['fruit','egg','wool','milk'].includes(item)) {
    const motion=item==='wool'?'shear':item==='milk'?'milk':'pick';
    noteWorkMotion(world,'p1',motion,{item,target,at:node?[node.x,node.z]:undefined});
  }
  bag[item]=amount(bag,item)+1;
  noteRes(world, 'personal', item, 1); // D1：从来源/树上收进个人包
  pay(world,cost);
  return ok();
}

