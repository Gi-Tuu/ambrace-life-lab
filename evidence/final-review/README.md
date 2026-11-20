# evidence/final-review —— 1.1 发布前独立审查证据（只读）

审查对象：`main` @ `caad92b`；对照 `master` @ `4f2577b`（tag `v1.0.0`）。
本目录只放**复跑/探针产生的证据**与探针源码；未改业务代码。主报告：`docs/审查-1.1-2026-11-21.md`。

## 一键复跑

```bash
# 全量 / 静态 / 台账（HEAD）
node scripts/test.mjs > evidence/final-review/full-test-head.log
node scripts/check.mjs > evidence/final-review/check-head.log
node scripts/research-md5-ledgers.mjs --check > evidence/final-review/research-ledgers-head.log

# 200 日 5 seeds（不覆盖 evidence/v11-balance 原台账）
node evidence/final-review/run-balance-200.mjs --days=200

# 两个关键缺陷探针
node evidence/final-review/offline-catchup-probe.mjs      # 重启后离线补时：不生效
node evidence/final-review/player-metab-probe.mjs         # p1 每游戏小时 -0.024（居民 -0.012）

# 性能（写本目录 perf/）
P3_PERF_OUT=evidence/final-review/perf node scripts/p3-perf-browser.mjs
```

golden/parity/quickstart 是在 `git archive HEAD` 的临时副本里跑的（避免改本仓库 tracked evidence）：

```bash
git archive HEAD | tar -x -C "$TEMP/ambrace-head-review"
cd "$TEMP/ambrace-head-review"
node scripts/redo-p0-golden.mjs --label final-review
node scripts/p2-golden-compare.mjs p3-final final-review
PARITY_OUT=final-review node scripts/p2-space-parity.mjs
node scripts/quickstart-browser.mjs
```

## 文件

| 文件 | 说明 |
|---|---|
| `full-test-head.log` | HEAD 全量 `1163/1163 pass, fail 0` |
| `check-head.log` | 静态检查 `488 文件 / 206 测试 / 341 运行 / 12 白名单` |
| `research-ledgers-head.log` | 12 份 artifact / 65 条记录 / 0 不一致 |
| `research-md5-head.json` | HEAD 重跑五面 `life/run.mjs`，CRLF 归一后 5/5 match |
| `golden/golden-head.json` | HEAD 金样（干净副本重采） |
| `golden/golden-compare-head.json` | vs `p3-final`：45/45，diffs 0 |
| `golden/*.png` | 金样截图（survival/compare/title） |
| `parity*.json`、`parity.log` | 22k 点：2×11000 terrain/walk/height/portal/bridge 全 0 |
| `quickstart-browser-head.log` | quickstart 真 Chrome PASS |
| `perf/perf.json`、`perf/perf.log` | cold 648.2ms / warm 526.4ms / fps 50 / p95 33.4 / buildWorld p50 213.8 |
| `long-run-on-200d-head.json`、`balance-200-on.log` | HEAD 200 日 5 seeds：`1,9,1,0,7`，1/5 灭绝，衰老 35+饥饿 10 |
| `player-metab-probe.mjs` / `.json` | p1 每游戏小时 `-0.024`（on）vs `-0.012`（off）；居民 60 分钟步/小时 |
| `offline-catchup-probe.mjs` / `.log` | 伪造停机 60 分钟：`t` 不变、`gameMinutes +0.002`、`missed=0` |
| `master-1.0.0/exact-extinction.json` | 1.0.0 host seed 7：97 日 store 0 → 100 日玩家死 → 101 日灭绝 |
| `master-1.0.0/probe-host-formal*.log` | 1.0.0 host 正式钟 100/150 日采样 |
| `master-1.0.0/probe-host-exact.mjs` | 1.0.0 逐日灭绝探针源码 |
| `serve-head.log`、`serve-head-formal.log` | HEAD 起服日志（研究态 / 正式态） |

## 结论速览

- 作者声称的 100/200 日、1163、golden 45/45、22k、研究五面 md5、12 份台账、perf —— **全部在 HEAD 复现，数字与日志一致**。
- 真实新增问题：**p1 重复结算**（P1）、**重启离线补时失效**（P1）、**200 日双峰且 seed 7 未解释**（P1）、**1.1 部署冒烟未复验**（P1）。
- 发布阻塞是**部署目标/版本**：`v1.0.0` 会在第 101 日（seed 7）灭绝；1.1 未打 tag、`package.json` 仍 1.0.0。
