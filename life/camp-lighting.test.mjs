import test from 'node:test';
import assert from 'node:assert/strict';
import { modelMesh, MODEL_STRIDE, campCamera, regionOnScreen, collisionFootprint } from '../web/camp-3d-render.mjs';
import { contactShadowMesh, materialGrain } from '../web/camp-lighting.mjs';
import { solarLight } from '../web/camp-sun.mjs';

const source=[{x:3,y:0,z:4,w:3,h:.16,d:2,solid:true}];
const axes=(b)=>{
  const data=[];modelMesh(data,b);
  return Array.from({length:5},(_,i)=>data.slice(i*6*MODEL_STRIDE+11,i*6*MODEL_STRIDE+14).map(n=>Math.round(n)||0));
};
test('B′-02 outward normals rotate with geometry and expose different faces to sunlight',()=>{
  const b={...source[0],color:'#72513B'};
  const plain=axes(b), rotated=axes({...b,rot:[0,Math.PI/2,0],pivot:[4.5,0,5]});
  assert.deepEqual(plain,[[0,1,0],[0,0,-1],[1,0,0],[0,0,1],[-1,0,0]]);
  assert.deepEqual(rotated,[[0,1,0],[-1,0,0],[0,0,-1],[1,0,0],[0,0,1]]);
  const light=[1,0,0];
  const diffuse=n=>Math.max(0,n.reduce((sum,x,i)=>sum+x*light[i],0));
  assert.equal(diffuse(plain[2]),1);
  assert.equal(diffuse(rotated[2]),0);
});
test('B′-03 daylight casts a contact mesh, nighttime omits it and footprints are stable',()=>{
  const height=()=>0, geometry={source,x:4,z:5,height};
  const morning=solarLight(3.36,24,0), noon=solarLight(10.68,24,0), evening=solarLight(18,24,0), night=solarLight(23,24,0);
  assert.deepEqual([morning,noon,evening,night].map(s=>s.phase),['日出','白昼','日落','夜晚']);
  assert.equal(morning.sunVector[0]>0,true);
  assert.equal(evening.sunVector[0]<0,true);
  const footprint=collisionFootprint(source[0],16);
  const mesh=contactShadowMesh(geometry,morning);
  assert.equal(mesh.length,24*MODEL_STRIDE);
  assert.ok(mesh[0]<4.5);
  assert.ok(contactShadowMesh(geometry,evening)[0]>4.5);
  assert.ok(contactShadowMesh(geometry,noon).length>0);
  assert.equal(contactShadowMesh(geometry,night).length,0);
  assert.deepEqual(collisionFootprint(source[0],16),footprint);
  assert.equal(source.length,1);
});
test('material texture is deterministic and camera clipping keeps partly visible regions',()=>{
  const pixels=materialGrain();
  assert.deepEqual(pixels,materialGrain());
  assert.notDeepEqual(pixels.slice(0,2048),pixels.slice(2048));
  const camera=campCamera({x:0,z:0,width:960,height:540,span:20});
  assert.equal(regionOnScreen([0,0,0,20,3,8],camera,960,540),true);
  assert.equal(regionOnScreen([90,0,90,120,6,120],camera,960,540),false);
});
