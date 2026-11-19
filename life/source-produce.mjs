import { ANIMAL_ITEMS, BERRY_PATCHES, campBeds, campPen, campSite } from '../shared/camp-interaction.mjs';
import { DAY_TICKS } from './clock.mjs';
import { noteRes } from './resource-ledger.mjs';

const GROUPS = { fruit: 'orchards', egg: 'chickens', milk: 'cows', wool: 'sheep' };
export const MATURE_DAYS = Object.freeze({ orchards: 6, chickens: 4 });
// 仅用于外观。老鸡的产蛋、繁殖和寿命继续由生态规则裁决。
const CHICKEN_ELDER_DAYS = 30;

function sources(w, item) {
  const s = w.survival, group = GROUPS[item];
  if (!group) return [];
  const population = s.ecosystem && s.ecoPop?.[group];
  if (population) return population.map(row => {
    const age = (w.t - row.born) / DAY_TICKS;
    const mature = age >= MATURE_DAYS[group];
    const stormLoss = (row.stormRecovery ?? row.health) - row.health;
    return {
      id: item === 'fruit' ? `fruit:${row.id}` : `${group}:${row.id}`, slot: row.slot, mature,
      ...(item === 'fruit' ? { healthGrade:row.health<=.3?0:row.health<.78?1:2,
        stormDamage:stormLoss>.105?2:stormLoss>1e-6?1:0 } : {}),
      ...(item === 'egg' ? { stage: !mature ? 'juvenile' : age >= CHICKEN_ELDER_DAYS ? 'elder' : 'adult' } : {}),
    };
  });
  const dead=Object.keys(s.culledAnimals??{}).filter(id=>id.startsWith(group+':')).length;
  return Array.from({ length: (s.livestock?.[group] ?? 0)+dead }, (_, slot) => ({
    id: `${ANIMAL_ITEMS[group] ? group : item}:${slot}`, slot, mature: true,
  })).filter(row=>!s.culledAnimals?.[row.id]);
}

export function restoreSources(w) {
  const s = w.survival;
  if (!s.farmLife) return;
  s.standing ??= {};
  for (const item of Object.keys(GROUPS)) {
    s.standing[item] ??= {};
    s.produce[item] ??= 0;
  }
  if (s.wildBerries) s.berryPatches ??= Object.fromEntries(Object.entries(BERRY_PATCHES).map(([site, n]) => [
    site, Array.from({ length: n }, () => (s.wildBerries[site] ?? 0) / n),
  ]));
  for (const rows of Object.values(s.ecoPop ?? {})) {
    const used = new Set(rows.map(r => r.slot).filter(Number.isInteger));
    for (const row of rows) {
      if (Number.isInteger(row.slot)) continue;
      let slot = 0;
      while (used.has(slot)) slot += 1;
      row.slot = slot;
      used.add(slot);
    }
  }
}

// 已挂在来源上的产物是总库存的子账。旧档已有库存留在公用库存，可继续兑换。
export function sourceView(w) {
  const s = w.survival;
  if (!s.farmLife) return undefined;
  // §3：坐标是服务端的权威值，同时给离线 harness 用（客户端不再自己推 from/to）。
  // NEW-01：布局 1/2 的世界只有 campLayout（w.layout 是旧字段）⇒ 必须统一取 campLayout。
  const layout = w.campLayout ?? w.layout;
  const garden = campSite('garden', layout);
  const bed = campBeds(garden, w.mapSeed ?? 0, w.layoutVersion ?? 0)[0];
  const pen = campPen(campSite('yard', layout));
  const animalAt = (slot) => pen ? {
    x: pen.x + pen.gate + 0.6 + (slot % 3) * 0.25,
    z: pen.z + pen.d - 0.8 - Math.floor(slot / 3) * 0.25,
  } : null;
  return Object.fromEntries(Object.keys(GROUPS).map(item => [item, sources(w, item).map(row => ({
    ...row, afraid:(s.frightenedAnimals?.[row.id]??0)>w.t, ready: s.standing[item][row.id] ?? 0,
    ...(item === 'fruit' && bed ? { x: bed.x + 1 + row.slot % 6 * 2.95, z: bed.z + 9.5 + Math.floor(row.slot / 6) * 3 } : {}),
    ...(item !== 'fruit' && animalAt(row.slot) ? animalAt(row.slot) : {}),
  }))]));
}

export function addStanding(w, item, units, cap, eligible) {
  const s = w.survival, ledger = s.standing?.[item];
  if (!ledger) {
    const before = s.produce[item] ?? 0;
    s.produce[item] = Math.min(cap, before + units);
    return s.produce[item] - before;
  }
  const rows = sources(w, item), live = new Set(rows.map(row => row.id));
  for (const id of Object.keys(ledger)) {
    if (live.has(id)) continue;
    if (item === 'fruit' || s.culledAnimals?.[id]) s.produce[item] -= ledger[id];
    delete ledger[id];
  }
  const producers = rows.filter(row => row.mature && (s.frightenedAnimals?.[row.id]??0)<=w.t && (!eligible || eligible.has(row.id)));
  if (producers.length === 0) return 0;
  if (item==='milk' || item==='wool') {
    units=Math.floor(units*producers.length/Math.max(1,rows.length));
  }
  let accepted = 0;
  const offset = Math.floor(w.t / DAY_TICKS);
  for (let n = 0; n < units && s.produce[item] < cap; n += 1) {
    const row = producers[(n + offset) % producers.length];
    const ready = ledger[row.id] ?? 0;
    if (ready >= 3) continue;
    ledger[row.id] = ready + 1;
    s.produce[item] += 1;
    accepted += 1;
  }
  if (accepted > 0 && item === 'wool') noteRes(w, 'gross', 'wool', accepted);
  return accepted;
}

export function takeProduce(s, item, units, source) {
  const stock = s.produce?.[item] ?? 0, ledger = s.standing?.[item];
  if (stock < units) return false;
  if (ledger && source !== undefined) {
    if ((ledger[source] ?? 0) < units) return false;
    ledger[source] -= units;
  } else if (ledger) {
    const entries = Object.entries(ledger);
    const pooled = stock - entries.reduce((total, [, count]) => total + count, 0);
    let debit = Math.max(0, units - pooled);
    for (const [id, count] of entries) {
      if (debit <= 0) break;
      const take = Math.min(debit, count);
      ledger[id] -= take;
      debit -= take;
    }
  }
  s.produce[item] -= units;
  return true;
}

export function berryAmount(s, site, target) {
  const patches = s.berryPatches?.[site];
  if (!patches) return Math.floor(s.wildBerries?.[site] ?? 0);
  if (target !== undefined) {
    const index = patches.findIndex((_, i) => target === `berry:${site}:${i}`);
    return Math.floor(patches[index] ?? 0);
  }
  return Math.floor(Math.max(...patches));
}

export function takeBerry(s, site, target) {
  const patches = s.berryPatches?.[site];
  let picked = target;
  if (patches) {
    const index = patches.findIndex((n, i) => n >= 1 && (target === undefined || target === `berry:${site}:${i}`));
    patches[index] -= 1;
    picked = `berry:${site}:${index}`;
  }
  s.wildBerries[site] -= 1;
  return picked;
}

