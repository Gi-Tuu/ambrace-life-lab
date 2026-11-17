// V7.2 D1：资源账本（只统计正式游戏，研究态不写 ⇒ 基线逐位不变）。
// 分清：自然环境产出（gross）、个人获得（personal）、公共入库（publicIn）、超容量损失（overflow）、
// 环境损失（envLoss）、已消费（consumed，按入口分 by）。
const BUCKETS = ['gross', 'personal', 'publicIn', 'overflow', 'envLoss', 'consumed'];
export const RES_KINDS = Object.freeze(['crop', 'berry', 'fruit', 'egg', 'milk', 'meat', 'wool', 'wood', 'stone', 'water']);

export function ensureResLedger(world) {
  if (world?.gameRules !== true) return null; // 研究态没有这本账
  const s = world.survival;
  if (!s) return null;
  s.resLedger ??= { gross: {}, personal: {}, publicIn: {}, overflow: {}, envLoss: {}, consumed: {} };
  for (const b of BUCKETS) s.resLedger[b] ??= {};
  return s.resLedger;
}

export function noteRes(world, bucket, kind, n = 0) {
  if (!(n > 0)) return;
  const L = ensureResLedger(world);
  if (!L) return;
  L[bucket][kind] = (L[bucket][kind] ?? 0) + n;
}

export function noteConsumed(world, kind, by, n = 1) {
  if (!(n > 0)) return;
  const L = ensureResLedger(world);
  if (!L) return;
  (L.consumed[kind] ??= {})[by] = (L.consumed[kind][by] ?? 0) + n;
}

const total = (obj) => Object.values(obj ?? {}).reduce((a, n) => a + n, 0);

export function resLedgerView(world) {
  const L = world?.survival?.resLedger;
  if (!L) return null;
  const consumed = {};
  for (const [kind, by] of Object.entries(L.consumed ?? {})) consumed[kind] = { total: total(by), ...by };
  const consumedTotal = Object.values(consumed).reduce((a, c) => a + c.total, 0);
  return {
    gross: { ...L.gross }, personal: { ...L.personal }, publicIn: { ...L.publicIn },
    overflow: { ...L.overflow }, envLoss: { ...L.envLoss }, consumed,
    totals: {
      gross: total(L.gross), personal: total(L.personal), publicIn: total(L.publicIn),
      overflow: total(L.overflow), envLoss: total(L.envLoss), consumed: consumedTotal,
    },
    lastOverflow: world.survival.lastOverflow ?? null,
  };
}
