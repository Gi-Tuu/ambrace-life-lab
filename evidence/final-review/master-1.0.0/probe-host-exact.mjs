import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir = mkdtempSync(join(tmpdir(), 'ambrace-exact-master-'));
process.env.DATA_DIR = dir; process.env.SEED_FILE = join(dir, 'none.json');
process.env.GAME_MODE = 'game'; process.env.GAME_RULES = '1'; process.env.BRAIN = 'local';
process.env.TICK_MS = '10000000'; process.env.SAVE_EVERY = '1000000'; process.env.PRESENCE_MS = '180000';
const { host } = await import('./life/host.mjs');
await host.start();
let endedDay = null, playerDeadDay = null, store0Day = null;
for (let i = 1; i <= 200 * 24 && endedDay === null; i++) {
  await host.ctl({ action: 'step' });
  const s = host.snapshot('survival').survival;
  const day = Math.floor(s.t / 24);
  const p1 = Object.values(s.agents ?? {}).find(a => a.isPlayer);
  if (playerDeadDay === null && p1?.dead) playerDeadDay = day;
  if (store0Day === null && (s.store ?? 1) === 0) store0Day = day;
  if (s.ended) endedDay = day;
}
const s = host.snapshot('survival').survival;
console.log(JSON.stringify({ head: 'master v1.0.0 host formal', store0Day, playerDeadDay, endedDay, finalT: s.t, pop: Object.values(s.agents).filter(a => !a.isPlayer && !a.dead).length, store: s.store, deaths: (s.deaths??[]).length }));
await host.stop();
