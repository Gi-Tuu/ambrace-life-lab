# HY4 续单｜基础 3D 资产补全 · 四阶段交付报告

**执行前 HEAD**：`ce3e0e4`（第一批 Granary 已通过视觉验收）
**执行方式**：本地编辑 + 本地提交；**未 push、未改部署、未提交赛事作品**
**目标**：优先补齐可正常游玩的世界，而不是孤立的精美模型。**不重做已合格的资产**。

---

## 0. 缺口核查（先做，避免重复开发）

核查结论：**第二、三阶段的资产大部分已存在**，真缺口集中在第一阶段。

| 资产 | 现状 | 处置 |
|---|---|---|
| 物品模型 `camp-items.mjs` | 20 个（10 材料 / 8 工具 / 2 其他），`itemIcon()` 等距投影 | 保留，仅补 `crate` / `sack` |
| 角色手持 / 背包 | `camp-3d-render.mjs` 已用 `itemBoxes()` 复用同一套模型 | 保留 |
| 家具 / 室内道具 | `prop3d()` 19 种独立形体 | 保留 |
| 农田 / 果树 / 浆果 / 灌木 / 野花 | `crops3d` 读 `plots[].growth`；`flora3d` 四类植被 | 保留，补果实状态映射 |
| 鸡 / 牛 / 羊 / 野生动物 | `livestock3d` 读 `world.livestock` 数量；`wildlife3d` | 保留 |
| 四种功能建筑 | `addCampWork` 里除 granary 外**全部共用一个盒子 + 屋顶** | **本轮重点替换** |
| 私人住宅 | `house()` 有外观差异，但窗户不读居住记录；施工中的 `households.projects` 走通用盒子 | 补状态映射 |

---

## 第一阶段｜补齐功能建筑

**修改文件**：`web/camp-3d-scene.mjs`、`web/app.js`

新增 5 个建模函数，全部走 `addCampWork` 分发（granary3d 保持第一批验收版本，未改动）：

| 建筑 | 轮廓设计（刻意互不相同） |
|---|---|
| `shelter3d` 住所 | 落地木屋 + 尖顶 + 外露门廊双柱 + 挑檐 + 两侧窗 + 烟囱 + 小台阶 |
| `workshop3d` 生产设施 | 三面矮墙 + 高挑平坡大屋檐 + **正面完全敞开**，内部可见工作台 / 工具架 / 木料堆 / 炉火 |
| `wall3d` 防护设施 | 沿地块长边的**线性木墙**（非实心盒子）：石基 + 6 根木桩 + 4 道横板 + 背面斜撑 |
| `home3d` 私人住宅 | 小体量尖顶木屋，屋顶色按 `campHash(seed, room)` 确定性变化；窗户亮光 / 炊烟 / 门口木柴**只在有人居住时出现** |

`worksBase()` 统一处理地基态（复用 `worldItem('wood'/'stone')` 的聚合模型），
四态统一为 `constructionStage(record)`：`foundation` / `frame`（按 `progress/labor` 逐层长高）/ `complete` / `damaged`（`integrity<1`：屋顶缺层、柱缩短、墙板或窗框脱落）。

**私人住宅与住房记录对应**：
- `outdoorStage` 的 `house()` 新增 `occupied` 参数，由 `Object.values(world.housing).includes(id)` 派生 → 有人住才亮暖窗（夜间 `glow` 生效）、空置为暗窗。
- `app.js` 给 `outdoorStage` 的 world 补传 `housing`，否则会全部误判为空置。
- `home3d` 同样从 `world.housing` 统计该 room 的居民数。

**截图**（`D:/Codex-Projects/output/`）：
`stage1-01-实机-现有建筑.png`（未注入，演示存档里 granary/shelter/workshop 三座）、
`stage1-02…05-四建筑-完工 / 地基 / 施工中 / 破损.png`（注入真实 `buildings`/`sites` 状态）。

**测试**：`npm run lint` 通过；`npm run check` **473/473 全绿**；真 Chrome `renderer:"3d"`、JS 错误 0。

---

## 第二阶段｜补齐生产和生活资产

**修改文件**：`web/camp-items.mjs`、`web/camp-3d-scene.mjs`

- 新增 `crate`（货箱）与 `sack`（粮袋）两个 0–1 归一化模型，与现有 `vessel` / `bottle` / `tray` 同族。
- 新增 `worldItem(s, id, x, z, scale, y)` 适配器：把 `itemBoxes(id)` 的模型定义缩放平移到世界坐标，
  让**场景堆放物 / 背包图标 / 角色手持**共用同一套几何定义，不再各写一份。
- 接入点：`worksBase()` 地基态的木料堆 / 石料堆改用 `worldItem('wood'/'stone')`；
  `workshop3d` 完工态的储物用 `worldItem('crate'/'sack')`。
- **未改**任何物品数量、消耗规则或 `CAMP_ITEMS` 列表。

**截图**：`stage2-物品目录-背包.png` — 实机背包 10 个道具图标全部渲染，
标签 木料/石料/浆果/水果/蔬菜/鸡蛋/羊毛/牛奶/水/木托盘。
**测试**：`npm run lint` 通过；最终统一 `npm run check` 473/473。

---

## 第三阶段｜补齐生态视觉

**修改文件**：`web/camp-3d-scene.mjs`、`web/app.js`

核查发现 `flora3d` 的果实原本是固定 3 个红点，与季节和存量脱节。补两处真实状态映射（都是派生量，不写存档）：

1. **果树**：`world.season === '冬'` → 不挂果；其余季节 3 颗。果树棵数仍由 `world.livestock.orchards` 决定。
2. **浆果灌木**：`world.wildBerries` 总量分档 → `0` 颗 / `2` 颗 / `3` 颗红果。采尽后灌木仍在、但不再显示果实。
3. `life3d` 缓存 key 补上 `season` 与 `berryTier`（档位而非原值），并把 `season` / `wildBerries` / `produce` / `housing` 传进 `outdoorLife()`，否则状态变了几何不刷新。

**截图**：`stage3-01-夏-有果.png` / `stage3-02-冬-无果.png` / `stage3-03-夏-野果采尽.png` — 三张 MD5 互异。
**测试**：`npm run lint` 通过；最终统一 `npm run check` 473/473。

---

## 第四阶段｜整体整合与整场景验收

**截图**：`stage4-整场景-全景.png`（`btnOverview` 全景，`mode:"overview"`）。
世界地图完整：河、道路、农田、树林、建筑群、全景边框都在，无大片空白、无明显穿模。

**逐项核对**：

| 派单要求 | 结果 |
|---|---|
| 模型适配现有镜头与场景风格 | 沿用 `WOOD/DARK/LIGHT` + 64 色板、等距投影、现有 `roof`/`cladding` 做法 |
| 建筑外观与进度/完整度一致 | 四态由 `progress` / `integrity` 驱动，`work3d` 缓存签名含两者 |
| 私人住宅与住房记录对应 | `house(occupied)` / `home3d(residents)` 读 `world.housing` |
| 物品表现与真实库存一致 | 粮仓容器按 `store/storeCap` 分档；地基材料堆复用 `itemBoxes`；果实按 `wildBerries` 分档 |
| 玩家/居民正常移动工作 | 装饰 `solid=false`，未改碰撞边界与寻路；无 JS 错误 |
| 不大规模改规则 | 只新增派生量与一个缓存 key，**未动** `life/` 任何规则文件 |
| 保持 WebGL 架构 | 全部走现有 `work3d` box 数组与 `moving` 缓冲，无新 draw call |
| 跑测试 + 看画面 | 见下 |

**运行命令与结果**：
```
node --check web/camp-3d-scene.mjs && web/app.js && web/camp-items.mjs   → SYNTAX_OK
npm run lint   → ✔ 语法 218 文件 / import 图 / JSON 12 份 / 引擎纪律 23 模块 / 测试 70 个
npm run check  → # tests 473 / # pass 473 / # fail 0
```
完整 `check` 在阶段 1 结束与四阶段全部完成后各跑一次（均 473/473）；
阶段 2、3 每次改动后跑 `lint` + 真 Chrome 截图，**没有逐阶段重跑完整 48s 测试**，此处如实说明。

**实机**：`http://127.0.0.1:7970/`（独立演示存档 `D:/Codex-Projects/output/ambrace-granary-demo/world.json`），
服务仍在运行，世界自主推进（截图时第 18 天、粮 17/36）。

---

## 尚未完成 / 待美术精修（按派单，精修集中放在基础资产之后）

1. 四种建筑的**地基态材料堆**在俯视下偏不显眼（与灰色基础同色系）。
2. `wall` 破损只按 `integrity<1` 二值（缺一段横板 + 一根短柱），未分损伤等级。
3. 屋顶仍是阶梯式双坡（现有 `roof` 家族做法），不是真斜面；不引入新渲染能力的前提下保持折中。
4. 第一批 Granary 的 `grContainer` 仍是手写几何，未切到 `itemBoxes('crate'/'sack')`——
   **按派单「不要反复重做已经合格的资产」刻意保留**，后续若要统一需重新走视觉验收。
5. 物品目录目前是代码内的 `models` 表，没有独立成册的文档；本报告的 §2 是首版清单。
6. 生态里「成熟 / 收获」的视觉反馈靠 `plots[].growth` 与 `wildBerries`，还没有收获瞬间的动效。

---

## 后续接手信息

- **建模入口**：`web/camp-3d-scene.mjs` → `shelter3d / workshop3d / wall3d / home3d / granary3d`，
  统一由 `addCampWork(boxes, world)` 分发；新增建筑照此加一个函数 + 一条分发即可。
- **状态适配**：`constructionStage(record)`（无 `progress`=完工，`<=0`=地基，其余=施工）；
  破损看 `record.integrity<1`；进度比例 `progress / buildingsDef[type].labor`。
- **模型定义格式**：box 数组 `{x,y,z,w,h,d,color,solid,rise,occluder}`；
  `worldItem()` 把 `camp-items.mjs` 的 0–1 归一化模型映射到世界坐标。
- **缓存签名**：`web/app.js → worldWithCollisions()` 含 `progress` / `integrity` / `storeTier`；
  `drawCamp` 的 `life3d` key 含 `livestock` / `plots` / `season` / `berryTier`。**新增状态维度必须同步进 key**。
- **设计约定**：装饰 `solid=false`；颜色取 64 色板；图内不放文字；禁止计时自完工；不改 `life/` 规则。
- **验收脚本**（临时、不在仓库）：`stage1-shots.mjs` / `stage234-shots.mjs` / `granary-shots.mjs`，
  均通过 CDP 改写 `/world` 真实状态拍照；若要长期保留，建议移入 `scripts/` 并去掉绝对路径。
