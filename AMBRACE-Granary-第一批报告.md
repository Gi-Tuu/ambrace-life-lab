# HY4 第一批｜Granary 储粮设施样板 · 阶段报告

**批次**：第一批（仅此一批，完成后暂停等待视觉确认）
**执行前 HEAD**：`28793e3d1fe05d48740853d55b25972801753dec`（与派单核验值一致，工作区干净）
**执行方式**：本地编辑 + 本地提交；**未 push、未改部署、未提交赛事作品**

---

## 1. 代码变更

| 文件 | 改动 |
|---|---|
| `web/camp-3d-scene.mjs` | 新增 `granary3d()` 及 4 个辅助函数（`grPlanks` / `grGable` / `grContainer` / granary3d 内的容器调度）；`addCampWork()` 对 `record.type==='granary'` 分发到专属建模，其余建筑**完全不动** |
| `web/app.js` | `worldWithCollisions()` 的缓存签名新增 `storeTier`（0/1/2/3 四档），使库存分档变化时重建 `work3d` |

**没有改动的机制**：自主生命决策、需求调制、记忆/习惯、人口繁衍、资源生产公式、
建筑功能数值、婚姻与住房产权、世界时间、存档格式、玩家操作方式 —— 全部未触碰。
新增 `storeTier` 只是**派生量**，不写存档、不加状态字段。

### 新增模型与组件

| 组件 | 职责 |
|---|---|
| `granary3d(s, lot, record, world)` | 状态适配 + 放置。读 `record.progress / record.integrity`、`world.store / storeCap / buildingsDef` |
| `grPlanks(s, …, skipFrontDoor)` | 木板分层纹理，正面可留 1.05 宽门洞 |
| `grGable(s, …, missing)` | 阶梯双坡屋顶 + 深色屋脊 + 两道檐口；`missing` 用于破损缺层 |
| `grContainer(s, kind, x, z, tilt)` | 粮袋 / 木桶 / 货箱三种聚合道具模型 |

**模型定义格式**：沿用现有 `work3d` 的 box 数组，每项是
`{x,y,z,w,h,d,color,solid,rise,occluder}`，由 `addCampWork` 内部适配器的
`s.box(x,y,z,w,h,d,color,solid=false,rise=false)` 产出。**未引入新的渲染接口**。

---

## 2. 视觉成果（全部为真实运行截图，无概念图）

截图目录 `D:/Codex-Projects/output/`，前缀 `granary3-`：

| 文件 | 内容 |
|---|---|
| `01-地基.png` | 只剩石基施工平台 + 待用材料，无墙无顶 |
| `02-施工中-早期.png` / `03-施工中-后期.png` | 木架随 `progress` 逐层长高、墙板逐层补齐 |
| `04-完工-少量储粮.png` | 完整外墙、双坡屋顶、门洞台阶、1 个容器 |
| `05-破损.png` | 屋脊缺 2 层、柱缩短、通风窗脱落、道具歪斜 |
| `06-储粮-空仓 / 适中 / 满仓.png` | `store = 0 / 10 / 23`（`storeCap=24`）三档对照 |
| `07-近景-完工.png`、`granary3-放大.png` | 近景与 3× 局部放大，看结构细节 |

**状态由真实世界状态驱动**：验收脚本通过 CDP 改写 `/world` 响应里的
`survival.sites[].progress`、`survival.buildings[].integrity`、`survival.store`，
走的是**正常游戏数据链路**，不是单独渲染的模型演示。
HUD 同步显示「粮 23/24」可佐证注入生效。

**九张截图 MD5 全不同**；地基态文件 259 KB 明显小于完工态约 319 KB（结构量差异）；
储粮三档 319169 / 319564 / 319699 B 单调递增，与容器数 0 / 3 / 5 一致。
`store=0` 时一个容器都不画，满足「实际粮食为零但场景显示大量储粮」的禁止条件。

### 与现有场景的协调性

- 沿用 `WOOD #BA8752` / `DARK #72513B` / `LIGHT #D8A667` 与 64 色板内的石色、谷色。
- 与 `house()` 共用 `cladding` 风格的分层板墙、外挑檐板做法。
- 地块沿用 `CONSTRUCTION_LOTS.yard = {x:25,z:27,w:4,d:3.2}`，未改地块面积与碰撞边界。
- 装饰物一律 `solid=false`，只有地块基础 `solid=true`（本来就是不可通行地块），门前台阶不阻挡。

---

## 3. 功能核验

| 项 | 结果 |
|---|---|
| `node --check web/camp-3d-scene.mjs` / `web/app.js` | SYNTAX_OK |
| `npm run lint` | ✔ 语法 218 文件 / import 图 / JSON 12 份 / 引擎纪律 23 模块 / 测试 70 个 |
| `npm run check` | **473 / 473 全绿**，耗时 48.2s |
| 真 Chrome（1400×1000，无 GPU） | `renderer:"3d"`、`mode:"view"`、**JS 错误 0** |
| 状态切换 | 四态 + 三档截图互异，缓存签名含 progress / integrity / storeTier |
| 几何预算 | 完工态约 120–140 个 box（木板纹理薄板占多数）；地基约 10 个 |
| 缓存 | 全部走 `worldCache.work3d`，由 `worldWithCollisions()` 按签名重建，**不每帧重建** |
| 绘制批次 | 无新增 draw call，仍并入既有 `moving` 缓冲 |
| 玩家/AI 移动 | 未改碰撞边界；装饰 `solid=false` |

**试玩路径**：启动 `serve.mjs` → 进入生存 → 顶栏切到「院子」→ 观察地块。
施工进度由 `survival.sites[].progress` 递增驱动，完工后读 `buildings[].integrity`，
库存读 `store / storeCap`。没有计时自完工动画。

---

## 4. 尚未完成 / 已知问题

1. **架空立柱在俯视斜角下仍偏弱**：立柱已移到墙外、加了柱脚石础与台基横撑/阴影带，
   但外挑屋檐会遮住上半段；近景放大图里能看到右侧柱与前沿横撑，左侧常被相邻建筑遮挡。
   若要更强，需要抬高平台（`deck` 从 .78 提到 ~1.0）并相应加台阶级数。
2. **地基态的待用木料堆偏不显眼**：受 `rise='ground'` 施工升起动画与灰色基础平台同色系影响，
   建议在下一轮把材料堆换成更高对比的色值并前移。
3. **屋顶是阶梯式双坡**（现有 `roof()` 家族做法），不是真斜面；
   在现有 `prism` 只支持 axis 斜面的前提下，这是不引入新渲染能力的折中。
4. **容器只有 3 种形态**（粮袋 / 木桶 / 货箱），未接 `camp-items.mjs` 的道具模型；
   第四批才要求统一物品目录，本批按「聚合模型」原则处理。
5. 破损态目前只按 `integrity<1` 二值判断，没有细分损伤等级。
6. 本批**只做了 Granary 一种建筑**；Shelter / Workshop / Wall 仍是原有通用占位结构，
   按派单要求未动。

---

## 6. 实机入口与默认可见性（2026-11-13 补充，重要边界）

**默认开局看不到 Granary，这不是 bug 而是游戏规则**：`initProduction()` 里
`s.sites = []`、`s.buildings = []`，建筑必须由玩家 `plan`（granary 需木 5 / 石 3 / 劳力 6）
再逐步 `build` 才会出现。因此第 2 节的四态截图是**通过 CDP 改写 `/world` 真实状态**拍的，
走的是正常游戏数据链路（HUD 同步显示「粮 23/24」可佐证），但**不是靠自然推进的存档**。

为了让验收方能直接点开看，另建了一个**独立演示存档**（不改仓库代码、不动 `data/world.json`）：

| 项 | 值 |
|---|---|
| 存档 | `D:/Codex-Projects/output/ambrace-granary-demo/world.json` |
| 启动 | `DATA_DIR=<上述目录> PORT=7970 HOST=127.0.0.1 BRAIN=local node serve.mjs` |
| 直达 URL | `http://127.0.0.1:7970/` → 点「继续生存」 |
| 预置状态 | `buildings` 含 granary（yard 地块、integrity 1）、`store` 22、`loc.p1 = yard` |

**未注入实机核验**：`D:/Codex-Projects/output/granary-实机-无注入.png`，
真 Chrome 直接打开该 URL，`renderer:"3d"`、`mode:"view"`、JS 错误 0，
画面里可见红顶粮仓、门楣牌匾、谷穗、门前粮袋木桶货箱。
HUD 显示 **粮 17/36** —— `storeCap` 因 granary 从 24 提升到 36，
证明该建筑在**规则层也真实生效**，不是孤立的模型演示。
服务运行期间世界仍在自主推进（第 4 天、store 22→17、AI 又自建了 shelter/workshop）。

---

## 5. 后续接手信息（给下一个编程助手）

### 模块入口
- 建模：**`web/camp-3d-scene.mjs` → `granary3d(s, lot, record, world)`**
- 分发：同文件 `addCampWork(boxes, world)` 里的
  `if (record.type === 'granary') { granary3d(s, lot, record, world); return; }`
- 缓存签名：`web/app.js → worldWithCollisions(sites, w)`，新增末段 `storeTier`
- 地块：`web/camp-layout.mjs → CONSTRUCTION_LOTS` / `constructionLot(site, layout)`
- 状态判定：`web/camp-3d-scene.mjs → constructionStage(record)`
  - 无 `progress` 字段 → `complete`
  - `progress<=0` → `foundation`
  - 否则 → `frame`（`ratio = progress / buildingsDef[type].labor`）
- 破损：`record.integrity < 1`（建筑记录里才有；工地记录没有）
- 库存：`world.store` / `world.storeCap`（生存载荷 `survView()` 直接提供）

### 设计约定
1. 四种建设状态由 `progress` 与 `integrity` 驱动，**禁止计时自完工**。
2. 储粮分档阈值：`store<=0 → 0`、`ratio<.15 → 1`、`<.6 → 3`、`>=.6 → 5` 个容器。
3. 装饰物 `solid=false`；只有地块基础 `solid=true`。
4. 颜色全部取自现有 64 色板；不引入渐变、半透明、圆角。
5. 图内不放文字，牌匾是纯色块。
6. `rise` 参数沿用既有语义：`'ground'` 表示从地面升起的施工动画，`true` 表示按工程分组升起。
   新建筑若复用，注意 `animatedConstruction()` 会在 650ms 内按 `occluder` 分组缩放 y/h。

### 验收脚本（可复现）
- `C:/Users/sheng/AppData/Local/Temp/granary-shots.mjs`：注入 `/world` 真实状态拍 9 张图
- `C:/Users/sheng/AppData/Local/Temp/gr-crop.mjs`：Chrome 局部 3× 放大
- 两者都是临时脚本，**不在仓库内**；若要长期保留，建议移到 `scripts/` 并去掉绝对路径。

### 下一批约束
第二批（Shelter / Workshop / Wall）**须等第一批视觉确认后再做**。
沿用本批的 `granary3d` 结构：状态适配读 `record`，几何构造放独立函数，
`addCampWork` 只做分发，不把新模型堆进一个超长函数。
