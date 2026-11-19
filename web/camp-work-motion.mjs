import { itemBoxes } from './camp-items.mjs';
import { WALK_DIRECTIONS, walkDirection } from './walk.mjs';
import { rotate } from '../shared/camp-geometry.mjs';

const clamp=(v,lo=0,hi=1)=>Math.max(lo,Math.min(v,hi));
const mix=(a,b,t)=>a.map((v,i)=>v+(b[i]-v)*t);
const smooth=t=>t*t*(3-2*t);
// Each stroke has an anticipation, one contact, and a recovery, in real seconds.
const strokes={
  hammer:{duration:.78,hit:.43,tool:'hammer',height:.58},
  chop:{duration:.94,hit:.49,tool:'axe',height:.64},
  mine:{duration:1.04,hit:.51,tool:'pick',height:.29},
  sow:{duration:1.04,hit:.43,height:.04},
  water:{duration:1.32,hit:.34,tool:'bucket',height:.04},
  pick:{duration:.94,hit:.46,tool:'basket',height:.4},
  shear:{duration:1.12,hit:.38,tool:'shears',height:.58},
  milk:{duration:1.38,hit:.35,tool:'bucket',height:.34},
  give:{duration:1.08,hit:.52,height:.77},
};

// A cursor per viewport/world. The first snapshot is a baseline, including after restoring a save.
export function workPlayback() {
  let identity, lastTick=-1, cursor=0, currentRows;
  const lanes=new Map();
  return (key,t,rows,now)=>{
    const tail=rows.at(-1)?.seq;
    if (key!==identity || t<lastTick || tail!==undefined && tail<cursor) {
      lanes.clear(); cursor=tail??0; identity=key;
    }
    lastTick=t;
    if (rows!==currentRows) {
      for (const row of rows) {
        if (row.seq<=cursor) continue;
        cursor=row.seq;
        if (!Object.hasOwn(strokes,row.kind) || t-row.t>1) continue;
        const lane=lanes.get(row.actor)??[];
        const start=Math.max(now,lane.at(-1)?.end??now);
        if (start-now<2.2) lane.push({row,start,end:start+strokes[row.kind].duration});
        lanes.set(row.actor,lane);
      }
      currentRows=rows;
    }
    const active=[];
    for (const [actor,lane] of lanes) {
      while (lane.length && lane[0].end<=now) lane.shift();
      if (!lane.length) { lanes.delete(actor); continue; }
      const clip=lane[0];
      clip.phase=clamp((now-clip.start)/(clip.end-clip.start));
      active.push(clip);
    }
    return active;
  };
}

function nearEdge(rect,person) {
  return [clamp(person.x,rect.x+.08,rect.x+rect.w-.08),clamp(person.z,rect.z+.08,rect.z+rect.d-.08)];
}
export function workContact(row,p,{site,people,animals,exterior,stage,heightAt}) {
  if ((row.actor==='p1' && (row.room??null)!==(site??null)) ||
      (site && row.actor!=='p1' && row.loc!==site && row.room!==site)) return null;
  let at, height=strokes[row.kind].height;
  if (row.kind==='give') {
    const other=people.find(q=>q.who===row.target);
    if (!other) return null;
    const dx=p.x-other.x,dz=p.z-other.z,span=Math.hypot(dx,dz)||1;
    return [other.x+.28*dx/span,other.y+(other.stage==='child'?.52:.77),other.z+.28*dz/span];
  }
  if (site) {
    const candidates=stage.interactables?.filter(q=>q.kind===row.prop ||
      (['water','sow','pick'].includes(row.kind) && ['planter','trellis'].includes(q.kind)));
    const prop=candidates?.sort((a,b)=>Math.hypot(a.x+a.w/2-p.x,a.z+a.d/2-p.z)-Math.hypot(b.x+b.w/2-p.x,b.z+b.d/2-p.z))[0];
    if (prop) at=nearEdge(prop,p);
  } else {
    const rect=row.rect ?? (row.door && (exterior?.homes3d?.entrances[row.door]??stage.entrances?.[row.door])) ??
      (row.home && exterior?.workProjects?.find(q=>q.record.loc===row.home)?.lot);
    if (rect) at=nearEdge(rect,p);
    else if (row.at) at=row.at;
    else if (row.target) {
      const animal=animals.find(a=>a.id===row.target);
      const plant=exterior?.life3d?.gatherables?.find(a=>a.id===row.target) ??
        exterior?.regional?.gatherables?.find(a=>a.id===row.target);
      const source=animal??plant;
      if (!source) return null;
      at=[source.x,source.z];
    }
    if (row.item==='fruit') height=1.56;
    if (row.item==='egg') height=.18;
    if (row.item==='crop') height=.25;
    if (row.item==='milk'||row.item==='wool'||row.item==='fruit'||row.item==='berry') {
      if (at) {
        const dx=p.x-at[0],dz=p.z-at[1],dist=Math.hypot(dx,dz)||1;
        const offset=Math.min(dist,row.item==='fruit'?.69:row.item==='berry'?.26:.34);
        at=[at[0]+dx/dist*offset,at[1]+dz/dist*offset];
      }
    }
  }
  if (!at) {
    // Location-level jobs have no finer object in the simulation.
    const yaw=Math.max(0,WALK_DIRECTIONS.indexOf(p.direction))*Math.PI/4;
    at=[p.x-Math.sin(yaw)*.52,p.z+Math.cos(yaw)*.52];
  }
  return [at[0],heightAt(...at)+height,at[1]];
}

// Static impacts stay on the workpiece even if the player walks during recovery.
export function clipContact(clip,p,scene) {
  const row=clip.row;
  const follows=row.kind==='give' || ['wool','milk','egg'].includes(row.item);
  if (!follows && clip.contact && clip.site===scene.site) return clip.contact;
  const point=workContact(row,p,scene);
  if (!follows && point) { clip.contact=point; clip.site=scene.site; }
  return point;
}

function limb(from,to,r,color) {
  const [dx,dy,dz]=to.map((v,i)=>v-from[i]);
  return {x:from[0]-r,y:from[1],z:from[2]-r,w:r*2,h:Math.hypot(dx,dy,dz),d:r*2,color,
    rot:[Math.atan2(Math.hypot(dx,dz),dy),Math.atan2(dx,dz),0],pivot:from};
}
function held(boxes,item,pivot,angles,scale,origin=[.5,.45,.5],open=0) {
  for (const [x,y,z,w,h,d,color] of itemBoxes(item)) {
    const blade=item==='shears' && y>=.51;
    boxes.push({x:pivot[0]+(x-origin[0]+(blade?(x<.5?-open:open):0))*scale,
      y:pivot[1]+(y-origin[1])*scale,z:pivot[2]+(z-origin[2])*scale,
      w:w*scale,h:h*scale,d:d*scale,color,rot:angles,pivot});
  }
}
const grain=(out,point,size,color,aspect=[1,1,1])=>{
  const [w,h,d]=aspect.map(n=>n*size);
  out.push({x:point[0]-w/2,y:point[1]-h/2,z:point[2]-d/2,w,h,d,color});
};

export function sampleWork(p,row,phase,contact) {
  const spec=strokes[row.kind], kind=row.kind;
  const yaw=Math.atan2(contact[0]-p.x,contact[2]-p.z);
  const direction=walkDirection(contact[0]-p.x,contact[2]-p.z,p.direction);
  const scale=p.stage==='child'?.72:p.stage==='elder'?.91:1;
  const local=(side,up,ahead)=>[p.x+scale*(side*Math.cos(yaw)+ahead*Math.sin(yaw)),
    p.y+up*scale,p.z+scale*(-side*Math.sin(yaw)+ahead*Math.cos(yaw))];
  const before=phase<spec.hit, travel=smooth(clamp(phase/spec.hit));
  const after=clamp((phase-spec.hit)/(1-spec.hit)), reach=before?travel:1-smooth(after);
  const cycle=Math.sin(after*Math.PI*4);
  const body=[],fx=[];
  const low=['sow','milk','mine','pick','water'].includes(kind);
  const crouch=reach*(low?.18:.055)*scale;
  const rShoulder=local(.21,.86-crouch/scale,.08+reach*.12), lShoulder=local(-.21,.86-crouch/scale,.08+reach*.12);
  const ready=local(.25,.7,.22);
  // Logical work sites can be farther away than the displayed actor (especially autonomous residents).
  // Keep limbs local. The impact still marks the actual plot, workpiece or recipient.
  const dist=Math.hypot(...contact.map((v,i)=>v-rShoulder[i]));
  const near=mix(rShoulder,contact,Math.min(1,1.35*scale/Math.max(.01,dist)));
  let hand=mix(ready,near,reach), left=local(-.25,.5,.10), tip=hand;
  const strike=['hammer','chop','mine'].includes(kind);
  if (strike) {
    const high=kind==='mine'?local(.06,1.68,-.1):kind==='chop'?local(.75,1.02,-.22):local(.22,1.44,.08);
    const rest=local(.34,.86,.39);
    const wind=.55;
    tip=before ? travel<wind?mix(rest,high,travel/wind):mix(high,near,(travel-wind)/(1-wind))
      :mix(near,rest,smooth(after));
    const angle=kind==='chop'?1.36:kind==='mine'?2.37:1.85;
    const rot=[(before?travel:1-after)*angle,yaw,kind==='chop'?(1-reach)*.7:0];
    const grip=rotate([0,-.42*scale,0],rot);
    hand=tip.map((v,i)=>v+grip[i]);
    left=mix(lShoulder,hand,kind==='hammer'?.41:.82);
    held(body,spec.tool,tip,rot,.8*scale,[.55,.78,.49]);
  } else if (kind==='water') {
    hand=mix(ready,local(.18,.88,.51),reach);
    left=mix(left,hand,.52*reach);
    held(body,'bucket',hand,[reach*1.18,yaw,0],.59*scale,[.5,.8,.5]);
    tip=hand;
  } else if (kind==='sow') {
    hand=mix(local(-.09,.58,.14),local(.26,.52,.66),reach);
    left=local(-.12,.53,.24);
  } else if (kind==='pick') {
    left=local(-.2,.51,.27);
    held(body,'basket',left,[0,yaw,0],.53*scale,[.5,.83,.5]);
    hand=before?mix(ready,near,travel):mix(near,left,smooth(after));
    if (!before && after<.9) held(body,row.item,hand,[0,yaw,0],.28*scale);
  } else if (kind==='shear') {
    hand=mix(ready,near,reach); hand[1]+=.07*cycle;
    held(body,'shears',hand,[1.35,yaw,0],.55*scale,[.5,.73,.5],.12*Math.abs(cycle));
    left=mix(left,near,reach*.76);
  } else if (kind==='milk') {
    const bucket=local(.09,.03,.49);
    held(body,'bucket',bucket,[0,yaw,0],.52*scale,[.5,.04,.5]);
    hand=mix(ready,near,reach); hand[1]-=.08*Math.abs(cycle);
    left=mix(left,near,reach*.85); left[1]+=.05*cycle;
    tip=[bucket[0],bucket[1]+.19*scale,bucket[2]];
  } else if (kind==='give') {
    hand=mix(local(.12,.65,.25),near,reach); left=mix(left,hand,.7*reach);
    if (before) held(body,row.item,hand,[0,yaw,0],.43*scale);
  }
  for (const [shoulder,wrist,side] of [[rShoulder,hand,1],[lShoulder,left,-1]]) {
    const elbow=mix(shoulder,wrist,.5);
    elbow[0]+=.09*side*Math.cos(yaw); elbow[2]-=.09*side*Math.sin(yaw); elbow[1]-=.09;
    body.push(limb(shoulder,elbow,.081*scale,p.color),limb(elbow,wrist,.066*scale,'#D58274'));
  }
  if (!before) {
    if (kind==='water' && after>.28 && after<.93) {
      // A spreading ring of wet soil where the stream meets the bed.
      const rim=(after-.28)*.36;
      for (let i=0;i<7;i++) {
        const angle=i*2*Math.PI/7;
        grain(fx,[contact[0]+rim*Math.cos(angle),contact[1]+.016,contact[2]+rim*Math.sin(angle)],.055,'#56838A',[1.3,.27,1]);
      }
    }
    const color={hammer:'#D5B78C',chop:'#CC9764',mine:'#B7C0BB',sow:'#DEB663',water:'#8CCBD3',
      pick:'#86A961',shear:'#F0E5C9',milk:'#ECE2C9',give:'#D6BC8A'}[kind];
    if (kind==='give') {
      if (after<.4) {
        // Logical neighbours can appear in distant render slots. Keep the prop within reach.
        const gap=Math.hypot(...contact.map((v,i)=>v-near[i]));
        const passing=gap<.8?mix(near,contact,smooth(after/.4)):(after<.2?near:contact);
        held(fx,row.item,passing,[0,yaw,0],.43*scale);
      }
    } else for (let i=0;i<6;i++) {
      const t=clamp((after-i*.045)/.69);
      if (t<=0 || t>=1) continue;
      const a=i*2.4+row.seq*.62, scatter=.06+.12*(i%3);
      const dx=Math.cos(a)*scatter,dz=Math.sin(a)*scatter;
      let point,size,aspect;
      if (kind==='milk' || kind==='water' || kind==='sow') {
        const start=kind==='milk'?near:kind==='water'?tip:hand;
        const end=kind==='milk'?tip:contact;
        point=mix(start,end,t);
        point[0]+=dx*t*.5;point[2]+=dz*t*.5;
        point[1]+=Math.sin(t*Math.PI)*(kind==='sow'?.18:.06);
        size=kind==='sow'?.052:.064;aspect=kind==='sow'?[1,.7,.8]:[.8,1.65,.8];
      } else {
        point=[contact[0]+dx*t,contact[1]+Math.sin(t*Math.PI)*(kind==='shear'?.1:.28)-.11*t,contact[2]+dz*t];
        size=(kind==='shear'?.12:.082)*(1-.48*t);
        aspect=kind==='chop'?[1.8,.55,.7]:kind==='pick'?[1.4,.45,1]:[1,1,1];
      }
      grain(fx,point,size,color,aspect);
    }
  }
  return {body,fx,crouch,direction};
}

export function receiveWork(receiver,giver,row,phase,contact) {
  const dx=giver.x-receiver.x,dz=giver.z-receiver.z,yaw=Math.atan2(dx,dz);
  const scale=receiver.stage==='child'?.72:receiver.stage==='elder'?.91:1;
  const body=[],reach=smooth(clamp(phase/.52))*(1-smooth(clamp((phase-.72)/.28)));
  let palm;
  for (const side of [-1,1]) {
    const root=[receiver.x+.2*side*Math.cos(yaw)*scale,receiver.y+.84*scale,
      receiver.z-.2*side*Math.sin(yaw)*scale];
    const elbow=[root[0],root[1]-.2*scale,root[2]];
    const rest=[root[0],root[1]-.36*scale,root[2]];
    const wrist=mix(rest,contact,reach*(side===1?1:.78));
    body.push(limb(root,elbow,.081*scale,receiver.color),limb(elbow,wrist,.065*scale,'#D58274'));
    if (side===1) palm=wrist;
  }
  if (phase>=.52+.48*.4) held(body,row.item,palm,[0,yaw,0],.43*scale);
  return {body,fx:[],direction:walkDirection(dx,dz,receiver.direction),crouch:0};
}
