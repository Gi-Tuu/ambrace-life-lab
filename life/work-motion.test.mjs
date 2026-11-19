import test from 'node:test';
import assert from 'node:assert/strict';
import { createSurvPlay, survAct, survView, dumpSurv, loadSurv, tickSurvPlay } from './survplay.mjs';
import { clockOf } from './resident-time.mjs';
import { actuate } from './body.mjs';
import { campPen, campSite } from '../shared/camp-interaction.mjs';
import { TIMBER_GROVE } from '../shared/camp-layout.mjs';
import { workPlayback, workContact, sampleWork, receiveWork, clipContact } from '../web/camp-work-motion.mjs';
import { actorBoxes, modelMesh } from '../web/camp-3d-render.mjs';

const options={independentWorld:true,ecosystem:true,wildFood:true};
const rows=sp=>survView(sp).workMotions;
test('九种成功劳动各有一条回执，包含实际对象；拒绝和恢复不会重播',()=>{
  const sp=createSurvPlay(13,options),w=sp.world,s=w.survival;
  const check=(body,kind)=>{
    w.t++;
    const seq=rows(sp).at(-1)?.seq??0;
    const result=survAct(sp,body);
    assert.equal(result.ok,true,JSON.stringify(result));
    const last=rows(sp).at(-1);
    assert.equal(last.seq,seq+1); assert.equal(last.kind,kind); assert.equal(last.actor,'p1');
    return last;
  };
  const tree=TIMBER_GROVE[0],lot={x:25,z:27,w:4,d:3.2};
  s.sites=[{loc:'yard',type:'granary',lot,progress:4}];
  assert.deepEqual(check({kind:'build',target:'work:yard:granary',from:[25,30.5]},'hammer').rect,lot);
  assert.deepEqual(check({kind:'camp_chop',target:tree.id,from:[tree.x+1,tree.z],tool:'axe'},'chop').at,[tree.x,tree.z]);
  w.loc.p1='watch';check({kind:'gather',tool:'pick'},'mine');
  const plot=s.plots[0]; plot.growth=0;s.water=1;
  const field={plot:plot.id,from:plot.at};
  assert.equal(check({...field,kind:'camp_plant',tool:'hoe'},'sow').plot,plot.id);
  w.pinv.p1.water=1;s.water=.4;
  check({...field,kind:'camp_water',tool:'bucket'},'water');
  plot.growth=1;
  assert.equal(check({...field,kind:'camp_collect',type:'crop',tool:'basket'},'pick').item,'crop');
  const pen=campPen(campSite('yard')),to=[pen.x+2,pen.z+3];
  for (const [kind,type,target,tool] of [['shear','wool','sheep:0','shears'],['milk','milk','cows:0','bucket']]) {
    s.produce[type]=1;
    const action={kind:'camp_collect',type,target,from:to,to,tool};
    assert.equal(check(action,kind).target,target);
    const before=rows(sp);assert.equal(survAct(sp,action).ok,false);assert.deepEqual(rows(sp),before);
  }
  w.loc.a1=w.loc.p1;w.pinv.p1.wood=2;
  s.requests=[{id:'r',from:'a1',kind:'material',t:w.t}];
  const give=check({kind:'respond_request',id:'r',accept:true},'give');
  assert.equal(give.target,'a1');assert.equal(give.item,'wood');
  s.requests=[{id:'r2',from:'a1',kind:'material',t:w.t}];
  assert.equal(survAct(sp,{kind:'respond_request',id:'r2',accept:false}).code,'DECLINED');
  assert.equal(rows(sp).at(-1).seq,give.seq);
  assert.deepEqual(rows(loadSurv(structuredClone(dumpSurv(sp)),13,options)),[]);
});

test('跨刻劳动等到结算，取消不产生命中；居民采石走同一出口',async()=>{
  const sp=createSurvPlay(7,{...options,actTimeModel:true}),w=sp.world;
  w.loc.p1='watch';
  const gather={kind:'gather',tool:'pick'};
  clockOf(w,'p1').tick.usedMin=59;
  assert.equal(survAct(sp,gather).code,'BUSY_START');assert.deepEqual(rows(sp),[]);
  assert.equal(survAct(sp,{kind:'busy_cancel'}).ok,true);assert.deepEqual(rows(sp),[]);
  w.t++;clockOf(w,'p1').tick.usedMin=59;
  assert.equal(survAct(sp,gather).code,'BUSY_START');
  await tickSurvPlay(sp);
  assert.equal(rows(sp).filter(r=>r.actor==='p1' && r.kind==='mine').length,1);
  w.loc.a1='well';assert.ok(actuate(w,'a1',{kind:'gather'}).ok);
  assert.equal(rows(sp).at(-1).actor,'a1');assert.equal(rows(sp).at(-1).kind,'mine');
});

test('同刻重复动作按次播放；轮询、全屏和两侧对照不会串播',()=>{
  const play=workPlayback(), base={t:7,actor:'p1',kind:'chop'};
  const events=[1,2,3].map(seq=>({...base,seq}));
  assert.deepEqual(play('A',7,events.slice(0,1),0),[]);
  assert.equal(play('A',7,events,.1)[0].row.seq,2);
  assert.equal(play('A',7,structuredClone(events),1.1)[0].row.seq,3);
  assert.deepEqual(play('A',7,events,2.2),[]);
  assert.deepEqual(workPlayback()('B',7,events,.1),[]);
  assert.deepEqual(play('new',7,events,3),[]);
});

test('九种姿势可投影为有限顶点；特效从接触帧开始，锤击/砍伐/采石轨迹不同',()=>{
  const p={who:'a1',x:0,y:0,z:0,color:'#98BD51',direction:'down'};
  const poses=new Set(), chips=new Set();
  for (const [kind,item] of [['hammer'],['chop'],['mine'],['sow'],['water'],['pick','berry'],['shear','wool'],['milk','milk'],['give','wood']]) {
    const row={kind,item,seq:1}, contact=[.62,.63,.18];
    const prep=sampleWork(p,row,.22,contact), hit=sampleWork(p,row,.64,contact);
    assert.equal(prep.fx.length,0,kind);assert.ok(hit.fx.length>0,kind);
    poses.add(JSON.stringify(prep.body));chips.add(JSON.stringify(hit.fx));
    const mesh=[];
    for (const box of [...actorBoxes({...p,stroke:hit,direction:hit.direction},1),...hit.fx]) modelMesh(mesh,box);
    assert.ok(mesh.length && mesh.every(Number.isFinite),kind);
  }
  assert.equal(poses.size,9);assert.equal(chips.size,9);
  const receiver={...p,x:1,who:'a2'}, give={kind:'give',item:'wood'};
  assert.ok(receiveWork(receiver,p,give,.82,[.8,.77,0]).body.length >
    receiveWork(receiver,p,give,.20,[.8,.77,0]).body.length,'物品在交接后进入接收者手中');
  const context={stage:{},animals:[],people:[p],heightAt:()=>2};
  assert.deepEqual(workContact({actor:'a1',kind:'water',rect:{x:1,z:1,w:3,d:2}},p,context),[1.08,2.04,1.08]);
  const clip={row:{actor:'a1',kind:'sow',rect:{x:1,z:1,w:3,d:2}}};
  const point=clipContact(clip,p,context);
  assert.deepEqual(clipContact(clip,{...p,x:3},context),point,'固定落点不会随玩家离开而滑动');
  assert.equal(workContact({actor:'p1',room:'yard',kind:'milk'},p,context),null);
  assert.equal(workContact({actor:'a1',kind:'give',target:'gone'},p,context),null);
});
