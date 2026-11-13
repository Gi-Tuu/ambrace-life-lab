import { HEAVY_CAMP_TOOLS, nearResident } from '../web/camp-interaction.mjs';
import { WORLD_TW, WORLD_TH } from './geometry.mjs';
import { speechLine } from './speech.mjs';
import { DAY_TICKS, dayOf } from './clock.mjs';
import { TIMBER_GROVE } from '../web/camp-layout.mjs';
import { doForage, doGather } from './production.mjs';
import { SURV_COST, isAlive } from './body.mjs';
import { doHarvest, doPlant } from './worldstate.mjs';

const STORAGE = Object.freeze({
  home:['4'], store:['0','1','2','3','4','5'], workshop:['3','4'],
  watch:['1','3'], garden:['0'], well:['2','3'], yard:['0','1','2'],
});
const TOOLS=Object.freeze({berry:'basket',fruit:'basket',crop:'basket',egg:'basket',wool:'shears',milk:'bucket',water:'bucket'});
const ITEMS=new Set(['wood','stone','tray',...Object.keys(TOOLS)]);
const FOOD=new Set(['berry','fruit','crop','egg','milk']);
const ok=()=>({ok:true,code:'OK'});
const fail=code=>({ok:false,code});
const amount=(bag,item)=>bag?.[item]??0;
const setCount=(bag,item,n)=>{bag[item]=n;};

const playerHome=(world,site)=>site==='home' || (Boolean(site) && site===world.housing?.p1);
// P0-3：玩家动作与居民同权，也付存续代价（只在动作成功时扣）。
const pay=(world,cost)=>{world.agents.p1?.viab?.spend?.(cost);};
export function campTimberView(world) {
  const cut=world.survival.campTrees??{};
  return Object.fromEntries((world.campLayout?.grove??TIMBER_GROVE).map(tree=>{
    const regrowAt=cut[tree.id]??0;
    return [tree.id,{stage:regrowAt>world.t?'sapling':'mature',regrowAt}];
  }));
}
export function campSleepTicks(world) {
  if (!playerHome(world,world.loc.p1)) return fail('NOT_HOME');
  if (!isAlive(world.agents.p1) || (!world.independentWorld && (world.survival.ended || world.survival.failed))) return fail('CAMP_ENDED');
  const hour=world.t%DAY_TICKS;
  return {...ok(),ticks:Math.min(24,hour>=12?DAY_TICKS-hour:4)};
}

function interactWithResident(world,{target,tool,room,from,to}) {
  if (typeof target!=='string' || target==='p1' || !Object.hasOwn(world.agents,target)) return fail('NO_RESIDENT');
  const npc=world.agents[target], site=world.loc[target], s=world.survival;
  if (!npc.viab || npc.viab.v<=0 || !nearResident(from,to)) return fail('RESIDENT_OUT_OF_REACH');
  if (room===null) {
    if ([from,to].some(([x,z])=>x<0 || z<0 || x>=WORLD_TW || z>=WORLD_TH)) return fail('RESIDENT_OUT_OF_REACH');
  } else if (room!==site || world.loc.p1!==room ||
    [from,to].some(([x,z])=>x<0 || z<0 || x>16 || z>12)) return fail('RESIDENT_OUT_OF_REACH');

  if (HEAVY_CAMP_TOOLS.includes(tool)) {
    const wounds=s.campWounds??={};
    if (world.t-(wounds[target]?.t??-Infinity)<2) return fail('RESIDENT_COOLDOWN');
    const before=npc.viab.v;
    npc.hurtBy='受伤'; // P0-1：致死原因可追溯
    npc.viab.v=Math.max(0,before-.14);
    const damage=before-npc.viab.v;
    wounds[target]={t:world.t,total:(wounds[target]?.total??0)+damage};
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
  return {...ok(),code:'RESIDENT_TALKED',name:npc.name,line:speechLine(npc,{world,kind:'talk',actionId:'talk:p1',t:world.t})};
}

export function campAction(world,body) {
  const {kind,type:item,target,tool,plot}=body, site=world.loc.p1, s=world.survival;
  if (!isAlive(world.agents.p1) || (!world.independentWorld && (s.ended || s.failed))) return fail('CAMP_ENDED');
  if (kind==='camp_resident') return interactWithResident(world,body);
  const bag=world.pinv.p1;
  if (kind==='camp_store' || kind==='camp_take') {
    const [room,slot]=typeof target==='string'?target.split(':'):[], table=slot==='meal' && playerHome(world,room);
    const shelf=room===world.housing?.p1 && slot==='2';
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
    if (!playerHome(world,site)) return fail('NOT_HOME');
    if (amount(bag,'tray')<1) return fail('NEED_TRAY'); // 托盘是餐具：没有它只能看着饭
    const meal=s.campContainers?.[`${site}:meal`];
    if (!FOOD.has(item) || !amount(meal,item)) return fail('EMPTY');
    setCount(meal,item,amount(meal,item)-1);
    const pl=world.agents.p1;
    pl?.viab?.regen?.(1);              // 一份饭按 mealYield 折算；低于 mealMin 不算进食
    pl?.drives?.reward?.('energy',0.35);
    s.mealsEaten=(s.mealsEaten??0)+1;
    return ok();
  }
  if (kind==='camp_chop') {
    if (tool!=='axe') return fail('NEED_TOOL');
    const tree=(world.campLayout?.grove??TIMBER_GROVE).find(t=>t.id===target);
    if (!tree || tree.site!==site) return fail('NO_TREE');
    const trees=(s.campTrees??={});
    if ((trees[target]??0)>world.t) return fail('TREE_GROWING');
    const cut=doGather(world,'p1');
    if (!cut.ok) return cut; // P0-3：储量采空不能砍，树不标记（与资源账同步，等再生）
    trees[target]=world.t+3*DAY_TICKS;
    pay(world,SURV_COST.gather); // P0-2：与 AI gather 同价
    return cut;
  }
  if (kind==='camp_craft') {
    if (!['workshop','yard'].includes(site)) return fail('NOT_WORKBENCH');
    if (item!=='tray') return fail('BAD_ITEM');
    if (amount(bag,'wood')<2) return fail('NO_MATERIAL');
    bag.wood-=2;
    world.observeProduction?.('materialSpent', 'craftWood', 2);
    bag.tray=amount(bag,'tray')+1;
    pay(world,0.01);
    return ok();
  }
  if (kind==='camp_plant') {
    if (site!=='garden') return fail('NOT_GARDEN');
    if (tool!=='hoe') return fail('NEED_TOOL');
    if (!Number.isInteger(plot)) return fail('BAD_PLOT');
    const done=doPlant(world,'p1',plot);
    if (done.ok) pay(world,SURV_COST.plant); // P0-2：与 AI plant 同价
    return done;
  }
  if (kind==='camp_water') {
    if (site!=='garden') return fail('NOT_GARDEN');
    if (tool!=='bucket') return fail('NEED_TOOL');
    if (!amount(bag,'water')) return fail('EMPTY');
    if (s.water>=1) return fail('WATER_FULL');
    bag.water-=1;
    s.water=Math.min(1,s.water+.12);
    pay(world,0.01);
    return ok();
  }
  if (kind!=='camp_collect') return fail('UNKNOWN_KIND');
  if (!Object.hasOwn(TOOLS,item)) return fail('BAD_ITEM');
  if (tool!==TOOLS[item]) return fail('NEED_TOOL');
  let cost=0.02; // P0-2：与 AI 基础动作同表；crop/berry 分别对齐 harvest/forage，其余营地采集保留小成本
  if (item==='water') {
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
    const result=doForage(world,'p1');
    if (!result.ok) return result;
    s.produce.berry-=1;
    world.observeProduction?.('collected', 'berry', 1);
    cost=SURV_COST.forage;
  } else {
    if (site!==(item==='fruit'?'garden':'yard')) return fail('WRONG_SOURCE');
    if (!amount(s.produce,item)) return fail('NO_PRODUCE');
    s.produce[item]-=1;
    world.observeProduction?.('collected', item, 1);
  }
  bag[item]=amount(bag,item)+1;
  pay(world,cost);
  return ok();
}
