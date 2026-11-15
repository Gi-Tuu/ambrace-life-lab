// 公开演示起点生成器：跑一条**无模型**自主轨迹，在多个停靠点报告营地成熟度，可选在指定停靠点落盘生存快照。
// 用法：GAME_MODE=game node scripts/seed-ladder.mjs 480,960,1440 [落盘停靠=0 表示不落盘]
// 产物落在仓库根 seed-run/（临时目录，不入库）；把 survival-<刻数>.json 拼进 seed/world.json 才算改好起点。
import { resolve, join } from 'node:path';
import { mkdirSync, writeFileSync, existsSync, statSync, readFileSync, renameSync } from 'node:fs';

const stops = (process.argv[2] ?? '480,960,1440').split(',').map(Number).sort((a, b) => a - b);
const dumpAt = Number(process.argv[3] ?? 0);
if (!stops.length) { console.error('需要停靠点'); process.exit(2); }
const out = resolve(import.meta.dirname, '..', 'seed-run');
mkdirSync(out, { recursive: true });
process.env.TICK_MS = '1';
process.env.DATA_DIR = out;
process.env.SEED_FILE = join(out, 'no-seed.json'); // 生成时必须从新世界开始，不能吃自己的种子

const { host, survivalOptions } = await import('../life/host.mjs');
const { loadSurv, dumpSurv } = await import('../life/survplay.mjs');

// 无人操作的轨迹里，玩家化身会"同权地"饿死（P0-3 的设计后果：基础代谢对 p1 一视同仁）。
// 公开起点要的是一名刚到营地的人，所以用运行时自己的新档构造换掉 p1 槽位，而不是手改数字。
const freshenPlayer = (camp, seed) => {
  const ref = dumpSurv(loadSurv(undefined, seed, survivalOptions()));
  camp.minds.p1 = structuredClone(ref.minds.p1);
  camp.pinv = { ...camp.pinv, p1: { wood: 0, stone: 0 } };
  camp.loc = { ...camp.loc, p1: 'hall' };
  camp.occupancy = { ...camp.occupancy, hall: [...new Set([...(camp.occupancy?.hall ?? []), 'p1'])] };
  camp.campPlayerRoom = null;
  camp.survival = { ...camp.survival, playerDead: false, talk: null };
  const back = loadSurv(structuredClone(camp), seed, survivalOptions()).world.agents.p1;
  if (!back || back.dead || back.viab?.v < 0.9) {
    console.error(`玩家槽位换完仍不可用：dead=${back?.dead} 存续=${back?.viab?.v}`);
    process.exit(1);
  }
  console.log('  玩家槽位已换为新到者：存续', back.viab.v.toFixed(2), '位置', camp.loc.p1);
  return camp;
};
const sv = () => host.snapshot().survival ?? {};
const residents = (s) => Object.entries(s.agents ?? {}).filter(([id, a]) => id !== 'p1' && a && !a.dead).length;
const brief = (s) => ({
  t: s.t, day: s.day, settlement: s.settlement, ended: !!s.ended, endReason: s.endReason ?? null,
  居民: residents(s), 出生: s.births, 死亡: Array.isArray(s.deaths) ? s.deaths.length : s.deaths,
  公仓: s.store, 工地: Object.keys(s.sites ?? {}).length,
  建筑: Object.values(s.buildings ?? {}).reduce((m, b) => { m[b?.type ?? '?'] = (m[b?.type ?? '?'] ?? 0) + 1; return m; }, {}),
  家庭: Object.keys(s.households ?? {}).length, 跨区行程: Object.keys(s.districtTravel ?? {}).length
});
await host.start();
host.stop();
const last = stops[stops.length - 1];
const seen = new Set();
let samplePrinted = false;
while ((sv().t ?? 0) < last) {
  await host.tickOnce();
  const s = sv();
  if (!seen.has(s.t) && stops.includes(s.t)) {
    seen.add(s.t);
    console.log(JSON.stringify(brief(s)));
    if (!samplePrinted) {
      samplePrinted = true;
      console.log('  样本 building:', JSON.stringify(Object.values(s.buildings ?? {})[0] ?? null).slice(0, 220));
      console.log('  样本 site:', JSON.stringify(Object.values(s.sites ?? {})[0] ?? null).slice(0, 220));
      console.log('  survival 字段数:', Object.keys(s).length, '| keys 摘要:', Object.keys(s).slice(0, 14).join(','));
    }
    if (dumpAt && s.t === dumpAt) {
      await host.save();
      const p = join(out, 'world.json');
      const raw = JSON.parse(readFileSync(p, 'utf8'));
      if (!raw.survival) { console.error('落盘缺 survival 块！'); process.exit(1); }
      raw.survival = freshenPlayer(raw.survival, raw.seed ?? 7);
      writeFileSync(join(out, `survival-${dumpAt}.json`), JSON.stringify(raw.survival));
      renameSync(p, join(out, `world-full-${dumpAt}.json`));
      console.log('已落盘:', join(out, `survival-${dumpAt}.json`), statSync(join(out, `survival-${dumpAt}.json`)).size, 'bytes');
    }
  }
}
