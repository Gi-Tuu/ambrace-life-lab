import { campTerrain, campHash } from './camp-terrain.mjs';
// 施工地块独立于地点中心。边界用世界 tile，包含施工与完工共同占地。
export const CONSTRUCTION_LOTS=Object.freeze(Object.fromEntries(
  Object.entries({yard:[25,27],garden:[26,33],watch:[59,12],well:[48,37]})
    .map(([site,[x,z]])=>[site,Object.freeze({x,z,w:4,d:3.2})]),
));

export function constructionLot(site, layout) {
  if (layout) return Object.hasOwn(layout.lots,site) ? layout.lots[site] : null;
  return Object.hasOwn(CONSTRUCTION_LOTS,site)?CONSTRUCTION_LOTS[site]:null;
}

export function overlapsLot(a,b,pad=0) {
  return a.x-pad<b.x+b.w && a.x+a.w+pad>b.x &&
    a.z-pad<b.z+b.d && a.z+a.d+pad>b.z;
}

export const TOWN_SIZE=Object.freeze({width:120,depth:80});

export const RESIDENT_HOMES=Object.freeze({
  p1:Object.freeze({room:'house1',at:[83,43]}),
  a1:Object.freeze({room:'house2',at:[95,43]}),
  a2:Object.freeze({room:'house3',at:[83,56]}),
  a3:Object.freeze({room:'house4',at:[95,56]}),
});

export const HOUSING_PLOTS = Object.freeze({
  ...Object.fromEntries(Object.values(RESIDENT_HOMES).map(h => [h.room, h.at])),
  house5: [107,43], house6: [107,56],
  house7: [83,69], house8: [95,69], house9: [107,69],
});

export function residentialSite(room, peripheralHomes) {
  if (Object.hasOwn(HOUSING_PLOTS,room)) return HOUSING_PLOTS[room];
  return peripheralHomes && Object.hasOwn(peripheralHomes,room) ? peripheralHomes[room] : null;
}

export const TIMBER_GROVE=Object.freeze([
  {id:'grove1',x:13.5,z:43.5,site:'yard'},
  {id:'grove2',x:16.5,z:44.5,site:'yard'},
  {id:'grove3',x:12.5,z:47.5,site:'yard'},
  {id:'grove4',x:16.5,z:49.5,site:'yard'},
  {id:'grove5',x:20.5,z:50.5,site:'garden'},
  {id:'grove6',x:24.5,z:52.5,site:'garden'},
].map(Object.freeze));

export const CURRENT_LAYOUT=2;

export function generateCampLayout(seed,version=1) {
  const pick = (key,min,max) => min + Math.floor(campHash(seed,key)*(max-min+1));
  const {river}=campTerrain(seed,false,version);
  const hubZ=pick('hub-z',20,36), crossZ=hubZ+pick('cross-z',7,10);
  const bank=Math.min(...Array.from({length:14},(_,i)=>river(hubZ-8+i)));
  const hubX=Math.min(pick('hub-x',19,31),Math.floor(bank)-21);
  const crossing=river(crossZ+.5);
  const sites={
    home:[hubX,hubZ], hall:[hubX+7,hubZ], store:[hubX+14,hubZ],
    yard:[pick('yard-x',16,20),crossZ+pick('yard-z',1,4)],
    garden:[Math.floor(river(crossZ+12))-9,crossZ+pick('garden-z',10,13)],
    well:[Math.ceil(crossing)+pick('well-x',7,10),crossZ],
    workshop:[pick('work-x',66,76),crossZ+pick('work-z',12,16)],
    watch:[pick('watch-x',66,77),pick('watch-z',14,23)],
  };
  sites.workshop[0]=Math.max(sites.workshop[0],sites.well[0]+9);
  const suburbX=pick('houses-x',86,93), north=pick('district',0,1)===0;
  const suburbZ=north?pick('north-z',14,23):pick('south-z',37,48);
  const lots={}, links=[
    ['home','hall',[]],['hall','store',[]],['home','yard',[]],['yard','garden',[]],
    ['store','westBank',[[sites.store[0],crossZ]]],['westBank','well',[]],
    ['garden','westBank',[[sites.garden[0],crossZ+3]]],['well','workshop',[]],
    ['well','watch',[[sites.watch[0],crossZ]]],
  ];
  const nodes={westBank:[Math.floor(crossing)-5,crossZ]};
  const rows=north?[0,12,24]:[0,11,22];
  const streetX=suburbX-5;
  for (let row=0;row<3;row+=1) {
    const z=suburbZ+rows[row];
    const lane=`lane${row}`;
    nodes[lane]=[streetX,z];
    if (row) links.push([`lane${row-1}`,lane,[]]);
    else links.push([north?'watch':'workshop',lane,[[streetX,north?sites.watch[1]:sites.workshop[1]]]]);
    for (let col=0;col<3;col+=1) {
      const id=`house${row*3+col+1}`;
      sites[id]=[suburbX+col*11+pick(`${id}-x`,-1,1),z];
      links.push([lane,id,[]]);
    }
  }
  if (version>=2) {
    // Nine separated building parcels distributed along a seeded, branching lane.
    const lanes=Array.from({length:3},(_,row)=>[
      pick('v2-lane-x'+row,87,91), 18+row*22+pick('v2-lane-z'+row,-2,2),
    ]);
    const parcels=lanes.flatMap(([x,z],row)=>Array.from({length:3},(_,col)=>({
      row,at:[x+col*11+pick('parcel-x'+row+':'+col,-1,1),
        z+pick('parcel-z'+row+':'+col,-4,4)],
    })));
    parcels.sort((a,b)=>campHash(seed,'deed:'+a.at.join(','))-campHash(seed,'deed:'+b.at.join(',')));
    for (let i=links.length-1;i>=0;i--) if (links[i][0].startsWith('lane') || links[i][1].startsWith('lane')) links.splice(i,1);
    for (const [row,[x,z]] of lanes.entries()) {
      nodes['lane'+row]=[x-4,z];
      links.push([row?'lane'+(row-1):'workshop','lane'+row,[]]);
    }
    for (const [i,{row,at}] of parcels.entries()) {
      const room='house'+(i+1);
      sites[room]=at;
      links.push(['lane'+row,room,[]]);
    }
  }
  for (const [room,[dx,dz]] of Object.entries({yard:[6,2],garden:[-7,10],watch:[-8,-3],well:[-3,4]})) {
    const [x,z]=sites[room];
    lots[room]={x:x+dx,z:z+dz,w:4,d:3.2};
  }
  const [,gz]=sites.yard, groveX=pick('grove-x',5,7);
  const grove=TIMBER_GROVE.map((tree,i)=>({
    ...tree, x:groveX+(i%3)*2.6+pick(`tree-x${i}`,-1,1)*.5,
    z:gz+9+Math.floor(i/3)*3.7+pick(`tree-z${i}`,-1,1)*.5,
  }));
  nodes.grove=[groveX+2,gz+7];
  links.push(['yard','grove',[]]);
  return {sites,lots,grove,nodes,links,crossZ};
}
