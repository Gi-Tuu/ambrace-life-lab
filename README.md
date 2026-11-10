# AMBRACE Life Lab

一个持续运行的微型生活世界。AI 居民拥有可量化的内部状态、持久记忆与自主行为；玩家是世界的参与者，不是控制中心。离开后再进入，世界已经自己往前走了一段。

参赛作品：AI+∞ 开发者创作大赛 第三期「AI 造游戏」。

**版本 `0.1.0`** · 变更记录见 [CHANGELOG.md](./CHANGELOG.md) · **每条结论怎么自己验**见 [EVIDENCE.md](./EVIDENCE.md) · 参与/复现约定见 [CONTRIBUTING.md](./CONTRIBUTING.md)

## 它不是什么

不是对话式 NPC。角色的行为由内部状态驱动，经规则层校验合法性后实际改变世界状态；切断某条内部通道后行为分布随之变化，且该变化可复现、可对照。每条判据都配负向对照——不能变红的闸门不算闸门。

## 架构分层

| 层 | 职责 | 模块 |
|---|---|---|
| L0 时钟 | 昼夜节律 | `life/clock.mjs` |
| L1 载体 | 位置、身体、库存、秘密 | `life/body.mjs` |
| L2 感受器 | 感知筛选 + 逐维精度 π | `life/body.mjs`（`perceptsAt` 筛选）+ `life/s4-predictor.mjs`（残差→精度→权重） |
| L3 反射弧 | 快速反应（3 条硬编码反射，先过规则层） | `life/agent.mjs` |
| L4 调制 | 调制量积分（衰减 / 交叉 / 注入 / 噪声） | `life/modulators.mjs` |
| L5 需求 | 内稳态与操作点 | `life/drives.mjs` |
| L6 认知评价 | 相关 / 意外 / 可控 / 规范 | `life/appraisal.mjs` |
| L7 动机 | 逐动作归因（`scoreAll` 的逐项 `parts`） | `life/model.mjs` |
| L8 行为状态 | 目标承诺期（可选层，默认关） | `life/m3-planner.mjs` |
| 耦合调制权 | 变聋 / 离场 / 拒绝互动（可选层，默认关） | `life/coupling.mjs` |
| L9 规则校验 | 合法性 + 驳回重决策（唯一裁决点） | `life/rules.mjs` |
| L10 反应器（效应器） | 意图 → 世界改变 | `life/body.mjs` 的 `actuate`（**不是** `host.mjs`） |
| — 世界宿主 | 持久化 / tick 调度 / 玩家面 / 载荷 | `life/host.mjs`（含线上思考层 `modelBrain`）+ `serve.mjs`（HTTP） |
| L11 记忆 | 情景记忆 + 习惯表 | `life/memory.mjs`（情景）+ `life/model.mjs` 的 `makeHabit`（习惯） |
| L12 思考层 | 事件门控、按需接 LLM | 线上：`life/host.mjs` 的 `modelBrain` + `life/agent.mjs` 的 `choose`；离线实验：`life/loop-real.mjs`（**CLI 脚本，服务端不加载**） |
| L13 自我维持 | 存续账本 + 不可逆降级 | `life/viability.mjs` |

> **未接线模块**（读代码时请注意）：`life/capability.mjs`、`life/pack.mjs`、`life/scene.mjs` 只被各自测试引用，
> 运行路径不加载，镜像里也不含 `packs/`。它们是"换题材时形状该长什么样"的设计物，不是可用扩展点。
> `life/metrics.mjs` 是离线度量库（`run.mjs` 调用），不属于在线动机层。
> 模块头部的 `Lx` 编号沿用的是 README 插入 L3 反射弧之前的旧编号，比本表小一档。

**世界预设**：`lab`（4 房间，全部研究读数与五份面用它）与 `town`（演示用：8 房间、物件、天气、工作/换粮/接济/结伴、群体规范、自然语言台词）。离线 `simulate` 默认 `lab`；`serve` 演示默认 `town`；预设随存档走。美术资源接入时按 `rooms/grid/things` 数据挂图，不改逻辑。

**语言层的边界**：NPC 的话是**状态条件化的确定性模板**；玩家的话走**关键词意图分类**（问候/讨食/警告/指责/道歉/分享，其余按中立），**不是语义理解**——交付文案按这个口径写。

L8 与耦合调制权是两层**可选层**：机制侧默认关（`channelMask` 不传），关掉时不消费额外随机数、不写状态，轨迹与没有这两层时逐位相同。
离线实验用 `channelMask` 打开它们并单独计量；演示页上的 `M3 承诺期 / M4 耦合调制` 两个开关只是同一件事的入口，且只叠加在 A 侧（B 侧是切断承重通道的负向对照，把内部状态接回决策就不再是对照）。

## 项目结构

```
.
├─ serve.mjs              # HTTP 入口：静态资源 + /world /act /ctl /healthz + 写路由守卫
├─ life/                  # 引擎（L0–L13）+ 全部闸门测试 + 离线复现脚本
│  ├─ host.mjs            #   世界宿主：持久化 / tick 调度 / 载荷 / 线上思考层
│  ├─ body.mjs            #   载体 + 效应器(actuate) + 感知筛选
│  ├─ agent.mjs / model.mjs / rules.mjs   # 反射 / 动机 / 规则校验(唯一裁决点)
│  ├─ clock.mjs / drives.mjs / appraisal.mjs / memory.mjs / viability.mjs …
│  ├─ m3-planner.mjs / coupling.mjs       # 可选层（默认关）
│  ├─ *.test.mjs          #   42 个测试文件（闸门，含负向对照）
│  └─ run.mjs / seed-gen.mjs / *-battery.mjs   # 离线复现 / 种子生成 / 变异电池
├─ web/                   # 前端：零依赖 canvas，纯表现层（不写世界状态）
│  ├─ index.html          #   HUD / 双世界对照面板 / 实验开关
│  ├─ app.js              #   渲染器：连续大地图 / 8 室内 / 镜头 / 特效 / WASD+点击控制
│  ├─ walk.mjs            #   A* 寻路内核（纯函数，可单测）
│  ├─ pixel-editor.html   #   本地手工像素工作台（配合 scripts/pixel-overrides.mjs）
│  └─ assets/             #   生成的像素资产 + palette.json + manifest + OFL 字体
├─ scripts/               # 资产生成 / 打包 / 静态检查 / 测试 runner
│  ├─ gen-pixel-assets.mjs / gen-actions.mjs / pack-assets.mjs
│  ├─ editor-catalog.mjs / pixel-overrides.mjs
│  └─ check.mjs / test.mjs
├─ seed/world.json        # 固定历史起点（seed=7 实跑 600 刻存档）
├─ evidence/              # 研究读数留底（随仓库发布，复现见 EVIDENCE.md）
├─ Dockerfile             # 魔搭创空间镜像（只含 serve/life/web/seed）
└─ package.json           # 零第三方依赖；scripts = lint/test/check/coverage/assets/serve
```

美术资产全部由 `scripts/` 代码定义生成（`npm run assets` 一键可复现），色板锁 `web/assets/palette.json`；
前端只读 `/world` 载荷做表现，动画不读 `w.t`、不消费 rng、不写世界状态，故不污染研究读数。
内部台账 / 交接稿在 `docs/`（`.gitignore`，不入库）。

## 快速开始

需要 Node **22+**，零第三方依赖（不需要 `npm install`，没有 lock 文件）。

```bash
node serve.mjs          # http://localhost:7860
```

未配置模型端点时世界自动退回本地确定性替身，照常运行。接入真实模型：

```bash
cp .env.example .env               # 然后填 MODEL_PROVIDERS / MODEL_KEYS / MODEL_NAME
node --env-file=.env serve.mjs
```

环境变量的完整清单（含每个开关的"不设＝什么行为"）见 [`.env.example`](./.env.example)。

```
MODEL_PROVIDERS=  # 供应商端点，逗号分隔可配多个，按序退回（兼容旧名 MODEL_BASE_URL）
MODEL_KEYS=       # 与端点按位对应的密钥（兼容旧名 MODEL_KEY）
MODEL_NAME=       # 单供应商模型 id；多供应商用 MODEL_NAMES 按位对应
MAX_CALLS=        # 每日调用预算闸门（跨天归零）
BRAIN=            # local（默认，0 成本）| model
TICK_MS=          # 每拍间隔，毫秒
PRESENCE_MS=      # 无人观看多久后停调真模型。**单位是毫秒**：60 秒要写 60000
CTL_TOKEN=        # 公开部署必设，否则任何脚本一条 JSON 就能重置世界（见 SECURITY.md）
CHAT_TOKEN=       # 不设时 /chat 转发整体关闭（默认）
WORK_CAP=         # 工坊每日收工次数；不设＝无上限＝默认行为逐位不变
MAX_CALLS_PER_TICK= # 单拍模型调用上限；0＝不设上限（默认）
```

密钥只留在服务端进程，不进前端、不进镜像、不进仓库。

## 判据与复现

```bash
npm run lint      # 静态检查：语法 176 文件 + import 图 + JSON + 引擎纪律 + 测试纪律
npm test          # 42 个测试文件 / 313 条断言（发现式点名，不会漏文件）
npm run coverage  # 同上 + Node 内建覆盖率（行 95.3% / 分支 87.6% / 函数 93.6%，43 个被加载模块）
npm run check     # lint + test
```

研究读数（五份面随仓库发布在 `evidence/`，md5 与复现方法见 [`EVIDENCE.md`](./EVIDENCE.md)）：

```bash
node life/run.mjs --report     # 四条件消融矩阵
node life/run.mjs --sweep      # 多 seed 复核（打印实际跑了几档）
node life/run.mjs --viab       # 受损速度
node life/run.mjs --recover    # 恢复动力学：机械侧 + 观察侧
node life/run.mjs --metab      # 代谢与进食实测账
node life/o18-heldout.mjs      # 事前特征、时间留出、传话切断对照
```

闸门有效性（"不能变红的闸门不算闸门"的机械证明；每条都要求未变异对照先全绿、锚点唯一命中、变异必须打红指定闸门）：

```bash
node life/o1o9-mutation-battery.mjs   # 13 条
node life/m6p-mutation-battery.mjs    # 4 条
node life/m6lp-mutation-battery.mjs   # 4 条
node life/m4-mutation-battery.mjs     # 7 条
```

**口径限制（必须一起读，否则会把弱证据当强证据）**：

- `--report` 默认**不是**同随机流对照（`condition` 与 `channelMask` 会一起哈希进角色种子）。
  要归因到通道，请加 `--paired`：两臂共用同一种子与同一条 rng 起点，只让通道不同。实测（seed=7, 400 刻）
  C2 vs C2-neg 为 KL 0.6032 vs 0、主动发起 975 vs 573、驳回 84 vs 42——这条差异可以归因。
  另外配对后 C0 / C1 / C2-neg 三行逐位相同（`channelsFor` 只区分 `'C2'` 与"其他"），
  所以四条件矩阵实际是"C2 对三个同一张表的对照"。留底：`evidence/report-paired.log`。
- 旧 P3 覆盖使用终局位置、事后需求与样本内标签择优，仅保留历史对照，不代表可执行规则的留出预测率。
- 越轨份量是世界明示的营养当量；预期份量只影响越轨能量评分，支持独立切断，并非已学会后果或完整风险权衡。
- `--viab` 的"饥馑"档只在头 55 刻真是饥馑（`simulate` 每 55 刻无条件补粮 +2），输出已带披露行。

## 反馈

- **缺陷 / 复现问题**：通过部署所在平台的作品页留言，或直接联系作者（见仓库根 `LICENSE` 的版权人）。
- **安全相关问题**：按 [SECURITY.md](./SECURITY.md) 的方式私下报告，不要开公开 issue 写利用细节。
- 单人项目，没有工单委员会与值班表；能保证的是：坏了会修、修了会配一条能变红的闸门。

## 部署

`Dockerfile` 面向魔搭创空间：监听 `0.0.0.0:7860`，世界状态落在 `DATA_DIR`（容器内 `/data`）。镜像只包含 `serve.mjs`、`life/`、`web/`、`seed/` 四样；密钥走平台密文变量。

世界状态必须在服务端持久化：放在浏览器里关标签页即重置，免费创空间休眠也会丢——两者都会直接否证「内部状态持续存在」这一主张。

**固定历史起点**：免费创空间实测无跨容器重建持久卷（重新部署即清空 `/data`）。因此镜像内置 `seed/world.json`——一份由 `seed-gen.mjs` 离线实跑 600 刻产生的存档（seed=7，含不可逆损失与关系历史）。启动时 `/data` 有存档优先续跑（休眠补时），没有则载入种子：平台重置变成「回到同一个可复现的历史起点」，而非一个空白世界。种子是实跑产物，不是编造历史；载入种子不做休眠补时。

**运行时后端**：种子历史由离线确定性替身产生；启动后的实时决策后端由 `BRAIN` 环境变量显式开关（`model` = 接所配置的真实模型，默认 `local` 替身，防止无预算时意外调用）。公开部署设 `BRAIN=model`，端点为魔搭 API-Inference（失败按配置顺序退到第三方），每供应商可配各自模型 id（`MODEL_NAMES` 按位对应 `MODEL_PROVIDERS`）。

**成本策略**（公开实例）：`MAX_CALLS` 是**每日**额度，跨天归零；只有最近有人在访问（`/world` 等应用路径，`PRESENCE_MS` 内）才允许调用真模型，无人观看时走替身。依据是 1 魔粒≈2 次旗舰调用、签到约 250 魔粒/天。**因此公开实例的行为依赖"当前有没有观众"，它只作为演示，不作为实验读数来源**——实验一律用离线固定条件复现。

## 仓库边界

内部实验记录、台账、赛事工作底稿与手记活稿不在本仓库（见 `.gitignore`）。研究全文与创作手记另行发布。根目录的日志、截图与 dump 均为临时产物，不入库。

**外部基线**：部分 M5 训练/校准脚本需要本机基线目录 `D:/Codex-Projects/output/` 下的历史日志，仓库内不保证独立复现；M3 第一候选的停止证明日志与 M5 缩放的原始日志未随仓库发布（结论保留在台账 §1 行内）。

## License

Apache-2.0，见 [LICENSE](./LICENSE)。