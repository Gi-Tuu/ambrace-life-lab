import test from 'node:test';
import assert from 'node:assert/strict';
import { distanceToRect } from '../shared/camp-interaction.mjs';
import { workPoints, entrancePoints } from '../shared/camp-construction-access.mjs';
import { planApproach, guideGeometry, GUIDE_COLORS } from '../web/camp-guidance.mjs';
import { modelMesh } from '../web/camp-3d-render.mjs';

const rect={x:10,z:8,w:4,d:3};
const lot={kind:'lot',rect,reach:1.15,at:[12,9.5]};
const from=[12,14];

test('提示的操作位与寻路终点同源，搜索会跳过第一处受阻和路线不通的候选',()=>{
  const clear=()=>true;
  const near=planApproach(lot,from,clear);
  assert.ok(workPoints(rect).some(p=>p.every((v,i)=>v===near.point[i])));
  const route=point=>distanceToRect(point,rect)<=1.15 && point[0]!==near.point[0] ? [point] : null;
  const result=planApproach(lot,from,clear,route);
  assert.notDeepEqual(result.point,near.point);
  assert.deepEqual(result.path.at(-1),result.point);
  const preferred=workPoints(rect).at(-2);
  assert.deepEqual(planApproach(lot,from,clear,p=>[p],preferred).point,preferred);
  assert.deepEqual(planApproach(lot,from,()=>false),{blockedAt:near.point});
  assert.deepEqual(planApproach(lot,from,clear,()=>null),{unreachableAt:near.point});
});

test('入口只取门口区域中的有效站位，地块标线与红叉贴合地表',()=>{
  const door={kind:'door',rect:{x:2,z:3,w:1.6,d:1},at:[2.8,3.72],reach:.1};
  const side=entrancePoints(door.rect)[1];
  const plan=planApproach(door,[2.8,5],(x,z)=>x===side[0]&&z===side[1],p=>[p]);
  assert.deepEqual(plan.point,side);
  const hints=[{kind:'outline',rect},{kind:'door',point:side},{kind:'block',point:[2,3]}];
  const height=(x,z)=>x*.125+z*.03;
  const geometry=guideGeometry(hints,height);
  const colors=new Set(geometry.map(box=>box.color));
  for (const {kind} of hints) assert.ok(colors.has(GUIDE_COLORS[kind]));
  for (const box of geometry) {
    assert.ok(box.y>=height(box.pivotX,box.pivotZ)+.08);
    assert.equal(box.solid,undefined);
  }
  const mesh=[];
  for (const box of geometry) modelMesh(mesh,box);
  assert.ok(mesh.length && mesh.every(Number.isFinite));
});
