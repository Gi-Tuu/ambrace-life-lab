# 基准与负向对照（作者侧）

> **这不是外部独立基准，也不是第三方验证。**
> 本文与 `scripts/score-baseline.mjs` 是作者自己做的消融/负向对照：在同一台机器、同一份代码、同一组 seeds 与 tick 数下，比较“内部状态通道接通 / 切断 / 随机选择”三种装置的行为分布与可复现性。它能证明“切断通道后分布变了、同 seed 能复现”，不能证明“机制在真实模型、真实玩家或第三方环境里同样成立”。外部验证尚未进行；第三方按下面的协议复现之前，不应把这里的数字写成“已通过外部验证”。

## 1. 它回答什么

| 问题 | 本基准的做法 | 能得出的结论 | 不能得出的结论 |
|---|---|---|---|
| 切断内部通道，行为分布会变吗？ | `internal`（C2）vs `cut`（C2-neg） | 同装置下分布不同（KL/JSD > 0） | 变化一定来自某个具体认知机制 |
| 换一种“被问到时随机选”的策略，分布会变吗？ | `internal` vs `random` | 事件门控处的随机化足以改变动作 kind 分布 | 通用随机策略的基线表现 |
| 同 seed 能复现吗？ | 每个 arm×seed 跑 2 次，比 SHA-256 摘要 | 逐位一致（本机、本 Node 大版本） | 跨机器/跨版本逐位一致 |

## 2. 装置

脚本：[`scripts/score-baseline.mjs`](./scripts/score-baseline.mjs)；证据：[`evidence/score/baseline.json`](./evidence/score/baseline.json)。

- 世界：`createSurvPlay(seed, BASE)`，`BASE` 见脚本文本（`gameRules`、`independentWorld`、`settlementLife`、`ecosystem`、`farmLife`、`actTimeModel` 等全开；`regionalWork` 不开，避免把分城区布局差异混进基线）。
- 三个 arm：
  - `internal`：`residentCondition='C2'`，内部状态通道按登记定义接通；
  - `cut`：`residentCondition='C2-neg'`，登记过的负向对照，切断内部状态进入决策；
  - `random`：`C2` + 一个只在“事件门控真的问到模型”时生效的随机 deliberator。它用 `hashSeed(seed, 'random-pick:t:id:n')` 选候选，因此同 seed 可复现；**其余时刻仍走同一确定性替身，所以它不是通用随机策略**，只是“把被问到的那次选择随机化”的探针。
- seeds：`7,13`；ticks：`240`（10 个游戏日，24 刻/日）；repeats：`2`。
- 行为分布：所有居民成功执行的动作 `kind` 计数（排除 `ok:false`、`refused`、`aborted`），跨 seed 聚合后归一。
- 可复现摘要：每个 arm×seed 的动作序列 + 终止刻/人口/死亡/公仓 做 SHA-256；同 arm×seed 的两次 repeat 必须相同。

## 3. 本机实测（2026-11-18，Node v24.18.0）

> **版本提示（2026-11-21 文档刷新）**：下面这组读数来自 **2026-11-18（v0.1.5 时代）**。1.6.0 改动了生存世界的牲畜圈几何与体力恢复，**这组数字不能当作 1.6.0 读数**；重跑 `node scripts/score-baseline.mjs --ticks 240 --seeds 7,13 --repeats 2` 后才算新基线。本文档刷新时未重跑（按"文档改动不跑业务测试"处理）。

命令：

```bash
node scripts/score-baseline.mjs --ticks 240 --seeds 7,13 --repeats 2
```

输出摘要（与 `evidence/score/baseline.json` 同源）：

| arm | 决策数 | 动作 kind 数 | 分布熵（bit） | 同 seed 可复现 |
|---|---:|---:|---:|---|
| internal | 1766 | 20 | 2.542412 | 是（2/2） |
| cut | 1781 | 20 | 2.449833 | 是（2/2） |
| random | 1880 | 21 | 2.530196 | 是（2/2） |

分布差异：

| 对照 | KL(internal‖other) | JSD |
|---|---:|---:|
| internal vs cut | 0.017097 | 0.003904 |
| internal vs random | 0.024346 | 0.006029 |
| cut vs random | 0.006471 | 0.001894 |

`random` arm 的 `asked` 计数（seed 7/13 分别 51/52）证明随机 deliberator 真的被事件门控调用过；`internal`/`cut` 没有真模型，`asked=0` 是预期行为。

### 怎么读这些数

- KL/JSD 是**描述性**的：只说明“同装置里分布不同”，没有显著性检验，也没有预登记阈值。不要把它写成“p<0.05”或“效应量”。
- `cut` 的决策数略多、熵略低，不代表“切断后更好/更差”；本基准不评价好坏，只记录分布。
- 三个 arm 的随机数消费不同（`random` 在事件门控处额外用哈希选候选），所以不是同随机流对照；这也是它只能叫“消融/负控”的原因之一。
- 同 seed 两次 repeat 逐位一致，是**本机确定性**证据；换 Node 大版本/平台可能不同（项目其他五份面同样只承诺同环境）。

## 4. 第三方复现协议

前置：Node 22+（本机 v24.18.0），零第三方依赖，仓库根执行。

```bash
git clone https://github.com/Gi-Tuu/ambrace-life-lab.git
cd ambrace-life-lab
git rev-parse --short HEAD
node --version
node scripts/score-baseline.mjs --ticks 240 --seeds 7,13 --repeats 2
```

验收：

1. 命令退出码 0，最后一行有 `pass=true`；
2. 生成的 `evidence/score/baseline.json` 中 `checks.reproducible`、`checks.distributionsDiffer`、`checks.hasDecisions` 都为 `true`；
3. `arms.*.seeds.*.digest` 在同 arm×seed 的两次 repeat 中相同；
4. 记录你的 `node --version`、平台、HEAD；如果与本文数字不同，先按第 5 节判断是环境差异还是代码差异。

想只验证可复现性、不写证据文件：

```bash
node scripts/score-baseline.mjs --ticks 48 --seeds 7 --repeats 2 --out /tmp/baseline-smoke.json
```

## 5. 未验证声明与边界

- **没有外部独立复现**：本文所有数字都出自作者机器；没有第三方实验室、没有独立评审、没有跨实现对照。
- **没有真实模型参与**：三个 arm 都走本地确定性替身；`random` 只是随机选候选。真实 LLM 的质量/稳定性未被本基准检验。
- **没有真人玩家参与**：没有玩家动作脚本，只有居民自主行动；玩家在环行为未覆盖。
- **没有统计显著性**：单组 seeds/tick 数，KL/JSD 是描述统计；不声称因果机制。
- **不是性能基准**：没有测吞吐/延迟/内存；`durationMs` 只是本机运行耗时。
- **不是跨版本兼容承诺**：同 Node 大版本、同 seed、同 HEAD 才承诺逐位；升级 Node 或改代码后重跑，以新证据为准。
- **`cut` 的语义来自登记**：C2-neg 是项目里已登记的负向对照；本基准不重新证明这个登记本身合理。

## 6. 与项目其他证据的关系

- 五份研究面（`--report/--sweep/--viab/--recover/--metab`）是**研究态**基线，md5 见 [EVIDENCE.md](./EVIDENCE.md)；本基准是**生存游戏态**的作者侧消融，两者不要混用。
- 机制是否“承重”的强证据在 `life/*.test.mjs` 的负向对照与变异电池（`npm test`，1261 条，2026-11-21）；本基准只是补一个可复现的行为分布读数。
- 外部验证如果以后做了，应新增独立文件/章节，并明确标注“外部”；不要把本文改写成“已外部验证”。
