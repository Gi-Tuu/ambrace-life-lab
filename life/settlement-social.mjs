import { dayOf, DAY_TICKS } from './clock.mjs';
import { reachableOf } from './coupling.mjs';
import { laborStage } from './households.mjs';
import { isAlive, livingResidents } from './viability.mjs';
import { REL_NEUTRAL } from './relations.mjs';
import { forecastDisasters } from './worldstate.mjs';
import { farmGroundReady, nextFarmBed } from './farmland.mjs';

const TOPICS = {
  famine:'公仓告急，先补粮', storm:'风暴将至，优先避险和维修', cold:'寒潮将至，优先取暖和储粮',
  build:'工地缺人，协调施工', farm:'评估增开菜畦', housing:'安排搬家与住房',
};
const relation = (a,id) => a.relations.map.get(id) ?? REL_NEUTRAL;
const memory = (a,w,kind,payload) => a.memory.add(w.t,{kind,payload,mSnapshot:a.bank.snapshot(),importance:.48});
const publicRoom = loc => ['hall','home','store','yard','garden','workshop'].includes(loc);
const score = (a,other,severity) => {
  const r=relation(a,other), v=a.drives.v, g=a.traits.goals;
  return severity*.4 + g.social*.22 + r.trust*.003 + r.familiarity*.1 +
    Math.max(0,a.drives.setpoint.social-v.social)*.25 - (1-v.energy)*.2;
};
function topicOf(w) {
  const s=w.survival;
  if (s.store < Math.max(1,livingResidents(w).length-1)) return ['famine',.9];
  const forecast=forecastDisasters(w);
  if (forecast?.stormTomorrow) return ['storm',.87];
  if (forecast?.coldsnapTomorrow) return ['cold',.83];
  if (s.coop?.task || s.sites.length) return ['build',.8];
  if (s.farmLife && s.store < livingResidents(w).length*2 && s.plots.every(p=>p.growth>0) &&
      farmGroundReady(w) && nextFarmBed(w)) return ['farm',.75];
  if (Object.keys(s.households?.projects??{}).length) return ['housing',.76];
  return null;
}
function available(w,id) {
  const a=w.agents[id];
  return isAlive(a) && !a.isPlayer && laborStage(w,id) && reachableOf(a) &&
    a.drives.v.energy>.25 && w.survival.talk?.target!==id;
}

export function discussionPaths(w,id) {
  const s=w.survival;
  if (!s?.settlementLife || !w.discussionsEnabled || !available(w,id)) return [];
  const a=w.agents[id], room=w.loc[id], meeting=s.discussions.active;
  if (meeting) {
    if (meeting.room!==room || w.t>=meeting.until) return [];
    const state=meeting.members[id];
    if (state==='invited') {
      const value=score(a,meeting.by,meeting.severity);
      return value>=.52 ? [{kind:'discuss_join',value:value+.32}] : [{kind:'discuss_decline',value:.65}];
    }
    if (state==='joined') return a.drives.v.energy<.43
      ? [{kind:'discuss_leave',value:.72}]
      : [{kind:'discuss_share',value:.78}];
    return [];
  }
  if (!publicRoom(room) || w.t<(s.discussions.next??0)) return [];
  const [topic,severity]=topicOf(w)??[];
  if (!topic || w.t-(s.discussions.last?.[topic]??-Infinity)<2*DAY_TICKS) return [];
  const peers=(w.occupancy[room]??[]).filter(peer=>peer!==id && available(w,peer));
  const value=Math.max(0,...peers.map(peer=>score(a,peer,severity)));
  return value>.53 ? [{kind:'discuss_open',value}] : [];
}

export function discussionAction(w,id,kind,commit=false) {
  const path=discussionPaths(w,id).find(p=>p.kind===kind);
  if (!path) return {ok:false,code:'NO_DISCUSSION'};
  if (!commit) return {ok:true};
  const d=w.survival.discussions, a=w.agents[id];
  if (kind==='discuss_open') {
    const [topic,severity]=topicOf(w), room=w.loc[id];
    const peers=w.occupancy[room].filter(peer=>peer!==id && available(w,peer))
      .sort((x,y)=>score(a,y,severity)-score(a,x,severity)).slice(0,3);
    d.active={t:w.t,until:w.t+3,by:id,room,topic,severity,members:{[id]:'joined',
      ...Object.fromEntries(peers.map(peer=>[peer,'invited']))}};
    (d.last??={})[topic]=w.t;
    d.next=w.t+DAY_TICKS;
  } else if (kind!=='discuss_share') d.active.members[id]={discuss_join:'joined',discuss_decline:'declined',discuss_leave:'left'}[kind];
  memory(a,w,kind,TOPICS[d.active.topic]);
  return {ok:true,code:'OK'};
}

export function finishDiscussion(w,log) {
  const d=w.survival.discussions, m=d?.active;
  if (!m) return;
  for (const [id,state] of Object.entries(m.members)) {
    if (state==='joined' && (!available(w,id) || w.loc[id]!==m.room)) m.members[id]='left';
  }
  if (w.t<m.until && m.members[m.by]==='joined' && Object.values(m.members).includes('invited')) return;
  const present=Object.keys(m.members).filter(id=>m.members[id]==='joined');
  const advice=Object.fromEntries(present.map(id=>{
    const a=w.agents[id], safe=a.traits.goals.safety;
    return [id,a.drives.v.energy<.48?'先休整':m.topic==='storm'||m.topic==='cold'
      ? (safe>=.5?'先避险':'先加固') : TOPICS[m.topic]];
  }));
  const agreed=present.length>=2 && new Set(Object.values(advice)).size===1;
  const record={...m,ended:w.t,advice,result:present.length<2?'no_quorum':agreed?'agreed':'split'};
  for (const id of present) {
    memory(w.agents[id],w,'discussion_result',advice[id]);
    if (id!==m.by) w.agents[id].relations.meet(m.by,w.t,{delta:{familiarity:.04,trust:agreed?3:0}});
  }
  (d.history??=[]).push(record);
  if (d.history.length>80) d.history.shift();
  log.push({t:w.t,kind:'discussion',ok:present.length>=2,code:record.result,topic:m.topic});
  d.active=null;
}

export function discussionSupport(w,id,action) {
  if (!w.discussionsEnabled) return 0;
  const last=w.survival?.discussions?.history?.at(-1);
  if (!last || last.result!=='agreed' || last.members[id]!=='joined' || w.t-last.ended>8) return 0;
  if (last.advice[id]==='先避险') return action.kind==='rest'?.18:0;
  if (last.advice[id]==='先加固') return action.kind==='repair'?.18:0;
  const relevant={farm:['till','plant'],build:['build','repair','plan'],famine:['harvest','forage','exchange'],
    storm:['repair','rest'],cold:['rest'],housing:['house_work']};
  if (last.advice[id]==='先休整') return action.kind==='rest'?.18:0;
  return relevant[last.topic]?.includes(action.kind) ? .18 : 0;
}

export function socialNetwork(w) {
  if (!w.survival.settlementLife) return undefined;
  const s=w.survival, h=s.households;
  const current=Object.entries(h?.spouses??{}).filter(([a,b])=>a<b && h.spouses[b]===a).map(([a,b])=>[a,b]);
  return {
    people:Object.values(w.agents).map(a=>({id:a.id,name:a.name,alive:isAlive(a),home:w.housing?.[a.id]??null})),
    ties:Object.values(w.agents).flatMap(a=>[...a.relations.map].filter(([id])=>id!==a.id && Object.hasOwn(w.agents,id))
      .map(([to,r])=>({from:a.id,to,...r}))),
    parents:Object.entries(h?.residents??{}).flatMap(([child,r])=>(r.parents??[]).map(parent=>({parent,child}))),
    marriages:{current,history:h?.marriages??[]},
    cooperation:(s.coop?.completions??[]).slice(-80), housing:h?.housingHistory?.slice(-80)??[],
    doors:s.doorHistory??[], discussions:s.discussions,
    changes:Object.values(w.agents).flatMap(a=>(a.relations.history??[]).map(row=>({from:a.id,...row})))
      .sort((a,b)=>a.t-b.t).slice(-80),
  };
}
