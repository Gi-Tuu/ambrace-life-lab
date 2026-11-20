#!/usr/bin/env node
// 只读探针：验证 terrainWithNormals 的 Math.hypot → Math.sqrt 替换在真实场景网格上
// 是否逐位相同（Float32 写入后的字节比较）。用于性能优化不改变金样的证据。
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCdpHarness } from './lib/cdp-harness.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'evidence', 'debt-perf');
mkdirSync(OUT, { recursive: true });
const h = createCdpHarness({
  root: ROOT,
  port: 9700 + (process.pid % 150),
  dataPrefix: 'debt-perf-norm-data-',
  profilePrefix: 'debt-perf-norm-chrome-',
  chromeArgs: ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-pipe'],
  serverEnv: { GAME_MODE: 'game', GAME_RULES: '1', BRAIN: 'local', TICK_MS: '10000000', MODEL_UNATTENDED: '0', V73_TEST: '1' },
  readyAttempts: 150, waitMs: 30000, waitIntervalMs: 120,
});
const probe = `(() => {
  const normal = (a,b,c,useHypot) => {
    const ux=b[0]-a[0],uy=b[1]-a[1],uz=b[2]-a[2],vx=c[0]-a[0],vy=c[1]-a[1],vz=c[2]-a[2];
    const x=uy*vz-uz*vy,y=uz*vx-ux*vz,z=ux*vy-uy*vx;
    const len=useHypot?Math.hypot(x,y,z):Math.sqrt(x*x+y*y+z*z);
    return [x/len,y/len,z/len];
  };
  const convert = (mesh,useHypot) => {
    const STRIDE=15,data=new Float32Array(mesh.length/11*STRIDE);
    for (let i=0,j=0;i<mesh.length;i+=33,j+=STRIDE*3) {
      const a=[mesh[i],mesh[i+1],mesh[i+2]], b=[mesh[i+11],mesh[i+12],mesh[i+13]], c=[mesh[i+22],mesh[i+23],mesh[i+24]];
      let n=normal(a,b,c,useHypot);
      if (mesh[i+10]>=-1.5 && n[1]<0) n=n.map(v=>-v);
      for(let k=0;k<3;k++){ const t=j+k*STRIDE,s=i+k*11; for(let q=0;q<11;q++)data[t+q]=mesh[s+q]; data[t+11]=n[0];data[t+12]=n[1];data[t+13]=n[2];data[t+14]=.5; }
    }
    return data;
  };
  const S=window.__lifeDebug.S, w=window.__lifeDebug.buildWorld({...S.view});
  const meshes={stage:w.scene3d?.mesh,life:w.life3d?.mesh,homes:w.homes3d?.mesh};
  // 地区地面网格（stageBuffer 走 terrainWithNormals 的唯一路径）：从 outskirts.regions 取真实 mesh。
  try {
    const regions=w.landscape?.regions ? w.landscape.regions(w.tw/2,w.th/2) : [];
    for (const [i,r] of regions.entries()) if (r.mesh) meshes['region'+i]=r.mesh;
  } catch (e) { meshes.regionsError=String(e); }
  const out={};
  for (const [name,mesh] of Object.entries(meshes)) {
    if (!mesh) { out[name]={skip:true}; continue; }
    const a=convert(mesh,true), b=convert(mesh,false);
    let diff=0,max=0; for (let i=0;i<a.length;i++){ const d=Math.abs(a[i]-b[i]); if(d){diff++; if(d>max)max=d;} }
    out[name]={floats:a.length,diff,max};
  }
  return out;
})()`;
const result = { at: new Date().toISOString(), ok: false };
try {
  await h.startServer();
  h.startChrome();
  const sid = await h.newPage();
  await h.send('Page.navigate', { url: `http://127.0.0.1:${h.port}/?mode=survival` }, sid);
  await h.waitFor(async () => Boolean(await h.evaluate('!!window.__lifeDebug', sid)), 40000, sid);
  result.meshes = await h.evaluate(probe, sid);
  result.ok = true;
  writeFileSync(join(OUT, 'normal-parity.json'), JSON.stringify(result, null, 2) + '\n');
  console.log('[normal-parity]', JSON.stringify(result.meshes));
} catch (error) {
  result.error = String(error?.stack ?? error);
  writeFileSync(join(OUT, 'normal-parity.json'), JSON.stringify(result, null, 2) + '\n');
  console.error('[normal-parity] FAIL', error);
  process.exitCode = 1;
} finally {
  await h.killChrome({ settleMs: 400 });
  await h.stopServer({ settleMs: 0 });
}
