// CI/本机共用的 Chrome 闸门：REQUIRE_CHROME=1 时找不到浏览器必须失败（而不是静默 skip）。
// 纯函数注入 exists，便于单测证明“缺失 ⇒ fail”真的会红。
import { existsSync } from 'node:fs';

export const CHROME_CANDIDATES = Object.freeze([
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x64)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
]);

export function chromeGate({
  requireChrome = process.env.REQUIRE_CHROME === '1',
  exists = existsSync,
  candidates = CHROME_CANDIDATES,
} = {}) {
  const path = candidates.find((p) => exists(p)) ?? null;
  if (path) return { path, skip: false, fail: false, reason: null, required: requireChrome };
  if (requireChrome) {
    return { path: null, skip: false, fail: true, reason: 'REQUIRE_CHROME=1 但本机/CI 找不到 Chrome：浏览器用例必须失败而不是静默跳过', required: true };
  }
  return { path: null, skip: true, fail: false, reason: '本机没有 Chrome，跳过浏览器用例（CI 用 REQUIRE_CHROME=1 强制）', required: false };
}
