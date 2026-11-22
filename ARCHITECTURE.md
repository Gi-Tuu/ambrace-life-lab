# 架构与接手说明

写给 **clone 之后、不依赖 `docs/` 也能接手** 的人。`docs/` 默认被忽略，但索引、手记及部分历史回报已入库，以 `git ls-files docs` 为准。本文核对 main `709f02b`；包版本仍为 `1.6.0`，下述历史拆分行数不代表当前行数。

## 一句话

服务端权威的微型生活世界：`serve.mjs` 只做 HTTP；`life/` 是引擎；`host` 负责时间、持久化与 A/B 对照；`survplay` 负责生存单世界与玩家动作。浏览器只读 `/world` 载荷做表现，不写世界状态。

## 模块边界（从入口往里看）

```
serve.mjs                  HTTP：静态资源 / /world /act /ctl /healthz / 写入守卫
  └─ life/host.mjs         facade + 状态单例 + HTTP 面（snapshot/act/ctl）
       ├─ life/host-world.mjs    世界创建/装载、tick 串行链、定时器、离线补时、存档、营地生命周期
       ├─ life/host-model.mjs    模型配置、预算/车道入口、审议提示词、modelBrain/modelTalk
       ├─ life/host-replay.mjs   A/B 对照、回放帧、comparison.json 落盘与只读回放
       ├─ life/host-budget.mjs   预算/熔断/车道纯函数与域对象
       ├─ life/host-saves.mjs    写队列、合并窗口、原子写/备份/隔离
       ├─ life/host-viewers.mjs  在场窗口（观众打点）
       └─ life/survplay.mjs      生存世界：create/tick/view/生命周期
            ├─ life/survplay-actions.mjs  玩家时间/体力成本、busy 跨刻、失败回滚与账本
            ├─ life/survplay-camp.mjs     营地/聚落动作入口（camp_*、住房、设施、建造、家庭、合作）
            └─ life/survplay-save.mjs     dump/load、旧档迁移、deaths 封顶
```

### `host.mjs` 为什么拆

拆前 1747 行，主路径上混了五件事：世界推进、模型调用、A/B 回放、HTTP 请求整形、存档。拆后：

| 文件 | 行数（2026-11-21，v1.6.0） | 职责 | 不做什么 |
|---|---:|---|---|
| `host.mjs` | ~646 | 组合根、`S`/`CFG` 单例、`snapshot/act/ctl` 请求整形、原导出 facade | 不直接推进世界、不拼提示词 |
| `host-world.mjs` | ~1073 | 世界创建/装载、tick、定时器、补时、存档、营地 | 不决定 HTTP 返回形状 |
| `host-model.mjs` | ~284 | 预算域、车道、提示词、`modelBrain/modelTalk` | 不持有第二份 `S` |
| `host-replay.mjs` | ~408 | 对照分支、回放帧、`comparison.json` | 不复制世界 |

`S`/`CFG` 仍只有一份，由 `host.mjs` 创建后以引用传给三个域；域模块返回工厂（`createHostWorld` / `createModelDomain` / `createReplayDomain`），不各自建单例。`model`/`replay` 用惰性 getter 注入，避免启动顺序与循环依赖。tick 串行链、异步存档、错误字段语义原样保留。

### `survplay.mjs` 为什么拆

拆前 1342 行。拆后 `survplay.mjs` 只留 `createSurvPlay`、`tickSurvPlay`、`survView`、生命/繁衍，约 870 行；动作、营地入口、存档各自成模块，死亡收尸与幽魂状态在 `life/death.mjs`。依赖方向是单向的：

```
survplay.mjs ──> survplay-actions.mjs ──> survplay-camp.mjs
     └────────> survplay-save.mjs（createSurvPlay/newChild 由 survplay 注入）
```

`survplay-camp.mjs` 不 import `survplay-actions.mjs`，所以不会循环；`survplay-save.mjs` 通过参数拿 `createSurvPlay`，也不反向 import 主模块。

## 关键流程

### tick

`host-world.advanceWorlds` → `tickBody`：
1. A/B 研究世界（`GAME_MODE=game` 且无对照观众时跳过）；
2. 生存主世界 + 常驻名字营地各走一拍（`tickSurvPlay`）；
3. 每 `SAVE_EVERY` 刻排一次异步存档（不 await 磁盘；`flushWrites/start/stop` 收口）。

tick/控制与营地切换等走 `queueWorldWrite`：定时器忙则跳过本拍，显式 `ctl step/tickOnce` 排队。普通动作另走 `queueAct`，不排在长 tick/模型等待后；自由对话分准备、模型等待、提交，等待不占动作队列。`/import` 直接调用 `importCampExport` 写盘，不经过这两条队列；不能宣称所有写入全局串行。

### 玩家动作

`/act {mode:'survival'}` → `host.act` → `actInSurvival` → `survAct`（`survplay-actions`）：
- 先算时间/体力成本（`costFor`，`V72_TIME=0` 时退回每刻 100 点旧预算）；
- 时间不够就 `BUSY_START`，跨刻由 `advancePlayerBusy` 继续；
- 具体动作交给 `survActInner`（`survplay-camp`）走 `validate/validateCamp → actuate/campAction`，规则层是唯一裁决点；
- 失败退时间、成功记账（`action-ledger`），再 `settleSurvival`。

### 数据与存档

- `data/world.json`：城镇 A/B + `survival` 子档；保存时留 `.bak`，坏档 quarantine。
- `data/saves/<32hex>.json.gz`：名字营地 gzip 档；`index.json` + `<key>.owner.json` 侧车；32hex key、TTL 清扫、索引锁。
- 已登记名字营地的非 owner 只能经 `/world` 获取独立白名单访客投影（camp key/名字、day、人口、settlement、最近 3 条事件 kind），无背包/关系/对话/位置明细；不能通过同名接管或操作。
- `/export`、`/import` 是 `SAVE_EXPORT_TOKEN` 控制的名字营地备份入口，默认关闭；包含 gzip 档的 base64、索引及 owner 侧车，不含 MAIN/对照。导入校验 key/解压/档形状，跳过已有 owner 的营地；停服全量归档用 `scripts/archive-saves.mjs`（主档、名字营地、对照及哈希校验）。
- `data/comparison.json`：A/B 对照分支与回放帧，独立于主档。
- 研究五份面：`node life/run.mjs --report|--sweep|--viab|--recover|--metab`，md5 见 [EVIDENCE.md](./EVIDENCE.md)。

## 默认关 / 研究态 / 正式游戏

| 开关 | 默认 | 打开方式 | 边界 |
|---|---|---|---|
| `GAME_MODE` | `research` | `GAME_MODE=game` | research 同时推进旧城镇 A/B；game 只推进生存 |
| `GAME_RULES` | 关 | `GAME_RULES=1` | 只影响 `gameRules` 世界；研究表逐位不变 |
| `BRAIN` | `local` | `BRAIN=model` + 模型 env | 无端点时退替身；无人调用另受 `MODEL_UNATTENDED` 等配置控制；预算/熔断在模型域 |
| M3/M4 | 关 | 仅 A/B 页开关，只叠 A 侧 | 不落盘，重启回关；B 侧保持 C2-neg |
| `M5_ENABLED` | 关 | `M5_ENABLED=1` | 慢仓状态校验失败会拒绝启动（不半载入） |
| 讨论/合作/生态等 | 按生存配置 | `createSurvPlay` 选项 | 研究路径不传这些选项时保持旧轨迹 |

## 已知限制

- **不是通用开放世界**：房间/地点/资源点是有限集合；玩家和居民的动作空间由 `body.mjs`/`rules.mjs` 定义，超出即 `UNKNOWN_KIND`。
- **语言层分路径**：研究预设与快捷话题是确定性模板/关键词分类；正式自由输入由 `resident-dialogue.mjs` 接模型措辞，服务端裁决态度与关系后果，不把模型文本当世界动作；无模型、超时、预算耗尽或熔断退模板。
- **统一长期记忆**：`npc-memory.mjs` 汇合事件/对话/承诺/知识，供正式世界决策与叙事检索，持久化在 `survival.npcMemory`，读档清洗/迁移；旧情景记忆仍保留统计/反思与兼容用途，研究/compare 不启用统一层。它是有界确定性记录，不是无限记忆或通用语义理解。
- **真实模型证据边界**：本地假上游测试验证预算/回退/坏 JSON 等机制，不证明当前线上供应商质量；`BRAIN=model` 需要端点。当前线上 token 配置/轮换、浏览器验收和多人采样未找到当前证据，待核实，不等于确定未做。
- **单机单进程**：`S` 是模块单例；同一 `DATA_DIR` 多进程并发写只做了索引锁与原子写，不是分布式系统。
- **离线补时有界且重启也生效**：MAIN 重启后按 `savedAt` 的真实停机时长、同一 `simClock.rate` 走本地替身补齐；上限 `SURV_CATCHUP_CAP`（默认 120 刻 = 7200 游戏分），超长空档如实标截断，不补决策。研究态/无 `simClock` 的旧路径才按 `TICK_MS` 整拍补：`分钟 × 60000 / TICK_MS` 刻（`TICK_MS` 默认 7500，部署若设 1200 或 360000 会得到不同刻数，口径以实际 env 为准）。
- **性能/内存**：trace 默认封顶 400/角色，日志与 observer 有界；长跑仍建议单独 `DATA_DIR` 并监控 RSS。
- **`scripts/` 下探针**：部分脚本是作者侧实验装置，读历史数据/本机路径，不承诺跨机器复现；以 `npm run check` 与 `evidence/` 为准。
- **五份研究面只在同 Node 大版本、同 seed 下逐位**；换环境属于环境差异，不是否定证据（见 EVIDENCE.md）。

## 提交前自查

```bash
npm run check      # lint + 美术指纹 + 全部测试
node scripts/score-baseline.mjs --ticks 240 --seeds 7,13 --repeats 2   # 作者侧消融/负控
```

新增模块时：保持 `life/` 不 import `web/`；主路径不要把模型/回放/存档重新塞回 `host.mjs`；`S`/`CFG` 不复制第二份；研究态改动必须能指出“关掉开关后逐位相同”的闸门。
