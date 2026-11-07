// M3 闸门③的底座：生成/比对一份"与 M3 无关"的行为指纹。
// 只取各版本都有的字段（动作、调制四维、需求三维、存续量与储能），避免新加的记账字段让老版本比对失败。
// 用法：在 e74af7d 的工作树上跑 `node life/m3-baseline.mjs > <out>.json`，再在 HEAD 上比对同一份摘要。
import { createHash } from 'node:crypto';
import { simulate } from './run.mjs';

export function traceDigest(rows) {
  const h = createHash('sha256');
  for (const r of rows) {
    if (!r.action) continue;
    const m = r.m ?? {};
    const d = r.drives ?? {};
    h.update([r.t, r.action,
      m.arousal?.toFixed(4), m.approach?.toFixed(4), m.inhibit?.toFixed(4), m.quiescence?.toFixed(4),
      d.energy?.toFixed(4), d.social?.toFixed(4), d.stimulation?.toFixed(4),
      r.viab?.v?.toFixed(4), r.viab?.reserve?.toFixed(4)].join('|') + '\n');
  }
  return h.digest('hex');
}

export async function digests({ seeds = [7, 11], ticks = 400 } = {}) {
  const out = {};
  for (const seed of seeds) {
    for (const ticksN of [ticks, ticks * 3]) {
      const { agents } = await simulate({ seed, ticks: ticksN, condition: 'C2' });
      for (const a of Object.values(agents)) out[`${seed}/${ticksN}/${a.id}`] = { n: a.trace.filter((r) => r.action).length, sha256: traceDigest(a.trace) };
    }
  }
  return out;
}

if (process.argv[1]?.endsWith('m3-baseline.mjs')) {
  const seeds = (process.argv.find((x) => x.startsWith('--seeds='))?.split('=')[1] ?? '7,11').split(',').map(Number);
  const ticks = Number(process.argv.find((x) => x.startsWith('--ticks='))?.split('=')[1] ?? 400);
  console.log(JSON.stringify(await digests({ seeds, ticks }), null, 2));
}
