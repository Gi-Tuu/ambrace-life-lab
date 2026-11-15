// 点哪走哪寻路内核闸门：纯函数、可在 Node 直跑（不依赖浏览器可见与否）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { astar, isWalkable, stepWalker, walkDirection } from '../web/walk.mjs';

import { actorBoxes, rayBox } from '../web/camp-3d-render.mjs';
import { moveMapFeet } from '../web/collision.mjs';

const open = (tw, th) => ({ tw, th, walk: new Uint8Array(tw * th).fill(1) });
const block = (w, x, y) => { w.walk[y * w.tw + x] = 0; return w; };

test('K1 空格直线：起终点曼哈顿距离即路径长，逐格相邻、终于目标', () => {
  const w = open(8, 8);
  const path = astar(w, [0, 0], [7, 7]);
  assert.ok(path, '应可达');
  assert.equal(path.length, 14);                 // 7 右 + 7 上，不含起点
  assert.deepEqual(path[path.length - 1], [7, 7]);
  let prev = [0, 0];
  for (const [x, y] of path) {
    assert.equal(Math.abs(x - prev[0]) + Math.abs(y - prev[1]), 1, '每步必须 4 邻接');
    prev = [x, y];
  }
});

test('K2 一堵墙留缝：绕行穿过缺口；封死则不可达返回 null', () => {
  const w = open(9, 5);
  for (let y = 0; y < 5; y += 1) if (y !== 2) block(w, 4, y);   // x=4 全堵，只留 y=2 缺口
  const path = astar(w, [0, 2], [8, 2]);
  assert.ok(path && path.length, '缺口应可绕行');
  assert.ok(path.some(([x, y]) => x === 4 && y === 2), '路径必须穿过缺口 (4,2)');
  assert.ok(!path.some(([x, y]) => w.walk[y * w.tw + x] === 0), '不得穿过墙格');

  const sealed = open(9, 5);
  for (let y = 0; y < 5; y += 1) block(sealed, 4, y);
  assert.equal(astar(sealed, [0, 2], [8, 2]), null, '封死必须 null');
});

test('K3 isWalkable：越界与阻挡格为假，可行格为真', () => {
  const w = open(4, 4);
  block(w, 1, 1);
  assert.equal(isWalkable(w, 2, 2), true);
  assert.equal(isWalkable(w, 1, 1), false);
  assert.equal(isWalkable(w, -1, 0), false);
  assert.equal(isWalkable(w, 0, 4), false);
  assert.equal(isWalkable(w, 1.6, 1.2), false, '取整后落在阻挡格');
});

test('K4 起终重合返回空路径；目标不可走返回 null', () => {
  const w = open(5, 5);
  assert.deepEqual(astar(w, [2, 2], [2, 2]), []);
  block(w, 4, 4);
  assert.equal(astar(w, [0, 0], [4, 4]), null);
});

test('K5 stepWalker：沿路径匀速推进、置 moving、按横向翻面、到点后停', () => {
  const s = { x: 0, y: 0, path: [[1, 0], [2, 0], [2, 1]], pi: 0, moving: false, face: 1 };
  stepWalker(s, 0.5);
  assert.equal(s.moving, true);
  assert.ok(s.x > 0 && s.x < 1, '应朝首个航点推进但未越过');
  assert.equal(s.face, 1, '向东走 face=1');
  // 跳到最后一个航点前：一步逼近 (2,1)，再一步到位并停
  s.x = 2; s.y = 0; s.pi = 2;
  stepWalker(s, 0.5);
  assert.equal(s.moving, true);
  assert.ok(s.y > 0 && s.y < 1, '朝 (2,1) 推进但未到');
  stepWalker(s, 0.5);
  assert.deepEqual([s.x, s.y], [2, 1], '最后一步吸附到航点');
  assert.equal(s.pi, 3);
  assert.equal(s.moving, false, '走完必须停');
  // 向西翻面
  const s2 = { x: 0, y: 0, path: [[-1, 0]], pi: 0, moving: false, face: 1 };
  stepWalker(s2, 0.5);
  assert.equal(s2.face, -1, '向西走 face=-1');
});

test('八方向使用实际位移；斜走等速且受原碰撞约束', () => {
  const offsets=[[0,1],[-1,1],[-1,0],[-1,-1],[0,-1],[1,-1],[1,0],[1,1]];
  const names=['down','down-left','left','up-left','up','up-right','right','down-right'];
  const w=open(10,10);
  for (const [i,[dx,dz]] of offsets.entries()) {
    const unit=Math.hypot(dx,dz);
    const [x,z]=moveMapFeet(w,4,4,dx/unit*.2,dz/unit*.2);
    assert.ok(Math.abs(Math.hypot(x-4,z-4)-.2)<1e-9);
    assert.equal(walkDirection(x-4,z-4),names[i]);
  }
  const [x,z]=moveMapFeet(w,4,4,.2,.2,(ox,oz,nx)=>nx===ox);
  assert.equal(walkDirection(x-4,z-4),'down');
  assert.equal(walkDirection(0,0,'up-right'),'up-right');
});

test('斜向身体使用旋转后的几何命中，四种斜向分别绕脚下旋转', () => {
  for (const [direction,turn] of [['down-left',1],['up-left',3],['up-right',5],['down-right',7]]) {
    const boxes=actorBoxes({x:8,y:0,z:12,direction,color:'#FFF1E8',moving:true},1);
    const nose=boxes.find(b=>b.color==='#D8B27C');
    const yaw=turn*Math.PI/4;
    assert.equal(nose.yaw,yaw);
    const dx=nose.x+nose.w/2-8, dz=nose.z+nose.d/2-12;
    const x=8+dx*Math.cos(yaw)-dz*Math.sin(yaw), z=12+dx*Math.sin(yaw)+dz*Math.cos(yaw);
    assert.ok(rayBox([x,3,z],[0,-1,0],nose)>2);
    assert.equal(rayBox([nose.x+nose.w/2,3,nose.z+nose.d/2],[0,-1,0],nose),null);
  }
});
