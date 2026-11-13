import { CURRENT_EVENT_RULES } from './rng.mjs';
import { dayOf, DAY_TICKS } from './clock.mjs';
import { residentialSite, HOUSING_PLOTS } from '../web/camp-layout.mjs';
import { isAlive } from './viability.mjs';

export const ADULT_DAYS = 12;
export const INFANT_DAYS = 3;   // P1-1：0–3 天婴幼儿
export const ELDER_DAYS = 60;   // P1-1：60 天起老年（两季）
export const RESIDENT_CAP = 10; // P1-3：存活居民上限（算力/生态承载），不含玩家
const BEDS = 4;
export const bedsPerHome = w => w.populationExperiment?.bedsPerHome ?? BEDS;
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

// P1-1 生命周期阶段：婴幼儿→儿童→成年→老年（死亡由 viability/reapDeaths 管）。
// 无 households 或无出生记录（初始 roster/旧档）＝成年 ⇒ lab/town 与 sweep 基线逐位不变。
export function residentStage(w, id) {
  const resident = w.survival.households?.residents[id];
  if (!resident) return 'adult';
  const age = (w.t - resident.born) / DAY_TICKS;
  if (age < INFANT_DAYS) return 'infant';
  if (age < ADULT_DAYS) return 'child';
  if (age < ELDER_DAYS) return 'adult';
  return 'elder';
}
export const ageDays = (w, id) => {
  const r = w.survival.households?.residents[id];
  return r ? (w.t - r.born) / DAY_TICKS : ADULT_DAYS;
};
export const isChildStage = (stage) => stage === 'infant' || stage === 'child';
// 劳动能力：成年与老年可劳动（老年减产）；婴幼儿/儿童不能劳动（P1-1：儿童不具成年劳动能力）。
export const laborStage = (w, id) => { const s = residentStage(w, id); return s === 'adult' || s === 'elder'; };

const WORK_ACTIONS = new Set(['harvest', 'plant', 'gather', 'house_work', 'forage', 'exchange',
  'expand', 'build', 'plan', 'repair', 'deposit', 'withdraw']);
export const isLaborAction = kind => WORK_ACTIONS.has(kind);
export const laborAllowed = (w, id, kind) =>
  !w.survival?.households || !isLaborAction(kind) || laborStage(w, id);

const adult = (w, id) => Object.hasOwn(w.agents, id) && residentStage(w, id) === 'adult' && isAlive(w.agents[id]); // 婚育仅成年（老年不繁衍）；死者排除
const relation = (w, a, b) => w.agents[a].relations?.map.get(b);
const trust = (w, a, b) => relation(w, a, b)?.trust ?? 30;
const sameRoom = (w, a, b) => w.loc[a] === w.loc[b];
export const residentsAt = (w, room) => Object.entries(w.housing).filter(([id, home]) => home === room && isAlive(w.agents[id])).length; // P0-1：床位按存活人口，死者腾出床位
const hasBed = (w, room) => Object.hasOwn(w.survival.households.deeds, room) && residentsAt(w, room) < bedsPerHome(w);
export const housingMode = w => w.familyExperiment?.housing ?? (w.eventRulesVersion === CURRENT_EVENT_RULES ? 'inherit' : 'legacy');
const canWork = (w, id) => isAlive(w.agents[id]) && laborStage(w, id);
const dependents = (w, id) => Object.keys(w.survival.households.residents).filter(child =>
  (housingMode(w) === 'legacy' || isAlive(w.agents[child])) && isChildStage(residentStage(w, child)) && w.housing[child]===w.housing[id] &&
  w.survival.households.residents[child].parents.includes(id));
const canShare = (w, a, b) => Boolean(w.housing[b] && w.housing[a] !== w.housing[b] &&
  hasBed(w, w.housing[b]) && residentsAt(w, w.housing[b]) + dependents(w, a).length < bedsPerHome(w));
const willing = (w, a, b) => trust(w, a, b) >= MARRIAGE_TRUST && (relation(w,a,b)?.familiarity ?? 0) >= .45;
const marriageMode = w => w.familyExperiment?.marriage ?? (w.eventRulesVersion === CURRENT_EVENT_RULES ? 'remarry' : 'legacy');
export const maritalStatus = (h, id) => h.spouses[id] ? 'married' : h.widowed?.[id] ? 'widowed' : 'single';

const canMarry = (w, a, b) => {
  const h = w.survival.households;
  if (!adult(w, a) || !adult(w, b) || a === b || h.spouses[a] || h.spouses[b]) return false;
  if (marriageMode(w) === 'widowOnly' && (h.widowed?.[a] || h.widowed?.[b])) return false;
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
  w.observeFamilyMarriage?.({ t: w.t, partners: [a, b].sort() });
  if (marriageMode(w) !== 'legacy') {
    const remarried = [a, b].filter(id => h.widowed?.[id]);
    (h.marriages ??= []).push({ partners: [a, b].sort(), t: w.t, remarried });
    for (const id of remarried) delete h.widowed[id];
  }
}

// Reconcile after all deaths in a tick have been recorded, including when loading an old V2 archive.
export function settleMarriages(w) {
  const h = w.survival.households;
  if (!h || marriageMode(w) === 'legacy') return;
  h.offers = h.offers.filter(({ from, to }) => !w.agents[from]?.dead && !w.agents[to]?.dead);
  for (const [a, b] of Object.entries(h.spouses)) {
    if (h.spouses[a] !== b || h.spouses[b] !== a) continue;
    const deaths = [a, b].filter(id => w.agents[id]?.dead);
    if (!deaths.length) continue;
    const partners = [a, b].sort();
    const t = h.marriedAt?.[a] ?? h.marriedAt?.[b] ?? null;
    const ended = Math.min(...deaths.map(id => w.agents[id].death?.t ?? w.t));
    const deceased = deaths.filter(id => (w.agents[id].death?.t ?? w.t) === ended).sort();
    const marriages = h.marriages ??= [];
    let record = marriages.findLast(m => m.ended === undefined && m.partners[0] === partners[0] && m.partners[1] === partners[1]);
    if (!record) {
      record = { partners, t, remarried: [] };
      marriages.push(record);
    }
    Object.assign(record, { ended, deceased });
    for (const id of partners) {
      delete h.spouses[id];
      if (h.marriedAt) delete h.marriedAt[id];
      if (!deceased.includes(id)) (h.widowed ??= {})[id] = { spouse: deceased[0], t: ended };
    }
  }
}

export function houseAction(w, actor, { kind, target, accept }) {
  const h = w.survival.households;
  if (!h || !adult(w, actor)) return fail('ADULT_REQUIRED');
  // P0-B2：危机（failed=crisis）不等于灭绝；正式游戏里家庭仍可行动。
  if (w.survival.ended) return fail('FAMILY_ENDED');
  if (!w.independentWorld && w.survival.failed) return fail('FAMILY_ENDED');
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
      if (marriageMode(w) !== 'legacy' && !willing(w, offer.from, actor)) return fail('OFFER_DECLINED');
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
    if (kind === 'family_marry' && marriageMode(w) !== 'legacy' && !w.agents[actor].isPlayer &&
        !willing(w, actor, target)) return fail('OFFER_DECLINED');
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
  if (housingMode(w) !== 'legacy') {
    recordHousing(w, { kind: 'purchase', room, from: deed.owner, to: actor });
    w.locs[room] = `${w.agents[actor].name}的小屋`;
  }
  moveHome(w, actor, room);
  return true;
}

function startHome(w, actor, room) {
  const h = w.survival.households, bag = w.pinv[actor];
  if (!Object.hasOwn(HOUSING_PLOTS, room) || Object.hasOwn(h.deeds, room) ||
      Object.hasOwn(h.projects, room) || !affordable(bag, BUILD)) return false;
  transfer(bag, null, BUILD);
  h.projects[room] = { owner: actor, started: w.t, progress: 0 };
  w.observeProduction?.('materialSpent', 'houseWood', BUILD.wood);
  w.observeProduction?.('materialSpent', 'houseStone', BUILD.stone);
  if (housingMode(w) !== 'legacy') recordHousing(w, { kind: 'start', room, owner: actor });
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

function recordHousing(w, event) {
  (w.survival.households.housingHistory ??= []).push({ t: w.t, ...event });
}

function finishHome(w, room, project, log) {
  const h = w.survival.households, id = project.owner;
  delete h.projects[room];
  if (Object.hasOwn(h.deeds, room)) return;
  h.deeds[room] = { owner: id };
  w.locs[room] = `${w.agents[id].name}的小屋`;
  if (isAlive(w.agents[id])) moveHome(w, id, room);
  if (h.residents[id]) mark(h.residents[id], 'built', w);
  if (housingMode(w) !== 'legacy') recordHousing(w, { kind: 'finish', room, owner: id });
  w.observeHomeComplete?.({ t: w.t, room, owner: id });
  log?.push({ t: w.t, kind: 'home', ok: true, code: `${w.agents[id].name}建成新房` });
}

export function settleHousing(w, log) {
  const h = w.survival.households;
  if (!h || housingMode(w) === 'legacy') return;
  for (const [room, project] of Object.entries(h.projects)) {
    if (w.agents[project.owner] && !w.agents[project.owner].dead) continue;
    if (project.progress >= WORK_DAYS && w.agents[project.owner]) finishHome(w, room, project, log);
    else if (project.pausedAt == null) {
      project.pausedAt = w.agents[project.owner]?.death?.t ?? w.t;
      recordHousing(w, { kind: 'pause', room, owner: project.owner });
    }
  }
  if (housingMode(w) !== 'inherit') return;
  for (const [room, deed] of Object.entries(h.deeds)) {
    const owner = deed.owner;
    if (owner && (!w.agents[owner] || w.agents[owner].dead)) {
      const spouse = h.spouses[owner] ?? h.marriages?.findLast(m => m.deceased?.includes(owner) &&
        m.ended === w.agents[owner]?.death?.t)?.partners.find(id => id !== owner);
      const children = Object.keys(h.residents).filter(id => canWork(w, id) && h.residents[id].parents.includes(owner));
      children.sort((a, b) => Number(w.housing[b] === room) - Number(w.housing[a] === room) ||
        h.residents[a].born - h.residents[b].born || a.localeCompare(b));
      deed.owner = isAlive(w.agents[spouse]) ? spouse : children[0] ?? null;
      deed.listed = !deed.owner && !residentsAt(w, room);
      w.locs[room] = deed.owner ? `${w.agents[deed.owner].name}的小屋` : deed.listed ? '待售小屋' : '住用公房';
      recordHousing(w, { kind: 'inherit', room, from: owner, to: deed.owner });
    } else if (!owner && !deed.listed && !residentsAt(w, room)) {
      deed.listed = true;
      w.locs[room] = '待售小屋';
      recordHousing(w, { kind: 'list', room });
    }
  }
}

function resumeProjects(w, adults) {
  const h = w.survival.households;
  for (const [room, project] of Object.entries(h.projects)) {
    if (project.pausedAt == null || canWork(w, project.owner)) continue;
    const successor = adults.find(id => !w.agents[id].isPlayer && h.residents[id]?.decision === 'seeking' &&
      !Object.values(h.projects).some(other => other.owner === id));
    if (successor) {
      const from = project.owner;
      project.owner = successor;
      delete project.pausedAt;
      mark(h.residents[successor], 'building', w);
      recordHousing(w, { kind: 'resume', room, from, to: successor });
    } else if (dayOf(w.t) - dayOf(project.pausedAt) >= WORK_DAYS) {
      // Materials were spent when construction began. Cancelling removes the unfinished work.
      delete h.projects[room];
      recordHousing(w, { kind: 'cancel', room, owner: project.owner });
    }
  }
}

export function stepHouseholds(w, log) {
  const h = w.survival.households;
  const day = dayOf(w.t);
  const adults = Object.keys(w.agents).filter(id => adult(w, id));
  const legacy = housingMode(w) === 'legacy';
  if (!legacy) {
    settleHousing(w, log);
    resumeProjects(w, adults);
  }
  for (const [room, project] of Object.entries(h.projects)) {
    if (project.started === w.t || project.progress < WORK_DAYS) continue;
    if (legacy ? !adults.includes(project.owner) || project.lastWorkDay !== day - 1 : !canWork(w, project.owner)) continue;
    finishHome(w, room, project, log);
  }

  for (const [id, person] of Object.entries(h.residents)) {
    if (!adults.includes(id) || ['stayed', 'bought', 'built', 'building'].includes(person.decision)) continue;
    const room = w.housing[id];
    const parents = person.parents.filter(p => adults.includes(p) && w.housing[p] === room);
    const allowed = parents.length > 0 && parents.every(p =>
      w.agents[p].isPlayer ? person.stayAllowed === true : trust(w, p, id) >= 30);
    const bag = w.pinv[id];
    const crowded = !room || residentsAt(w, room) >= bedsPerHome(w);
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
  if (!work || (housingMode(w) !== 'legacy' && !canWork(w, id)) || w.loc[id] !== 'workshop' || work.lastWorkDay === day || work.progress >= WORK_DAYS) return false;
  if (apply) {
    work.lastWorkDay = day;
    work.progress += housingMode(w) !== 'legacy' && residentStage(w, id) === 'elder' ? .5 : 1;
  }
  return true;
}

export function householdPlans(w, id) {
  const h = w.survival.households;
  const person = h?.residents[id];
  if (!person) return null;
  if (housingMode(w) !== 'legacy' && person.decision === 'building' && canWork(w, id)) {
    const work = Object.values(h.projects).find(p => p.owner === id);
    return work && work.progress < WORK_DAYS && work.lastWorkDay !== dayOf(w.t) ? 'workshop' : null;
  }
  if (!adult(w, id)) return null;
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

export const strictLifecycle = w => (w.lifecycleRulesVersion ?? w.eventRulesVersion) === CURRENT_EVENT_RULES;

export function birthHomeStatus(w,a,b) {
  if (strictLifecycle(w) && (!adult(w,a) || !adult(w,b))) return { reason:'age' };
  const h=w.survival.households, room=w.housing[a];
  if (h.spouses[a] !== b) return { reason:'marriage' };
  if (room !== w.housing[b]) return { reason:'residence' };
  if (!hasBed(w,room)) return { reason:'beds' };
  return { room };
}

export function familyHomeForBirth(w, a, b) {
  return birthHomeStatus(w,a,b).room ?? null;
}

export function restoreHouseholds(w, housing) {
  const h = w.survival.households;
  if (!h) return;
  for (const [id, room] of Object.entries(housing ?? {})) {
    if (Object.hasOwn(w.agents, id) && residentialSite(room) && Object.hasOwn(h.deeds, room)) w.housing[id] = room;
  }
  for (const [room, deed] of Object.entries(h.deeds)) {
    if (residentialSite(room)) w.locs[room] = deed.owner ? `${w.agents[deed.owner]?.name ?? '居民'}的小屋` : housingMode(w) !== 'inherit' || deed.listed ? '待售小屋' : '住用公房';
  }
}
