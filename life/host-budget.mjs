// 模型预算 / 车道 / 熔断：host 的 model* 与 isFreeProvider 抽到这里。
// 纯函数 + 一个持有状态引用的域对象，host 只保留 facade 与原对外 API。
export function isFreeProvider(base, { freeHosts = [], paidHosts = [] } = {}) {
  const b = String(base ?? '');
  let host = '';
  try { host = new URL(b).hostname; } catch { return false; }
  if (paidHosts.includes(host)) return false;
  if (/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?([/?]|$)/i.test(b)) return true;
  return freeHosts.includes(host);
}

// 纯函数：给定「有没有观众 / 这条链路花不花钱 / 两本账 / 熔断」，决定这次能不能发、该记哪本账。
export function modelChannel({ watched, free, moneyCalls = 0, nodeCalls = 0, moneyBudget = 0, nodeBudget = 0, breakerOpen = false, allowPaidUnattended = false }) {
  if (free) {
    if (breakerOpen) return { go: false, kind: 'node', why: 'BREAKER' };
    if (nodeBudget > 0 && nodeCalls >= nodeBudget) return { go: false, kind: 'node', why: 'NODE_BUDGET' };
    return { go: true, kind: 'node' };
  }
  if (!watched && !allowPaidUnattended) return { go: false, kind: 'money', why: 'NO_OBSERVER' };
  if (moneyBudget > 0 && moneyCalls >= moneyBudget) return { go: false, kind: 'money', why: 'BUDGET' };
  return { go: true, kind: 'money' };
}

export function breakerOpenAt(breaker, now = Date.now()) {
  return Number(breaker?.openUntil ?? 0) > now;
}

export function observerActive(lastVisitor, now, presenceMs) {
  return now - lastVisitor <= presenceMs;
}

// 纯函数便于闸门测试：跨天归零，同日原样返回
export function budgetTick(model, dayKey) {
  if (model.dayKey === dayKey) return model;
  model.dayKey = dayKey;
  model.calls = 0;
  model.tokens = 0;
  model.moneyCalls = 0;
  model.nodeCalls = 0;
  if ('survivalChoices' in model) model.survivalChoices = 0;
  model.attempts.length = 0;
  return model;
}

export function pickProviderKey(keys, i, providerCount = (keys ?? []).length) {
  const list = keys ?? [];
  if (providerCount <= 1) return list[0] || '';
  return list[i] || '';
}

const dayKeyAt = (now) => new Date(now).toISOString().slice(0, 10);

// host 用：S.model / S.lastVisitor / S.breaker 由调用方注入，模块不持有全局单例。
export function createBudgetDomain({ getState, budget, nodeBudget = 0, presenceMs, breakerFails, breakerMs, attemptCap = 20, now = Date.now }) {
  const state = () => getState();
  return {
    gate(at = now()) {
      const s = state();
      budgetTick(s.model, dayKeyAt(at));
      if (s.model.calls >= budget) return 'BUDGET';
      if (!observerActive(s.lastVisitor, at, presenceMs)) return 'NO_OBSERVER';
      s.model.calls += 1; // 预扣：额度在"决定放行"的此刻就减少，并发下也不可能超发
      s.model.reserved = (s.model.reserved ?? 0) + 1;
      return null;
    },
    release() {
      const s = state();
      if (s.model.reserved > 0) s.model.reserved -= 1;
      s.model.calls = Math.max(0, s.model.calls - 1);
    },
    chargeLane(free) {
      const s = state();
      if (free) s.model.nodeCalls = (s.model.nodeCalls ?? 0) + 1;
      else s.model.moneyCalls = (s.model.moneyCalls ?? 0) + 1;
    },
    charged(tokens = 0) {
      const s = state();
      if (s.model.reserved > 0) s.model.reserved -= 1;
      s.model.tokens += Number(tokens) || 0;
    },
    // 内部决策/对话路径不走 gate 预扣，只记 token；不能误伤 /chat 的在途 reserved。
    addTokens(tokens = 0) {
      const s = state();
      s.model.tokens += Number(tokens) || 0;
    },
    // ARCH5-06：内部模型路径的成功调用统一在这里记账（calls + 分车道 + token）。
    // /chat 仍走 gate（预扣）→ charged（转正式），两条路只共享这一份字段写入面。
    recordCall({ free = false, tokens = 0 } = {}) {
      const s = state();
      s.model.calls = (s.model.calls ?? 0) + 1;
      if (free) s.model.nodeCalls = (s.model.nodeCalls ?? 0) + 1;
      else s.model.moneyCalls = (s.model.moneyCalls ?? 0) + 1;
      s.model.tokens = (s.model.tokens ?? 0) + (Number(tokens) || 0);
    },
    // 诊断原因队列：统一 push + 截断，host 不再手写 attempts。
    attempt(note) {
      const s = state();
      s.model.attempts.push(String(note).slice(0, 80));
      if (s.model.attempts.length > attemptCap) s.model.attempts.splice(0, s.model.attempts.length - attemptCap);
    },
    choice() {
      const s = state();
      s.model.survivalChoices = (s.model.survivalChoices ?? 0) + 1;
    },
    see(free, ok, at = now()) {
      if (!free) return;
      const s = state();
      if (ok) { s.breaker.fails = 0; return; }
      s.breaker.fails += 1;
      if (breakerFails > 0 && s.breaker.fails >= breakerFails) {
        s.breaker.openUntil = at + breakerMs;
        s.breaker.trips = (s.breaker.trips ?? 0) + 1;
        s.breaker.fails = 0;
      }
    },
    breakerOpen(at = now()) { return breakerOpenAt(state().breaker, at); },
    watching(at = now()) { return observerActive(state().lastVisitor, at, presenceMs); },
  };
}
