import test from 'node:test';
import assert from 'node:assert/strict';
import {campSight,sightScene,terrainHit} from '../web/camp-sight.mjs';

test('3D sight crosses the settlement boundary in both directions',()=>{
  for (const edge of [0,120]) {
    const wall={x:edge-.32,y:0,z:19,w:.64,h:2.6,d:2,occluder:'work:wall'};
    const scenes=[sightScene(()=>0,[[wall]]),sightScene(()=>0,[[]])];
    for (const dir of [-1,1]) {
      const mask=campSight(scenes[0],edge+dir*2,20,11), tx=edge-dir*2;
      const at=(x,z)=>mask.bytes[Math.floor((z-mask.origin[1])*2)*mask.size+Math.floor((x-mask.origin[0])*2)];
      assert.equal(mask.sees(tx,20),false);
      assert.equal(at(tx,20),0);
      assert.equal(mask.sees(tx,20,undefined,'work:wall'),true);
      assert.equal(mask.sees(tx,25),true);
      assert.equal(at(tx,25),255);
      assert.equal(campSight(scenes[1],edge+dir*2,20,11).sees(tx,20),true);
    }
  }
});

test('terrain and trees block sight while low crops and grass preserve it',()=>{
  const ridge=sightScene((x,z)=>z>14 && z<17 && x>124 && x<131?3.5:0,[]);
  const mask=campSight(ridge,128,12,11);
  assert.equal(mask.sees(128,20),false);
  assert.equal(mask.sees(122,12),true);
  const tree={x:128,y:0,z:-15,w:.6,h:2.7,d:.6,occluder:'wildtree:128:-15'};
  const crop={...tree,h:.32,occluder:'crop'};
  assert.equal(campSight(sightScene(()=>0,[[tree]]),128.3,-17,11).sees(128.3,-12),false);
  assert.equal(campSight(sightScene(()=>0,[[crop]]),128.3,-17,11).sees(128.3,-12),true);
  assert.equal(campSight(sightScene(()=>0,[]),128.3,-17,5).sees(128.3,-11),false);
});

test('ungrouped solid geometry and a grazing ray across a bin corner block sight',()=>{
  const wall={x:1.93,y:0,z:2.005,w:.068,h:2,d:.45,solid:true};
  const scene=sightScene(()=>0,[[wall]]);
  assert.equal(scene.clear([.14,1,.16],[4.14,1,4.21]),false);
  assert.equal(sightScene(()=>0,[]).clear([.14,1,.16],[4.14,1,4.21]),true);
});

test('terrain picking returns the foreground hill before the object behind it',()=>{
  const origin=[0,8,0], ray=[1,-1,0];
  assert.equal(terrainHit(origin,ray,()=>0,20),8.25);
  assert.equal(terrainHit(origin,ray,x=>x>=3 && x<=5?6:0,20),3);
  assert.equal(terrainHit(origin,ray,()=>0,4),Infinity);
});
