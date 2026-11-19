// 前端图标层：几何/模型数据在 shared/camp-items.mjs，这里只做浏览器 Canvas 光栅化。
import { itemBoxes } from '../shared/camp-items.mjs';

const icons = new Map();
export { itemBoxes };
export function itemIcon(id) {
  if (icons.has(id)) return icons.get(id);
  const canvas=document.createElement('canvas');
  canvas.width=canvas.height=40;
  const g=canvas.getContext('2d');
  const project=(x,y,z)=>[20+(x-z)*19,29+(x+z-1)*8-y*24];
  const face=(pts,color,shade=0)=>{
    g.beginPath();
    for (const [i,point] of pts.entries()) g[i?'lineTo':'moveTo'](...project(...point));
    g.closePath();
    g.fillStyle=color;
    g.fill();
    if (shade) { g.fillStyle=`rgba(22,20,16,${shade})`;g.fill(); }
  };
  const sorted=[...itemBoxes(id)].sort((a,b)=>a[0]+a[2]+a[1]*.6-b[0]-b[2]-b[1]*.6);
  for (const [x,y,z,w,h,d,c] of sorted) {
    const X=x+w,Y=y+h,Z=z+d;
    face([[x,y,Z],[X,y,Z],[X,Y,Z],[x,Y,Z]],c,.17);
    face([[X,y,z],[X,y,Z],[X,Y,Z],[X,Y,z]],c,.32);
    face([[x,Y,z],[X,Y,z],[X,Y,Z],[x,Y,Z]],c);
  }
  const src=canvas.toDataURL();
  icons.set(id,src);
  return src;
}
