import test from 'node:test';
import assert from 'node:assert/strict';
import { modelMesh, MODEL_STRIDE, campCamera, regionOnScreen, collisionFootprint } from '../web/camp-3d-render.mjs';
import { contactShadowMesh, groundContactMesh, materialGrain, roomExposure } from '../web/camp-lighting.mjs';
import { solarLight } from '../web/camp-sun.mjs';
import { outdoorHomes, outdoorStage } from '../shared/camp-scene.mjs';

test('接触阴影只贴接地物，桥桩伸入地面且井沿高于井水',()=>{
  const cast=[{x:1,y:0,z:2,w:2,d:1,h:.35},{x:1,y:2,z:2,w:1,d:1,h:.2}];
  const mesh=groundContactMesh({source:cast,x:2,z:2,height:()=>0});
  assert.equal(mesh.length,24*MODEL_STRIDE);
  assert.ok(Array.from(mesh).filter((_,i)=>i%MODEL_STRIDE===1).every(y=>Math.abs(y-.024)<1e-6));
  const stage=outdoorStage({tw:24,th:24,sites:{well:[14,16]},trees:[],grass:[],height:()=>-.27},
    [[2,3,8,5]],[]);
  const posts=stage.boxes.filter(b=>b.color==='#5B4434' && b.z<5 && b.h>.4);
  assert.equal(posts.length,4);
  assert.ok(posts.every(b=>b.y<-.27 && Math.abs(b.y+b.h-.30)<1e-8));
  // 井沿/井台在遮挡分件后归 wall:well（roof:well 是井盖），见 shared/camp-scene.mjs outdoorFixture。
  const water=stage.boxes.find(b=>b.water), rim=stage.boxes.filter(b=>b.occluder==='wall:well' && b.color==='#939584');
  assert.ok(water && rim.some(b=>b.y<=water.y && b.y+b.h>water.y+water.h));
  assert.ok(roomExposure(false,1)<roomExposure(true,1));
  assert.ok(roomExposure(false,0,1)>roomExposure(false,0,0));
});

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
    assert.equal(contactShadowMesh(geometry,morning,{soft:true}).length,3*24*MODEL_STRIDE); // soft shadow
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

test('日出时高物体的投影比低物体更长，接地点仍邻接底座',()=>{
  const sun=solarLight(3.36,24,0);
  const shadow=h=>contactShadowMesh({source:[{...source[0],h}],x:4,z:5,height:()=>0},sun);
  const extent=mesh=>{
    const xs=Array.from(mesh).filter((_,i)=>i%MODEL_STRIDE===0);
    return [Math.min(...xs),Math.max(...xs)];
  };
  const [lowMin,lowMax]=extent(shadow(.3));
  const [tallMin,tallMax]=extent(shadow(4));
  assert.ok(tallMin<lowMin-2);
  assert.equal(tallMax,lowMax);
  assert.ok(tallMax>source[0].x+source[0].w);
});

test('只有住人住宅的真实发光窗会提供室外暖光位置',()=>{
  const world={};
  assert.deepEqual(outdoorHomes(world,[['house1',false,0]]).windows,[]);
  const home=outdoorHomes(world,[['house1',true,0]]);
  assert.equal(home.windows.length,2);
  for (const [x,z,halfWidth,h] of home.windows) {
    assert.ok(home.boxes.some(box=>box.glow && box.part.startsWith('window-') &&
      Math.abs(box.x+halfWidth-x)<1e-8 && Math.abs(box.z+box.d-z)<1e-8 && box.y===h));
  }
});
