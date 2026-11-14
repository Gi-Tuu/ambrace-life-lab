import { campHash } from './camp-terrain.mjs';
import { overlapsLot, generateCampLayout } from './camp-layout.mjs';
import { inCamp, wildLandscape } from './wild-landscape.mjs';

// Seeded sites spread across both riverbanks. Each has a work pad and a separate resource marker.
// 两环（派单第三阶段要求1，数据侧）：内环 inner-* ≤35 单位供日常木石（新手第一次采集可达），
// 外环 district-* 保留远征。规则语义不变，仅新增近郊点位。
const SITES = [
  ['inner-west','近郊林地','wood',24,-5], ['inner-north','近郊石坡','stone',36,-5],
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
    if (key.startsWith('inner-')) continue; // 内环单独放置（见下），外环螺旋远征点位不变
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
  placeInnerRing(districts, terrain, generateCampLayout(seed, version).sites.hall);
  return districts;
}

// 内环（派单第三阶段要求1，数据侧）：相对实际生成 hall 全方向扫描 ≤35 单位合法地形，
// 木取最近合法点、石取首个与木 pad 不重叠的合法点，保证日常木石 ≤35u 可达。规则语义不变。
function placeInnerRing(districts, terrain, hall) {
  const valid=[];
  for (let cx=hall[0]-45;cx<=hall[0]+45;cx++) for (let cz=hall[1]-45;cz<=hall[1]+45;cz++) {
    const dist=Math.hypot(cx-hall[0],cz-hall[1]);
    if (dist>45) continue;
    const pad={x:cx-3,z:cz-5.2,w:6,d:9.2};
    const pts=[[cx,cz],[pad.x,pad.z],[pad.x+pad.w,pad.z],[pad.x,pad.z+pad.d],[pad.x+pad.w,pad.z+pad.d]];
    if (pts.some(([px,pz])=>inCamp(px,pz)||terrain.bankGap(px,pz)<3||terrain.rim(px,pz)<10||terrain.land(px,pz)<12||!terrain.groundAllows(px,pz))) continue;
    valid.push([cx,cz,dist]);
  }
  valid.sort((a,b)=>a[2]-b[2]);
  const mk=(key,label,resource,cx,cz)=>{
    districts['district-'+key]={label,resource,capacity:resource==='wood'?12:10,at:[cx,cz],source:[cx-2.8,cz+1.7],lot:{x:cx-2,z:cz-4.2,w:4,d:3.2},pad:{x:cx-3,z:cz-5.2,w:6,d:9.2},home:null};
  };
  const padOf=([x,z])=>({x:x-3,z:z-5.2,w:6,d:9.2});
  // 取最近且能容下不重叠石点的木石对（窄地形带里木取中心会堵死石，故迭代找可行对）
  let wood=null, stone=null;
  for (const wc of valid) {
    const sc=valid.find(c=>!overlapsLot(padOf(c),padOf(wc),4));
    if (sc){ wood=wc; stone=sc; break; }
  }
  if (wood) mk('inner-west','近郊林地','wood',wood[0],wood[1]);
  if (stone) mk('inner-north','近郊石坡','stone',stone[0],stone[1]);
}

export function districtPads(districts) {
  return Object.values(districts??{}).map(d=>d.pad);
}

export function districtHomes(districts) {
  return Object.fromEntries(Object.entries(districts??{}).filter(([,d])=>d.home)
    .map(([loc,d])=>['house-'+loc,d.home]));
}
