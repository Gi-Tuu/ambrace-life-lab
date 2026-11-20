# 架构与接手说明

写给 **clone 之后、不想依赖 `docs/`（被 `.gitignore` 挡在库外）也能接手** 的人。`docs/` 里的实验台账/赛事底稿不入库；这里与根目录文档是公开可读的边界。

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

| 文件 | 行数（2026-11-18） | 职责 | 不做什么 |
|---|---:|---|---|
| `host.mjs` | ~460 | 组合根、`S`/`CFG` 单例、`snapshot/act/ctl` 请求整形、原导出 facade | 不直接推进世界、不拼提示词 |
| `host-world.mjs` | ~890 | 世界创建/装载、tick、定时器、补时、存档、营地 | 不决定 HTTP 返回形状 |
| `host-model.mjs` | ~220 | 预算域、车道、提示词、`modelBrain/modelTalk` | 不持有第二份 `S` |
| `host-replay.mjs` | ~200 | 对照分支、回放帧、`comparison.json` | 不复制世界 |

`S`/`CFG` 仍只有一份，由 `host.mjs` 创建后以引用传给三个域；域模块返回工厂（`createHostWorld` / `createModelDomain` / `createReplayDomain`），不各自建单例。`model`/`replay` 用惰性 getter 注入，避免启动顺序与循环依赖。tick 串行链、异步存档、错误字段语义原样保留。

### `survplay.mjs` 为什么拆

拆前 1342 行。拆后 `survplay.mjs` 只留 `createSurvPlay`、`tickSurvPlay`、`survView`、生命/繁衍/死亡收尸，约 620 行；动作、营地入口、存档各自成模块。依赖方向是单向的：

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

所有世界写入走同一条 `queueWorldWrite` 串行链：定时器忙则跳过本拍，显式 `ctl step/tickOnce` 排队。

### 玩家动作

`/act {mode:'survival'}` → `host.act` → `actInSurvival` → `survAct`（`survplay-actions`）：
- 先算时间/体力成本（`costFor`，`V72_TIME=0` 时退回每刻 100 点旧预算）；
- 时间不够就 `BUSY_START`，跨刻由 `advancePlayerBusy` 继续；
- 具体动作交给 `survActInner`（`survplay-camp`）走 `validate/validateCamp → actuate/campAction`，规则层是唯一裁决点；
- 失败退时间、成功记账（`action-ledger`），再 `settleSurvival`。

### 数据与存档

- `data/world.json`：城镇 A/B + `survival` 子档；保存时留 `.bak`，坏档 quarantine。
- `data/saves/`：名字营地；`index.json` + owner 侧车；32hex key、TTL 清扫、索引锁。
- `data/comparison.json`：A/B 对照分支与回放帧，独立于主档。
- 研究五份面：`node life/run.mjs --report|--sweep|--viab|--recover|--metab`，md5 见 [EVIDENCE.md](./EVIDENCE.md)。

## 默认关 / 研究态 / 正式游戏

| 开关 | 默认 | 打开方式 | 边界 |
|---|---|---|---|
| `GAME_MODE` | `research` | `GAME_MODE=game` | research 同时推进旧城镇 A/B；game 只推进生存 |
| `GAME_RULES` | 关 | `GAME_RULES=1` | 只影响 `gameRules` 世界；研究表逐位不变 |
| `BRAIN` | `local` | `BRAIN=model` + 模型 env | 无端点/无观众时退替身；预算/熔断在 `host-model` |
| M3/M4 | 关 | 仅 A/B 页开关，只叠 A 侧 | 不落盘，重启回关；B 侧保持 C2-neg |
| `M5_ENABLED` | 关 | `M5_ENABLED=1` | 慢仓状态校验失败会拒绝启动（不半载入） |
| 讨论/合作/生态等 | 按生存配置 | `createSurvPlay` 选项 | 研究路径不传这些选项时保持旧轨迹 |

## 已知限制

- **不是通用开放世界**：房间/地点/资源点是有限集合；玩家和居民的动作空间由 `body.mjs`/`rules.mjs` 定义，超出即 `UNKNOWN_KIND`。
- **语言层不是语义理解**：NPC 台词是状态条件化模板；玩家输入走关键词意图分类（问候/讨食/警告/指责/道歉/分享等）。
- **真实模型质量未验证**：仓库内只有假上游测试（预算/退替身/坏 JSON），不证明供应商真实质量；`BRAIN=model` 需要自备端点。
- **单机单进程**：`S` 是模块单例；同一 `DATA_DIR` 多进程并发写只做了索引锁与原子写，不是分布式系统。
- **离线补时有界且重启也生效**：MAIN 重启后按 `savedAt` 的真实停机时长、同一 `simClock.rate` 走本地替身补齐；上限 `SURV_CATCHUP_CAP`（默认 120 刻 = 7200 游戏分），超长空档如实标截断，不补决策。研究态/旧时间模型仍按「1 真实分 = 1 刻」的旧口径。
- **性能/内存**：trace 默认封顶 400/角色，日志与 observer 有界；长跑仍建议单独 `DATA_DIR` 并监控 RSS。
- **`scripts/` 下探针**：部分脚本是作者侧实验装置，读历史数据/本机路径，不承诺跨机器复现；以 `npm run check` 与 `evidence/` 为准。
- **五份研究面只在同 Node 大版本、同 seed 下逐位**；换环境属于环境差异，不是否定证据（见 EVIDENCE.md）。

## 提交前自查

```bash
npm run check      # lint + 美术指纹 + 全部测试
node scripts/score-baseline.mjs --ticks 240 --seeds 7,13 --repeats 2   # 作者侧消融/负控
```

新增模块时：保持 `life/` 不 import `web/`；主路径不要把模型/回放/存档重新塞回 `host.mjs`；`S`/`CFG` 不复制第二份；研究态改动必须能指出“关掉开关后逐位相同”的闸门。
