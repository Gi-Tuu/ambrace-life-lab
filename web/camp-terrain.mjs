export const hash2 = (x, y, s = 0) => {
  let n = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 1274126177)) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
};
export const campHash = (seed,key) => {
  let salt=0;
  for (const ch of key) salt=Math.imul(salt,31)+ch.charCodeAt(0);
  return hash2(seed,salt,29);
};
const baseRiver = z => 40 + Math.sin(z * .085) * 4 + Math.sin(z * .031) * 2;
const zones = [[14,12], [72,8], [108,15], [10,65], [60,67]];

export function campTerrain(seed = 0, raised = true, layoutVersion = 0) {
  const phase = campHash(seed, 'river') * Math.PI * 2;
  const offset=(campHash(seed,'river-offset')-.5)*9;
  const river = z => {
    const wilderness = Math.min(1, Math.max(0, (20-z)/13, (z-55)/14));
    if (layoutVersion) {
      return 45 + offset +
        Math.sin(z*.088+phase)*3.1 + Math.sin(z*.04+phase*.4)*2;
    }
    return baseRiver(z) + (seed ? wilderness * 3.5 * Math.sin(z*.18+phase) : 0);
  };
  const riverCenter = y => river(y / 16) * 16 + Math.sin(y*.07)*3;
  const riverHalfWidth = y => 17 + Math.sin(y*.021)*3 +
    (seed ? 2.4*Math.sin(y*.01+phase) : 0);
  const hillZones=layoutVersion
    ? [[11,10],[32,11],[57,10],[83,10],[108,12],[11,65],[26,69],[61,67],[78,70],[108,68]]
    : zones;
  const drift=layoutVersion?9:5;
  const hills = raised ? hillZones.map(([x,z], i) => ({
    x: x + Math.floor(campHash(seed, `x${i}`)*drift) - Math.floor(drift/2),
    z: z + Math.floor(campHash(seed, `z${i}`)*drift) - Math.floor(drift/2),
    rx: 4 + Math.floor(campHash(seed, `w${i}`)*4),
    rz: 4 + Math.floor(campHash(seed, `d${i}`)*3),
    h: 1.15 + campHash(seed, `h${i}`)*1.65,
  })) : [];
  return { river, riverCenter, riverHalfWidth, hills };
}

export function reliefAt(hill, x, z) {
  const dx = (x-hill.x)/hill.rx, dz = (z-hill.z)/hill.rz;
  const r = Math.hypot(dx + .18*dz, dz);
  return hill.h * Math.max(0, 1-r)**1.5 * (1 + .17*Math.sin(dx*5+dz*4));
}

// 两个三角形共享对角线，渲染、脚底高度和点击使用同一平面。
export function reliefFaces(hills) {
  const faces = [];
  for (const hill of hills) {
    const z0 = hill.z-hill.rz, x0 = hill.x-hill.rx-1;
    for (let z=z0; z<hill.z+hill.rz; z+=1) for (let x=x0; x<hill.x+hill.rx+1; x+=1) {
      const y=reliefAt(hill,x,z), a=reliefAt(hill,x+1,z), b=reliefAt(hill,x+1,z+1), c=reliefAt(hill,x,z+1);
      if (!(y || a || b || c)) continue;
      faces.push({ x,z,w:1,d:1,y,ax:a-y,az:b-a,triangle:1 });
      faces.push({ x,z,w:1,d:1,y,ax:b-c,az:c-y,triangle:2 });
    }
  }
  return faces;
}

export function floorContains(f, x, z) {
  const u=(x-f.x)/f.w, v=(z-f.z)/f.d;
  return u>=0 && u<=1 && v>=0 && v<=1 &&
    (f.triangle===1 ? u>=v : f.triangle===2 ? u<=v : true);
}
