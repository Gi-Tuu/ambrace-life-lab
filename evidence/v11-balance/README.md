# evidence/v11-balance · 1.1 正式钟生存

修复前基线：`main` @ `4b60736`。修复内容与结论见 `docs/回报-1.1-正式钟生存-2026-11-20.md`。

## 前后分布（5 seeds × 200 日）

| 文件 | 口径 |
|---|---|
| `long-run-on.{json,log}` | 修复后：正式连续钟 + 分钟身体（默认） |
| `long-run-off.{json,log}` | 修复后：`M5_MINUTE_METAB=0` 回退（身体仍在 think 里按刻结算） |
| `long-run-legacy-formal.{json,log}` | 对照：同 `FORMAL_OPTIONS`、无 simClock（旧每刻路径；与 `evidence/redo-p3/long-run.json` 逐项相同） |
| `long-run-p3-legacy-rules.{json,log}` | 对照：`GAME_OPTIONS` + `eventRules=1`（`life/long-run.mjs` 的 v1 口径） |
| `long-run-p3.log` | 参考：`GAME_OPTIONS` + `eventRules=2`（当前事件规则的 P3 口径，非旧基线） |
| `summary.json` | before/after/对照与研究 md5 的机器可读汇总 |

修复前同 harness 数据在 `evidence/v11-metab/long-run-{on,off}.json`。

## 根因 / 死亡曲线

| 文件 | 说明 |
|---|---|
| `before-probe-on-7.json` | `4b60736` worktree 里同 probe 跑 seed7 100 日 → 第 51 天全灭；含逐日公仓/产出/能量/死因 |
| `probe-on-7.json` | 修复后同 probe seed7 100 日 → 人口 7、0 死亡；用于前后对照 |
| `death-curve.json` | 从上面两份摘出的死亡/食物曲线 |
| `before-regression-test.log` | `life/v11-balance.test.mjs` 在 `4b60736` 上跑：BAL-01/02/03 红（1 分/步 vs 60 分/步分叉、tick 返回 Promise、移动门不存在） |
| `after-think-probe.log` / `after-think-probe-legacy.log` | 修复后 5 日决策节拍/旅行/单程时长探针 |

## 闸门

| 文件 | 结果 |
|---|---|
| `full-test-after.log` | 无并发负载的全量：1146/1146 pass、0 fail |
| `full-test-load-flaky.log` | 有并发负载时的一次全量：1143/1146，3 条均为负载敏感的时序/寻路闸门（单跑全绿；详见报告 §4/§5） |
| `full-test-before-new-gate.log` | 加入 `v11-balance.test.mjs` 之前的一次全量：1142/1142 |
| `check.log` | 静态/架构检查通过（语法 488、测试 204、架构 343/12） |
| `golden-run.log` / `golden-compare.log` | golden 45/45，diffs 0（vs `p3-final`） |
| `parity.log` | 2×11,000 点 terrain/walk/height/portal/bridge 全 0 |
| `quickstart-browser.log` | quickstart PASS |
| `research/` + `research-md5.json` | 研究五面重跑；按 P3 的 CRLF 字节口径归一后 5/5 md5 相同 |

## 复跑

```bash
node scripts/v11-balance-long-run.mjs --mode on
node scripts/v11-balance-long-run.mjs --mode off
node scripts/v11-balance-long-run.mjs --mode legacy-formal
node scripts/v11-balance-long-run.mjs --mode p3 --rules 1
node scripts/v11-balance-summary.mjs
node --test life/v11-balance.test.mjs
node scripts/test.mjs
node scripts/check.mjs
node scripts/redo-p0-golden.mjs --label v11-balance
node scripts/p2-golden-compare.mjs p3-final v11-balance
node scripts/p2-space-parity.mjs
node scripts/quickstart-browser.mjs
```
