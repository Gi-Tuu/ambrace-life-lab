import { PARAMS } from './params.mjs';

export function recordResidentHit(world, resident, before) {
  const wounds=world.survival.campWounds??={};
  const previous=wounds[resident.id];
  // Preserve an earlier unhealed injury's recovery point when there is another hit.
  const recovery=Math.max(before,Number.isFinite(previous?.recovery)?previous.recovery:before);
  wounds[resident.id]={t:world.t,total:(previous?.total??0)+(before-resident.viab.v),recovery};
}

export function residentInjury(world,resident) {
  const wound=world.survival.campWounds?.[resident.id], viability=resident.viab?.v??1;
  if (resident.dead || viability<=0 || !wound || wound.recovery===null || !Number.isFinite(wound.t) || wound.t>world.t) return null;
  // Old saves only recorded the last hit tick and total damage, so use the original hit cooldown.
  const active=Number.isFinite(wound.recovery)?viability<wound.recovery-1e-6:world.t-wound.t<2;
  return active ? viability<PARAMS.viab.crit?'critical':'hurt' : null;
}

export function settleResidentInjuries(world) {
  let changed=false;
  for (const [id,wound] of Object.entries(world.survival.campWounds??{})) {
    if (!Number.isFinite(wound?.recovery)) continue;
    if ((world.agents[id]?.viab?.v??0)>=wound.recovery-1e-6) {
      wound.recovery=null;
      changed=true;
    }
  }
  return changed;
}
