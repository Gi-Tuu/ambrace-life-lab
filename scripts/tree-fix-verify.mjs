#!/usr/bin/env node
// 树可砍 + 树后透明 的真实浏览器验收（2026-11-21）：
//   01 运行时白名单：tree:/wildtree: 可淡、pen/plot/rock 不可淡；
//   02 像素 A/B：玩家走到树后（树在玩家与相机之间）时，同一棵树冠的采样色必须变化，
//      同帧对照（旁边没被遮的树）必须几乎不变 ⇒ 树冠真的半透明，不是换了相机就把整片算进去；
//   03 鼠标拾取/目标：斧头在手时指针移到树上 cursor=pointer，hover 标签是“树”；
//   04 砍伐：/act camp_chop 后 hidden/stumps/forest 视图同步，木料 +2，
//      world.space / world.pathGrid / world.walk 在树心变可走（碰撞/寻路移除）；
//   05 再生时间写进视图（默认 30 游戏日）。
// 输出：evidence/tree-fix/browser.json + browser.log + 截图（behind-tree / front-tree / after-chop）。
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCdpHarness } from './lib/cdp-harness.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'evidence', 'tree-fix');
mkdirSync(OUT, { recursive: true });
const log = [];
const note = (kind, data = {}) => { log.push({ at: new Date().toISOString(), kind, ...data }); console.log(kind, JSON.stringify(data)); };
const h = createCdpHarness({
  root: ROOT,
  port: 9700 + (process.pid % 90),
  dataPrefix: 'tree-fix-data-',
  profilePrefix: 'tree-fix-chrome-',
  serverEnv: {
    GAME_MODE: 'game', GAME_RULES: '1', BRAIN: 'local',
    GAME_MS_PER_MINUTE: '6000', TICK_MS: '360000', MODEL_UNATTENDED: '0', V73_TEST: '1',
  },
});
const assert = (cond, message) => { if (!cond) throw new Error(message); };
const act = async (body) => (await h.post('/act', { mode: 'survival', ...body })).body;
const WALKER = `(()=>{const W=window.__lifeDebug.WALK;const k=Object.keys(W).find(k=>k.endsWith(':p1'));return k?{k,x:W[k].x,y:W[k].y}:null})()`;

// 只截 3D 视口（整页截图的 HUD 会占掉大半，图看不见树）。
async function shotView(sid, file) {
  const rect = await h.evaluate(`(()=>{const r=document.getElementById('cvA').getBoundingClientRect();
    return {x:r.left,y:r.top,width:r.width,height:r.height}})()`, sid);
  const shot = await h.send('Page.captureScreenshot', { format: 'png', clip: { ...rect, scale: 1 } }, sid);
  writeFileSync(file, Buffer.from(shot.data, 'base64'));
}

async function walkTo(sid, targetX, targetZ, { maxSteps = 60, stepMs = 150 } = {}) {
  let pos = await h.evaluate(WALKER, sid);
  for (let i = 0; i < maxSteps; i += 1) {
    const dx = targetX - pos.x, dz = targetZ - pos.y;
    if (Math.hypot(dx, dz) < .4) return { reached: true, pos };
    const key = Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? 'd' : 'a') : (dz > 0 ? 's' : 'w');
    await h.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{code:'Key${key.toUpperCase()}',key:${JSON.stringify(key)},bubbles:true}))`, sid);
    await h.wait(stepMs);
    await h.evaluate(`window.dispatchEvent(new KeyboardEvent('keyup',{code:'Key${key.toUpperCase()}',key:${JSON.stringify(key)},bubbles:true}))`, sid);
    await h.wait(60);
    pos = await h.evaluate(WALKER, sid);
  }
  return { reached: false, pos };
}

// 页面侧：挑一棵“能站到相机方向对面”的树（玩家站树北侧 ⇒ 树正好在玩家与相机之间）。
const PICK_TREE = `(()=>{
  const S=window.__lifeDebug.S, cv=document.getElementById('cvA');
  const W=window.__lifeDebug.WALK, k=Object.keys(W).find(k=>k.endsWith(':p1')), p=W[k];
  const world=window.__lifeDebug.buildWorld(S.view), space=world.space;
  // 相机 back 的水平投影（从镜头看向焦点是 -back；玩家要站在 -back 一侧，让树夹在中间）。
  const back=cv._cam?.project3d?.back ?? [0,0,1];
  const len=Math.hypot(back[0],back[2])||1, ux=back[0]/len, uz=back[2]/len;
  const pts=[];
  for (const [tx,tz] of world.trees) {
    const cx=tx+.5, cz=tz+.5;
    const stand=[cx-ux*1.3, cz-uz*1.3];
    if (!space.walkable(stand[0],stand[1],.33)) continue;
    if (space.walkable(cx,cz,.33)) continue; // 已经砍掉/不存在碰撞的树不再当目标
    pts.push({id:'forest:'+tx+':'+tz,occluder:'tree:'+tx+':'+tz,cx,cz,stand,
      dist:Math.hypot(stand[0]-p.x,stand[1]-p.y)});
  }
  pts.sort((a,b)=>a.dist-b.dist);
  return {best:pts[0]??null, player:[p.x,p.y], candidates:pts.length};
})()`;

// 页面侧：采样某棵树的“最高树冠盒”中心 5×5 平均色（同一 3D 点 ⇒ 同一面 ⇒ 无视角着色差）。
const SAMPLE = `((occluder)=>{
  const cv=document.getElementById('cvA'), cam=cv._cam?.project3d, stage=cv._cam?.stage;
  if (!cam||!stage) return null;
  const boxes=stage.boxes.filter(b=>b.occluder===occluder);
  if (!boxes.length) return null;
  let best=null;
  for (const b of boxes) { if (b.solid) continue; if (!best || b.y+b.h>best.y+best.h) best=b; }
  if (!best) return null;
  const [sx,sy]=cam.project(best.x+best.w/2,best.y+best.h/2,best.z+best.d/2);
  const x=Math.max(2,Math.min(cv.width-3,Math.round(sx))), y=Math.max(2,Math.min(cv.height-3,Math.round(sy)));
  const g=cv.getContext('2d'), d=g.getImageData(x-2,y-2,5,5).data;
  let r=0,gg=0,bb=0,n=0;
  for (let i=0;i<d.length;i+=4){r+=d[i];gg+=d[i+1];bb+=d[i+2];n+=1;}
  return {mean:[r/n,gg/n,bb/n],screen:[sx,sy],onscreen:sx>6&&sy>6&&sx<cv.width-6&&sy<cv.height-6};
})`;

const mousePick = `((occluder)=>{
  const cv=document.getElementById('cvA'), cam=cv._cam?.project3d, stage=cv._cam?.stage;
  if (!cam||!stage) return null;
  const b=stage.boxes.find(b=>b.occluder===occluder&&b.solid) ?? stage.boxes.find(b=>b.occluder===occluder);
  if (!b) return null;
  const [sx,sy]=cam.project(b.x+b.w/2,b.y+b.h/2,b.z+b.d/2);
  const rect=cv.getBoundingClientRect(), ratio=cv.width/rect.width;
  const clientX=rect.left+sx/ratio, clientY=rect.top+sy/ratio;
  cv.dispatchEvent(new PointerEvent('pointermove',{clientX,clientY,bubbles:true,pointerId:1,pointerType:'mouse'}));
  return {cursor:cv.style.cursor,clientX,clientY};
})`;

try {
  await h.startServer();
  h.startChrome();
  const sid = await h.openPage({ url: `${h.origin}/` });
  // 画布 692×364 在 758×482 的默认窗口里会被 HUD 挤到视口外：放大视口，截图/像素断言才看得见整张 3D 画面。
  await h.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, sid);
  assert(await h.waitFor(async () => Boolean(await h.evaluate('!!window.__lifeDebug?.S', sid))), '页面未就绪');
  await h.wait(900);
  assert(await h.evaluate(`!document.querySelector('#startSurvival').disabled`, sid), '继续生存按钮禁用');
  await h.evaluate(`document.querySelector('#startSurvival').click()`, sid);
  assert(await h.waitFor(async () => await h.evaluate('window.__lifeDebug.S.playing === true', sid)), '没有进入游戏');
  assert(await h.waitFor(async () => Boolean(await h.evaluate('!!window.__lifeDebug.S.view?.camp', sid))), '营地视图未建立');
  assert(await h.waitFor(async () => Boolean(await h.evaluate('document.getElementById("cvA")?.dataset.renderer', sid))), '首帧未渲染');
  await h.wait(1200);

  // 01 运行时白名单
  const whitelist = await h.evaluate(`(()=>({tree:window.__lifeDebug.fadesOccluder('tree:1:2'),
    wild:window.__lifeDebug.fadesOccluder('wildtree:3:4'), pen:window.__lifeDebug.fadesOccluder('pen:0'),
    plot:window.__lifeDebug.fadesOccluder('plot:bed-0'), rock:window.__lifeDebug.fadesOccluder('rock:5:6'),
    fadeableTree:window.__lifeDebug.fadeable(['wall:home','tree:1:2','pen:0'])}))()`, sid);
  note('01.whitelist', whitelist);
  assert(whitelist.tree === true && whitelist.wild === true, 'tree:/wildtree: 必须可淡');
  assert(whitelist.pen === false && whitelist.plot === false && whitelist.rock === false, '栅栏/田地/岩石不得淡出');
  assert(whitelist.fadeableTree.includes('tree:1:2') && !whitelist.fadeableTree.includes('pen:0'), 'fadeable 白名单投影不对');

  // 02/03：走到目标树北侧（树在玩家与相机之间）；相机 yaw 会随走路变化，按当帧 back 重算站位并重试。
  const pick = await h.evaluate(PICK_TREE, sid);
  note('02.pick', pick);
  assert(pick.best, '找不到可站到北侧的树');
  const target = pick.best;
  const standFor = async () => h.evaluate(`(()=>{
    const cv=document.getElementById('cvA'), back=cv._cam?.project3d?.back; if(!back) return null;
    const len=Math.hypot(back[0],back[2])||1;
    return [${target.cx}-back[0]/len*1.3, ${target.cz}-back[2]/len*1.3];
  })()`, sid);
  let behind = null, walkBehind = null, behindAttempts = 0;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    behindAttempts = attempt + 1;
    const stand = await standFor();
    if (!stand) { await h.wait(400); continue; }
    walkBehind = await walkTo(sid, stand[0], stand[1], { maxSteps: 30, stepMs: 140 });
    await h.wait(700);
    behind = await h.evaluate(`(()=>{const cv=document.getElementById('cvA'),d=cv._debug;
      return {p1:d?.p1,covered:d?.covered,occluded:d?.occluded,hiddenCount:d?.hiddenCount}})()`, sid);
    if (behind.occluded?.includes(target.occluder)) break;
  }
  note('02.behind', { walkBehind, behind, attempts: behindAttempts });
  assert(walkBehind?.reached, `走不到树后：${JSON.stringify(walkBehind)}`);
  assert(behind?.occluded?.includes(target.occluder), `树后 occluded 必须含 ${target.occluder}：${JSON.stringify(behind?.occluded)}`);
  const m1 = await h.evaluate(`${SAMPLE}(${JSON.stringify(target.occluder)})`, sid);
  await shotView(sid, join(OUT, 'behind-tree-fade.png'));

  // 对照树：挑一棵离目标不远、当前在屏幕内、且不在遮挡集合里的树（相机平移后仍应在屏幕内）。
  const sideTree = await h.evaluate(`(()=>{
    const cv=document.getElementById('cvA'), cam=cv._cam?.project3d, stage=cv._cam?.stage;
    const occluded=new Set(cv._debug?.occluded??[]), world=cv._cam.exterior;
    const [tx0,tz0]=${JSON.stringify(target.id)}.split(':').slice(1).map(Number);
    let best=null;
    for (const [tx,tz] of world.trees) { const id='tree:'+tx+':'+tz;
      if (occluded.has(id) || id===${JSON.stringify(target.occluder)}) continue;
      const boxes=stage.boxes.filter(b=>b.occluder===id&&!b.solid);
      if (!boxes.length) continue;
      let top=boxes[0]; for (const b of boxes) if (b.y+b.h>top.y+top.h) top=b;
      const [sx,sy]=cam.project(top.x+top.w/2,top.y+top.h/2,top.z+top.d/2);
      if (sx<60||sy<60||sx>cv.width-60||sy>cv.height-60) continue;
      const d=Math.hypot(tx-tx0,tz-tz0);
      if (!best||d<best.d) best={occluder:id,d};
    }
    return best;})()`, sid);
  const side1 = sideTree ? await h.evaluate(`${SAMPLE}(${JSON.stringify(sideTree.occluder)})`, sid) : null;

  // 玩家移到树的另一侧（相机反方向）：树不再夹在玩家与镜头之间
  const currentStand = await standFor();
  const walkFront = await walkTo(sid, target.cx + (target.cx - currentStand[0]) * 2.2 / 1.3,
    target.cz + (target.cz - currentStand[1]) * 2.2 / 1.3);
  await h.wait(700);
  const front = await h.evaluate(`(()=>{const cv=document.getElementById('cvA'),d=cv._debug;
    return {p1:d?.p1,covered:d?.covered,occluded:d?.occluded}})()`, sid);
  const m2 = await h.evaluate(`${SAMPLE}(${JSON.stringify(target.occluder)})`, sid);
  const side2 = sideTree ? await h.evaluate(`${SAMPLE}(${JSON.stringify(sideTree.occluder)})`, sid) : null;
  await shotView(sid, join(OUT, 'front-tree.png'));
  const diff = (a, b) => (a && b) ? Math.abs(a.mean[0]-b.mean[0]) + Math.abs(a.mean[1]-b.mean[1]) + Math.abs(a.mean[2]-b.mean[2]) : null;
  const pixels = { behind: m1, front: m2, sideBehind: side1, sideFront: side2,
    treeDiff: diff(m1, m2),
    controlDiff: (side1?.onscreen && side2?.onscreen) ? diff(side1, side2) : null };
  note('02.pixels', { walkFront, front: { occluded: front.occluded, p1: front.p1 }, ...pixels });
  assert(walkFront.reached, `走不到树前：${JSON.stringify(walkFront)}`);
  assert(!front.occluded?.includes(target.occluder), '树前不应再遮挡这棵树');
  assert(pixels.treeDiff !== null && pixels.treeDiff > 4, `树后被遮挡时树冠采样色必须变化（实测 ${pixels.treeDiff}）`);
  assert(pixels.controlDiff !== null && pixels.controlDiff < pixels.treeDiff / 2,
    `对照树不得跟着变（实测 ${pixels.controlDiff} vs 目标 ${pixels.treeDiff}）`);

  // 03 鼠标拾取/目标高亮：斧头在手 → 指针移到树上 cursor=pointer，hover 标签出现
  await h.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'2',code:'Digit2',bubbles:true}))`, sid);
  assert(await h.evaluate(`window.__lifeDebug.ui.tool`, sid) === 'axe', '没切到斧头');
  const pickInfo = await h.evaluate(`${mousePick}(${JSON.stringify(target.occluder)})`, sid);
  await h.wait(500);
  const hover = await h.evaluate(`(()=>{const d=document.getElementById('cvA')._debug;return {hover:d?.hover,hoverLabel:d?.hoverLabel}})()`, sid);
  note('03.pick', { pickInfo, hover });
  assert(pickInfo?.cursor === 'pointer', `指针在树上必须变成 pointer（实测 ${pickInfo?.cursor}）`);
  assert(hover.hover === true && hover.hoverLabel === '树', `hover 必须命中“树”：${JSON.stringify(hover)}`);

  // 04 砍伐：先走回树旁（够得到的站位），再从真实脚点发 /act
  const backStand = await standFor();
  const walkBack = await walkTo(sid, backStand[0], backStand[1]);
  await h.wait(500);
  const near = await h.evaluate(`(()=>{const d=document.getElementById('cvA')._debug;return d?.p1})()`, sid);
  const wood0 = (await h.evaluate(`window.__lifeDebug.S.view.pinv?.p1?.wood ?? 0`, sid)) ?? 0;
  const chop = await act({ kind: 'camp_chop', target: target.id, tool: 'axe', from: [near[0], near[2]] });
  note('04.chop', { walkBack, near, target: target.id, wood0, chop });
  assert(chop?.ok, `砍伐失败：${JSON.stringify(chop)}`);
  assert(chop.amount === 2, `木料产出应为 2：${chop.amount}`);
  assert(await h.waitFor(async () => Boolean(await h.evaluate(`window.__lifeDebug.S.view.camp?.forest?.[${JSON.stringify(target.id)}]`, sid))), '视图没出现树桩');
  await h.wait(900);
  const after = await h.evaluate(`(()=>{
    const S=window.__lifeDebug.S, cv=document.getElementById('cvA'), d=cv._debug;
    const world=window.__lifeDebug.buildWorld(S.view);
    const [tx,tz]=${JSON.stringify(target.id)}.split(':').slice(1).map(Number);
    const grid=world.pathGrid;
    return {forest:S.view.camp.forest[${JSON.stringify(target.id)}], hidden:d?.hidden, hiddenCount:d?.hiddenCount,
      stumps:d?.stumps, wood:S.view.pinv?.p1?.wood??0,
      spaceWalkable:world.space.walkable(tx+.5,tz+.5,.33),
      tileWalk:world.walk[tz*120+tx],
      pathPixel: grid ? grid.walk[Math.floor((tz+.5)*16)*grid.tw+Math.floor((tx+.5)*16)] : null,
      coveredHasTree:(d?.covered??[]).includes(${JSON.stringify(target.occluder)})};})()`, sid);
  note('04.after', after);
  assert(after.hidden?.includes(target.occluder), `hidden 必须含被砍树 occluder：${JSON.stringify(after.hidden)}`);
  assert(after.stumps >= 4, `树桩必须画出来（stumps=${after.stumps}）`);
  assert(after.forest?.stage === 'stump' && after.forest?.regrowAt > (await h.evaluate('window.__lifeDebug.S.view.t', sid)),
    `视图树桩/再生时间不对：${JSON.stringify(after.forest)}`);
  assert(after.wood === wood0 + 2, `木料必须 +2：${wood0} → ${after.wood}`);
  assert(after.spaceWalkable === true, '砍后树心必须可走（客户端 space）');
  assert(after.tileWalk === 1, '砍后 tile walk 必须 = 1');
  assert(after.pathPixel === 1, '砍后 pathGrid 像素必须可走');
  assert(after.coveredHasTree === false, '砍倒的树不应再出现在 covered 里');
  await shotView(sid, join(OUT, 'after-chop.png'));

  const result = { at: new Date().toISOString(), ok: true, whitelist, target, pixels, pickInfo, hover, chop, after };
  writeFileSync(join(OUT, 'browser.json'), JSON.stringify(result, null, 2) + '\n');
  writeFileSync(join(OUT, 'browser.log'), log.map((r) => JSON.stringify(r)).join('\n') + '\n');
  console.log('✔ tree-fix 浏览器验收通过');
} catch (error) {
  note('error', { message: String(error?.message ?? error) });
  writeFileSync(join(OUT, 'browser.log'), log.map((r) => JSON.stringify(r)).join('\n') + '\n');
  process.exitCode = 1;
  throw error;
} finally {
  await h.close({ settleMs: 400 }).catch(() => {});
}

