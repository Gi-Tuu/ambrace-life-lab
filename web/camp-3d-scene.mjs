const WOOD = '#BA8752', DARK = '#72513B', LIGHT = '#D8A667';

function stage(width, depth) {
  const boxes = [], floors = [], fxs = [], chimneys = [];
  return {
    width, depth, boxes, floors, fxs, chimneys, entrances: {},
    // fxKind 非空 ⇒ 这块几何不进静态网格，改由渲染器按动画帧逐帧生成（呼吸感）。
    box(x, y, z, w, h, d, color, solid = false, glow = false, fxKind = null) {
      const item = { x,y,z,w,h,d,color,solid,glow };
      if (fxKind) { item.fx = fxKind; fxs.push(item); }
      boxes.push(item);
    },
    floor(x, z, w, d, y, color, axis, end = y) { floors.push({ x,z,w,d,y,color,axis,end }); },
    heightAt(x, z) {
      let y = 0;
      for (const f of floors) {
        if (x < f.x || x > f.x + f.w || z < f.z || z > f.z + f.d) continue;
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

function roof(s, x, z, w, d, y, color) {
  s.box(x-.22,y,z-.22,w+.44,.16,d+.44,color);
  for (let i = 0; i < 5; i += 1) {
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
  roof(s,left,back,right-left,3.06,2.9,'#3F7036');
  for(const bx of [left+1.1,right-1.6]){
    s.box(bx,y+1.32,front-.34,.66,1.22,.06,'#944735',false,false,'banner');
    s.box(bx+.2,y+1.82,front-.27,.26,.3,.03,'#FFEC27',false,false,'banner');
  }
}

function house(s, id, x, z) {
  const colors = { home:'#AB5236', store:'#D8A667', workshop:'#5F574F', watch:'#83769C' };
  const color = colors[id] ?? '#976A45';
  const left = x - 3.6, back = z - 7.85, width = 7.2, depth = 6.15;
  s.box(left,0,back,width,.27,depth,DARK,true);
  s.box(left+.15,.27,back+.1,width-.30,2.8,depth-.20,'#D8A667');
  roof(s,left,back,width,depth,3.08,color);
  const front = back + depth;
  s.entrances[id] = { x:x-1.15, z:front-.55, w:2.3, d:1.5 };
  s.box(x-.63,.27,front-.02,1.26,1.82,.10,'#72513B');
  s.box(x-.49,.33,front+.09,.98,1.66,.035,'#AB5236');
  s.box(x+.23,1.02,front+.135,.11,.1,.04,'#EDC787');
  for (const dx of [-2.45,1.57]) {
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

function outdoorFixture(s, id, x, z) {
  s.entrances[id] = { x:x-1.1, z:z-1.35, w:2.2, d:1.5 };
  if (id === 'well') {
    s.box(x+.2,0,z-4,2.6,.72,2.65,'#939584',true);
    s.box(x+.47,.73,z-3.73,2.05,.045,2.09,'#458996');
    for (const dx of [.28,2.56]) s.box(x+dx,.72,z-3.12,.18,1.84,.18,DARK);
    roof(s,x+.12,z-3.98,2.8,2.6,2.5,'#5F574F');
    return;
  }
  const x0 = x+.1, z0 = z-4.95;
  s.box(x0,0,z0,3.75,.22,3.75,DARK);
  for (const dx of [.12,3.46]) for (const dz of [.12,3.46]) s.box(x0+dx,.21,z0+dz,.17,2.3,.17,DARK,true);
  // 棚屋此前是一整块深棕立方体：补屋脊亮线、檐口和两只货箱，与住屋同一套材质语言。
  roof(s,x0,z0,3.75,3.75,2.5,id === 'garden' ? '#3F7036' : '#B65B3C');
  s.box(x0-.16,3.32,z0+1.62,4.07,.14,.5,id === 'garden' ? '#93AE73' : '#E99E61');
  s.box(x0-.12,2.46,z0-.12,3.99,.12,.16,'#D8A667');
  s.box(x0+.36,.24,z0+.37,1.13,.76,.94,WOOD,true);
  s.box(x0+.45,1.0,z0+.46,.95,.09,.76,'#D8A667');
  s.box(x0+2.28,.24,z0+2.36,.86,.58,.84,'#72513B',true);
  s.box(x0+2.36,.82,z0+2.44,.7,.08,.68,'#D8A667');
}

// 世界植被：果树 / 浆果灌木 / 灌木 / 野花。确定性分布由 app.js 生成，这里只负责建模。
// 纯表现层：不进 blockers、不改可行走格；带 sway 的部分交给渲染器逐帧轻摆。
function flora3d(s, world) {
  const LEAF = '#3F7036', LIGHT = '#98BD51', BERRY = '#FF004D';
  for (const [tx, tz, kind] of (world.flora ?? [])) {
    const x = tx + .5, z = tz + .5, v = (tx * 7 + tz) % 3;
    if (kind === 'fruit') {
      s.box(x-.16,0,z-.16,.32,1.45,.32,DARK);
      s.box(x-.82,1.28,z-.76,1.64,.96,1.52,v===0?LEAF:'#568D3E',false,false,'sway');
      s.box(x-.52,2.16,z-.48,1.04,.66,1.0,LIGHT,false,false,'sway');
      for(const [dx,dy,dz] of [[-.48,1.62,.58],[.42,1.88,-.34],[.08,2.34,.34]])
        s.box(x+dx,dy,z+dz,.17,.17,.17,BERRY);
    } else if (kind === 'berry') {
      for(const [dx,dz,hh] of [[-.32,-.2,.5],[.28,.1,.66],[0,.34,.42]])
        s.box(x+dx-.3,.02,z+dz-.3,.6,hh,.6,LEAF,false,false,'sway');
      for(const [dx,dy,dz] of [[-.38,.48,-.18],[.24,.6,.1],[0,.38,.38]])
        s.box(x+dx,dy,z+dz,.12,.12,.12,BERRY);
    } else if (kind === 'bush') {
      s.box(x-.42,.02,z-.36,.84,.54,.72,v===1?'#315431':LEAF,false,false,'sway');
      s.box(x-.22,.5,z-.2,.44,.3,.4,LIGHT,false,false,'sway');
    } else {
      const c = ['#FFEC27','#FF77A8','#FFF0CC','#29ADFF'][v%4];
      s.box(x-.03,0,z-.03,.06,.4,.06,'#315431');
      s.box(x-.18,.36,z-.18,.36,.14,.36,c,false,false,'sway');
      s.box(x-.04,.48,z-.04,.08,.08,.08,'#FFA300');
    }
  }
}

// 田地作物独立建模：每块 8 株，高度/颜色取载荷里的真实生长度（纯读取，不改规则）。
function crops3d(s, world) {
  const plots = world.plots ?? [], beds = world.beds ?? [];
  for (const b of beds) {
    const bx=b.x/16, bz=b.y/16, bw=b.w/16, bh=b.h/16;
    const growth = plots[(b.row*4+b.col)%Math.max(1,plots.length)]?.growth ?? .3;
    s.box(bx,0,bz,bw,.06,bh,'#482D2B');
    for(let r=0;r<2;r+=1) for(let c=0;c<4;c+=1){
      const x=bx+.42+c*(bw-.84)/3.5, z=bz+.5+r*(bh-1), hh=.18+growth*.6;
      s.box(x-.05,.06,z-.05,.1,hh,.1,'#315431');
      s.box(x-.22,.06+hh*.42,z-.12,.44,.16,.24,growth>=1?'#FFEC27':'#73A747',false,false,'sway');
      if(growth>=.65)s.box(x-.12,.06+hh,z-.12,.24,.22,.24,growth>=1?'#FFA300':'#98BD51');
    }
  }
}

// 养殖：院旁围栏鸡舍 + 3 只鸡（逐帧点头/挪动）。产出仍由规则层裁决，这里只建可见内容。
function livestock3d(s, world) {
  const y = world.sites?.yard;
  if (!y) return;
  const cx=y[0]+8.5, cz=y[1]+.5;
  for(let i=0;i<9;i+=1){
    s.box(cx-2.4+i*.6,0,cz-1.6,.1,.68,.1,DARK);
    s.box(cx-2.4+i*.6,0,cz+1.6,.1,.68,.1,DARK);
  }
  s.box(cx-2.4,.48,cz-1.6,4.8,.09,.1,WOOD);
  s.box(cx-2.4,.48,cz+1.6,4.8,.09,.1,WOOD);
  s.box(cx+1.1,0,cz-1.05,1.5,1.02,1.35,WOOD);
  roof(s,cx+1.05,cz-1.1,1.6,1.45,1.02,'#AB5236');
  s.box(cx+1.5,.1,cz+.3,.5,.66,.06,'#1D2B53');
  const stock = world.livestock ?? {}, nChicken = Math.min(4, stock.chickens ?? 3);
  const spots = [[-1.6,-.6,'#FFF0CC'],[-.7,.7,'#D58274'],[.1,-.2,'#FFF0CC'],[.6,.8,'#FFF0CC']];
  for(let i=0;i<nChicken;i+=1){
    const [dx,dz,c]=spots[i];
    s.box(cx+dx,.02,cz+dz,.42,.34,.34,c,false,false,'peck');
    s.box(cx+dx+.16,.36,cz+dz+.1,.1,.12,.1,'#FF004D');
  }
  // 奶牛 / 羊：存栏数由规则层给出，模型随数量增减，不吃帧预算。
  const cows=Math.min(3,stock.cows??2), sheep=Math.min(3,stock.sheep??2);
  for(let i=0;i<cows;i+=1){
    const bx=cx-2.1+i*1.25, bz=cz-2.75;
    s.box(bx,0,bz,1.02,.62,.68,'#FFF0CC',false,false,'graze');
    s.box(bx+.1,.62,bz+.08,.8,.28,.5,'#5F574F',false,false,'graze');
    for(const [ox,oz] of [[.08,.08],[.72,.08],[.08,.46],[.72,.46]])s.box(bx+ox,0,bz+oz,.14,.42,.14,'#72513B');
    s.box(bx+.86,.42,bz+.12,.42,.4,.38,'#FFF0CC',false,false,'graze');
    s.box(bx+1.02,.82,bz+.06,.1,.14,.1,'#D8A667');
  }
  for(let i=0;i<sheep;i+=1){
    const bx=cx+.5+i*1.1, bz=cz-2.75;
    s.box(bx,0,bz,.86,.6,.62,'#D9D6B8',false,false,'graze');
    s.box(bx+.08,.6,bz+.06,.7,.24,.5,'#FFF1E8',false,false,'graze');
    for(const [ox,oz] of [[.08,.08],[.62,.08],[.08,.42],[.62,.42]])s.box(bx+ox,0,bz+oz,.12,.4,.12,'#5F574F');
    s.box(bx+.74,.36,bz+.14,.3,.3,.3,'#32302C',false,false,'graze');
  }
}

export function outdoorStage(world, bridges, rocks) {
  const s = stage(world.tw, world.th);
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
    if (id === 'hall') hall(s,x,z);
    else if (['garden','well','yard'].includes(id)) outdoorFixture(s,id,x,z);
    else house(s,id,x,z);
  }
  for (const [tx,tz] of world.trees) {
    const x = tx+.5, z = tz+.5, variant = (tx*3+tz)%3;
    s.box(x-.2,0,z-.21,.4,1.51,.42,DARK,true);
    s.box(x-.83,1.22,z-.77,1.66,1.08,1.54,'#315431');
    s.box(x-.7,2.1,z-.63,1.4,.85,1.26,variant===0?'#3F7036':'#568D3E');
    s.box(x-.39,2.82,z-.41,.83,.52,.82,'#98BD51',false,false,'sway');
  }
  for (const [tx,tz] of rocks) {
    s.box(tx+.12,0,tz+.12,.76,.48,.71,'#6D7165',true);
    s.box(tx+.24,.48,tz+.22,.52,.16,.47,'#939584');
  }
  crops3d(s, world);
  flora3d(s, world);
  livestock3d(s, world);
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
      b(.12,0,.16,1.62,.86,1.24,'#5F574F',true);
      b(.42,.22,.42,.92,.52,.12,'#1D2B53');
      b(.5,.28,.44,.76,.38,.06,'#FFA300',false,'fire');
      b(.6,.36,.46,.56,.22,.05,'#FFEC27',false,'fire');
      b(.2,.86,.22,1.46,.14,1.12,LIGHT);
      b(.62,1.0,.5,.42,.62,.42,'#5F574F');
      b(.7,1.62,.58,.26,.22,.26,'#C2C3C7',false,'smoke');
      break;
    case 'table':
      legs(); b(.08,.55,.08,1.74,.12,1.26,LIGHT,true);
      b(.34,.67,.36,.34,.09,.3,'#EDC787'); b(1.06,.67,.72,.3,.14,.3,'#C2C3C7');
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
      for(const sy of [.12,.66,1.2,1.62]) b(.12,sy,.18,1.62,.1,1.2,LIGHT);
      for(const [sx,c] of [[.28,'#FFEC27'],[.5,'#29ADFF'],[.72,'#00E436'],[.94,'#FFA300'],[1.24,'#D58274']])
        b(sx,.76,.42,.18,.36,.22,c);
      break;
    case 'planter': case 'trellis':
      b(.14,0,.2,1.6,.42,1.1,'#AB5236',true);
      b(.22,.42,.28,1.44,.08,.94,'#482D2B');
      for(const [dx,h,c] of [[.36,.62,'#008751'],[.78,.86,'#00E436'],[1.2,.7,'#568D3E']]) {
        b(dx+.1,.5,.55,.08,h,.08,'#315431');
        b(dx,.5+h*.5,.38,.36,.34,.42,c,false,'sway');
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
      b(.36,0,.34,1.1,tall?1.16:.7,1.08,'#7E2553',true);
      for(const sy of [.2,tall?.86:.52]) b(.32,sy,.3,1.18,.09,1.16,DARK);
      b(.4,tall?1.16:.7,.38,.98,.08,.98,LIGHT);
      if(!tall){ b(.3,.7,.32,.1,.62,.1,DARK); b(1.42,.7,.32,.1,.62,.1,DARK); b(.3,1.28,.32,1.22,.08,.1,DARK); }
      break;
    }
    case 'telescope':
      b(.86,0,.62,.12,.9,.12,DARK); b(.4,0,.3,.12,.9,.12,DARK); b(1.3,0,.3,.12,.9,.12,DARK);
      b(.6,.9,.46,.68,.18,.4,'#5F574F');
      b(.42,1.02,.5,1.06,.24,.3,'#83769C',false,'sway');
      b(1.44,1.06,.52,.18,.16,.26,'#29ADFF');
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
      b(.06,.28,.44,1.72,.12,.1,'#AB5236'); b(.06,.68,.44,1.72,.1,.1,'#7E2553');
      break;
    case 'cart':
      b(.1,.44,.24,1.66,.12,1.1,WOOD,true);
      b(.1,.56,.24,1.66,.3,.12,DARK); b(.1,.56,1.22,1.66,.3,.12,DARK);
      for(const dx of [.3,1.4]) b(dx,0,.16,.28,.5,.28,'#5F574F');
      b(1.76,.5,.62,.62,.1,.12,DARK);
      break;
    default:
      b(.16,0,.21,1.56,.69,1.1,WOOD,true);
      b(.2,.69,.25,1.48,.06,1.02,LIGHT);
  }
}

export function roomStage(site, props, front, width, depth) {
  const s = stage(width, depth);
  const outside = ['garden','well','yard'].includes(site);
  const color = outside ? '#568D3E' : ['watch','workshop'].includes(site) ? '#939584' : WOOD;
  s.floor(0,0,width,depth,0,color);
  if (!outside) {
    const rear = 50/16;
    s.box(0,0,0,width,2.18,rear,'#72513B');
    s.box(0,.26,rear-.02,width,.09,.075,'#D8A667');
    s.box(0,0,rear,2,1.27,depth-rear,DARK);
    s.box(width-2,0,rear,2,1.27,depth-rear,DARK);
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
  for (const [kind,px,pz] of props) prop3d(s,kind,px/16,pz/16,s.heightAt(px/16+.75,pz/16+.6));
  return s;
}

export function addCampWork(stage, w, sites) {
  const s = { box(x,y,z,w,h,d,color,solid=false) { stage.push({x,y,z,w,h,d,color,solid}); } };
  for (const b of w.buildings ?? []) {
    const at = sites[b.loc];
    if (!at) continue;
    const [x,z] = at;
    s.box(x+3,0,z-3,3.5,1.55,2.7,'#72513B',true);
    roof(s,x+3,z-3,3.5,2.7,1.55,b.integrity < 1 ? '#5F574F' : '#976A45');
  }
  for (const b of w.sites ?? []) {
    const at = sites[b.loc];
    if (!at) continue;
    const [x,z] = at;
    s.box(x+3,0,z-3,3.5,.18,2.7,'#939584');
    s.box(x+3.24,.18,z-2.72,1.62,.48,.46,WOOD,true);
  }
}
