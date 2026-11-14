import { campBeds, campSite } from '../web/camp-interaction.mjs';
import { dayOf } from './clock.mjs';

export function restoreFarmPlots(w) {
  const candidates = campBeds(campSite('garden', w.campLayout), w.mapSeed, w.layoutVersion);
  for (const p of w.survival.plots) {
    p.bed ??= candidates.find(b => b.id === p.id);
    if (p.bed) p.at = [p.bed.x + p.bed.w / 2, p.bed.z + p.bed.d / 2];
  }
}

export function nextFarmBed(w) {
  const s = w.survival;
  const candidates = campBeds(campSite('garden', w.campLayout), w.mapSeed, w.layoutVersion);
  return candidates.find(b => !s.plots.some(p => p.id === b.id ||
    (p.bed && b.x < p.bed.x + p.bed.w && p.bed.x < b.x + b.w && b.z < p.bed.z + p.bed.d && p.bed.z < b.z + b.d)));
}

export function farmGroundReady(w) {
  const s = w.survival;
  return s.soil >= .35 && s.water >= .24 && !s.drought && w.weather !== 'cold' &&
    !s.disasterToday && s.lastTilledDay !== dayOf(w.t);
}

export function tillRule(w, id, plot) {
  const s = w.survival;
  if (!s?.farmLife) return { ok: false, code: 'NOT_AVAILABLE' };
  if (w.loc[id] !== 'garden') return { ok: false, code: 'NOT_GARDEN' };
  if (!farmGroundReady(w)) return { ok: false, code: 'POOR_GROUND' };
  const bed = nextFarmBed(w);
  if (!bed || bed.id !== plot) return { ok: false, code: 'NO_FARM_LAND' };
  if ((w.pinv?.[id]?.wood ?? 0) + (s.inv.wood ?? 0) < 1) return { ok: false, code: 'NO_MATERIAL' };
  return { ok: true, bed };
}

export function till(w, id, plot) {
  const gate = tillRule(w, id, plot);
  if (!gate.ok) return gate;
  const s = w.survival, bag = w.pinv?.[id], { bed } = gate;
  if (bag?.wood >= 1) bag.wood -= 1;
  else s.inv.wood -= 1;
  w.observeProduction?.('materialSpent', 'tillWood', 1);
  s.lastTilledDay = dayOf(w.t);
  s.soil -= .03;
  s.plots.push({ id: bed.id, bed, at: [bed.x + bed.w / 2, bed.z + bed.d / 2], growth: 0 });
  return { ok: true, code: 'OK' };
}
