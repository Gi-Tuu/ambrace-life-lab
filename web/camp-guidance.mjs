import { entrancePoints, workPoints } from './camp-construction-access.mjs';
import { distanceTo, distanceToRect } from './camp-interaction.mjs';

export function guidedOutdoor(entity) {
  return ['door','lot','work','plot'].includes(entity?.kind);
}

export function planApproach(entity,from,allows,route,preferred) {
  const gap=point=>entity.rect ? distanceToRect(point,entity.rect) : distanceTo(point,entity.at);
  const candidates=entity.kind==='door' ? [...entrancePoints(entity.rect),entity.at]
    : guidedOutdoor(entity) ? workPoints(entity.rect)
    : Array.from({length:8},(_,i)=>{
      const angle=i*Math.PI/4, radius=entity.reach*.75;
      return [entity.at[0]+Math.cos(angle)*(entity.rect?entity.rect.w/2+.25:radius),
        entity.at[1]+Math.sin(angle)*(entity.rect?entity.rect.d/2+.25:radius)];
    });
  candidates.sort((a,b)=>distanceTo(a,from)-distanceTo(b,from));
  if (preferred) candidates.unshift(preferred);
  let blockedAt, unreachableAt;
  for (const point of candidates) {
    if (gap(point)>entity.reach) continue;
    if (!allows(...point)) { blockedAt??=point; continue; }
    if (!route) return {point};
    const path=route(point);
    if (path?.length || path && distanceTo(point,from)<.08) return {point,path};
    unreachableAt??=point;
  }
  return unreachableAt?{unreachableAt}:{blockedAt};
}

export const GUIDE_COLORS={outline:'#DCB86F',door:'#F3CE85',stand:'#7DDCD1',block:'#FF806B',unreachable:'#F1AA6E'};
const base='#262D2B';

// Depth-tested floor graphics. Subdivide long edges to follow slopes without cutting across them.
function line(out,from,to,style,height) {
  const dx=to[0]-from[0],dz=to[1]-from[1],length=Math.hypot(dx,dz);
  const segments=Math.max(1,Math.ceil(length/.48)), span=length/segments;
  const yaw=Math.atan2(dz,dx);
  const add=(x,z,y,w,d,color)=>out.push({x:x-w/2,y,z:z-d/2,w,d,h:0,color,yaw,pivotX:x,pivotZ:z});
  for (let i=0;i<segments;i++) {
    if (style.dashed && i%2) continue;
    const f=(i+.5)/segments, x=from[0]+dx*f, z=from[1]+dz*f, y=height(x,z)+.09;
    add(x,z,y,span+.012,style.width+.055,base);
    add(x,z,y+.012,span,style.width,style.color);
  }
}
export function guideGeometry(hints,height) {
  const out=[];
  for (const {kind,rect,point,dashed} of hints) {
    const style={color:GUIDE_COLORS[kind],width:kind==='outline'?.045:.075,dashed};
    if (rect) {
      // Keep the outline outside of the floors, foundations and collision bodies it describes.
      const inset=kind==='outline'?.075:0;
      const a=[rect.x-inset,rect.z-inset], b=[rect.x+rect.w+inset,a[1]];
      const c=[b[0],rect.z+rect.d+inset], d=[a[0],c[1]];
      for (const [from,to] of [[a,b],[b,c],[c,d],[d,a]]) line(out,from,to,style,height);
    }
    if (point) {
      const [x,z]=point, r=.245;
      if (kind==='block' || kind==='unreachable') {
        line(out,[x-r,z-r],[x+r,z+r],style,height);
        line(out,[x-r,z+r],[x+r,z-r],style,height);
      } else {
        const corners=[[x-r,z],[x,z-r],[x+r,z],[x,z+r]];
        for (let i=0;i<4;i++) line(out,corners[i],corners[(i+1)%4],style,height);
      }
    }
  }
  return out;
}
