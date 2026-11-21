> 历史快照（当时版本），现行口径见 README/CHANGELOG。

# 时间节奏 1:10 证据（2026-11-21）

口径：**现实 1 分钟 = 游戏 10 分钟；1 游戏分钟 = 6000ms；1 天 1440 游戏分 = 144 现实分钟（2.4h）**。
正式连续世界由 `simClock`（`GAME_MS_PER_MINUTE=6000`）驱动；`TICK_MS` 只服务研究态/非连续旧路径，部署设 `360000` 只为让仍按「刻」换算的表现层同口径。

## 闸门结果

| 闸门 | 结果 | 证据 |
|---|---|---|
| 全量测试 | **1192/1192 pass**，209 文件，74.5s | `full-test.log` |
| 静态检查 | PASS：493 文件 · 209 测试文件 · 架构闸门 349 文件/12 白名单 | `check.log` |
| 真实 60s | 1.004 真实分 → **10.018 游戏分**，比 **1:9.983** | `pace.json`、`browser.log` |
| HUD 6s | +1.116 游戏分（锚点 `msPerGameMinute=6000`） | `hud-a.png`、`hud-b.png`、`pace.log` |
| HUD 60s | +10.103 游戏分 | `pace.json` |
| 暂停 | HUD/服务端均冻结在同一分钟 | `hud-paused.png`、`pace.json` |
| 倍速 2× | 6s 服务端 +2.009 游戏分 | `hud-rate2.png`、`pace.json` |
| 金样 | **45/45，diffs 0**（vs `p3-final`） | `golden-compare.json`、`golden/` |
| 22k parity | 2×11000 点 terrain/walk/height/portal/bridge **全 0** | `parity.json`、`parity.log` |
| 研究五面 md5 | 5/5 与 P3 台账逐位相同（rerun） | `research-md5.log`、`research-md5.json` |
| quickstart | PASS（走/采集/吃/睡/HUD/死亡后世界继续） | `quickstart.log` |

## 复现命令

```bash
node scripts/test.mjs
node scripts/check.mjs
node scripts/pace-1to10-browser.mjs
node scripts/quickstart-browser.mjs
node scripts/redo-p0-golden.mjs --label pace-1to10
node scripts/p2-golden-compare.mjs p3-final pace-1to10
PARITY_OUT=pace-1to10 node scripts/p2-space-parity.mjs
node evidence/v11-research/run-research-md5.mjs --rerun
```

说明：`p2-space-parity.mjs` 自身会写 `evidence/<PARITY_OUT>/parity.log`，所以控制台输出另存为
`parity-console.log`，避免与本目录 `parity.log` 冲突。
