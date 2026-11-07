import { simulate } from './run.mjs';
import { createHash } from 'node:crypto';
for (const spec of [{seed:7,ticks:400},{seed:7,ticks:1200},{seed:11,ticks:400}]) {
 const {world,agents}=await simulate({...spec,condition:'C2'});
 const traces=Object.fromEntries(Object.values(agents).map(a=>[a.id,a.trace.filter(r=>r.action).map(r=>({t:r.t,action:r.action,drives:r.drives,m:r.m,viab:r.viab}))]));
 console.log(JSON.stringify({spec,schedule:world.scheduleWeight,sha256:createHash('sha256').update(JSON.stringify(traces)).digest('hex')}));
}
