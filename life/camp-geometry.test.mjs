import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { beam, boxVertices, collisionFootprint, MODEL_STRIDE, cyl, modelBounds, modelMesh, rayBox } from '../web/camp-3d-render.mjs';
import { fillCollisionRect } from '../shared/asset-collision.mjs';
import { addCampWork } from '../shared/camp-scene.mjs';
import { outdoorStage, wildVegetation, roomStage, outdoorLife, regionLife } from '../shared/camp-scene.mjs';
import { itemBoxes } from '../shared/camp-items.mjs';
import { generateCampLayout } from '../shared/camp-layout.mjs';

const box={x:1,y:2,z:3,w:2,h:3,d:4,color:'#72513B'};
const close=(a,b)=>assert.ok(Math.abs(a-b)<1e-8, [a,b].join(' vs '));
const positions=mesh=>Array.from({length:mesh.length/MODEL_STRIDE},(_,i)=>mesh.slice(i*MODEL_STRIDE,i*MODEL_STRIDE+3));
const meshOf=part=>{const out=[];if(part) modelMesh(out,part);return out;};

test('A′-01 three-axis vertices and inverse picking agree with rotation about a nonzero pivot',()=>{
  const pivot=[1,2,3], rot=[Math.PI/2,Math.PI/2,Math.PI/2];
  const rotated={...box,pivot,rot};
  const before=boxVertices(box), after=boxVertices(rotated);
  for (let i=0;i<8;i++) {
    const [x,y,z]=before[i];
    const expected=[1+z-3,2+y-2,3-(x-1)];
    after[i].forEach((n,j)=>close(n,expected[j]));
  }
  // Rz(pi/2) Ry(pi/2) Rx(0) maps relative (x,y,z) to (-y,z,-x).
  const second=boxVertices({...box,pivot,rot:[0,Math.PI/2,Math.PI/2]});
  before.forEach(([x,y,z],i)=>{
    second[i].forEach((n,j)=>close(n,[1-(y-2),2+z-3,3-(x-1)][j]));
  });
  close(rayBox([2,3,7],[0,0,-1],rotated),4);
  assert.equal(rayBox([.5,3,7],[0,0,-1],rotated),null);
});

test('A′-02 cylinder and diagonal beam emit capped polygons with the clamped segment count',()=>{
  for (const axis of ['x','y','z']) {
    const b=cyl(1,2,3,.3,2,'#72513B',4,axis);
    assert.equal(b.segments,6);
    assert.equal(positions(meshOf(b)).length,6*12);
    close(rayBox(b.to.map((n,i)=>n+b.unit[i]),b.unit.map(n=>-n),b),1);
  }
  const b=beam([1,1,1],[3,4,2],.4,'#72513B',8);
  assert.equal(positions(meshOf(b)).length,96);
  assert.equal(rayBox([9,9,9],[0,1,0],b),null);
});

test('A′-03 zero-length or zero-radius primitives emit no triangles',()=>{
  assert.deepEqual(meshOf(beam([1,2,3],[1,2,3],.5,'#72513B')),[]);
  assert.equal(cyl(1,2,3,0,3,'#72513B'),null);
  assert.equal(cyl(1,2,3,.5,0,'#72513B'),null);
});

test('A′-04 collision stamps the same AABB as an axis-aligned box',()=>{
  const b={...box,z:4,d:1,rot:[0,Math.PI/4,0],pivot:[2,2,4.5],solid:true};
  const aabb=modelBounds(b);
  close(aabb.x,2-1.5/Math.sqrt(2));
  close(aabb.z,4.5-1.5/Math.sqrt(2));
  close(aabb.w,3/Math.sqrt(2));
  close(aabb.d,3/Math.sqrt(2));
  const grid=footprint=>{
    const data=new Uint8Array(96*96).fill(1);
    fillCollisionRect(data,96,96,...footprint,0);
    return data;
  };
  const expected=[Math.floor(aabb.x*16),Math.floor(aabb.z*16),
    Math.ceil((aabb.x+aabb.w)*16)-Math.floor(aabb.x*16),Math.ceil((aabb.z+aabb.d)*16)-Math.floor(aabb.z*16)];
  assert.deepEqual(grid(collisionFootprint(b,16)),grid(expected));
  // An OBB-only stamp leaves the corner free, unlike the collision contract.
  const corner=[(expected[0]+1)/16,(expected[1]+1)/16];
  assert.equal(grid(expected)[(expected[1]+1)*96+expected[0]+1],0);
  assert.equal(rayBox([corner[0],10,corner[1]],[0,-1,0],b),null);
});

for (const [type,ridgeZ,ridgeY] of [['granary',1.6,3.54],['shelter',1.455,3.18]]) {
test(`${type} roof has joined slopes, a visible damage opening and no roof before completion`,()=>{
  const bake=(record)=>{
    const boxes=[];
    addCampWork(boxes,{buildings:[{type,loc:'yard',lot:{x:0,z:0,w:4,d:3.2},...record}],sites:[]},[]);
    return boxes;
  };
  const panels=boxes=>boxes.filter(b=>b.rot && b.h===.13);
  const complete=panels(bake({integrity:1})), damaged=panels(bake({integrity:.5}));
  assert.equal(complete.length,8);
  assert.equal(damaged.length,complete.length);
  assert.equal(damaged.filter((b,i)=>b.d<complete[i].d).length,1);
  assert.ok(damaged.every((b,i)=>b.d>complete[i].d*.4),'one section opens while the ridge stays covered');
  assert.equal(complete.filter(b=>b.rot[0]>0).length,4);
  assert.equal(complete.filter(b=>b.rot[0]<0).length,4);
  for (const b of complete) {
    const half=b.d*Math.cos(b.rot[0])/2, rise=b.d*Math.abs(Math.sin(b.rot[0]))/2;
    const ridge=b.pivot[2]-Math.sign(b.rot[0])*half;
    assert.ok(Math.abs(ridge-ridgeZ)<1e-9);
    assert.ok(Math.abs(b.pivot[1]+rise-ridgeY)<1e-9);
    assert.equal(b.solid,false);
  }
  for (const progress of [0,3]) assert.equal(panels(bake({progress})).length,0);
});
}

test('granary doorway recesses the door behind two jambs without adding collision',()=>{
  for (const integrity of [1,.5]) {
    const boxes=[];
    addCampWork(boxes,{buildings:[{type:'granary',loc:'yard',lot:{x:0,z:0,w:4,d:3.2},integrity}],sites:[]},[]);
    const door=boxes.find(b=>b.color==='#AB5236' && b.w===.84);
    const jambs=boxes.filter(b=>b.w===.14 && b.h===1.42 && b.d===.20);
    assert.equal(jambs.length,2);
    for(const jamb of jambs){
      assert.ok(jamb.z+jamb.d > door.z+door.d+.1);
      assert.equal(jamb.solid,false);
    }
    assert.ok(jambs[0].x+jambs[0].w <= door.x+1e-9);
    assert.ok(jambs[1].x >= door.x+door.w-1e-9);
  }
});

test('shelter entry frames clear the door and leave storm shutters unobstructed',()=>{
  for (const weather of ['clear','rain']) {
    const boxes=[];
    addCampWork(boxes,{weather,buildings:[{type:'shelter',loc:'yard',lot:{x:0,z:0,w:4,d:3.2},integrity:1}],sites:[]},[]);
    const door=boxes.find(b=>b.color==='#AB5236' && b.w===.8);
    const jambs=boxes.filter(b=>b.w===.14 && b.h===1.48 && b.d===.20);
    assert.equal(jambs.length,2);
    assert.ok(jambs[0].x+jambs[0].w<=door.x+1e-9);
    assert.ok(jambs[1].x>=door.x+door.w-1e-9);
    assert.ok(jambs.every(b=>!b.solid && b.z+b.d>door.z+door.d+.1));
    const sills=boxes.filter(b=>b.w===.68 && b.h===.08 && b.y===.97);
    assert.equal(sills.length,2);
    for(const shutter of boxes.filter(b=>b.part?.startsWith('storm-shutter-'))) {
      assert.ok(sills.every(sill=>sill.y+sill.h<=shutter.y+1e-9));
    }
  }
});

test('granary octagonal barrels follow stock tiers and stay within the original footprint',()=>{
  for(const [store,count] of [[0,0],[1,0],[12,1],[24,2]]) {
    const boxes=[];
    addCampWork(boxes,{store,storeCap:24,buildings:[{type:'granary',loc:'yard',lot:{x:0,z:0,w:4,d:3.2},integrity:1}],sites:[]},[]);
    const barrels=boxes.filter(b=>b.shape && b.r>=.21 && b.r<=.25 && b.from[1]<.7);
    assert.equal(barrels.length,count*5);
    for(const b of barrels){
      assert.equal(b.segments,8);
      assert.ok(b.bounds.w<=.5+1e-9 && b.bounds.d<=.5+1e-9);
      assert.ok(b.bounds.y>=.02-1e-9 && b.bounds.y+b.bounds.h<=.7+1e-9);
      assert.ok(!b.solid);
    }
  }
});

test('hall roof becomes joined slopes but keeps its open ends and posts',()=>{
  const world={tw:24,th:24,hills:[],trees:[],grass:[],sites:{hall:[10,14]}};
  const a=outdoorStage(world,[],[]), b=outdoorStage(world,[],[]);
  assert.equal(JSON.stringify(a.boxes),JSON.stringify(b.boxes));
  const roofBoxes=a.boxes.filter(p=>p.occluder==='roof:hall');
  const panels=roofBoxes.filter(p=>p.rot && p.h===.13);
  assert.equal(panels.length,8);
  assert.ok(panels.every(p=>Math.abs(p.pivot[1]+p.d*Math.abs(Math.sin(p.rot[0]))/2-4.16)<1e-9));
  assert.equal(roofBoxes.filter(p=>p.w===.095 && !p.shape).length,0);
  assert.ok(a.boxes.filter(p=>p.solid).every(p=>p.occluder!=='roof:hall'));
});

test('enrichment pass adds lanterns, scarecrow, root flares and item detail without collision',()=>{
  const lot={x:0,z:0,w:4,d:3.2};
  const boxes=[];
  addCampWork(boxes,{settlementLife:true,buildings:[{type:'shelter',loc:'yard',lot,integrity:1},{type:'granary',loc:'garden',lot,integrity:1}],sites:[],store:12,storeCap:24},[]);
  for (const t of ['shelter','granary']) {
    const g=boxes.filter(b=>b.occluder.endsWith(':'+t));
    assert.ok(g.some(b=>b.glow && b.color==='#FFA300'),t+' lantern');
    assert.ok(g.filter(b=>b.solid).every(b=>b.color!=='#FFA300'));
  }
  const garden=outdoorStage({tw:24,th:24,hills:[],trees:[],grass:[],sites:{garden:[10,14]}},[],[]).boxes;
  assert.ok(garden.some(b=>b.w===.44&&b.h===.07&&b.color==='#8D6A3D'));
  const grove=outdoorStage({tw:24,th:24,hills:[],trees:[[4,4]],grass:[[6,6]],sites:{}},[],[]).boxes;
  assert.ok(grove.some(b=>b.w===.56&&b.h===.1&&b.color==='#5B4434'&&!b.solid));
  const axe=itemBoxes('axe');
  assert.equal(axe.length,6);
  assert.equal(JSON.stringify(axe),JSON.stringify(itemBoxes('axe')));
  assert.ok(axe.every(([, , , , , ,c])=>typeof c==='string'));
});

test('batch refinement adds non-solid detail without touching collision bodies',()=>{
  const lot={x:0,z:0,w:4,d:3.2};
  const boxes=[];
  addCampWork(boxes,{settlementLife:true,buildings:[{type:'house',loc:'yard',lot,integrity:1},{type:'wall',loc:'well',lot,integrity:1}],sites:[],store:12,storeCap:24},[]);
  const home=boxes.filter(b=>b.occluder.endsWith(':house'));
  assert.equal(home.filter(b=>b.w===.14&&b.h===1.42&&b.d===.20).length,2);
  assert.equal(home.filter(b=>b.w===.66&&b.h===.08&&b.y===.97).length,2);
  const wall=boxes.filter(b=>b.occluder.endsWith(':wall'));
  assert.equal(wall.filter(b=>b.h===.09&&b.w===.23).length,6);
  const prop=k=>{const s=roomStage('home',[[k,60,60]],{},16,12);return s.interactables[0].boxes;};
  assert.equal(prop('table').filter(b=>b.h===.07&&b.w===1.36).length,2);
  assert.equal(prop('bed').filter(b=>b.w===.14&&b.h===.52).length,1);
  assert.equal(prop('barrel').filter(b=>b.w===.12&&b.d===.12).length,4);
  assert.equal(prop('fence').filter(b=>b.h===.07&&b.w===.2).length,3);
  assert.equal(prop('cart').filter(b=>b.h===.22&&b.w===.12).length,4);
  for (const k of ['table','bed','barrel','fence','cart']) {
    const a=prop(k), b=prop(k);
    assert.equal(JSON.stringify(a),JSON.stringify(b));
    assert.ok(a.filter(p=>p.solid).every(p=>!p.rot&&!p.shape));
  }
  const life=outdoorLife({tw:24,th:24,sites:{yard:[6,6]},livestock:{chickens:1,cows:1,sheep:1},beds:[],flora:[]});
  const chick=life.animals.find(a=>a.kind==='chickens').boxes;
  assert.equal(chick.filter(b=>b.w===.05&&b.h===.16).length,2);
  const wild=regionLife([],[{kind:'deer',x:5,z:5,y:0},{kind:'rabbit',x:8,z:5,y:0}]);
  const deer=wild.animals.find(a=>a.kind==='deer').boxes;
  assert.equal(deer.filter(b=>b.h===.3&&b.w===.05).length,2);
  const rabbit=wild.animals.find(a=>a.kind==='rabbit').boxes;
  assert.equal(rabbit.filter(b=>b.color==='#D58274').length,2);
});

test('legacy house shells get joined slopes with closed gables',()=>{
  for (const id of ['store','workshop']) {
    const world={tw:24,th:24,hills:[],trees:[],grass:[],sites:{[id]:[10,14]}};
    const a=outdoorStage(world,[],[]), b=outdoorStage(world,[],[]);
    assert.equal(JSON.stringify(a.boxes),JSON.stringify(b.boxes));
    const roofBoxes=a.boxes.filter(p=>p.occluder==='site:'+id && p.rot && p.h===.13);
    assert.equal(roofBoxes.length,8);
    assert.ok(roofBoxes.every(p=>Math.abs(p.pivot[1]+p.d*Math.abs(Math.sin(p.rot[0]))/2-4.2)<1e-9));
    assert.equal(a.boxes.filter(p=>p.occluder==='site:'+id && p.w===.095 && !p.shape).length,32);
  }
});

test('watchtower roof becomes joined slopes over the open deck',()=>{
  const world={tw:24,th:24,hills:[],trees:[],grass:[],sites:{watch:[10,14]}};
  const a=outdoorStage(world,[],[]), b=outdoorStage(world,[],[]);
  assert.equal(JSON.stringify(a.boxes),JSON.stringify(b.boxes));
  const roofBoxes=a.boxes.filter(p=>p.occluder==='roof:watch');
  const panels=roofBoxes.filter(p=>p.rot && p.h===.13);
  assert.equal(panels.length,8);
  assert.ok(panels.every(p=>Math.abs(p.pivot[1]+p.d*Math.abs(Math.sin(p.rot[0]))/2-6.44)<1e-9));
  assert.equal(roofBoxes.filter(p=>p.w===.095 && !p.shape).length,0);
  assert.equal(a.boxes.filter(p=>p.solid).length,8);
});

test('tree canopies vary deterministically while trunks and collision stay fixed',()=>{
  const trees=[[4,4],[8,6],[12,9],[6,14],[15,15],[18,5]];
  const world={tw:24,th:24,hills:[],trees,grass:[],sites:{}};
  const a=outdoorStage(world,[],[]), b=outdoorStage(world,[],[]);
  assert.equal(JSON.stringify(a.boxes),JSON.stringify(b.boxes));
  const tops=new Set(), leans=[];
  for(const [tx,tz] of trees){
    const group=a.boxes.filter(p=>p.occluder===`tree:${tx}:${tz}`);
    const trunk=group.find(p=>p.solid);
    assert.deepEqual([trunk.x,trunk.y,trunk.z,trunk.w,trunk.h,trunk.d],[tx+.5-.2,0,tz+.5-.21,.4,1.88,.42]);
    const canopy=group.filter(p=>!p.solid && p.wind);
    tops.add(Math.max(...canopy.map(p=>p.y+p.h)).toFixed(4));
    const top=canopy.reduce((m,p)=>p.y+p.h>m.y+m.h?p:m);
    leans.push(Math.abs(top.x+top.w/2-(tx+.5)));
  }
  assert.ok(tops.size>=3,[...tops].join(','));
  assert.ok(leans.some(v=>v>.05),leans.join(','));
  const wild=wildVegetation([{x:4.5,y:0,z:4.5,variant:0,scale:.6}],[]);
  const trunk=wild.boxes.find(p=>p.solid);
  assert.ok(Math.abs(trunk.h-1.88*.6)<1e-9);
});

test('workshop tabletop rests on four legs and supports its tool in both damage states',()=>{
  for(const integrity of [1,.5]) {
    const boxes=[];
    addCampWork(boxes,{settlementLife:true,buildings:[{type:'workshop',loc:'yard',lot:{x:0,z:0,w:4,d:3.2},integrity}],sites:[]},[]);
    const top=boxes.find(b=>b.h===.12 && b.d===.55);
    const legs=boxes.filter(b=>b.w===.12 && b.h===.62 && b.d===.12);
    const tool=boxes.find(b=>b.w===.5 && b.h===.08 && b.d===.3);
    assert.equal(legs.length,4);
    for(const leg of legs){
      assert.ok(Math.abs(leg.y+leg.h-top.y)<1e-9);
      assert.ok(leg.x>=top.x && leg.x+leg.w<=top.x+top.w);
      assert.ok(leg.z>=top.z && leg.z+leg.d<=top.z+top.d);
    }
    assert.ok(Math.abs(top.y+top.h-tool.y)<1e-9);
    assert.ok([top,tool,...legs].every(b=>!b.solid));
  }
});

test('workshop roof slopes toward the open front and damage opens a section of one panel',()=>{
  const bake=record=>{
    const boxes=[];
    addCampWork(boxes,{settlementLife:true,buildings:[{type:'workshop',loc:'yard',lot:{x:0,z:0,w:4,d:3.2},...record}],sites:[]},[]);
    return boxes.filter(b=>b.rot && b.h===.13);
  };
  const complete=bake({integrity:1});
  assert.equal(complete.length,4);
  const damaged=bake({integrity:.5});
  assert.equal(damaged.length,complete.length);
  assert.equal(damaged.filter((b,i)=>b.d<complete[i].d).length,1);
  assert.ok(damaged.every((b,i)=>b.d>complete[i].d*.5));
  for (const panel of complete) {
    const rise=panel.d*Math.sin(panel.rot[0])/2;
    assert.ok(Math.abs(panel.pivot[1]+rise-2.95)<1e-9);
    assert.ok(Math.abs(panel.pivot[1]-rise-2.5)<1e-9);
    assert.equal(panel.solid,false);
  }
  for (const progress of [0,3]) assert.equal(bake({progress}).length,0);
});

test('A′-05 same seed and states emit identical vertices and palette-bound accessories',()=>{
  const layout=generateCampLayout(13,2);
  const types=['granary','shelter','workshop','wall'];
  const buildings=['yard','garden','watch','well'].map((loc,i)=>({loc,type:types[i],lot:layout.lots[loc],integrity:1}));
  const world={mapSeed:13,layout,buildings,households:{deeds:{house1:{owner:'p1'}}},settlementLife:true};
  const bake=()=>{const boxes=[];addCampWork(boxes,world);return boxes;};
  const a=bake(), b=bake();
  assert.deepEqual(a.flatMap(meshOf),b.flatMap(meshOf));
  const palette=new Set(JSON.parse(readFileSync(new URL('../web/assets/palette.json',import.meta.url),'utf8')));
  for (const type of [...types,'house']) {
    const accessories=a.filter(b=>b.occluder.endsWith(':'+type) && (b.shape || b.rot));
    assert.ok(accessories.length>0,type);
    assert.ok(accessories.every(b=>palette.has(b.color) && !b.solid),type);
  }
});
