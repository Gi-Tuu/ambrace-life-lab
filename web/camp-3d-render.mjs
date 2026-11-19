import { animalHead, posedAnimalHead, animalNeck } from './camp-animal-motion.mjs';
import { residentLook } from './resident-look.mjs';
import { itemBoxes } from './camp-items.mjs';
import { CAMP_BODY_RADIUS } from './camp-3d-physics.mjs';
import { WALK_DIRECTIONS } from './walk.mjs';
import { contactShadowMesh, groundContactMesh, materialGrain } from './camp-lighting.mjs';
import { bakeVertexAO } from '../shared/camp-ao.mjs';
import { beam, boxVertices, cyl, modelBounds, beamRing, dot, cross, norm, rotate, rotateXZ } from '../shared/camp-geometry.mjs';
export { beam, boxVertices, cyl, modelBounds };

const rgb = (hex, shade = 1) => [1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)*shade/255);
export const MODEL_STRIDE=15;
const WOOD=new Set(['#514134','#72513B','#976A45','#BA8752','#D8A667','#EDC787','#8A633F','#5B4434','#8D593F']);
const METAL=new Set(['#458996','#939584','#9DA8A8','#6D7165']);
const finishOf=color=>WOOD.has(color)?1:METAL.has(color)?2:0;
const faceNormal=(a,b,c)=>{
  const ux=b[0]-a[0],uy=b[1]-a[1],uz=b[2]-a[2],vx=c[0]-a[0],vy=c[1]-a[1],vz=c[2]-a[2];
  const x=uy*vz-uz*vy,y=uz*vx-ux*vz,z=ux*vy-uy*vx;
  const len=Math.hypot(x,y,z)||1;
  return [x/len,y/len,z/len];
};

export function campCamera({ x,z,width,height,span,yaw=.29,pitch=.65,targetY=.55 }) {
  const back = [Math.sin(yaw)*Math.cos(pitch),Math.sin(pitch),Math.cos(yaw)*Math.cos(pitch)];
  const right = norm(cross([0,1,0],back)), up = cross(back,right);
  const aim = [x,targetY,z], eye = aim.map((v,i)=>v+80*back[i]);
  const halfX = span/2, halfY = halfX*height/width;
  return {
    back, focus:[x,z],
    view: [right[0],up[0],back[0],0,right[1],up[1],back[1],0,right[2],up[2],back[2],0,
      -dot(right,eye),-dot(up,eye),-dot(back,eye),1],
    projection: [1/halfX,0,0,0,0,1/halfY,0,0,0,0,-2/199.9,0,0,0,-200.1/199.9,1],
    project(px,py,pz) {
      const p = [px-aim[0],py-aim[1],pz-aim[2]];
      return [(1+dot(right,p)/halfX)*width/2,(1-dot(up,p)/halfY)*height/2];
    },
    ground(u,v,y=0) {
      const a=(2*u-1)*halfX, b=(1-2*v)*halfY;
      const point=aim.map((n,i)=>n+right[i]*a+up[i]*b);
      const shift=(y-point[1])/back[1];
      return [point[0]+back[0]*shift,point[2]+back[2]*shift];
    },
  };
}

// 射线用同一相机方向判定点击深度和实际遮挡。
export function rayBox(origin, direction, b) {
  if (b.shape==='beam') return rayBeam(origin,direction,b);
  if (b.rot) {
    origin=rotate(origin,b.rot,b.pivot,true);
    direction=rotate(direction,b.rot,undefined,true);
  } else if (b.yaw) {
    origin=rotateXZ(origin,-b.yaw,b.pivotX,b.pivotZ);
    direction=rotateXZ(direction,-b.yaw);
  }
  const lower=[b.x,b.y,b.z], upper=[b.x+b.w,b.y+b.h,b.z+b.d];
  return rayBounds(origin,direction,lower,upper);
}

function rayBounds(origin,direction,lower,upper) {
  let near=0, far=Infinity;
  for (let i=0;i<3;i+=1) {
    const o=origin[i], d=direction[i];
    if (Math.abs(d)<1e-7) {
      if (o<lower[i] || o>upper[i]) return null;
      continue;
    }
    const a=(lower[i]-o)/d, c=(upper[i]-o)/d;
    near=Math.max(near,Math.min(a,c));
    far=Math.min(far,Math.max(a,c));
    if (near>far) return null;
  }
  return near;
}

function rayBeam(origin,direction,b) {
  // Clip against the two caps and the actual polygon faces, not the enclosing box.
  const relative=origin.map((n,i)=>n-b.from[i]);
  let near=0,far=Infinity;
  const normals=[[b.unit,b.length],[b.unit.map(n=>-n),0]];
  for (let i=0;i<b.segments;i++) {
    const angle=(i+.5)*2*Math.PI/b.segments;
    const normal=b.u.map((n,j)=>n*Math.cos(angle)+b.v[j]*Math.sin(angle));
    normals.push([normal,b.r*Math.cos(Math.PI/b.segments)]);
  }
  for (const [normal,bound] of normals) {
    const left=bound-dot(relative,normal), speed=dot(direction,normal);
    if (Math.abs(speed)<1e-8) { if (left<0) return null; }
    else if (speed>0) far=Math.min(far,left/speed);
    else near=Math.max(near,left/speed);
    if (near>far) return null;
  }
  return near;
}

export function collisionFootprint(b,scale) {
  const {x,z,w,d}=b.bounds??modelBounds(b);
  const left=Math.floor(x*scale), top=Math.floor(z*scale);
  return [left,top,Math.ceil((x+w)*scale)-left,Math.ceil((z+d)*scale)-top];
}

export function coveredModels(camera, player, ...lists) {
  const covered=new Set();
  if (!player || camera.back[1]>.995) return covered;
  const {x,y,z}=player;
  const samples=[[x,y+.12,z],[x,y+.59,z],[x,y+1.11,z]];
  for (const boxes of lists) for (const b of boxes) {
    if (!b.occluder || covered.has(b.occluder) || b.fx) continue;
    const bounds=b.bounds??modelBounds(b);
    if (bounds.y+bounds.h<=y+.12 || bounds.x>x+9 || bounds.x+bounds.w<x-9 ||
        bounds.z>z+9 || bounds.z+bounds.d<z-9) continue;
    if (samples.some(origin => {
      const distance=rayBox(origin,camera.back,b);
      return distance!==null && distance>.025;
    })) covered.add(b.occluder);
  }
  return covered;
}

const QUAD_UV=[[0,0],[0,0],[0,0],[0,0]];
const noFx=()=>[0,0,0];
function quad(data,a,b,c,d,color,uv=QUAD_UV,material=noFx,normal=faceNormal(a,c,b),surface=.5) {
  const points=[a,b,c,d];
  for (const i of [0,1,2,0,2,3]) data.push(...points[i],...color,...uv[i],...material(points[i]),...normal,surface);
}

export function modelMesh(data,b) {
  if (b.shape==='beam') {
    const ring=beamRing(b), add=(p,q)=>p.map((n,i)=>n+q[i]);
    const color=rgb(b.color), finish=finishOf(b.color), lower=b.unit.map(n=>-n);
    for (let i=0;i<ring.length;i++) {
      const next=(i+1)%ring.length;
      const a=add(b.from,ring[i]), c=add(b.to,ring[i]), d=add(b.to,ring[next]), e=add(b.from,ring[next]);
      const normal=norm(ring[i].map((n,j)=>n+ring[next][j]));
      quad(data,a,e,d,c,color,QUAD_UV,noFx,normal,finish+(.76+.18*Math.cos(i*2*Math.PI/ring.length))*.5);
      for (const point of [b.from,e,a]) data.push(...point,...color,0,0,0,0,0,...lower,finish+.34);
      for (const point of [b.to,c,d]) data.push(...point,...color,0,0,0,0,0,...b.unit,finish+.5);
    }
    return;
  }
  prism(data,b);
}

function prism(data,b) {
  const { x,y,z,w,h,d,color,axis,glow,water,wind }=b;
  if (w <= 0 || d <= 0 || h < 0) return;
  const [a,bb,c,d0,A,B,C,D]=boxVertices(b);
  const material=point=>[wind ? wind.weight*(wind.rooted ? (point[1]-y)/Math.max(h,.01) : 1) : 0,
    wind?.phase??0,water?-1:Number(Boolean(glow))];
  const tint=rgb(color), finish=wind||glow?0:finishOf(color);
  const face=(a,b,c,d,shade)=>{
    quad(data,a,b,c,d,tint,QUAD_UV,material,faceNormal(a,b,c),finish+shade*.5);
  };
  quad(data,a,bb,c,d0,tint,QUAD_UV,material,faceNormal(a,c,bb),finish+.5);
  if (!axis && h===0) return;
  face(a,bb,B,A,.70); face(bb,c,C,B,.78);
  face(c,d0,D,C,.91); face(d0,a,A,D,.65);
}

function stageMesh(stage) {
  const out=[], ranges=[];
  const floors=stage.floors;
  let terrainCount=0;
  for (const f of floors) {
    if (f.triangle) {
      const {x,z,y,ax,az}=f;
      const corner=f.triangle===1 ? [x+1,y+ax,z] : [x,y+az,z+1];
      const points=[[x,y+.006,z],corner.map((v,i)=>i===1?v+.006:v),[x+1,y+ax+az+.006,z+1]];
      const shade=Math.min(1.08,Math.max(.91,1-ax*.16+az*.12));
      if (f.triangle===2) [points[1],points[2]]=[points[2],points[1]];
      const normal=faceNormal(points[0],points[2],points[1]);
      for (const point of points) out.push(...point,shade,shade,shade,point[0]/stage.width,point[2]/stage.depth,0,0,0,...normal,.5);
      terrainCount+=3;
      continue;
    }
    const slope=f.end!==f.y, elevated=f.y>0;
    prism(out,{...f,y:slope?f.y:elevated?f.y-.12:f.y,h:slope?0:elevated?.12:0,axis:slope?f.axis:undefined});
    if (!elevated && !slope) continue;
    for (let i=.3;i<f.d-.06;i+=.42) {
      const top = f.axis==='z' ? f.y+(f.end-f.y)*i/f.d : f.y;
      const end = f.axis==='x' ? f.end : top;
      prism(out,{x:f.x,y:top+.003,z:f.z+i,w:f.w,d:.025,h:0,axis:f.axis==='x'?'x':undefined,end:end+.003,color:'#976A45'});
    }
  }
  if (out.length/MODEL_STRIDE>terrainCount) ranges.push({id:null,from:terrainCount,count:out.length/MODEL_STRIDE-terrainCount});
  for (const b of stage.boxes) {
    if (b.fx) continue;
    const from=out.length/MODEL_STRIDE;
    modelMesh(out,b);
    const count=out.length/MODEL_STRIDE-from, last=ranges.at(-1);
    if (last && last.id===b.occluder) last.count+=count;
    else ranges.push({id:b.occluder,from,count});
  }
  return {mesh:new Float32Array(out),ranges,terrainCount};
}

// 呼吸感：带 fx 标记的几何不进静态网格，按共享帧号逐帧重建（独立 6fps 时钟，不读 w.t、不消费 rng）。
export function fx3d(data, list, frame) {
  if (!list || !list.length) return;
  const t = frame % 4;
  for (const b of list) {
    if (b.fx === 'banner') {
      prism(data,{...b,x:b.x+[0,.045,0,-.045][t],d:b.d+.02});
    } else if (b.fx === 'smoke') {
      // 三团逐帧上飘并散开：小、错开、越往上越淡，避免挤成一根柱子。
      for (let i=0;i<3;i+=1) {
        const k=(t+i)%4;
        prism(data,{x:b.x+[0,.16,.05,-.16][k],y:b.y+k*.3,z:b.z+k*.06,
          w:b.w*(1+k*.1),h:.13,d:b.d*(1+k*.1),
          color:['#FFF0CC','#C2C3C7','#939584','#6D7165'][k]});
      }
    } else if (b.fx === 'fire') {
      prism(data,{...b,color:t%2?'#FFA300':'#FFEC27',h:b.h*(t%2?1:.8)});
    } else if (b.fx === 'water') {
      prism(data,{...b,color:t%2?'#29ADFF':'#458996'});
    } else if (b.fx === 'nod') {
      prism(data,{...b,y:b.y-[0,.019,.036,.017][t]});
    } else prism(data,b);
  }
}

function turnBox(x,z,w,d,turn) {
  if (turn===1) return [-z-d,x,d,w];
  if (turn===2) return [-x-w,-z-d,w,d];
  if (turn===3) return [z,-x-w,d,w];
  return [x,z,w,d];
}
function animalMesh(data,animals,time) {
  for (const a of animals) {
    for (const box of animalBoxes(a,time)) modelMesh(data,box);
  }
}
export function animalBoxes(a,time) {
  const turn=a.direction??0;
  const gait=a.moving?Math.sin(time*(a.stepRate??10)+a.phase)*(a.stride??.08):0;
  const head=animalHead(a,time);
  const boxes=a.boxes.map(b=>{
    if (head && (b.fx==='head' || b.fx==='nod')) return posedAnimalHead(b,head);
    const stride=b.fx==='leg'?gait*(b.x<0?1:-1)*(b.z<0?1:-1):0;
    const nod=b.fx==='nod'?.015*Math.sin(time*3+a.phase):0;
    const [x,z,w,d]=turnBox(b.x,b.z+stride,b.w,b.d,turn);
    const flight=a.kind==='bird'?2.7+.7*Math.sin(time*1.8+a.phase):0;
    const flap=b.fx==='wing'?.095*Math.sin(time*15):0;
    return {...b,x:a.x+x,z:a.z+z,w,d,y:b.y+(a.groundY??0)+Math.max(0,stride*.4)+nod+flight+flap};
  });
  const neck=animalNeck(a,head);
  if (neck) boxes.push(neck);
  return boxes;
}
function actor(data,p,frame) { actorGeometry(p,frame,box=>prism(data,box)); }
export function actorBoxes(p,frame) {
  const boxes=[];
  actorGeometry(p,frame,box=>boxes.push(box));
  return boxes;
}
const RESIDENT_FORM = {
  infant: {height:.73, radius:.26, stride:0},
  child: {height:.56+(1.45-.88)*.81, radius:.27, stride:.15},
  adult: {height:1.45, radius:CAMP_BODY_RADIUS, stride:.15},
  elder: {height:.44+(1.45-.44)*.87, radius:CAMP_BODY_RADIUS, stride:.09},
};
const residentForm = stage => RESIDENT_FORM[stage] ?? RESIDENT_FORM.adult;
export const actorLabelHeight = stage => residentForm(stage).height+.09;
export const residentCollisionRadius = stage => residentForm(stage).radius;

function infantGeometry(draw,{shirt,face,hair,trim,style},rock,injury) {
  // 襁褓落地，脸与发梢跟着上身轻摆。
  draw(-.188,0,-.155,.376,.09,.31,'#A28A6E');
  draw(-.21,.065,-.165,.42,.28,.34,shirt);
  draw(-.166,.29,-.125,.332,.17,.27,trim);
  draw(-.206,.20,.173,.41,.085,.027,shirt);
  draw(-.13,.285,.181,.26,.045,.023,shirt);
  draw(-.151+rock,.435,-.121,.302,.236,.26,face);
  draw(-.135+rock,.639,-.121,.27,.065,.21,hair);
  const curl=style==='part'?-.072:style==='tie'?.021:-.043;
  draw(curl+rock,.677,-.022,.09,.043,.11,hair);
  for (const dx of [-.083,.054]) draw(dx+rock,.56,.141,.032,injury?.018:.039,.016,'#18251E');
  draw(-.027+rock,.499,.142,.054,.023,.016,'#AB6B56');
  if (injury) draw(-.13+rock,.605,.14,.135,.042,.017,'#F2E0BE');
}

function actorGeometry(p,frame,emit) {
  const {x,y,z}=p, t=frame%4, form=residentForm(p.stage);
  const injury=p.injury, guarding=injury && !p.pose && !p.stroke;
  const lowered=guarding ? (injury==='critical'?.15:.068) : 0;
  const gait=p.moving ? [0,form.stride,0,-form.stride][t]*(guarding?.58:1) : 0;
  const turn=Math.max(0,WALK_DIRECTIONS.indexOf(p.direction));
  const child=p.stage==='child', elder=p.stage==='elder';
  const look=p.look??residentLook(p);
  const {feminine,hair,face,shirt,trim,coat,style}=look;
  const receiptAction=p.settledWork && /^(build|plan|repair|gather|plant|harvest|forage|camp_chop|camp_plant|camp_collect|camp_water|house_work)$/.test(p.act);
  const act=receiptAction?'idle':String(p.act??'idle');
  const build=/^(build|plan|repair|work|till)$/.test(act);
  const gather=/^(gather|harvest|plant|forage|collect)$/.test(act);
  const talk=/^(talk|hail|say|companion)$/.test(act);
  const food=/^(eat|food|trade|buy|take_shared)$/.test(act);
  const rest=/^(idle|rest|seclude|deafen|rej|refuse|look_out)$/.test(act);
  const lift=build||talk||food||act==='push', bend=p.stroke?p.stroke.crouch*.65:gather?.13:0;
  const bob=!guarding && !p.stroke && rest?[0,.02,0,-.02][t]:0, swing=[0,.17,0,-.17][t];
  const draw=(dx,dy,dz,w,h,d,color)=>{
    if (child) {
      const head=dy>=.90, horizontal=head?.9:.72;
      dx*=horizontal; dz*=horizontal; w*=horizontal; d*=horizontal;
      dy=head?.56+(dy-.88)*.81:dy*.63;
      h*=head?.81:.63;
    } else if (elder && dy>=.44) {
      dz+=(dy-.44)*.17;
      dy=.44+(dy-.44)*.87;
      h*=.87;
    }
    if (p.pose==='sleep') {
      emit({x:x-dy-h+.74,y:y+dz+.23,z:z+dx,w:h,h:d,d:w,color});
      return;
    }
    if (p.pose==='sit') {
      dy=dy<.44?dy*.62:dy-.16;
      if (dy<.3) { h*=.66; dz+=.16; }
    }
    const waist=child?.255:.4;
    if (dy>waist) {
      dz+=bend;
      dy-=(p.stroke?.crouch??0)+lowered;
      if (guarding) {
        const lean=Math.max(0,dy-waist);
        dz+=lean*.19;
        dx+=lean*.11;
      }
    } else if (dy===0 && h>.25) {
      h-=lowered+(p.stroke?.crouch??0);
    }
    if (turn % 2) {
      emit({x:x+dx,y:y+dy+bob,z:z+dz,w,h,d,color,yaw:turn*Math.PI/4,pivotX:x,pivotZ:z});
    } else {
      const [px,pz,pw,pd]=turnBox(dx,dz,w,d,turn/2);
      emit({x:x+px,y:y+dy+bob,z:z+pz,w:pw,h,d:pd,color});
    }
  };
  if (p.stage==='infant') {
    infantGeometry(draw,look,[0,.022,0,-.022][t],injury);
    return;
  }
  if (!p.pose) draw(-.27,.004,-.20,.54,0,.45,'#72513B');
  draw(-.20,0,-.12+gait,.15,.46,.25,'#324D59');
  draw(.04,0,-.12-gait*(guarding?.35:1)+(guarding&&injury==='critical'?.12:0),.15,.46,.25,'#324D59');
  draw(-.23,.44,-.155,.46,.2,.31,feminine?'#735649':'#43545A');
  draw(feminine?-.195:-.23,.63,-.16,feminine?.39:.46,.3,.32,shirt);
  draw(-.08,.78,.161,.16,.1,.025,'#D8B27C');
  draw(-.23,.6,-.17,.46,.045,.34,'#493F37');
  if (child) {
    // A child's tunic uses a low bib and visible shoulder ties.
    draw(-.138,.64,.163,.276,.16,.028,trim);
    for (const offset of [-.148,.097]) draw(offset,.78,.157,.05,.13,.03,trim);
  } else if (elder) {
    draw(-.255,.814,-.146,.51,.102,.338,trim);
    draw(-.227,.743,.145,.132,.105,.045,trim);
    draw(.095,.743,.145,.132,.105,.045,trim);
    draw(-.192,.69,.168,.079,.16,.027,trim);
    draw(.113,.754,.168,.073,.095,.027,'#93805A');
  } else if (coat==='jacket') {
    draw(-.222,.475,.094,.208,.165,.078,shirt);
    draw(.014,.475,.094,.208,.165,.078,shirt);
    draw(-.022,.64,.163,.046,.19,.028,trim);
    for (const y of [.677,.753]) draw(.026,y,.171,.03,.027,.018,'#C7AC76');
  } else if (coat==='vest') {
    for (const offset of [-.187,.107]) draw(offset,.645,.163,.074,.243,.032,trim);
    draw(.064,.681,.197,.108,.079,.022,'#655746');
  } else {
    draw(-.172,.842,-.154,.344,.073,.353,trim);
    draw(.087,.744,.174,.066,.124,.041,trim);
    draw(.112,.711,.171,.052,.043,.034,trim);
  }
  if (injury) {
    draw(.096,.743,.197,.109,.048,.018,'#EBD9B5');
    draw(.132,.728,.216,.029,.075,.014,'#BFAD8D');
  }
  if (p.who==='p1' && !p.pose && !p.portrait) {
    for (const [dx,dy,dz,w,h,d,c] of itemBoxes('backpack'))
      draw(-.35+dx*.70,.39+dy*.67,-.22-dz*.27-d*.27,w*.70,h*.67,d*.27,c);
    for (const x of [-.15,.11]) draw(x,.66,.16,.045,.25,.027,'#4F5842');
  }
  const ay=lift?.78:.44, ah=lift?.44:.38;
  if (p.stroke) {
    for (const box of p.stroke.body) emit(box);
  } else if (guarding) {
    // One forearm crosses the ribs; the other hangs low to balance the shortened step.
    draw(-.295,.565,-.086,.105,.27,.19,shirt);
    draw(-.234,.603,.101,.294,.105,.111,face);
    draw(.201,.459,-.053,.092,.32,.174,face);
  } else {
    draw(-.30,ay+(build?swing:0),-.12-gait,.1,ah,.24,'#D58274');
    draw(.20,ay+(build?-swing:0),-.12+gait,.1,ah,.24,'#D58274');
    const tool=p.tool && p.tool!=='hand'?p.tool:build?'hammer':gather?'basket':null;
    if (!p.pose && tool) for (const [dx,dy,dz,w,h,d,c] of itemBoxes(tool))
      draw(.15+dx*.53,ay+dy*.53+(build?swing:0)-.04,.09+dz*.44,w*.53,h*.53,d*.44,c);
    if(food) for (const [dx,dy,dz,w,h,d,c] of itemBoxes('fruit'))
      draw(.16+dx*.31,ay+ah*.6+dy*.31,.02+dz*.31,w*.31,h*.31,d*.31,c);
  }
  draw(-.22,.92,-.17+(talk?swing*.2:0),.44,.37,.34,face);
  draw(-.247,1.236,-.204,.494,style==='crop'?.181:.214,.402,hair);
  draw(-.239,1.109,-.185,.478,style==='crop'?.137:.165,.091,hair);
  if (style==='part') {
    draw(-.232,1.167,.153,.145,.135,.067,hair);
    draw(-.112,1.215,.18,.26,.075,.039,hair);
  } else if (style==='bun') {
    draw(.115,1.188,-.299,.205,.214,.197,hair);
    draw(.18,1.107,-.112,.073,.17,.233,hair);
  } else if (style==='tie') {
    draw(-.248,1.059,-.12,.071,.21,.247,hair);
    draw(.098,.916,-.259,.144,.348,.151,hair);
    draw(.113,.995,-.268,.128,.045,.021,trim);
  } else {
    draw(-.216,1.193,.153,.315,.064,.055,hair);
  }
  if (elder) {
    for (const dx of [-.151,.104]) {
      draw(dx,1.093,.188,.048,.014,.014,'#946F59');
      draw(dx,1.178,.171,.053,.021,.016,hair);
    }
  }
  for (const offset of [-.14,.09]) draw(offset,1.105,.173,.05,injury?.039:.065,.024,'#18251E');
  draw(-.038,1.045,.176,.076,.036,.024,'#AB6B56');
}

const VERTEX = `
  attribute vec3 aPosition;
  attribute vec3 aColor;
  attribute vec2 aUV;
  attribute vec3 aMaterial;
  attribute vec4 aNormal;
  uniform mat4 uView, uProjection;
  uniform mediump vec4 uWeather;
  uniform bool uRegionTexture;
  uniform mediump vec4 uSunRay;
  uniform mediump vec3 uLight;
  uniform mediump float uSunStrength;
  varying vec3 vColor;
  varying vec2 vUV;
  #ifdef GL_FRAGMENT_PRECISION_HIGH
    varying highp vec2 vWorld;
  #else
    varying mediump vec2 vWorld;
  #endif
  varying float vGlow, vHeight, vRoad, vBank;
  varying mediump vec3 vPhysical;
  varying mediump float vFinish, vUp;

  float rockHash(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
  float rockNoise(vec2 p){
    vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
    return mix(mix(rockHash(i),rockHash(i+vec2(1,0)),f.x),
               mix(rockHash(i+vec2(0,1)),rockHash(i+vec2(1,1)),f.x),f.y);
  }
void main(){
    float phase=uWeather.x*2.1+aMaterial.y;
    vec3 point=aPosition;
    float wind=uRegionTexture?0.:aMaterial.x;
    point.x+=sin(phase)*wind*uWeather.y;
    point.z+=sin(phase*.72+.8)*wind*uWeather.y*.43;
    gl_Position=uProjection*uView*vec4(point,1.);
    vGlow=aMaterial.z; vHeight=point.y; vRoad=aMaterial.x; vBank=aMaterial.y;
    float diffuse=max(0.,dot(aNormal.xyz,uSunRay.xyz));
    vPhysical=uLight*(.78+.14*max(0.,aNormal.y)+diffuse*uSunRay.w*.55)+vec3(.22,.09,.035)*uSunStrength*diffuse;
    vFinish=aNormal.w; vUp=aNormal.y;
    vColor=aColor; vUV=aUV; vWorld=aPosition.xz;
  }
`;
const FRAGMENT = `
  precision mediump float;
  uniform sampler2D uGround, uFog, uWater, uGrain;
  uniform vec4 uFogBounds;
  uniform bool uTexture, uVisibility, uHasWater;
  uniform vec3 uSight;
  uniform vec3 uViewDirection;
  uniform mediump vec4 uSunRay;
  uniform vec4 uHearth;
uniform float uExposure;
uniform vec4 uWindowA, uWindowB;
uniform vec4 uExteriorWindows[8];
uniform int uExteriorWindowCount;
uniform float uDaylight;
uniform bool uInterior;
  uniform mediump vec4 uWeather;
  uniform float uSeason;
  uniform float uWetness;
  uniform vec4 uShelters[4];
  uniform int uShelterCount;
  uniform mediump vec3 uLight;
  uniform mediump float uSunStrength;
  uniform bool uPhysical, uShadow;
  uniform float uAlpha;
  varying vec3 vColor;
  varying vec2 vUV;
  #ifdef GL_FRAGMENT_PRECISION_HIGH
    varying highp vec2 vWorld;
  #else
    varying mediump vec2 vWorld;
  #endif
  varying float vGlow, vHeight, vRoad, vBank;
  varying mediump vec3 vPhysical;
  varying mediump float vFinish, vUp;
  uniform bool uWild, uRegionTexture;
  // Room at Dawn 式窗光（2026-11-15）：以窗为源，向屋内与远离窗宽衰减；强度乘 uDaylight，
// 所以白天有、夜里归零——这就是"白天因子"，不需要把光静态烘进几何。
// 参数：w = (窗中心x, 窗所在z, 半窗宽, 未用)；p = 世界 xz；h = 高度。
float windowPool(vec4 w, vec2 p, float h){
  if (w.z <= 0.) return 0.;
  float forward=p.y-w.y;
  float lat=1.-smoothstep(w.z*.75,w.z+.23*max(0.,forward),abs(p.x-w.x));
  float deep=smoothstep(.025,.24,forward)*(1.-smoothstep(2.35,5.7,forward));
  float high=1.-smoothstep(1.02,2.05,h);
  return lat*deep*high;
}

float exteriorWindowPool(vec4 window, vec2 point, float elevation) {
  vec2 fromWindow=point-window.xy;
  float forward=fromWindow.y;
  float width=window.z+max(0.,forward)*.36;
  float side=1.-smoothstep(width*.58,width+.18,abs(fromWindow.x));
  float depth=smoothstep(.05,.52,forward)*(1.-smoothstep(.65,2.8,forward));
  float low=1.-smoothstep(window.w*.65,window.w+.20,elevation);
  return side*depth*low;
}


  void main(){
    vec3 color=uTexture ? texture2D(uGround,vUV).rgb*vColor : vColor;
    if (uRegionTexture && vUV.y>=0.) {
      vec2 pixel=floor(vWorld*32.);
      float fleck=fract(sin(dot(mod(pixel,257.),vec2(.93,1.71)))*105.7);
      vec2 texel=(vUV*32.+floor(fract(vWorld)*32.)+.5)/vec2(128.,128.);
      color=texture2D(uGround,texel).rgb*vColor;
      if (vUV.y<1.5) {
        vec2 dirt=vec2(texel.x,texel.y+(1.-vUV.y)*.25);
        vec2 grass=vec2(texel.x,texel.y-vUV.y*.25);
        color=texture2D(uGround,grass).rgb*vColor;
        if (vRoad>1.52+fleck*.23) {
          color=mix(texture2D(uGround,dirt).rgb,vec3(.85,.67,.40),.35)*vColor;
        }
        float shore=.30+fleck*.20;
        if (vBank<shore) {
          vec3 sand=mix(vec3(.73,.72,.63),vec3(.93,.78,.53),step(.30,fleck));
          vec3 damp=mix(vec3(.33,.23,.17),vec3(.49,.36,.24),fleck);
          color=mix(damp,sand,smoothstep(.03,.33,vBank))*vColor;
        } else if (vBank<shore+.13 && fleck<.38) {
          color=mix(color,vec3(.73,.72,.63)*vColor,.62);
        }
      }
    }
    bool river=uRegionTexture && vGlow<-.5 && vGlow>-1.5 && vUV.y<0.;
    bool basin=!uRegionTexture && vGlow<-.5 && vGlow>-1.5;
    float water=(river||basin)?1.:(uTexture && uHasWater ? texture2D(uWater,vUV).r : 0.);
    if (river) {
      vec2 pixel=floor(vWorld*32.);
      vec2 sampleAt=(mod(pixel+vec2(0.,-floor(uWeather.x*5.)),32.)+.5)/128.;
      vec3 deep=texture2D(uGround,sampleAt+vec2(0.,.75)).rgb;
      float shore=1.-smoothstep(.03,.41,vBank);
      float fleck=fract(sin(dot(mod(pixel,257.),vec2(1.7,2.9)))*87.3);
      vec3 shallow=mix(vec3(.27,.54,.59),vec3(.52,.70,.70),step(.79,fleck));
      color=mix(deep,shallow,shore*.84);
    }
    bool green=color.g>color.r*1.12 && color.g>color.b*1.10;
    if (green && water<.5) {
      if (uSeason==1.) color*=vec3(1.08,1.03,.93);
      if (uSeason==2.) color=mix(color,vec3(.64,.38,.15)*(.6+color.g*.7),.61);
      if (uSeason==3.) color=mix(color,vec3(.71,.79,.81),(uTexture || uRegionTexture)?.68:.37);
    }
    if (uWeather.z>.5 && water<.5 && !uShadow && vGlow<=0.) {
      // Cold-snap rime clings to exposed surfaces. Break up the edge at pixel scale.
      vec2 pixel=floor(vec2(vWorld.x+vHeight*.37,vWorld.y-vHeight*.57)*18.);
      float crystal=fract(sin(dot(mod(pixel,113.),vec2(.93,1.27)))*207.1);
      float patch=sin(vWorld.x*4.5+sin(vWorld.y*6.4)+vHeight*4.1);
      float crust=smoothstep(.19,.71,crystal+patch*.23)*(.19+.46*max(0.,vUp));
      float grain=step(.93,crystal)*.22;
      color=mix(color,mix(vec3(.65,.77,.81),vec3(.88,.93,.90),crystal),crust+grain);
    }
    if (water>.5) {
      float flow=sin(vWorld.y*15.-uWeather.x*5.+sin(vWorld.x*9.)*1.4);
      float ripple=smoothstep(.78,1.,flow)*(.55+.45*sin(vWorld.x*17.+vWorld.y*2.));
      color+=vec3(.075,.15,.17)*ripple;
    }
    if (uWild && vGlow<-1.5) {
      float phase=vHeight*.83+uWeather.x*6.;
      float foam=smoothstep(.72,1.,sin(phase+sin(vWorld.x*14.)*.6));
      color+=foam*vec3(.085,.13,.14);
    }
    float shade=1.;
    if (uSight.z>0.) {
      float radius=uSight.z;
      float radial=1.-smoothstep(radius-1.6,radius+.45,distance(vWorld,uSight.xy));
      vec2 local=(vWorld-uFogBounds.xy)/uFogBounds.zw;
      bool known=uVisibility && all(greaterThanEqual(local,vec2(0.))) && all(lessThan(local,vec2(1.)));
      shade=(known?texture2D(uFog,local).r:0.)*radial;
    }
    if (uShadow) {
      gl_FragColor=vec4(.105,.135,.12,vColor.r);
      return;
    }
    vec3 sunlight=vec3(.27,.123,.046)*uSunStrength;
    float baked=fract(vFinish)*2.;
    float finish=floor(vFinish);
    if (uPhysical && finish>0. && !uTexture && !uRegionTexture) {
      vec2 grain=vec2(vWorld.x+vWorld.y*.53,vHeight+vWorld.y*.73);
      float row=finish>1.5?.5:0.;
      float tone=texture2D(uGrain,vec2(fract(grain.x*.82),fract(grain.y*1.21)*.48+.01+row)).r;
      color*=mix(.87,1.12,tone);
    }
    vec3 lit=color*(uPhysical?vPhysical:(uLight+sunlight)*baked);
    float shelter=0.;
    if (vHeight<2.35) for (int i=0;i<4;i++) {
      if (i>=uShelterCount) break;
      vec4 roof=uShelters[i];
      vec2 edge=min(vWorld-roof.xy,roof.xy+roof.zw-vWorld);
      shelter=max(shelter,smoothstep(-.05,.19,min(edge.x,edge.y)));
    }
    lit*=1.-shelter*.27;
    float hardGround=uTexture || uRegionTexture || finish>0. || (color.r<color.g*1.2 && color.b>color.g*.7) ? 1. : .22;
    float wet=water<.5 ? uWetness*hardGround*(1.-shelter*.92)*(.26+.74*max(0.,vUp)) : 0.;
    lit*=1.-wet*.26;
    vec2 wetCell=floor(vWorld*8.);
      float rivulet=smoothstep(.86,.97,fract(sin(dot(wetCell,vec2(127.1,311.7)))*43758.5453));
    lit+=vec3(.065,.099,.107)*wet*rivulet*vUp*vUp;
    if (water>.5) {
      vec3 reflected=reflect(-uSunRay.xyz,vec3(0.,1.,0.));
      float glint=pow(max(0.,dot(reflected,uViewDirection)),5.);
      lit+=vec3(.20,.105,.037)*uSunStrength*(.20+.80*glint);
      if (basin) lit+=vec3(.024,.044,.048)*max(0.,vUp);
    }
    vec3 amber=mix(vec3(.65,.27,.08),vec3(1.,.68,.34),clamp(color.g+color.b*.6,0.,1.));
    float fire=uHearth.w*(1.-smoothstep(.15,3.7,distance(vWorld,uHearth.xy)));
    lit+=vec3(.31,.145,.048)*fire;
    // Harrowfield 式加法假体积光（2026-11-15）：核心火光之外再叠一层更宽、随高度衰减的光晕，
    // 让它读成"空气里的光"而不是贴地的一个亮圆。强度与闪烁共用 uHearth.w，所以会一起呼吸。
    float halo=uHearth.w*(1.-smoothstep(1.,7.2,distance(vWorld,uHearth.xy)))*max(0.,1.-abs(vWorld.y-.75)/2.4);
    lit+=vec3(.17,.08,.03)*halo;
    if (uInterior && uDaylight > .01) {
      float pool=windowPool(uWindowA,vWorld,vHeight)+windowPool(uWindowB,vWorld,vHeight);
      lit+=vec3(.46,.33,.19)*pool*uDaylight;
    }
    if (uExteriorWindowCount>0) {
      float spill=0.;
      for (int i=0;i<8;i++) {
        if (i>=uExteriorWindowCount) break;
        spill=max(spill,exteriorWindowPool(uExteriorWindows[i],vWorld,vHeight));
      }
      lit+=vec3(.23,.115,.038)*spill*smoothstep(.57,.9,uWeather.w);
    }
    if (uWild) {
      float mist=smoothstep(2.,25.,-vHeight);
      float drift=.92+.08*sin(vWorld.x*.13+vWorld.y*.11+uWeather.x*.2);
      lit=mix(lit,vec3(.38,.48,.51),mist*drift*.79);
    }
    vec3 sceneColor=mix(lit,amber,max(0.,vGlow)*uWeather.w)*uExposure;
    // The perception layer mutes detail without becoming a moving light.
    float luma=dot(sceneColor,vec3(.2126,.7152,.0722));
    vec3 muted=mix(vec3(luma),sceneColor,.52);
    gl_FragColor=vec4(mix(sceneColor,muted,1.-shade),uAlpha);
  }
`;

function terrainWithNormals(mesh) {
  const data=new Float32Array(mesh.length/11*MODEL_STRIDE);
  for (let i=0,j=0;i<mesh.length;i+=33,j+=MODEL_STRIDE*3) {
    const normal=faceNormal(mesh.subarray(i,i+3),mesh.subarray(i+11,i+14),mesh.subarray(i+22,i+25));
    if (mesh[i+10]>=-1.5 && normal[1]<0) for(let k=0;k<3;k++) normal[k]*=-1;
    for(let k=0;k<3;k++){
      const target=j+k*MODEL_STRIDE, source=i+k*11;
      data.set(mesh.subarray(source,source+11),target);
      data.set(normal,target+11);
      data[target+14]=.5;
    }
  }
  return data;
}

export function regionOnScreen(bounds,camera,width,height) {
  if (!bounds) return true;
  const [x,y,z,X,Y,Z]=bounds;
  let left=Infinity,top=Infinity,right=-Infinity,bottom=-Infinity;
  for (const px of [x,X]) for (const py of [y,Y]) for (const pz of [z,Z]) {
    const [u,v]=camera.project(px,py,pz);
    left=Math.min(left,u);right=Math.max(right,u);top=Math.min(top,v);bottom=Math.max(bottom,v);
  }
  return right>=0 && bottom>=0 && left<=width && top<=height;
}


const POST_VERTEX=`
attribute vec2 aPosition;
varying vec2 vUV;
void main(){ vUV=aPosition*.5+.5; gl_Position=vec4(aPosition,0.,1.); }
`;
const POST_FRAGMENT=`
precision highp float;
varying vec2 vUV;
uniform sampler2D uScene;
uniform vec2 uResolution;
float postHash(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
vec3 aces(vec3 x){ return clamp((x*(2.51*x+.03))/(x*(2.43*x+.59)+.14),0.,1.); }
void main(){
  vec3 c=texture2D(uScene,vUV).rgb;
  vec3 bloom=vec3(0.);
  float r=4.0/uResolution.y;
  for(int i=0;i<8;i++){
    float a=float(i)*0.785398;
    vec2 o=vec2(cos(a),sin(a))*r*(1.0+float(i)*0.55);
    bloom+=max(texture2D(uScene,vUV+o).rgb-vec3(0.58),0.0);
  }
  bloom/=8.0;
  c+=bloom*vec3(0.62,0.48,0.30)*0.55;
  c*=1.12;
  c=aces(c);
  float l=dot(c,vec3(.2126,.7152,.0722));
  c=mix(c*vec3(.90,1.0,1.08),c*vec3(1.07,1.0,.91),smoothstep(.32,.78,l));
  vec2 q=vUV-.5;
  float vig=1.0-smoothstep(.42,.86,length(q))*0.34;
  c*=vig;
  c+=(postHash(gl_FragCoord.xy)-.5)*.016;
  gl_FragColor=vec4(clamp(c,0.,1.),1.);
}
`;

export function createCampRenderer() {
  const canvas=document.createElement('canvas');
  const gl=canvas.getContext('webgl',{alpha:false,antialias:false,depth:true});
  if (!gl) return null;
  function shader(type,src) {
    const s=gl.createShader(type);
    gl.shaderSource(s,src); gl.compileShader(s);
    if (!gl.getShaderParameter(s,gl.COMPILE_STATUS)) throw Error(gl.getShaderInfoLog(s));
    return s;
  }
  const p=gl.createProgram(), vs=shader(gl.VERTEX_SHADER,VERTEX), fs=shader(gl.FRAGMENT_SHADER,FRAGMENT);
  gl.attachShader(p,vs);gl.attachShader(p,fs);gl.linkProgram(p);
  gl.deleteShader(vs);gl.deleteShader(fs);
  if (!gl.getProgramParameter(p,gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(p));
  const aPos=gl.getAttribLocation(p,'aPosition'),aColor=gl.getAttribLocation(p,'aColor'),aUV=gl.getAttribLocation(p,'aUV');
  const aNormal=gl.getAttribLocation(p,'aNormal');
  const aMaterial=gl.getAttribLocation(p,'aMaterial');
  const uniform=Object.fromEntries(['SunStrength','SunRay','ViewDirection','Grain','Physical','Shadow','RegionTexture','Wild','Water','HasWater','Sight','Hearth','Exposure','WindowA','WindowB','ExteriorWindows[0]','ExteriorWindowCount','Daylight','Interior','Season','Wetness','Shelters[0]','ShelterCount','Weather','View','Projection','Ground','Fog','FogBounds','Texture','Visibility','Light','Alpha'].map(k=>[k,gl.getUniformLocation(p,'u'+k)]));
  
    const postProgram=gl.createProgram();
    {
      const pv=shader(gl.VERTEX_SHADER,POST_VERTEX), pf=shader(gl.FRAGMENT_SHADER,POST_FRAGMENT);
      gl.attachShader(postProgram,pv);gl.attachShader(postProgram,pf);gl.linkProgram(postProgram);
      gl.deleteShader(pv);gl.deleteShader(pf);
      if(!gl.getProgramParameter(postProgram,gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(postProgram));
    }
    const postPos=gl.getAttribLocation(postProgram,'aPosition');
    const postScene=gl.getUniformLocation(postProgram,'uScene');
    const postRes=gl.getUniformLocation(postProgram,'uResolution');
    const postBuffer=gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER,postBuffer);
    gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),gl.STATIC_DRAW);
    let sceneFbo=null,sceneTex=null,sceneDepth=null,fboSize='';
    function ensureSceneTarget(width,height){
      const size=width+'x'+height;
      if(sceneFbo && fboSize===size) return true;
      if(sceneFbo) gl.deleteFramebuffer(sceneFbo);
      if(sceneTex) gl.deleteTexture(sceneTex);
      if(sceneDepth) gl.deleteRenderbuffer(sceneDepth);
      sceneFbo=gl.createFramebuffer();sceneTex=gl.createTexture();sceneDepth=gl.createRenderbuffer();
      gl.bindTexture(gl.TEXTURE_2D,sceneTex);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,width,height,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
      gl.bindRenderbuffer(gl.RENDERBUFFER,sceneDepth);
      gl.renderbufferStorage(gl.RENDERBUFFER,gl.DEPTH_COMPONENT16,width,height);
      gl.bindFramebuffer(gl.FRAMEBUFFER,sceneFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,sceneTex,0);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER,gl.DEPTH_ATTACHMENT,gl.RENDERBUFFER,sceneDepth);
      const ok=gl.checkFramebufferStatus(gl.FRAMEBUFFER)===gl.FRAMEBUFFER_COMPLETE;
      gl.bindFramebuffer(gl.FRAMEBUFFER,null);
      if(!ok){ gl.deleteFramebuffer(sceneFbo);gl.deleteTexture(sceneTex);gl.deleteRenderbuffer(sceneDepth);sceneFbo=sceneTex=sceneDepth=null;fboSize='';return false; }
      fboSize=size;
      return true;
    }

    gl.useProgram(p);gl.enable(gl.DEPTH_TEST);
  for (const a of [aPos,aColor,aUV,aMaterial,aNormal]) gl.enableVertexAttribArray(a);
  const stages=new WeakMap(), groundBuffer=gl.createBuffer(), movingBuffer=gl.createBuffer(), shadowBuffer=gl.createBuffer();
  const createTexture=(unit)=>{
    const t=gl.createTexture();
    gl.activeTexture(unit);gl.bindTexture(gl.TEXTURE_2D,t);
    for(const [key,value] of [[gl.TEXTURE_MIN_FILTER,gl.NEAREST],[gl.TEXTURE_MAG_FILTER,gl.NEAREST],
      [gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE],[gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D,key,value);
    return t;
  };
  const blank=createTexture(gl.TEXTURE0), fog=createTexture(gl.TEXTURE1), water=createTexture(gl.TEXTURE2);
  gl.activeTexture(gl.TEXTURE1);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
  gl.activeTexture(gl.TEXTURE2);
  gl.texImage2D(gl.TEXTURE_2D,0,gl.LUMINANCE,1,1,0,gl.LUMINANCE,gl.UNSIGNED_BYTE,new Uint8Array(1));
  createTexture(gl.TEXTURE3);
  const grain=materialGrain();
  gl.texImage2D(gl.TEXTURE_2D,0,gl.LUMINANCE,64,64,0,gl.LUMINANCE,gl.UNSIGNED_BYTE,grain);
  gl.uniform1i(uniform.Grain,3);
  gl.uniform1i(uniform.Water,2);
  gl.uniform1i(uniform.Ground,0);gl.uniform1i(uniform.Fog,1);
  // 两个采样器始终绑定完整纹理，室内和全景也能正常绘制。
  gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,blank);
  gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array([255,255,255,255]));
  gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,fog);
  gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array([255,255,255,255]));
  const terrainTextures=new Map(), maxTexture=gl.getParameter(gl.MAX_TEXTURE_SIZE);
  let groundSize='', visibilityImage=null, waterImage=null;
  const groundContactBuffer=gl.createBuffer();
  let shadowData=null, contactData=null;
  function terrainTexture(source) {
    let texture=terrainTextures.get(source);
    if (texture) {
      terrainTextures.delete(source);
      terrainTextures.set(source,texture);
      return texture;
    }
    texture=createTexture(gl.TEXTURE0);
    let image=source;
    const scale=Math.min(1,maxTexture/Math.max(source.width,source.height));
    if (scale<1) {
      image=document.createElement('canvas');
      image.width=Math.floor(source.width*scale);image.height=Math.floor(source.height*scale);
      const g=image.getContext('2d');
      g.imageSmoothingEnabled=false;g.drawImage(source,0,0,image.width,image.height);
    }
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,image);
    terrainTextures.set(source,texture);
    if(terrainTextures.size>4) {
      const old=terrainTextures.keys().next().value;
      gl.deleteTexture(terrainTextures.get(old));terrainTextures.delete(old);
    }
    return texture;
  }
  let lost=false;
  canvas.addEventListener('webglcontextlost',event=>{ event.preventDefault(); lost=true; });
  function bind(buffer) {
    gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
    gl.vertexAttribPointer(aPos,3,gl.FLOAT,false,MODEL_STRIDE*4,0);
    gl.vertexAttribPointer(aColor,3,gl.FLOAT,false,MODEL_STRIDE*4,12);
    gl.vertexAttribPointer(aUV,2,gl.FLOAT,false,MODEL_STRIDE*4,24);
    gl.vertexAttribPointer(aMaterial,3,gl.FLOAT,false,MODEL_STRIDE*4,32);
    gl.vertexAttribPointer(aNormal,4,gl.FLOAT,false,MODEL_STRIDE*4,44);
  }
  function paint(buffer,count,textured,from=0) {
    bind(buffer);gl.uniform1i(uniform.Texture,Number(textured));gl.drawArrays(gl.TRIANGLES,from,count);
  }
  // 仅保留当前几种场景的缓冲，地图/对照切换时释放长期不用的资源。
  const lru=[], workMeshes=new WeakMap();
  function stageBuffer(stage, limit) {
    if (stages.has(stage)) {
      const index=lru.indexOf(stage);
      lru.splice(index,1);
      lru.push(stage);
      return stages.get(stage);
    }
    const b=gl.createBuffer();
    const {mesh,ranges,terrainCount}=stage.mesh ? {mesh:terrainWithNormals(stage.mesh),ranges:[],terrainCount:0} : stageMesh(stage);
    bind(b);gl.bufferData(gl.ARRAY_BUFFER,mesh,gl.STATIC_DRAW);
    const item={ b,count:mesh.length/MODEL_STRIDE,ranges,terrainCount };
    stages.set(stage,item);
    lru.push(stage);
    while(lru.length>limit){
      const old=lru.shift();
      gl.deleteBuffer(stages.get(old).b);
      stages.delete(old);
    }
    return item;
  }
  function paintStage({b,count,ranges,terrainCount}, covered, faded, terrain=false) {
    if (terrainCount) paint(b,terrainCount,terrain);
    let from=terrainCount;
    for (const r of ranges) {
      if (!covered.has(r.id) || !/^(roof|room-roof):/.test(r.id)) continue;
      if (from<r.from) paint(b,r.from-from,false,from);
      faded.push({b,...r});
      from=r.from+r.count;
    }
    if (from<count) paint(b,count-from,false,from);
  }
  function paintFaded(ranges) {
    if (!ranges.length) return;
    // 先保留最近的表面，再混合一次，避免同一屋顶的各层累积成不透明。
    gl.colorMask(false,false,false,false);
    for (const r of ranges) paint(r.b,r.count,false,r.from);
    gl.colorMask(true,true,true,true);
    gl.depthFunc(gl.EQUAL);
    gl.depthMask(false);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform1f(uniform.Alpha,.28);
    for (const r of ranges) paint(r.b,r.count,false,r.from);
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    gl.depthFunc(gl.LESS);
  }
  return {
    render({ target,stage,regions,regionAtlas,life,homes,terrain,camera,people,work=[],impacts=[],covered=new Set(),frame,light,sun,visibility,animals=[],hearth=[0,0,0,0],sight=[0,0,0],waterMask,season=-1,weather=[0,0,0,0], physical=true, shadows, wetness=0, shelters=[], animateParts=true, exposure=1, windows=null, daylight=0, interior=false }) {
      if (lost || gl.isContextLost()) return false;
      const width=target.width,height=target.height;
      if(canvas.width!==width || canvas.height!==height) {canvas.width=width;canvas.height=height;}
      gl.viewport(0,0,width,height);
      gl.clearColor(.10*light[0],.145*light[1],.119*light[2],1);
      gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
      gl.uniformMatrix4fv(uniform.View,false,camera.view);
      gl.uniformMatrix4fv(uniform.Projection,false,camera.projection);
      gl.uniform3fv(uniform.Light,light);
      gl.uniform1f(uniform.SunStrength,sun?.strength??0);
      gl.uniform3fv(uniform.ViewDirection,camera.back);
      gl.uniform4fv(uniform.SunRay,sun?[...sun.sunVector,sun.direct]:[0,1,0,0]);
      gl.uniform1i(uniform.Physical,Number(physical));
      gl.uniform1i(uniform.Shadow,0);
      gl.uniform3fv(uniform.Sight,sight);
      gl.uniform4fv(uniform.Hearth,hearth);
gl.uniform1f(uniform.Exposure,exposure);
gl.uniform4fv(uniform.WindowA,windows?.[0]??[0,0,0,0]);
gl.uniform4fv(uniform.WindowB,windows?.[1]??[0,0,0,0]);
      const exteriorWindows=weather[3]>.57 && homes?.windows?.length
        ? homes.windows.map(window=>({window,distance:Math.hypot(window[0]-camera.focus[0],window[1]-camera.focus[1])}))
          .sort((a,b)=>a.distance-b.distance).slice(0,8).flatMap(({window})=>window)
        : [];
      gl.uniform1i(uniform.ExteriorWindowCount,exteriorWindows.length/4);
      if (exteriorWindows.length) gl.uniform4fv(uniform['ExteriorWindows[0]'],exteriorWindows);
gl.uniform1f(uniform.Daylight,daylight);
gl.uniform1i(uniform.Interior,Number(Boolean(interior)));
      gl.uniform4fv(uniform.Weather,weather);
      gl.uniform1f(uniform.Season,season);
      gl.uniform1f(uniform.Wetness,physical?wetness:0);
      const covers=physical?shelters.slice(0,4):[];
      gl.uniform1i(uniform.ShelterCount,covers.length);
      if (covers.length) gl.uniform4fv(uniform['Shelters[0]'],covers.flat());
      gl.uniform1i(uniform.RegionTexture,0);
      gl.uniform1i(uniform.Wild,Number(Boolean(regions?.length)));
      gl.uniform1i(uniform.HasWater,Number(Boolean(waterMask)));
      if (waterMask && waterMask!==waterImage) {
        gl.activeTexture(gl.TEXTURE2);gl.bindTexture(gl.TEXTURE_2D,water);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT,1);
        gl.texImage2D(gl.TEXTURE_2D,0,gl.LUMINANCE,waterMask.width,waterMask.height,0,
          gl.LUMINANCE,gl.UNSIGNED_BYTE,waterMask.bytes);
        waterImage=waterMask;
      }
      gl.uniform1f(uniform.Alpha,1);
      gl.uniform1i(uniform.Visibility,Number(Boolean(visibility)));
      if (visibility) gl.uniform4f(uniform.FogBounds,...visibility.origin,visibility.extent,visibility.extent);
      if (visibility && visibilityImage!==visibility) {
        gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,fog);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT,1);
        gl.texImage2D(gl.TEXTURE_2D,0,gl.LUMINANCE,visibility.size,visibility.size,0,gl.LUMINANCE,gl.UNSIGNED_BYTE,visibility.bytes);
        visibilityImage=visibility;
      }
      if(terrain) {
        const texture=terrainTexture(terrain), size=stage.width+':'+stage.depth;
        gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,texture);
        if(groundSize!==size){
          const data=[];
          quad(data,[0,-.012,0],[stage.width,-.012,0],[stage.width,-.012,stage.depth],[0,-.012,stage.depth],
            [1,1,1],[[0,0],[1,0],[1,1],[0,1]]);
          bind(groundBuffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(data),gl.STATIC_DRAW);
          groundSize=size;
        }
        paint(groundBuffer,6,true);
      }
      const faded=[];
      const cacheLimit=regions?.length ? 48 : 12;
      if (regions?.length) {
        if (regionAtlas) {
          const texture=terrainTexture(regionAtlas);
          gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,texture);
        }
        for (const region of regions) {
          if (!regionOnScreen(region.viewBounds,camera,width,height)) continue;
          gl.uniform1i(uniform.RegionTexture,Number(Boolean(regionAtlas && region.mesh)));
          paintStage(stageBuffer(region,cacheLimit),covered,faded);
        }
        gl.uniform1i(uniform.RegionTexture,0);
        if (terrain) {
          const texture=terrainTexture(terrain);
          gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,texture);
        }
      }
      paintStage(stageBuffer(stage,cacheLimit),covered,faded,Boolean(terrain));
      if (life) paintStage(stageBuffer(life,cacheLimit),covered,faded);
      if (homes) paintStage(stageBuffer(homes,cacheLimit),covered,faded);
      if (physical && shadows) {
        const base=groundContactMesh(shadows);
        const cast=sun?.direct ? contactShadowMesh(shadows,sun,{soft:true}) : null;
        gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);
        gl.depthMask(false);gl.uniform1i(uniform.Shadow,1);
        if (cast?.length) {
          bind(shadowBuffer);
          if (cast!==shadowData) {
            gl.bufferData(gl.ARRAY_BUFFER,cast,gl.DYNAMIC_DRAW);shadowData=cast;
          }
          paint(shadowBuffer,cast.length/MODEL_STRIDE,false);
        }
        if (base.length) {
          bind(groundContactBuffer);
          if (base!==contactData) {
            gl.bufferData(gl.ARRAY_BUFFER,base,gl.DYNAMIC_DRAW);contactData=base;
          }
          paint(groundContactBuffer,base.length/MODEL_STRIDE,false);
        }
        gl.uniform1i(uniform.Shadow,0);gl.depthMask(true);gl.disable(gl.BLEND);
      }
      const moving=[];
      const translucent=[];
      for (const box of work) {
        const fadedModel=covered.has(box.occluder), out=fadedModel?translucent:moving;
        if (box.fx) {
          if (!fadedModel) fx3d(out,[box],animateParts?frame:0);
          continue;
        }
        let mesh=!box.transient && workMeshes.get(box);
        if (!mesh) {
          mesh=[];
          modelMesh(mesh,box);
          if (!box.transient) workMeshes.set(box,mesh);
        }
        out.push(...mesh);
      }
      fx3d(moving,stage.fxs?.filter(b=>!covered.has(b.occluder)),frame);
      fx3d(moving,life?.fxs,frame);
      animalMesh(moving,animals,weather[0]);
      for(const person of people)actor(moving,person,frame);
      for (const box of impacts) prism(moving,box);
      bind(movingBuffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(moving),gl.DYNAMIC_DRAW);
      paint(movingBuffer,moving.length/MODEL_STRIDE,false);
      if (translucent.length) {
        bind(movingBuffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(translucent),gl.DYNAMIC_DRAW);
        faded.push({b:movingBuffer,from:0,count:translucent.length/MODEL_STRIDE});
      }
      paintFaded(faded);
      const ctx=target.getContext('2d');
      ctx.setTransform(1,0,0,1,0,0);
      ctx.imageSmoothingEnabled=false;
      ctx.drawImage(canvas,0,0);
      return true;
    },
    regionStats:()=>({buffers:lru.length,bytes:lru.reduce((sum,stage)=>sum+stages.get(stage).count*MODEL_STRIDE*4,0)}),
  };
}
