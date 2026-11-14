import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { beam, boxVertices, collisionFootprint, cyl, modelBounds, modelMesh, rayBox } from '../web/camp-3d-render.mjs';
import { fillCollisionRect } from '../web/asset-collision.mjs';
import { addCampWork } from '../web/camp-3d-scene.mjs';
import { generateCampLayout } from '../web/camp-layout.mjs';

const box={x:1,y:2,z:3,w:2,h:3,d:4,color:'#72513B'};
const close=(a,b)=>assert.ok(Math.abs(a-b)<1e-8, [a,b].join(' vs '));
const positions=mesh=>Array.from({length:mesh.length/11},(_,i)=>mesh.slice(i*11,i*11+3));
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
