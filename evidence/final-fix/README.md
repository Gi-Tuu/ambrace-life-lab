> 历史快照（当时版本），现行口径见 README/CHANGELOG。

# evidence/final-fix —— 审查修复证据（1.1，main @ 3643f14）

- 基线：`main` @ `caad92b`（审查对象）；对照 `master` @ `4f2577b`（v1.0.0，**未动**）。
- 修复后：`main` @ `3643f14`（本目录生成时的 HEAD；未 push、未部署、未 bump 版本、未打 tag）。
- 主报告：`docs/回报-审查修复-2026-11-21.md`（`docs/` 被仓库策略 ignore，只在本机工作树）。
- 审查报告：`docs/审查-1.1-2026-11-21.md`、`evidence/final-review/`（未跟踪，保留为输入证据）。

## 修了什么

| 项 | 结论 | 闸门 |
|---|---|---|
| P1-1 p1 每游戏小时被结算两次 | 已修（`survplay.mjs` worldTick 的 p1 tick 加 `!minuteBody` 门） | `V11-METAB-01/02` 纳入 p1；`V11-METAB-10` p1 与居民每小时同量 |
| P1-2 重启离线补时失效 | 已修（读档后把真实停机分钟写入 `S.missed`；正式世界由 `catchUpSurvival` 按同一 `clock.rate` 补，cap 120 刻/7200 游戏分；不重复补） | `V11-OFFLINE-01`：60 真实分 × rate2 = 432 游戏分/+7 刻；无 survival 块档案不推进 |
| P1-3 200 日双峰 | 未改阈值；报告如实披露 seed 7/29/41 崩落链并给出裁决（≤100 日口径可接受，>150 日演示风险最高） | 5 seeds × 100/200 日复跑 |
| P1-4 部署冒烟 | 已复验 runtime/静态面；Docker build 与线上 iframe 仍标未验 | `deploy-smoke` 203/203 + 17/17；browser iframe 12/12 + perf 16/16 |

## 最终闸门（HEAD 3643f14）

| 闸门 | 结果 | 证据 |
|---|---|---|
| 全量测试 | **1165/1165 pass，fail 0**（59.1s） | `full-test-after.log` |
| 静态检查 | 489 文件 / 9 JSON / 23 模块 / **207 测试** / 341 运行 / 12 白名单 | `check-after.log` |
| golden | **45/45，diffs 0** | `golden/golden-compare.log`、`golden/final-fix.json`、3 张截图 |
| 22k parity | 2×11000 terrain/walk/height/portal/kind **全 0** | `parity.json`、`parity.log`、`parity-*.json` |
| 研究五面 md5 | **5/5 match**（真实重跑 run.mjs，CRLF 归一） | `research-md5-after.json`、`research-md5-after.log`、`research-*-after.log` |
| 12 份研究台账 | 12 artifact / 65 条 / **0 不一致** | `research-ledgers-after.log` |
| quickstart 真 Chrome | **PASS**（起服→走→采集→吃→睡→HUD→死亡后世界继续） | `quickstart-browser-after.log` |
| 100 日 5 seeds | **0/5 灭绝**，pop `7,9,10,9,9`，均值 8.8 | `long-run-on-200d-after-fix.json/.log` |
| 200 日 5 seeds | **1/5 灭绝**，pop `1,9,1,0,7`；衰老 35 + 饥饿 10；agentErrors 0 | 同上 |
| P1-1 探针 | on `-0.024` → **`-0.012`/游戏小时**；off `-0.012` | `player-metab-BEFORE.json` / `player-metab-AFTER.json` |
| P1-2 探针 | `t 2→2`、`missed 0` → **`t 2→5`、+216 游戏分、missed 60 / appliedMinutes 216 / cap 7200** | `offline-catchup-BEFORE.json` / `offline-catchup-AFTER.json` |

## 文件

| 文件/目录 | 说明 |
|---|---|
| `summary.json` | 上述闸门与 P1-1/2/3/4 的机器可读汇总 |
| `full-test-after.log`、`check-after.log` | 最终 HEAD 全量/静态 |
| `v11-metab-after.log`、`v11-offline-restart-after.log` | 新增/修改闸门的单独运行记录 |
| `research-md5-after.mjs`、`run-research-md5-after.mjs` 产物 | 五面真实重跑源码与 md5 |
| `run-balance-key.mjs`、`long-run-on-200d-after-fix.*` | 100/200 日复跑源码与数据（birth/death 日、拒绝原因） |
| `player-metab-BEFORE/AFTER.json` | P1-1 修复前后独立探针 |
| `offline-catchup-BEFORE/AFTER.json` | P1-2 修复前后独立探针 |
| `golden/` | 45/45 金样、截图、采集/对比日志 |
| `parity*` | 2×11000 parity |
| `deploy-smoke/` | build-audit、http-matrix、http-headers、iframe、perf、server/browser 日志 |
| `deploy-smoke-console.log`、`deploy-smoke-browser-console.log` | 部署冒烟完整控制台输出 |
| `debug-seed7*.mjs` | seed 7 崩落链的一次性诊断脚本（只读，不含业务改动） |
| `commit-1.log` | 修复 commit 的落盘输出 |

## 一键复跑（本机）

```bash
node scripts/test.mjs > evidence/final-fix/full-test-after.log
node scripts/check.mjs > evidence/final-fix/check-after.log
node scripts/research-md5-ledgers.mjs --check > evidence/final-fix/research-ledgers-after.log
node evidence/final-fix/run-research-md5-after.mjs
node evidence/final-fix/run-balance-key.mjs --days=200
node evidence/final-review/player-metab-probe.mjs
node evidence/final-review/offline-catchup-probe.mjs

# golden/quickstart/parity/deploy 建议在干净 worktree（git worktree add --detach <dir> HEAD）里跑：
node scripts/redo-p0-golden.mjs --label final-fix
node scripts/p2-golden-compare.mjs p3-final final-fix
node scripts/quickstart-browser.mjs
PARITY_OUT=final-fix node scripts/p2-space-parity.mjs
node scripts/deploy-smoke.mjs all
node scripts/deploy-smoke-browser.mjs all
```

## 边界（不能声称）

- 没有 Docker daemon：**未 docker build**，镜像大小/层数/容器内 HEALTHCHECK 未实测；`deploy-smoke` 是文件级物化 + HTTP/安全头等价检查。
- 没有线上平台：**未实测 ms.show/Qoder CN 的 iframe/TLS/嵌套**；本地 CSP iframe 模拟只证明头与白名单行为。
- 200 日只跑 5 seeds（与审查同口径），每个 seed 单次；不声称分布置信区间。
- 未改任何平衡阈值；P1-3 是产品裁决，不是代码修复。
