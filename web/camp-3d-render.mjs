import { itemBoxes } from './camp-items.mjs';
import { WALK_DIRECTIONS } from './walk.mjs';

function rotateXZ([x,y,z], angle, px=0, pz=0) {
  const c=Math.cos(angle), s=Math.sin(angle);
  return [px+(x-px)*c-(z-pz)*s,y,pz+(x-px)*s+(z-pz)*c];
}

const rgb = (hex, shade = 1) => [1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)*shade/255);
const dot = (a,b) => a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const cross = (a,b) => [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const norm = v => { const len=Math.hypot(...v); return v.map(a=>a/len); };

export function campCamera({ x,z,width,height,span,yaw=.29,pitch=.65,targetY=.55 }) {
  const back = [Math.sin(yaw)*Math.cos(pitch),Math.sin(pitch),Math.cos(yaw)*Math.cos(pitch)];
  const right = norm(cross([0,1,0],back)), up = cross(back,right);
  const aim = [x,targetY,z], eye = aim.map((v,i)=>v+80*back[i]);
  const halfX = span/2, halfY = halfX*height/width;
  return {
    back,
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
  if (b.yaw) {
    origin=rotateXZ(origin,-b.yaw,b.pivotX,b.pivotZ);
    direction=rotateXZ(direction,-b.yaw);
  }
  const lower=[b.x,b.y,b.z], upper=[b.x+b.w,b.y+b.h,b.z+b.d];
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

export function coveredModels(camera, player, ...lists) {
  const covered=new Set();
  if (!player || camera.back[1]>.995) return covered;
  const {x,y,z}=player;
  const samples=[[x,y+.12,z],[x,y+.59,z],[x,y+1.11,z]];
  for (const boxes of lists) for (const b of boxes) {
    if (!b.occluder || covered.has(b.occluder) || b.fx || b.y+b.h<=y+.12 ||
        b.x>x+9 || b.x+b.w<x-9 || b.z>z+9 || b.z+b.d<z-9) continue;
    if (samples.some(origin => {
      const distance=rayBox(origin,camera.back,b);
      return distance!==null && distance>.025;
    })) covered.add(b.occluder);
  }
  return covered;
}

function quad(data,a,b,c,d,color,uv=[[0,0],[0,0],[0,0],[0,0]],material=()=>[0,0,0]) {
  const points=[a,b,c,d];
  for (const i of [0,1,2,0,2,3]) data.push(...points[i],...color,...uv[i],...material(points[i]));
}

function prism(data,{ x,y,z,w,h,d,color,axis,end,glow,wind,yaw,pivotX,pivotZ }) {
  if (w <= 0 || d <= 0 || h < 0) return;
  const x1=x+w,z1=z+d;
  const height=(u,v)=>axis==='x' ? y+(end-y)*u : axis==='z' ? y+(end-y)*v : y+h;
  const bottom=axis ? Math.min(y,end)-.11 : y;
  const a=[x,height(0,0),z],b=[x1,height(1,0),z],c=[x1,height(1,1),z1],d0=[x,height(0,1),z1];
  const A=[x,bottom,z],B=[x1,bottom,z],C=[x1,bottom,z1],D=[x,bottom,z1];
  const material=point=>[wind ? wind.weight*(wind.rooted ? (point[1]-y)/Math.max(h,.01) : 1) : 0,
    wind?.phase??0,Number(Boolean(glow))];
  const face=(a,b,c,d,shade=1)=>{
    const points=yaw?[a,b,c,d].map(p=>rotateXZ(p,yaw,pivotX,pivotZ)):[a,b,c,d];
    quad(data,...points,rgb(color,shade),undefined,material);
  };
  face(a,b,c,d0);
  if (!axis && h===0) return;
  face(a,b,B,A,.70); face(b,c,C,B,.78);
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
      for (const point of points) out.push(...point,shade,shade,shade,point[0]/stage.width,point[2]/stage.depth,0,0,0);
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
  if (out.length/11>terrainCount) ranges.push({id:null,from:terrainCount,count:out.length/11-terrainCount});
  for (const b of stage.boxes) {
    if (b.fx) continue;
    const from=out.length/11;
    prism(out,b);
    const count=out.length/11-from, last=ranges.at(-1);
    if (last && last.id===b.occluder) last.count+=count;
    else ranges.push({id:b.occluder,from,count});
  }
  return {mesh:new Float32Array(out),ranges,terrainCount};
}

// 呼吸感：带 fx 标记的几何不进静态网格，按共享帧号逐帧重建（独立 6fps 时钟，不读 w.t、不消费 rng）。
function fx3d(data, list, frame) {
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
    for (const box of animalBoxes(a,time)) prism(data,box);
  }
}
export function animalBoxes(a,time) {
  const turn=a.direction??0, gait=a.moving?Math.sin(time*10+a.phase)*.08:0;
  return a.boxes.map(b=>{
    const stride=b.fx==='leg'?gait*(b.x<0?1:-1)*(b.z<0?1:-1):0;
    const nod=b.fx==='nod'?.015*Math.sin(time*3+a.phase):0;
    const [x,z,w,d]=turnBox(b.x,b.z+stride,b.w,b.d,turn);
    const flight=a.kind==='bird'?2.7+.7*Math.sin(time*1.8+a.phase):0;
    const flap=b.fx==='wing'?.095*Math.sin(time*15):0;
    return {...b,x:a.x+x,z:a.z+z,w,d,y:b.y+Math.max(0,stride*.4)+nod+flight+flap};
  });
}
function actor(data,p,frame) { actorGeometry(p,frame,box=>prism(data,box)); }
export function actorBoxes(p,frame) {
  const boxes=[];
  actorGeometry(p,frame,box=>boxes.push(box));
  return boxes;
}
function actorGeometry(p,frame,emit) {
  const {x,y,z}=p, t=frame%4, gait=p.moving ? [0,.15,0,-.15][t] : 0;
  const turn=Math.max(0,WALK_DIRECTIONS.indexOf(p.direction));
  const child=p.stage==='child';
  const feminine=p.sex==='F', hair=p.hair??(feminine?'#573B31':'#403631');
  const act=String(p.act??'idle');
  const build=/^(build|plan|repair|work|till)$/.test(act);
  const gather=/^(gather|harvest|plant|forage|collect)$/.test(act);
  const talk=/^(talk|hail|say|companion)$/.test(act);
  const food=/^(eat|food|trade|buy|take_shared)$/.test(act);
  const rest=/^(idle|rest|seclude|deafen|rej|refuse|look_out)$/.test(act);
  const lift=build||talk||food||act==='push', bend=gather?.13:0;
  const bob=rest?[0,.02,0,-.02][t]:0, swing=[0,.17,0,-.17][t];
  const draw=(dx,dy,dz,w,h,d,color)=>{
    if (child) {
      const head=dy>=.88, horizontal=head?.9:.72;
      dx*=horizontal; dz*=horizontal; w*=horizontal; d*=horizontal;
      dy=head?.56+(dy-.88)*.81:dy*.63;
      h*=head?.81:.63;
    }
    if (p.pose==='sleep') {
      emit({x:x-dy-h+.74,y:y+dz+.23,z:z+dx,w:h,h:d,d:w,color});
      return;
    }
    if (p.pose==='sit') {
      dy=dy<.44?dy*.62:dy-.16;
      if (dy<.3) { h*=.66; dz+=.16; }
    }
    if (dy>.4) dz+=bend;
    if (turn % 2) {
      emit({x:x+dx,y:y+dy+bob,z:z+dz,w,h,d,color,yaw:turn*Math.PI/4,pivotX:x,pivotZ:z});
    } else {
      const [px,pz,pw,pd]=turnBox(dx,dz,w,d,turn/2);
      emit({x:x+px,y:y+dy+bob,z:z+pz,w:pw,h,d:pd,color});
    }
  };
  if (!p.pose) draw(-.27,.004,-.20,.54,0,.45,'#72513B');
  draw(-.20,0,-.12+gait,.15,.46,.25,'#324D59');
  draw(.04,0,-.12-gait,.15,.46,.25,'#324D59');
  draw(-.23,.44,-.155,.46,.2,.31,feminine?'#735649':'#43545A');
  draw(feminine?-.195:-.23,.63,-.16,feminine?.39:.46,.3,.32,p.color);
  draw(-.08,.78,.161,.16,.1,.025,'#D8B27C');
  draw(-.23,.6,-.17,.46,.045,.34,'#493F37');
  if (p.who==='p1' && !p.pose) {
    for (const [dx,dy,dz,w,h,d,c] of itemBoxes('backpack'))
      draw(-.35+dx*.70,.39+dy*.67,-.22-dz*.27-d*.27,w*.70,h*.67,d*.27,c);
    for (const x of [-.15,.11]) draw(x,.66,.16,.045,.25,.027,'#4F5842');
  }
  const ay=lift?.78:.44, ah=lift?.44:.38;
  draw(-.30,ay+(build?swing:0),-.12-gait,.1,ah,.24,'#D58274');
  draw(.20,ay+(build?-swing:0),-.12+gait,.1,ah,.24,'#D58274');
  const tool=p.tool && p.tool!=='hand'?p.tool:build?'hammer':gather?'basket':null;
  if (!p.pose && tool) for (const [dx,dy,dz,w,h,d,c] of itemBoxes(tool))
    draw(.15+dx*.53,ay+dy*.53+(build?swing:0)-.04,.09+dz*.44,w*.53,h*.53,d*.44,c);
  if(food) for (const [dx,dy,dz,w,h,d,c] of itemBoxes('fruit'))
    draw(.16+dx*.31,ay+ah*.6+dy*.31,.02+dz*.31,w*.31,h*.31,d*.31,c);
  draw(-.22,.92,-.17+(talk?swing*.2:0),.44,.37,.34,'#EDC787');
  draw(-.26,1.22,-.21,.52,.23,.41,hair);
  if (feminine) {
    draw(-.255,1.03,-.232,.51,.25,.125,hair);
    draw(-.238,1.04,-.105,.072,.24,.25,hair);
    draw(.167,1.015,-.12,.071,.25,.24,hair);
    draw(.12,.88,-.25,.125,.26,.095,hair);
    draw(.143,.88,-.262,.08,.065,.03,'#C99073');
  }
  for (const offset of [-.14,.09]) draw(offset,1.105,.173,.05,.065,.024,'#18251E');
  draw(-.038,1.045,.176,.076,.036,.024,'#AB6B56');
}

const VERTEX = `
  attribute vec3 aPosition;
  attribute vec3 aColor;
  attribute vec2 aUV;
  attribute vec3 aMaterial;
  uniform mat4 uView, uProjection;
  uniform mediump vec4 uWeather;
  varying vec3 vColor;
  varying vec2 vUV, vWorld;
  varying float vGlow, vHeight;
  void main(){
    float phase=uWeather.x*2.1+aMaterial.y;
    vec3 point=aPosition;
    point.x+=sin(phase)*aMaterial.x*uWeather.y;
    point.z+=sin(phase*.72+.8)*aMaterial.x*uWeather.y*.43;
    gl_Position=uProjection*uView*vec4(point,1.);
    vGlow=aMaterial.z; vHeight=point.y;
    vColor=aColor; vUV=aUV; vWorld=aPosition.xz;
  }
`;
const FRAGMENT = `
  precision mediump float;
  uniform sampler2D uGround, uFog, uWater;
  uniform vec2 uExtent;
  uniform bool uTexture, uVisibility, uHasWater;
  uniform vec3 uSight;
  uniform vec4 uHearth;
  uniform mediump vec4 uWeather;
  uniform float uSeason;
  uniform vec3 uLight;
  uniform float uAlpha;
  varying vec3 vColor;
  varying vec2 vUV, vWorld;
  varying float vGlow, vHeight;
  uniform bool uWild;
  void main(){
    vec3 color=uTexture ? texture2D(uGround,vUV).rgb*vColor : vColor;
    float water=uTexture && uHasWater ? texture2D(uWater,vUV).r : 0.;
    bool green=color.g>color.r*1.12 && color.g>color.b*1.10;
    if (green && water<.5) {
      if (uSeason==1.) color*=vec3(1.08,1.03,.93);
      if (uSeason==2.) color=mix(color,vec3(.64,.38,.15)*(.6+color.g*.7),.61);
      if (uSeason==3.) color=mix(color,vec3(.71,.79,.81),uTexture?.68:.37);
      if (uWeather.z>.5) color=mix(color,vec3(.55,.39,.20),.45);
    }
    if (water>.5) {
      float flow=sin(vWorld.y*15.-uWeather.x*5.+sin(vWorld.x*9.)*1.4);
      float ripple=smoothstep(.78,1.,flow)*(.55+.45*sin(vWorld.x*17.+vWorld.y*2.));
      color+=vec3(.075,.15,.17)*ripple;
    }
    if (uWild && vGlow<0.) {
      float phase=vGlow<-1.5 ? vHeight*.83+uWeather.x*6. : vWorld.y*4.-uWeather.x*3.;
      float foam=smoothstep(.72,1.,sin(phase+sin(vWorld.x*14.)*.6));
      color+=foam*vec3(.085,.13,.14);
    }
    float shade=1.;
    if (uVisibility) {
      float radius=uSight.z;
      float radial=1.-smoothstep(radius-1.6,radius+.45,distance(vWorld,uSight.xy));
      shade=texture2D(uFog,vWorld/uExtent).r*radial;
    }
    vec3 lit=color*uLight*mix(.48,1.,shade);
    vec3 amber=mix(vec3(.65,.27,.08),vec3(1.,.68,.34),clamp(color.g+color.b*.6,0.,1.));
    float fire=uHearth.w*(1.-smoothstep(.15,3.7,distance(vWorld,uHearth.xy)));
    lit+=vec3(.31,.145,.048)*fire;
    if (uWild) {
      float mist=smoothstep(2.,25.,-vHeight);
      float drift=.92+.08*sin(vWorld.x*.13+vWorld.y*.11+uWeather.x*.2);
      lit=mix(lit,vec3(.38,.48,.51),mist*drift*.79);
    }
    gl_FragColor=vec4(mix(lit,amber*mix(.55,1.,shade),max(0.,vGlow)*uWeather.w),uAlpha);
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
  const aMaterial=gl.getAttribLocation(p,'aMaterial');
  const uniform=Object.fromEntries(['Wild','Water','HasWater','Sight','Hearth','Season','Weather','View','Projection','Ground','Fog','Extent','Texture','Visibility','Light','Alpha'].map(k=>[k,gl.getUniformLocation(p,'u'+k)]));
  gl.useProgram(p);gl.enable(gl.DEPTH_TEST);
  for (const a of [aPos,aColor,aUV,aMaterial]) gl.enableVertexAttribArray(a);
  const stages=new WeakMap(), groundBuffer=gl.createBuffer(), movingBuffer=gl.createBuffer();
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
  gl.uniform1i(uniform.Water,2);
  gl.uniform1i(uniform.Ground,0);gl.uniform1i(uniform.Fog,1);
  // 两个采样器始终绑定完整纹理，室内和全景也能正常绘制。
  gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,blank);
  gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array([255,255,255,255]));
  gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,fog);
  gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array([255,255,255,255]));
  const terrainTextures=new Map(), maxTexture=gl.getParameter(gl.MAX_TEXTURE_SIZE);
  let groundSize='', visibilityImage=null, waterImage=null;
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
    gl.vertexAttribPointer(aPos,3,gl.FLOAT,false,44,0);
    gl.vertexAttribPointer(aColor,3,gl.FLOAT,false,44,12);
    gl.vertexAttribPointer(aUV,2,gl.FLOAT,false,44,24);
    gl.vertexAttribPointer(aMaterial,3,gl.FLOAT,false,44,32);
  }
  function paint(buffer,count,textured,from=0) {
    bind(buffer);gl.uniform1i(uniform.Texture,Number(textured));gl.drawArrays(gl.TRIANGLES,from,count);
  }
  // 仅保留当前几种场景的缓冲，地图/对照切换时释放长期不用的资源。
  const lru=[];
  function stageBuffer(stage) {
    if (stages.has(stage)) {
      const index=lru.indexOf(stage);
      lru.splice(index,1);
      lru.push(stage);
      return stages.get(stage);
    }
    const b=gl.createBuffer();
    const {mesh,ranges,terrainCount}=stage.mesh ? {mesh:stage.mesh,ranges:[],terrainCount:0} : stageMesh(stage);
    bind(b);gl.bufferData(gl.ARRAY_BUFFER,mesh,gl.STATIC_DRAW);
    const item={ b,count:mesh.length/11,ranges,terrainCount };
    stages.set(stage,item);
    lru.push(stage);
    if(lru.length>(stage.wild ? 42 : 12)){
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
      if (!covered.has(r.id)) continue;
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
    render({ target,stage,regions,life,homes,terrain,camera,people,work=[],covered=new Set(),frame,light,visibility,animals=[],hearth=[0,0,0,0],sight=[0,0,0],waterMask,season=-1,weather=[0,0,0,0] }) {
      if (lost || gl.isContextLost()) return false;
      const width=target.width,height=target.height;
      if(canvas.width!==width || canvas.height!==height) {canvas.width=width;canvas.height=height;}
      gl.viewport(0,0,width,height);
      gl.clearColor(.10*light[0],.145*light[1],.119*light[2],1);
      gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
      gl.uniformMatrix4fv(uniform.View,false,camera.view);
      gl.uniformMatrix4fv(uniform.Projection,false,camera.projection);
      gl.uniform3fv(uniform.Light,light);
      gl.uniform3fv(uniform.Sight,sight);
      gl.uniform4fv(uniform.Hearth,hearth);
      gl.uniform4fv(uniform.Weather,weather);
      gl.uniform1f(uniform.Season,season);
      gl.uniform1i(uniform.Wild,Number(Boolean(regions)));
      gl.uniform1i(uniform.HasWater,Number(Boolean(waterMask)));
      if (waterMask && waterMask!==waterImage) {
        gl.activeTexture(gl.TEXTURE2);gl.bindTexture(gl.TEXTURE_2D,water);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT,1);
        gl.texImage2D(gl.TEXTURE_2D,0,gl.LUMINANCE,waterMask.width,waterMask.height,0,
          gl.LUMINANCE,gl.UNSIGNED_BYTE,waterMask.bytes);
        waterImage=waterMask;
      }
      gl.uniform1f(uniform.Alpha,1);
      gl.uniform2f(uniform.Extent,stage.width,stage.depth);
      gl.uniform1i(uniform.Visibility,Number(Boolean(visibility)));
      if (visibility && visibilityImage!==visibility) {
        gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,fog);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT,1);
        gl.texImage2D(gl.TEXTURE_2D,0,gl.LUMINANCE,stage.width,stage.depth,0,gl.LUMINANCE,gl.UNSIGNED_BYTE,visibility);
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
      if (regions) for (const region of regions) paintStage(stageBuffer(region),covered,faded);
      else paintStage(stageBuffer(stage),covered,faded,Boolean(terrain));
      if (life) paintStage(stageBuffer(life),covered,faded);
      if (homes) paintStage(stageBuffer(homes),covered,faded);
      const moving=[];
      const translucent=[];
      for (const box of work) prism(covered.has(box.occluder)?translucent:moving,box);
      fx3d(moving,stage.fxs?.filter(b=>!covered.has(b.occluder)),frame);
      fx3d(moving,life?.fxs,frame);
      animalMesh(moving,animals,weather[0]);
      for(const person of people)actor(moving,person,frame);
      bind(movingBuffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(moving),gl.DYNAMIC_DRAW);
      paint(movingBuffer,moving.length/11,false);
      if (translucent.length) {
        bind(movingBuffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(translucent),gl.DYNAMIC_DRAW);
        faded.push({b:movingBuffer,from:0,count:translucent.length/11});
      }
      paintFaded(faded);
      const ctx=target.getContext('2d');
      ctx.setTransform(1,0,0,1,0,0);
      ctx.imageSmoothingEnabled=false;
      ctx.drawImage(canvas,0,0);
      return true;
    },
    regionStats:()=>({buffers:lru.length,bytes:lru.reduce((sum,stage)=>sum+stages.get(stage).count*44,0)}),
  };
}
