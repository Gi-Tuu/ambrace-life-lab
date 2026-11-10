import { writeEditorCatalog } from './editor-catalog.mjs';
import { overridesFor } from './pixel-overrides.mjs';
// 全套动作精灵图 + 场景细节小动画生成器（零依赖、零许可风险、确定性）。
//
// 用法：node scripts/gen-actions.mjs
// 产出：web/assets/actions/{a1,a2,a3,p1,fx}.png + manifest.json
//
// 为什么放子目录：scripts/pack-assets.mjs 的 pack() 只 readdirSync 顶层 .png，
// 子目录完全不进校验 ⇒ 不必改 manifest schema、不必改打包脚本、不必改引擎。
// 帧号由前端独立渲染时钟驱动（A/B 共用），绝不读 w.t / 不消费 rng / 不写世界状态。
//
// 硬约束（docs/HANDOVER-ui-hunyuan-2026-11-09.md §2）：
//   · 所有颜色 ⊆ 所有者批准的固定 64 色板
//   · 真像素网格、无抗锯齿、无半透明大面积叠加
//   · 图内不画文字，文案一律前端渲染
import { encodePNG, PALETTE } from './gen-pixel-assets.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const C = (h) => PALETTE.indexOf(h.toUpperCase());
const K = {
  outline: C('#000000'), dark: C('#1D2B53'), plum: C('#7E2553'), green: C('#3F7036'),
  brown: C('#AB5236'), gray: C('#5F574F'), light: C('#C2C3C7'), white: C('#FFF1E8'),
  red: C('#FF004D'), orange: C('#FFA300'), yellow: C('#FFEC27'), lime: C('#98BD51'),
  blue: C('#6CB3B4'), mauve: C('#83769C'), pink: C('#FF77A8'), skin: C('#FFCCAA'),
};
// 与 scripts/gen-pixel-assets.mjs 的 CHARS 逐值一致（家族同源，四角色只换配色）。
const CHARS = {
  a1: { hair: 1, hi: 7, skin: 15, shirt: 12, shirtHi: 7, pants: 1 },
  a2: { hair: 8, hi: 7, skin: 15, shirt: 9, shirtHi: 10, pants: 4 },
  a3: { hair: 5, hi: 7, skin: 15, shirt: 3, shirtHi: 11, pants: 5 },
  p1: { hair: 7, hi: 7, skin: 15, shirt: 6, shirtHi: 7, pants: 1 },
};

const W = 32, H = 48;   // 2.5D 加高：角色 16×24，脚底锚点 (8,24)，头顶留出 emote 空位
const blank = () => Array.from({ length: H }, () => Array(W).fill(null));
const set = (c, x, y, v) => { if (x >= 0 && y >= 0 && x < W && y < H) c[y][x] = v; };
const rect = (c, x, y, w, h, v) => { for (let j = 0; j < h; j += 1) for (let i = 0; i < w; i += 1) set(c, x + i, y + j, v); };

// 角色基底：16×16、脚底中心锚点 (8,16)、1px 黑描边、左上光源、双 tone 衣色。
function body(A) {
  const c = blank();
  rect(c, 5, 1, 6, 1, K.outline);
  rect(c, 4, 2, 8, 1, K.outline); rect(c, 5, 2, 6, 1, A.hair); set(c, 6, 2, A.hi);
  rect(c, 3, 3, 10, 1, K.outline); rect(c, 4, 3, 8, 1, A.hair); set(c, 5, 3, A.hi);
  rect(c, 3, 4, 10, 1, K.outline); rect(c, 4, 4, 8, 1, A.skin);
  rect(c, 3, 5, 9, 1, K.outline); rect(c, 4, 5, 7, 1, A.skin);
  set(c, 5, 5, K.outline); set(c, 8, 5, K.outline);
  rect(c, 3, 6, 10, 1, K.outline); rect(c, 4, 6, 8, 1, A.skin);
  rect(c, 4, 7, 8, 1, K.outline); rect(c, 5, 7, 6, 1, A.shirt);
  rect(c, 3, 8, 10, 1, K.outline); rect(c, 4, 8, 8, 1, A.shirt); set(c, 5, 8, A.shirtHi);
  rect(c, 3, 9, 10, 1, K.outline); rect(c, 4, 9, 8, 1, A.shirt); set(c, 5, 9, A.shirtHi);
  rect(c, 3, 10, 10, 1, K.outline); rect(c, 4, 10, 8, 1, A.skin);
  rect(c, 4, 11, 8, 1, K.outline); rect(c, 5, 11, 6, 1, A.shirt);
  rect(c, 4, 12, 8, 1, K.outline); rect(c, 5, 12, 6, 1, A.pants);
  // 加长双腿：两条腿 x4..6 与 x9..11，行 13..22，脚底行 23（2.5D 更高剪影）
  for (let y = 13; y <= 22; y += 1) {
    rect(c, 4, y, 3, 1, K.outline); rect(c, 5, y, 2, 1, A.pants);
    rect(c, 9, y, 3, 1, K.outline); rect(c, 10, y, 2, 1, A.pants);
  }
  rect(c, 3, 23, 4, 1, K.outline); rect(c, 4, 23, 2, 1, A.pants);
  rect(c, 9, 23, 4, 1, K.outline); rect(c, 10, 23, 2, 1, A.pants);
  return c;
}
const armUp = (c, side, up, A) => {
  const x = side === 'l' ? 2 : 12;
  const y = up ? 6 : 9;
  rect(c, x, y, 2, 4, K.outline); rect(c, x, y + 1, 1, 2, A.shirt); set(c, x, y + 3, A.skin);
};
const legs = (c, phase, A) => {
  const s = phase % 2 ? 1 : 0;
  rect(c, 4 + s, 22, 3, 2, K.outline); rect(c, 9 - s, 22, 3, 2, K.outline);
  rect(c, 4 + s, 23, 3, 1, K.outline); rect(c, 9 - s, 23, 3, 1, K.outline);
};

// 17 个动作 = life/body.mjs 的 BASE_KINDS 13 个真实动作 + idle/walk/rej/hail。
// 行号即动作索引；每动作 4 帧；形状差异全部落到具体像素，不用透明度。
export const ACTIONS = [
  { id: 'idle', label: '待机', f: (c, n, A) => { if (n === 2) { set(c, 5, 5, A.skin); set(c, 8, 5, A.skin); } if (n === 1 || n === 3) set(c, 7, 8, A.shirtHi); } },
  { id: 'walk', label: '行走', f: (c, n, A) => { legs(c, n, A); if (n % 2) { set(c, 3, 9, null); set(c, 12, 9, null); } } },
  { id: 'move_to', label: '走过去', f: (c, n, A) => { legs(c, n, A); armUp(c, 'r', n % 2 === 0, A); } },
  { id: 'eat', label: '吃点存粮', f: (c, n, A) => { armUp(c, 'r', true, A); const y = 6 + n % 2; set(c, 12, y, K.orange); set(c, 7, 6, n % 2 ? K.red : A.skin); } },
  { id: 'talk', label: '说话', f: (c, n, A) => { armUp(c, 'l', n % 2 === 0, A); rect(c, 7, 6, 2, n % 2 ? 2 : 1, K.outline); } },
  { id: 'rest', label: '靠着歇一会儿', f: (c, n, A) => {
    rect(c, 4, 5, 8, 1, K.outline); rect(c, 6, 5, 2, 1, K.outline); rect(c, 9, 5, 2, 1, K.outline);
    if (n === 1 || n === 3) rect(c, 4, 11, 8, 1, K.outline);
    const z = [[12, 2], [13, 1], [13, 0], [12, 1]][n];
    set(c, z[0], z[1], K.light); set(c, z[0] + 1, z[1], K.light); set(c, z[0], z[1] + 1, K.light);
  } },
  { id: 'work', label: '在工坊干活', f: (c, n, A) => { armUp(c, 'r', n % 2 === 0, A); rect(c, 11, n % 2 ? 4 : 6, 3, 2, K.gray); set(c, 13, n % 2 ? 4 : 6, K.light); } },
  { id: 'look_out', label: '往外看', f: (c, n, A) => { rect(c, 4, 4, 8, 1, K.mauve); set(c, 5 + n % 3, 4, K.white); armUp(c, 'l', true, A); } },
  { id: 'take_shared', label: '去拿一份', f: (c, n, A) => { armUp(c, 'r', n % 2 === 0, A); rect(c, 11, 8 + n % 2, 3, 2, K.brown); set(c, 12, 8 + n % 2, K.orange); } },
  { id: 'trade', label: '接济/交换', f: (c, n, A) => { armUp(c, 'l', true, A); armUp(c, 'r', true, A); set(c, 2, 5 + n % 2, K.yellow); set(c, 13, 5 + n % 2, K.yellow); } },
  { id: 'buy', label: '用铜币换粮', f: (c, n, A) => { armUp(c, 'r', true, A); rect(c, 12, 5 + n % 2, 2, 2, K.orange); set(c, 12, 5 + n % 2, K.yellow); } },
  { id: 'companion', label: '结伴', f: (c, n, A) => { armUp(c, 'l', n % 2 === 0, A); set(c, 12, 4 + n % 2, K.pink); set(c, 13, 3 + n % 2, K.pink); } },
  { id: 'deafen', label: '捂住耳朵', f: (c, n, A) => { rect(c, 2, 5, 2, 3, A.skin); rect(c, 12, 5, 2, 3, A.skin); if (n % 2) { set(c, 1, 4, K.mauve); set(c, 14, 4, K.mauve); } } },
  { id: 'seclude', label: '躲进里屋', f: (c, n, A) => {
    rect(c, 4, 2, 8, 5, A.hair); rect(c, 5, 3, 6, 1, K.mauve);
    rect(c, 4, 7, 8, 13, K.mauve); set(c, 6, 8 + n % 2, K.light);
    rect(c, 4, 20, 8, 1, A.hair); rect(c, 5, 21, 2, 2, A.hair); rect(c, 9, 21, 2, 2, A.hair);
  } },
  { id: 'refuse', label: '别理他', f: (c, n, A) => {
    rect(c, 4, 2, 8, 5, A.hair); set(c, 5, 3, K.mauve);
    rect(c, 4, 7, 8, 5, A.shirt); set(c, 5, 8, K.mauve);
    rect(c, n % 2 ? 12 : 1, 7 + n % 2, 2, 3, A.skin);
    set(c, n % 2 ? 13 : 0, 6 + n % 2, K.light);
  } },
  { id: 'rej', label: '被规则驳回', f: (c, n, A) => { set(c, 7, 0, K.red); set(c, 8, 0, K.red); if (n % 2) { set(c, 6, 1, K.red); set(c, 9, 1, K.red); } } },
  { id: 'hail', label: '被喊住', f: (c, n, A) => { set(c, 7, 0, K.yellow); if (n % 2) set(c, 7, 1, K.yellow); legs(c, 0, A); } },
];
export const ACTION_INDEX = Object.fromEntries(ACTIONS.map((a, i) => [a.id, i]));
export const FRAMES_PER_ACTION = 4;
export const FPS = 6;

// 原生 32×48 四向精灵；不把旧图放大充当高分辨率。
const DIRECTIONS = ['down', 'left', 'right', 'up'];
function resident(id, action, frame, direction) {
  const c = blank(), pal = {
    a1: ['#514134', '#976A45', '#458996', '#6CB3B4', '#263D29'],
    a2: ['#6E3830', '#B65B3C', '#BA8752', '#EDC787', '#514134'],
    a3: ['#32302C', '#6D7165', '#568D3E', '#93AE73', '#514134'],
    p1: ['#72513B', '#BA8752', '#944735', '#D58274', '#32302C'],
  }[id].map(C), [hair, hairLight, cloth, clothLight, pants] = pal;
  const outline = C('#32302C'), skin = C('#F2B29A'), skinLight = C('#FFCCAA'), skinShade = C('#D58274');
  const r = (x,y,w,h,col) => rect(c,x,y,w,h,col), p = (x,y,col) => set(c,x,y,col);
  const walk = action === 'walk' || action === 'move_to', stride = walk ? [-2,0,2,0][frame] : 0;
  const bob = walk && frame % 2 ? 1 : 0;
  // 裤腿与有厚度的鞋；前后脚的交错只改变关节，不挪动脚底锚点。
  r(10,34,6,10,outline);r(17,34,6,10,outline);r(11,35,4,8,pants);r(18,35,4,8,pants);
  r(9+stride,43,7,4,outline);r(17-stride,43,7,4,outline);r(10+stride,43,5,2,C('#72513B'));r(18-stride,43,5,2,C('#514134'));
  // 躯干、肩线、侧面衣褶。
  r(9,21+bob,15,15,outline);r(10,22+bob,13,12,cloth);r(10,22+bob,4,10,clothLight);r(21,25+bob,2,9,cloth);
  r(10,33+bob,13,2,C('#72513B'));p(16,33+bob,C('#EDC787'));
  // 头部轮廓与发梢。帽状轮廓不以巨大矩形代替头发。
  r(11,6+bob,10,2,outline);r(8,8+bob,16,12,outline);r(10,7+bob,12,14,outline);
  r(9,9+bob,14,9,hair);r(10,8+bob,12,3,hairLight);r(10,12+bob,12,8,skin);r(11,12+bob,5,5,skinLight);
  r(9,10+bob,13,3,hair);r(9,12+bob,3,5,hair);r(20,11+bob,3,6,hair);
  r(11,9+bob,7,1,hairLight);r(11,19+bob,10,2,skinShade);r(14,21+bob,5,2,skinShade);
  if(direction==='up'){
    r(9,10+bob,14,10,hair);r(10,10+bob,4,7,hairLight);r(12,19+bob,8,2,hair);
    r(10,23+bob,13,2,clothLight);r(14,25+bob,1,7,clothLight);
  }else if(direction==='right'||direction==='left'){
    r(9,11+bob,7,9,hair);r(16,12+bob,6,7,skinLight);p(21,14+bob,outline);r(22,16+bob,2,2,skin);p(20,19+bob,skinShade);
  }else{
    r(12,14+bob,2,2,outline);r(18,14+bob,2,2,outline);p(13,14+bob,C('#FFF0CC'));p(19,14+bob,C('#FFF0CC'));p(16,17+bob,skinShade);r(15,19+bob,3,1,C('#A85A55'));
  }
  // 手臂各自运动；动作工具与姿态使用真实 action id。
  const raised = ['talk','trade','companion','hail','look_out','deafen'].includes(action), working = action==='work';
  const ly = 24+bob+(walk?stride:frame%2), ry = raised?19+frame%2:working?(frame%2?20:14):24+bob-(walk?stride:frame%2);
  r(6,ly,4,9,outline);r(7,ly+1,3,6,cloth);r(7,ly+6,3,3,skin);
  r(23,ry,4,9,outline);r(23,ry+1,3,5,cloth);r(23,ry+5,3,3,skinLight);
  // 待机、交谈也有可见的呼吸/眨眼/口型，四向背面以肩线呼吸表达。
  if(!walk&&frame%2)r(11,24+bob,5,1,clothLight);
  if(frame===2&&direction==='down'&&!['rest','deafen'].includes(action)){r(12,14+bob,2,2,skinLight);r(18,14+bob,2,2,skin);r(12,15+bob,2,1,hair);r(18,15+bob,2,1,hair);}
  if(action==='talk'&&direction==='down')r(15,18+bob,3,frame%2?2:1,frame%2?outline:skinShade);
  if(action==='seclude'){r(9,23,14,12,C('#77607A'));r(10,24+frame%2,3,9,C('#A18597'));r(12,20,9,3,hair);}
  if(action==='refuse'){r(frame%2?24:5,22,4,5,skinLight);r(10,21,12,2,hair);}
  if(action==='rest'){r(12,14+bob,3,1,hair);r(18,14+bob,3,1,hair);r(25,7+frame,3,1,C('#EDC787'));}
  if(action==='work'){r(25,ry-8,2,10,C('#976A45'));r(22,ry-9,8,4,C('#939584'));r(22,ry-9,8,1,C('#D9D6B8'));}
  if(['eat','take_shared','buy','trade'].includes(action)){r(24,ry+3,6,6,C('#72513B'));r(25,ry+3,4,4,C('#EDC787'));p(27,ry+3,C('#FFF0CC'));}
  if(action==='deafen'){r(7,15,4,6,skin);r(22,15,4,6,skin);}
  if(action==='rej'||action==='hail'){const col=C(action==='rej'?'#B65B3C':'#EDC787');r(15,0,2,4,col);p(15,5,col);}
  if(action==='companion'){p(27,9,C('#D58274'));p(29,9,C('#D58274'));r(27,10,3,2,C('#D58274'));p(28,12,C('#D58274'));}
  if(direction==='left')return c.map(row=>[...row].reverse());
  return c;
}
function actionSheet(A,id) {
  const SW=W*FRAMES_PER_ACTION, SH=H*ACTIONS.length*DIRECTIONS.length, px=Array(SW*SH).fill(null);
  ACTIONS.forEach((a,r)=>DIRECTIONS.forEach((direction,d)=>{
    for(let f=0;f<FRAMES_PER_ACTION;f++){
      const c=resident(id,a.id,f,direction),row=r*DIRECTIONS.length+d;
      for(let y=0;y<H;y++)for(let x=0;x<W;x++)px[(row*H+y)*SW+f*W+x]=c[y][x];
    }
  }));
  return {px,w:SW,h:SH};
}

// 场景 fx：4 类 × 4 帧，32×32 单元，透明底。
// 只画「会动的那几个像素」，静止部分（草根/水面/树干/屋顶）由离屏静态底图提供，
// 因此贴到任何地形上都不会出现补丁方块或重影。
export const FX_ROWS = ['grass', 'water', 'tree', 'smoke'];
const FW = 32, FH = 32;
function fxSheet() {
  const px = Array(FW * FRAMES_PER_ACTION * FH * FX_ROWS.length).fill(null);
  const put = (r, f, x, y, v) => { if (x >= 0 && x < FW && y >= 0 && y < FH) px[(r * FH + y) * (FW * FRAMES_PER_ACTION) + f * FW + x] = v; };
  const box = (r, f, x, y, w, h, v) => { for (let j = 0; j < h; j += 1) for (let i = 0; i < w; i += 1) put(r, f, x + i, y + j, v); };
  for (let f = 0; f < FRAMES_PER_ACTION; f += 1) {
    const bend = [0, 1, 2, 1][f];
    // 草：4 簇尖端按风相位左右 1–2px 摆动，根部不动、不画
    for (let k = 0; k < 4; k += 1) {
      const bx = 4 + k * 7;
      put(0, f, bx + bend - 1, 20, K.lime);
      put(0, f, bx + bend, 21, K.lime);
      put(0, f, bx + bend, 19, K.green);
      if (k === 1) put(0, f, bx + bend, 18, K.yellow);
    }
    // 水波：亮蓝短线按帧水平移动（只有线，没有水面底色）
    for (let k = 0; k < 3; k += 1) box(1, f, 3 + ((k * 9 + f * 3) % 24), 12 + k * 5, 7, 1, K.blue);
    // 树冠：只画随帧摆动的高光边，树冠主体由静态底图提供
    box(2, f, 5 + bend, 10, 8, 1, K.lime);
    put(2, f, 12 + bend, 15, K.lime);
    put(2, f, 4 + bend, 13, K.lime);
    // 炊烟：3 个 2×2 烟点逐帧上升并循环
    for (let k = 0; k < 3; k += 1) {
      const y = 20 - ((f * 3 + k * 5) % 16);
      box(3, f, 14 + ((f + k) % 3) * 2 - 1, Math.max(2, y), 2, 2, k === 1 ? K.light : K.mauve);
    }
  }
  return { px, w: FW * FRAMES_PER_ACTION, h: FH * FX_ROWS.length };
}

export function generate(outDir) {
  const override = overridesFor(outDir, PALETTE.length);
  mkdirSync(outDir, { recursive: true });
  const files = [];
  for (const [id, A] of Object.entries(CHARS)) {
    const s = actionSheet(A, id);
    writeFileSync(join(outDir, `${id}.png`), encodePNG(s.w, s.h, override(`${id}.png`, s.w, s.h, s.px)));
    files.push(`${id}.png`);
    const face = resident(id, 'idle', 0, 'down'), portrait = face.slice(4, 36).flat();
    writeFileSync(join(outDir, `portrait_${id}.png`), encodePNG(32, 32, override(`portrait_${id}.png`, 32, 32, portrait)));
    files.push(`portrait_${id}.png`);
  }
  const fx = fxSheet();
  writeFileSync(join(outDir, 'fx.png'), encodePNG(fx.w, fx.h, override('fx.png', fx.w, fx.h, fx.px)));
  files.push('fx.png');
  const manifest = {
    version: 'v2',
    frame: [W, H], anchor: [16, 48], directions: DIRECTIONS, framesPerAction: FRAMES_PER_ACTION, fps: FPS,
    fxCell: [FW, FH], fxRows: FX_ROWS,
    palette: '/web/assets/palette.json',
    clock: 'independent render clock; A/B share the same frame index; never derived from w.t',
    chars: Object.fromEntries(Object.keys(CHARS).map((id) => [id, `/web/assets/actions/${id}.png`])),
    fx: '/web/assets/actions/fx.png',
    portraits: Object.fromEntries(Object.keys(CHARS).map(id => [id, `/web/assets/actions/portrait_${id}.png`])),
    actions: ACTIONS.map((a) => ({ id: a.id, label: a.label })),
  };
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  files.push('manifest.json');
  return files;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const out = resolve('web/assets/actions');
  const files = generate(out);
  writeEditorCatalog(resolve('web/assets'));
  console.log(`generated ${ACTIONS.length} actions x ${FRAMES_PER_ACTION} frames x ${Object.keys(CHARS).length} chars + ${FX_ROWS.length} fx rows -> ${out} (${files.length} files)`);
}
