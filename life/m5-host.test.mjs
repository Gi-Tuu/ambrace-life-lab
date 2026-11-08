import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
const fixture=resolve('life/m5-host-fixture.mjs');
function child(mode,dir,enabled){
 const env={...process.env,DATA_DIR:dir,SEED_FILE:join(dir,'no-seed.json'),M5_ENABLED:enabled?'1':'0',TICK_MS:'1000000'};
 const r=spawnSync(process.execPath,[fixture,mode],{env,encoding:'utf8',timeout:30000});
 assert.equal(r.status,0,`${mode} 退出 ${r.status}: ${r.stderr}`);return JSON.parse(r.stdout);
}
test('本地宿主启用→关闭保存→重启启用保留慢状态，休眠只消费一次',()=>{
 const dir=mkdtempSync(join(tmpdir(),'ambrace-m5-host-'));
 const first=child('first',dir,true),off=child('off',dir,false),resume=child('resume',dir,true);
 assert.deepEqual(off.prior,first.saved);assert.deepEqual(resume.before,off.saved);assert.equal(resume.bM5,false);
});
test('旧存档没有 M5 字段时开启后安全初始化',()=>{
 const source=mkdtempSync(join(tmpdir(),'ambrace-m5-src-'));child('first',source,true);
 const raw=JSON.parse(readFileSync(join(source,'world.json'),'utf8'));
 for(const p of ['A','B'])for(const a of Object.values(raw[p].agents))delete a.m5;
 raw.savedAt=Date.now();const target=mkdtempSync(join(tmpdir(),'ambrace-m5-old-'));
 writeFileSync(join(target,'world.json'),JSON.stringify(raw));
 const r=child('legacy',target,true);assert.equal(r.slow,0);assert.equal(r.load,0);
});

test('M5 坏档及延迟不兼容中止启动，任何世界不部分载入且文件不变',()=>{
 const source=mkdtempSync(join(tmpdir(),'ambrace-m5-bad-src-'));child('first',source,true);
 const original=JSON.parse(readFileSync(join(source,'world.json'),'utf8'));
 for(const [name,enabled,mutate] of [
  ['version-on',true,a=>a.version=999],['version-off',false,a=>a.version=999],
  ['delay-on',true,a=>a.delay=9],['scale-on',true,a=>a.slowScale=.1],['v1-on',true,a=>a.version=1],['null-on',true,()=>null]
 ]){
  const raw=structuredClone(original);raw.savedAt=Date.now();raw.A.world.t=123;raw.B.world.t=456;
  const state=raw.A.agents.a3.m5;const result=mutate(state);if(result===null)raw.A.agents.a3.m5=null;
  const dir=mkdtempSync(join(tmpdir(),`ambrace-m5-${name}-`));writeFileSync(join(dir,'world.json'),JSON.stringify(raw));
  assert.match(child('bad',dir,enabled).error,/M5_STATE_INVALID A\/a3/);
 }
});

test('内置种子含坏 M5 时中止启动，不新建世界档案',()=>{
 const source=mkdtempSync(join(tmpdir(),'ambrace-m5-bad-seed-src-'));child('first',source,true);
 const raw=JSON.parse(readFileSync(join(source,'world.json'),'utf8'));raw.B.world.t=456;raw.A.agents.a3.m5.version=99;
 const dir=mkdtempSync(join(tmpdir(),'ambrace-m5-bad-seed-'));writeFileSync(join(dir,'no-seed.json'),JSON.stringify(raw));
 assert.match(child('badseed',dir,true).error,/M5_STATE_INVALID A\/a3/);
});

test('历史 v1 慢仓在关闭态透传，开启不同尺度时拒绝',()=>{
 const source=mkdtempSync(join(tmpdir(),'ambrace-m5-v1-src-'));child('first',source,true);
 const raw=JSON.parse(readFileSync(join(source,'world.json'),'utf8'));raw.savedAt=Date.now();raw.A.agents.a1.m5.version=1;delete raw.A.agents.a1.m5.slowScale;
 const dir=mkdtempSync(join(tmpdir(),'ambrace-m5-v1-'));writeFileSync(join(dir,'world.json'),JSON.stringify(raw));
 const off=child('off',dir,false);assert.equal(off.saved.version,1);assert.equal(off.saved.slowScale,undefined);
 assert.match(child('bad',dir,true).error,/M5_STATE_INVALID A\/a1/);
});
