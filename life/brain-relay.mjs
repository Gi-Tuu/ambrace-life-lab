// 大脑中继（纯内存队列，可单测）。用途：让公开实例把"问模型"这件事外包给赛事云节点，
// 而节点**不需要任何入站端口**——它自己每隔 POLL_MS 出站来取活、跑本地 vLLM、把结果送回。
// 队列只搬运单次请求：不落盘、不保存世界状态，容器重启即空。
// 上游不可用/超时一律以错误收场 ⇒ 调用方返回 5xx ⇒ 引擎的供应商循环自动落到下一个回退位。
import { randomUUID } from 'node:crypto';

export function constantTimeEqual(a, b) {
  const x = String(a ?? '');
  const y = String(b ?? '');
  // 任一侧为空就一律不相等：否则"没配令牌"与"没带令牌"会互相匹配，等于默认开放。
  if (!x || !y) return false;
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

export function createRelay({ maxPending = 8, ttlMs = 9000 } = {}) {
  const pending = new Map(); // id -> { body, at }   等 agent 来取
  const claimed = new Set(); // id                   已取走，等结果
  const waiters = new Map(); // id -> finish(res)
  const stat = { served: 0, failed: 0, expired: 0, late: 0, dropped: 0 };

  // 容量覆盖提交至结算的整个窗口，节点取活后调用方仍在等结果。
  function submit(body) {
    if (waiters.size >= maxPending) { stat.dropped += 1; return null; }
    const id = randomUUID();
    let settled = false;
    let settle;
    const promise = new Promise((res) => { settle = res; });
    const finish = (res) => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      pending.delete(id);
      claimed.delete(id);
      waiters.delete(id);
      settle(res);
      return true;
    };
    const timer = setTimeout(() => {
      if (finish({ ok: false, code: 'RELAY_TIMEOUT' })) stat.expired += 1;
    }, ttlMs);
    pending.set(id, { body, at: Date.now() });
    waiters.set(id, finish);
    return { id, promise };
  }

  // agent 取活：一次投递（先出队再返回，两个 agent 拿不到同一条）。
  function claim() {
    const now = Date.now();
    for (const [id, job] of pending) {
      if (now - job.at > ttlMs) {
        pending.delete(id);
        if (waiters.get(id)?.({ ok: false, code: 'RELAY_TIMEOUT' })) stat.expired += 1;
        continue;
      }
      pending.delete(id);
      claimed.add(id);
      return { id, body: job.body, waitedMs: now - job.at };
    }
    return null;
  }

  // agent 交活（或报错）。未知 id / 已超时的迟到结果一律丢弃并计数——绝不能把答案塞给已经走开的等待方。
  function complete(id, patch) {
    if (!claimed.has(id)) { stat.late += 1; return false; }
    const finish = waiters.get(id);
    const res = { ok: true, ...patch };
    const done = Boolean(finish) && finish(res);
    claimed.delete(id);
    if (!done) { stat.late += 1; return false; }
    if (res.ok) stat.served += 1; else stat.failed += 1;
    return true;
  }

  function view() {
    return { pending: pending.size, claimed: claimed.size, ...stat };
  }

  return { submit, claim, complete, view, limits: { maxPending, ttlMs } };
}
