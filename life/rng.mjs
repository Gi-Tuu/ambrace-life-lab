export function makeRng(seed) {
  let a = (seed >>> 0) || 1;
  function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  // C2：闭包内部进度可存档/恢复；新世界与旧调用方不受影响。
  rng.state = () => a >>> 0;
  rng.restore = (st) => { a = (Number(st) >>> 0) || 1; };
  return rng;
}

export function gauss(rng) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export const hashSeed = (base, salt) => {
  let h = (base >>> 0) || 1;
  for (const ch of String(salt)) h = (Math.imul(h, 31) ^ ch.charCodeAt(0)) >>> 0;
  return h || 1;
};

// FNV-1a over a framed tuple, then MurmurHash3 fmix32 to avalanche adjacent inputs.
export function eventRoll(seed, eventType, entityId, day, sequence = 0) {
  const key = JSON.stringify([seed, eventType, entityId, day, sequence]);
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 0x100000000;
}

export const LEGACY_EVENT_RULES = 1;
export const CURRENT_EVENT_RULES = 2;

export function survivalRoll(world, type, id, day) {
  const seed = world.seed ?? 7;
  if (world.eventRulesVersion === CURRENT_EVENT_RULES) return eventRoll(seed, type, id, day);
  if (type === 'birth-sex') return (hashSeed(seed, `sex:${id}`) % 2) / 2;
  const [tag, divisor] = { 'elder-death': ['age', 1000], 'chicken-birth': ['ch', 10000], 'orchard-birth': ['or', 10000] }[type];
  return (hashSeed(seed, `${tag}:${id}:${day}`) % divisor) / divisor;
}
