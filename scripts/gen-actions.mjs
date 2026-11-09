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
//   · 所有颜色 ⊆ web/assets/palette.json 的 PICO-8 16 色
//   · 真像素网格、无抗锯齿、无半透明大面积叠加
//   · 图内不画文字，文案一律前端渲染
import { encodePNG, PALETTE } from './gen-pixel-assets.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const C = (h) => PALETTE.indexOf(h.toUpperCase());
const K = {
  outline: C('#000000'), dark: C('#1D2B53'), plum: C('#7E2553'), green: C('#008751'),
  brown: C('#AB5236'), gray: C('#5F574F'), light: C('#C2C3C7'), white: C('#FFF1E8'),
  red: C('#FF004D'), orange: C('#FFA300'), yellow: C('#FFEC27'), lime: C('#00E436'),
  blue: C('#29ADFF'), mauve: C('#83769C'), pink: C('#FF77A8'), skin: C('#FFCCAA'),
};
// 与 scripts/gen-pixel-assets.mjs 的 CHARS 逐值一致（家族同源，四角色只换配色）。
const CHARS = {
  a1: { hair: 1, hi: 7, skin: 15, shirt: 12, shirtHi: 7, pants: 1 },
  a2: { hair: 8, hi: 7, skin: 15, shirt: 9, shirtHi: 10, pants: 4 },
  a3: { hair: 5, hi: 7, skin: 15, shirt: 3, shirtHi: 11, pants: 5 },
  p1: { hair: 7, hi: 7, skin: 15, shirt: 6, shirtHi: 7, pants: 1 },
};

const W = 16, H = 16;
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
  rect(c, 4, 13, 3, 1, K.outline); rect(c, 9, 13, 3, 1, K.outline);
  rect(c, 5, 13, 2, 1, A.pants); rect(c, 9, 13, 2, 1, A.pants);
  rect(c, 4, 14, 2, 1, K.outline); rect(c, 7, 14, 2, 1, K.outline); rect(c, 10, 14, 2, 1, K.outline);
  rect(c, 4, 15, 3, 1, K.outline); rect(c, 9, 15, 3, 1, K.outline);
  return c;
}
const armUp = (c, side, up, A) => {
  const x = side === 'l' ? 2 : 12;
  const y = up ? 6 : 9;
  rect(c, x, y, 2, 4, K.outline); rect(c, x, y + 1, 1, 2, A.shirt); set(c, x, y + 3, A.skin);
};
const legs = (c, phase, A) => {
  const s = phase % 2 ? 1 : 0;
  rect(c, 4 + s, 13, 2, 2, K.outline); rect(c, 9 - s, 13, 2, 2, K.outline);
  rect(c, 4 + s, 15, 3, 1, K.outline); rect(c, 9 - s, 15, 3, 1, K.outline);
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
    rect(c, 4, 7, 8, 5, K.mauve); set(c, 6, 8 + n % 2, K.light);
    rect(c, 4, 12, 8, 1, A.hair); rect(c, 5, 13, 2, 2, A.hair); rect(c, 9, 13, 2, 2, A.hair);
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

function actionSheet(A) {
  const SW = W * FRAMES_PER_ACTION, SH = H * ACTIONS.length;
  const px = Array(SW * SH).fill(null);
  ACTIONS.forEach((a, r) => {
    for (let f = 0; f < FRAMES_PER_ACTION; f += 1) {
      const c = body(A);
      a.f(c, f, A);
      for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) {
        if (c[y][x] !== null) px[(r * H + y) * SW + (f * W + x)] = c[y][x];
      }
    }
  });
  return { px, w: SW, h: SH };
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
  mkdirSync(outDir, { recursive: true });
  const files = [];
  for (const [id, A] of Object.entries(CHARS)) {
    const s = actionSheet(A);
    writeFileSync(join(outDir, `${id}.png`), encodePNG(s.w, s.h, s.px));
    files.push(`${id}.png`);
  }
  const fx = fxSheet();
  writeFileSync(join(outDir, 'fx.png'), encodePNG(fx.w, fx.h, fx.px));
  files.push('fx.png');
  const manifest = {
    version: 'v1',
    frame: [W, H], anchor: [8, 16], framesPerAction: FRAMES_PER_ACTION, fps: FPS,
    fxCell: [FW, FH], fxRows: FX_ROWS,
    palette: '/web/assets/palette.json',
    clock: 'independent render clock; A/B share the same frame index; never derived from w.t',
    chars: Object.fromEntries(Object.keys(CHARS).map((id) => [id, `/web/assets/actions/${id}.png`])),
    fx: '/web/assets/actions/fx.png',
    actions: ACTIONS.map((a) => ({ id: a.id, label: a.label })),
  };
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  files.push('manifest.json');
  return files;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const out = resolve('web/assets/actions');
  const files = generate(out);
  console.log(`generated ${ACTIONS.length} actions x ${FRAMES_PER_ACTION} frames x ${Object.keys(CHARS).length} chars + ${FX_ROWS.length} fx rows -> ${out} (${files.length} files)`);
}
