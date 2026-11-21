// 名字存档的世界实例管理器（S2 任务二 / C1）。
//
// 红线（交接单 §4.3）：
//  · 不实例化 host.mjs 的 N 份（它是模块级单例）；这里直接组合 survplay 的纯 API。
//  · 不给每份世界造新 deliberator：调用方传进来的 options 里带同一个 modelBrain，
//    于是两把尺子记账、熔断、排队天然全局共享。
//  · 名字只作为字段进索引，**永不进路径**；路径由 sha256(归一化名字) 派生。
//  · 只在 saves/ 目录内读写；拒绝一切越界名字，且拒绝时不得产生任何文件写入。
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';

import { createSurvPlay, dumpSurv, loadSurv, tickSurvPlay } from './survplay.mjs';

export const NAME_MIN = 1;
export const NAME_MAX = 16;
export const SAVE_TTL_MS = 3 * 24 * 60 * 60 * 1000; // 3 天无活跃即删
export const RESIDENT_LIMIT = 6; // 常驻上限（含主营地）
// DATA5-06：营地 key 只接受 32 位小写十六进制。名字 sha256 是派生规则，但 key 本身不是 owner 凭据。
export const CAMP_KEY_RE = /^[0-9a-f]{32}$/;
// DATA5-04：索引锁。超时必须 fail-fast（绝不无锁继续写）；持锁进程崩溃留下的锁按 owner+时间戳回收。
const envInt = (name, def) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
};
const lockTimeoutMs = () => envInt('INDEX_LOCK_TIMEOUT_MS', 3000);
const lockStaleMs = () => envInt('INDEX_LOCK_STALE_MS', 30000);
const lockRetryMs = () => Math.max(1, Math.min(50, envInt('INDEX_LOCK_RETRY_MS', 10)));

// 存档形状：dumpSurv 的最小可辨认字段。缺任何一项都不能交给 loadSurv——
// 它会把空对象当成"新世界"（t=0、4 个 minds），随后 persist 用这份空世界覆盖唯一副本（SAV-01）。
export function validCampArchive(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  if (!Number.isSafeInteger(raw.t) || raw.t < 0) return false;
  // dumpSurv 没有 agents 键（只有 minds）：以 minds.p1 作为'这是一个生存世界'的最小证据。
  if (!raw.minds || typeof raw.minds !== 'object' || Array.isArray(raw.minds)) return false;
  const p1 = raw.minds.p1;
  if (!p1 || typeof p1 !== 'object' || Array.isArray(p1)) return false;
  // 审计 DATA-06：只有"像一个人"的 p1 才可信；空对象会让 loadSurv 生成默认世界并覆盖唯一副本。
  if (!p1.m || typeof p1.m !== 'object' || !p1.drives || typeof p1.drives !== 'object' || !p1.viab || typeof p1.viab !== 'object') return false;
  const sv = raw.survival;
  if (!sv || typeof sv !== 'object' || Array.isArray(sv)) return false;
  if (!Number.isFinite(sv.store) || sv.store < 0) return false;
  if (!Array.isArray(sv.plots) || !sv.buildings || typeof sv.buildings !== 'object' || !sv.inv || typeof sv.inv !== 'object') return false;
  return true;
}

const CONTROL = /[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029\ufeff]/;
const SEPARATORS = /[\\/]/;

// 名字校验：先归一化再判，任何不合法都在建路径之前返回。
export function normalizeName(raw) {
  const display = String(raw ?? '').trim();
  if ([...display].length < NAME_MIN) return { ok: false, code: 'EMPTY' };
  if (CONTROL.test(display)) return { ok: false, code: 'CONTROL_CHAR' };
  if (SEPARATORS.test(display)) return { ok: false, code: 'SEPARATOR' };
  if (display.includes('..')) return { ok: false, code: 'DOTDOT' };
  if (/^\.+$/.test(display)) return { ok: false, code: 'DOTS' };
  if ([...display].length > NAME_MAX) return { ok: false, code: 'TOO_LONG' };
  const folded = display.normalize('NFC').toLowerCase();
  if (!folderSafe(folded)) return { ok: false, code: 'UNSAFE' };
  return { ok: true, code: 'OK', display, key: createHash('sha256').update(folded).digest('hex').slice(0, 32) };
}

function folderSafe(name) {
  return name.length > 0 && !CONTROL.test(name) && !SEPARATORS.test(name) && !name.includes('..');
}

export const savesDir = (dataDir) => join(dataDir, 'saves');
const indexFile = (dataDir) => join(savesDir(dataDir), 'index.json');
const isCampKey = (key) => CAMP_KEY_RE.test(String(key ?? ''));

// 只在 saves/ 内解析营地档路径；非法 key 直接抛 BAD_KEY（调用方不得把外部字符串拼进路径）。
function campFile(dataDir, key) {
  if (!isCampKey(key)) { const e = new Error('营地 key 必须是 32 位小写十六进制'); e.code = 'BAD_KEY'; throw e; }
  const dir = resolve(savesDir(dataDir));
  const file = resolve(dir, `${key}.json.gz`);
  if (dirname(file) !== dir) { const e = new Error('营地路径越界'); e.code = 'BAD_KEY'; throw e; }
  return file;
}

// 删除/改名前的第二道闸：文件必须真实位于 saves/ 内（展开符号链接/junction 后比较）。
function safeSavesFile(dataDir, file) {
  try {
    const dir = realpathSync(savesDir(dataDir));
    const real = realpathSync(file);
    return dirname(real) === dir;
  } catch { return false; }
}

// DATA5-05：owner/名字侧车。索引不是唯一真相：索引丢失后靠它恢复归属与显示名。
const ownerSidecar = (dataDir, key) => join(savesDir(dataDir), `${key}.owner.json`);
export function readOwnerSidecar(dataDir, key) {
  try {
    if (!isCampKey(key)) return null;
    const raw = JSON.parse(readFileSync(ownerSidecar(dataDir, key), 'utf8'));
    const ownerHash = /^[0-9a-f]{64}$/.test(String(raw?.ownerHash ?? '')) ? raw.ownerHash : null;
    const name = typeof raw?.name === 'string' && raw.name ? String(raw.name).slice(0, 64) : null;
    return { name, ownerHash };
  } catch { return null; }
}
export function writeOwnerSidecar(dataDir, key, { name, ownerHash } = {}) {
  if (!isCampKey(key)) return false;
  try {
    mkdirSync(savesDir(dataDir), { recursive: true });
    const file = ownerSidecar(dataDir, key);
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    const payload = {
      name: typeof name === 'string' ? name.slice(0, 64) : null,
      ownerHash: /^[0-9a-f]{64}$/.test(String(ownerHash ?? '')) ? ownerHash : null,
      updatedAt: Date.now(),
    };
    try {
      writeFileSync(tmp, JSON.stringify(payload));
      renameWithRetry(tmp, file);
    } finally { if (existsSync(tmp)) rmSync(tmp, { force: true }); }
    return true;
  } catch { return false; }
}

// DATA5-05：索引整体丢失（没有 corrupt 备份）时，从 saves/ 的营地档 + 侧车重建索引。
// 老营地没有侧车：名字退化为 key，ownerHash 为空，继续走“首次 claim”兼容路径。
export function rebuildIndexFromSaves(dataDir) {
  const dir = savesDir(dataDir);
  if (!existsSync(dir) || existsSync(indexFile(dataDir))) return 0;
  try {
    if (readdirSync(dir).some((n) => n.startsWith('index.json.corrupt-'))) return 0;
  } catch { return 0; }
  const entries = [];
  let names = [];
  try { names = readdirSync(dir); } catch { return 0; }
  for (const name of names) {
    const m = /^([0-9a-f]{32})\.json\.gz$/.exec(name);
    if (!m) continue;
    const key = m[1];
    let raw;
    try { raw = loadCamp(dataDir, key); } catch { continue; }
    if (!validCampArchive(raw)) continue;
    const side = readOwnerSidecar(dataDir, key);
    let lastSeenAt = Date.now();
    try { lastSeenAt = statSync(join(dir, name)).mtimeMs; } catch { /* 保留 now */ }
    const minds = Object.values(raw.minds ?? {});
    entries.push({
      key,
      name: side?.name ?? key,
      day: Math.floor((Number.isFinite(raw.t) ? raw.t : 0) / 24),
      population: Math.max(0, minds.filter((x) => x && !x.dead).length - (raw.minds?.p1 ? 1 : 0)),
      status: raw.survival?.ended ? 'extinct' : raw.survival?.playerDead ? 'ghost' : 'active',
      lastSeenAt,
      ...(side?.ownerHash ? { ownerHash: side.ownerHash } : {}),
    });
  }
  if (!entries.length) return 0;
  writeIndex(dataDir, { entries });
  return entries.length;
}

function rotateCorrupt(dataDir, keep = 10) {
  try {
    const dir = savesDir(dataDir);
    const olds = readdirSync(dir).filter((n) => n.startsWith('index.json.corrupt-')).sort();
    for (const n of olds.slice(0, Math.max(0, olds.length - keep))) rmSync(join(dir, n), { force: true });
  } catch { /* 轮转失败不影响主流程 */ }
}

// 索引：{ generation, entries: [{ key, name, day, population, status, lastSeenAt, main, ownerHash }] }
export function readIndex(dataDir) {
  try {
    const raw = JSON.parse(readFileSync(indexFile(dataDir), 'utf8'));
    if (!Array.isArray(raw?.entries)) throw new Error('营地索引格式无效');
    // DATA5-06：只接受 32hex key。语法合法但 key 非法的条目（如 `../../victim`）一律从视图丢弃；
    // 不在这里改名索引——否则调用方随后拿过滤后的 entries 做 merge 写回时会丢掉别的合法条目。
    // 下一次 writeIndex/touchSave 会把过滤后的视图原子写回，坏 key 自然消失。
    const entries = raw.entries.filter((e) => e && typeof e === 'object' && !Array.isArray(e) && isCampKey(e.key));
    const dropped = raw.entries.length - entries.length;
    return {
      entries,
      droppedEntries: dropped,
      generation: Number.isSafeInteger(raw?.generation) ? raw.generation : 0,
    };
  } catch (error) {
    if (error.code === 'ENOENT') return { entries: [], generation: 0 };
    // 审计 DATA-04：索引坏掉时先保留现场，再以空索引继续服务（否则 /saves、open、sweep 全部 500）。
    try {
      renameSync(indexFile(dataDir), indexFile(dataDir) + '.corrupt-' + Date.now());
      rotateCorrupt(dataDir);
    } catch { /* 备份失败也不阻塞启动 */ }
    return { entries: [], recovered: false, generation: 0, indexError: String(error?.message ?? error).slice(0, 80) };
  }
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Windows 上 rename 覆盖目标时可能撞上短暂的 EPERM/EBUSY（杀软/索引器持有句柄）。
// 有界重试；仍失败就抛出，绝不当成写成功。
function renameWithRetry(from, to, attempts = 20) {
  let last;
  for (let i = 0; i < attempts; i += 1) {
    try { renameSync(from, to); return true; }
    catch (error) {
      last = error;
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) break;
      sleepMs(5 + i * 5);
    }
  }
  throw last;
}

// 持锁进程是否还活着；读不到 owner 时退回 mtime。过期/进程不存在 ⇒ 可回收。
function lockIsStale(lock) {
  let at = 0;
  let pid = 0;
  try {
    const raw = JSON.parse(readFileSync(lock, 'utf8'));
    at = Number(raw?.at ?? 0);
    pid = Number(raw?.pid ?? 0);
  } catch {
    try { at = statSync(lock).mtimeMs; } catch { return false; }
  }
  const age = Date.now() - (Number.isFinite(at) && at > 0 ? at : 0);
  if (age > lockStaleMs()) return true;
  if (Number.isSafeInteger(pid) && pid > 0) {
    try { process.kill(pid, 0); }
    catch (error) { if (error.code === 'ESRCH') return true; }
  }
  return false;
}

function acquireIndexLock(dataDir) {
  const lock = indexFile(dataDir) + '.lock';
  const deadline = Date.now() + lockTimeoutMs();
  for (;;) {
    try {
      const fd = openSync(lock, 'wx');
      try {
        writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now(), host: process.env.HOSTNAME ?? '' }));
      } finally { closeSync(fd); }
      return lock;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (lockIsStale(lock)) {
        try { rmSync(lock, { force: true }); } catch { /* 抢不到就重试 */ }
        continue;
      }
      if (Date.now() >= deadline) {
        const e = new Error('营地索引锁等待超时');
        e.code = 'INDEX_LOCKED';
        throw e;
      }
      sleepMs(lockRetryMs());
    }
  }
}

export function writeIndex(dataDir, index, { merge = false } = {}) {
  const dir = savesDir(dataDir);
  mkdirSync(dir, { recursive: true });
  const lock = acquireIndexLock(dataDir);
  try {
    // 锁内重读：merge 基于磁盘最新版本，避免用调用方手里的旧快照覆盖别的进程刚写的条目。
    const disk = readIndex(dataDir);
    const incoming = (index?.entries ?? []).filter((e) => e && isCampKey(e.key));
    let entries;
    if (merge) {
      const by = new Map(disk.entries.map((e) => [e.key, e]));
      for (const e of incoming) {
        const prev = by.get(e.key);
        by.set(e.key, prev ? { ...prev, ...e, ...(prev.ownerHash && !e.ownerHash ? { ownerHash: prev.ownerHash } : {}) } : e);
      }
      entries = [...by.values()];
    } else entries = incoming;
    const generation = Math.max(disk.generation ?? 0, Number(index?.generation) || 0) + 1;
    const tmp = `${indexFile(dataDir)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify({ generation, entries }));
      renameWithRetry(tmp, indexFile(dataDir));
    } finally { if (existsSync(tmp)) rmSync(tmp, { force: true }); }
    return { ok: true, generation, entries: entries.length };
  } finally {
    try { rmSync(lock, { force: true }); } catch { /* ignore */ }
  }
}

// 公开列表：只投影五项（§0-9），不泄露背包/关系/对话。
export function listSaves(dataDir, now = Date.now()) {
  return readIndex(dataDir).entries
    .filter((e) => e.key)
    .map((e) => ({
      name: e.name,
      day: e.day ?? 0,
      population: e.population ?? 0,
      status: e.status ?? 'active',
      lastSeenAt: e.lastSeenAt ?? 0,
      daysLeft: Math.max(0, Math.ceil((SAVE_TTL_MS - (now - (e.lastSeenAt ?? 0))) / 86400000)),
    }))
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}

function stageCamp(dataDir, key, survivalDump) {
  mkdirSync(savesDir(dataDir), {recursive:true});
  const file = campFile(dataDir,key);
  if (existsSync(file + '.tmp') && statSync(file + '.tmp').isDirectory()) throw Object.assign(new Error('EISDIR: camp tmp is a directory'), { code: 'EISDIR' });
  const tmp = file + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2);
  writeFileSync(tmp,gzipSync(Buffer.from(JSON.stringify(survivalDump))));
  return {file,tmp};
}

export function saveCamp(dataDir, key, survivalDump) {
  const {file,tmp} = stageCamp(dataDir,key,survivalDump);
  renameSync(tmp,file);
  return file;
}

export function loadCamp(dataDir, key) {
  return JSON.parse(gunzipSync(readFileSync(campFile(dataDir, key))).toString('utf8'));
}

export function touchSave(dataDir, entry, index = readIndex(dataDir)) {
  if (!entry || !isCampKey(entry.key)) { const e = new Error('营地 key 非法'); e.code = 'BAD_KEY'; throw e; }
  const i = index.entries.findIndex((e) => e.key === entry.key);
  const next = { ...(i >= 0 ? index.entries[i] : { key: entry.key, name: entry.name }), ...entry, lastSeenAt: entry.lastSeenAt ?? Date.now() };
  if (i >= 0) index.entries[i] = next;
  else index.entries.push(next);
  writeIndex(dataDir, index, { merge: true });
  return next;
}

// TTL 清扫：只删 saves/ 里的文件；**正在被观看的营地绝不删**（先查观看计数再动文件）。
// DATA3-02：索引不健康时一律不清、不删（readIndex 已把坏索引备份移走）；健康索引下的孤儿档改为隔离，不 rm。
export function sweepSaves(dataDir, { now = Date.now(), ttlMs = SAVE_TTL_MS, lastSeenAt = () => 0, isWatched = () => false } = {}) {
  const dir = savesDir(dataDir);
  if (!existsSync(dir)) return { removed: [], kept: 0, quarantined: [], indexUnhealthy: false };
  const index = readIndex(dataDir);
  // readIndex 会把坏索引改名备份；之后 index.json 缺失 + 存在 .corrupt-* ⇒ 仍视为「索引不健康」，
  // 直到有人写回一份健康索引。否则重启后 sweep 会把所有档当孤儿。
  const hasCorruptBackup = !existsSync(indexFile(dataDir)) &&
    readdirSync(dir).some((name) => name.startsWith('index.json.corrupt-'));
  if (index.indexError || hasCorruptBackup) {
    // 索引坏：这份目录里哪些档是"活的"无从判断，宁可不动。恢复由备份 + 人工完成。
    return { removed: [], kept: index.entries.length, quarantined: [], indexUnhealthy: true };
  }
  const removed = [];
  const kept = [];
  const quarantined = [];
  const known = new Set();
  for (const entry of index.entries) {
    // readIndex 已经过滤非 32hex；这里再挡一层，任何非法 key 都不得进入路径。
    if (!isCampKey(entry.key)) continue;
    known.add(entry.key);
    const file = campFile(dataDir, entry.key);
    const stale = now - Math.max(entry.lastSeenAt ?? 0, lastSeenAt(entry.key) ?? 0) > ttlMs;
    if (!stale || isWatched(entry.key)) { kept.push(entry); continue; }
    // 过期才清：新鲜但暂时没有文件的条目（首次落盘前/索引恢复中）保留，避免误删正在使用的营地。
    if (existsSync(file) && safeSavesFile(dataDir, file)) rmSync(file);
    removed.push(entry.key);
  }
  // 审计 DATA-05：没有索引的孤儿营地文件（崩溃/索引重建后遗留）按文件时间隔离（不删除，留作取证/恢复）。
  try {
    const qdir = join(dir, 'quarantine');
    for (const name of readdirSync(dir)) {
      const m = /^([0-9a-f]{32})\.json\.gz$/.exec(name);
      if (!m || known.has(m[1])) continue;
      const file = join(dir, name);
      if (now - statSync(file).mtimeMs <= ttlMs) continue;
      mkdirSync(qdir, { recursive: true });
      renameSync(file, join(qdir, name));
      quarantined.push(m[1]);
    }
    // DATA4-09：quarantine 目录上限 100，超出按 mtime 删最旧。
    try {
      const qs = readdirSync(qdir).map((n) => ({ n, m: statSync(join(qdir, n)).mtimeMs })).sort((a, b) => a.m - b.m);
      for (let i = 0; i < qs.length - 100; i += 1) rmSync(join(qdir, qs[i].n), { force: true });
    } catch { /* ignore */ }
    // DATA5-12：清掉崩溃残留的营地 tmp（只清 saves/ 内、超过 1 小时的普通文件）。
    try {
      const cutoff = now - 60 * 60 * 1000;
      for (const name of readdirSync(dir)) {
        if (!/\.json\.gz\.tmp-/.test(name)) continue;
        const file = join(dir, name);
        if (now - statSync(file).mtimeMs <= cutoff) continue;
        if (safeSavesFile(dataDir, file)) rmSync(file, { force: true });
      }
    } catch { /* ignore */ }
  } catch { /* 清扫尽力而为 */ }
  if (removed.length) writeIndex(dataDir, { entries: kept });
  return { removed, kept: kept.length, quarantined, indexUnhealthy: false };
}

// fork 新营地：从种子营地的 survival 块起步，但玩家必须是"刚到的人"。
// 这条坑过一次：挂着旧档的玩家会带着 dead:true 进场。
export function forkCamp(seedSurvival, { seed = 7, options = {} } = {}) {
  const fresh = structuredClone(seedSurvival);
  const ref = dumpSurv(loadSurv(undefined, seed, options));
  fresh.minds.p1 = structuredClone(ref.minds.p1);
  fresh.pinv = { ...(fresh.pinv ?? {}), p1: { wood: 0, stone: 0 } };
  fresh.loc = { ...(fresh.loc ?? {}), p1: 'hall' };
  fresh.occupancy = { ...(fresh.occupancy ?? {}), hall: [...new Set([...(fresh.occupancy?.hall ?? []), 'p1'])] };
  fresh.campPlayerRoom = null;
  fresh.survival = { ...(fresh.survival ?? {}), playerDead: false, talk: null };
  delete fresh.survival.playerPos;
  const back = loadSurv(structuredClone(fresh), seed, options).world.agents.p1;
  if (!back || back.dead) throw new Error('fork 后玩家不是活的：检查 freshenPlayer 步骤');
  return fresh;
}

// 常驻实例管理器：LRU 常驻 ≤limit，其余按需载入；tick 有 wall-time 上限。
export class CampInstances {
  constructor({ dataDir, options = {}, limit = RESIDENT_LIMIT, seedSurvival = null } = {}) {
    this.dataDir = dataDir;
    this.options = options;
    this.limit = Math.max(1, limit);
    this.seedSurvival = seedSurvival;
    this.live = new Map(); // key -> { sp, key, lastUsed }
    this.stats = { ticks: 0, loaded: 0, evicted: 0 };
  }

  // 按名字进场：命中同名就用磁盘档；新名从种子 fork。
  open(name, { now = Date.now() } = {}) {
    const id = normalizeName(name);
    if (!id.ok) return { ok: false, code: id.code };
    if (this.live.has(id.key)) {
      const hit = this.live.get(id.key);
      this.markSeen(hit,now);
      return { ok: true, code: 'OK', key: id.key, sp: hit.sp, created: false };
    }
    let archive = null;
    if (existsSync(campFile(this.dataDir,id.key))) {
      try { archive = loadCamp(this.dataDir,id.key); }
      catch { return { ok: false, code: 'CAMP_CORRUPT' }; } // 解压/JSON 坏：拒绝，不落盘
      if (!validCampArchive(archive)) return { ok: false, code: 'CAMP_CORRUPT' }; // 语义坏档（如 {}）
    } else if (readIndex(this.dataDir).entries.some(e=>e.key===id.key)) {
      return {ok:false,code:'CAMP_UNAVAILABLE'};
    }
    let sp;
    let created = false;
    if (archive) {
      sp = loadSurv(archive, this.options.seed ?? 7, this.options);
    } else {
      if (!this.seedSurvival) return { ok: false, code: 'NO_SEED' };
      sp = loadSurv(forkCamp(this.seedSurvival, { options: this.options }), this.options.seed ?? 7, this.options);
      created = true;
      this.stats.loaded += 1;
    }
    const entry = {sp,key:id.key,name:id.display,lastUsed:now,lastSeenAt:now,savedSeenAt:now};
    if (!this.admit(entry)) return {ok:false, code:'SAVE_FAILED'};
    return { ok: true, code: 'OK', key: id.key, sp, created };
  }

  // 按 key 取（query/cookie 路由用）：先 live，再磁盘；都没有返回 null。
  // 安全：key 只接受 32 位十六进制，且必须是索引成员——两条都要，防目录穿越与"复活孤儿文件"。
  openKey(key, { now = Date.now() } = {}) {
    const k = String(key ?? '');
    if (!/^[0-9a-f]{32}$/.test(k)) return null;
    const hit = this.live.get(k);
    if (hit) { hit.lastUsed = now; hit.lastSeenAt = now; return hit.sp; }
    const known = readIndex(this.dataDir).entries.find((e) => e.key === k);
    if (!known) return null;
    let raw;
    try { raw = loadCamp(this.dataDir, k); } catch { return null; }
    if (!validCampArchive(raw)) return null; // 坏档不装进 live，避免被 save() 写回
    const sp = loadSurv(raw, this.options.seed ?? 7, this.options);
    sp.world.campKey = k;
    if (!this.admit({sp, key:k, name:known.name, lastUsed:now, lastSeenAt:known.lastSeenAt ?? 0}, false)) {
      throw new Error('当前无法换入营地');
    }
    return sp;
  }

  admit(entry, persist = true) {
    let evicted;
    if (this.live.size >= this.limit) {
      const oldest = [...this.live.values()].reduce((a,b) => b.lastUsed < a.lastUsed ? b : a);
      try { this.persistEntry(oldest); } catch { return false; }
      evicted = oldest.key;
    }
    if (persist) this.persistEntry(entry);
    if (evicted) {
      this.live.delete(evicted);
      this.stats.evicted += 1;
    }
    this.live.set(entry.key, entry);
    return true;
  }

  persistEntry({sp, key, name, lastSeenAt}) {
    if (!isCampKey(key)) { const e = new Error('营地 key 非法'); e.code = 'BAD_KEY'; throw e; }
    const w = sp.world;
    const {tmp,file} = stageCamp(this.dataDir,key,dumpSurv(sp));
    try {
      // DATA5-03：先发布文件、再写索引。反过来的窗口会让索引指向不存在的档（名字失效）；
      // 文件先落地时，即使索引没写成，下一次 open 也能从文件自愈并补索引。
      renameSync(tmp,file);
      // DATA5-05：owner/名字侧车与营地档同一次保存发布；索引丢了也能从这里恢复。
      const indexed = readIndex(this.dataDir).entries.find((e) => e.key === key);
      const side = readOwnerSidecar(this.dataDir, key);
      writeOwnerSidecar(this.dataDir, key, { name, ownerHash: indexed?.ownerHash ?? side?.ownerHash ?? null });
      touchSave(this.dataDir, {
        key, name,
        day: Math.floor((w.t ?? 0) / (w.dayTicks ?? 24)),
        population: Object.values(w.agents).filter(a => !a.dead && !a.isPlayer).length,
        status: w.survival?.ended ? 'extinct' : w.survival?.playerDead ? 'ghost' : 'active',
        lastSeenAt,
      });
    } finally {
      if (existsSync(tmp)) rmSync(tmp,{force:true});
    }
  }

  markSeen(entry, now, intervalMs = 60_000) {
    entry.lastUsed = entry.lastSeenAt = now;
    if (entry.savedSeenAt !== undefined && now - entry.savedSeenAt < intervalMs) return;
    touchSave(this.dataDir,{key:entry.key,lastSeenAt:now});
    entry.savedSeenAt = now;
  }

  // 串行 tick：每刻有 wall-time 上限，避免 6 份世界的模型等待互相饿死。
  async tickAll({ budgetMs = 4000, now = Date.now() } = {}) {
    const started = Date.now();
    for (const entry of this.live.values()) {
      if (Date.now() - started > budgetMs) break;
      await tickSurvPlay(entry.sp, { now });
      this.stats.ticks += 1;
    }
    return this.stats.ticks;
  }

  // 落盘：每份营地各自写 gzip，并更新索引。
  persist() {
    for (const entry of this.live.values()) this.persistEntry(entry);
    return this.live.size;
  }

  close() { this.live.clear(); }
}






