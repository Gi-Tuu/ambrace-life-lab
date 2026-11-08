# AMBRACE Life Lab

一个持续运行的微型生活世界。AI 居民拥有可量化的内部状态、持久记忆与自主行为；玩家是世界的参与者，不是控制中心。离开后再进入，世界已经自己往前走了一段。

参赛作品：AI+∞ 开发者创作大赛 第三期「AI 造游戏」。

## 它不是什么

不是对话式 NPC。角色的行为由内部状态驱动，经规则层校验合法性后实际改变世界状态；切断某条内部通道后行为分布随之变化，且该变化可复现、可对照。每条判据都配负向对照——不能变红的闸门不算闸门。

## 架构分层

| 层 | 职责 | 模块 |
|---|---|---|
| L0 时钟 | 昼夜节律 | `life/clock.mjs` |
| L1 载体 | 位置、身体、库存、秘密 | `life/body.mjs` |
| L2 感受器 | 感知筛选 + 逐维精度 | `life/model.mjs` |
| L3 反射弧 | 零成本快速反应 | `life/agent.mjs` |
| L4 调制 | 内部状态 → 精度再分配 | `life/modulators.mjs` |
| L5 需求 | 内稳态与操作点 | `life/drives.mjs` |
| L6 认知评价 | 相关 / 意外 / 可控 / 规范 | `life/appraisal.mjs` |
| L7 动机 | 逐动作归因 | `life/metrics.mjs` |
| L8 行为状态 | 目标承诺期（可选层，默认关） | `life/m3-planner.mjs` |
| 耦合调制权 | 变聋 / 离场 / 拒绝互动（可选层，默认关） | `life/coupling.mjs` |
| L9 规则校验 | 合法性 + 驳回重决策 | `life/rules.mjs` |
| L10 反应器 | 意图 → 世界改变 | `life/host.mjs` |
| L11 记忆 | 情景 + 习惯 | `life/memory.mjs` |
| L12 思考层 | 事件门控、按需接 LLM | `life/loop-real.mjs` |
| L13 自我维持 | 存续账本 + 不可逆降级 | `life/viability.mjs` |

L8 与耦合调制权是两层**可选层**：机制侧默认关（`channelMask` 不传），关掉时不消费额外随机数、不写状态，轨迹与没有这两层时逐位相同。
离线实验用 `channelMask` 打开它们并单独计量；演示页上的 `M3 承诺期 / M4 耦合调制` 两个开关只是同一件事的入口，且只叠加在 A 侧（B 侧是切断承重通道的负向对照，把内部状态接回决策就不再是对照）。

## 快速开始

需要 Node 22+，零第三方依赖。

```bash
node serve.mjs          # http://localhost:7860
```

未配置模型端点时世界自动退回本地替身，照常运行。接入真实模型用环境变量（或 `.env`，不入库）：

```
MODEL_BASE_URL=   # 供应商端点，逗号分隔可配多个，按序退回
MODEL_NAME=
MODEL_KEY=
MAX_CALLS=        # 调用预算闸门
SLEEP_MS=
WORLD_PANTRY=     # 世界资源常数
WORLD_STASH=
```

密钥只留在服务端进程，不进前端、不进镜像、不进仓库。

## 判据与复现

```bash
node --test life/life.test.mjs life/host.test.mjs life/host-layers.test.mjs life/s4-predictor.test.mjs life/s4-integration.test.mjs life/o18-metrics.test.mjs life/o18-integration.test.mjs life/social.test.mjs life/scene.test.mjs life/capability.test.mjs life/pack.test.mjs life/m3.test.mjs life/m3-planner.test.mjs life/m3-benchmark.test.mjs life/m3-model-reality.test.mjs life/m3-social-reality.test.mjs life/m3-yield.test.mjs life/m3-stop-proof.test.mjs life/coupling.test.mjs life/o10-ledger.test.mjs life/m5-event-exposure.test.mjs life/m5-host.test.mjs life/m5-integration.test.mjs life/m5-mechanics.test.mjs life/m5-pin.test.mjs life/m5-recovery-metrics.test.mjs life/o9-event-first.test.mjs life/o1-counterfactual.test.mjs life/m6-plastic.test.mjs
node life/o18-heldout.mjs       # 事前特征、时间留出和传话切断对照
node life/run.mjs --report     # 四条件消融矩阵
node life/run.mjs --sweep      # 多 seed 复核
node life/run.mjs --viab       # 受损速度
node life/run.mjs --recover    # 恢复动力学
node life/run.mjs --metab      # 代谢与进食实测账
node life/supply-tradeoff-sweep.mjs   # 供给常数取舍表（只测量，不改默认值）
node life/o1-fallback-audit.mjs       # 影响度兜底窗口是否与侵蚀同窗
node life/o1o9-mutation-battery.mjs   # 闸门变异电池：每条闸门都要能被变异打红
node life/m6-device-probe.mjs         # M6 装置先验（巩固/睡眠压力/学习进度，只测量）
node life/m6p-mutation-battery.mjs    # M6-P 精度门控可塑性闸门变异电池
node life/m6-sl-round3.mjs            # M6 睡眠压力/学习进度 round3 装置（只测量）
node life/seed-gen.mjs 600 seed-run   # 重新生成演示种子存档（离线实跑，固定 seed）
node serve.mjs                 # 本地 demo
```

旧 P3 覆盖使用终局位置、事后需求与样本内标签择优，仅保留历史对照，不代表可执行规则的留出预测率。越轨份量是世界明示的营养当量；预期份量只影响越轨能量评分，支持独立切断，并非已学会后果或完整风险权衡。

套件必须逐个点名文件；`node --test life/` 不给文件名在部分 Node 版本下不通。

## 部署

`Dockerfile` 面向魔搭创空间：监听 `0.0.0.0:7860`，世界状态落在 `DATA_DIR`（容器内 `/data`）。镜像只包含 `serve.mjs`、`life/`、`web/`、`seed/` 四样；密钥走平台密文变量。

世界状态必须在服务端持久化：放在浏览器里关标签页即重置，免费创空间休眠也会丢——两者都会直接否证「内部状态持续存在」这一主张。

**固定历史起点**：免费创空间实测无跨容器重建持久卷（重新部署即清空 `/data`）。因此镜像内置 `seed/world.json`——一份由 `seed-gen.mjs` 离线实跑 600 刻产生的存档（seed=7，含不可逆损失与关系历史）。启动时 `/data` 有存档优先续跑（休眠补时），没有则载入种子：平台重置变成「回到同一个可复现的历史起点」，而非一个空白世界。种子是实跑产物，不是编造历史；载入种子不做休眠补时。

**运行时后端**：种子历史由离线确定性替身产生；启动后的实时决策后端由 `BRAIN` 环境变量显式开关（`model` = 接所配置的真实模型，默认 `local` 替身，防止无预算时意外调用）。公开部署设 `BRAIN=model`，端点为魔搭 API-Inference（失败按配置顺序退到第三方），每供应商可配各自模型 id（`MODEL_NAMES` 按位对应 `MODEL_PROVIDERS`）。

**成本策略**（公开实例）：`MAX_CALLS` 是**每日**额度，跨天归零；只有最近有人在访问（`/world` 等应用路径，`PRESENCE_MS` 内）才允许调用真模型，无人观看时走替身。依据是 1 魔粒≈2 次旗舰调用、签到约 250 魔粒/天。**因此公开实例的行为依赖"当前有没有观众"，它只作为演示，不作为实验读数来源**——实验一律用离线固定条件复现。

## 仓库边界

内部实验记录、台账、赛事工作底稿与手记活稿不在本仓库（见 `.gitignore`）。研究全文与创作手记另行发布。根目录的日志、截图与 dump 均为临时产物，不入库。

## License

Apache-2.0，见 [LICENSE](./LICENSE)。