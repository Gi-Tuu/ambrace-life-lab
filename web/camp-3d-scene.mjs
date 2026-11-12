import { reliefFaces, floorContains, campHash } from './camp-terrain.mjs';
import { constructionLot, residentialSite, TIMBER_GROVE } from './camp-layout.mjs';

const WOOD = '#BA8752', DARK = '#72513B', LIGHT = '#D8A667';

function stage(width, depth) {
  const boxes = [], floors = [], fxs = [], chimneys = [], interactables = [], animals = [], gatherables = [];
  let occluder = null;
  return {
    width, depth, boxes, floors, fxs, chimneys, interactables, animals, gatherables, entrances: {},
    group(id, build) {
      const previous=occluder;
      occluder=id;
      build();
      occluder=previous;
    },
    // fxKind 非空 ⇒ 这块几何不进静态网格，改由渲染器按动画帧逐帧生成（呼吸感）。
    box(x, y, z, w, h, d, color, solid = false, glow = false, fxKind = null) {
      const item = { x,y,z,w,h,d,color,solid,glow,occluder };
      if (fxKind) { item.fx = fxKind; fxs.push(item); }
      boxes.push(item);
      return item;
    },
    floor(x, z, w, d, y, color, axis, end = y) { floors.push({ x,z,w,d,y,color,axis,end }); },
    heightAt(x, z) {
      let y = 0;
      for (const f of floors) {
        if (!floorContains(f,x,z)) continue;
        if (f.triangle) {
          y = Math.max(y, f.y + f.ax*(x-f.x) + f.az*(z-f.z));
          continue;
        }
        const t = f.axis === 'x' ? (x - f.x) / f.w : f.axis === 'z' ? (z - f.z) / f.d : 0;
        y = Math.max(y, f.y + (f.end - f.y) * t);
      }
      return y;
    },
  };
}

function rail(s, x, z, w, d, y, solid = true) {
  s.box(x, y + .46, z, w, .17, d, WOOD, solid);
  s.box(x, y + .22, z, w, .09, d, DARK);
  const alongX = w >= d, length = alongX ? w : d;
  const count = Math.max(1, Math.ceil(length / 1.35));
  for (let i = 0; i <= count; i += 1) {
    const t = i / count;
    const px = x + (alongX ? (w - .13) * t : 0), pz = z + (alongX ? 0 : (d - .13) * t);
    s.box(px, y, pz, alongX ? .13 : w, .69, alongX ? d : .13, DARK);
  }
}

function roof(s, x, z, w, d, y, color, tiers=5) {
  s.box(x-.22,y,z-.22,w+.44,.16,d+.44,color);
  for (let i = 0; i < tiers; i += 1) {
    s.box(x-.12,y+.16+i*.14,z+i*d*.082,w+.24,.14,d-i*d*.164,color);
  }
}

function hall(s, x, z) {
  const left = x - 3.55, right = x + 3.55, back = z - 6.8, front = z - 1.1, y = .48;
  s.floor(left, back, right-left, front-back, y, WOOD);
  s.floor(x-1, front, 2, 1.45, y, LIGHT, 'z', 0);
  s.entrances.hall = { x:x-1, z:front-.25, w:2, d:2.25 };
  rail(s,left,front-.14,x-1-left,.15,y);
  rail(s,x+1,front-.14,right-x-1,.15,y);
  rail(s,left,back,right-left,.15,y);
  rail(s,left,back,.15,front-back,y);
  rail(s,right-.15,back,.15,front-back,y);
  for (const px of [left+.12,right-.30]) {
    for (const pz of [back+.12,back+2.85]) s.box(px,y,pz,.18,2.45,.18,DARK,true);
  }
  for (const px of [left+.12,right-.30]) s.box(px,y,front-.37,.18,2.55,.18,DARK,true);
  s.group('roof:hall',() => roof(s,left,back,right-left,front-back-.25,3.04,'#3F7036'));
  s.box(left+.1,2.96,front-.4,right-left-.2,.16,.19,DARK);
  for(const bx of [left+1.1,right-1.6]){
    s.box(bx-.06,2.91,front-.25,.78,.10,.12,LIGHT);
    s.box(bx,1.74,front-.19,.66,1.19,.06,'#944735',false,false,'banner');
    s.box(bx+.2,2.27,front-.124,.26,.30,.023,'#E6BD70',false,false,'banner');
  }
}

function cladding(s, x, y, z, w, h, d, masonry) {
  const step = masonry ? .34 : .24;
  const palette = masonry ? ['#A39B88','#929082','#AAA28E','#88887D']
    : ['#BA8752','#C9955D','#D8A667','#C48D57'];
  for (let row=0; row*step<h-.06; row+=1) {
    const base = y+row*step+.025, height = Math.min(step-.035,y+h-base);
    for (const side of [0,1,-1]) {
      const length = side ? d : w, pitch = masonry ? .73 : 2.35;
      let index = 0;
      for (let start=-(row%2)*pitch/2; start<length-.035; start+=pitch) {
        const a=Math.max(.012,start+.019), b=Math.min(length-.012,start+pitch-.019);
        if (b <= a) continue;
        const color = palette[(index++*3+row+(side?1:0))%palette.length];
        if (side) s.box(side>0?x+w+.003:x-.017,base,z+a,.014,height,b-a,color);
        else s.box(x+a,base,z+d+.003,b-a,height,.014,color);
      }
    }
  }
}

function house(s, id, x, z, seed) {
  const colors = { home:'#AB5236', store:'#D8A667', workshop:'#5F574F', watch:'#83769C' };
  const variant=seed==null?null:Math.floor(campHash(seed,`roof-${id}`)*5);
  const seededColors=['#AB5236','#72513B','#5F574F','#70657A','#526B54'];
  const color=(variant==null?null:seededColors[variant])??colors[id]??({house1:'#8D593F',house2:'#526B54',house3:'#70657A',house4:'#A17B54'}[id]??'#976A45');
  const small=Boolean(residentialSite(id));
  const width=small?5.6:7.2, depth=small?4.6:6.15;
  const left=x-width/2, back=z-depth-1.7;
  s.box(left,0,back,width,.27,depth,DARK,true);
  const masonry = id === 'workshop' || id === 'watch' || variant===2;
  s.box(left+.15,.27,back+.1,width-.30,2.8,depth-.20,masonry?'#67675E':'#72513B');
  cladding(s,left+.15,.27,back+.1,width-.30,2.8,depth-.20,masonry);
  cladding(s,left,0,back,width,.27,depth,true);
  roof(s,left,back,width,depth,3.08,color,variant===2?3:variant===3?4:5);
  const front = back + depth;
  s.entrances[id] = { x:x-1.15, z:front-.55, w:2.3, d:1.5 };
  s.box(x-.63,.27,front-.02,1.26,1.82,.10,'#72513B');
  s.box(x-.49,.33,front+.09,.98,1.66,.035,'#AB5236');
  s.box(x+.23,1.02,front+.135,.11,.1,.04,'#EDC787');
  for (const dx of (small?[-1.95,1.03]:[-2.45,1.57])) {
    s.box(x+dx,1.36,front-.025,.89,.83,.1,'#514134');
    s.box(x+dx+.09,1.45,front+.079,.71,.65,.035,'#458996',false,true);
    s.box(x+dx+.12,1.88,front+.116,.28,.16,.02,'#A0D2C6');
  }
  if (id === 'workshop' || id === 'home') {
    s.box(x+2.2,3.55,back+1.8,.56,1.18,.62,'#5F574F');
    s.box(x+2.14,4.7,back+1.74,.68,.13,.74,'#939584');
      s.chimneys.push([x+2.48,4.92,back+2.07]);
  }
}

function watchTower(s,x,z) {
  const left=x-2.3, back=z-5.9, width=4.6, depth=4.15, deck=3.16, front=back+depth;
  for (const px of [left,left+width-.27]) for (const pz of [back,front-.27]) {
    s.box(px,0,pz,.27,5.35,.27,DARK,true);
    s.box(px-.06,0,pz-.06,.39,.32,.39,'#77766E',true);
  }
  s.box(left-.13,deck-.19,back-.13,width+.26,.19,depth+.26,WOOD);
  for (const pz of [back,front-.15]) rail(s,left,pz,width,.15,deck,false);
  for (const px of [left,left+width-.15]) rail(s,px,back,.15,depth,deck,false);
  for (let step=0;step<8;step+=1) {
    const h=(step+1)*.39;
    s.box(x-.61,h-.13,front+.1+(7-step)*.30,1.22,.13,.34,LIGHT);
  }
  for (let i=0;i<5;i+=1) {
    const h=.5+i*.48;
    s.box(left+.27+i*.65,h,front-.14,.78,.14,.15,WOOD);
    s.box(left+width-1.04-i*.65,h,back+.06,.78,.14,.15,WOOD);
  }
  s.group('roof:watch',()=>roof(s,left,back,width,depth,5.32,'#526464'));
  s.box(x-.1,deck+.64,back+.6,.2,1.0,.2,'#6F685F');
  s.box(x-.22,deck+1.42,back-.18,.44,.37,1.35,'#837C69');
  s.entrances.watch={x:x-.95,z:front+2.19,w:1.9,d:1.35};
}

function outdoorFixture(s, id, x, z) {
  s.entrances[id] = { x:x-1.1, z:z-1.35, w:2.2, d:1.5 };
  if (id === 'well') {
    s.box(x+.2,0,z-4,2.6,.72,2.65,'#67675E',true);
    cladding(s,x+.2,0,z-4,2.6,.72,2.65,true);
    s.box(x+.47,.73,z-3.73,2.05,.045,2.09,'#458996');
    for (const dx of [.28,2.56]) s.box(x+dx,.72,z-3.12,.18,1.84,.18,DARK);
    s.group('roof:well',()=>roof(s,x+.12,z-3.98,2.8,2.6,2.5,'#5F574F'));
    return;
  }
  const x0 = x+.1, z0 = z-4.95;
  s.box(x0,0,z0,3.75,.22,3.75,DARK);
  for (const dx of [.12,3.46]) for (const dz of [.12,3.46]) s.box(x0+dx,.21,z0+dz,.17,2.3,.17,DARK,true);
  // 棚屋此前是一整块深棕立方体：补屋脊亮线、檐口和两只货箱，与住屋同一套材质语言。
  s.group(`roof:${id}`,()=>{
    roof(s,x0,z0,3.75,3.75,2.5,id === 'garden' ? '#3F7036' : '#B65B3C');
    s.box(x0-.16,3.32,z0+1.62,4.07,.14,.5,id === 'garden' ? '#93AE73' : '#E99E61');
  });
  s.box(x0-.12,2.46,z0-.12,3.99,.12,.16,'#D8A667');
  s.box(x0+.36,.24,z0+.37,1.13,.76,.94,WOOD,true);
  s.box(x0+.45,1.0,z0+.46,.95,.09,.76,'#D8A667');
  s.box(x0+2.28,.24,z0+2.36,.86,.58,.84,'#72513B',true);
  s.box(x0+2.36,.82,z0+2.44,.7,.08,.68,'#D8A667');
}

const CANOPIES = [
  [[-.86,1.24,-.76,1.74,1.02,1.52],[-.68,2.21,-.59,1.38,.76,1.21],[-.41,2.94,-.35,.84,.38,.75]],
  [[-.55,1.42,-.52,1.12,.91,1.08],[-.69,2.28,-.62,1.37,.6,1.24],[-.45,2.83,-.4,.94,.61,.85],[-.24,3.39,-.21,.48,.54,.45]],
  [[-1.22,1.64,-.48,1.18,.73,.98],[-.48,1.53,-.79,1.19,1.09,1.43],[.32,1.77,-.36,.98,.69,.88],[-.42,2.57,-.48,.97,.55,.96]],
  [[-.76,1.37,-.63,1.53,.83,1.33],[-.81,2.16,-.71,1.62,.81,1.48],[-.49,2.92,-.44,.99,.76,.9],[-.26,3.64,-.24,.52,.34,.5]],
];
const LEAF_RAMPS = [
  ['#315431','#3F7036','#568D3E','#73A747'],
  ['#294A3B','#38634B','#467C57','#66916A'],
  ['#425B2D','#5B7634','#7F9942','#A4B658'],
  ['#2E5343','#437655','#5C895D','#79A477'],
];
const SHRUBS = [
  [[-.43,0,-.37,.86,.52,.74],[-.24,.47,-.21,.49,.32,.43]],
  [[-.54,0,-.28,.53,.43,.57],[-.19,.013,-.36,.61,.68,.61],[.22,.026,.02,.37,.42,.43]],
  [[-.51,0,-.29,.56,.3,.54],[-.2,.027,-.4,.46,.43,.61],[.17,.045,-.14,.49,.3,.54]],
  [[-.31,0,-.37,.68,.53,.73],[-.23,.48,-.27,.47,.44,.55],[-.13,.87,-.15,.25,.23,.29]],
];
function plantBox(s, phase, weight, rooted, ...args) {
  s.box(...args).wind={phase,weight,rooted};
}
function tree(s, x, z, variant) {
  const shades = LEAF_RAMPS[variant];
  s.box(x-.2,0,z-.21,.4,1.88,.42,DARK,true);
  s.box(x-.21,.11,z+.211,.07,1.42,.016,WOOD);
  CANOPIES[variant].forEach(([dx,y,dz,w,h,d],i) =>
    plantBox(s,x*.37+z*.81,.08+i*.032,false,x+dx,y,z+dz,w,h,d,shades[i]));
}
function flora3d(s, world) {
  const orchards=world.livestock?.orchards ?? 3;
  (world.flora ?? []).forEach(([tx,tz,seed],index) => {
    const x=tx+.5, z=tz+.5, v=(tx*7+tz*13)%4, shades=LEAF_RAMPS[v];
    if (index < orchards) {
      s.gatherables.push({x,z,item:'fruit'});
      s.group(`fruit:${tx}:${tz}`, () => {
        s.box(x-.16,0,z-.16,.32,1.45,.32,DARK);
        plantBox(s,x+z,.12,false,x-.82,1.28,z-.76,1.64,.96,1.52,shades[1]);
        plantBox(s,x+z,.12,false,x-.52,2.16,z-.48,1.04,.66,1.0,shades[2]);
        for (const [dx,y,dz] of [[-.48,1.62,.74],[.77,1.88,-.34],[.08,2.34,.5]])
          plantBox(s,x+z,.12,false,x+dx,y,z+dz,.17,.17,.17,'#CF4E53');
      });
    } else if (seed < .052) {
      if (seed < .022) s.gatherables.push({x,z,item:'berry'});
      for (const [i,[dx,y,dz,w,h,d]] of SHRUBS[v].entries())
        plantBox(s,x+z,.09,true,x+dx,y+.02,z+dz,w,h,d,shades[Math.min(i+1,3)]);
      if (seed < .022) for (const [dx,y,dz] of [[-.22,.28,.28],[.07,.46,.35],[.29,.29,.13]])
        plantBox(s,x+z,.08,false,x+dx,y,z+dz,.11,.11,.11,'#CE6274');
    } else {
      const color=['#FFEC27','#FF77A8','#FFF0CC','#68ADD4'][v];
      for (const [dx,h,dz] of [[-.16,.25,.08],[.07,.39,-.11],[.26,.19,.13]]) {
        const phase=x+z+dx;
        plantBox(s,phase,.08,true,x+dx-.025,0,z+dz-.025,.05,h,.05,'#315431');
        plantBox(s,phase,.08,false,x+dx-.082,h-.03,z+dz-.079,.164,.078,.158,color);
        plantBox(s,phase,.08,false,x+dx-.025,h+.048,z+dz-.025,.05,.026,.05,'#FFA300');
      }
    }
  });
}

function grass3d(s, sites) {
  for (const [x,z] of sites ?? []) {
    const phase=x*.89+z*.62;
    for (const [dx,dz,h] of [[-.12,0,.19],[.03,-.1,.3],[.16,.06,.23]])
      plantBox(s,phase+dx,.085,true,x+dx,0,z+dz,.043,h,.045,'#6B994D');
  }
}
function crops3d(s, world) {
  const plots = world.plots ?? [], beds = world.beds ?? [];
  for (const b of beds) {
    const bx=b.x/16, bz=b.y/16, bw=b.w/16, bh=b.h/16;
    const growth = plots[b.row*4+b.col]?.growth ?? 0;
    if (growth <= 0) continue;
    for(let r=0;r<2;r+=1) for(let c=0;c<4;c+=1){
      const x=bx+.42+c*(bw-.84)/3.5, z=bz+.5+r*(bh-1), hh=.18+growth*.6;
      s.box(x-.05,.06,z-.05,.1,hh,.1,'#315431');
      s.box(x-.22,.06+hh*.42,z-.12,.44,.16,.24,growth>=1?'#FFEC27':'#73A747');
      if(growth>=.65)s.box(x-.12,.06+hh,z-.12,.24,.22,.24,growth>=1?'#FFA300':'#98BD51');
    }
  }
}

export function penLayout(sites) {
  const yard=sites.yard;
  return yard ? {x:yard[0]-9,z:yard[1]-4,w:7,d:6.4,gate:2.75,opening:1.5} : null;
}
function livestockPen(s, sites) {
  const p=penLayout(sites);
  if (!p) return;
  const {x,z,w,d,gate,opening}=p, t=.14;
  const rails=[[x,z,w,t],[x,z+t,t,d-t],[x+w-t,z+t,t,d-t],
    [x+t,z+d-t,gate-t,t],[x+gate+opening,z+d-t,w-gate-opening-t,t]];
  rails.forEach((r,i) => s.group(`pen:${i}`,() => rail(s,...r,0)));
  for (const gx of [x+gate-t,x+gate+opening]) s.box(gx,0,z+d-t,t,.91,t,LIGHT,true);
  s.group('pen:shelter',() => {
    s.box(x+5.13,0,z+.45,1.5,1.02,1.35,WOOD,true);
    roof(s,x+5.08,z+.4,1.6,1.45,1.02,'#AB5236');
    s.box(x+5.53,.1,z+1.8,.5,.66,.06,'#1D2B53');
  });
}
function livestock3d(s, world) {
  const pen=penLayout(world.sites);
  if (!pen) return;
  const stock=world.livestock ?? {};
  const specs=[
    ['chickens',stock.chickens??3,4,.38,1.11,2.82,.98],
    ['cows',stock.cows??2,3,.59,1.16,1.06,1.43],
    ['sheep',stock.sheep??2,3,.52,2.97,4.91,1.29],
  ];
  for (const [kind,count,limit,r,x,z,spacing] of specs) for (let i=0;i<Math.min(count,limit);i+=1) {
    const px=pen.x+x+i*spacing, pz=pen.z+z+(i%2)*.11;
    const boxes=[];
    s.animals.push({id:`${kind}:${i}`,x:px,z:pz,r,kind,boxes,speed:kind==='chickens'?1.0:.63,
      habitat:{x:pen.x+.18,z:pen.z+.18,w:pen.w-.36,d:pen.d-.36}});
    const b=(x,y,z,w,h,d,color,fx)=>boxes.push({x,y,z,w,h,d,color,fx});
    if (kind==='chickens') {
      const feathers=i%2?'#B67554':'#E8D7B3';
      b(-.16,.14,-.19,.32,.31,.38,feathers);
      b(-.117,.29,.09,.23,.23,.21,feathers,'nod');
      b(-.073,.49,.127,.15,.09,.11,'#B74C3E','nod');
      b(-.061,.339,.292,.12,.064,.082,'#EAB25E','nod');
      for (const dx of [-.083,.05]) {
        b(dx,0,-.015,.035,.16,.048,'#BE8753','leg');
        b(dx-.015,0,.015,.066,.045,.087,'#BE8753','leg');
        b(dx,.432,.301,.041,.041,.011,'#2C2822','nod');
      }
      b(-.13,.3,-.28,.26,.12,.13,'#8A5A47');
      continue;
    }
    const cow=kind==='cows', coat=cow?'#DFD5BC':'#DCD3B7', face=cow?'#A07F73':'#5F5348';
    const w=cow?.74:.67, d=cow?.81:.69, y=cow?.42:.32;
    b(-w/2,y,-d/2,w,.49,d,coat);
    for (const dx of [-w*.39,w*.22]) for (const dz of [-d*.36,d*.18]) {
      b(dx,0,dz,.13,y+.08,.135,face,'leg');
      b(dx-.015,0,dz-.012,.16,.105,.17,'#3F3A33','leg');
    }
    if (cow) {
      b(-w/2-.015,y+.13,-.18,.042,.23,.39,'#57514A');
      b(.02,y+.49,-.28,.28,.012,.36,'#57514A');
      b(.068,y+.52,d*.36,.08,.13,.085,'#D6BD8A');
      b(-.147,y+.52,d*.36,.08,.13,.085,'#D6BD8A');
    } else {
      b(-.29,y+.45,-.26,.57,.12,.53,'#F0E4C7');
      b(-.32,y+.44,.105,.29,.11,.26,'#E8DCBE');
    }
    b(-.18,y+.22,d*.29,.36,.32,.29,face);
    b(-.145,y+.2,d*.29+.245,.29,.155,.072,cow?'#B48278':'#6C5748');
    for (const dx of [-.135,.08]) b(dx,y+.404,d*.29+.291,.055,.05,.013,'#262722');
    for (const dx of [-.256,.176]) b(dx,y+.43,d*.31,.08,.073,.14,face);
    b(-.044,y+.36,-d*.63,.08,.1,.16,face);
  }
}

export function outdoorStage(world, bridges, rocks) {
  const s = stage(world.tw, world.th);
  s.floors.push(...reliefFaces(world.hills ?? []));
  for (const [x0,z0,x1,z1] of bridges) {
    const y = .32, ramp = Math.min(.85,(x1-x0)/4);
    s.floor(x0,z0,ramp,z1-z0,0,WOOD,'x',y);
    s.floor(x0+ramp,z0,x1-x0-ramp*2,z1-z0,y,WOOD);
    s.floor(x1-ramp,z0,ramp,z1-z0,y,WOOD,'x',0);
    rail(s,x0+ramp,z0,x1-x0-ramp*2,.13,y);
    rail(s,x0+ramp,z1-.13,x1-x0-ramp*2,.13,y);
  }
  for (const [id,[sx,sy]] of Object.entries(world.sites)) {
    const x = sx+.5, z = sy+.5;
    if (id==='hall') hall(s,x,z);
    else if (id==='watch') watchTower(s,x,z);
    else if (['garden','well','yard'].includes(id)) outdoorFixture(s,id,x,z);
    else s.group(`site:${id}`,()=>house(s,id,x,z,world.layoutSeed));
  }
  for (const [tx,tz] of world.trees) {
    s.group(`tree:${tx}:${tz}`,() => tree(s,tx+.5,tz+.5,(tx*3+tz*7)%4));
  }
  for (const [tx,tz] of rocks) {
    s.group(`rock:${tx}:${tz}`,() => {
      s.box(tx+.12,0,tz+.12,.76,.48,.71,'#6D7165',true);
      s.box(tx+.24,.48,tz+.22,.52,.16,.47,'#939584');
    });
  }
  grass3d(s,world.grass);
  livestockPen(s, world.sites);
  return s;
}

function wildlife3d(s, places) {
  for (const [i,{x,z,kind}] of (places??[]).entries()) {
    const boxes=[], b=(x,y,z,w,h,d,color,fx)=>boxes.push({x,y,z,w,h,d,color,fx});
    const rabbit=kind==='rabbit', deer=kind==='deer';
    const coat=rabbit?'#8D8273':deer?'#AE835A':'#B2663F';
    const leg=deer?.69:rabbit?.15:.28, length=deer?.85:rabbit?.37:.56;
    const width=deer?.43:rabbit?.27:.33;
    b(-width/2,leg,-length/2,width,rabbit?.29:.36,length,coat);
    for (const dx of [-width*.46,width*.22]) for (const dz of [-length*.42,length*.25])
      b(dx,0,dz,deer?.105:.09,leg+.05,deer?.105:.13,rabbit?'#766C61':'#594439','leg');
    const neck=leg+(deer?.48:.16);
    if (deer) b(-.13,leg+.14,length*.24,.26,.52,.26,coat);
    b(-width*.42,neck,length*.3,width*.85,rabbit?.21:.25,rabbit?.23:.30,coat);
    b(-width*.32,neck+.04,length*.3+(rabbit?.18:.22),width*.64,.12,.15,deer?'#80614E':'#DDD0B0');
    for (const dx of [-width*.46,width*.26]) {
      b(dx,neck+.18,length*.32,width*.21,rabbit?.29:deer?.14:.16,.08,coat);
      b(dx,neck+.13,length*.3+(rabbit?.20:.25),.054,.052,.026,'#252825');
    }
    const tail=deer?.19:rabbit?.16:.36;
    b(-.105,leg+.15,-length/2-tail+.025,.21,.16,tail,rabbit?'#E0D4B6':coat);
    if (!rabbit && !deer) b(-.107,leg+.16,-length/2-tail,.215,.155,.13,'#E3CCAA');
    const radius=deer?.63:rabbit?.36:.57;
    s.animals.push({id:`wild:${i}`,x,z,r:radius,kind,boxes,wild:true,speed:rabbit?1.65:1.2,
      habitat:{x:x-4,z:z-4,w:8,d:8}});
  }
}

export function outdoorLife(world) {
  const s = stage(world.tw,world.th);
  crops3d(s, world);
  flora3d(s, world);
  livestock3d(s, world);
  wildlife3d(s,world.wildlife);
  return s;
}

// 室内/院内道具：19 种各自有形体，而不是"一个盒子换颜色"。
// 约定 (x,z) 是道具左下角，占约 1.9×1.5 世界单位；只有主体 solid，小装饰不参与碰撞。
function prop3d(s, kind, x, z, y) {
  const b = (dx,dy,dz,w,h,d,c,solid=false,fx=null) => s.box(x+dx,y+dy,z+dz,w,h,d,c,solid,false,fx);
  const legs = (top=.55) => {
    for(const dx of [.22,1.42]) for(const dz of [.18,1.06]) b(dx,0,dz,.16,top,.16,DARK);
  };
  switch (kind) {
    case 'bed':
      b(.1,0,.15,1.72,.36,1.28,DARK,true);
      b(.18,.36,.23,1.56,.12,1.12,'#FFF0CC');
      b(.22,.48,.28,.62,.1,.94,'#FFF0CC');
      b(.9,.48,.25,.78,.13,1.0,'#D58274');
      b(.04,0,.1,.16,.78,1.36,LIGHT);
      break;
    case 'hearth': case 'furnace':
      const stone=kind==='furnace'?'#77766E':'#98654F';
      b(.12,0,.16,1.62,.2,1.24,stone,true);
      b(.12,.2,.16,.31,.78,1.24,stone);
      b(1.43,.2,.16,.31,.78,1.24,stone);
      b(.43,.2,.16,1,.7,.63,stone);
      b(.43,.2,.795,1,.62,.028,'#32302C');
      b(.53,.22,1.09,.76,.09,.25,DARK);
      b(.58,.28,1.16,.63,.36,.14,'#FFA300',false,'fire');
      b(.71,.32,1.30,.35,.20,.045,'#FFEC27');
      b(.1,.82,.14,1.66,.19,1.29,'#9B9183');
      b(.59,1.01,.34,.52,.64,.54,stone);
      b(.54,1.65,.29,.62,.12,.64,'#939584');
      for (const dy of [.33,.6]) {
        b(.14,dy,1.403,.27,.026,.019,DARK);
        b(1.45,dy,1.403,.27,.026,.019,DARK);
      }
      break;
    case 'table':
      legs(); b(.08,.55,.08,1.74,.12,1.26,LIGHT,true);
      b(.36,.67,.37,.33,.045,.29,'#C2C3C7'); b(1.04,.67,.71,.34,.045,.3,'#C2C3C7');
      break;
    case 'workbench':
      legs(.62); b(.06,.62,.06,1.8,.13,1.3,WOOD,true);
      b(.16,.75,.2,.5,.2,.34,'#5F574F'); b(.18,.95,.22,.46,.07,.3,'#C2C3C7');
      b(1.08,.75,.66,.2,.38,.2,'#939584'); b(1.3,.75,.3,.16,.3,.16,'#72513B');
      break;
    case 'rug':
      b(.06,.01,.1,1.84,.025,1.28,'#7E2553');
      b(.18,.04,.2,1.6,.02,1.08,'#83769C');
      b(.3,.06,.3,1.36,.02,.88,'#7E2553');
      break;
    case 'shelf':
      b(.12,0,.18,.14,1.7,1.2,DARK,true); b(1.6,0,.18,.14,1.7,1.2,DARK,true);
      b(.26,0,.18,1.34,1.67,.09,DARK,true);
      for(const sy of [.12,.66,1.2,1.62]) b(.12,sy,.18,1.62,.1,1.2,LIGHT);
      for(const [sx,c] of [[.28,'#FFEC27'],[.5,'#29ADFF'],[.72,'#00E436'],[.94,'#FFA300'],[1.24,'#D58274']])
        b(sx,.76,.42,.18,.36,.22,c);
      b(.44,.22,.56,.61,.28,.54,WOOD); b(.49,.5,.6,.51,.04,.46,LIGHT);
      b(.96,1.3,.6,.27,.31,.3,'#939584'); b(.99,1.61,.63,.21,.05,.24,'#C2C3C7');
      break;
    case 'planter': case 'trellis':
      b(.14,0,.2,1.6,.42,1.1,'#AB5236',true);
      b(.22,.42,.28,1.44,.08,.94,'#482D2B');
      for(const [dx,h,c] of [[.36,.62,'#008751'],[.78,.86,'#00E436'],[1.2,.7,'#568D3E']]) {
        b(dx+.1,.5,.55,.08,h,.08,'#315431');
        b(dx,.5+h*.5,.38,.36,.34,.42,c);
        if(kind==='trellis') b(dx,1.02,.5,.36,.06,.1,'#EDC787');
      }
      if(kind==='trellis') for(const sx of [.14,1.58]) b(sx,0,.2,.12,1.8,.12,DARK);
      break;
    case 'bench':
      b(.08,.42,.3,1.76,.12,.62,LIGHT,true);
      for(const dx of [.2,1.52]) b(dx,0,.32,.15,.42,.58,DARK);
      b(.08,.54,.3,1.76,.04,.1,'#EDC787');
      break;
    case 'banner':
      b(.84,0,.5,.14,1.95,.14,DARK);
      b(.3,1.86,.44,1.24,.09,.16,LIGHT);
      b(.34,.72,.5,1.16,1.14,.07,'#944735',false,'banner');
      b(.5,1.12,.57,.84,.34,.02,'#E99E61',false,'banner');
      b(.8,1.2,.59,.24,.2,.02,'#FFEC27',false,'banner');
      break;
    case 'crate':
      b(.16,0,.2,1.56,1.02,1.12,WOOD,true);
      for(const sy of [.16,.82]) b(.16,sy,.2,1.56,.09,1.12,DARK);
      b(.28,0,.21,.12,1.02,.1,DARK); b(1.48,0,.21,.12,1.02,.1,DARK);
      b(.2,1.02,.24,1.48,.06,1.04,LIGHT);
      break;
    case 'barrel': case 'bucket': {
      const tall = kind === 'barrel';
      const top=tall?1.16:.66;
      b(.36,0,.34,1.1,top-.15,1.08,WOOD,true);
      for (const dz of [.34,1.32]) b(.36,top-.15,dz,1.1,.15,.1,LIGHT);
      for (const dx of [.36,1.36]) b(dx,top-.15,.44,.1,.15,.88,LIGHT);
      for (const dy of [.2,top-.28]) b(.32,dy,.30,1.18,.07,1.16,'#5F574F');
      for (const dx of [.53,.76,.99,1.22]) b(dx,.27,1.424,.028,top-.55,.012,DARK);
      if (tall) {
        b(.4,top-.04,.38,1.02,.06,1.0,WOOD);
        b(.58,top+.02,.53,.65,.035,.1,DARK);
      } else {
        b(.46,top-.13,.44,.9,.045,.88,'#458996');
        b(.31,.61,.68,.075,.48,.075,'#5F574F'); b(1.46,.61,.68,.075,.48,.075,'#5F574F');
        b(.31,1.09,.68,1.23,.07,.075,'#5F574F');
      }
      break;
    }
    case 'telescope':
      for (const [dx,dz,top] of [[.61,.19,.92],[1.15,1.02,.82],[.37,1.08,.72]])
        b(dx,0,dz,.14,top,.14,DARK,true);
      b(.65,.74,.47,.49,.18,.49,'#575953');
      b(.72,.92,.18,.33,.29,1.05,'#827766');
      b(.68,.89,.02,.41,.36,.2,LIGHT);
      b(.74,.96,.006,.29,.22,.022,'#458996');
      b(.775,.99,1.22,.22,.17,.15,'#5F574F');
      break;
    case 'anvil':
      b(.5,0,.4,.9,.42,.8,'#5F574F',true);
      b(.3,.42,.28,1.3,.24,.92,'#939584');
      b(1.58,.46,.48,.42,.16,.42,'#6D7165');
      break;
    case 'well':
      b(.18,0,.2,1.5,.62,1.32,'#939584',true);
      b(.3,.62,.32,1.26,.04,1.08,'#1D2B53',false,'water');
      b(.24,.66,.38,1.38,.03,.96,'#29ADFF',false,'water');
      b(.16,.62,.16,.14,1.5,.14,DARK); b(1.56,.62,.16,.14,1.5,.14,DARK);
      b(.12,2.06,.12,1.62,.12,1.5,'#72513B');
      b(.76,1.0,.7,.32,.34,.32,WOOD);
      break;
    case 'fence':
      for(const dx of [.1,.82,1.54]) b(dx,0,.4,.16,1.06,.16,'#AB5236');
      b(.06,.28,.44,1.72,.12,.1,'#AB5236'); b(.06,.68,.44,1.72,.1,.1,'#7E2553',true);
      break;
    case 'cart':
      b(.1,.44,.24,1.66,.12,1.1,WOOD,true);
      b(.1,.56,.24,1.66,.3,.12,DARK); b(.1,.56,1.22,1.66,.3,.12,DARK);
      for (const dz of [.09,1.27]) for(const dx of [.3,1.4]) {
        b(dx,0,dz,.29,.56,.19,'#5F574F');
        b(dx-.07,.12,dz+.02,.43,.31,.15,'#5F574F');
        b(dx+.07,.2,dz+.196,.15,.15,.045,'#939584');
      }
      b(1.76,.5,.62,.62,.1,.12,DARK);
      break;
    default:
      b(.16,0,.21,1.56,.69,1.1,WOOD,true);
      b(.2,.69,.25,1.48,.06,1.02,LIGHT);
  }
}

function outdoorRoom(s,site,width,depth,back) {
  const soil='#78604A', gravel='#8A8C78';
  s.floor(6.54,2.95,2.9,depth-2.95,.008,site==='well'?gravel:soil);
  if (site==='garden') {
    for (const x of [2.3,10.3]) for (const z of [3.5,6.05]) {
      s.floor(x,z,3.36,1.7,.017,'#543F32');
      for (let row=0;row<3;row+=1)
        s.floor(x+.16,z+.29+row*.52,3.04,.08,.022,'#876247');
    }
  } else if (site==='well') {
    s.floor(4,3.2,8,4.65,.017,gravel);
    for (let i=0;i<7;i+=1) s.floor(4,3.34+i*.63,8,.035,.023,'#686D61');
  } else {
    for (const x of [2.3,9.65]) {
      s.floor(x,3.1,4,4.8,.018,'#886648');
      for (let i=0;i<8;i+=1) s.floor(x,3.25+i*.55,4,.035,.023,'#634B3B');
    }
  }
  for (const x of [2.02,width-2.16]) rail(s,x,back,.14,7.2,0);
  rail(s,2.02,back-.14,width-4.04,.14,0);
  // 顶棚独立淡出，地面和柱脚仍留在同一个位置。
  s.group(`room-roof:${site}`,()=>roof(s,2.04,2.72,4.05,4.05,2.75,site==='garden'?'#526B46':'#7A624D'));
  for (const x of [2.14,5.78]) for (const z of [2.83,6.47]) s.box(x,0,z,.18,2.78,.18,DARK,true);
}

export function roomStage(site, props, front, width, depth) {
  const s = stage(width, depth);
  const outside = ['garden','well','yard'].includes(site);
  const back=outside?2.75:site==='watch'?1.76:1.65, wallWidth=2;
  s.walkBounds={left:wallWidth,right:width-wallWidth,top:back,bottom:depth};
  const color = outside ? '#568D3E' : ['watch','workshop'].includes(site) ? '#939584' : WOOD;
  s.floor(0,0,width,depth,0,color);
  if (outside) outdoorRoom(s,site,width,depth,back);
  if (site==='watch') {
    const rear=back-.24;
    s.box(1.9,0,rear,12.2,.78,.24,DARK,true);
    s.box(1.9,2.28,rear,12.2,.21,.24,WOOD);
    for (const x of [1.9,5.75,10.1,13.85]) s.box(x,.78,rear,.22,1.5,.24,DARK);
    for (const x of [1.85,13.9]) {
      s.box(x,0,rear,.22,1.65,depth-rear,DARK,true);
      rail(s,x,rear,.19,depth-rear,.06,false);
    }
    s.floor(2,3,12,7,.01,WOOD);
  } else if (!outside) {
    const rear=back;
    s.box(0,0,rear-.2,width,2.18,.2,'#72513B',true);
    cladding(s,0,0,rear-.2,width,2.18,.2,['watch','workshop'].includes(site));
    s.box(0,.26,rear-.02,width,.09,.075,'#D8A667',true);
    for (const side of [0,width-wallWidth]) s.group(`wall:${side}`,() => {
      s.box(side,0,rear,wallWidth,1.27,depth-rear,DARK,true);
      cladding(s,side,0,rear,wallWidth,1.27,depth-rear,['watch','workshop'].includes(site));
    });
    // 后墙不再是一整面纯色：两扇窗（框+玻璃+十字棂）+ 一面挂布 + 壁灯。
    for (const wx of [width*.22,width*.68]) {
      s.box(wx,1.06,rear+.02,1.5,1.02,.07,DARK);
      s.box(wx+.1,1.14,rear+.1,1.3,.86,.03,'#458996',false,true);
      s.box(wx+.72,1.14,rear+.13,.06,.86,.03,'#72513B');
      s.box(wx+.1,1.53,rear+.13,1.3,.05,.03,'#72513B');
      s.box(wx+.16,1.2,rear+.14,.34,.22,.02,'#A0D2C6');
      s.box(wx-.08,1.0,rear+.04,1.66,.08,.13,'#D8A667');
    }
    s.box(width*.46,.72,rear+.03,1.24,1.28,.06,'#7E2553');
    s.box(width*.46+.16,1.24,rear+.1,.92,.24,.03,'#EDC787');
    s.box(width*.46+.5,1.5,rear+.1,.24,.28,.03,'#FFEC27');
    s.box(width*.5,.62,rear+.04,.16,.12,.12,'#FFA300',false,true);
  }
  const door = site === 'hall' ? front.door : [112,176,32,16];
  const [dx,dz,dw,dd] = door.map(v=>v/16);
  s.floor(dx,dz,dw,dd,.025,'#EDC787');
  if (site === 'hall') {
    const [x,z,w,d] = front.stair.map(v=>v/16);
    s.floor(1.5,3,width-3,z-3,.31,LIGHT);
    s.floor(x,z,w,d,.31,WOOD,'z',.025);
    for (const r of front.rails) rail(s,...r.map(v=>v/16),.24,false);
  }
  for (const [i,[kind,px,pz]] of props.entries()) {
    const id=`prop:${i}`, start=s.boxes.length;
    s.group(id,() => prop3d(s,kind,px/16,pz/16,s.heightAt(px/16+.75,pz/16+.6)));
    const boxes=s.boxes.slice(start).filter(b => !['fire','smoke'].includes(b.fx));
    const x=Math.min(...boxes.map(b=>b.x)), z=Math.min(...boxes.map(b=>b.z));
    const w=Math.max(...boxes.map(b=>b.x+b.w))-x, d=Math.max(...boxes.map(b=>b.z+b.d))-z;
    s.interactables.push({id,kind,x,z,w,d,boxes});
  }
  return s;
}

export function timberStage(timber, grove=TIMBER_GROVE) {
  const s=stage(0,0);
  if (!timber) return s;
  for (const [i,t] of grove.entries()) {
    const {x,z,id}=t;
    s.group(`timber:${id}`,()=>{
      if (timber[id]?.stage!=='sapling') { tree(s,x,z,i%4); return; }
      s.box(x-.17,0,z-.16,.34,.16,.32,'#72513B');
      s.box(x-.13,.16,z-.12,.26,.024,.24,'#C29662');
      const sx=x+.27,sz=z+.13;
      plantBox(s,x+z,.045,true,sx-.024,0,sz-.024,.048,.57,.048,'#6C5C3F');
      plantBox(s,x+z,.045,false,sx-.16,.29,sz-.06,.18,.10,.16,'#518A45');
      plantBox(s,x+z,.045,false,sx+.017,.39,sz-.05,.18,.11,.12,'#84A956');
      plantBox(s,x+z,.045,false,sx-.065,.52,sz-.06,.13,.15,.14,'#6D9F4E');
    });
  }
  return s;
}
export function constructionStage(record) {
  if (!Object.hasOwn(record,'progress')) return 'complete';
  if (record.progress<=0) return 'foundation';
  return 'frame';
}

export function addCampWork(boxes, world) {
  const projects=[];
  const add=(record)=>{
    const lot=record.lot??constructionLot(record.loc,world.layout);
    if (!lot) return;
    const {x,z,w,d}=lot, X=x+.24,Z=z+.24,W=w-.48,D=d-.48;
    const id=`work:${record.loc}:${record.type}`, labor=world.buildingsDef?.[record.type]?.labor??6;
    const phase=constructionStage(record);
    projects.push({id,phase,record,lot,labor});
    const s={box(x,y,z,w,h,d,color,solid=false,rise=false) {
      boxes.push({x,y,z,w,h,d,color,solid,occluder:id,rise});
    }};
    const baseRise=phase==='foundation'?'ground':false;
    s.box(x+.02,0,z+.02,w-.04,.16,d-.04,'#7A7667',true,baseRise);
    for (const px of [x+.13,x+w-.22]) for (const pz of [z+.13,z+d-.22])
      s.box(px,.16,pz,.09,.21,.09,DARK,false,baseRise);
    if (phase==='foundation') {
      for (let i=0;i<4;i++) s.box(X+.1,.16+i*.08,Z+.14,1.05,.07,.25,WOOD,false,baseRise);
      return;
    }
    if (phase==='frame') {
      const ratio=Math.max(.25,Math.min(1,record.progress/labor));
      const top=.88+ratio*.78;
      for (const px of [X,X+W-.16]) for (const pz of [Z,Z+D-.16])
        s.box(px,.16,pz,.16,top,.16,DARK,false,true);
      for (const pz of [Z,Z+D-.16]) {
        s.box(X,top+.12,pz,W,.15,.16,WOOD,false,true);
        s.box(X+.02,.26,pz,W-.04,.16,.16,LIGHT,false,true);
      }
      for (const px of [X,X+W-.16]) s.box(px,top+.12,Z,.16,.15,D,WOOD,false,true);
      return;
    }
    s.box(X,.16,Z,W,1.41,D,record.type==='granary'?'#696861':'#72513B',false,true);
    const canopy={box:(x,y,z,w,h,d,color)=>s.box(x,y,z,w,h,d,color,false,true)};
    cladding(canopy,X,.16,Z,W,1.41,D,record.type==='granary');
    roof(canopy,X,Z,W,D,1.57,record.integrity<1?'#5F574F':'#976A45');
  };
  for (const building of world.buildings??[]) add(building);
  for (const site of world.sites??[]) add(site);
  for (const [room,project] of Object.entries(world.households?.projects??{})) {
    const [x,z]=world.layout?.sites[room]??residentialSite(room);
    add({loc:room,type:'house',progress:project.progress,lot:{x:x-2.3,z:z-6.05,w:4.6,d:3.7}});
  }
  return projects;
}
