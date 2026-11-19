// 持久化机制：串行写队列、动作合并窗口、原子提交、读档回退、坏档隔离。
// host 只保留"写什么/何时写"的领域 glue；磁盘时序全部在这里可单测。
import { mkdir, readFile, writeFile, rename, readdir, rm, copyFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export function createWriteQueue() {
  let chain = Promise.resolve();
  return {
    enqueue(task) {
      const run = chain.then(task);
      chain = run.catch(() => {});
      return run;
    },
    flush() { return chain; },
  };
}

export function createCoalescer({ delayMs = 0, run, unref = true }) {
  let timer = null;
  const schedule = () => {
    if (delayMs <= 0) { void run(); return false; }
    if (timer) return false;
    timer = setTimeout(() => { timer = null; void run(); }, delayMs);
    if (unref) timer.unref?.();
    return true;
  };
  return {
    schedule,
    takeNow() {
      if (!timer) return false;
      clearTimeout(timer);
      timer = null;
      void run();
      return true;
    },
    pending() { return Boolean(timer); },
  };
}

let writeSeq = 0;
// SEC5-06：错误只回错误码，不把 fs message 里的绝对路径/用户名带回 HTTP。
export function publicSaveError(error) {
  if (error?.code === 'PRESERVE_PRIMARY') return '旧存档未能隔离，暂停覆盖';
  const code = String(error?.code ?? '');
  return /^[A-Z][A-Z0-9_]*$/.test(code) ? code : 'SAVE_FAILED';
}
// 唯一 tmp（H-09）→ 备份旧档 → rename 发布。失败不覆盖旧档；tmp 无论成败都清掉。
export async function writeArchiveAtomic({ file, text, preservePrimary = false, primaryValid = false }) {
  const tmp = `${file}.${process.pid}.${(writeSeq += 1)}.tmp`;
  const backupTmp = `${tmp}.bak`;
  try {
    await mkdir(dirname(file), { recursive: true });
    // 故障注入（仅证据/测试）：模拟慢磁盘，验证 tick 没有 await 这条路径。
    const stall = Number(process.env.ARCH_WRITE_STALL_MS ?? 0);
    if (stall > 0) await new Promise((resolve) => setTimeout(resolve, stall));
    await writeFile(tmp, text, 'utf8');
    if (preservePrimary) { const e = new Error('旧存档未能隔离，暂停覆盖'); e.code = 'PRESERVE_PRIMARY'; throw e; }
    if (primaryValid) {
      let copied = true;
      try { await copyFile(file, backupTmp); }
      catch (error) { if (error.code !== 'ENOENT') throw error; copied = false; }
      if (copied) await rename(backupTmp, `${file}.bak`);
    }
    await rename(tmp, file);
    return { ok: true, file, error: null };
  } catch (error) {
    return { ok: false, file, error: publicSaveError(error) };
  } finally {
    await Promise.allSettled([rm(tmp, { force: true }), rm(backupTmp, { force: true })]);
  }
}

// 读档：主路径失败且属于"可降级"错误（M5 状态）时再读一次 skip，带 warning 返回。
// BUG-5 / DATA5-09：载入失败的错误可能带路径；这里只留给本地日志（调用方决定是否回显）。
export async function readArchiveFile(path, { decode, recoverCodes = ['M5_STATE_INVALID'] } = {}) {
  const source = await readFile(path, 'utf8');
  try {
    return { loaded: await decode(source), warning: null };
  } catch (error) {
    if (!recoverCodes.includes(error.code)) throw error;
    return { loaded: await decode(source, { skipM5: true }), warning: String(error?.message ?? error) };
  }
}

// 隔离文件不能无限堆：每次约 340KB，只留最近 N 份。
export async function quarantineArchive(dir, worldFile, { keep = 5 } = {}) {
  const dst = join(dir, `world.corrupt-${Date.now()}.json`);
  try {
    await rename(worldFile, dst);
  } catch {
    return { path: null, error: '隔离失败（目录不可写/文件被占）' };
  }
  try {
    const olds = (await readdir(dir)).filter((n) => n.startsWith('world.corrupt-')).sort();
    for (const n of olds.slice(0, Math.max(0, olds.length - keep))) await rm(join(dir, n), { force: true });
  } catch { /* 清理失败不重要 */ }
  return { path: dst, error: null };
}
