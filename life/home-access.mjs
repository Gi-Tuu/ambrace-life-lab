import { residentialSite } from '../web/camp-layout.mjs';
import { DAY_TICKS } from './clock.mjs';
import { isAlive } from './viability.mjs';

const fail = code => ({ ok:false, code });
const ok = { ok:true, code:'OK' };
const grants = w => w.survival.homeAccess ??= {};
const ownerOf = (w, room) => w.survival.households?.deeds[room]?.owner;
const resident = (w,id,room) => isAlive(w.agents[id]) && w.housing?.[id] === room;

export function householdAccess(w, id, room) {
  return resident(w,id,room) || (ownerOf(w,room) === id && isAlive(w.agents[id]));
}

function activeGrant(w,room,g) {
  return isAlive(w.agents[g.to]) && isAlive(w.agents[g.by]) && g.owner === ownerOf(w,room) &&
    (g.type === 'invite' ? householdAccess(w,g.by,room) && w.t < g.until : g.by === g.owner);
}

export function homeEntry(w,id,room) {
  if (!w.survival?.settlementLife || !residentialSite(room,w.peripheralHomes)) return ok;
  const deed=w.survival.households?.deeds[room];
  if (!deed) return w.survival.households?.projects[room]?.owner===id && !w.agents[id]?.isPlayer ? ok : fail('NO_HOME');
  if (householdAccess(w,id,room)) return ok;
  if (!deed.owner && deed.listed) return ok;
  if ((w.survival.homeAccess?.[room] ?? []).some(g=>g.to===id && activeGrant(w,room,g))) return ok;
  if ((w.survival.brokenDoors?.[room] ?? 0) >= .5) return ok;
  return fail('HOME_LOCKED');
}

export function changeHomeAccess(w,id,{room,target,type,kind}) {
  if (!w.survival.settlementLife || !residentialSite(room,w.peripheralHomes) || !w.survival.households?.deeds[room]) return fail('NO_HOME');
  if (!['key','invite','permission'].includes(type)) return fail('BAD_ACCESS');
  if (!Object.hasOwn(w.agents,target) || !isAlive(w.agents[target]) || target===id) return fail('NO_RESIDENT');
  const owner=ownerOf(w,room), revoke=kind==='home_revoke';
  if (revoke) {
    if (owner!==id && !(grants(w)[room]??[]).some(g=>g.by===id && g.to===target && g.type===type))
      return fail('NO_AUTHORITY');
  } else if (type==='invite' ? !householdAccess(w,id,room) : owner!==id) return fail('NO_AUTHORITY');
  const rows=(grants(w)[room]??[]).filter(g=>activeGrant(w,room,g) &&
    !(g.to===target && g.type===type && (g.by===id || owner===id)));
  if (!revoke) rows.push({ type, by:id, to:target, owner, ...(type==='invite'?{until:w.t+DAY_TICKS}:{}) });
  grants(w)[room]=rows;
  return ok;
}

export function doorWork(w,id,room,kind,tool) {
  const s=w.survival;
  if (!s.settlementLife || !residentialSite(room,w.peripheralHomes) || !s.households?.deeds[room]) return fail('NO_HOME');
  if (tool!=='hammer') return fail('NEED_TOOL');
  const doors=s.brokenDoors??={}, damage=doors[room]??0;
  if (kind==='home_fix') {
    if (!householdAccess(w,id,room)) return fail('NO_AUTHORITY');
    if (!damage) return fail('NO_REPAIR');
    const bag=w.pinv[id];
    if (!(bag.wood>=1)) return fail('NO_MATERIAL');
    bag.wood-=1;
    delete doors[room];
    return ok;
  }
  if (homeEntry(w,id,room).ok) return fail('DOOR_OPEN');
  doors[room]=Math.min(1,damage+.5);
  for (const a of Object.values(w.agents)) {
    if (a.id===id || !isAlive(a) || !householdAccess(w,a.id,room)) continue;
    a.relations.meet(id,w.t,{delta:{trust:-15},why:'破门'});
    w.pending.push({for:a.id,evt:{kind:'trespass',valence:-.65,about:id,serves:'safety'}});
  }
  const history=s.doorHistory??=[];
  history.push({t:w.t,kind:'break',room,actor:id,owner:ownerOf(w,room)});
  if (history.length>80) history.shift();
  return ok;
}

export function homeAccessView(w,id) {
  const s=w.survival;
  if (!s.settlementLife) return undefined;
  return Object.fromEntries(Object.entries(s.households?.deeds??{}).map(([room,deed])=>[room,{
    owner:deed.owner, resident:householdAccess(w,id,room), entry:homeEntry(w,id,room).ok,
    damage:s.brokenDoors?.[room]??0, grants:(s.homeAccess?.[room]??[]).filter(g=>activeGrant(w,room,g) &&
      (g.to===id || g.by===id || deed.owner===id)),
  }]));
}
