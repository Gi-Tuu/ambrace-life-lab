// 种子存档生成：离线实跑到目标刻数后落盘，作为公开演示的固定初始状态。
// 种子是实跑产物（固定 seed + 确定性替身），不是编造历史；之后的行为仍由运行时自主产生。
// 用法：node life/seed-gen.mjs [目标刻数=600] [输出目录=seed-run]
import { resolve, join } from 'node:path';

const target = Number(process.argv[2] ?? 600);
const out = resolve(process.argv[3] ?? 'seed-run');
process.env.TICK_MS = '1';
process.env.DATA_DIR = out;
process.env.SEED_FILE = join(out, 'no-seed.json'); // 生成时必须从新世界开始，不能吃自己的种子

const { host } = await import('./host.mjs');
await host.start();
host.stop();
while (host.status().t < target) await host.tickOnce();
await host.save();

const s = host.snapshot();
const brief = (p) => Object.values(p.agents).map((a) => `${a.name}: 存续${a.viab.v} 损失[${a.viab.lost.join('/')}]`);
console.log(JSON.stringify({ t: s.A.t, seed: process.env.SEED ?? 7, A: brief(s.A), B: brief(s.B), out: join(out, 'world.json') }, null, 1));