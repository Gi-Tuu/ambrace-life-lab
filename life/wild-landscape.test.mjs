import test from 'node:test';
import assert from 'node:assert/strict';
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
  const trees=wildDetails(a,2,1,z).boxes.filter(b=>b.color==='#584635');
  assert.ok(trees.length>0);
  for(const b of trees) assert.ok(!a.walkable(b.x+.08,b.z+.08,z));
});
