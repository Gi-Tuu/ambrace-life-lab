// V7.1 §7：累计行动账本（内存计数，不保存无限日志）。
// 区分 尝试 / 成功 / 规则拒绝 / 决策来源（reflex|habit|deliberation），并把玩家与居民分开。
// V7.2 E2/E3：同一口径补齐 开始/完成/中止/时间/体力/资源变化；服务端位置同步不算劳动。
const BOOK_FIELDS = ['attempt', 'success', 'refused', 'aborted', 'cancelled', 'byLayer', 'minutes', 'energy', 'resources'];
const SYNC_KINDS = new Set(['player_sync']); // 客户端位移同步：表现层事实，不是行动

const emptyBook = () => ({
  attempt: {}, success: {}, refused: {}, aborted: {}, cancelled: {}, byLayer: {},
  minutes: {}, energy: {}, resources: {},
  laborAttempt: 0, laborSuccess: 0, sync: 0,
});

export function ensureLedger(world) {
  const s = world?.survival;
  if (!s) return null;
  // 研究态保持旧账本形状（只有 attempt/success/refused/byLayer）⇒ 存档逐位不变。
  const extended = world.gameRules === true;
  const base = () => ({ attempt: {}, success: {}, refused: {}, byLayer: {} });
  s.actionLedger ??= { resident: extended ? emptyBook() : base(), player: extended ? emptyBook() : base() };
  if (extended) {
    for (const side of ['resident', 'player']) {
      const b = (s.actionLedger[side] ??= emptyBook());
      for (const f of BOOK_FIELDS) b[f] ??= {};
      b.laborAttempt ??= 0; b.laborSuccess ??= 0; b.sync ??= 0;
    }
  }
  return s.actionLedger;
}

// info：{ minutes, energy, resource, labor, started, completed }
export function noteAction(world, side, kind, ok, layer = null, info = {}) {
  const ledger = ensureLedger(world);
  if (!ledger || !kind) return;
  const sideBook = ledger[side];
  const extended = world.gameRules === true;
  if (SYNC_KINDS.has(kind)) { if (extended) sideBook.sync += 1; return; } // 不进 attempt/success ⇒ 不影响劳动成功率
  sideBook.attempt[kind] = (sideBook.attempt[kind] ?? 0) + 1;
  if (ok) sideBook.success[kind] = (sideBook.success[kind] ?? 0) + 1;
  if (side === 'resident' && layer) {
    const key = `${kind}:${layer}`;
    sideBook.byLayer[key] = (sideBook.byLayer[key] ?? 0) + 1;
  }
  if (!extended) return;
  if (info.minutes) sideBook.minutes[kind] = Number(((sideBook.minutes[kind] ?? 0) + info.minutes).toFixed(3));
  if (info.energy) sideBook.energy[kind] = Number(((sideBook.energy[kind] ?? 0) + info.energy).toFixed(4));
  if (Number.isFinite(info.resource) && info.resource !== 0) {
    sideBook.resources[kind] = (sideBook.resources[kind] ?? 0) + info.resource;
  }
  if (info.labor) {
    sideBook.laborAttempt += 1;
    if (ok) sideBook.laborSuccess += 1;
  }
}

export function noteRefusal(world, side, kind) {
  const ledger = ensureLedger(world);
  if (!ledger || !kind) return;
  const book = side === 'resident' ? ledger.resident : ledger.player;
  book.refused ??= {};
  book.refused[kind] = (book.refused[kind] ?? 0) + 1;
}

export function noteCancel(world, side, kind) {
  if (world?.gameRules !== true) return;
  const ledger = ensureLedger(world);
  if (!ledger || !kind) return;
  const book = side === 'resident' ? ledger.resident : ledger.player;
  book.cancelled ??= {};
  book.cancelled[kind] = (book.cancelled[kind] ?? 0) + 1;
}

export function noteAbort(world, side, kind) {
  if (world?.gameRules !== true) return; // 研究态不写新字段
  const ledger = ensureLedger(world);
  if (!ledger || !kind) return;
  const book = side === 'resident' ? ledger.resident : ledger.player;
  book.aborted ??= {};
  book.aborted[kind] = (book.aborted[kind] ?? 0) + 1;
}

const sum = (obj) => Object.values(obj ?? {}).reduce((a, n) => a + n, 0);
const sideStats = (book) => {
  if (!book) return null;
  const laborAttempt = book.laborAttempt ?? 0;
  const laborSuccess = book.laborSuccess ?? 0;
  return {
    attempt: sum(book.attempt), success: sum(book.success), refused: sum(book.refused), aborted: sum(book.aborted), cancelled: sum(book.cancelled),
    laborAttempt, laborSuccess,
    laborRate: laborAttempt ? Number((laborSuccess / laborAttempt).toFixed(4)) : null,
    sync: book.sync ?? 0,
    minutes: Number(sum(book.minutes).toFixed(2)), energy: Number(sum(book.energy).toFixed(4)),
    resources: Number(sum(book.resources).toFixed(2)),
  };
};

// 累计账本读数：长跑/报表统一从这里取，玩家与居民同一口径。
export function ledgerStats(world) {
  const L = world?.survival?.actionLedger;
  if (!L) return null;
  return { player: sideStats(L.player), resident: sideStats(L.resident) };
}

