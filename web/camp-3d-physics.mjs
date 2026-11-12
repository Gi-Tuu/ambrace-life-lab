export const CAMP_BODY_RADIUS = .33;

// 同一身体半径用于贴墙、窄门寻路和人物间距。
const bodyGrids=new WeakMap();
export function bodyGrid(grid, scale) {
  if (bodyGrids.has(grid)) return bodyGrids.get(grid);
  const {tw,th,walk}=grid, radius=Math.ceil(CAMP_BODY_RADIUS*scale);
  const pitch=tw+1, sums=new Int32Array(pitch*(th+1)), clear=new Uint8Array(walk.length);
  for (let y=0;y<th;y+=1) {
    let row=0;
    for (let x=0;x<tw;x+=1) {
      row+=1-walk[y*tw+x];
      sums[(y+1)*pitch+x+1]=row+sums[y*pitch+x+1];
    }
  }
  for (let y=radius;y<th-radius;y+=1) for (let x=radius;x<tw-radius;x+=1) {
    const a=x-radius, b=x+radius+1, top=(y-radius)*pitch, bottom=(y+radius+1)*pitch;
    clear[y*tw+x]=Number(sums[bottom+b]-sums[bottom+a]-sums[top+b]+sums[top+a]===0);
  }
  const result={tw,th,walk:clear};
  bodyGrids.set(grid,result);
  return result;
}

export function separates(x,z,nx,nz,others,r=CAMP_BODY_RADIUS) {
  return others.every(o=>{
    const before=(x-o.x)**2+(z-o.z)**2;
    const after=(nx-o.x)**2+(nz-o.z)**2;
    return after>=(r+o.r)**2 || after>before;
  });
}
