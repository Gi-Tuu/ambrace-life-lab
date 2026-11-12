const rgb = (hex, shade = 1) => [1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)*shade/255);
const dot = (a,b) => a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const cross = (a,b) => [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const norm = v => { const len=Math.hypot(...v); return v.map(a=>a/len); };

export function campCamera({ x,z,width,height,span,yaw=.29,pitch=.65 }) {
  const back = [Math.sin(yaw)*Math.cos(pitch),Math.sin(pitch),Math.cos(yaw)*Math.cos(pitch)];
  const right = norm(cross([0,1,0],back)), up = cross(back,right);
  const aim = [x,.55,z], eye = aim.map((v,i)=>v+80*back[i]);
  const halfX = span/2, halfY = halfX*height/width;
  return {
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

function quad(data,a,b,c,d,color,uv=[[0,0],[0,0],[0,0],[0,0]]) {
  const points=[a,b,c,d];
  for (const i of [0,1,2,0,2,3]) data.push(...points[i],...color,...uv[i]);
}

function prism(data,{ x,y,z,w,h,d,color,axis,end }) {
  if (w <= 0 || d <= 0 || h < 0) return;
  const x1=x+w,z1=z+d;
  const height=(u,v)=>axis==='x' ? y+(end-y)*u : axis==='z' ? y+(end-y)*v : y+h;
  const bottom=axis ? Math.min(y,end)-.11 : y;
  const a=[x,height(0,0),z],b=[x1,height(1,0),z],c=[x1,height(1,1),z1],d0=[x,height(0,1),z1];
  const A=[x,bottom,z],B=[x1,bottom,z],C=[x1,bottom,z1],D=[x,bottom,z1];
  quad(data,a,b,c,d0,rgb(color));
  if (!axis && h===0) return;
  quad(data,a,b,B,A,rgb(color,.70)); quad(data,b,c,C,B,rgb(color,.78));
  quad(data,c,d0,D,C,rgb(color,.91)); quad(data,d0,a,A,D,rgb(color,.65));
}

function stageMesh(stage) {
  const out=[];
  for (const f of stage.floors) {
    const slope=f.end!==f.y, elevated=f.y>0;
    prism(out,{...f,y:slope?f.y:elevated?f.y-.12:f.y,h:slope?0:elevated?.12:0,axis:slope?f.axis:undefined});
    if (!elevated && !slope) continue;
    for (let i=.3;i<f.d-.06;i+=.42) {
      const top = f.axis==='z' ? f.y+(f.end-f.y)*i/f.d : f.y;
      const end = f.axis==='x' ? f.end : top;
      prism(out,{x:f.x,y:top+.003,z:f.z+i,w:f.w,d:.025,h:0,axis:f.axis==='x'?'x':undefined,end:end+.003,color:'#976A45'});
    }
  }
  for (const b of stage.boxes) if (!b.fx) prism(out,b);
  return new Float32Array(out);
}

// 呼吸感：带 fx 标记的几何不进静态网格，按共享帧号逐帧重建（独立 6fps 时钟，不读 w.t、不消费 rng）。
function fx3d(data, list, frame) {
  if (!list || !list.length) return;
  const t = frame % 4;
  for (const b of list) {
    if (b.fx === 'sway') {
      prism(data,{...b,x:b.x+[0,.05,0,-.05][t],z:b.z+[.025,0,-.025,0][t],color:t%2?b.color:'#98BD51'});
    } else if (b.fx === 'banner') {
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
    } else if (b.fx === 'graze') {
      // 牛/羊：按帧轻微起伏，像在低头吃草；位移很小，保持像素稳定。
      prism(data,{...b,y:b.y+[0,.03,0,-.02][t]});
    } else if (b.fx === 'peck') {
      // 鸡：奇数帧低头啄食、偶数帧抬头，并沿 z 轻挪。
      const down = t % 2 === 1;
      prism(data,{...b,y:down?b.y-.04:b.y,z:b.z+[0,.04,0,-.04][t]});
      if (down) prism(data,{...b,x:b.x+.12,y:b.y-.12,z:b.z+.12,w:.12,h:.1,d:.12,color:'#FFA300'});
    } else prism(data,b);
  }
}

function actor(data,p,frame) {
  const {x,y,z}=p, t=frame%4, gait=p.moving ? [0,.15,0,-.15][t] : 0;
  const act=String(p.act??'idle');
  const build=/^(build|plan|repair|work)$/.test(act);
  const gather=/^(gather|harvest|plant|forage|collect)$/.test(act);
  const talk=/^(talk|hail|say|companion)$/.test(act);
  const food=/^(eat|food|trade|buy|take_shared)$/.test(act);
  const rest=/^(idle|rest|seclude|deafen|rej|refuse|look_out)$/.test(act);
  const lift=build||talk||food, bend=gather?.13:0;
  const bob=rest?[0,.02,0,-.02][t]:0, swing=[0,.17,0,-.17][t];
  // 上半身统一按动作前倾/呼吸，腿脚只随走路摆动；全部走同一套色板与共享帧号。
  const draw=(dx,dy,dz,w,h,d,color)=>prism(data,{x:x+dx,y:y+dy+bob,z:z+dz+(dy>.4?bend:0),w,h,d,color});
  draw(-.27,.004,-.20,.54,0,.45,'#72513B');
  draw(-.20,0,-.12+gait,.15,.46,.25,'#324D59');
  draw(.04,0,-.12-gait,.15,.46,.25,'#324D59');
  draw(-.23,.44,-.16,.46,.49,.32,p.color);
  const ay=lift?.78:.44, ah=lift?.44:.38;
  draw(-.30,ay+(build?swing:0),-.12-gait,.1,ah,.24,'#D58274');
  draw(.20,ay+(build?-swing:0),-.12+gait,.1,ah,.24,'#D58274');
  if(build)draw(.26,ay+ah,-.1+gait,.1,.26,.1,'#5F574F');
  if(gather)draw(.22,.56,.02,.22,.2,.2,'#AB5236');
  if(food)draw(.16,ay+ah*.6,.02,.14,.14,.14,'#FFA300');
  draw(-.22,.92,-.17+(talk?swing*.2:0),.44,.37,.34,'#EDC787');
  draw(-.26,1.22,-.21,.52,.23,.41,'#514134');
  const face=p.direction ?? 'down';
  if (face==='down' || face==='up') {
    const front = face==='down' ? .17 : -.194;
    for (const offset of [-.14,.09]) draw(offset,1.105,front,.05,.065,.024,'#18251E');
  } else {
    const side = face==='right' ? .22 : -.244;
    for (const offset of [-.11,.07]) draw(side,1.105,offset,.024,.065,.05,'#18251E');
  }
}

const VERTEX = `
  attribute vec3 aPosition;
  attribute vec3 aColor;
  attribute vec2 aUV;
  uniform mat4 uView, uProjection;
  varying vec3 vColor;
  varying vec2 vUV, vWorld;
  void main(){
    gl_Position=uProjection*uView*vec4(aPosition,1.);
    vColor=aColor; vUV=aUV; vWorld=aPosition.xz;
  }
`;
const FRAGMENT = `
  precision mediump float;
  uniform sampler2D uGround, uFog;
  uniform vec2 uExtent;
  uniform bool uTexture, uVisibility;
  uniform vec3 uLight;
  varying vec3 vColor;
  varying vec2 vUV, vWorld;
  void main(){
    vec3 color=uTexture ? texture2D(uGround,vUV).rgb : vColor;
    float shade=uVisibility ? texture2D(uFog,vWorld/uExtent).r : 1.;
    gl_FragColor=vec4(color*uLight*mix(.48,1.,shade),1.);
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
  const uniform=Object.fromEntries(['View','Projection','Ground','Fog','Extent','Texture','Visibility','Light'].map(k=>[k,gl.getUniformLocation(p,'u'+k)]));
  gl.useProgram(p);gl.enable(gl.DEPTH_TEST);
  for (const a of [aPos,aColor,aUV]) gl.enableVertexAttribArray(a);
  const stages=new WeakMap(), groundBuffer=gl.createBuffer(), movingBuffer=gl.createBuffer();
  const createTexture=(unit)=>{
    const t=gl.createTexture();
    gl.activeTexture(unit);gl.bindTexture(gl.TEXTURE_2D,t);
    for(const [key,value] of [[gl.TEXTURE_MIN_FILTER,gl.NEAREST],[gl.TEXTURE_MAG_FILTER,gl.NEAREST],
      [gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE],[gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D,key,value);
    return t;
  };
  const blank=createTexture(gl.TEXTURE0), fog=createTexture(gl.TEXTURE1);
  gl.uniform1i(uniform.Ground,0);gl.uniform1i(uniform.Fog,1);
  // 两个采样器始终绑定完整纹理，室内和全景也能正常绘制。
  gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,blank);
  gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array([255,255,255,255]));
  gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,fog);
  gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array([255,255,255,255]));
  const terrainTextures=new Map(), maxTexture=gl.getParameter(gl.MAX_TEXTURE_SIZE);
  let groundSize='', visibilityImage=null;
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
    gl.vertexAttribPointer(aPos,3,gl.FLOAT,false,32,0);
    gl.vertexAttribPointer(aColor,3,gl.FLOAT,false,32,12);
    gl.vertexAttribPointer(aUV,2,gl.FLOAT,false,32,24);
  }
  function paint(buffer,count,textured) {
    bind(buffer);gl.uniform1i(uniform.Texture,Number(textured));gl.drawArrays(gl.TRIANGLES,0,count);
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
    const b=gl.createBuffer(), mesh=stageMesh(stage);
    bind(b);gl.bufferData(gl.ARRAY_BUFFER,mesh,gl.STATIC_DRAW);
    const item={ b,count:mesh.length/8 };
    stages.set(stage,item);
    lru.push(stage);
    if(lru.length>12){
      const old=lru.shift();
      gl.deleteBuffer(stages.get(old).b);
      stages.delete(old);
    }
    return item;
  }
  return {
    render({ target,stage,terrain,camera,people,work=[],frame,light,visibility }) {
      if (lost || gl.isContextLost()) return false;
      const width=target.width,height=target.height;
      if(canvas.width!==width || canvas.height!==height) {canvas.width=width;canvas.height=height;}
      gl.viewport(0,0,width,height);
      gl.clearColor(.10*light[0],.145*light[1],.119*light[2],1);
      gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
      gl.uniformMatrix4fv(uniform.View,false,camera.view);
      gl.uniformMatrix4fv(uniform.Projection,false,camera.projection);
      gl.uniform3fv(uniform.Light,light);
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
      const {b,count}=stageBuffer(stage);
      paint(b,count,false);
      const moving=[];
      for(const box of work)prism(moving,box);
      if(stage.fxs)fx3d(moving,stage.fxs,frame);
      for(const person of people)actor(moving,person,frame);
      bind(movingBuffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(moving),gl.DYNAMIC_DRAW);
      paint(movingBuffer,moving.length/8,false);
      const ctx=target.getContext('2d');
      ctx.setTransform(1,0,0,1,0,0);
      ctx.imageSmoothingEnabled=false;
      ctx.drawImage(canvas,0,0);
      return true;
    },
  };
}
