// B120 测量：5 种子 × 30/100/200 日（正式游戏，玩家闲置），逐种子表。
import { writeFileSync } from 'node:fs';
import { runLong, LONG_SEEDS } from './long-run.mjs';
import { FORMAL_OPTIONS } from './balance-probe.mjs';

const rows = [];
for (const days of [30, 100, 200]) {
  for (const seed of LONG_SEEDS) {
    const r = await runLong(seed, days, { checkpoints: [days], options: FORMAL_OPTIONS });
    const p1 = (r.deaths ?? []).find((d) => d.id === 'p1');
    rows.push({
      days, seed, population: r.final.population, births: r.final.births,
      marriages: r.final.family?.marriages ?? 0, deaths: r.final.deaths ?? 0,
      playerAlive: r.final.playerAlive, playerDeathDay: p1 ? Math.round((p1.t ?? 0) / 24) : null,
      ended: r.final.ended, store: r.final.store,
    });
    console.log(JSON.stringify(rows.at(-1)));
  }
}
writeFileSync('docs/b120.json', JSON.stringify({ seeds: LONG_SEEDS, rows }, null, 2));
