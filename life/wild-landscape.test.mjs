import test from 'node:test';
import assert from 'node:assert/strict';
import { createCampOutskirts, moveJoinedWalker } from '../web/camp-outskirts.mjs';
import { bodyGrid } from '../web/camp-3d-physics.mjs';
import { campTerrain } from '../web/camp-terrain.mjs';
import { moveWildWalker, regionWindow, wildDetails, wildLandscape, wildRegion, REGION_SIZE } from '../web/wild-landscape.mjs';

function vertices(mesh) {
  const result=[];
  for (let i=0;i<mesh.length;i+=11) result.push([mesh[i],mesh[i+1],mesh[i+2],mesh[i+10]]);
  return result;
}

test('荒野区块独立重现，接缝与脚底共享高度，负坐标区块可加载',()=>{
  const a=wildLandscape(13,1), b=wildLandscape(13,1), c=wildLandscape(42,1);
  const west=wildRegion(a,-1,-1), east=wildRegion(a,0,-1);
  assert.deepEqual(west,wildRegion(b,-1,-1));
  assert.notDeepEqual(west,wildRegion(c,-1,-1));
  const seam=mesh=>new Map(vertices(mesh).filter(([x,,z,water])=>x===0 && z>=-24 && z<=0 && water===0)
    .map(([x,y,z])=>[z,y]).sort((a,b)=>a[0]-b[0]));
  assert.deepEqual(seam(west),seam(east));
  for(const [z,y] of seam(west)) assert.ok(Math.abs(y-a.height(0,z))<1e-5);
  assert.ok(regionWindow(-.1,-.1).some(b=>b.key==='-1:-1' && b.near));
  assert.equal(regionWindow(0,0).length,25);
  assert.equal(regionWindow(0,0).filter(b=>b.near).length,9);
});

test('主河沿用聚落河轴，北谷支流汇入主河且南端生成瀑布',()=>{
  for(const seed of [0,7,13,27,42,51]) {
    const a=wildLandscape(seed,1), old=campTerrain(seed,false,1);
    for(const z of [0,24,79]) assert.equal(a.river(z),old.riverCenter(z*16)/16);
    assert.equal(a.sideStream(a.junction),a.river(a.junction));
    const branch=(a.branchSource+a.junction)/2;
    assert.ok(a.channel(a.sideStream(branch),branch)>0);
    assert.ok(a.waterHeight(a.source)>a.waterHeight(a.fall));
    const mesh=wildRegion(a,Math.floor(a.river(a.fall)/REGION_SIZE),Math.floor(a.fall/REGION_SIZE));
    assert.ok(vertices(mesh).some(([,y,,material])=>material===-2 && y<-20));
  }
});

test('移动沿桥过河，河面、三侧山脊、南崖和树干挡住行走',()=>{
  const a=wildLandscape(7,1), z=24, x=a.river(z), close=a.river(19);
  assert.ok(!a.walkable(close,19));
  const across=moveWildWalker(a,x-5,z,10,0,z);
  assert.ok(across[0]>x+4);
  assert.ok(!a.walkable(-236,18) && !a.walkable(355,18) && !a.walkable(66,-218));
  assert.ok(a.southEdge(25)!==a.southEdge(60));
  const edge=a.southEdge(65);
  assert.ok(!a.walkable(65,edge+.2));
  const before=moveWildWalker(a,65,edge-8,0,20,z);
  assert.ok(before[1]<edge-1);
  const trees=wildDetails(a,2,1,z).boxes.filter(b=>b.solid);
  assert.ok(trees.length>0);
  for(const b of trees) assert.ok(!a.walkable(b.x+b.w/2,b.z+b.d/2,z));
});

test('同一地表覆盖村内和村外，建筑地块平整，玩家碰撞能跨区往返',()=>{
  const out=createCampOutskirts(13,2,34,{flatLand:[{x:11,z:12,w:8,d:8}],roadDistance:()=>0}), w=out.terrain;
  assert.equal(w.height(14,15),0);
  assert.ok(wildRegion(w,1,1).length>0);
  const mesh=wildRegion(w,1,3);
  assert.ok(vertices(mesh).some(([, ,z])=>z<80));
  assert.ok(vertices(mesh).some(([, ,z])=>z>80));
  assert.ok(mesh.some((v,i)=>i%11===8 && v>1));
  for (const [x,z] of [[0,24],[120,32],[22,0],[70,80]]) {
    assert.ok(Math.abs(w.height(x-.05,z)-w.height(x+.05,z))<.1);
    assert.ok(Math.abs(w.height(x,z-.05)-w.height(x,z+.05))<.1);
  }
  assert.ok(out.overview()[0].mesh.length>mesh.length);
  const inside=(x,z)=>x>=0 && x<120 && z>=0 && z<80 && z!==20;
  const x=12,z=79.5;
  const [wx,wz]=moveJoinedWalker(x,z,0,2,inside,out.walkable);
  assert.ok(wz>81);
  const [cx,cz]=moveJoinedWalker(wx,wz,0,-2,inside,out.walkable);
  assert.ok(cz<80 && cx===x);
  assert.ok(out.regions(10,82).length>0);
  assert.strictEqual(out.regions(10,82),out.regions(10,82));
  const grid={tw:32,th:32,walk:new Uint8Array(32*32).fill(1)};
  grid.walk[31*32+25]=0;
  const open=bodyGrid(grid,16,true), closed=bodyGrid(grid,16);
  assert.equal(open.walk[31*32+10],1);
  assert.equal(open.walk[31*32+25],0);
  assert.equal(closed.walk[31*32+10],0);
});

test('外围共用地表材质和树木模型，种子改变山谷、河宽及森林分布',()=>{
  const a=wildLandscape(13,2,{joined:true}), b=wildLandscape(42,2,{joined:true});
  assert.notEqual(a.river(160),b.river(160));
  assert.notEqual(a.width(160),a.width(220));
  for (const z of [0,80]) {
    assert.equal(a.river(z),campTerrain(13,false,2).riverCenter(z*16)/16);
    assert.ok(a.waterHeight(z-1)>=a.waterHeight(z+1));
  }
  const materials=new Set();
  const density=[];
  for (const [x,z] of [[1,4],[2,5],[-1,4],[2,-3],[13,0],[1,13]]) {
    const mesh=wildRegion(a,x,z);
    for (let i=7;i<mesh.length;i+=11) if(mesh[i]>=0) materials.add(mesh[i]);
    density.push(wildDetails(a,x,z,24).boxes.filter(box=>box.solid).length);
  }
  assert.deepEqual([...materials].sort(),[0,1,2]);
  assert.ok(Math.max(...density)>Math.min(...density)+5);
  const trees=wildDetails(a,1,4,24).boxes;
  assert.ok(trees.some(box=>box.solid));
  assert.ok(trees.some(box=>box.wind && box.h>.5));
});

test('同一河面保留深浅水值，湿岸有连续距离，花草和灌木带风动',()=>{
  const w=wildLandscape(13,2,{joined:true}), z=46, x=w.river(z), width=w.sourceWidth(z);
  const mesh=wildRegion(w,Math.floor(x/REGION_SIZE),Math.floor(z/REGION_SIZE));
  const depth=new Set(), bank=[];
  for (let i=0;i<mesh.length;i+=11) {
    if (mesh[i+10]===-1) depth.add(mesh[i+9]);
    if (mesh[i+10]===0) bank.push(mesh[i+9]);
  }
  assert.deepEqual([...depth].sort(),[0,1]);
  assert.ok(bank.some(d=>d>0 && d<.25));
  assert.ok(bank.some(d=>d>.25 && d<.5));
  assert.ok(Math.abs(w.bankGap(x+width+.15,z)-.15)<1e-9);
  const flowerColors=new Set(['#FFEC27','#FF77A8','#FFF0CC','#68ADD4']);
  const detail=wildDetails(w,1,4,24).boxes;
  assert.ok(detail.some(b=>flowerColors.has(b.color) && b.wind && !b.wind.rooted));
  assert.ok(detail.some(b=>b.color==='#6B994D' && b.wind.rooted));
  assert.ok(detail.some(b=>b.h>.3 && b.wind?.rooted));
});
