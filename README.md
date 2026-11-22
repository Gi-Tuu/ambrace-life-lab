# AMBRACE Life Lab

一个持续运行的微型生活世界。AI 居民拥有可量化的内部状态、持久记忆与自主行为；玩家是世界的参与者，不是控制中心。离开后再进入，世界已经自己往前走了一段。

参赛作品：AI+∞ 开发者创作大赛 第三期「AI 造游戏」。

**包版本 `1.6.0`**（历史 tag `v1.6.0`；本文核对 main `709f02b`，含 tag 后续改动，不表示新 tag 或已部署）· 5 分钟上手见 [QUICKSTART.md](./QUICKSTART.md) · 模块边界/接手见 [ARCHITECTURE.md](./ARCHITECTURE.md) · 作者侧基准与未验证声明见 [BENCHMARK.md](./BENCHMARK.md) · 变更记录见 [CHANGELOG.md](./CHANGELOG.md) · **每条结论怎么自己验**见 [EVIDENCE.md](./EVIDENCE.md) · 参与/复现约定见 [CONTRIBUTING.md](./CONTRIBUTING.md)

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
| — 世界宿主 | 持久化 / tick 调度 / 玩家面 / 载荷 | `life/host.mjs`（facade + 单例）+ `host-world.mjs`（世界/tick/存档）+ `host-model.mjs`（思考层）+ `host-replay.mjs`（A/B 回放）+ `serve.mjs`（HTTP） |
| L11 记忆 | 情景记忆 + 习惯表 + 正式世界统一长期记忆 | `life/memory.mjs`（情景）+ `life/model.mjs` 的 `makeHabit`（习惯）+ `life/npc-memory.mjs`（事件/对话/承诺/知识） |
| L12 思考层 | 事件门控、按需接 LLM | 线上：`life/host-model.mjs` 的 `modelBrain` + `life/agent.mjs` 的 `choose`；离线实验：`life/loop-real.mjs`（**CLI 脚本，服务端不加载**） |
| L13 自我维持 | 存续账本 + 不可逆降级 | `life/viability.mjs` |

> **未接线模块**（读代码时请注意）：`life/capability.mjs`、`life/pack.mjs`、`life/scene.mjs` 只被各自测试引用，
> 运行路径不加载，镜像里也不含 `packs/`。它们是"换题材时形状该长什么样"的设计物，不是可用扩展点。
> `life/metrics.mjs` 是离线度量库（`run.mjs` 调用），不属于在线动机层。
> 模块头部的 `Lx` 编号沿用的是 README 插入 L3 反射弧之前的旧编号，比本表小一档。

**世界预设**：`lab`（4 房间，全部研究读数与五份面用它）与 `town`（演示用：8 房间、物件、天气、工作/换粮/接济/结伴、群体规范、自然语言台词）。离线 `simulate` 默认 `lab`；`serve` 演示默认 `town`；预设随存档走。美术资源接入时按 `rooms/grid/things` 数据挂图，不改逻辑。

**研究预设的语言层**：NPC 的话是**状态条件化的确定性模板**；玩家的话走**关键词意图分类**（问候/讨食/警告/指责/道歉/分享，其余按中立），**不是语义理解**——交付文案按这个口径写。

**正式自由对话与长期记忆**：`resident-dialogue.mjs` 处理居民自由输入，服务端裁决态度/关系后果，模型只写措辞；不可用时退模板，不把生成文本执行成世界动作。`npc-memory.mjs` 统一事件、对话、承诺、知识，供正式世界叙事与决策检索，随 `survival.npcMemory` 存档并清洗/迁移；研究/compare 不启用统一层，旧情景记忆仍保留统计/反思与兼容用途。

L8 与耦合调制权是两层**可选层**：机制侧默认关（`channelMask` 不传），关掉时不消费额外随机数、不写状态，轨迹与没有这两层时逐位相同。
离线实验用 `channelMask` 打开它们并单独计量；演示页上的 `M3 承诺期 / M4 耦合调制` 两个开关只是同一件事的入口，且只叠加在 A 侧（B 侧是切断承重通道的负向对照，把内部状态接回决策就不再是对照）。

## 项目结构

```
.
├─ serve.mjs              # HTTP 入口：静态资源 + /world /act /ctl /healthz + 写路由守卫
├─ life/                  # 引擎（L0–L13）+ 全部闸门测试 + 离线复现脚本
│  ├─ host.mjs            #   世界宿主 facade：状态单例 + snapshot/act/ctl + 原导出
│  ├─ host-world.mjs      #   世界创建/装载、tick 串行链、定时器、补时、存档、营地
│  ├─ host-model.mjs      #   模型配置/预算车道/审议提示词/modelBrain/modelTalk
│  ├─ host-replay.mjs     #   A/B 对照、回放帧、comparison.json
│  ├─ body.mjs            #   载体 + 效应器(actuate) + 感知筛选
│  ├─ agent.mjs / model.mjs / rules.mjs   # 反射 / 动机 / 规则校验(唯一裁决点)
│  ├─ clock.mjs / drives.mjs / appraisal.mjs / memory.mjs / viability.mjs …
│  ├─ m3-planner.mjs / coupling.mjs       # 可选层（默认关）
│  ├─ worldstate.mjs / production.mjs / geometry.mjs   # 生存 Phase A/B（有限资源 + 建设闭环）
│  ├─ cooperation.mjs                     # Phase C AI 合作（意愿/公共需求/分解/重规划，默认关）
│  ├─ survplay.mjs                        # Phase D 生存单世界：create/tick/view/生命周期
│  ├─ survplay-actions.mjs                #   玩家时间/体力/busy/失败回滚与账本
│  ├─ survplay-camp.mjs                   #   营地/住房/设施/建造/家庭/合作动作入口
│  ├─ survplay-save.mjs                   #   生存档 dump/load 与旧档迁移
│  ├─ ecology.mjs / households.mjs        # 生存 V2：轻量生态种群、家庭与生命周期（事件判定按版本派生）
│  ├─ resident-dialogue.mjs               # 正式自由对话：服务端定态度/关系后果，模型只写措辞
│  ├─ npc-memory.mjs                      # 统一长期记忆：事件/对话/承诺/知识，检索与存档迁移
│  ├─ home-roads.mjs / camp-animals.mjs   # 生存 V2：道路铺设、动物行为与蓄养
│  ├─ *.test.mjs          #   233 个测试文件（闸门，含负向对照）
│  └─ run.mjs / seed-gen.mjs / *-battery.mjs   # 离线复现 / 种子生成 / 变异电池
├─ shared/                # 服务端与浏览器共用的纯数据/几何（无 DOM/Node 副作用，22 个模块）
│  ├─ camp-layout.mjs / layout-version.mjs     # 营地布局与版本（单一来源）
│  ├─ camp-scene.mjs / camp-geometry.mjs       # 几何与场景定义（浏览器只负责渲染）
│  └─ camp-construction-access.mjs …           # 规则/物理/物品纯函数
├─ web/                   # 前端：零依赖 canvas，纯表现层（不写世界状态）
│  ├─ index.html          #   HUD / 双世界对照面板 / 实验开关
│  ├─ app.js              #   3D WebGL 渲染入口：世界构建 / 8 室内 / 镜头 / 特效 / WASD+点击控制（无 2D 视图）
│  ├─ walk.mjs            #   A* 寻路内核（纯函数，可单测）
│  ├─ camp-lighting.mjs / camp-sun.mjs   # 受光与日照（接触阴影，纯表现）
│  ├─ audio.mjs           #   音频引擎：状态驱动 SFX / 环境声；BGM 来源见 web/music/CREDITS.md
│  └─ assets/             #   16 张地形 tile + 4 张 HUD 头像 + palette.json + OFL 字体（指纹在根目录 art-hashes.json）
├─ tools/pixel-editor/    # 开发工具：像素工作台 + 覆盖稿/碰撞稿/素材目录（不进镜像，不在 /web/ 下）
├─ scripts/               # 头像生成 / 静态检查 / 测试 runner / 作者侧探针
│  ├─ gen-actions.mjs         #   4 张 HUD 头像 + actions/manifest.json（npm run actions）
│  ├─ editor-catalog.mjs / pixel-overrides.mjs   # 本地像素工作台用（不在运行时）
│  └─ check.mjs / test.mjs
├─ seed/world.json        # 固定历史起点（seed=7 实跑 600 刻存档）
├─ evidence/              # 研究读数留底（随仓库发布，复现见 EVIDENCE.md）
├─ Dockerfile             # 魔搭创空间镜像（含 serve/life/web/shared/seed）
└─ package.json           # 零第三方依赖；scripts = lint/test/coverage/check/art/art:check/actions/research:md5/smoke:online/serve
```

美术只保留 **20 张 PNG**：16 张地形 tile（3D 地面 `regionAtlas` 的唯一来源）与 4 张 HUD 头像（`npm run actions` 可重生成，应用 `pixel-overrides` 手改），色板锁 `web/assets/palette.json`，20 张全部由 `art-hashes.json` 钉 sha256。旧的 2D 资产管线（`gen-pixel-assets.mjs` / `pack-assets.mjs` / `npm run assets`）已随 2D 视口在 1.5 前删除，仓库里不再有能重画整批 2D 素材的生成器。
前端只读 `/world` 载荷做表现，动画不读 `w.t`、不消费 rng、不写世界状态，故不污染研究读数。
内部台账 / 交接稿大部分在 `docs/`（默认被 `.gitignore` 忽略）；现行文档（创作手记 v2、参赛评分冲刺、像素工作台说明、索引、文档状态）及部分历史回报已显式入库。历史记录保留当时口径，是否发布以 `git ls-files docs` 为准。**不读 `docs/` 也能接手**：公开的模块边界、默认开关、存档位置与已知限制见根目录 [ARCHITECTURE.md](./ARCHITECTURE.md)；5 分钟真实路径见 [QUICKSTART.md](./QUICKSTART.md)。

## 快速开始

需要 Node **22+**，零第三方依赖（不需要 `npm install`，没有 lock 文件）。**3 条命令 + 5 分钟真实路径（起服、进游戏、走/采集/吃/睡、HUD、死亡后世界继续）见 [QUICKSTART.md](./QUICKSTART.md)**；下面是开发者最短路径。

```bash
node serve.mjs          # http://localhost:7860
```

启动生存试玩时可设 `GAME_MODE=game`，服务器持续推进生存世界。游戏界面的生存 A/B 仅在有对照观众时自动推进，也可独立暂停或单步。`GAME_MODE=research`（默认）还会持续推进兼容接口的旧城镇研究预设。生存玩法为无尽经营，个人死亡后可继续观察世界。关闭页面或未操作时，已运行的服务器照常推进；服务暂停只接受显式单步或补时。重新加载存档时，离线补时默认最多 120 刻并走本地决策。床铺睡眠是玩家主动操作，和离线补时分别处理。

生存世界使用一份共享存档，多位玩家访问同一服务时会互相影响。将 `DATA_DIR` 放在持久卷上可以跨容器恢复。没有持久卷的平台只能在容器存续期间保存进度。

玩家在有权限的名字营地选择「新开一局」时，以新地图替换这份同名档。主营地进度独立。名字/key 仅定位，`camp_owner` cookie 才是归属凭据；已登记营地的非 owner 只能读 `/world` 白名单投影（名字、day、人口、settlement、最近 3 条事件 kind），不能同名接管或写入。

游戏内的「研究对照 A/B」从同一份生存快照复制两条独立分支，沿用相同的地图、玩法、裁决和居民初始随机状态。两侧都用本地决策，B 切断登记的状态通道。在 A 侧操作，两侧分别裁决。点击「重跑对照」回到本轮起点，或点击「用当前生存快照」从当前选中的营地另起一轮。对照进度单独存于 `DATA_DIR/comparison.json`，主营地继续使用 `DATA_DIR/world.json`，名字营地使用 `DATA_DIR/saves/<32hex>.json.gz`，另有索引与 owner 侧车。`/export`、`/import` 为独立 `SAVE_EXPORT_TOKEN` 控制的名字营地备份入口（默认关闭，不含 MAIN/对照，导入跳过已有 owner 的营地；安全边界见 SECURITY.md）。停服后运行 `scripts/archive-saves.mjs` 可归档这三种存档，恢复前逐项校验哈希。

未配置模型端点时世界自动退回本地确定性替身，照常运行。接入真实模型：

```bash
cp .env.example .env               # 然后填 MODEL_PROVIDERS / MODEL_KEYS / MODEL_NAME
node --env-file=.env serve.mjs
# 注意：GAME_RULES（游戏态规则层）只写在镜像 ENV 里。本地默认关，想复现线上手感用
#   GAME_RULES=1 node serve.mjs   或把它写进 .env 再 --env-file 启动。
```

环境变量的完整清单（含每个开关的"不设＝什么行为"）见 [`.env.example`](./.env.example)。

```
MODEL_PROVIDERS=  # 供应商端点，逗号分隔可配多个，按序退回（兼容旧名 MODEL_BASE_URL）
MODEL_KEYS=       # 与端点按位对应的密钥（兼容旧名 MODEL_KEY）
MODEL_NAME=       # 单供应商模型 id；多供应商用 MODEL_NAMES 按位对应
MAX_CALLS=        # 每日调用预算闸门（跨天归零）
GAME_MODE=        # research（默认）| game（有对照观众时才推进 A/B）
SURV_CATCHUP_CAP= # 生存离线补时上限，默认 120 刻
BRAIN=            # local（默认，0 成本）| model
GAME_MS_PER_MINUTE= # 正式节奏：1 游戏分钟的真实毫秒，默认 6000（现实 1 分 = 10 游戏分，1 天 = 144 现实分钟）
TICK_MS=          # 研究态/非连续旧路径的整拍间隔；正式连续世界不读它（部署游戏态可设 360000 对齐 60 分/刻）
PRESENCE_MS=      # 观众在场窗口（毫秒，60 秒写 60000）；无人调用另受 MODEL_UNATTENDED 等配置控制
CTL_TOKEN=        # 建议公开部署配置；未设走会话 nonce，MAIN 重开另有例外（见 SECURITY.md）
CHAT_TOKEN=       # 不设时 /chat 转发整体关闭（默认）
WORK_CAP=         # 工坊每日收工次数；不设＝无上限＝默认行为逐位不变
MAX_CALLS_PER_TICK= # 单拍模型调用上限；0＝不设上限（默认）
```

密钥只留在服务端进程，不进前端、不进镜像、不进仓库。

## 判据与复现

```bash
npm run lint      # 静态检查：语法 + import 图 + JSON + 引擎纪律 + 测试纪律
npm test          # 233 个测试文件 / 1309 条检查（发现式点名 life/*.test.mjs，不会漏文件；2026-11-22 全绿口径）
npm run coverage  # 同上 + Node 内建覆盖率（2026-11-21 实跑：行 90.58% / 分支 85.84% / 函数 89.62%；插桩下 1258/1261，2–3 条时序/环境用例红，**非全绿**，见 EVIDENCE.md §四）
node scripts/test-ids.mjs # 判据编号盘点：1305 条 test/describe/it 标题 · 1028 条带 ID · 1028 个唯一 ID · 0 重复（重复即 exit 1，已钉进 npm run check 第 9 项）
npm run art       # 重钉美术指纹：对 web/assets 每张 PNG 取 sha256 写入 art-hashes.json（改图后必须显式跑）
npm run art:check # 校验美术指纹：任何一张与留底不一致即 exit 1
npm run check     # lint + art:check + test
npm run smoke:online # 线上冒烟：只读检查 + 写路径拒绝检查（SMOKE_URL / SMOKE_COOKIE / SMOKE_TOKEN）
```

本次口径依据本地日志 `docs/battery-harness-check-20261122.log`（未随仓库发布，可运行上述命令复核）：233 个测试文件、1309/1309 检查通过。ID 按标题开头的**完整记号**统计：1028 个唯一 ID；复合号不拆分，0 重复不表示拆号后无歧义。历史覆盖率与研究读数保留原日期，不以本地测试证明线上状态。当前线上 token 配置/轮换、浏览器验收及多人采样尚未找到当前证据，均待核实。

**为什么美术也要指纹**：研究面早有"五份面 md5"钉死，但素材没有指纹时，"改图"只能靠肉眼发现——重生成、覆盖稿、别人提交一张图都可能在无人察觉时改变游戏外观。`art:check` 把外观也纳入"改了就必须在提交里承认"的纪律（与五份面同源思路）。哈希对 PNG 字节取，Node 大版本升级可能改变压缩输出（像素相同、字节不同）⇒ 那时 `--check` 会红，逼你显式重钉并在 CHANGELOG 说明"只是压缩器变了"。

研究读数（五份面随仓库发布在 `evidence/`，md5 与复现方法见 [`EVIDENCE.md`](./EVIDENCE.md)）：

```bash
node life/run.mjs --report     # 四条件消融矩阵
node life/run.mjs --sweep      # 多 seed 复核（打印实际跑了几档）
node life/run.mjs --viab       # 受损速度
node life/run.mjs --recover    # 恢复动力学：机械侧 + 观察侧
node life/run.mjs --metab      # 代谢与进食实测账
node life/o18-heldout.mjs      # 事前特征、时间留出、传话切断对照
```

闸门有效性（"不能变红的闸门不算闸门"的机械证明；要求未变异对照全绿、锚点符合各脚本匹配规则、变异打红指定闸门）：

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

`Dockerfile` 面向魔搭创空间：监听 `0.0.0.0:7860`，世界状态落在 `DATA_DIR`（容器内 `/data`）。镜像包含 `serve.mjs`、`life/`、`web/`、`shared/`、`seed/` 五样；密钥走平台密文变量。

世界状态必须在服务端持久化：放在浏览器里关标签页即重置，免费创空间休眠也会丢——两者都会直接否证「内部状态持续存在」这一主张。

**固定历史起点**：免费创空间实测无跨容器重建持久卷（重新部署即清空 `/data`）。因此镜像内置 `seed/world.json`——一份由 `seed-gen.mjs` 离线实跑 600 刻产生的存档（seed=7，含不可逆损失与关系历史）。启动时 `/data` 有存档优先续跑（休眠补时），没有则载入种子：平台重置变成「回到同一个可复现的历史起点」，而非一个空白世界。种子是实跑产物，不是编造历史；载入种子不做休眠补时。

**运行时后端**：种子历史由离线确定性替身产生；启动后的实时决策后端由 `BRAIN` 环境变量显式开关（`model` = 接所配置的真实模型，默认 `local` 替身）。供应商及回退顺序由配置决定，`MODEL_NAMES` 按位对应 `MODEL_PROVIDERS`；当前线上 provider、模型及开关待核实，不从仓库推定。

**成本策略**（代码机制）：`MAX_CALLS` 是**每日**额度，跨天归零；模型调用还受在场窗口、车道预算与熔断限制；无人时是否允许调用还取决于 `MODEL_UNATTENDED` 等配置，不是无观众就一律退替身。当前线上额度与策略待核实。历史预算估算为 1 魔粒≈2 次旗舰调用、签到约 250 魔粒/天，不作为当前价格或配额承诺。公开实例只作演示，实验用离线固定条件复现。

## 仓库边界

`docs/` 默认被 `.gitignore` 忽略，但已有索引、手记、工作底稿及部分历史回报被显式纳入版本控制；是否入库以 `git ls-files docs` 为准，不能把内部记录一概视为未公开。研究全文与创作手记另行发布；临时日志、截图与 dump 通常不入库。

**外部基线**：部分 M5 训练/校准脚本需要本机基线目录 `D:/Codex-Projects/output/` 下的历史日志，仓库内不保证独立复现；M3 第一候选的停止证明日志与 M5 缩放的原始日志未随仓库发布（结论保留在台账 §1 行内）。

## License

Apache-2.0，见 [LICENSE](./LICENSE)。