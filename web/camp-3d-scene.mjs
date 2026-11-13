import { reliefFaces, floorContains, campHash } from './camp-terrain.mjs';
import { constructionLot, residentialSite, TIMBER_GROVE } from './camp-layout.mjs';
import { ANIMAL_LIMITS, campEntrance, campPen, campPlants } from './camp-interaction.mjs';
import { itemBoxes } from './camp-items.mjs';

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
  const color=(variant==null?null:seededColors[variant])??colors[id]??'#976A45';
  const width=7.2, depth=6.15;
  const left=x-width/2, back=z-depth-1.7;
  s.box(left,0,back,width,.27,depth,DARK,true);
  const masonry = id === 'workshop' || id === 'watch' || variant===2;
  s.box(left+.15,.27,back+.1,width-.30,2.8,depth-.20,masonry?'#67675E':'#72513B');
  cladding(s,left+.15,.27,back+.1,width-.30,2.8,depth-.20,masonry);
  cladding(s,left,0,back,width,.27,depth,true);
  roof(s,left,back,width,depth,3.08,color,variant===2?3:variant===3?4:5);
  const front = back + depth;
  s.box(x-.63,.27,front-.02,1.26,1.82,.10,'#72513B');
  s.box(x-.49,.33,front+.09,.98,1.66,.035,'#AB5236');
  s.box(x+.23,1.02,front+.135,.11,.1,.04,'#EDC787');
  for (const dx of [-2.45,1.57]) {
    s.box(x+dx,1.36,front-.025,.89,.83,.1,'#514134');
    s.box(x+dx+.09,1.45,front+.079,.71,.65,.035,'#458996');
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
}

function outdoorFixture(s, id, x, z) {
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
  const nodes=campPlants(world.layout,world.livestock?.orchards,world.mapSeed,world.layoutVersion);
  for (const plant of nodes) {
    const {x,z,item,id,site}=plant, v=Math.floor(x*7+z*13)%4, shades=LEAF_RAMPS[v];
    s.gatherables.push(plant);
    s.group(id,()=>{
      if (item==='fruit') {
        s.box(x-.16,0,z-.16,.32,1.45,.32,DARK);
        plantBox(s,x+z,.12,false,x-.82,1.28,z-.76,1.64,.96,1.52,shades[1]);
        plantBox(s,x+z,.12,false,x-.52,2.16,z-.48,1.04,.66,1.0,shades[2]);
        const count=world.season==='冬'?0:Math.min(3,world.produce?.fruit??0);
        for (const [dx,y,dz] of [[-.48,1.62,.74],[.77,1.88,-.34],[.08,2.34,.5]].slice(0,count))
          plantBox(s,x+z,.12,false,x+dx,y,z+dz,.17,.17,.17,'#CF4E53');
      } else {
        for (const [i,[dx,y,dz,w,h,d]] of SHRUBS[v].entries())
          plantBox(s,x+z,.09,true,x+dx,y+.02,z+dz,w,h,d,shades[Math.min(i+1,3)]);
        const count=Math.min(3,Math.floor(world.wildBerries?.[site]??3));
        for (const [dx,y,dz] of [[-.22,.28,.28],[.07,.46,.35],[.29,.29,.13]].slice(0,count))
          plantBox(s,x+z,.08,false,x+dx,y,z+dz,.11,.11,.11,'#CE6274');
      }
    });
  }
  for (const [tx,tz,seed] of world.flora??[]) {
    const x=tx+.5,z=tz+.5,v=(tx*7+tz*13)%4;
    if (nodes.some(p=>Math.hypot(p.x-x,p.z-z)<1.1)) continue;
    if (seed<.052) {
      for (const [i,[dx,y,dz,w,h,d]] of SHRUBS[v].entries())
        plantBox(s,x+z,.09,true,x+dx,y+.02,z+dz,w,h,d,LEAF_RAMPS[v][Math.min(i+1,3)]);
    } else {
      const color=['#FFEC27','#FF77A8','#FFF0CC','#68ADD4'][v];
      for (const [dx,h,dz] of [[-.16,.25,.08],[.07,.39,-.11],[.26,.19,.13]]) {
        const phase=x+z+dx;
        plantBox(s,phase,.08,true,x+dx-.025,0,z+dz-.025,.05,h,.05,'#315431');
        plantBox(s,phase,.08,false,x+dx-.082,h-.03,z+dz-.079,.164,.078,.158,color);
        plantBox(s,phase,.08,false,x+dx-.025,h+.048,z+dz-.025,.05,.026,.05,'#FFA300');
      }
    }
  }
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
  return campPen(sites.yard);
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
    ['chickens',stock.chickens??3,ANIMAL_LIMITS.chickens,.38,1.11,2.82,.98],
    ['cows',stock.cows??2,ANIMAL_LIMITS.cows,.59,1.16,1.06,1.43],
    ['sheep',stock.sheep??2,ANIMAL_LIMITS.sheep,.52,2.97,4.91,1.29],
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
    if (residentialSite(id)) continue;
    s.group(`site:${id}`,()=>{
      if (id==='hall') hall(s,x,z);
      else if (id==='watch') watchTower(s,x,z);
      else if (['garden','well','yard'].includes(id)) outdoorFixture(s,id,x,z);
      else house(s,id,x,z,world.layoutSeed);
    });
    s.entrances[id]=campEntrance(id,[sx,sy]);
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
// ── 第一批样板：储粮设施 Granary ────────────────────────────────────────
// 设计约束（HY4 派单 §3）：4×3.2 地块内做「架空防潮粮仓」——石基 + 承重立柱 + 抬高木平台
// + 双坡屋檐 + 门洞小台阶 + 木板分层 + 储粮道具。轮廓要能在俯视斜角下一眼认出"存粮的地方"。
// 状态全部来自 record（progress / integrity）与 world（store / storeCap），无计时自完工。
const GR_STONE = ['#8A8F83', '#676D68', '#A7AA97'];
const GR_PLANK = ['#BA8752', '#C9955D', '#D8A667', '#C48D57'];

function grPlanks(s, x, y, z, w, h, d, skipFrontDoor = false) {
  const step = .28;
  for (let row = 0; row * step < h - .04; row += 1) {
    const yy = y + row * step + .02, hh = Math.min(step - .04, y + h - yy);
    const color = GR_PLANK[(row * 3 + 1) % GR_PLANK.length];
    for (const side of [0, 1, -1]) {
      if (side === 0 && skipFrontDoor) continue;
      const len = side ? d : w, pitch = side ? .8 : 1.05;
      for (let k = 0, start = -(row % 2) * pitch / 2; start < len - .04; start += pitch, k += 1) {
        const a = Math.max(.01, start + .02), b = Math.min(len - .01, start + pitch - .02);
        if (b <= a) continue;
        const c = GR_PLANK[(k + row + (side ? 2 : 0)) % GR_PLANK.length];
        if (side) s.box(side > 0 ? x + w + .004 : x - .018, yy, z + a, .014, hh, b - a, c);
        else s.box(x + a, yy, z + d + .004, b - a, hh, .014, c);
      }
    }
    if (skipFrontDoor) {
      // 正面留 1.05 宽门洞，左右各补一段板墙
      const dw = (w - 1.05) / 2;
      s.box(x, yy, z + d + .004, dw - .02, hh, .014, color);
      s.box(x + w - dw + .02, yy, z + d + .004, dw - .02, hh, .014, color);
    }
  }
}

function grGable(s, x, y, z, w, d, color, missing = 0) {
  // 阶梯式双坡：沿 z 向中心逐层收缩，形成俯视可读的屋脊与南北两坡。
  for (let i = 0; i < 5; i += 1) {
    if (i < missing) continue;                    // 破损态：屋脊缺层
    const shrink = i * d * .088, rise = i * .27;
    s.box(x - .16, y + rise, z + shrink, w + .32, .13, d - 2 * shrink, i % 2 ? color : '#B97A45');
  }
  // 深色屋脊长条 + 两道檐口，明确「两坡 + 屋檐」而不是平顶瓦片
  s.box(x - .2, y + 1.12, z + d / 2 - .11, w + .4, .12, .22, '#5B4434');
  s.box(x - .28, y - .06, z - .28, w + .56, .1, d + .56, DARK);
  s.box(x - .34, y - .16, z + d + .22, w + .68, .07, .12, LIGHT);
}

function grContainer(s, kind, x, z, tilt = 0) {
  if (kind === 'sack') {
    s.box(x, .02 + tilt, z, .62, .12, .5, '#A39B88');
    s.box(x + .06, .14 + tilt, z + .04, .5, .46, .42, '#D8C3A0');
    s.box(x + .16, .6 + tilt, z + .1, .3, .12, .26, '#EFE4CA');
  } else if (kind === 'barrel') {
    s.box(x, .02, z, .5, .12, .5, '#5B4434');
    s.box(x + .04, .14, z + .04, .42, .5, .42, '#976744');
    s.box(x, .3, z, .5, .09, .5, '#6D7165');
    s.box(x, .54, z, .5, .09, .5, '#6D7165');
    s.box(x + .04, .64, z + .04, .42, .06, .42, '#C18F58');
  } else {
    s.box(x, .02, z, .7, .56, .62, '#976744');
    s.box(x + .04, .58, z + .04, .62, .07, .54, '#C18F58');
    s.box(x + .04, .25, z + .64, .62, .08, .04, '#5B4434');
  }
}

function granary3d(s, lot, record, world) {
  const { x, z, w, d } = lot;
  const X = x + .22, Z = z + .22, W = w - .44, D = d - .44;
  const phase = constructionStage(record);
  const labor = world.buildingsDef?.[record.type]?.labor ?? 6;
  const ratio = phase === 'frame' ? Math.max(.2, Math.min(1, (record.progress ?? 0) / labor)) : 1;
  const damaged = Boolean(buildingDamage(record));
  const deck = .78, wallTop = 2.42;
  const id = `work:${record.loc}:${record.type}`;

  // 地基：石墩 + 施工平台，四态共有（完工时藏在平台下）
  s.box(x + .04, 0, z + .04, w - .08, .14, d - .08, '#7A7667', true, 'ground');
  for (const px of [X + .12, X + W - .46]) for (const pz of [Z + .12, Z + D - .46]) {
    s.box(px, .14, pz, .34, .5, .34, GR_STONE[(Math.round(px * 3 + pz * 5)) % 3], false, false);
  }

  if (phase === 'foundation') {
    // 待用材料：木料堆、石料堆、一卷草席；不放任何主体结构
    for (let i = 0; i < 3; i++) s.box(X + .2, .18 + i * .17, Z + .3 + i * .06, 1.15, .14, .28, GR_PLANK[i % 4], false, 'ground');
    s.box(X + W - 1.1, .18, Z + .3, .8, .3, .6, GR_STONE[1], false, 'ground');
    s.box(X + W - .95, .48, Z + .42, .5, .16, .4, GR_STONE[2], false, 'ground');
    return;
  }

  // 承重立柱：刻意放在墙体四角之外，让俯视斜角也能看见「架空防潮」的结构。
  const postH = phase === 'frame' ? .5 + ratio * 1.25 : 1.86;
  for (const px of [X - .08, X + W - .14]) for (const pz of [Z - .08, Z + D - .14]) {
    const h = damaged && px > X + 1 && pz > Z + 1 ? postH * .72 : postH;
    s.box(px, .62, pz, .22, h, .22, DARK, false, phase === 'frame');
    s.box(px - .05, .62, pz - .05, .32, .13, .32, LIGHT, false, phase === 'frame');
    s.box(px - .02, .62, pz - .02, .26, .3, .26, GR_STONE[1]);   // 柱脚石础
  }
  // 架空平台：比墙体四周各外挑 .14，形成可读的台基边线
  s.box(X - .14, deck - .12, Z - .14, W + .28, .14, D + .28, WOOD, false, phase === 'frame');
  for (let i = 1; i < 6; i++) s.box(X + i * W / 6, deck + .025, Z + .04, .025, .02, D - .08, '#8A633F');
  s.box(X - .14, deck - .13, Z + D + .14, W + .28, .09, .06, LIGHT);  // 前沿亮边
  // 台基下的横撑与阴影带：俯视斜角下也能读出「下面是空的、由柱子撑着」
  if (phase !== 'frame') {
    s.box(X - .14, deck - .26, Z + D + .14, W + .28, .1, .08, '#5B4434');
    s.box(X + .06, .3, Z + D + .02, W - .12, .12, .1, DARK);
    for (const px of [X + .4, X + W - .56]) s.box(px, .14, Z + D + .02, .14, .34, .12, LIGHT);
  }

  if (phase === 'frame') {
    // 施工中：横梁 + 按进度逐层补墙板，屋架只出现到一半
    const built = Math.ceil(ratio * 6);
    for (let row = 0; row < built; row += 1) {
      const yy = deck + .02 + row * .28;
      s.box(X, yy, Z + D + .004, W - (row < 2 ? 1.05 : 0), .22, .014, GR_PLANK[row % 4]);
      for (const side of [-1, 1]) s.box(side > 0 ? X + W + .004 : X - .018, yy, Z, .014, .22, D, GR_PLANK[(row + 2) % 4]);
    }
    for (const pz of [Z, Z + D - .16]) s.box(X, deck + 1.6, pz, W, .14, .16, WOOD, false, true);
    if (ratio > .72) s.box(X - .1, deck + 1.78, Z + D * .3, W + .2, .1, D * .4, DARK, false, true);
    return;
  }

  // 完工 / 破损：完整墙体、门洞、双坡屋顶
  s.box(X + .06, deck, Z + .06, W - .12, wallTop - deck, D - .12, '#72513B', false, true);
  grPlanks(s, X + .06, deck, Z + .06, W - .12, wallTop - deck - .06, D - .12, true);
  // 门洞 + 门楣 + 台阶
  const front = Z + D;
  s.box(X + W / 2 - .52, deck, front - .04, 1.04, 1.42, .08, '#514134', false, true);
  s.box(X + W / 2 - .42, deck + .08, front + .045, .84, 1.2, .04, '#AB5236', false, true);
  s.box(X + W / 2 - .56, deck + 1.42, front - .02, 1.12, .13, .12, LIGHT, false, true);
  // 门楣牌匾：纯色块、不写文字（文案一律引擎内渲染），配合两束谷穗点明「粮」
  s.box(X + W / 2 - .34, wallTop - .76, front + .07, .68, .2, .05, '#EDC787', false, true);
  s.box(X + W / 2 - .28, wallTop - .72, front + .12, .56, .05, .03, '#FFA300', false, true);
  for (let i = 0; i < 3; i++) s.box(X + W / 2 - .72, .16 + i * .2, front + .06 + i * .22, 1.44, .2, .28, i % 2 ? LIGHT : WOOD);
  // 山墙通风窗（小木格），破损时脱落
  if (!damaged) {
    s.box(X + W / 2 - .34, wallTop - .34, front + .01, .68, .34, .04, '#1D2B53');
    s.box(X + W / 2 - .02, wallTop - .34, front + .05, .04, .34, .04, WOOD);
    s.box(X + W / 2 - .34, wallTop - .17, front + .05, .68, .04, .04, WOOD);
  }
  grGable(s, X - .06, wallTop, Z - .06, W + .12, D + .12, damaged ? '#5F574F' : '#B3643C', damaged ? 2 : 0);
  // 檐下横梁 + 两束谷穗（可辨认"粮"）
  s.box(X - .1, wallTop - .1, front + .06, W + .2, .12, .12, DARK);
  if (!damaged) for (const dx of [-1.1, 1.0]) {
    s.box(X + W / 2 + dx, wallTop - .5, front + .1, .12, .34, .1, '#FFEC27');
    s.box(X + W / 2 + dx - .04, wallTop - .58, front + .1, .2, .1, .1, '#FFA300');
  }

  // 储粮量分档：0 / 少量 / 部分 / 明显增多。store=0 时一个容器都不画。
  const count = granaryGoods(world);
  const slots = [
    ['sack', X + .35, front + .34], ['barrel', X + 1.05, front + .38],
    ['crate', X + W - .85, front + .34], ['sack', X + W - .45, front + .62],
    ['barrel', X + .7, front + .78],
  ];
  for (let i = 0; i < count; i += 1) {
    const [kind, px, pz] = slots[i];
    grContainer(s, kind, px, pz, damaged && i === count - 1 ? .06 : 0);
  }
}

// ── 第一阶段：功能建筑专属形体（HY4 续单）────────────────────────────────
// 与 granary3d 同层：状态适配读 record.progress / record.integrity，几何构造各自独立，
// addCampWork 只做分发。四种建筑轮廓刻意不同：架空粮仓 / 尖顶小屋 / 敞开工棚 / 线性木墙。
const FN_STONE = '#7A7667';

// 场景里的散落/堆放物品复用 camp-items.mjs 的同一套 0–1 归一化模型定义，
// 与背包图标、角色手持保持同一视觉语言；不做第二份几何。
function worldItem(s, id, x, z, scale = .8, y = .16) {
  for (const [dx,dy,dz,w,h,d,c] of itemBoxes(id))
    s.box(x + dx*scale, y + dy*scale, z + dz*scale, w*scale, h*scale, d*scale, c);
}

function worksBase(s, lot, phase) {
  const { x, z, w, d } = lot;
  // 精修①：地基平台压深到 #5B574C，与木料（#976744/#C18F58）和石料（#676D68/#A7AA97）拉开明度差，
  // 俯视斜角下不再与灰平台糊成一片。材料堆下各垫一块浅色托板，进一步分离。
  s.box(x + .02, 0, z + .02, w - .04, .16, d - .04, phase === 'foundation' ? '#5B574C' : FN_STONE, true, phase === 'foundation' ? 'ground' : false);
  if (phase !== 'foundation') return false;
  s.box(x + .26, .16, z + .3, 1.32, .05, .96, '#A79C86', false, 'ground');
  s.box(x + w - 1.3, .16, z + .3, 1.0, .05, .82, '#B5AA93', false, 'ground');
  worldItem(s, 'wood', x + .3, z + .35, .95, .21);
  worldItem(s, 'stone', x + w - 1.25, z + .35, .85, .21);
  return true;
}

function worksRatio(record, world, laborDefault) {
  const labor = world.buildingsDef?.[record.type]?.labor ?? laborDefault;
  return Math.max(.2, Math.min(1, (record.progress ?? 0) / labor));
}

// 住所：落地木屋 + 尖顶 + 门廊 + 侧窗 + 烟囱。与架空粮仓轮廓完全不同。
function shelter3d(s, lot, record, world) {
  const { x, z, w, d } = lot;
  const X = x + .3, Z = z + .28, W = w - .6, D = d - .85;
  const phase = constructionStage(record), damaged = Boolean(buildingDamage(record));
  const ratio = worksRatio(record, world, 6), front = Z + D;
  if (worksBase(s, lot, phase)) return;

  const postH = phase === 'frame' ? .5 + ratio * 1.4 : 2.05;
  for (const px of [X, X + W - .2]) for (const pz of [Z, Z + D - .2])
    s.box(px, .16, pz, .2, postH, .2, DARK, false, phase === 'frame');
  // 门廊：两根前柱 + 挑檐，完工后仍外露
  if (phase !== 'frame' || ratio > .7) for (const px of [X + .35, X + W - .55]) {
    s.box(px, .16, front + .34, .16, 1.62, .16, LIGHT);
    s.box(px, 1.78, front + .34, .2, .12, .2, WOOD);
  }
  if (phase === 'frame') {
    const rows = Math.ceil(ratio * 5);
    for (let i = 0; i < rows; i++) s.box(X, .16 + i * .34, front, W, .28, .12, GR_PLANK[i % 4], false, true);
    s.box(X - .12, .16 + postH, front + .3, W + .24, .13, .65, WOOD, false, true);
    return;
  }
  s.box(X, .16, Z, W, 1.9, D, '#72513B', false, true);
  grPlanks(s, X, .16, Z, W, 1.88, D, true);
  for (const dx of [-1.45, 1.0]) {
    s.box(X + W / 2 + dx, 1.05, front + .01, .58, .62, .06, '#514134');
    if (!damaged) s.box(X + W / 2 + dx + .06, 1.12, front + .075, .46, .48, .03, '#458996', false, true);
  }
  s.box(X + W / 2 - .5, .16, front, 1.0, 1.48, .08, '#514134');
  s.box(X + W / 2 - .4, .24, front + .05, .8, 1.3, .04, '#AB5236');
  s.box(X - .2, 2.06, front + .2, W + .4, .12, .9, DARK);           // 门廊挑檐
  grGable(s, X - .1, 2.06, Z - .1, W + .2, D + .2, damaged ? '#5F574F' : '#8D593F', damaged ? 2 : 0);
  if (!damaged) {
    s.box(X + W - .75, 2.4, Z + .5, .38, .9, .38, '#5F574F');         // 烟囱
    s.box(X + W - .8, 3.3, Z + .45, .48, .12, .48, '#939584');
    s.chimneys?.push?.([X + W - .55, 3.42, Z + .7]);
  }
  for (let i = 0; i < 2; i++) s.box(X + W / 2 - .65, .16 + i * .18, front + .3 + i * .18, 1.3, .18, .22, i ? LIGHT : WOOD);
}

// 生产设施：三面矮墙 + 高挑平坡屋顶 + 正面完全敞开，内部可见工作台/工具架/木料堆。
function workshop3d(s, lot, record, world) {
  const { x, z, w, d } = lot;
  const X = x + .22, Z = z + .22, W = w - .44, D = d - .44;
  const phase = constructionStage(record), damaged = Boolean(buildingDamage(record));
  const ratio = worksRatio(record, world, 8), front = Z + D;
  if (worksBase(s, lot, phase)) return;

  const postH = phase === 'frame' ? .6 + ratio * 1.7 : 2.35;
  for (const px of [X, X + W - .2]) for (const pz of [Z, front - .2])
    s.box(px, .16, pz, .22, postH, .22, DARK, false, phase === 'frame');
  if (phase === 'frame') {
    for (const pz of [Z, front - .18]) s.box(X, .16 + postH, pz, W, .16, .18, WOOD, false, true);
    for (let i = 0; i < Math.ceil(ratio * 3); i++) s.box(X, .16 + i * .4, Z, W, .32, .12, GR_PLANK[i % 4], false, true);
    return;
  }
  // 三面矮墙（正面敞开）
  for (const pz of [Z, Z + D - .12]) s.box(X, .16, pz, W, 1.15, .12, '#72513B');
  for (const px of [X, X + W - .12]) s.box(px, .16, Z, .12, 1.15, D, '#72513B');
  grPlanks(s, X, .16, Z, W, 1.14, D, false);
  // 高挑平坡顶：两侧外挑大檐，与尖顶住所区分
  s.box(X - .42, 2.5, Z - .3, W + .84, .16, D + .6, damaged ? '#5F574F' : '#6B7468');
  for (let i = 0; i < 3; i++) s.box(X - .3 + i * .12, 2.66 + i * .2, Z - .18 + i * .12, W + .6 - i * .24, .14, D + .36 - i * .24, i % 2 ? '#5F574F' : '#837C69');
  s.box(X - .42, 2.42, front + .24, W + .84, .1, .12, LIGHT);
  // 内部：工作台、工具架、木料堆、炉火
  s.box(X + .35, .16, Z + .7, W - .7, .12, .55, WOOD);
  for (const px of [X + .42, X + W - .58]) s.box(px, .16, Z + .72, .12, .62, .12, DARK);
  s.box(X + .5, .74, Z + .8, .5, .08, .3, '#9DA8A8');
  s.box(X + W - .95, .16, Z + .2, .12, 1.6, .8, '#5B4434');
  for (let i = 0; i < 3; i++) s.box(X + W - .9, .5 + i * .38, Z + .3, .06, .28, .55, i % 2 ? '#9DA8A8' : '#C18F58');
  for (let i = 0; i < 3; i++) s.box(X + .35, .16 + i * .16, front - .72, 1.1, .14, .28, GR_PLANK[i % 4]);
  // 储物聚合模型：与背包图标共用 camp-items.mjs 定义，不另写一份几何
  worldItem(s, 'crate', X + W - 1.9, front - 1.35, .72, .16);
  worldItem(s, 'sack', X + W - 1.25, front - 1.35, .68, .16);
  if (!damaged) s.box(X + W - 1.5, .16, front - .62, .42, .34, .42, '#FFA300', false, 'fire');
}

// 防护设施：沿地块长边的线性木墙，不是实心盒子；石基 + 木桩 + 横板 + 斜撑。
// 精修②：破损分三档（完好 / 轻损 / 重损），由 integrity 派生，不新增字段。
function wall3d(s, lot, record, world) {
  const { x, z, w, d } = lot;
  const phase = constructionStage(record);
  const damage = buildingDamage(record);
  const ratio = worksRatio(record, world, 8);
  const Z = z + d / 2 - .25, H = 1.72, seg = 5;
  s.box(x + .04, 0, Z - .1, w - .08, .18, .62, '#8A8F83', true, phase === 'foundation' ? 'ground' : false);
  if (phase === 'foundation') {
    s.box(x + .3, .18, Z - .05, 1.3, .05, .5, '#A79C86', false, 'ground');
    worldItem(s, 'wood', x + .34, Z - .02, .9, .23);
    worldItem(s, 'stone', x + w - 1.3, Z - .02, .8, .23);
    return;
  }
  const posts = Math.max(2, Math.ceil(ratio * (seg + 1)));
  for (let i = 0; i <= seg; i++) {
    if (i >= posts && phase === 'frame') continue;
    const px = x + .18 + i * (w - .36) / seg;
    // 轻损：第 3 根柱矮一截；重损：第 2 根柱断到一半、第 4 根倾斜
    const short = (damage >= 1 && i === 3) || (damage >= 2 && i === 2);
    s.box(px, .18, Z, .19, short ? H * (damage >= 2 && i === 2 ? .46 : .62) : H, .42, DARK, false, phase === 'frame');
    s.box(px - .03, .18, Z - .03, .25, .14, .48, GR_STONE[0]);
  }
  const rows = phase === 'frame' ? Math.ceil(ratio * 4) : 4;
  for (let r = 0; r < rows; r++) {
    if (damage >= 1 && r === 3) continue;          // 轻损：缺最上一道横板
    if (damage >= 2 && r === 1) continue;          // 重损：再缺第二道
    s.box(x + .18, .34 + r * .36, Z + .42, w - .36, .3, .09, GR_PLANK[(r + 1) % 4]);
  }
  if (phase !== 'frame') {
    s.box(x + .14, .18 + H, Z - .05, w - .28, .13, .52, WOOD);
    for (let i = 0; i < 3; i++) {
      const px = x + .7 + i * (w - 1.5) / 2;
      const fallen = damage >= 2 && i === 1;        // 重损：中间斜撑倒地
      s.box(px, fallen ? .2 : .4, Z - (fallen ? .75 : .38), fallen ? .55 : .16, fallen ? .16 : .95, fallen ? .16 : .16, DARK);
      s.box(px, .34, Z - .6, .5, .14, .3, GR_STONE[1]);
    }
  }
}

// 从奠基到登记入住使用同一个地块和木屋外壳。
function home3d(s, lot, record, seed) {
  const { x, z, w, d } = lot;
  const X = x + .25, Z = z + .25, W = w - .5, D = d - .5;
  const phase = constructionStage(record);
  const ratio = Math.min(1, (record.progress ?? HOME_LABOR) / HOME_LABOR), front = Z + D;
  const v = Math.floor(campHash(seed ?? 0, `home-${record.loc}`) * 4);
  const roofColor = ['#8D593F', '#526B54', '#70657A', '#A17B54'][v];
  if (worksBase(s, lot, phase)) return;
  const postH = phase === 'frame' ? .5 + ratio * 1.5 : 1.95;
  for (const px of [X, X + W - .18]) for (const pz of [Z, front - .18])
    s.box(px, .16, pz, .18, postH, .18, DARK, false, phase === 'frame');
  if (phase === 'frame') {
    for (let i = 0; i < Math.ceil(ratio * 5); i++) s.box(X, .16 + i * .36, front, W, .3, .12, GR_PLANK[(i + v) % 4], false, true);
    s.box(X, .16 + postH, Z, W, .14, .18, WOOD, false, true);
    return;
  }
  s.box(X, .16, Z, W, 1.85, D, '#72513B');
  grPlanks(s, X, .16, Z, W, 1.82, D, true);
  grGable(s, X - .08, 2.0, Z - .08, W + .16, D + .16, roofColor);
  s.box(X + W / 2 - .46, .16, front, .92, 1.42, .08, '#514134');
  s.box(X + W / 2 - .36, .24, front + .05, .72, 1.26, .04, '#AB5236');
  const doorX = X + W / 2;
  s.box(doorX - .6, 0, front + .14, 1.2, .12, .43, '#7A7667');
  s.box(doorX - .49, .004, front + .57, .98, .04, .39, '#939584');
  for (const dx of [-1.35, .78]) {
    s.box(X + W / 2 + dx, 1.05, front + .01, .54, .58, .06, '#514134');
  }
  // 烟囱是房屋的一部分。烟、暖窗和柴堆由住户状态决定。
  s.box(X + W - .62, 2.35, Z + .45, .34, .92, .34, '#5F574F');
  s.box(X + W - .66, 3.27, Z + .41, .42, .11, .42, '#939584');
}

const HOME_LABOR = 3;

function homeLot(world, room) {
  const at = world.layout?.sites[room] ?? residentialSite(room);
  return at && { x: at[0] - 2.3, z: at[1] - 6.05, w: 4.6, d: 3.7 };
}

export function homeAppearance(world, sites = world.rooms ?? {}) {
  const rooms = Object.keys(world.households?.deeds ?? sites).filter(room => residentialSite(room)).sort();
  const occupied = new Set();
  for (const [id, room] of Object.entries(world.housing ?? {})) {
    const agent = world.agents?.[id];
    if (agent && !agent.dead) occupied.add(room);
  }
  return rooms.map(room => [room, occupied.has(room)]);
}

export function outdoorHomes(world, appearance) {
  const s = stage(0, 0);
  for (const [room, occupied] of appearance) {
    const lot = homeLot(world, room);
    const x = lot.x + lot.w / 2, front = lot.z + lot.d - .25;
    s.entrances[room]=campEntrance(room,world.layout?.sites[room]??residentialSite(room));
    s.group(`work:${room}:house`, () => {
      for (const dx of [-1.29, .84]) {
        s.box(x + dx, 1.12, front + .075, .42, .44, .03, occupied ? '#EDC787' : '#2E3B3A', false, occupied);
      }
      if (occupied) {
        s.chimneys.push([lot.x + lot.w - .70, 3.4, lot.z + .87]);
        worldItem(s, 'wood', lot.x + .45, front + .32, .68, .02);
      }
    });
  }
  return s;
}

export function buildingDamage(record) {
  if (constructionStage(record) !== 'complete') return 0;
  const integrity = record.integrity ?? 1;
  if (record.type === 'wall') return integrity >= .99 ? 0 : integrity >= .5 ? 1 : 2;
  return Number(integrity < 1);
}

export function granaryGoods(world) {
  const store = Math.max(0, world.store ?? 0);
  const level = store / Math.max(1, world.storeCap ?? 24);
  return store === 0 ? 0 : level < .15 ? 1 : level < .6 ? 3 : 5;
}

export function workModelKey(world, appearance, treeSignature) {
  const placement = b => [b.type, b.loc, b.lot?.x, b.lot?.z, b.lot?.w, b.lot?.d];
  const buildings = world.buildings ?? [];
  return JSON.stringify([
    buildings.map(b => [...placement(b), buildingDamage(b)]),
    (world.sites ?? []).map(b => [...placement(b), b.progress, world.buildingsDef?.[b.type]?.labor]),
    appearance.map(([room]) => room),
    Object.entries(world.households?.projects ?? {}).map(([room, p]) => [room, p.progress]),
    treeSignature,
    buildings.some(b => b.type === 'granary') ? granaryGoods(world) : 0,
  ]);
}

export function constructionStage(record) {
  if (!Object.hasOwn(record,'progress') || (record.type === 'house' && record.progress >= HOME_LABOR)) return 'complete';
  if (record.progress<=0) return 'foundation';
  return 'frame';
}

export function addCampWork(boxes, world, appearance = homeAppearance(world)) {
  const projects=[];
  const add=(record)=>{
    const lot=record.lot??constructionLot(record.loc,world.layout);
    if (!lot) return;
    const {x,z,w,d}=lot, X=x+.24,Z=z+.24,W=w-.48,D=d-.48;
    const id=`work:${record.loc}:${record.type}`, labor=record.type === 'house' ? HOME_LABOR : world.buildingsDef?.[record.type]?.labor??6;
    const phase=constructionStage(record);
    projects.push({id,phase,record,lot,labor});
    const s={box(x,y,z,w,h,d,color,solid=false,rise=false) {
      boxes.push({x,y,z,w,h,d,color,solid,occluder:id,rise});
    }};
    // 第一阶段：四种建筑各走专属轮廓，保留已验收的 granary3d 不动。
    if (record.type === 'granary') { granary3d(s, lot, record, world); return; }
    if (record.type === 'shelter') { shelter3d(s, lot, record, world); return; }
    if (record.type === 'workshop') { workshop3d(s, lot, record, world); return; }
    if (record.type === 'wall') { wall3d(s, lot, record, world); return; }
    if (record.type === 'house') { home3d(s, lot, record, world.layout ? world.mapSeed : 0); return; }
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
  const finished = new Set(appearance.map(([room]) => room));
  for (const room of finished) add({loc:room,type:'house',lot:homeLot(world, room)});
  for (const [room,project] of Object.entries(world.households?.projects??{})) {
    if (!finished.has(room)) add({loc:room,type:'house',progress:project.progress,lot:homeLot(world, room)});
  }
  return projects;
}
