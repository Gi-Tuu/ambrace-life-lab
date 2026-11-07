import test from 'node:test';
import assert from 'node:assert/strict';
import { SelfMaintain } from './viability.mjs';
import { PARAMS } from './params.mjs';
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-12, `${a} != ${b}`);
const life=(v,reserve=0)=>{const x=new SelfMaintain({organs:{},damage:false,v});x.reserve=reserve;return x;};
test('基础代谢按实际余额支付：零余额、部分支付和储能先释放',()=>{
 const z=life(0);z.tick();near(z.upkeepPaid,0);
 const p=life(PARAMS.viab.upkeep/2);p.tick();near(p.upkeepPaid,PARAMS.viab.upkeep/2);near(p.v,0);
 const r=life(PARAMS.viab.upkeep/3,PARAMS.viab.upkeep/3);const before=r.v+r.reserve;r.tick();near(r.upkeepPaid,before-r.v-r.reserve);near(r.upkeepPaid,2*PARAMS.viab.upkeep/3);
 const full=life(.5);full.tick();near(full.upkeepPaid,PARAMS.viab.upkeep);
});
test('基础代谢实付随存档恢复，旧档历史未知不伪装为完整',()=>{
 const a=life(.001);a.tick();const b=life(1);b.restore(a.dump());near(a.upkeepPaid,b.upkeepPaid);assert.equal(b.upkeepAuditComplete,true);
 const old=life(1);old.restore({v:.5,reserve:0,age:100,stage:0,ledger:[]});assert.equal(old.upkeepAuditComplete,false);old.tick();assert.equal(old.upkeepAuditComplete,false);
});
