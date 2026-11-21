# 时间节奏 × 移动修复证据（2026-11-21）

事故：1:10 时间节奏（`msPerGameMinute=6000`）把**位移**也按游戏分钟换算，玩家现实 1 秒只走
0.0625 tile（3 tile/s 的 1/48）；quickstart 固定按键 1200ms 只走 0.074（1.1.2 是 700ms→2.1）。
修法：位移（玩家键盘、居民连续路径、服务端 `playerReach`）只按**真实毫秒**，动作/睡眠/旅行的
“游戏分钟”语义保持 1:10。详见 `docs/回报-时间节奏移动修复-2026-11-21.md`。

## 闸门结果

| 闸门 | 结果 | 证据 |
|---|---|---|
| 全量测试 | **1214/1214 pass**，212 文件 | `full-test.log` |
| 静态检查 | PASS：语法 499 文件 · 测试 212 · 架构闸门 353 文件/12 白名单 | `check.log` |
| 真实 1s 步行 | **3.10 tile / 3.061 tile/s**（≥2.5 闸门） | `browser.json`、`browser.log`、`walk-1s.png` |
| 真实 1s 冲刺 | **5.70 tile / 5.391 tile/s**（≥4.5 闸门） | `browser.json`、`sprint-1s.png` |
| 室内 WASD 1s | **3.10 tile / 2.982 tile/s**（室外/室内同一手感） | `browser.json`、`indoor-1s.png` |
| 居民 10s | 服务端位置 **+36.0**、客户端行走 **+17.3**（≥10/≥15） | `browser.json`、`resident-10s.png` |
| 断线重连 | 重载后 1s **3.10 tile / 2.878 tile/s**，与服务端权威位置差 **0.5** | `browser.json`、`browser.log` |
| quickstart | PASS：`walkMoved=2.15`、**3.071 tile/s**、采集/吃/睡/死亡后世界继续 | `quickstart-console.log`、`../score/quickstart-browser.log` |
| 60s 时间 | 1.004 现实分 → **10.022 游戏分（1:9.979）**；HUD 60s +10.102；暂停冻结；rate2 6s +2.003 | `pace-console.log`、`pace-1to10.json` |
| golden | **45/45，diffs 0**（vs `p3-final`） | `golden-compare.json`、`golden/` |
| 22k parity | 2×11000 点 terrain/walk/height/portal/bridge **全 0**；quickstart 探针 700ms 走 2.2 tile | `parity*.json`、`parity.log` |
| 研究五面 md5 | 5/5 与 P3 台账逐位相同（rerun） | `research-md5.log` |

## 复现命令

```bash
node scripts/test.mjs
node scripts/check.mjs
node scripts/pace-move-browser.mjs
node scripts/quickstart-browser.mjs
node scripts/pace-1to10-browser.mjs     # 输出 evidence/pace-1to10/，本目录留了 pace-1to10.json/log
node scripts/redo-p0-golden.mjs --label pace-move-fix
node scripts/p2-golden-compare.mjs p3-final pace-move-fix
PARITY_OUT=pace-move-fix node scripts/p2-space-parity.mjs
node evidence/v11-research/run-research-md5.mjs --rerun
```

说明：
- `quickstart-console.log`/`pace-console.log`/`browser-console.log` 是脚本 stdout；`*.json` 是结构化结果。
- `golden/` 是金样采集产物（json + 3 张图），与 `evidence/redo-p0/p3-final.json` 对比。
- `full-test.log` 为最终一次全量。同一命令在本机重负载下曾抖动两条时序用例
  （`V11-OFFLINE-01` 的 1200 vs 1200.1、`DATA5-04` 的 6 进程并发），单独重跑均绿；
  没有改弱任何断言，也不属于本次位移改动。
