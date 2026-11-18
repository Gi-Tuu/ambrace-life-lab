// 观看/在场：host 的 touch/campViewers/viewers 抽到这里。状态由调用方注入，模块不持有单例。
export function observerActive(lastVisitor, now, presenceMs) {
  return now - lastVisitor <= presenceMs;
}

export function createViewerDomain({ getState, presenceMs, now = Date.now, validCampKey = () => true, markSeen = () => {} }) {
  const state = () => getState();
  return {
    // 只由应用路径调用（/healthz 不算，否则平台健康检查会让"有观众"恒真）。
    touch(mode, campKey) {
      const s = state();
      const at = now();
      s.lastVisitor = at;
      // N3：非法/未登记不得在 campViewers 留永久键；N4：只认请求自己带的 camp，不兜到 S.campKey。
      const requested = campKey ?? 'MAIN';
      if (requested !== 'MAIN' && !validCampKey(requested)) return { touched: false, reason: 'CAMP_INVALID' };
      if (!mode || mode === 'survival') {
        if (requested === 'MAIN') s.viewers.survival = at;
        s.campViewers[requested] = at;
      }
      // P1-3：观众行为推进 lastSeenAt（落盘不推进）
      if (requested !== 'MAIN') markSeen(requested, at);
      if (!mode || mode === 'compare') s.viewers.compare = at;
      if (mode === 'comparison') s.viewers.comparison = at;
      return { touched: true, key: requested };
    },
    keys() { return Object.keys(state().campViewers); },
    watching(campKey, at = now()) {
      const s = state();
      return observerActive(campKey ? s.campViewers[campKey] : s.viewers.survival, at, presenceMs);
    },
    reset() {
      const s = state();
      s.lastVisitor = s.viewers.survival = s.viewers.compare = s.viewers.comparison = 0;
      s.campViewers = {};
    },
  };
}
