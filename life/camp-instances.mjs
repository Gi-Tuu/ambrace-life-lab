// 名字存档的世界实例管理器（S2 任务二 / C1）。
//
// 红线（交接单 §4.3）：
//  · 不实例化 host.mjs 的 N 份（它是模块级单例）；这里直接组合 survplay 的纯 API。
//  · 不给每份世界造新 deliberator：调用方传进来的 options 里带同一个 modelBrain，
//    于是两把尺子记账、熔断、排队天然全局共享。
//  · 名字只作为字段进索引，**永不进路径**；路径由 sha256(归一化名字) 派生。
//  · 只在 saves/ 目录内读写；拒绝一切越界名字，且拒绝时不得产生任何文件写入。
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';

import { createSurvPlay, dumpSurv, loadSurv, tickSurvPlay } from './survplay.mjs';

export const NAME_MIN = 1;
export const NAME_MAX = 16;
export const SAVE_TTL_MS = 3 * 24 * 60 * 60 * 1000; // 3 天无活跃即删
export const RESIDENT_LIMIT = 6; // 常驻上限（含主营地）

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
const campFile = (dataDir, key) => join(savesDir(dataDir), `${key}.json.gz`);

// 索引：{ entries: [{ key, name, day, population, status, lastSeenAt, main }] }
export function readIndex(dataDir) {
  try {
    const raw = JSON.parse(readFileSync(indexFile(dataDir), 'utf8'));
    return { entries: Array.isArray(raw?.entries) ? raw.entries : [] };
  } catch {
    return { entries: [] };
  }
}

export function writeIndex(dataDir, index) {
  const dir = savesDir(dataDir);
  mkdirSync(dir, { recursive: true });
  const tmp = `${indexFile(dataDir)}.tmp`;
  writeFileSync(tmp, JSON.stringify({ entries: index.entries ?? [] }));
  renameSync(tmp, indexFile(dataDir));
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

export function saveCamp(dataDir, key, survivalDump) {
  const dir = savesDir(dataDir);
  mkdirSync(dir, { recursive: true });
  const tmp = `${campFile(dataDir, key)}.tmp`;
  writeFileSync(tmp, gzipSync(Buffer.from(JSON.stringify(survivalDump))));
  renameSync(tmp, campFile(dataDir, key));
  return campFile(dataDir, key);
}

export function loadCamp(dataDir, key) {
  return JSON.parse(gunzipSync(readFileSync(campFile(dataDir, key))).toString('utf8'));
}

export function touchSave(dataDir, entry) {
  const index = readIndex(dataDir);
  const i = index.entries.findIndex((e) => e.key === entry.key);
  const next = { ...(i >= 0 ? index.entries[i] : { key: entry.key, name: entry.name }), ...entry, lastSeenAt: entry.lastSeenAt ?? Date.now() };
  if (i >= 0) index.entries[i] = next;
  else index.entries.push(next);
  writeIndex(dataDir, index);
  return next;
}

// TTL 清扫：只删 saves/ 里的文件；**正在被观看的营地绝不删**（先查观看计数再动文件）。
export function sweepSaves(dataDir, { now = Date.now(), ttlMs = SAVE_TTL_MS, isWatched = () => false } = {}) {
  const dir = savesDir(dataDir);
  if (!existsSync(dir)) return { removed: [], kept: 0 };
  const index = readIndex(dataDir);
  const removed = [];
  const kept = [];
  for (const entry of index.entries) {
    const stale = now - (entry.lastSeenAt ?? 0) > ttlMs;
    if (!stale || isWatched(entry.key)) { kept.push(entry); continue; }
    const file = campFile(dataDir, entry.key);
    if (existsSync(file)) rmSync(file);
    removed.push(entry.key);
  }
  if (removed.length) writeIndex(dataDir, { entries: kept });
  return { removed, kept: kept.length };
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
      hit.lastUsed = now;
      return { ok: true, code: 'OK', key: id.key, sp: hit.sp, created: false };
    }
    let archive = null;
    if (existsSync(campFile(this.dataDir, id.key))) archive = loadCamp(this.dataDir, id.key);
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
    this.live.set(id.key, { sp, key: id.key, name: id.display, lastUsed: now });
    this.evictIfNeeded();
    touchSave(this.dataDir, {
      key: id.key, name: id.display,
      day: Math.floor((sp.world.t ?? 0) / (sp.world.dayTicks ?? 24)),
      population: Object.values(sp.world.agents).filter((a) => !a.dead && !a.isPlayer).length,
      status: sp.world.survival?.playerDead ? 'ended' : 'active',
      lastSeenAt: now,
    });
    return { ok: true, code: 'OK', key: id.key, sp, created };
  }

  // 按 key 取（cookie 路由用）：先 live，再磁盘；都没有返回 null。
  openKey(key, { now = Date.now() } = {}) {
    if (!key) return null;
    const hit = this.live.get(key);
    if (hit) { hit.lastUsed = now; return hit.sp; }
    if (!existsSync(campFile(this.dataDir, key))) return null;
    const sp = loadSurv(loadCamp(this.dataDir, key), this.options.seed ?? 7, this.options);
    sp.world.campKey = key;
    this.live.set(key, { sp, key, name: readIndex(this.dataDir).entries.find((e) => e.key === key)?.name ?? key, lastUsed: now });
    this.evictIfNeeded();
    return sp;
  }

  evictIfNeeded() {
    while (this.live.size > this.limit) {
      let oldestKey = null, oldest = Infinity;
      for (const [key, v] of this.live) if (v.lastUsed < oldest) { oldest = v.lastUsed; oldestKey = key; }
      if (!oldestKey) break;
      this.live.delete(oldestKey);
      this.stats.evicted += 1;
    }
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
  persist({ now = Date.now() } = {}) {
    for (const entry of this.live.values()) {
      saveCamp(this.dataDir, entry.key, dumpSurv(entry.sp));
      touchSave(this.dataDir, {
        key: entry.key, name: entry.name,
        day: Math.floor((entry.sp.world.t ?? 0) / (entry.sp.world.dayTicks ?? 24)),
        population: Object.values(entry.sp.world.agents).filter((a) => !a.dead && !a.isPlayer).length,
        status: entry.sp.world.survival?.playerDead ? 'ended' : 'active',
        lastSeenAt: now,
      });
    }
    return this.live.size;
  }

  close() { this.live.clear(); }
}
