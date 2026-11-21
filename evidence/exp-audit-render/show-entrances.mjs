import { readFileSync } from 'node:fs';
const file = process.argv[2] ?? 'evidence/exp-audit-render/entrance-default-save.log';
const lines = readFileSync(file, 'utf8').split('\n');
for (const l of lines) {
  if (!l.startsWith('{"room"')) continue;
  const o = JSON.parse(l);
  if (!o.footprint) continue;
  console.log([o.room, JSON.stringify(o.gate), 'foot', JSON.stringify(o.footprint),
    'in%', o.rectInFootprintPct, 'solid%', o.rectOnSolidPct,
    'centerWalk', o.centerWalkableR, 'outside', o.outsideReachable].join(' '));
}
