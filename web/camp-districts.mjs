import { campHash } from './camp-terrain.mjs';
import { overlapsLot } from './camp-layout.mjs';
import { inCamp, wildLandscape } from './wild-landscape.mjs';

// Seeded sites spread across both riverbanks. Each has a work pad and a separate resource marker.
const SITES = [
  ['northwest','西北林地','wood',14,-24], ['north','北岸石坡','stone',75,-35],
  ['west','西侧林地','wood',-22,30], ['east','东侧石坡','stone',146,48],
  ['southwest','西南石坡','stone',17,108], ['southeast','东南林地','wood',95,116],
  ['far-west','西部岩地','stone',-116,49], ['far-east','东部林地','wood',228,26],
  ['far-north','北部林地','wood',7,-141], ['far-south','南部岩地','stone',96,208],
];
const HOME_DISTRICTS=new Set(['northwest','east','southwest','southeast']);

export function campDistricts(seed, version) {
  const terrain=wildLandscape(seed,version,{joined:true});
  const districts={};
  for (const [key,label,resource,x,z] of SITES) {
    const n=campHash(seed,'district:'+key)*Math.PI*2;
    for (let i=0;i<49;i++) {
      const a=n+i*2.39996, r=4+Math.sqrt(i)*3.4;
      const cx=Math.round(x+Math.cos(a)*r), cz=Math.round(z+Math.sin(a)*r);
      const lot={x:cx-2,z:cz-4.2,w:4,d:3.2};
      const home=HOME_DISTRICTS.has(key)?[cx+8,cz+1]:null;
      const pad={x:cx-4,z:cz-(home?7:5.2),w:home?16:8,d:home?13:9.2};
      const points=[[cx,cz],[pad.x,pad.z],[pad.x+pad.w,pad.z],[pad.x,pad.z+pad.d],[pad.x+pad.w,pad.z+pad.d]];
      if (points.some(([px,pz])=>inCamp(px,pz) || terrain.bankGap(px,pz)<3 || terrain.rim(px,pz)<10 ||
          terrain.land(px,pz)<12 || !terrain.groundAllows(px,pz))) continue;
      if (Object.values(districts).some(other=>overlapsLot(pad,other.pad,4))) continue;
      districts['district-'+key]={label,resource,capacity:resource==='wood'?12:10,at:[cx,cz],source:[cx-2.8,cz+1.7],lot,pad,home};
      break;
    }
  }
  return districts;
}

export function districtPads(districts) {
  return Object.values(districts??{}).map(d=>d.pad);
}

export function districtHomes(districts) {
  return Object.fromEntries(Object.entries(districts??{}).filter(([,d])=>d.home)
    .map(([loc,d])=>['house-'+loc,d.home]));
}
