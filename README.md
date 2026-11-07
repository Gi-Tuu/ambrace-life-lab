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
| L9 规则校验 | 合法性 + 驳回重决策 | `life/rules.mjs` |
| L10 反应器 | 意图 → 世界改变 | `life/host.mjs` |
| L11 记忆 | 情景 + 习惯 | `life/memory.mjs` |
| L12 思考层 | 事件门控、按需接 LLM | `life/loop-real.mjs` |
| L13 自我维持 | 存续账本 + 不可逆降级 | `life/viability.mjs` |

L8（行为状态 + 承诺期）尚未实现；当前行为粒度是单个动作。

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
node --test life/life.test.mjs life/host.test.mjs life/s4-predictor.test.mjs life/s4-integration.test.mjs
node life/run.mjs --report     # 四条件消融矩阵
node life/run.mjs --sweep      # 多 seed 复核
node life/run.mjs --viab       # 受损速度
node life/run.mjs --recover    # 恢复动力学
node life/run.mjs --metab      # 代谢与进食实测账
node life/seed-gen.mjs 600 seed-run   # 重新生成演示种子存档（离线实跑，固定 seed）
node serve.mjs                 # 本地 demo
```

套件必须逐个点名文件；`node --test life/` 不给文件名在部分 Node 版本下不通。

## 部署

`Dockerfile` 面向魔搭创空间：监听 `0.0.0.0:7860`，世界状态落在 `DATA_DIR`（容器内 `/data`）。镜像只包含 `serve.mjs`、`life/`、`web/`、`seed/` 四样；密钥走平台密文变量。

世界状态必须在服务端持久化：放在浏览器里关标签页即重置，免费创空间休眠也会丢——两者都会直接否证「内部状态持续存在」这一主张。

**固定历史起点**：免费创空间实测无跨容器重建持久卷（重新部署即清空 `/data`）。因此镜像内置 `seed/world.json`——一份由 `seed-gen.mjs` 离线实跑 600 刻产生的存档（seed=7，含不可逆损失与关系历史）。启动时 `/data` 有存档优先续跑（休眠补时），没有则载入种子：平台重置变成「回到同一个可复现的历史起点」，而非一个空白世界。种子是实跑产物，不是编造历史；载入种子不做休眠补时。

## 仓库边界

内部实验记录、台账、赛事工作底稿与手记活稿不在本仓库（见 `.gitignore`）。研究全文与创作手记另行发布。根目录的日志、截图与 dump 均为临时产物，不入库。

## License

Apache-2.0，见 [LICENSE](./LICENSE)。