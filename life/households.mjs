import { dayOf, DAY_TICKS } from './clock.mjs';
import { residentialSite, HOUSING_PLOTS } from '../web/camp-layout.mjs';

export const ADULT_DAYS = 12;
const BEDS = 4;
const BUILD = { wood: 5, stone: 3 };
const PRICE = { wood: 3, stone: 2 };
const WORK_DAYS = 3;
const MARRIAGE_TRUST = 52;
const COHABIT_TRUST = 46;
const ok = () => ({ ok: true, code: 'OK' });
const fail = code => ({ ok: false, code });

export function makeHouseholds(housing) {
  return {
    residents: {}, spouses: {}, offers: [], projects: {},
    deeds: { ...Object.fromEntries(Object.entries(housing).map(([id, room]) => [room, { owner: id }])),
      house5: { owner: null, listed: true } },
    receipts: { wood: 0, stone: 0 },
  };
}

export function residentStage(w, id) {
  const resident = w.survival.households?.residents[id];
  return resident && w.t - resident.born < ADULT_DAYS * DAY_TICKS ? 'child' : 'adult';
}

const adult = (w, id) => Object.hasOwn(w.agents, id) && residentStage(w, id) === 'adult' &&
  (w.agents[id].viab?.v ?? 1) > 0;
const relation = (w, a, b) => w.agents[a].relations?.map.get(b);
const trust = (w, a, b) => relation(w, a, b)?.trust ?? 30;
const sameRoom = (w, a, b) => w.loc[a] === w.loc[b];
const residentsAt = (w, room) => Object.values(w.housing).filter(home => home === room).length;
const hasBed = (w, room) => Object.hasOwn(w.survival.households.deeds, room) && residentsAt(w, room) < BEDS;
const dependents = (w, id) => Object.keys(w.survival.households.residents).filter(child =>
  residentStage(w, child)==='child' && w.housing[child]===w.housing[id] &&
  w.survival.households.residents[child].parents.includes(id));
const canShare = (w, a, b) => Boolean(w.housing[b] && w.housing[a] !== w.housing[b] &&
  hasBed(w, w.housing[b]) && residentsAt(w, w.housing[b]) + dependents(w, a).length < BEDS);
const willing = (w, a, b) => trust(w, a, b) >= MARRIAGE_TRUST && (relation(w,a,b)?.familiarity ?? 0) >= .45;
const canMarry = (w, a, b) => {
  const h = w.survival.households;
  if (!adult(w, a) || !adult(w, b) || a === b || h.spouses[a] || h.spouses[b]) return false;
  const parents = h.residents[a]?.parents ?? [];
  const otherParents = h.residents[b]?.parents ?? [];
  return !parents.includes(b) && !otherParents.includes(a) && !parents.some(id => otherParents.includes(id));
};

function moveHome(w, id, room) {
  w.housing[id] = room;
}

function cohabit(w, id, room) {
  for (const child of dependents(w, id)) moveHome(w, child, room);
  moveHome(w, id, room);
}

function unite(w, a, b) {
  const h = w.survival.households;
  h.spouses[a] = b;
  h.spouses[b] = a;
  h.marriedAt ??= {};
  h.marriedAt[a] = h.marriedAt[b] = w.t;
}

export function houseAction(w, actor, { kind, target, accept }) {
  const h = w.survival.households;
  if (!h || !adult(w, actor)) return fail('ADULT_REQUIRED');
  if (w.survival.ended || w.survival.failed) return fail('FAMILY_ENDED');
  if (kind === 'family_answer') {
    const offer = h.offers.find(o => o.to === actor && o.from === target);
    if (!offer) return fail('NO_OFFER');
    if (accept !== true) {
      h.offers = h.offers.filter(o => o !== offer);
      return ok();
    }
    if (!adult(w, offer.from) || !sameRoom(w, actor, offer.from)) return fail('MEET_REQUIRED');
    if (offer.kind === 'family_marry') {
      if (!canMarry(w, offer.from, actor)) return fail('MARRIAGE_UNAVAILABLE');
      unite(w, offer.from, actor);
    } else {
      if (h.spouses[offer.from] !== actor || !canShare(w, offer.from, actor) ||
          w.housing[actor] !== offer.room) return fail('NO_BED');
      cohabit(w, offer.from, offer.room);
    }
    h.offers = h.offers.filter(o => o !== offer);
    return ok();
  }
  if (kind === 'family_marry' || kind === 'family_move') {
    if (!adult(w, target) || !sameRoom(w, actor, target)) return fail('MEET_REQUIRED');
    if (kind === 'family_marry' && !canMarry(w, actor, target)) return fail('MARRIAGE_UNAVAILABLE');
    if (kind === 'family_move' && (h.spouses[actor] !== target || !canShare(w, actor, target))) return fail('NO_BED');
    if (w.agents[target].isPlayer) {
      if (!h.offers.some(o => o.to === target && o.from === actor)) {
        h.offers.push({ from: actor, to: target, kind, room: w.housing[target], t: w.t });
      }
      return ok();
    }
    if (kind === 'family_marry' ? !willing(w, target, actor) :
        trust(w, target, actor) < COHABIT_TRUST) return fail('OFFER_DECLINED');
    if (kind === 'family_marry') unite(w, actor, target);
    else cohabit(w, actor, w.housing[target]);
    return ok();
  }
  if (kind === 'family_stay') {
    const person = Object.hasOwn(h.residents, target) ? h.residents[target] : null;
    if (!person?.parents.includes(actor)) return fail('NO_FAMILY');
    person.stayAllowed = accept === true;
    return ok();
  }
  if (kind === 'family_list') {
    if (!Object.hasOwn(h.deeds, target)) return fail('NO_DEED');
    const deed = h.deeds[target];
    if (deed.owner !== actor || residentsAt(w, target)) return fail('HOME_OCCUPIED');
    deed.listed = accept === true;
    return ok();
  }
  return fail('UNKNOWN_KIND');
}

const affordable = (bag, cost) => bag.wood >= cost.wood && bag.stone >= cost.stone;
function transfer(bag, receiver, cost) {
  for (const key of ['wood', 'stone']) {
    bag[key] -= cost[key];
    if (receiver) receiver[key] = (receiver[key] ?? 0) + cost[key];
  }
}

function marketHome(w, actor, room) {
  const h = w.survival.households, bag = w.pinv[actor];
  if (!Object.hasOwn(h.deeds, room)) return false;
  const deed = h.deeds[room];
  if (!deed.listed || deed.owner === actor || residentsAt(w, room) || !affordable(bag, PRICE)) return false;
  transfer(bag, deed.owner ? w.pinv[deed.owner] : h.receipts, PRICE);
  h.deeds[room] = { owner: actor };
  moveHome(w, actor, room);
  return true;
}

function startHome(w, actor, room) {
  const h = w.survival.households, bag = w.pinv[actor];
  if (!Object.hasOwn(HOUSING_PLOTS, room) || Object.hasOwn(h.deeds, room) ||
      Object.hasOwn(h.projects, room) || !affordable(bag, BUILD)) return false;
  transfer(bag, null, BUILD);
  h.projects[room] = { owner: actor, started: w.t, progress: 0 };
  return true;
}

const mark = (person, decision, w) => {
  person.decision = decision;
  person.decisionAt = w.t;
};

export function stepRelationships(w, log) {
  const h = w.survival.households;
  const day = dayOf(w.t);
  h.offers = h.offers.filter(o => day - dayOf(o.t) <= 2);
  const adults = Object.keys(w.agents).filter(id => adult(w, id));
  for (const a of adults) {
    if (w.agents[a].isPlayer) continue;
    if (!h.spouses[a]) {
      const b = adults.find(b => sameRoom(w, a, b) && canMarry(w, a, b) && willing(w, a, b) &&
        w.sex[a] !== w.sex[b] && (w.agents[b].isPlayer || willing(w, b, a)));
      if (b && houseAction(w, a, { kind: 'family_marry', target: b }).ok && h.spouses[a]) {
        log.push({ t: w.t, kind: 'marriage', ok: true, code: `${w.agents[a].name}与${w.agents[b].name}结婚` });
      }
    } else if (w.t - (h.marriedAt?.[a] ?? 0) >= DAY_TICKS) {
      const b = h.spouses[a];
      if (sameRoom(w, a, b) && trust(w, a, b) >= COHABIT_TRUST && canShare(w, a, b)) {
        const old = w.housing[a];
        if (houseAction(w, a, { kind: 'family_move', target: b }).ok && w.housing[a] !== old) {
          if (h.deeds[old]?.owner === a && !residentsAt(w, old)) h.deeds[old].listed = true;
          log.push({ t: w.t, kind: 'cohabit', ok: true, code: `${w.agents[a].name}与${w.agents[b].name}同住` });
        }
      }
    }
  }
}

export function stepHouseholds(w, log) {
  const h = w.survival.households;
  const day = dayOf(w.t);
  const adults = Object.keys(w.agents).filter(id => adult(w, id));
  for (const [room, project] of Object.entries(h.projects)) {
    if (!adults.includes(project.owner) || project.started === w.t) continue;
    if (project.lastWorkDay !== day - 1) continue;
    if (project.progress < WORK_DAYS) continue;
    h.deeds[room] = { owner: project.owner };
    w.locs[room] = `${w.agents[project.owner].name}的小屋`;
    moveHome(w, project.owner, room);
    mark(h.residents[project.owner], 'built', w);
    delete h.projects[room];
    log.push({ t: w.t, kind: 'home', ok: true, code: `${w.agents[project.owner].name}建成新房` });
  }

  for (const [id, person] of Object.entries(h.residents)) {
    if (!adults.includes(id) || ['stayed', 'bought', 'built', 'building'].includes(person.decision)) continue;
    const room = w.housing[id];
    const parents = person.parents.filter(p => adults.includes(p) && w.housing[p] === room);
    const allowed = parents.length > 0 && parents.every(p =>
      w.agents[p].isPlayer ? person.stayAllowed === true : trust(w, p, id) >= 30);
    const bag = w.pinv[id];
    const crowded = !room || residentsAt(w, room) >= BEDS;
    const stayScore = allowed && !crowded ? (w.agents[id].traits.archetype === '孤僻' ? 1 : 4) : 0;
    const sale = Object.keys(h.deeds).find(k => h.deeds[k].listed && h.deeds[k].owner !== id && !residentsAt(w, k));
    const plot = Object.keys(HOUSING_PLOTS).find(k => !Object.hasOwn(h.deeds, k) && !Object.hasOwn(h.projects, k));
    const buyScore = sale && affordable(bag, PRICE) ? 3 : 0;
    const buildScore = plot && affordable(bag, BUILD) ? (w.agents[id].traits.archetype === '孤僻' ? 4 : 2) : 0;
    if (stayScore > 0 && stayScore >= Math.max(buyScore, buildScore)) mark(person, 'stayed', w);
    else if (buyScore > 0 && buyScore >= buildScore && marketHome(w, id, sale)) mark(person, 'bought', w);
    else if (buildScore > 0 && startHome(w, id, plot)) mark(person, 'building', w);
    else {
      if (!person.decision) mark(person, 'seeking', w);
      continue;
    }
    log.push({ t: w.t, kind: 'home', ok: true, code: `${w.agents[id].name}${{ stayed:'成年后留家', bought:'买下空房', building:'开始建房' }[person.decision]}` });
  }
}

export function houseLabor(w, id, apply = false) {
  const h = w.survival?.households;
  const work = h && Object.values(h.projects).find(p => p.owner === id);
  const day = dayOf(w.t);
  if (!work || w.loc[id] !== 'workshop' || work.lastWorkDay === day || work.progress >= WORK_DAYS) return false;
  if (apply) {
    work.lastWorkDay = day;
    work.progress += 1;
  }
  return true;
}

export function householdPlans(w, id) {
  const h = w.survival.households;
  const person = h?.residents[id];
  if (!person || !adult(w, id)) return null;
  if (person.decision === 'building') return Object.values(h.projects).some(p=>p.owner===id && p.lastWorkDay===dayOf(w.t)) ? null : 'workshop';
  if (person.decision !== 'seeking') return null;
  const cost = Object.values(h.deeds).some(d => d.listed) ? PRICE : BUILD;
  const bag = w.pinv[id];
  if (bag.wood < cost.wood) return 'yard';
  if (bag.stone < cost.stone) return 'watch';
  if (bag.wood < BUILD.wood) return 'yard';
  if (bag.stone < BUILD.stone) return 'watch';
  return null;
}

export function familyHomeForBirth(w, a, b) {
  const h = w.survival.households;
  const room = w.housing[a];
  return h.spouses[a] === b && room === w.housing[b] && hasBed(w, room) ? room : null;
}

export function restoreHouseholds(w, housing) {
  const h = w.survival.households;
  if (!h) return;
  for (const [id, room] of Object.entries(housing ?? {})) {
    if (Object.hasOwn(w.agents, id) && residentialSite(room) && Object.hasOwn(h.deeds, room)) w.housing[id] = room;
  }
  for (const [room, deed] of Object.entries(h.deeds)) {
    if (residentialSite(room)) w.locs[room] = deed.owner ? `${w.agents[deed.owner]?.name ?? '居民'}的小屋` : '待售小屋';
  }
}
