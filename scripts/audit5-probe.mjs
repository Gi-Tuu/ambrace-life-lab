// 审计5 证据探针：只起临时 serve.mjs（临时 DATA_DIR、loopback、无模型），把
// SEC5-01/02/05 的放行/拒绝矩阵打成一份可复跑的 JSON。不写仓库 data/。
// 用法：node scripts/audit5-probe.mjs > evidence/audit5/security.json
import { execFileSync } from 'node:child_process';
import { bootAudit5, stopAudit5, openSession, jsonPost, jsonGet, cookieJar } from '../life/audit5-harness.mjs';

const head = (() => {
  try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(); }
  catch { return 'unknown'; }
})();

const RESET = { action: 'reset', confirm: true };
const rows = {};

async function withServer(env, fn) {
  const h = await bootAudit5(env);
  try { return await fn(h); } finally { await stopAudit5(h); }
}

// 1) 未配置令牌：自选 nonce 对 + 伪造头；服务端签发 nonce。
rows.noToken = await withServer({ CTL_TOKEN: '' }, async (h) => {
  const forged = await jsonPost(h.base, '/ctl', RESET, {
    headers: {
      cookie: 'ctl_sid=deadbeef; ctl_nonce=zzz',
      'x-ctl-nonce': 'zzz',
      origin: h.base,
      'sec-fetch-site': 'same-origin',
      'x-forwarded-host': 'evil.example',
    },
  });
  const forgedBody = await forged.json();
  const jar = {};
  await openSession(h.base, jar);
  const legit = await jsonPost(h.base, '/ctl', RESET, { jar, headers: { 'x-ctl-nonce': jar.ctl_nonce } });
  const legitBody = await legit.json();
  return {
    selfChosenNonceStatus: forged.status,
    selfChosenNonceError: forgedBody.error ?? null,
    serverNonceStatus: legit.status,
    serverNonceOk: legitBody.ok ?? null,
    sessionCookieNames: Object.keys(jar).sort(),
  };
});

// 2) 配置令牌：伪造头/合法 nonce 都不能绕过；Bearer 可用。
rows.token = await withServer({ CTL_TOKEN: 'top-secret' }, async (h) => {
  const jar = {};
  await openSession(h.base, jar);
  const nonceOnly = await jsonPost(h.base, '/ctl', RESET, {
    jar, headers: { 'x-ctl-nonce': jar.ctl_nonce, origin: h.base, 'sec-fetch-site': 'same-origin', 'x-forwarded-host': 'evil.example' },
  });
  const bearer = await jsonPost(h.base, '/ctl', RESET, { headers: { authorization: 'Bearer top-secret' } });
  const bearerBody = await bearer.json();
  return { nonceOnlyStatus: nonceOnly.status, bearerStatus: bearer.status, bearerOk: bearerBody.ok ?? null };
});

// 3) /world owner 边界 + 重开不换 owner。
rows.worldOwner = await withServer({ CTL_TOKEN: '' }, async (h) => {
  const jarA = {};
  const rA = await jsonPost(h.base, '/saves/open', { name: '证据营地甲' }, { jar: jarA });
  cookieJar(rA, jarA);
  const a = await rA.json();
  const jarB = {};
  const rB = await jsonPost(h.base, '/saves/open', { name: '证据营地乙' }, { jar: jarB });
  cookieJar(rB, jarB);
  const b = await rB.json();
  const noCookie = await jsonGet(h.base, `/world?camp=${a.key}`);
  const asOwner = await jsonGet(h.base, `/world?camp=${a.key}`, { jar: { camp_owner: jarA.camp_owner } });
  const asOther = await jsonGet(h.base, `/world?camp=${a.key}`, { jar: { camp_owner: jarB.camp_owner } });
  const reopenNoCookie = await jsonPost(h.base, '/saves/open', { name: '证据营地甲' }, { jar: {} });
  const reopenBody = await reopenNoCookie.json();
  return {
    openA: a.ok ?? null, openB: b.ok ?? null,
    worldNoCookieStatus: noCookie.status,
    worldOwnerStatus: asOwner.status,
    worldOtherOwnerStatus: asOther.status,
    reopenNoCookieStatus: reopenNoCookie.status,
    reopenNoCookieError: reopenBody.error ?? null,
    reopenIssuedOwnerCookie: (reopenNoCookie.headers.getSetCookie?.() ?? []).some((c) => c.startsWith('camp_owner=')),
  };
});

// 4) 会话配额（同一会话第 6 个营地必须 429；NaN env 回落不是 0）。
rows.quota = await withServer({ CTL_TOKEN: '', OPEN_SESSION_LIMIT: 'NaN', OPEN_LIMIT: 'NaN', OPEN_LIMIT_GLOBAL: 'NaN', CAMP_TOTAL_MAX: 'NaN' }, async (h) => {
  const jar = {};
  await openSession(h.base, jar);
  const codes = [];
  for (let i = 0; i < 6; i += 1) {
    const r = await jsonPost(h.base, '/saves/open', { name: `证据配额${i}` }, { jar });
    codes.push(r.status);
  }
  return { codes, sixthBlocked: codes[5] === 429 };
});

// 5) 安全头。
rows.headers = await withServer({ CTL_TOKEN: '' }, async (h) => {
  const res = await jsonGet(h.base, '/');
  return {
    csp: res.headers.get('content-security-policy'),
    xContentTypeOptions: res.headers.get('x-content-type-options'),
    xFrameOptions: res.headers.get('x-frame-options'),
    setCookie: res.headers.getSetCookie?.(),
  };
});

console.log(JSON.stringify({
  head,
  generatedAt: new Date().toISOString(),
  note: '临时 DATA_DIR；每个 server 用完即停；不含任何真实令牌。',
  rows,
}, null, 2));
