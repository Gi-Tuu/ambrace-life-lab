import { runLong } from '../../life/long-run.mjs';
import { FORMAL_OPTIONS } from '../../life/balance-probe.mjs';
import { createSimClock } from '../../life/sim-clock.mjs';
import { isAlive } from '../../life/body.mjs';
import { residentStage } from '../../life/households.mjs';
const clock = createSimClock({ now: () => 0, tickMs: 3600000, manual: true });
const r = await runLong(7, 200, { checkpoints: [200], options: { ...FORMAL_OPTIONS, eventRulesVersion: 2, simTime: true, simClock: clock, minuteMetab: true } });
const after = r.birthChecks.filter(b => b.day > 100);
console.log('after100 samples', after.slice(0,6).map(b=>JSON.stringify(b)).join('\n'));
const w = r.final; // snapshot doesn't have agents ids; use r.deaths etc.
console.log('deaths', r.deaths.map(d=>`${d.day}:${d.name}:${d.cause}`).join(','));
