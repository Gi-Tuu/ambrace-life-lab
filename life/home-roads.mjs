import { dayOf } from './clock.mjs';
import { campEntrance, distanceToRect } from '../web/camp-interaction.mjs';
import { residentialSite } from '../web/camp-layout.mjs';
import { worldSite } from './geometry.mjs';
import { regionPoint } from '../web/camp-region-entities.mjs';
import { isAlive } from './viability.mjs';

const fail=code=>({ok:false,code});
export function roadRule(w,id,action) {
  const {room,kind,from}=action, s=w.survival, a=w.agents[id];
  if (!s?.settlementLife || (!w.campLayout && !w.peripheralHomes?.[room]) || !residentialSite(room,w.peripheralHomes) ||
      !s.households?.deeds[room]) return fail('NO_ROAD_SITE');
  if (!isAlive(a) || (s.households.deeds[room].owner!==id && w.housing[id]!==room)) return fail('NO_AUTHORITY');
  const gate=campEntrance(room,worldSite(w,room),w.peripheralHomes);
  if (a.isPlayer ? w.campPlayerRoom || !regionPoint(from) || distanceToRect(from,gate)>1.6
    : w.loc[id]!==room) return fail('OUT_OF_REACH');
  const add=kind==='road_lay';
  if ((s.homeRoads?.[room]?.present??true)===add) return fail('ROAD_UNCHANGED');
  if ((s.roadCooldown?.[room]??-1)>dayOf(w.t)) return fail('ROAD_COOLDOWN');
  if (add && (w.pinv[id]?.stone??0)<1) return fail('NO_MATERIAL');
  return {ok:true};
}

export function changeRoad(w,id,action) {
  const gate=roadRule(w,id,action);
  if (!gate.ok) return gate;
  const present=action.kind==='road_lay', s=w.survival;
  if (present) {
    w.pinv[id].stone-=1;
    w.observeProduction?.('materialSpent','roadStone',1);
  }
  (s.homeRoads??={})[action.room]={present,by:id,t:w.t};
  (s.roadCooldown??={})[action.room]=dayOf(w.t)+4;
  return {ok:true,code:'OK'};
}

export function roadCandidate(w,id) {
  const s=w.survival, a=w.agents[id], room=w.loc[id];
  if (!s?.settlementLife || (!w.campLayout && !w.peripheralHomes?.[room]) || a.isPlayer || !residentialSite(room,w.peripheralHomes) ||
      s.households?.deeds[room]?.owner!==id || a.drives.v.energy<.42) return null;
  const privateLife=a.traits.comfortAlone>=.76 && a.drives.v.social>=a.drives.setpoint.social;
  const hasRoad=s.homeRoads?.[room]?.present??true;
  const kind=privateLife?'road_remove':'road_lay';
  if (hasRoad===!privateLife || !roadRule(w,id,{kind,room}).ok) return null;
  return {kind,room,value:privateLife?.24:.37};
}
