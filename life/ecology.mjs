// P1-4/5/6 轻量生态：果树（植物）＋鸡（一种动物）种群生命周期。
// 日界推进；确定哈希（无 Math.random，可复现）；门控 world.survival.ecosystem。
// 轻量实体 {id, born, health}——非完整 Organism，控服务器负载（派单§十二取舍）。
// lab/town 无 survival、sweep 默认 ecosystem=false ⇒ 逐位不变；host 游戏模式开启。
// 生态链：水分/季节/干旱→果树健康与结果→鸡吃植物性产出→鸡群健康/繁殖→蛋→居民食物；风暴损果树、墙庇护减损。
import { dayOf, seasonOf, DAY_TICKS } from './clock.mjs';
import { hashSeed } from './rng.mjs';

export const ECO = Object.freeze({
  orchardCap: 12, chickenCap: 12,
  orchardMatureDays: 6, orchardLifespan: 90,
  chickenMatureDays: 4, chickenLifespan: 40,
  chickenFeed: 0.5,      // 每鸡每日耗粮（先吃 berry/fruit，再吃公仓）
  reproChance: 0.25,     // 成熟健康个体每日繁殖概率基值（×health）
});
const SEASON_FRUIT = [2, 3, 1, 0]; // 春夏秋冬每棵成熟果树
const SEASON_EGG = [3, 3, 2, 1];   // 每只成熟鸡
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const roll = (seed, key) => (hashSeed(seed ?? 7, key) % 10000) / 10000;
const ageDays = (t, born) => (t - born) / DAY_TICKS;

export function initEcoPop(s) {
  const mk = (n, prefix, matureDays) => Array.from({ length: n }, (_, i) => ({
    id: `${prefix}${i + 1}`, born: -matureDays * DAY_TICKS, health: 1, // 初始种群即成熟成年
  }));
  const ch = s.livestock?.chickens ?? 3, or = s.livestock?.orchards ?? 3;
  s.ecoPop = { chickens: mk(ch, 'ch', ECO.chickenMatureDays), orchards: mk(or, 'or', ECO.orchardMatureDays) };
  s.ecoSeq = { ch, or };
}

// 日界推进：返回当日 {egg, fruit}（由成熟健康个体×季节），并同步 s.livestock 计数。
export function stepEcosystem(world, log) {
  const s = world.survival;
  if (!s?.ecosystem) return null;
  if (!s.ecoPop) initEcoPop(s);
  const day = dayOf(world.t), season = seasonOf(day), t = world.t;
  const drought = s.drought === true, storm = s.disasterToday === 'storm';
  const shield = (s.buildings ?? []).some((b) => b.type === 'wall' && b.integrity > 0);
  const water = s.water ?? 0.5;
  let births = 0, deaths = 0;

  // ── 果树（植物）：水分/季节/干旱/风暴影响健康，衰老死亡，成熟结果＋自然繁殖 ──
  const orchards = s.ecoPop.orchards;
  for (const tr of orchards) {
    const wf = 0.4 + 0.6 * water;
    tr.health = clamp01(tr.health + (drought ? -0.08 : 0.02 * wf));
    if (storm) tr.health = clamp01(tr.health - (shield ? 0.06 : 0.15)); // P1-6 墙庇护减损
    if (ageDays(t, tr.born) > ECO.orchardLifespan) tr.health = 0; // 自然衰老
  }
  for (let i = orchards.length - 1; i >= 0; i -= 1) if (orchards[i].health <= 0) { orchards.splice(i, 1); deaths += 1; }
  const matureOr = orchards.filter((tr) => ageDays(t, tr.born) >= ECO.orchardMatureDays && tr.health > 0.3);
  const fruit = Math.round(matureOr.length * SEASON_FRUIT[season] * (drought ? 0.5 : 1)); // P1-6 干旱减产
  if (orchards.length < ECO.orchardCap && water >= 0.3 && !drought) {
    for (const tr of matureOr) {
      if (orchards.length >= ECO.orchardCap) break;
      if (roll(world.seed, `or:${tr.id}:${day}`) < ECO.reproChance * tr.health) {
        orchards.push({ id: `or${++s.ecoSeq.or}`, born: t, health: 1 }); births += 1;
      }
    }
  }

  // ── 鸡（动物）：进食（植物性产出→公仓）→健康→繁殖/死亡→产蛋 ──
  const chickens = s.ecoPop.chickens;
  const need = Math.ceil(chickens.length * ECO.chickenFeed);
  let consumed = 0;
  for (const k of ['berry', 'fruit']) { // 先吃植物性产出（生态链：植物不足→鸡挨饿）
    const have = s.produce?.[k] ?? 0;
    const take = Math.min(have, need - consumed);
    if (take > 0) { s.produce[k] -= take; consumed += take; }
  }
  if (consumed < need) { const take = Math.min(s.store ?? 0, need - consumed); s.store -= take; consumed += take; }
  const fedRatio = need > 0 ? consumed / need : 1;
  for (const c of chickens) {
    c.health = clamp01(c.health + (fedRatio >= 0.99 ? 0.03 : -0.12 * (1 - fedRatio)));
    if (ageDays(t, c.born) > ECO.chickenLifespan) c.health = 0; // 自然衰老
  }
  for (let i = chickens.length - 1; i >= 0; i -= 1) if (chickens[i].health <= 0) { chickens.splice(i, 1); deaths += 1; }
  const matureCh = chickens.filter((c) => ageDays(t, c.born) >= ECO.chickenMatureDays && c.health > 0.3);
  const egg = Math.round(matureCh.length * SEASON_EGG[season]);
  if (chickens.length < ECO.chickenCap && fedRatio >= 0.99) { // 吃饱才繁殖
    for (const c of matureCh) {
      if (chickens.length >= ECO.chickenCap) break;
      if (roll(world.seed, `ch:${c.id}:${day}`) < ECO.reproChance * c.health) {
        chickens.push({ id: `ch${++s.ecoSeq.ch}`, born: t, health: 1 }); births += 1;
      }
    }
  }

  s.livestock.chickens = chickens.length; // 同步存栏数（doExpand/survView/produceYield 用）
  s.livestock.orchards = orchards.length;
  if (births || deaths) log?.push({ t, kind: 'eco', ok: true, code: `出生${births}/死亡${deaths} 鸡${chickens.length}果${orchards.length}` });
  return { egg, fruit, fedRatio };
}