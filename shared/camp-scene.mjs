import { beam, cyl, modelBounds } from './camp-geometry.mjs';
import { reliefFaces, floorContains, campHash, hash2 } from './camp-terrain.mjs';
import { homeLot as layoutHomeLot, constructionLot, residentialSite, TIMBER_GROVE } from './camp-layout.mjs';
import { facilityGate, facilityId } from './camp-facility.mjs';
import { ANIMAL_ITEMS, ANIMAL_LIMITS, campEntrance, campPen, campPlants } from './camp-interaction.mjs';
import { orchardAppearance, orchardWeather } from './camp-orchard-look.mjs';
import { itemBoxes } from './camp-items.mjs';

const WOOD = '#BA8752', DARK = '#72513B', LIGHT = '#D8A667';

const HOME_STYLES = [
  {id:'timber', rise:1.06, ridge:.5, roof:'#944735', trim:'#976A45', door:'#AB5236',
    windows:[-1.35,.78], floor:WOOD, cloth:'#A85A55', border:'#EDC787', pottery:'#D27A4A'},
  {id:'saltbox', rise:1.32, ridge:.34, roof:'#497245', trim:'#70905A', door:'#3F7036',
    windows:[-1.53,.89], floor:'#B58A4C', cloth:'#497245', border:'#C2CFA0', pottery:'#A0D2C6'},
  {id:'stone', rise:.97, ridge:.5, roof:'#6D7165', trim:'#939584', door:'#664D32',
    windows:[-1.25,.70], floor:'#B9B8A1', cloth:'#2D5D6E', border:'#D9D6B8', pottery:'#83769C'},
].map(Object.freeze);

export function homeStyle(room, seed=0) {
  return HOME_STYLES[Math.floor(campHash(seed,'home-style:'+room)*HOME_STYLES.length)];
}

function addModel(boxes,model,occluder) {
  if (!model) return null;
  const entry={...model,occluder};
  if (entry.rot || entry.shape) entry.bounds=modelBounds(entry);
  boxes.push(entry);
  return entry;
}

function stage(width, depth) {
  const boxes = [], floors = [], fxs = [], chimneys = [], interactables = [], animals = [], gatherables = [], parts=new Map();
  let occluder = null;
  return {
    width, depth, boxes, floors, fxs, chimneys, interactables, animals, gatherables, parts, entrances: {}, shelters:[],
    group(id, build) {
      const previous=occluder;
      occluder=id;
      build();
      occluder=previous;
    },
    // fxKind 非空 ⇒ 这块几何不进静态网格，改由渲染器按动画帧逐帧生成（呼吸感）。
    box(x, y, z, w, h, d, color, solid = false, glow = false, fxKind = null, transform) {
      const item=addModel(boxes,{x,y,z,w,h,d,color,solid,glow,...transform},occluder);
      if (fxKind) { item.fx = fxKind; fxs.push(item); }
      if (item.part) parts.set(occluder+':'+item.part,item);
      return item;
    },
    beam(...args) { return addModel(boxes,beam(...args),occluder); },
    cyl(...args) { return addModel(boxes,cyl(...args),occluder);
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
  // stage.box 比 addCampWork 的 box 多一个 fxKind 位；适配后再复用同一套双坡几何。
  const roofStage={box:(...a)=>s.box(...a.slice(0,9),null,a[9]),beam:(...a)=>s.beam(...a)};
  s.group('roof:hall',() => timberGable(roofStage,left,3.04,back,right-left,front-back-.25,'#3F7036',false,true));
  s.box(left+.1,2.96,front-.4,right-left-.2,.16,.19,DARK);
  for(const bx of [left+1.1,right-1.6]){
    s.box(bx-.06,2.91,front-.25,.78,.10,.12,LIGHT);
    s.box(bx,1.74,front-.19,.66,1.19,.06,'#944735',false,false,'banner');
    s.box(bx+.2,2.27,front-.124,.26,.30,.023,'#E6BD70',false,false,'banner');
  }
  for (const bz of [back+1.5, back+3.4]) {
    s.box(left+.7, y+.42, bz, 2.4, .1, .48, WOOD);
    for (const bx of [left+.85, left+2.8]) s.box(bx, y, bz+.1, .14, .42, .28, DARK);
  }
  s.box(right-2.6, y, back+2.2, 1.5, .5, .9, WOOD);
  s.box(right-2.5, y+.5, back+2.3, 1.3, .06, .7, LIGHT);
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
  s.box(left+.15,.27,back+.1,width-.30,2.8,depth-.20,masonry?'#67675E':'#72513B',false,false,null,{castShadow:true});
  cladding(s,left+.15,.27,back+.1,width-.30,2.8,depth-.20,masonry);
  cladding(s,left,0,back,width,.27,depth,true);
  const roofStage={box:(...a)=>s.box(...a.slice(0,9),null,a[9]),beam:(...a)=>s.beam(...a)};
  timberGable(roofStage,left,3.08,back,width,depth,color,false);
  if (id==='workshop') s.shelters.push([left,back,width,depth]);
  const front = back + depth;
  s.box(x-.63,.27,front-.02,1.26,1.82,.10,'#72513B');
  s.box(x-.49,.33,front+.09,.98,1.66,.035,'#AB5236');
  s.box(x-.69,0,front+.08,1.38,.13,.58,'#786C58');
  s.box(x-.63,.13,front+.015,1.26,.13,.39,'#AE865A');
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
  lantern(s, x-1.15, .27, front+.42);
  s.box(left-1.11,0,front-1.42,.81,.053,1.58,'#5B4938');
  worldItem(s,'crate',left-1.05,front-1.35,.8,.045);
  worldItem(s,'sack',left-.85,front-.5,.7,.045);
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
  const roofStage={box:(...a)=>s.box(...a.slice(0,9),null,a[9]),beam:(...a)=>s.beam(...a)};
  s.group('roof:watch',()=>timberGable(roofStage,left,5.32,back,width,depth,'#526464',false,true));
  s.box(x-.1,deck+.64,back+.6,.2,1.0,.2,'#6F685F');
  s.box(x-.22,deck+1.42,back-.18,.44,.37,1.35,'#837C69');
  s.box(left+.3,deck,back+.3,.08,1.5,.08,DARK);
  s.box(left+.38,deck+1.0,back+.3,.7,.5,.03,'#944735',false,false,'banner');
  s.box(left+.5,deck+1.15,back+.33,.24,.2,.02,'#E6BD70',false,false,'banner');
}

function outdoorFixture(s, id, x, z) {
  if (id === 'well') {
    s.shelters.push([x+.12,z-3.98,2.8,2.6]);
    s.box(x+.2,0,z-4,2.6,.57,2.65,'#67675E',true);
    cladding(s,x+.2,0,z-4,2.6,.57,2.65,true);
    for (const edge of [z-4,z-1.62]) s.box(x+.17,.57,edge,2.66,.20,.29,'#939584');
    for (const edge of [x+.17,x+2.54]) s.box(edge,.57,z-3.71,.29,.20,2.09,'#939584');
    s.box(x+.46,.585,z-3.71,2.08,.013,2.09,'#2F6066',false,false,null,{water:true});
    for (const dx of [.28,2.56]) s.box(x+dx,.72,z-3.12,.18,1.84,.18,DARK);
    s.group('roof:well',()=>timberGable(roofAdapter(s),x+.12,2.5,z-3.98,2.8,2.6,'#5F574F',false,true));
    s.beam([x+.37,2.2,z-3.03],[x+2.65,2.2,z-3.03],.06,DARK);
    s.cyl(x+1.5,1.15,z-3.03,.025,1.05,'#D8A667',6);
    worldItem(s, 'bucket', x+1.28, z-3.25, .55, .74);
    return;
  }
  const x0 = x+.1, z0 = z-4.95;
  s.box(x0,0,z0,3.75,.22,3.75,DARK);
  for (const dx of [.12,3.46]) for (const dz of [.12,3.46]) s.box(x0+dx,.21,z0+dz,.17,2.3,.17,DARK,true);
  // 棚屋此前是一整块深棕立方体：补屋脊亮线、檐口和两只货箱，与住屋同一套材质语言。
  s.group(`roof:${id}`,()=>{
    timberGable(roofAdapter(s),x0,2.5,z0,3.75,3.75,id === 'garden' ? '#3F7036' : '#B65B3C',false,true);
    s.box(x0-.16,3.60,z0+1.62,4.07,.14,.5,id === 'garden' ? '#93AE73' : '#E99E61');
  });
  s.box(x0-.12,2.46,z0-.12,3.99,.12,.16,'#D8A667');
  s.box(x0+.36,.24,z0+.37,1.13,.76,.94,WOOD,true);
  s.box(x0+.45,1.0,z0+.46,.95,.09,.76,'#D8A667');
  s.box(x0+2.28,.24,z0+2.36,.86,.58,.84,'#72513B',true);
  s.box(x0+2.36,.82,z0+2.44,.7,.08,.68,'#D8A667');
  if (id === 'garden') {
    const sx = x0+3.1, sz = z0+3.1;
    s.box(sx,0,sz,.1,1.7,.1,DARK);
    s.box(sx-.6,1.22,sz-.05,1.3,.09,.09,WOOD);
    s.box(sx-.14,1.5,sz-.14,.28,.26,.28,'#D8A667');
    s.box(sx-.22,1.74,sz-.22,.44,.07,.44,'#8D6A3D');
    s.box(sx-.1,1.62,sz+.14,.06,.05,.03,'#32302C');
    s.box(sx+.06,1.62,sz+.14,.06,.05,.03,'#32302C');
    s.box(sx-.3,1.05,sz-.06,.6,.5,.12,'#944735');
  } else {
    s.box(x0+.5,.24,z0+2.5,1.6,.34,.6,WOOD);
    s.box(x0+.58,.5,z0+2.56,1.44,.05,.48,'#458996');
    worldItem(s, 'bucket', x0+2.4, z0+1.5, .6, .24);
    s.box(x0+2.3,.24,z0+.5,1.0,.5,.8,'#D8A667');
    s.box(x0+2.3,.44,z0+.5,1.0,.06,.8,'#B58A4C');
  }
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
function tree(s, x, z, variant, ground=0, scale=1) {
  const shades = LEAF_RAMPS[variant];
  s.box(x-.2*scale,ground,z-.21*scale,.4*scale,1.88*scale,.42*scale,DARK,true);
  s.box(x-.21*scale,ground+.11*scale,z+.211*scale,.07*scale,1.42*scale,.016*scale,WOOD);
  const jitter = campHash(Math.round(x*4)*73+Math.round(z*4)*151, 'canopy');
  const lean = (jitter-.5)*.5*scale, stretch = .9+(jitter*7%1)*.28;
  const layers = CANOPIES[variant].length;
  CANOPIES[variant].forEach(([dx,y,dz,w,h,d],i) =>
    plantBox(s,x*.37+z*.81,.08+i*.032,false,x+(dx+lean*(i+1)/layers)*scale,ground+y*stretch*scale,z+dz*scale,w*scale,h*stretch*scale,d*scale,shades[i]));
  // 丰富化：根盘、断枝与落地落叶（纯哈希，不消费 rng、不参与碰撞）。
  s.box(x-.28*scale,ground,z-.29*scale,.56*scale,.1*scale,.58*scale,'#5B4434');
  if (jitter>.45) s.beam([x+.1*scale,ground+1.1*scale,z],[x+.42*scale,ground+1.34*scale,z+.16*scale],.05*scale,'#72513B');
  if (jitter<.6) for (const [dx,dz] of [[-.42,.3],[.36,-.4],[.5,.28]])
    s.box(x+dx*scale,ground+.012,z+dz*scale,.14*scale,.02,.1*scale,shades[1]);
}
function meadowPlant(s,x,y,z,variant,kind) {
  if (kind==='grass') {
    grass3d(s,[[x,z,y]]);
  } else if (kind==='shrub') {
    for (const [i,[dx,h,dz,w,height,d]] of SHRUBS[variant].entries()) {
      plantBox(s,x+z,.09,true,x+dx,y+h+.02,z+dz,w,height,d,LEAF_RAMPS[variant][Math.min(i+1,3)]);
    }
  } else {
    const color=['#FFEC27','#FF77A8','#FFF0CC','#68ADD4'][variant];
    for (const [dx,h,dz] of [[-.16,.25,.08],[.07,.39,-.11],[.26,.19,.13]]) {
      const phase=x+z+dx;
      plantBox(s,phase,.08,true,x+dx-.025,y,z+dz-.025,.05,h,.05,'#315431');
      plantBox(s,phase,.08,false,x+dx-.082,y+h-.03,z+dz-.079,.164,.078,.158,color);
      plantBox(s,phase,.08,false,x+dx-.025,y+h+.048,z+dz-.025,.05,.026,.05,'#FFA300');
    }
  }
}
function bankPlant(s,x,y,z,variant,kind) {
  const colors={
    reed:['#497245','#93AE73','#8D6A3D'],
    rush:['#315431','#70905A','#BED773'],
    iris:['#497245','#70905A','#83769C'],
  }[kind];
  const scale=.76+variant*.13;
  const phase=x*.37+z*.81;
  for (const [dx,dz,stem] of [[-.18,-.035,.64],[.05,.09,.89],[.21,-.10,.72]]) {
    const px=x+dx,pz=z+dz,h=stem*scale*(kind==='rush'?.62:1);
    plantBox(s,phase,.14,true,px-.024,y,pz-.024,.048,h,.048,colors[0]);
    for (const [side,above] of [[-1,.28],[1,.47]]) {
      const pivot=[px,y+h*above,pz];
      plantBox(s,phase,.14,false,px-.026,pivot[1],pz-.035,.052,h*.48,.07,colors[1],false,false,null,
        {rot:[dz,0,side*.64],pivot});
    }
    plantBox(s,phase,.16,false,px-.043,y+h-.04,pz-.043,.086,kind==='reed'?.18:.073,.086,colors[2]);
    if (kind==='iris') {
      plantBox(s,phase,.16,false,px-.102,y+h+.012,pz-.045,.204,.068,.09,colors[2]);
      plantBox(s,phase,.16,false,px-.034,y+h+.071,pz-.031,.068,.028,.062,'#EDC787');
    }
  }
}

export function addWildLandmarks(s,landmarks,height) {
  for (const {id,name,x,z,cores} of landmarks) {
    const start=s.boxes.length;
    s.group('landmark:'+id,()=>{
      for (const [i,b] of cores.entries()) {
        const ground=height(b.x+b.w/2,b.z+b.d/2), top=ground+b.h;
        const bottom=Math.min(ground,height(b.x,b.z),height(b.x+b.w,b.z),
          height(b.x,b.z+b.d),height(b.x+b.w,b.z+b.d))-.08;
        const color=id==='falls-rocks'?'#6D7165':'#5F574F';
        s.box(b.x,bottom,b.z,b.w,top-bottom,b.d,color,true);
        if (id==='boundary-wall') {
          for (let row=0;row<b.h*.88;row+=.26) {
            for (let dx=(row===0?.08:.13);dx<b.w-.12;dx+=.59)
              s.box(b.x+dx,ground-.045+row,b.z+b.d+.005,Math.min(.54,b.w-dx-.07),.22,.025,'#939584');
          }
        } else if (id==='fork-cairn') {
          for (const [inset,level,lift] of [[.15,0,.24],[.29,.24,.22],[.43,.46,.20]])
            s.box(b.x+inset+.025,top-.061+level,b.z+inset*.85,b.w-inset*2,lift,b.d-inset*1.7,'#939584');
        } else {
          s.box(b.x+.1,top-.035,b.z+.12,b.w-.22,.19,b.d-.22,'#B9B8A1',false,false,null,
            {yaw:i%2?.14:-.09,pivotX:b.x+b.w/2,pivotZ:b.z+b.d/2});
        }
        s.box(b.x+.08,top-.044,b.z+.08,b.w*.35,.052,b.d*.47,'#70905A');
      }
    });
    for (let i=start;i<s.boxes.length;i++) s.boxes[i].landmark={name,at:[x,z]};
  }
}

export function wildVegetation(trees, undergrowth) {
  const s=stage(0,0);
  for (const {x,y,z,variant,scale} of trees) {
    s.group(`wildtree:${x}:${z}`,()=>tree(s,x,z,variant,y,scale));
  }
  for (const {x,y,z,variant,kind} of undergrowth) {
    if (['reed','rush','iris'].includes(kind)) bankPlant(s,x,y,z,variant,kind);
    else meadowPlant(s,x,y,z,variant,kind);
  }
  return s;
}
function flora3d(s, world) {
  const nodes=campPlants(world.layout,world.livestock?.orchards,world.mapSeed,world.layoutVersion,world.ecoSources);
  producePlants(s,nodes,world);
  for (const [tx,tz,seed] of world.flora??[]) {
    const x=tx+.5,z=tz+.5,v=(tx*7+tz*13)%4;
    if (nodes.some(p=>Math.hypot(p.x-x,p.z-z)<1.1)) continue;
    meadowPlant(s,x,world.landscape?.height(x,z)??0,z,v,seed<.052?'shrub':'flower');
  }
}
const orchardSpurs=[
  [-.51,1.75,.75], [.17,1.53,.78], [.76,1.71,-.25], [-.89,1.95,.08],
  [.41,2.28,.49], [-.59,2.39,.19], [.29,2.80,-.12], [-.26,2.74,-.29], [.75,2.04,.25],
];
function orchardTree(s,{x,z,mature},ground,shades,look,ready) {
  const scale=mature===false?.46:1;
  const lean=look.bent?.18:0, drop=look.parched?.19:look.damage>=2?.14:0;
  const leaf=look.parched?['#777647','#8A8750']:shades.slice(1);
  const lowerWidth=look.damage===2?1.25:1.64, upperWidth=look.damage>0?.72:1.04;
  const b=(dx,y,dz,w,h,d,c,wind=.12)=>plantBox(s,x+z,wind,false,
    x+dx*scale,ground+y*scale,z+dz*scale,w*scale,h*scale,d*scale,c);
  s.box(x-.16*scale,ground,z-.16*scale,.32*scale,1.45*scale,.32*scale,DARK);
  b(-.82+lean,1.28-drop,-.76,lowerWidth,look.parched?.71:.96,1.52,leaf[0]);
  b(-.52+lean,2.16-drop,-.48,upperWidth,look.parched?.42:.66,1.0,leaf[1]);
  if (look.damage) {
    const branch=(dx,y,dz)=>[x+dx*scale,ground+y*scale,z+dz*scale];
    s.beam(branch(.08,1.32,0),branch(.86,1.66,.24),.086*scale,DARK);
    s.beam(branch(.76,1.62,.22),branch(.92,1.69,.26),.055*scale,'#DAB284');
    if (look.damage===2) {
      s.beam(branch(.43,.07,.1),branch(1.11,.09,.71),.067*scale,WOOD);
      b(.59,.07,.49,.31,.08,.17,'#817A48',.03);
    }
  }
  if (look.frost) {
    b(-.47+lean,(look.parched?2.58:2.82)-drop,-.41,upperWidth*.58,.027,.31,'#D5DECF');
    b(-.76+lean,(look.parched?1.99:2.24)-drop,.43,.28,.032,.23,'#C5D1CA');
  }
  for (const [i,[dx,y,dz]] of orchardSpurs.slice(0,look.flowers).entries()) {
    if (look.damage && dx>.6) continue;
    const bud=look.bloom==='bud';
    const width=bud?.093:.148;
    const color=bud?'#CB8B9D':i%3===0?'#FFF0D4':'#F3C3C5';
    b(dx+lean,y-drop,dz,width,.064,width,color);
    if (!bud) {
      b(dx+lean+.037,y-drop+.004,dz-.032,.074,.066,.211,color);
      b(dx+lean+.054,y-drop+.064,dz+.04,.041,.018,.041,'#D7A56B');
    }
  }
  const fruitSites=look.damage>=2?[[-.65,1.62,.74],[-.15,1.88,-.79],[-.32,2.34,.5]]:
    [[-.48,1.62,.74],[.77,1.88,-.34],[.08,2.34,.5]];
  for (const [dx,y,dz] of fruitSites.slice(0,Math.min(3,ready)))
    b(dx+lean,y-drop,dz,.17,.17,.17,'#CF4E53');
}

function producePlants(s,nodes,world) {
  const weather=world.orchard??orchardWeather(world);
  for (const plant of nodes) {
    const {x,z,item,id,site}=plant, v=((Math.floor(x*7+z*13)%4)+4)%4, shades=LEAF_RAMPS[v];
    const ready=plant.ready ?? (item==='fruit' ? world.season==='冬'?0:world.produce?.fruit??0
      : Math.floor(world.berryPatches?.[site]?.[Number(id.split(':').at(-1))] ?? world.wildBerries?.[site] ?? 3));
    const ground=plant.y??0;
    const appearance=item==='fruit'?orchardAppearance(plant,weather):null;
    s.gatherables.push({...plant,ready,...(appearance && {appearance})});
    s.group(id,()=>{
      if (item==='fruit') {
        orchardTree(s,plant,ground,shades,appearance,ready);
      } else {
        for (const [i,[dx,y,dz,w,h,d]] of SHRUBS[v].entries())
          plantBox(s,x+z,.09,true,x+dx,ground+y+.02,z+dz,w,h,d,shades[Math.min(i+1,3)]);
        const count=Math.min(3,ready);
        for (const [dx,y,dz] of [[-.22,.28,.28],[.07,.46,.35],[.29,.29,.13]].slice(0,count))
          plantBox(s,x+z,.08,false,x+dx,ground+y,z+dz,.11,.11,.11,'#CE6274');
      }
    });
  }
}
export function regionLife(plants,animals,orchard) {
  const s=stage(0,0);
  producePlants(s,plants,{orchard});
  wildlife3d(s,animals);
  return s;
}

function grass3d(s, sites) {
  for (const [x,z,y=0] of sites ?? []) {
    const phase=x*.89+z*.62;
    for (const [dx,dz,h] of [[-.12,0,.19],[.03,-.1,.3],[.16,.06,.23]])
      plantBox(s,phase+dx,.085,true,x+dx,y,z+dz,.043,h,.045,'#6B994D');
    const h=campHash(Math.round(x*8)*13+Math.round(z*8)*29,'grass');
    if (h>.62) {
      plantBox(s,phase,.085,true,x+.03,y,z-.1,.05,.34,.05,'#568D3E');
      s.box(x+.005,y+.34,z-.125,.1,.07,.1,h>.85?'#FF77A8':'#FFEC27');
    }
  }
}
function crackedBed(s,bed,x,z,w,d) {
  for (let i=0;i<bed.dryness*3;i++) {
    let px=x+w*(.14+.68*hash2(bed.id,i,61)), pz=z+d*(.16+.64*hash2(bed.id,i,62));
    const heading=hash2(bed.id,i,63)*Math.PI*2;
    for (let j=0;j<3;j++) {
      const angle=heading+(hash2(bed.id,i,64+j)-.5)*1.35;
      const span=(.095+hash2(bed.id,i,67+j)*.11)*(1+bed.dryness*.27);
      const nx=Math.min(x+w-.06,Math.max(x+.06,px+span*Math.cos(angle)));
      const nz=Math.min(z+d-.06,Math.max(z+.06,pz+span*Math.sin(angle)));
      const length=Math.hypot(nx-px,nz-pz);
      if (length>.02) {
        s.box(px,.053,pz-.011,length,.002,.022+bed.dryness*.008,'#432B26',false,false,null,
          {yaw:Math.atan2(nz-pz,nx-px),pivotX:px,pivotZ:pz});
      }
      px=nx;pz=nz;
    }
  }
}

function crops3d(s, world) {
  for (const b of world.beds ?? []) {
    const bx=b.x/16, bz=b.y/16, bw=b.w/16, bh=b.h/16;
    const {growth,dryness=0,windDamage}=b;
    s.group('plot:'+b.id, () => {
      s.box(bx,.012,bz,bw,.04,bh,dryness>=2?'#A78158':b.moisture?'#594032':'#8C6648');
      for (const row of [.15, .65]) s.box(bx+.13,.052,bz+bh*row,bw-.26,.022,.27,b.moisture?'#463024':'#694932');
      if (dryness) crackedBed(s,b,bx,bz,bw,bh);
      if (growth <= 0 && !windDamage) return;
      for(let r=0;r<2;r+=1) for(let c=0;c<4;c+=1){
        const x=bx+.42+c*(bw-.84)/3.5, z=bz+.5+r*(bh-1);
        if (windDamage && (r+c)%3!==2) {
          // The storm took growth from this bed. Leave a flattened strip through the affected rows.
          const rot={rot:[.95,0,-.67],pivot:[x,.072,z]};
          s.box(x-.036,.072,z-.036,.072,.24+growth*.24,.072,'#585B36',false,false,null,rot);
          s.box(x-.112,.19,z-.077,.23,.09,.15,'#88864D',false,false,null,rot);
          continue;
        }
        if (growth <= 0) continue;
        const height=(.18+growth*.6)*(1-.12*dryness);
        const lean=dryness?{rot:[dryness*.1,0,(c%2===0?1:-1)*dryness*.21],pivot:[x,.06,z]}:undefined;
        const leaf=['#73A747','#87A34F','#99994E','#A48D54'][dryness];
        s.box(x-.05,.06,z-.05,.1,height,.1,dryness?'#606136':'#315431',false,false,null,lean);
        s.box(x-.22,.06+height*.42,z-.12,.44,.16,.24,dryness?leaf:growth>=1?'#FFEC27':leaf,false,false,null,lean);
        if(growth>=.65)s.box(x-.12,.06+height,z-.12,.24,.22,.24,dryness?leaf:growth>=1?'#FFA300':'#98BD51',false,false,null,lean);
      }
    });
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
    timberGable(roofAdapter(s),x+5.08,1.02,z+.4,1.6,1.45,'#AB5236',false,true);
    s.box(x+5.53,.1,z+1.8,.5,.66,.06,'#1D2B53');
  });
  s.box(x+.6,.0,z+d-1.0,2.2,.3,.55,WOOD);
  s.box(x+.68,.26,z+d-.94,2.04,.05,.43,'#D8A667');
  s.box(x+3.4,.0,z+d-1.1,1.0,.55,.8,'#D8A667');
  s.box(x+3.4,.22,z+d-1.1,1.0,.07,.8,'#B58A4C');
  s.box(x+3.4,.44,z+d-1.1,1.0,.07,.8,'#B58A4C');
  worldItem(s, 'bucket', x+4.7, z+d-.9, .6, 0);
}
const CHICKEN_FORM = {
  juvenile: {radius:.23, stepRate:14, stride:.046},
  adult: {radius:.38, stepRate:10, stride:.08},
  elder: {radius:.36, stepRate:7, stride:.05},
};

function chicken3d(b, stage, dark) {
  const feathers=dark?'#B67554':'#E8D7B3';
  if (stage==='juvenile') {
    const down=dark?'#DEA36C':'#F5D997';
    b(-.117,.075,-.134,.234,.195,.24,down);
    b(-.096,.204,.048,.192,.174,.174,down,'nod');
    b(-.034,.252,.217,.068,.039,.052,'#C7874A','nod');
    b(-.126,.131,-.10,.032,.083,.13,feathers);
    b(.094,.131,-.10,.032,.083,.13,feathers);
    for (const dx of [-.062,.037]) {
      b(dx,0,.004,.026,.089,.071,'#B87F47','leg');
      b(dx,.30,.216,.026,.031,.011,'#2C2822','nod');
    }
    return;
  }
  if (stage==='elder') {
    const plume=dark?'#AB836E':'#CFC3AD', wing=dark?'#8B6F60':'#ACA08D';
    b(-.165,.12,-.193,.33,.275,.378,plume);
    b(-.182,.181,-.164,.061,.136,.258,wing);
    b(.121,.181,-.164,.061,.136,.258,wing);
    b(-.104,.243,.106,.208,.199,.211,feathers,'nod');
    b(-.082,.284,.278,.164,.085,.052,'#B5A592','nod');
    b(-.056,.432,.137,.112,.055,.105,'#945A50','nod');
    b(-.053,.296,.325,.106,.043,.072,'#C39261','nod');
    for (const dx of [-.083,.05]) {
      b(dx,0,-.025,.037,.135,.053,'#A27F63','leg');
      b(dx-.015,0,.014,.067,.04,.085,'#A27F63','leg');
      b(dx,.365,.319,.037,.033,.014,'#2C2822','nod');
    }
    b(-.09,.22,-.285,.18,.08,.133,wing);
    return;
  }
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
  b(-.185,.2,-.14,.05,.16,.26,dark?'#8B6F60':'#C9B896');
  b(.135,.2,-.14,.05,.16,.26,dark?'#8B6F60':'#C9B896');
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
  for (const [kind,count,limit,r,x,z,spacing] of specs) {
    const herd=world.ecoSources?.[ANIMAL_ITEMS[kind]] ??
      Array.from({length:Math.min(count,limit)},(_,slot)=>({id:`${kind}:${slot}`,slot,mature:true}));
    for (const [i, animal] of herd.entries()) {
      const px=pen.x+x+(animal.slot%limit)*spacing, pz=pen.z+z+(i%2)*.11+Math.floor(i/limit)%3*.34;
      const boxes=[], isChicken=kind==='chickens';
      const stage=isChicken ? animal.stage ?? (animal.mature===false?'juvenile':'adult') : undefined;
      const form=CHICKEN_FORM[stage];
      const size=isChicken || animal.mature ? 1 : .65;
      s.animals.push({id:animal.id,afraid:animal.afraid,ready:animal.ready,x:px,z:pz,r:form?.radius??r*size,kind,boxes,speed:isChicken?1.0:.63,
        ...(form ? {stage, stepRate:form.stepRate, stride:form.stride} : {}),
        habitat:{x:pen.x+.18,z:pen.z+.18,w:pen.w-.36,d:pen.d-.36}});
      const b=(x,y,z,w,h,d,color,fx)=>boxes.push({x:x*size,y:y*size,z:z*size,w:w*size,h:h*size,d:d*size,color,fx});
      if (isChicken) {
        chicken3d(b,stage,animal.slot%2===1);
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
        b(.068,y+.52,d*.36,.08,.13,.085,'#D6BD8A','head');
        b(-.147,y+.52,d*.36,.08,.13,.085,'#D6BD8A','head');
        b(-.06,y+.3,-d*.63-.06,.12,.14,.08,'#57514A');
      } else {
        b(-.29,y+.45,-.26,.57,.12,.53,'#F0E4C7');
        b(-.32,y+.44,.105,.29,.11,.26,'#E8DCBE');
        b(-.2,y+.56,.02,.4,.1,.34,'#F0E4C7');
      }
      b(-.18,y+.22,d*.29,.36,.32,.29,face,'head');
      b(-.145,y+.2,d*.29+.245,.29,.155,.072,cow?'#B48278':'#6C5748','head');
      for (const dx of [-.135,.08]) b(dx,y+.404,d*.29+.291,.055,.05,.013,'#262722','head');
      if (cow) b(-.06,y+.16,d*.29+.24,.12,.11,.06,'#D8A667','head');
      for (const dx of [-.256,.176]) b(dx,y+.43,d*.31,.08,.073,.14,face,'head');
      b(-.044,y+.36,-d*.63,.08,.1,.16,face);
    }
  }
}

export function outdoorStage(world, bridges, rocks) {
  const s = stage(world.tw, world.th);
  s.floors.push(...reliefFaces(world.hills ?? []));
  for (const [x0,z0,x1,z1] of bridges) {
    const y = .32, ramp = Math.min(.85,(x1-x0)/4);
    for (const px of [x0+ramp+.12,x1-ramp-.36]) {
      for (const pz of [z0+.09,z1-.29]) {
        const ground=Math.min(.12,world.height?.(px+.11,pz+.11)??-.14);
        s.box(px,ground-.08,pz,.24,y-ground+.06,.22,'#5B4434');
        s.box(px-.06,ground-.08,pz-.06,.36,.19,.34,'#767667');
      }
      s.box(px-.035,y-.12,z0+.045,.31,.12,z1-z0-.09,'#72513B');
    }
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
    const x=tx+.5,z=tz+.5;
    s.group(`tree:${tx}:${tz}`,() => tree(s,x,z,(tx*3+tz*7)%4,world.height?.(x,z)??0));
  }
  for (const [tx,tz] of rocks) {
    s.group(`rock:${tx}:${tz}`,() => {
      const y=world.height?.(tx+.5,tz+.5)??0;
      s.box(tx+.12,y,tz+.12,.76,.48,.71,'#6D7165',true);
      s.box(tx+.24,y+.48,tz+.22,.52,.16,.47,'#939584');
      const h=campHash(tx*31+tz*17,'rock');
      if (h>.4) s.box(tx+.2,y+.62,tz+.26,.34,.05,.3,'#568D3E');
      s.box(tx+(h>.5?.86:-.14),y,tz+.5,.22,.16,.2,'#8A8F83');
    });
  }
  grass3d(s,world.height?world.grass.map(([x,z])=>[x,z,world.height(x,z)]):world.grass);
  livestockPen(s, world.sites);
  return s;
}

function wildlife3d(s, places) {
  for (const {id,x,z,kind} of places??[]) {
    const boxes=[], b=(x,y,z,w,h,d,color,fx)=>boxes.push({x,y,z,w,h,d,color,fx});
    if (kind==='bird') {
      b(-.09,0,-.21,.18,.17,.41,'#737E84');
      b(-.085,.08,.1,.17,.15,.19,'#435762');
      b(-.035,.105,.25,.07,.055,.13,'#C39C5E');
      b(-.26,.04,-.12,.18,.05,.23,'#536875','wing');
      b(.08,.04,-.12,.18,.05,.23,'#536875','wing');
      b(-.05,.23,.12,.1,.05,.08,'#435762');
      b(-.07,.06,-.24,.14,.04,.06,'#536875');
      s.animals.push({id,x,z,r:0,kind,boxes,wild:true,speed:2.4,habitat:{x:x-7,z:z-7,w:14,d:14}});
      continue;
    }
    const rabbit=kind==='rabbit', deer=kind==='deer';
    const coat=rabbit?'#8D8273':deer?'#AE835A':'#B2663F';
    const leg=deer?.69:rabbit?.15:.28, length=deer?.85:rabbit?.37:.56;
    const width=deer?.43:rabbit?.27:.33;
    b(-width/2,leg,-length/2,width,rabbit?.29:.36,length,coat);
    for (const dx of [-width*.46,width*.22]) for (const dz of [-length*.42,length*.25])
      b(dx,0,dz,deer?.105:.09,leg+.05,deer?.105:.13,rabbit?'#766C61':'#594439','leg');
    const neck=leg+(deer?.48:.16);
    if (deer) b(-.13,leg+.14,length*.24,.26,.52,.26,coat,'head');
    b(-width*.42,neck,length*.3,width*.85,rabbit?.21:.25,rabbit?.23:.30,coat,'head');
    b(-width*.32,neck+.04,length*.3+(rabbit?.18:.22),width*.64,.12,.15,deer?'#80614E':'#DDD0B0','head');
    for (const dx of [-width*.46,width*.26]) {
      b(dx,neck+.18,length*.32,width*.21,rabbit?.29:deer?.14:.16,.08,coat,'head');
      b(dx,neck+.13,length*.3+(rabbit?.20:.25),.054,.052,.026,'#252825','head');
      if (rabbit) b(dx+.02,neck+.2,length*.32+.02,width*.17-.04,.25,.04,'#D58274','head');
      if (deer) {
        b(dx+.02,neck+.3,length*.32,.05,.3,.05,'#80614E','head');
        b(dx-.04,neck+.44,length*.32,.13,.05,.05,'#80614E','head');
      }
    }
    const tail=deer?.19:rabbit?.16:.36;
    b(-.105,leg+.15,-length/2-tail+.025,.21,.16,tail,rabbit?'#E0D4B6':coat);
    if (!rabbit && !deer) b(-.107,leg+.16,-length/2-tail,.215,.155,.13,'#E3CCAA');
    const radius=deer?.63:rabbit?.36:.57;
    s.animals.push({id,x,z,r:radius,kind,boxes,wild:true,speed:rabbit?1.65:1.2,
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
function prop3d(s, kind, x, z, y, style) {
  const b = (dx,dy,dz,w,h,d,c,solid=false,fx=null) => s.box(x+dx,y+dy,z+dz,w,h,d,c,solid,false,fx);
  const legs = (top=.55) => {
    for(const dx of [.22,1.42]) for(const dz of [.18,1.06]) b(dx,0,dz,.16,top,.16,DARK);
  };
  switch (kind) {
    case 'grain':
      b(.05,0,.05,1.62,.68,1.07,'#9A7044',true);
      b(.14,.68,.14,1.44,.12,.89,'#C79B61');
      for (const x of [.13,1.44]) b(x,0,.025,.12,.74,.12,DARK);
      for (const dx of [.5,1.1]) b(dx,.8,.14,.1,.03,.89,'#9A7044');
      break;
    case 'bed':
      b(.1,0,.15,1.72,.36,1.28,DARK,true);
      b(.18,.36,.23,1.56,.12,1.12,'#FFF0CC');
      b(.22,.48,.28,.62,.1,.94,'#FFF0CC');
      b(.9,.48,.25,.78,.13,1.0,style?.cloth??'#D58274');
      b(.04,0,.1,.16,.78,1.36,LIGHT);
      b(1.72,0,.1,.14,.52,1.36,LIGHT);
      b(.86,.61,.25,.1,.04,1.0,style?.border??'#B65B3C');
      if (style) for (const dz of [.41,.8,1.11]) b(1.13,.612,dz,.31,.02,.055,style.border);
      break;
    case 'hearth': case 'furnace':
      const stone=kind==='furnace'||style?.id==='stone'?'#77766E':'#98654F';
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
      b(.52,1.77,.27,.66,.06,.68,'#6D7165');
      for (const dy of [.33,.6]) {
        b(.14,dy,1.403,.27,.026,.019,DARK);
        b(1.45,dy,1.403,.27,.026,.019,DARK);
      }
      break;
    case 'table':
      legs(); b(.08,.55,.08,1.74,.12,1.26,LIGHT,true);
      b(.36,.67,.37,.33,.045,.29,style?.pottery??'#C2C3C7'); b(1.04,.67,.71,.34,.045,.3,style?.pottery??'#C2C3C7');
      b(.22,.18,.24,1.36,.07,.1,DARK); b(.22,.18,.98,1.36,.07,.1,DARK);
      break;
    case 'workbench':
      legs(.62); b(.06,.62,.06,1.8,.13,1.3,WOOD,true);
      b(.16,.75,.2,.5,.2,.34,'#5F574F'); b(.18,.95,.22,.46,.07,.3,'#C2C3C7');
      b(1.08,.75,.66,.2,.38,.2,'#939584'); b(1.3,.75,.3,.16,.3,.16,'#72513B');
      b(.22,.2,.24,1.36,.07,.1,DARK); b(.22,.2,.98,1.36,.07,.1,DARK);
      b(.22,.34,.24,1.36,.06,1.0,WOOD);
      break;
    case 'rug':
      b(.06,.01,.1,1.84,.025,1.28,style?.cloth??'#7E2553');
      b(.18,.04,.2,1.6,.02,1.08,style?.border??'#83769C');
      b(.3,.06,.3,1.36,.02,.88,style?.cloth??'#7E2553');
      if (style) for (const dx of [.47,.9,1.33]) b(dx,.08,.49,.13,.01,.5,style.border);
      for (const dz of [.06,1.38]) for (let i=0;i<6;i++) b(.16+i*.3,.012,dz,.12,.02,.06,'#EDC787');
      break;
    case 'shelf':
      b(.12,0,.18,.14,1.7,1.2,DARK,true); b(1.6,0,.18,.14,1.7,1.2,DARK,true);
      b(.26,0,.18,1.34,1.67,.09,DARK,true);
      for(const sy of [.12,.66,1.2,1.62]) b(.12,sy,.18,1.62,.1,1.2,LIGHT);
      if (style?.id==='saltbox') {
        for (const dx of [.38,.95]) {
          b(dx,.76,.42,.37,.20,.40,'#98744C');
          b(dx+.045,.96,.46,.28,.055,.31,'#627C51');
        }
      } else if (style) {
        for (const [dx,r,h] of [[.45,.16,.28],[.87,.13,.21],[1.23,.14,.31]]) {
          s.cyl(x+dx,y+.76,z+.61,r,h,style.pottery);
          s.cyl(x+dx,y+.76+h,z+.61,r*.72,.05,style.border);
        }
      } else {
        for (const [sx,c] of [[.28,'#FFEC27'],[.5,'#29ADFF'],[.72,'#00E436'],[.94,'#FFA300'],[1.24,'#D58274']])
          b(sx,.76,.42,.18,.36,.22,c);
      }
      b(.44,.22,.56,.61,.28,.54,WOOD); b(.49,.5,.6,.51,.04,.46,LIGHT);
      b(.96,1.3,.6,.27,.31,.3,'#939584'); b(.99,1.61,.63,.21,.05,.24,'#C2C3C7');
      b(.08,1.7,.14,1.7,.08,1.28,DARK);
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
      b(.1,.42,.16,1.68,.06,1.18,'#D58274');
      break;
    case 'bench':
      b(.08,.42,.3,1.76,.12,.62,LIGHT,true);
      for(const dx of [.2,1.52]) b(dx,0,.32,.15,.42,.58,DARK);
      b(.08,.54,.3,1.76,.04,.1,'#EDC787');
      b(.2,.16,.55,1.52,.07,.12,DARK);
      break;
    case 'banner':
      b(.84,0,.5,.14,1.95,.14,DARK);
      b(.8,1.95,.46,.22,.08,.22,'#D8A667');
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
      for (const dx of [.55,1.05]) b(dx,1.08,.24,.1,.03,1.04,DARK);
      break;
    case 'barrel': case 'bucket': {
      const tall = kind === 'barrel';
      const top=tall?1.16:.66;
      b(.36,0,.34,1.1,top-.15,1.08,WOOD,true);
      for (const [cx,cz] of [[.36,.34],[1.34,.34],[.36,1.3],[1.34,1.3]]) b(cx,0,cz,.12,top-.15,.12,'#8D6A3D');
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
      for (const [dx,dz,top] of [[.61,.19,.92],[1.15,1.02,.82],[.37,1.08,.72]]) {
        b(dx,0,dz,.14,top,.14,DARK,true);
        b(dx-.03,0,dz-.03,.2,.06,.2,'#6D7165');
      }
      b(.65,.74,.47,.49,.18,.49,'#575953');
      b(.72,.92,.18,.33,.29,1.05,'#827766');
      b(.68,.89,.02,.41,.36,.2,LIGHT);
      b(.74,.96,.006,.29,.22,.022,'#458996');
      b(.775,.99,1.22,.22,.17,.15,'#5F574F');
      break;
    case 'anvil':
      b(.4,0,.3,1.1,.12,1.0,'#6D7165');
      b(.5,0,.4,.9,.42,.8,'#5F574F',true);
      b(.3,.42,.28,1.3,.24,.92,'#939584');
      b(1.58,.46,.48,.42,.16,.42,'#6D7165');
      break;
    case 'well':
      b(.18,0,.2,1.5,.55,1.32,'#939584',true);
      for (const dz of [.20,1.37]) b(.18,.55,dz,1.5,.16,.15,'#7B827B');
      for (const dx of [.18,1.53]) b(dx,.55,.35,.15,.16,1.02,'#7B827B');
      s.box(x+.33,y+.565,z+.35,1.2,.015,1.02,'#2F6066',false,false,null,{water:true});
      b(.16,.62,.16,.14,1.5,.14,DARK); b(1.56,.62,.16,.14,1.5,.14,DARK);
      b(.12,2.06,.12,1.62,.12,1.5,'#72513B');
      b(.1,2.18,.1,1.66,.06,1.54,'#5B4434');
      b(.76,1.0,.7,.32,.34,.32,WOOD);
      b(1.7,1.2,.8,.08,.3,.08,DARK); b(1.7,1.42,.8,.08,.08,.24,DARK);
      break;
    case 'fence':
      for(const dx of [.1,.82,1.54]) {
        b(dx,0,.4,.16,1.06,.16,'#AB5236');
        b(dx-.02,1.06,.38,.2,.07,.2,LIGHT);
      }
      b(.06,.28,.44,1.72,.12,.1,'#AB5236'); b(.06,.68,.44,1.72,.1,.1,'#7E2553',true);
      break;
    case 'cart':
      b(.1,.44,.24,1.66,.12,1.1,WOOD,true);
      b(.1,.56,.24,1.66,.3,.12,DARK); b(.1,.56,1.22,1.66,.3,.12,DARK);
      b(.1,.86,.24,.12,.22,.12,DARK); b(1.64,.86,.24,.12,.22,.12,DARK);
      b(.1,.86,1.22,.12,.22,.12,DARK); b(1.64,.86,1.22,.12,.22,.12,DARK);
      for (const dz of [.09,1.27]) for(const dx of [.3,1.4]) {
        b(dx,0,dz,.29,.56,.19,'#5F574F');
        b(dx-.07,.12,dz+.02,.43,.31,.15,'#5F574F');
        b(dx+.07,.2,dz+.196,.15,.15,.045,'#939584');
      }
      b(1.76,.5,.62,.62,.1,.12,DARK);
      b(2.3,.48,.6,.1,.14,.16,'#8D6A3D');
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
  s.shelters.push([2.04,2.72,4.05,4.05]);
  s.group(`room-roof:${site}`,()=>timberGable(roofAdapter(s),2.04,2.75,2.72,4.05,4.05,site==='garden'?'#526B46':'#7A624D',false,true));
  for (const x of [2.14,5.78]) for (const z of [2.83,6.47]) s.box(x,0,z,.18,2.78,.18,DARK,true);
}

export function roomStage(site, props, front, width, depth, style) {
  const s = stage(width, depth);
  const facility=site.startsWith('facility:') ? site.split(':')[2] : null;
  const outside = ['garden','well','yard'].includes(site);
  const back=outside?2.75:site==='watch'?1.76:1.65, wallWidth=2;
  s.walkBounds={left:wallWidth,right:width-wallWidth,top:back,bottom:depth};
  const color = style?.floor ?? (facility==='workshop'?'#77766E':facility==='granary'?'#9C7750':outside ? '#568D3E' : ['watch','workshop'].includes(site) ? '#939584' : WOOD);
  s.floor(0,0,width,depth,0,color);
  if (outside) outdoorRoom(s,site,width,depth,back);
  if (facility) {
    s.box(2,0,back-.22,width-4,facility==='workshop'?1.05:2.2,.22,WOOD,true);
    for (const x of [1.77,width-2]) {
      s.box(x,0,back,.23,1.1,depth-back,DARK,true);
      for (const z of [back,depth-1]) s.box(x,0,z,.23,2.22,.23,LIGHT,true);
    }
    if (facility==='granary') for (const z of [8.4,9.1,9.8,10.5]) s.floor(6,z,4,.36,.026,LIGHT);
    if (facility==='workshop') s.floor(2,depth-1.5,width-4,1.5,.01,'#9C8C73');
  } else if (site==='watch') {
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
    cladding(s,0,0,rear-.2,width,2.18,.2,site==='workshop'||style?.id==='stone');
    s.box(0,.26,rear-.02,width,.09,.075,'#D8A667',true);
    for (const side of [0,width-wallWidth]) s.group(`wall:${side}`,() => {
      s.box(side,0,rear,wallWidth,1.27,depth-rear,DARK,true);
      cladding(s,side,0,rear,wallWidth,1.27,depth-rear,site==='workshop'||style?.id==='stone');
    });
    // 后墙不再是一整面纯色：两扇窗（框+玻璃+十字棂）+ 一面挂布 + 壁灯。
    for (const wx of [width*.22,width*.68]) {
      s.box(wx,1.06,rear+.02,1.5,1.02,.07,DARK);
      s.box(wx+.1,1.14,rear+.1,1.3,.86,.03,'#458996',false,true);
      s.box(wx+.72,1.14,rear+.13,.06,.86,.03,'#72513B');
      s.box(wx+.1,1.53,rear+.13,1.3,.05,.03,'#72513B');
      s.box(wx+.16,1.2,rear+.14,.34,.22,.02,'#A0D2C6');
      s.box(wx-.08,1.0,rear+.04,1.66,.08,.13,'#D8A667');
      // 窗光烘焙：已回退（2026-11-15）。静态烘焙的暖色会被夜间偏冷的 uLight 乘成蓝灰，
      // 夜里读成"发蓝的地板补丁"。要做对需要给 shader 加一个白天因子通道，
      // 2026-11-15：白天因子通道已加 —— 窗光改为 shader 里的程序化通道（见 camp-3d-render.mjs 的 windowPool），
      // 强度乘 uDaylight，夜里自然归零，不再把暖色静态烘进几何。
    }
    // 窗位交给渲染器（中心 x / 所在 z / 半宽 / 占位）
    s.windows = [width*.22, width*.68].map((wx) => [wx + .75, rear + .12, .78, 1]);
    const middle=width*.46;
    if (style?.id==='saltbox') {
      s.box(middle+.08,1.8,rear+.02,1.25,.06,.18,DARK);
      for (const dx of [.27,.68,1.06]) {
        s.beam([middle+dx,1.8,rear+.16],[middle+dx-.08,1.22,rear+.27],.029,'#B49462');
        s.box(middle+dx-.16,1.2,rear+.19,.18,.24,.15,'#839564');
      }
    } else if (style?.id==='stone') {
      s.box(middle,1.12,rear+.03,1.38,.09,.36,DARK);
      for (const [dx,r,h] of [[.21,.13,.23],[.59,.15,.3],[1.08,.17,.22]]) {
        s.cyl(middle+dx,1.21,rear+.19,r,h,style.pottery);
        s.cyl(middle+dx,1.21+h,rear+.19,r*.71,.04,style.border);
      }
    } else {
      s.box(middle,.72,rear+.03,1.24,1.28,.06,style?.cloth??'#7E2553');
      s.box(middle+.16,1.24,rear+.1,.92,.24,.03,style?.border??'#EDC787');
      s.box(middle+.5,1.5,rear+.1,.24,.28,.03,'#FFEC27');
    }
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
    s.group(id,() => prop3d(s,kind,px/16,pz/16,s.heightAt(px/16+.75,pz/16+.6),style));
    const boxes=s.boxes.slice(start).filter(b => !['fire','smoke'].includes(b.fx));
    const bounds=boxes.map(b=>b.bounds??b);
    const x=Math.min(...bounds.map(b=>b.x)), z=Math.min(...bounds.map(b=>b.z));
    const w=Math.max(...bounds.map(b=>b.x+b.w))-x, d=Math.max(...bounds.map(b=>b.z+b.d))-z;
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

// 丰富化（2026-11-19）：门口灯笼，glow 走渲染器夜间光晕，不参与碰撞。
function lantern(s, x, y, z) {
  s.box(x, y, z, .06, .5, .06, DARK);
  // glow 走 transform 展开：stage 与 addCampWork 两套 box 参数位不同，对象 spread 两边都认。
  s.box(x-.05, y+.5, z-.05, .16, .2, .16, '#FFA300', false, false, { glow: true });
  s.box(x-.07, y+.7, z-.07, .2, .05, .2, '#5F574F');
}

// stage.box 比 addCampWork 的 box 多一个 fxKind 位；适配后复用同一套双坡几何。
function roofAdapter(s) {
  return { box: (...a) => s.box(...a.slice(0, 9), null, a[9]), beam: (...a) => s.beam(...a) };
}

function timberGable(s, x, y, z, w, d, color, damaged, openEnds = false) {
  const left = x - .28, width = w + .56, half = d / 2 + .28;
  const ridge = z + d / 2, rise = 1.12, slope = Math.atan2(rise, half);
  const length = Math.hypot(half, rise);
  for (const side of [-1, 1]) {
    const pivot = [left + width / 2, y + rise / 2, ridge + side * half / 2];
    const transform = { rot: [side * slope, 0, 0], pivot };
    const start = pivot[2] - length / 2;
    const panels=4; // 保留屋顶木板分缝；白斜线是雨丝，不是这些接缝
    for (let panel = 0; panel < panels; panel++) {
      const broken=damaged && side===1 && panel===1;
      const px = left + panel * width / 4, panelWidth=width/panels, remaining=length*(broken?.54:1);
      s.box(px, pivot[1] - .065, start, panelWidth, .13, remaining, color, false, false, transform);
      if (panel > 0) s.box(px, pivot[1] + .065, start + .03, .045, .035, remaining - .06, WOOD, false, false, transform);
      if (broken) for (const [offset,tail] of [[.04,.18],[.44,.33],[.8,.12]]) {
        s.box(px+panelWidth*offset,pivot[1]-.064,start+remaining,panelWidth*.13,.089,tail,LIGHT,false,false,transform);
      }
    }
    const eave = ridge + side * half;
    s.box(left, y - .14, eave - .065, width, .16, .13, DARK);
    s.box(left, y - .04, eave - .08, width, .05, .16, LIGHT);
    for (const end of [x + .025, x + w - .12]) {
      if (!openEnds) for (let step = 0; step < 8; step++) {
        const span = (d / 2) / 8, zz = side < 0 ? z + step * span : z + d - (step + 1) * span;
        const high = rise * (.28 + step * span) / half;
        s.box(end, y - .08, zz, .095, high + .08, span, '#72513B');
      }
      s.beam([end + .047, y, eave], [end + .047, y + rise, ridge], .075, DARK);
    }
  }
  s.box(x - .2, y + rise - .02, ridge - .11, w + .4, .14, .22, '#5B4434');
  for (const pz of [z + .1, z + d - .1]) {
    s.box(x, y - .16, pz - .07, w, .16, .14, DARK);
    for (const side of [-1, 1]) {
      const px = side < 0 ? x + .14 : x + w - .14;
      s.beam([px, y - .48, pz], [px - side * .36, y - .12, pz], .075, DARK);
    }
  }
}

function grContainer(s, kind, x, z, tilt = 0) {
  if (kind === 'sack') {
    s.box(x, .02 + tilt, z, .62, .12, .5, '#A39B88');
    s.box(x + .06, .14 + tilt, z + .04, .5, .46, .42, '#D8C3A0');
    s.box(x + .16, .6 + tilt, z + .1, .3, .12, .26, '#EFE4CA');
  } else if (kind === 'barrel') {
    const cx = x + .25, cz = z + .25;
    s.cyl(cx, .02, cz, .23, .12, '#514134', 8);
    s.cyl(cx, .14, cz, .24, .5, '#976A45', 8);
    s.cyl(cx, .3, cz, .25, .09, '#6D7165', 8);
    s.cyl(cx, .54, cz, .25, .09, '#6D7165', 8);
    s.cyl(cx, .64, cz, .21, .06, WOOD, 8);
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
  for (const dx of [-.56, .42]) {
    s.box(X + W / 2 + dx, deck, front + .015, .14, 1.42, .20, DARK, false, true);
  }
  s.box(X + W / 2 - .60, deck + 1.42, front, 1.20, .15, .23, LIGHT, false, true);
  s.box(X + W / 2 - .56, deck, front + .015, 1.12, .07, .24, WOOD, false, true);
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
  timberGable(s, X - .06, wallTop, Z - .06, W + .12, D + .12, '#B65B3C', damaged);
  // 檐下横梁 + 两束谷穗（可辨认"粮"）
  s.box(X - .1, wallTop - .1, front + .06, W + .2, .12, .12, DARK);
  if (!damaged) for (const dx of [-1.1, 1.0]) {
    s.box(X + W / 2 + dx, wallTop - .5, front + .1, .12, .34, .1, '#FFEC27');
    s.box(X + W / 2 + dx - .04, wallTop - .58, front + .1, .2, .1, .1, '#FFA300');
  }

  // 储粮量分档：0 / 少量 / 部分 / 明显增多。store=0 时一个容器都不画。
  const count = granaryGoods(world);
  const scaleX=X+W-.65, scaleZ=front+.12;
  s.box(scaleX,.89,scaleZ,.42,.7,.05,'#514134',false,false,{part:'stock-scale'});
  const level=count===0?0:count===1?1:count===3?2:3;
  s.box(scaleX+.06,.94+level*.17,scaleZ+.06,.30,.08,.055,'#FFEC27',false,false,{part:'stock-marker'});
  const slots = [
    ['sack', X + .35, front + .34], ['barrel', X + 1.05, front + .38],
    ['crate', X + W - .85, front + .34], ['sack', X + W - .45, front + .62],
    ['barrel', X + .7, front + .78],
  ];
  for (let i = 0; i < count; i += 1) {
    const [kind, px, pz] = slots[i];
    grContainer(s, kind, px, pz, damaged && i === count - 1 ? .06 : 0);
  }
  lantern(s, X + W / 2 + .95, .16, front + .62);
  s.beam([X - .3, .2, front + .3], [X - .12, 1.5, front + .06], .04, WOOD);
  s.box(X - .38, .16, front + .24, .22, .1, .3, '#D8A667');
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
function shelter3d(s, lot, record, world, state) {
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
    s.box(X + W / 2 + dx - .05, .97, front + .015, .68, .08, .20, WOOD);
    s.box(X + W / 2 + dx - .03, 1.67, front + .015, .64, .08, .14, DARK);
    if (!damaged) {
      s.box(X + W / 2 + dx - .02, .88, front + .10, .62, .1, .14, '#8D6A3D');
      s.box(X + W / 2 + dx + .06, .98, front + .13, .1, .08, .1, '#FF77A8');
      s.box(X + W / 2 + dx + .3, .98, front + .13, .1, .08, .1, '#FFEC27');
    }
  }
  s.box(X + W / 2 - .5, .16, front, 1.0, 1.48, .08, '#514134');
  s.box(X + W / 2 - .4, .24, front + .05, .8, 1.3, .04, '#AB5236');
  for (const dx of [-.54, .4]) s.box(X + W / 2 + dx, .16, front + .015, .14, 1.48, .20, DARK);
  s.box(X + W / 2 - .58, 1.64, front + .015, 1.16, .13, .22, WOOD);
  s.box(X + W / 2 - .54, .16, front + .015, 1.08, .07, .24, WOOD);
  s.box(X - .2, 2.06, front + .2, W + .4, .12, .9, DARK);           // 门廊挑檐
  timberGable(s, X - .1, 2.06, Z - .1, W + .2, D + .2, '#976A45', damaged);
  const drainX=X+.42, drainZ=front+1.11;
  s.beam([drainX,2.08,drainZ],[X+W+.17,2.14,drainZ],.076,'#458996',8);
  s.beam([drainX,2.08,drainZ],[drainX,1.91,front+.53],.052,'#458996');
  s.cyl(drainX,.35,front+.53,.054,1.56,'#458996');
  s.beam([drainX,.35,front+.53],[drainX,.25,front+.87],.055,'#458996');
  if (state.sheltered) {
    for (const [i,dx] of [-1.45,1].entries()) {
      s.box(X+W/2+dx,1.05,front+.12,.58,.61,.055,'#976A45',false,false,{part:'storm-shutter-'+i});
    }
  }
  if (state.occupied && !damaged) {
    s.box(X+W-.44,3.47,Z+.62,.23,.19,.23,'#C2C3C7',false,false,{part:'hearth-smoke',fx:'smoke'});
  }
  if (!damaged) {
    s.box(X + W - .75, 2.4, Z + .5, .38, .9, .38, '#5F574F');         // 烟囱
    s.box(X + W - .8, 3.3, Z + .45, .48, .12, .48, '#939584');
  }
  for (let i = 0; i < 2; i++) s.box(X + W / 2 - .65, .16 + i * .18, front + .3 + i * .18, 1.3, .18, .22, i ? LIGHT : WOOD);
  lantern(s, X + W / 2 + .85, .16, front + .5);
}

// 生产设施：三面矮墙 + 高挑平坡屋顶 + 正面完全敞开，内部可见工作台/工具架/木料堆。
function workshop3d(s, lot, record, world, state) {
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
  for (const px of [X-.028,X+W-.24]) for (const pz of [Z-.03,front-.24])
    s.box(px,.16,pz,.27,.105,.27,'#7D7A6B');
  s.box(X+.06,.16,front-.045,W-.12,.053,.125,'#8F6B4B');
  s.box(X, .16, Z, W, 1.15, .12, '#72513B');
  if (!world.settlementLife) s.box(X,.16,Z+D-.12,W,1.15,.12,'#72513B');
  for (const px of [X, X + W - .12]) s.box(px, .16, Z, .12, 1.15, D, '#72513B');
  grPlanks(s, X, .16, Z, W, 1.14, D, Boolean(world.settlementLife));
  const roofDepth = D + .6, roofWidth = W + .84;
  const slope = Math.atan2(.45, roofDepth), length = Math.hypot(roofDepth, .45);
  const pivot = [X + W / 2, 2.725, Z + D / 2];
  const surface = { rot: [slope, 0, 0], pivot };
  const start = pivot[2] - length / 2;
  for (let panel = 0; panel < 4; panel++) {
    const broken=damaged && panel===1;
    const px=X-.42+panel*roofWidth/4, panelWidth=roofWidth/4, remaining=length*(broken?.63:1);
    s.box(px,pivot[1]-.065,start,panelWidth,.13,remaining,'#6D7165',false,false,surface);
    if (panel > 0) s.box(px,pivot[1]+.065,start+.03,.05,.035,remaining-.06,'#939584',false,false,surface);
    if (broken) s.box(px+panelWidth*.67,pivot[1]-.06,start+remaining,panelWidth*.27,.07,.42,'#8A8F83',false,false,surface);
  }
  const rearBeamY = 2.95 - .45 * .3 / roofDepth - .14;
  s.box(X, rearBeamY, Z, W, .14, .2, DARK);
  for (const px of [X, X + W - .2]) {
    s.box(px, 2.5, Z, .22, rearBeamY - 2.5, .22, DARK);
    s.beam([px + .1, rearBeamY, Z], [px + .1, 2.42, front], .085, DARK);
  }
  s.box(X - .42, 2.82, Z - .36, roofWidth, .14, .12, DARK);
  s.box(X - .42, 2.42, front + .24, roofWidth, .1, .12, LIGHT);
  // 内部：工作台、工具架、木料堆、炉火
  s.box(X + .35, .78, Z + .7, W - .7, .12, .55, WOOD);
  for (const px of [X + .42, X + W - .58]) for (const pz of [Z + .72, Z + 1.11]) {
    s.box(px, .16, pz, .12, .62, .12, DARK);
  }
  s.box(X + .5, .90, Z + .8, .5, .08, .3, '#9DA8A8');
  s.box(X + W - .95, .16, Z + .2, .12, 1.6, .8, '#5B4434');
  for (let i = 0; i < 3; i++) s.box(X + W - .9, .5 + i * .38, Z + .3, .06, .28, .55, i % 2 ? '#9DA8A8' : '#C18F58');
  for (let i = 0; i < 3; i++) s.box(X + .35, .16 + i * .16, front - .72, 1.1, .14, .28, GR_PLANK[i % 4]);
  // 储物聚合模型：与背包图标共用 camp-items.mjs 定义，不另写一份几何
  worldItem(s, 'crate', X + W - 1.9, front - 1.35, .72, .16);
  worldItem(s, 'sack', X + W - 1.25, front - 1.35, .68, .16);
  if (!damaged) {
    s.box(X+W-1.5,.16,front-.62,.42,.34,.42,'#514134',false,false,{part:'forge-bed'});
    if (state.occupied) {
      s.box(X+W-1.47,.49,front-.59,.36,.19,.36,'#FFA300',false,false,{part:'forge-embers',fx:'fire',glow:true});
      s.box(X+W-1.40,3.74,front-.52,.22,.18,.22,'#C2C3C7',false,false,{part:'forge-smoke',fx:'smoke'});
    }
  }
  // The exhaust joins the forge to the roof, with a rain cap on three supports.
  const px=X+W-1.29,pz=front-.41;
  s.cyl(px,.52,pz,.16,2.86,'#5F574F',8);
  s.cyl(px,3.29,pz,.23,.14,'#939584',8);
  for (const [dx,dz] of [[-.13,0],[.13,0],[0,.13]]) s.cyl(px+dx,3.43,pz+dz,.026,.17,'#939584',6);
  s.cyl(px,3.60,pz,.25,.085,'#6D7165',8);
  s.beam([X+.12,1.86,front-.1],[X+.78,2.43,front-.1],.066,'#72513B');
  s.beam([X+W-.12,1.86,front-.1],[X+W-.78,2.43,front-.1],.066,'#72513B');
  worldItem(s, 'bucket', X + .3, front - .35, .62, .16);
  worldItem(s, 'wood', X + W - 1.15, front - .3, .8, .16);
  worldItem(s, 'wood', X + W - 1.0, front - .55, .7, .32);
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
  s.box(x+.08,0,Z+.48,w-.16,.082,.105,'#686A5C',false,phase==='foundation'?'ground':false);
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
    const ph = short ? H * (damage >= 2 && i === 2 ? .46 : .62) : H;
    s.box(px, .18, Z, .19, ph, .42, DARK, false, phase === 'frame');
    s.box(px - .03, .18, Z - .03, .25, .14, .48, GR_STONE[0]);
    if (!short) s.box(px - .02, .18 + ph, Z - .02, .23, .09, .46, LIGHT, false, phase === 'frame');
  }
  const rows = phase === 'frame' ? Math.ceil(ratio * 4) : 4;
  for (let r = 0; r < rows; r++) {
    const broken=(damage>=1 && r===3) || (damage>=2 && r===1);
    const start=x+.18,width=w-.36,y=.34+r*.36,color=GR_PLANK[(r+1)%4];
    if (!broken) {
      s.box(start,y,Z+.42,width,.3,.09,color);
      continue;
    }
    // Keep both ends of the rail. The gap follows the shortened post instead of spanning the wall.
    const gapStart=r===3?.46:.29, gapEnd=r===3?.73:.61;
    s.box(start,y,Z+.42,width*gapStart,.3,.09,color);
    s.box(start+width*gapEnd,y,Z+.42,width*(1-gapEnd),.3,.09,color);
    s.box(start+width*gapStart,y+.11,Z+.42,width*.032,.105,.085,LIGHT);
  }
  if (phase !== 'frame') {
    const capWidth=w-.28;
    if (damage) {
      s.box(x+.14,.18+H,Z-.05,capWidth*.48,.13,.52,WOOD);
      s.box(x+.14+capWidth*.72,.18+H,Z-.05,capWidth*.28,.13,.52,WOOD);
    } else s.box(x+.14,.18+H,Z-.05,capWidth,.13,.52,WOOD);
    for (let i = 0; i < 3; i++) {
      const px = x + .7 + i * (w - 1.5) / 2;
      const fallen = damage >= 2 && i === 1;        // 重损：中间斜撑倒地
      const heel=[px,.46,Z-.59];
      const head=fallen?[px+.55,.22,Z-.75]:[px,1.52,Z+.09];
      s.beam(heel,head,.093,'#514134').part='wall-brace-'+i;
      s.box(px, .34, Z - .6, .5, .14, .3, GR_STONE[1]);
    }
  }
}

// 从奠基到登记入住使用同一个地块和木屋外壳。
function homeRoof(s,x,y,z,w,d,style) {
  const {rise}=style, ridge=z+d*style.ridge;
  for (const side of [-1,1]) {
    const run=d*(side<0?style.ridge:1-style.ridge);
    const slope=Math.atan2(rise,run), length=Math.hypot(run,rise);
    const pivot=[x+w/2,y+rise/2,ridge+side*run/2];
    const surface={rot:[side*slope,0,0],pivot};
    const start=pivot[2]-length/2;
    s.box(x-.06,pivot[1]-.065,start,w+.12,.13,length,style.roof,false,false,surface);
    for (let k=.32; k<w; k+=.62) {
      s.box(x+k,pivot[1]+.065,start+.04,.044,.031,length-.08,'#514134',false,false,surface);
    }
    const eave=ridge+side*run;
    s.box(x-.12,y-.09,eave-.055,w+.24,.14,.11,'#72513B');
    // The gable closes the space under the roof at both ends.
    for (let step=0;step<7;step++) {
      const span=run/7, zz=side<0 ? z+step*span : z+d-(step+1)*span;
      for (const xx of [x+.025,x+w-.12]) {
        const high=rise*step/7;
        if (high>0) s.box(xx,y-.02,zz,.095,high+.02,span,'#976A45');
      }
    }
  }
  s.box(x-.12,y+rise-.033,ridge-.071,w+.24,.12,.142,'#514134');
}

function home3d(s, lot, record, seed) {
  const { x, z, w, d } = lot;
  const X = x + .25, Z = z + .25, W = w - .5, D = d - .5;
  const phase = constructionStage(record);
  const ratio = Math.min(1, (record.progress ?? HOME_LABOR) / HOME_LABOR), front = Z + D;
  const style = homeStyle(record.loc,seed);
  if (worksBase(s, lot, phase)) return;
  const postH = phase === 'frame' ? .5 + ratio * 1.5 : 1.95;
  for (const px of [X, X + W - .18]) for (const pz of [Z, front - .18])
    s.box(px, .16, pz, .18, postH, .18, DARK, false, phase === 'frame');
  if (phase === 'frame') {
    for (let i = 0; i < Math.ceil(ratio * 5); i++) s.box(X, .16 + i * .36, front, W, .3, .12, GR_PLANK[i % GR_PLANK.length], false, true);
    s.box(X, .16 + postH, Z, W, .14, .18, WOOD, false, true);
    return;
  }
  s.box(X, .16, Z, W, 1.85, D, '#72513B', false, false, {castShadow:true});
  grPlanks(s, X, .16, Z, W, 1.82, D, true);
  homeRoof(s,X-.19,2.0,Z-.30,W+.38,D+.60,style);
  if (style.id==='stone') {
    cladding(s,X-.025,.16,Z-.023,W+.05,.56,D+.05,true);
  } else if (style.id==='saltbox') {
    for (const side of [-1,1]) {
      const px=X+W/2+side*(W/2-.13);
      s.beam([px,.27,front+.031],[px-side*.65,1.04,front+.031],.05,style.trim);
      s.box(px-.055,.16,front+.025,.11,1.78,.09,style.trim);
    }
  }
  s.box(X + W / 2 - .46, .16, front, .92, 1.42, .08, '#514134');
  s.box(X + W / 2 - .36, .24, front + .05, .72, 1.26, .04, style.door);
  for (const dx of [-.5, .36]) s.box(X + W / 2 + dx, .16, front + .015, .14, 1.42, .20, DARK);
  s.box(X + W / 2 - .54, 1.58, front + .015, 1.08, .13, .22, WOOD);
  s.box(X + W / 2 - .5, .16, front + .015, 1.0, .07, .24, WOOD);
  const doorX = X + W / 2;
  s.box(doorX - .6, 0, front + .14, 1.2, .12, .43, '#7A7667');
  s.box(doorX - .49, .004, front + .57, .98, .04, .39, '#939584');
  for (const dx of style.windows) {
    const windowX=X+W/2+dx;
    s.box(windowX,1.05,front+.01,.54,.58,.06,'#514134');
    s.box(windowX-.035,1.043,front+.015,.61,.045,.105,'#976A45');
    s.box(windowX-.018,1.60,front+.019,.578,.065,.09,'#72513B');
    s.box(windowX-.06,.97,front+.015,.66,.08,.20,WOOD);
    s.box(windowX-.04,1.66,front+.015,.62,.08,.14,DARK);
    s.box(windowX-.02,.88,front+.10,.6,.1,.14,'#8D6A3D');
    s.box(windowX+.08,.98,front+.13,.1,.08,.1,'#FF77A8');
    s.box(windowX+.3,.98,front+.13,.1,.08,.1,'#FFEC27');
  }
  // 烟囱是房屋的一部分。烟、暖窗和柴堆由住户状态决定。
  s.box(X + W - .62, 2.35, Z + .45, .34, .92, .34, '#5F574F');
  s.box(X + W - .66, 3.27, Z + .41, .42, .11, .42, '#939584');
  // A rain hood protects the threshold and is fixed back into the façade.
  const pivot=[doorX,1.82,front+.16];
  s.box(doorX-.72,1.78,front+.06,1.44,.09,.67,style.trim,false,false,
    {rot:[.25,0,0],pivot});
  for (const side of [-1,1]) {
    const px=doorX+side*.55;
    s.beam([px,1.49,front+.08],[px,1.72,front+.51],.044,'#514134');
  }
  s.cyl(doorX+.26,.93,front+.088,.052,.08,'#D8A667',8,'z');
  lantern(s, doorX+.85, .16, front+.5);
}

const HOME_LABOR = 3;

function homeLot(world, room) {
  return layoutHomeLot(room,world.layout,world.peripheralHomes);
}

export function homeAppearance(world, sites = world.rooms ?? {}) {
  const rooms = Object.keys(world.households?.deeds ?? sites).filter(room => residentialSite(room,world.peripheralHomes)).sort();
  const occupied = new Set();
  for (const [id, room] of Object.entries(world.housing ?? {})) {
    const agent = world.agents?.[id];
    if (agent && !agent.dead) occupied.add(room);
  }
  return rooms.map(room => [room, occupied.has(room), ...(world.homeAccess ? [world.homeAccess[room]?.damage??0] : [])]);
}

export function outdoorHomes(world, appearance) {
  const s = stage(0, 0);
  s.windows=[];
  for (const [room, occupied, damage] of appearance) {
    const lot = homeLot(world, room);
    const x = lot.x + lot.w / 2, front = lot.z + lot.d - .25;
    s.entrances[room]=campEntrance(room,world.layout?.sites[room]??residentialSite(room,world.peripheralHomes),world.peripheralHomes);
    s.group(`work:${room}:house`, () => {
      const style=homeStyle(room,world.layout?world.mapSeed:0);
      for (const offset of style.windows) {
        const dx=offset+.06, side=offset<0?'left':'right';
        const pane=s.box(x+dx,1.12,front+.075,.42,.44,.03,occupied?'#EDC787':'#2E3B3A',false,occupied,null,{part:'window-'+side});
        if (occupied) s.windows.push([pane.x+pane.w/2,pane.z+pane.d,pane.w/2,pane.y]);
        const shutter=occupied?(dx<0?x+dx-.2:x+dx+.44):x+dx;
        s.box(shutter,1.1,front+.115,occupied?.17:.42,.48,.045,style.trim,false,false,null,{part:'shutter-'+side});
      }
      if (damage>0) {
        s.box(x-.34,.27,front+.105,.68,1.17,.055,'#342923');
        s.box(x-.33,.44,front+.17,.46,.13,.07,'#B58656');
        s.box(x-.2,.94,front+.17,.5,.12,.07,'#B58656');
      }
      if (occupied) {
        s.chimneys.push([lot.x + lot.w - .70, 3.4, lot.z + .87]);
        worldItem(s, 'wood', lot.x + .45, front + .32, .68, .02);
      }
    });
  }
  return s;
}

export function districtResources(districts) {
  const boxes=[];
  for (const [loc,{source:[x,z],resource}] of Object.entries(districts??{})) {
    const s={box(x,y,z,w,h,d,color) {
      boxes.push({x,y,z,w,h,d,color,occluder:'resource:'+loc});
    }};
    worldItem(s,resource,x-.32,z-.24,.88,.015);
  }
  return boxes;
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

function facilityParts(world,building) {
  const type=building.type;
  const canBeOccupied=['shelter','workshop'].includes(type) && (building.integrity??1)>=1;
  const inside=world.campPlayerRoom===facilityId(building) && !world.agents?.p1?.dead;
  const active=['shelter','workshop'].includes(type) && (world.occupancy?.[building.loc]??[]).some(id=>{
    const a=world.agents?.[id];
    return a && !a.isPlayer && !a.dead && !world.districtTravel?.[id] &&
      a.loc===building.loc && (type==='shelter'?a.act==='rest':['work','repair'].includes(a.act));
  });
  return {
    occupied:canBeOccupied && (inside || active),
    sheltered:type==='shelter' && ['rain','cold'].includes(world.weather),
  };
}

export function workModelKey(world, appearance, treeSignature) {
  const placement = b => [b.type, b.loc, b.lot?.x, b.lot?.z, b.lot?.w, b.lot?.d];
  const buildings = world.buildings ?? [];
  return JSON.stringify([
    buildings.map(b => [...placement(b), buildingDamage(b), ...(world.settlementLife?[b.integrity>0]:[]), facilityParts(world,b)]),
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
    const first=boxes.length;
    const project={id,phase,record,lot,labor,gate:facilityGate(record,world.layout),parts:new Map()};
    projects.push(project);
    const state=facilityParts(world,record);
    const build=()=>{
      const s={
        box(x,y,z,w,h,d,color,solid=false,rise=false,transform) {
          addModel(boxes,{x,y,z,w,h,d,color,solid,rise,...transform},id);
        },
        beam(...args) { return addModel(boxes,beam(...args),id); },
        cyl(...args) { return addModel(boxes,cyl(...args),id); },
      };
      // 第一阶段：四种建筑各走专属轮廓，保留已验收的 granary3d 不动。
      if (record.type === 'granary') {
        granary3d(s,lot,record,world);
        if (phase==='complete') {
          // Loading handrail sits beside the existing stairs.
          const railX=x+w/2-.72, front=z+d-.17;
          for (const [y,pz] of [[.22,front+.47],[.8,front-.36]]) s.cyl(railX,y,pz,.042,.55,'#514134',6);
          s.beam([railX,.77,front+.47],[railX,1.35,front-.36],.053,'#976A45');
        }
        return;
      }
      if (record.type === 'shelter') { shelter3d(s, lot, record, world,state); return; }
      if (record.type === 'workshop') { workshop3d(s, lot, record, world,state); return; }
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
    build();
    for (let i=first;i<boxes.length;i++) if (boxes[i].part) project.parts.set(boxes[i].part,boxes[i]);
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
