// 纯几何：不碰 DOM / WebGL / 渲染器。服务端（host/serve）与前端共享同一份尺寸与网格数学，
// 避免"服务端锚点/碰撞"和"页面显示的 3D"各算一套。
const dot = (a,b) => a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const cross = (a,b) => [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const norm = v => { const len=Math.hypot(...v); return v.map(a=>a/len); };

function rotateXZ([x,y,z], angle, px=0, pz=0) {
  const c=Math.cos(angle), s=Math.sin(angle);
  return [px+(x-px)*c-(z-pz)*s,y,pz+(x-px)*s+(z-pz)*c];
}

// Euler order X → Y → Z. The legacy yaw uses its original sign convention.
function rotate(point, angles, pivot=[0,0,0], inverse=false) {
  const v=point.map((n,i)=>n-pivot[i]);
  for (const axis of inverse?[2,1,0]:[0,1,2]) {
    const a=(axis+1)%3,b=(axis+2)%3, angle=angles[axis]*(inverse?-1:1);
    const c=Math.cos(angle),s=Math.sin(angle), left=v[a],right=v[b];
    v[a]=left*c-right*s;
    v[b]=left*s+right*c;
  }
  return v.map((n,i)=>n+pivot[i]);
}

function transformBox(point,b) {
  if (b.rot) return rotate(point,b.rot,b.pivot);
  return b.yaw?rotateXZ(point,b.yaw,b.pivotX,b.pivotZ):point;
}

export function boxVertices(b) {
  const {x,y,z,w,h,d,axis,end}=b;
  const top=(u,v)=>axis==='x'?y+(end-y)*u:axis==='z'?y+(end-y)*v:y+h;
  const bottom=axis?Math.min(y,end)-.11:y;
  const x1=x+w,z1=z+d;
  const points=[[x,top(0,0),z],[x1,top(1,0),z],[x1,top(1,1),z1],[x,top(0,1),z1],
    [x,bottom,z],[x1,bottom,z],[x1,bottom,z1],[x,bottom,z1]];
  return b.rot || b.yaw ? points.map(p=>transformBox(p,b)) : points;
}

export function beam(from,to,r,color,segments=6) {
  const axis=to.map((n,i)=>n-from[i]), length=Math.hypot(...axis);
  if (!(length>1e-8 && r>0)) return null;
  const unit=axis.map(n=>n/length);
  const u=norm(cross(Math.abs(unit[1])>.95?[1,0,0]:[0,1,0],unit));
  const v=cross(unit,u);
  const count=Number.isFinite(segments)?Math.max(6,Math.min(64,Math.floor(segments))):6;
  return {shape:'beam',from,to,r,color,segments:count,unit,u,v,length};
}

export function cyl(x,y,z,r,h,color,segments=8,axis='y') {
  if (!['x','y','z'].includes(axis) || !(h>0)) return null;
  const from=[x,y,z], to=from.slice();
  to['xyz'.indexOf(axis)]+=h;
  return beam(from,to,r,color,segments);
}

export function beamRing(b) {
  return Array.from({length:b.segments},(_,i)=>{
    const angle=i*2*Math.PI/b.segments,c=Math.cos(angle)*b.r,s=Math.sin(angle)*b.r;
    return b.u.map((n,j)=>n*c+b.v[j]*s);
  });
}

export function modelBounds(b) {
  if (!b.shape && !b.rot && !b.yaw) return b;
  const points=b.shape==='beam'?beamRing(b).flatMap(offset=>[b.from,b.to].map(p=>p.map((n,i)=>n+offset[i]))):boxVertices(b);
  const low=[0,1,2].map(i=>Math.min(...points.map(p=>p[i])));
  const high=[0,1,2].map(i=>Math.max(...points.map(p=>p[i])));
  return {x:low[0],y:low[1],z:low[2],w:high[0]-low[0],h:high[1]-low[1],d:high[2]-low[2]};
}

// 渲染器内部也复用这三个向量运算；导出为避免两份实现漂移（不是对外 API）。
export { dot, cross, norm, rotateXZ, rotate };
