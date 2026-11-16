// V7.1 §7：累计行动账本（内存计数，不保存无限日志）。
// 区分 尝试 / 成功 / 规则拒绝 / 决策来源（reflex|habit|deliberation），并把玩家与居民分开。
export function ensureLedger(world) {
  const s = world?.survival;
  if (!s) return null;
  s.actionLedger ??= {
    resident: { attempt: {}, success: {}, refused: {}, byLayer: {} },
    player: { attempt: {}, success: {} },
  };
  return s.actionLedger;
}

export function noteAction(world, side, kind, ok, layer = null) {
  const ledger = ensureLedger(world);
  if (!ledger || !kind) return;
  const sideBook = ledger[side];
  sideBook.attempt[kind] = (sideBook.attempt[kind] ?? 0) + 1;
  if (ok) sideBook.success[kind] = (sideBook.success[kind] ?? 0) + 1;
  if (side === 'resident' && layer) {
    const key = `${kind}:${layer}`;
    sideBook.byLayer[key] = (sideBook.byLayer[key] ?? 0) + 1;
  }
}

export function noteRefusal(world, side, kind) {
  const ledger = ensureLedger(world);
  if (!ledger || !kind) return;
  const book = side === 'resident' ? ledger.resident : ledger.player;
  book.refused ??= {};
  book.refused[kind] = (book.refused[kind] ?? 0) + 1;
}
