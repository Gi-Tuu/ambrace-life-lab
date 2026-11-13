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
