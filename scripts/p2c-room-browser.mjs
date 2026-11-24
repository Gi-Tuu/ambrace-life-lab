#!/usr/bin/env node
// P2c 室内空间真实浏览器验收：用页面里的正式房间路径函数（roomSurface + moveRoomSurface）
// 验证门 portal、墙/家具/越界拒绝，以及 animate 里 IPOS 的真实按键位移（不是 Node 复刻）。
// 输出 evidence/redo-p2c/room-browser.log；不写真实存档。
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCdpHarness } from './lib/cdp-harness.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'evidence', 'redo-p2c', 'room-browser.log');
mkdirSync(dirname(OUT), { recursive: true });
const h = createCdpHarness({
  root: ROOT,
  port: 9100 + (process.pid % 90),
  dataPrefix: 'p2c-room-data-',
  profilePrefix: 'p2c-room-chrome-',
  serverEnv: {
    GAME_MODE: 'game', GAME_RULES: '1', BRAIN: 'local', TICK_MS: '10000000',
    MODEL_UNATTENDED: '0', V73_TEST: '1',
  },
});
const lines = [];
const note = (kind, data) => { lines.push({ at: new Date().toISOString(), kind, ...data }); };
const assert = (cond, message) => { if (!cond) throw new Error(message); };

try {
  await h.startServer();
  h.startChrome();
  const sid = await h.openPage({ url: `${h.origin}/` });
  assert(await h.waitFor(async () => Boolean(await h.evaluate('!!window.__lifeDebug', sid))), '页面未就绪');
  await h.wait(1200);
  assert(await h.waitFor(async () => !(await h.evaluate(`document.querySelector('#startSurvival')?.disabled ?? true`, sid))), '继续生存按钮一直禁用');
  await h.evaluate(`document.querySelector('#startSurvival').click()`, sid);
  assert(await h.waitFor(async () => await h.evaluate('window.__lifeDebug.S.playing === true', sid), 30000), '未进入游戏');
  await h.wait(800);

  const probe = await h.evaluate(`(()=>{
    const d=window.__lifeDebug, s=d.roomSpaceFor('hall'), R=d.roomDoorWorld();
    const px=(v)=>v*16, py=(v)=>v*16;
    const wall=d.moveRoomSurface('hall', px(8), py(6), -px(8), 0);
    const door=d.moveRoomSurface('hall', px(8), py(10), 0, py(4));
    return {
      door:R,
      doorWalk:s.walkable(8,11.5,.33),
      wallBlocked:s.walkable(.5,6,.33),
      furnitureBlocked:s.walkable(4,4,.33),
      outsideBlocked:s.walkable(2,13,.33),
      portalKind:s.portalAt(8,11.9,.2)?.kind ?? null,
      portalRoom:s.portalAt(8,11.9,.2)?.room ?? null,
      wallMove:{x:wall.moved[0],z:wall.moved[1]},
      doorMove:{x:door.moved[0],z:door.moved[1]},
    };
  })()`, sid);
  note('roomSpace', probe);
  assert(probe.doorWalk === true, '门口必须可站');
  assert(probe.wallBlocked === false, '左墙必须拒');
  assert(probe.furnitureBlocked === false, 'hall 长凳必须拒');
  assert(probe.outsideBlocked === false, '越出 16×12 必须拒');
  assert(probe.portalKind === 'door' && probe.portalRoom === 'hall', '门 portal 必须命中');
  assert(probe.wallMove.x > 2 * 16, `向左走必须被墙挡住，实测 x=${probe.wallMove.x}`);
  assert(probe.doorMove.z >= 11.6 * 16 && probe.doorMove.z <= 12 * 16 + .5, `门口必须可到且不得越过 12×16，实测 z=${probe.doorMove.z}`);

  // 真实 animate 路径：把 ui.interior 设成 hall，按 A 向左走，看 IPOS 真的动且不穿墙。
  const before = await h.evaluate(`(()=>{const d=window.__lifeDebug;d.S.view.campPlayerRoom='hall';d.S.view.loc.p1='hall';d.ui.interior='hall';d.ui.room='hall';d.IPOS.x=8*16-8;d.IPOS.y=8*16-16;return {x:d.IPOS.x,y:d.IPOS.y}})()`, sid);
  await h.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyA',key:'a',bubbles:true}))`, sid);
  await h.wait(700);
  await h.evaluate(`window.dispatchEvent(new KeyboardEvent('keyup',{code:'KeyA',key:'a',bubbles:true}))`, sid);
  await h.wait(200);
  const after = await h.evaluate(`(()=>{const d=window.__lifeDebug,s=d.roomSpaceFor('hall');const fx=(d.IPOS.x+8)/16,fz=(d.IPOS.y+16)/16;return {x:d.IPOS.x,y:d.IPOS.y,walkable:s.walkable(fx,fz,.33)}})()`, sid);
  note('keyboardWalk', { before, after });
  assert(after.x < before.x - 2, `按 A 后 IPOS.x 必须真实左移，实测 ${before.x}→${after.x}`);
  assert(after.walkable === true, '键盘走完的脚点必须仍在房间可走面上');

  // 回归：旧 /world 回包晚于 move 到达时，不得清掉新房间；新回包必须能把室内视角恢复回来。
  await h.evaluate(`(()=>{
    const d=window.__lifeDebug,w=d.buildWorld(d.S.view),g=w.scene3d.entrances.store,p=d.WALK['cvA:p1'];
    p.x=g.x+g.w/2-.5;p.y=g.z+g.d*.82-.5;p.path=[];p.pi=0;p.moving=false;p.lastSync={x:p.x+.5,z:p.y+.5,t:performance.now()+5000};
    window.__hold={enabled:true,seen:0,releases:[],of:window.fetch};
    window.fetch=async function(...a){const r=await window.__hold.of.apply(this,a);if(window.__hold.enabled&&String(a[0]).startsWith('/world')){const i=window.__hold.seen++;const text=await r.text();await new Promise(res=>window.__hold.releases[i]=res);return new Response(text,{status:r.status,headers:r.headers});}return r;};
  })()`, sid);
  assert(await h.waitFor(async () => await h.evaluate('window.__hold.seen>=1', sid), 5000), '旧 /world 回包未进入等待');
  await h.evaluate(`window.__lifeDebug.enterRoom('store')`, sid);
  assert(await h.waitFor(async () => await h.evaluate("window.__lifeDebug.ui.interior==='store'", sid), 10000), '公仓进门失败');
  assert(await h.waitFor(async () => await h.evaluate('window.__hold.seen>=2', sid), 5000), '新 /world 回包未进入等待');
  await h.evaluate(`window.__hold.releases[0]()`, sid);
  await h.wait(300);
  const staleRoom = await h.evaluate(`({ui:window.__lifeDebug.ui.interior,room:window.__lifeDebug.S.view.campPlayerRoom})`, sid);
  assert(staleRoom.ui === 'store', `旧回包清掉了新房间：${JSON.stringify(staleRoom)}`);
  await h.evaluate(`window.__hold.enabled=false;window.__hold.releases[1]();`, sid);
  await h.wait(600);
  const freshRoom = await h.evaluate(`({ui:window.__lifeDebug.ui.interior,room:window.__lifeDebug.S.view.campPlayerRoom})`, sid);
  assert(freshRoom.ui === 'store' && freshRoom.room === 'store', `新回包没有恢复房间：${JSON.stringify(freshRoom)}`);
  note('roomSyncRace', { staleRoom, freshRoom });
  await h.evaluate(`(()=>{const d=window.__lifeDebug;window.fetch=window.__hold.of;d.IPOS.x=120;d.IPOS.y=168;d.IPOS.site='store';d.interact();})()`, sid);
  assert(await h.waitFor(async () => await h.evaluate("window.__lifeDebug.ui.interior===null&&window.__lifeDebug.S.view?.campPlayerRoom===null", sid), 10000), '公仓出门失败');

  const text = JSON.stringify({ ok: true, lines }, null, 2) + '\n';
  writeFileSync(OUT, text);
  console.log(`[p2c-room] PASS door=(${probe.door.x},${probe.door.z},${probe.door.w},${probe.door.d}) wallMoveX=${probe.wallMove.x.toFixed(1)} ipos ${before.x.toFixed(1)}→${after.x.toFixed(1)} roomRace=ok`);
  console.log(`[p2c-room] evidence: ${OUT}`);
} catch (error) {
  const text = JSON.stringify({ ok: false, error: String(error?.stack ?? error), lines }, null, 2) + '\n';
  writeFileSync(OUT, text);
  console.error('[p2c-room] FAIL ' + String(error?.message ?? error));
  console.error(`[p2c-room] evidence: ${OUT}`);
  process.exitCode = 1;
} finally {
  await h.close({ settleMs: 300 });
}
