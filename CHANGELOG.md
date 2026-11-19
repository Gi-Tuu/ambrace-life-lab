# 变更记录

## [未发布]

### 雨丝去规则条纹

- `paintWeather` 的雨滴不再用固定步长的 55 条平行线：位置/长度/倾角/透明度逐滴 hash 抖动，数量降至 48，避免读成整屏白色斜条纹。
- 只改天气表现层，不影响世界与测试。



### 材质颗粒去斜纹

- `materialGrain` 从正弦线纹理改为各向同性 hash 颗粒：木/金属材质贴到墙面、斜面时不再出现规则斜条纹。
- 仍保留木/金属不同行的粗糙差异；不改世界与测试。



### 顶点色烘焙 AO + 软阴影

- 新增 `shared/camp-ao.mjs`：静态网格生成时把“竖直面近地变暗”的 AO 烘进顶点色，渲染零成本；近地竖面 0.80→1.00，底面 0.82。
- 新增 `life/camp-ao.test.mjs`：近地竖面变暗、高处更亮、朝上地面不变。
- 接触阴影保留可选 `soft` 两层伞面；屏幕空间 SSAO 的深度纹理合成在 WebGL1 上黑屏，已回滚，未计入。



### 软阴影 + 接地 AO

- contactShadowMesh 增加可选 soft 模式：同中心铺两层更大、更淡的伞面，渲染器使用；测试默认仍用硬影，避免改变足迹断言。
- 场景 shader 增加竖直面近地的 contact AO（非屏幕空间 SSAO）；完整 SSAO 的深度纹理合成尝试因黑屏回滚，未计入。



### 电影化后处理第一档

- 离屏 HDR 帧缓冲 + 单 pass bloom/ACES tone mapping/冷暗部暖高光分级/暗角/胶片颗粒；WebGL 不支持 FBO 时自动回退直绘。
- web/camp-3d-render.mjs 场景先渲染到 texture，再由全屏 shader 合成；不改变世界与测试口径。



### 山体/岩壁材质：去掉逐面砖格

- web/camp-3d-render.mjs 对坡度陡的岩壁/山体改用世界坐标连续噪声 + 层理 + 细颗粒，覆盖逐面图集变体（4 个 variant 在 1×1 面上轮换会读成砖格）。
- 低矮作物/围栏仍按眼高判定；本次只改材质，不改遮挡规则。



### 视野机制：按眼高判定

- campSight 的格子与实体可见性目标从地面附近（+.43/.65）提高到眼高（+1.15），低矮作物/围栏/桌面不再以自身包围盒遮挡大片地面与站立居民；墙、树、地形仍按实际高度遮挡。
- 新增 life/camp-sight.test.mjs 用例：同位置 1.06m 作物可见、2.6m 墙仍遮挡。

## [0.1.6] — 2026-11-19

### 场景表现与美术图鉴

- 加入九类劳动动作与落点特效。风暴水花、飞叶、寒潮挂霜、旱地裂纹和倒伏植株反映游戏状态。
- 补充地块轮廓、入口、操作位及受阻提示。居民四龄各有身型和头像，果树表现花期与受灾状态，动物表现警觉和进食。
- 修正桥、井台、工坊、墙体和门口的接地及湿面，调整室内遮光。补充河岸植被、荒野地标和住宅内外造型变体。
- A/B 选刻可重建两侧场景。较早记录缺少场景数据时显示提示。
- 运行 `npm run art:catalog` 在本机查看美术图鉴。补录狐狸、人物四龄、作物状态和天气共 20 张预览卡。牛羊及野生动物的幼体、老体待生命周期数据接入。

### 3D 画面丰富化（2026-11-19）

- 所有者要求"全部都要做"的第二轮细节增加（61 族）：23 件手持/背包物品各加 1–3 个结构小件
  （扣带/柄箍/刃口高光/织带/年轮/苔面/斑点/骨脂/标签/扎口等），**场景聚合道具与背包图标同源同改**；
  环境层：树根盘＋断枝＋落叶、岩石苔面＋伴石、草丛野花（纯哈希门控）；
  建筑侧：门口灯笼（glow 夜间光晕）、住所/住宅窗箱花、粮仓扫帚、旧壳货堆、工棚淬水桶＋柴堆、
  主厅长凳＋桌、瞭望塔旗幡、水井辘绳＋吊桶、菜园稻草人、畜栏食槽＋干草捆＋水桶、牛铃。
- **不变量**：61/61 族碰撞体逐字节不变；新增全部非碰撞；灯笼 glow 经 transform 对象 spread 传递
  （stage 与 addCampWork 两套 box 参数位不同，位置参数会吞 glow——本轮实测抓到并修）。
- 确定性：环境细节走 `campHash`，不消费 rng、不进世界 tick；研究面不受影响（表现层-only）。
- 对照总览 `docs/enrich-compare.html`（61 族左旧右新）；图鉴物品/树木标签同步「已翻新」。
- 闸门：新增丰富化结构断言（灯笼 glow/稻草人/根盘/物品件数/确定性）；`npm run check` 实测 **995/995** 全绿。

### 3D 资产批量细化（2026-11-18）

- 所有者放行一次性细化剩余 3D 家族（32 族）：私人住宅入口门框/窗台窗楣、围墙壁柱帽（随破损递减）、
  菜园/水井/畜栏棚/室内外顶棚全部换连续双坡（`roof()` 层叠顶在生存场景至此无消费者）、
  鸡成鸡双翼、牛尾穗、羊额毛、鸟冠羽尾尖、兔内耳、鹿角；20 件室内道具各加结构细节
  （横撑/床尾板/烟囱帽箍/流苏/顶冠/盆沿/杆帽/盖压条/八角倒角/三脚垫/底座/柱帽/栏桩握把等）。
- **不变量**：32/32 族碰撞体（solid 部件）逐字节不变；新增细节全部非碰撞；围墙部件数断言同步 24/23/22 → 30/28/26（柱帽 6/5/4）。
- 手持/背包物品 23 件**不动**：与背包图标共用同一套 0–1 归一化形体，改会连坐 UI 图标语言。
- 对照总览 `docs/refine-compare.html`（32 族左旧右新同镜头）；图鉴标签同步「已翻新」。
- 闸门：`camp-geometry.test.mjs` 新增批量细化结构断言；`npm run check` 实测 **994/994** 全绿（lint 433 文件 / 179 测试文件）。

### 像素资产清理（2026-11-18）

- 删除 31 张无绘制消费者的 2D 遗留 PNG：`room_*` 8、`thing_*` 5、`icon_*` 5、`house_*` 8、`actions/{a1,a2,a3,p1,fx}` 5。
  逐张枚举过消费者：它们只被加载进内存、从未被绘制（2D 视口退役后）；HUD 图标现为程序化绘制，不依赖 icon PNG。
- **UI 保留**：头像 `actions/portrait_*` 4 张、角色帧 `char_*` 16 张（头像兜底）、OFL 字体、palette.json 不动。
- 生成器同步停产上述死类别（`gen-pixel-assets.mjs` / `gen-actions.mjs`），`npm run assets` 不再复活它们；
  `pack-assets.mjs` 必需场景表移除 house_*；闸门测试改断言新产出表（4 角色×4 帧＋44 场景皮肤、死类别 0）。
- `app.js` 动作精灵加载改为缺失只放弃精灵、**不连坐 UI 头像**（此前 fx 缺失会使整组 ACT 加载失败）。
- 指纹重钉 64 张（60 顶层＋4 头像）；实跑展开态对照面板确认头像 `<img>` 正常；`npm run check` 992/992 全绿。
- **仍在服役的 44 张场景皮肤**（terrain 20 / prop 21 / tree 3）是 3D 地面与道具贴图来源；所有者裁决**保留**（删它们会回退程序化色块）。图鉴中标「服役中」，角色帧标「UI 保留」，不再混入「未翻新」清理候选。

### 审计5 修复（2026-11-18）

- **SEC5-01**：`ctl_nonce` 改为服务端签发、绑定 `ctl_sid` 会话并在服务端存储校验；自选 cookie/header 对与伪造 `Origin`/`x-forwarded-host`/`Sec-Fetch-Site` 不再能授权。配置 `CTL_TOKEN` 时破坏性 `/ctl` 只认 Bearer，nonce 分支彻底关闭。
- **SEC5-02**：非 MAIN 的 `/world?camp=` 无 owner cookie 一律 403；已归属营地重开不换绑、不给非 owner 发新 cookie（`CAMP_OWNED`）。
- **SEC5-03/04**：MAIN 与营地统一 `catchup` 冷却 + 每日累计上限；`/saves/open` 增加会话配额（默认 5/分钟），NaN env 回落不再归零。
- **SEC5-06**：CSP / nosniff / XFO / Referrer-Policy 全套安全头；cookie 支持 Secure（`COOKIE_SECURE=1`）；存档错误只回错误码，不回显绝对路径。
- **DATA5-02/03**：`flushWrites` 改为硬屏障（必要时强制保存、返回营地错误明细）；营地写失败不再报 `ok:true`；SIGTERM 等待 flush，未完成以非零码退出。
- **DATA5-04/06**：索引 key 严格 32hex；sweep 只操作 `saves/` 内且 realpath 校验的文件；索引锁超时 fail-fast、stale lock 按 owner/时间戳回收、唯一 tmp + 代际；6 进程 ×8 轮 48/48 不丢。
- **ARCH5-01/02**：`validateCamp` 非 camp 分支改用字符串返回 `NOT_CAMP_ACTION`；成本注册与运行时统一走 `costFor`/`SHARED_COST`。
- **DATA5-09**：`settlementLife` 旧档按“分城区证据”显式 OR 迁移，不再因 false 永久丢 districts/peripheralHomes。
- **DATA5-11/13/14**：wool 兑换/屠宰/喂食记入 consumed；deaths 封顶 200 并累计总数；observer 默认 cap 降到 2 万；分营地 tick 支持墙钟预算。
- **测试/CI**：`REQUIRE_CHROME=1` 真正驱动浏览器用例失败（新增 `chrome-gate.mjs` 与 Linux Chrome 路径）；CI 显式验证 Chrome；文档测试数、Dockerfile、SECURITY 白名单同步到 178 文件 / 976 条。
- **第二轮补齐**：MAIN `survival_reset` 在令牌姿态下可用服务端 nonce（一次性 + 60s TTL + 3 次/分钟 + `[audit] main_reset`）；owner/名字侧车 `saves/<key>.owner.json` 与索引重建；`S.model.calls/attempts/survivalChoices` 统一走预算域；启动基线档 + `SAVE_EVERY` 可配 + `.bak` 回退测试；camp_* 工具/品类前置收敛到 `camp-precheck.mjs`。

### 外围同权收口（P0）

- 服务端拥有玩家外围位置 `playerPos`（进存档）；带 `from` 的外围动作先做连续性校验（玩家速度≤居民 `startMove`）再走距离门与规则层；伪造跨区劳动返回 `TELEPORT`，不扣行动预算与存续。
- 外围资源点分两环：内环近郊日常木石（相对实际生成 hall 取最近可行对，80 seed 0 缺失，62/80 双≤35u，18 个营区近河 seed 35.8–38.6u，地形约束如实披露），外环远征不变。
- 村外步行钳到世界时允许速度（禁冲刺），村内保留冲刺；HUD 标"村外·限速"。`player_sync` 节流上报（位移>2u 或≥1.2s），被拒时客户端可视位置钳回服务端认可点。
- 闸门 V4-01…07（负向对照真打红）；秒表对照远征区玩家同程刻数≥居民（north 8=8、far-east 21≥18、far-south 20≥18）。口径：玩家 1.33 u/s vs 居民有效 ≈1.30 u/s，68u 处都 7 刻，基本相等非惩罚。

### 荒野 V6 与 UI

- 区块化 600×570 野外（河流/岸线/植被/丘陵），聚落与野外共用几何与寻路；跨区采集/建造/施工统一走规则层。
- UI 重做：工具栏/物品栏收进背景框、图标 HUD、四季木板、对照面板双世界对齐、事件窗滚动、网格背包、瞬态 toast。
- A′B′C′ 美术升级：受光与接触阴影、具名部件按真实状态驱动；帧时 8.41→8.70ms、绘制 38→17 次、顶点 395853→255853/帧。
- 程序化声音：状态驱动 SFX/环境声/BGM，离聚落越远配给与锤击声消失、风底与林鸟上来、BGM 淡到 sparse 版。

### 美术指纹闸门

- `npm run art` 重钉 web/assets 每张 PNG 的 sha256 到 art-hashes.json；`npm run art:check` 校验，任何一张不一致即 exit 1；`npm run check` = lint + art:check + test。改图必须显式重钉并在本文件承认。

### 文档

- README/创作手记/CHANGELOG 同源刷新：测试 556 项/82 文件、模块 180、覆盖率行 90.24%/分支 88.35%/函数 92.10%（2026-11-15 实测）。

## [0.1.5] — 2026-11-18

### 主路径可读性（行为等价拆分）

- `life/host.mjs` 1747 → 约 460 行：拆出 `host-world.mjs`（世界创建/装载、tick 串行链、定时器、离线补时、存档、营地生命周期）、`host-model.mjs`（配置、预算/车道、审议提示词、modelBrain/modelTalk）、`host-replay.mjs`（A/B 对照、回放帧、comparison.json）。`S`/`CFG` 仍是单例引用，不复制；`host.mjs` 保留 facade 与全部原导出。
- `life/survplay.mjs` 1342 → 约 630 行：拆出 `survplay-actions.mjs`（时间/体力/成本、busy 跨刻、失败回滚与账本）、`survplay-camp.mjs`（营地/住房/设施/建造/家庭/合作动作入口）、`survplay-save.mjs`（dump/load 与旧档迁移）。依赖方向单向，`survplay` 保留 tick/view/原导出。
- 新增 `life/split-boundaries.test.mjs`：行数、域模块存在性、依赖方向、原导出兼容六条边界闸门（先红后绿）。
- 行为等价：`npm run check` 全绿；测试 179 文件 / 982 条；五份研究面 md5 与 `seed/world.json` 旧档载入未变。

### 交付项

- `package.json` 增加 `"type": "module"`（消除 lint/ESM 重解析警告）、`repository`/`bugs` 字段，版本 `0.1.5`；新增 `.github/ISSUE_TEMPLATE/bug.md`。
- 新增根目录 `QUICKSTART.md`（3 条命令 + 5 分钟真实路径）与 `ARCHITECTURE.md`（模块边界、host/survplay 拆分、默认开关、已知限制），clone 后不读 gitignored `docs/` 也能接手。
- 新增 `BENCHMARK.md` + `scripts/score-baseline.mjs`：同 seeds/同 tick 比较内部通道开/关/随机策略的行为分布与可复现性；明确为**作者侧消融/负控**，不是外部独立基准，附第三方复现协议与未验证声明；证据 `evidence/score/baseline.json`。
- 新增 `scripts/quickstart-browser.mjs`：真实 Chrome 跑起服→进游戏→走→采集→吃→睡→HUD→死亡后世界继续，证据 `evidence/score/quickstart-browser.log`。
- 公仓谷仓新增「在公仓吃一份」按钮（与服务端 `camp_eat` 的谷仓分支同源；不饿时按钮给出原因）。

## [0.1.5 之前的未发布]

### 游戏模式规则层（2026-11-15）
- 新增 `GAME_BUILDINGS` 与 `buildDef(world, type)`：**研究世界逐位沿用 `BUILDINGS`**，正式游戏走游戏表。
  开关是显式 `gameRules`（`GAME_RULES=1`），刻意不用 `independentWorld`——长程/游戏预设的研究样本也用它，
  否则所有既有读数会一起漂移。
- 该层覆盖全部算成本的消费者（`doPlan/doBuild`、`body` 的可负担/候选/文案、`cooperation`、`goals`、`rules`、
  `survView.buildingsDef`），避免"AI 用研究价算钱、按游戏价扣钱"的双账。
- 游戏表首批数值（B：建造不再三下）：成本 ×2、工时 10/14 ⇒ 住所 5 下、生产设施 7 下。
  实测：`GAME_RULES` 关 = 4木2石/6 工时；开 = 8木4石/10 工时。
- 新闸门 `life/game-rules.test.mjs` R1–R3（研究世界原表、游戏世界新表与扣料、视图透传），可验红。

### 食物不再抹平（A，仅 `gameRules`）
- 公仓新增分类账本 `s.food`（作物/浆果/果/蛋/奶/肉），`s.store` 始终是各品类之和；
  研究世界**没有** `s.food`，算术逐位不变。
- 五个进出点接入：玩家存/取（按品类，取用时品类为 0 自动挑存量最多的）、每日配给、
  收获入库、生态取食、产物入库。粮仓面板显示"公仓 12/24（作物 5 · 肉 3）"。
- 闸门 `game-rules.test.mjs` R4：总数守恒、取用后仍守恒、研究世界无账本；可验红。
### 灯火要烧柴（C，仅 `gameRules`）
- 每天烧 1 份木料（先公共柴堆、再玩家背包）；**亮不亮按当前柴量实时推导**（`survView.light`），
  不是日落时的一次性状态——补到柴立刻有灯。
- 没柴时：室内炉火光晕关掉、夜里曝光降到 0.62（屋子明显变暗），HUD 显示"没柴，夜里点不着火"。
- 研究世界没有 `light`/燃料概念、不烧柴。闸门 `game-rules.test.mjs` R5（燃烧计数、无柴无灯、研究世界不烧）。
### 可玩性：首次进入三步引导（2026-11-15）
- 玩家第一次进入生存模式时，右上角出现一张三步卡：**采集 → 吃饭 → 睡觉**，每完成一步自动打勾，
  全部完成或点"知道了，先自己逛"后**永久不再出现**（`localStorage: ambrace.firstRun.v1`）。
- 进度来自真实动作成功（`performCamp` 成功后按 kind 推进），不是点按钮自证；判定只认当前那一步，跳步无效。
- 闸门 `frontend.test.mjs` F11（键、三步定义、跳过入口、动作推进、吃/睡两步的映射），去掉动作推进即变红。
### 游戏态规则上线三件（2026-11-15）
- **修载入对账**（缺陷）：旧档没有 `food` 字段，而建世界时的 `crop:6` 会留下来、`store` 被覆盖成存档值，
  于是 Σ分档 与 store 永久差一截（线上种子实测差 **11**，配给扣完而公仓显示不变）。现在任何载入路径都对账：
  缺分档先建账，再按差值补/扣作物。新闸门 `game-rules.test.mjs` R4b（去掉对账行即红，实测 Σ=6 vs store=17）。
- **开关进镜像**：`Dockerfile` ENV 增加 `GAME_RULES=1`；README 开发小节说明本地默认关、想复现线上要显式开。
- **重烘公开起点**：按新规则跑 `seed-ladder` 960 刻（第 40 日：6 位在世居民、3 生 1 死、公仓 11、4 座建筑），
  拼进 `seed/world.json` 时只替换 `survival` 值、A/B 块逐字节不变；`seed-archive.test.mjs` 新增
  「起点档 Σfood === store」断言。体积 877 KB → 978 KB（如实记）。
### S2 意图通道（C0，2026-11-15）
- 新增 `life/intent.mjs`：一条意图消息 = 结构化事件；**闭合词表**（9 act × 8 topic）、文本归一化（≤28 字）、
  后果表（信任 ±，单次 ≤ ±8）、每日上限（每人 3 次 / 同一对 1 次）、`converseLog` 环形 240 条。
- 接线：`agent.receiveMessage`（只留痕与计数，不碰世界数值）、`survplay` 每刻至多一轮遭遇对话
  （只在 `GAME_RULES=1`）、`survView` 暴露最近 12 条与条数。
- 闸门 `game-rules.test.mjs` S2-1（词表拒收）/ S2-2（文本不造事实、信任 ≤±8）/ S2-3（A=3、P=1）/
  S2-4（落盘往返逐位一致；摘掉即少条目）。三条负向对照均验红并字节还原。
- 未做：模型侧"选动作时顺带输出 say"的接线（属 C3 调度）、开始页回看面板（属 C2）。
### 名字存档的世界实例管理器（C1，2026-11-15）
- 新增 `life/camp-instances.mjs`：**不实例化 host 单例**，直接组合 `survplay` 纯 API；
  名字校验（1–16 字，拦分隔符/`..`/控制符/零宽）、`sha256(归一化名字)` 派生 key（名字永不进路径）、
  `saves/index.json` + `saves/<key>.json.gz`、LRU 常驻 ≤6、`tickAll` 有 wall-time 上限、
  TTL 3 天且**正在被观看的绝不删**、公开列表只投影五项。
- `forkCamp` 复用 `seed-ladder` 的换玩家槽位做法（新名从 40 天种子起步，玩家是活的新到者）。
- 闸门 `camp-saves.test.mjs` SA1（隔离）/ SA2（往返不动点 + Σfood 对账）/ SA5（名字安全且不产生文件）/
  SA4（TTL 不删活跃）/ SA6（列表投影）。四条负向对照均验红并字节还原。
  注：SA5 删单条检查不会红——**名字不进路径**这层更强；短路整个校验即红。
- 未做：HTTP `/saves`、开始页进场 UI、三态调度（C2/C3）。
### 名字存档的进场流程（C2，2026-11-15）
- **host 支持按名字切换当前营地**（一次只服务一份，多营地并发留给 C3）：`openCamp(name)` 先落当前营地，
  再把该名字的营地切为当前世界；`save()` 分流——命名营地只写 `saves/<key>.gz` + 索引，**绝不覆盖主营地 world.json**。
- **serve 路由**：`GET /saves`（只投影六项）、`POST /saves/open`（写路由，走同源/令牌守卫）。
- **开始页**：名字输入框 + 「已有营地」列表 + 一句话红线「名字就是钥匙」；提交成功后直接进
  `/?mode=survival`，当前营地由服务端持有。
- 实机点通：起始页输入「阿禾」→ 重载进游戏 → 第 40 天、6 位居民、玩家为活的新到者（HUD 体力 0.7 / 存续 1）。
- 闸门 `camp-saves.test.mjs` 新增 SA3：fork 起点照 `seed-archive` 口径（刻数>0、未终局、在世≥3+玩家、
  公仓>0、建筑≥3、玩家在世且在占用表、刻数等于种子刻数），阈值未放宽。
### 三态调度与按营地观看计数（C3，2026-11-15）
- 新增 `life/camp-lane.mjs` 纯判定：有观众→`watched`；无人+主营地→`node`；无人+分名字营地→`idle`（确定性替身，询问不发出）；
  无人且未开启无人运行→`off`。`modelBrain` 在顶部按 `world.campKey` 判道，`idle` 直接返回 null 并记 `LANE:IDLE_CAMP`。
- `host.touch` 除既有三个 key 外，按**当前营地**打点（`S.campViewers[campKey]`）；`openCamp` 给世界打 `campKey`，
  主营地启动时标 `MAIN`。
- 默认值按所有者批准上调：`NODE_CALLS_DAY` game 8000 → **12000**、`UNATTENDED_CALLS_PER_TICK` 1 → **2**。
  线上仍在部署会话的环境变量里，需同步（env 显式值会盖住代码默认）。
- 闸门 `camp-saves.test.mjs` SA7：三态表格逐格 + 两份营地互不影响；把 `idle` 放行即红（已验，字节还原）。
### TTL 清扫接线与存档归档脚本（C4，2026-11-15）
- host 启动时扫一次名字营地、之后**每小时**扫一次（`unref`，不拖住进程退出）；`stop()` 清掉定时器。
  清扫复用 `sweepSaves` 的"正在被观看的绝不删"逻辑（SA4 覆盖）。
- 新增 `scripts/archive-saves.mjs`：`archive` 把 `DATA_DIR/world.json` 与 `saves/` 复制到**仓库外**
  `~/.ambrace-archives/<时间戳>/` 并写 sha256 manifest；`restore` 默认取最近一份、可按时间戳指定，
  恢复后校验 manifest。数据目录不存在时 exit 2，**不生成空归档**。
- `docs/deploy-checklist.md` 顶部新增「0. 重新部署前必须先归档」一节，把这条从登记项升成交付步骤。
- 闸门 `save-archive.test.mjs` A1（归档→清空→恢复，逐字节一致）/ A2（无数据目录必须失败且不留目录）；
  拆掉归档里复制 `saves/` 那行即红（已验，字节还原）。
### 多营地并发（C3 补齐，2026-11-15）
- `openCamp` 不再替换当前世界：装载后由每个请求按 `camp` cookie 选世界（`/saves/open` 下发，
  `Path=/; Max-Age=30d; SameSite=Lax`），`/world` 与 `/act` 按 cookie 路由；无 cookie 即主营地。
- 按营地 tick：每拍推进主世界与所有常驻分名字营地（同一套预算/熔断/两本账），单份异常不拖垮整拍。
- 按营地落盘：主营地仍写 `world.json`；每个常驻营地各写 `saves/<key>.gz` + 索引。
- `ctl` 的 `reset` / `survival_reset` 同步 `S.mainSurv`（修掉并发改动打红的 3 条既有测试）。
- 闸门 SA9：`tickAll` 必须推进每个营地（只跑第一份即红）；实机两个 cookie 各自 960→963，
  对甲 `move garden` 后甲变、乙不变。
### 核验修复：路由补 query、camp key 校验、TTL 语义（2026-11-15）
- **P0-1 营地路由不再只依赖第三方 cookie**：`web/net.mjs` 的唯一出口按注入的 provider 给 `/world`、`/act`
  自动追加 `?camp=`；`web/app.js` 从 `localStorage: ambrace.camp.v1` 提供 key，进场后写 key 并带
  `&camp=` 跳转；开始页新增"当前营地 / 回主营地"（`POST /saves/back` 清 cookie 与本地 key）。
  跨站 iframe 里 cookie 可能存不下也带不上，query 是主路径，cookie 只当加分项。
- **P0-2 `camp` key 二重校验**：`openKey` 只接受 `^[0-9a-f]{32}$` **且**必须是索引成员（`campSurv` 再兜一层）。
  截断了 `../archive-2026/victim` 这类"复活并覆盖归档"的路径穿越。闸门 SA5b。
- **P1-3 TTL 语义**：`lastSeenAt` 只由观众行为推进（`open`/`openKey`/`touch`），落盘（`save`/`persist`）
  不再刷新；常驻但三天无人会被扫掉。闸门 SA4b。
- 闸门 `camp-routing.test.mjs` SA10：起真服务验证 `?camp=A` / `?camp=B` / 不带 camp 三条路由；
  `scripts/smoke-online.mjs` 增加只读路由检查（`SMOKE_CAMP_KEY` 提供 key，`/saves` 按设计不投影 key）。
- 三条负向对照均验红并字节还原（整条 key 校验短路、persist 刷新 lastSeenAt、忽略 camp 路由）。
### 第二轮核验的两处 P2（2026-11-15）
- **P2-a `/world.camp.name` 恒为哈希**：快照里的营地标签原先走 `listCamps()`，而公开投影按设计不含 `key`，
  这条 `find` 永不命中。改为读**内部 live 条目**的名字（`S.camps.live.get(key)?.name`），闸门 SA10 增加
  `camp.name === '甲'` 断言。
- **P2-b localStorage 写不进时丢营地**：`setCampProvider` 的初值改为优先取 URL 的 `camp`（校验 32 位十六进制），
  localStorage 只做持久化。实测：清空 localStorage 后用 `?camp=` 刷新，所有 `/world` 请求仍带 `camp=`。
  闸门 F12 结构性覆盖该路径。
- 一处自身失误如实记：给快照加行内注释时 `//` 吞掉了同一行的 `saveError`，被 `node --check` 当场抓出，已修。
### 回看面板 + `served` 徽章（P1，2026-11-15）
- 开始页新增「这一段他们之间发生了什么」：只读 `/world` 的 `survival.converse`（最近 12 条），
  每条显示 第几天 · 谁 → 谁 · act/topic 中文 · 原话 · 信任变化 · `served` 徽章（`standin` → **本地替身**）。
- 全部用 `textContent` 与 `createElement` 渲染，不拼 `innerHTML`（原话是模型输出，按不可信文本处理）。
- 面板与「当前营地」都按内存 provider（URL 优先）取营地；URL 直达没有本地名字时，用 `/world.camp.name` 兜底显示。
- 闸门 F13（面板存在、读 converse、textContent、替身徽章中文、开始页会加载）。
- 一次自身失误如实记：面板常量名 `ACT_ZH` 与既有常量重名 ⇒ 模块级 SyntaxError、整页不启动，F6 冒烟 19s 超时抓到；
  改名 `CONV_ACT_ZH/CONV_TOPIC_ZH` 后恢复（F6 回到 ~3.1s）。
### 模型 `say` 接线（P2，2026-11-15）
- `modelBrain` 的 JSON 协议从 `{id,reason}` 扩成可选 `{act,topic,text}`：提示词里给出闭合词表与 28 字上限，
  模型不想说可以省略。
- **规则层仍是唯一裁决者**：`parseSay` 校验词表与文本长度（非法则丢弃并记 `SAY:INVALID`），
  真正投递走 `converse`（同地点、上限 A=3/P=1、信任变化 ≤±8）；动作执行后由 `survplay` 投递，
  条目带 `served:'node'`，面板徽章从"本地替身"变成"模型"。
- `agent.pendingSay` 是唯一交接点：模型只写"怎么说"，不改世界。
- 闸门 `life/say.test.mjs`（S2-5，假 OpenAI 端点、零联网）：非法 act → `SAY:INVALID` 且绝不进 converse；
  合法句子 → `served:'node'`、文本与 act 原样。两条负向对照（去掉投递 / 去掉词表校验）均验红并字节还原。
### SA8：两本账分离 + 熔断只关免费路（P2，2026-11-15）
- 新增独立闸门 `life/lane-accounting.test.mjs`（不再只靠 `model-lanes` 间接覆盖）：
  免费路被 `BREAKER`/`NODE_BUDGET` 挡住时不受钱账影响；付费路**不受熔断连坐**，
  无人时 `NO_OBSERVER`（除非显式允许），钱账/节点账互不牵连。
- 负向对照：把熔断判断挪到两路之前（连付费一起挡）⇒ SA8-2 红，已验并字节还原。
### 第三轮核验：非法 camp 回落 + 观看键校验 + lint 真 import（2026-11-16）
- **N1（必修）**：非法/未登记的 `camp` 不再让访客拿到空世界——`snapshot` 先解析一次，
  不可用就一律按主营地服务（`camp:null`，`survival` 有值）；`camp.name` 只从索引取，**绝不回显请求原语**。
  闸门 SA11：`?camp=../etc/passwd` 与格式合法但未登记的键都断言 `camp===null && survival!==null` 且载荷不含输入；
  拆掉回落行即红。
- **N3（必修）**：`host.touch` 先用 `validCampKey` 验一次，非法/未登记键不写 `S.campViewers`
  （否则每个乱码 URL 都留一条永久记录，污染三态调度的观看判据）。闸门 `camp-viewers.test.mjs` 覆盖。
- **lint 盲区**：`scripts/check.mjs` 增加一次**真 `import('web/app.js')`**，只接受非 SyntaxError 的失败
  （`ReferenceError: document is not defined` 是预期）。验红：在文件末尾注入 `let broken = (((;`，
  旧 lint 打"✔ 通过"，新 lint 报 `✖ 真 import() 失败：Unexpected token ';'`。
- **顺手**：回主菜单时保留 `?camp=`（隐私模式下 URL 是唯一凭据，否则面板会显示主营地的对话）。
- 更正上一轮的归因：`node --check` 漏报**不是**"重复声明不算语法错"，而是 `package.json` 没声明 `type`，
  含 import 的 `.js` 先按 CJS 解析、失败后重探为 ESM，重探只报前半段——Qoder 的定位是对的。
### 第四轮核验：观看打点不得兜到"最后打开的营地"（N4，2026-11-16）
- **P1-N4**：`host.touch` 原先用 `campKey ?? S.campKey` 判定打点对象，而 `S.campKey` 是全局"最后一次被打开"；
  于是任何**不带 camp 的主营地轮询**都会把别人的分名字营地标成"有人看" ⇒ 三态调度被绕过、该营地恒用真模型，
  同时 `served` 读数会说谎。现在只认请求自带的 camp（`campKey ?? 'MAIN'`），`S.campKey` 仅留给 healthz 读数。
- 闸门 `life/camp-watch.test.mjs`：`openCamp('阿禾')` 后一次 `touch('survival')` ⇒ `campViewerKeys()` 必须含
  `MAIN` 且不含该营地 key；明确带 key 时才打点。负向对照：恢复 `?? S.campKey` ⇒ 红（已验、字节还原）。
- 登记两条（非缺陷）：`validCampKey` 经 `campSurv` 可能触发磁盘载入（校验带 I/O 副作用）；lint 会**真执行**
  `web/app.js` 顶层（目前只会以 ReferenceError 收场，但新增了执行面）。
### 测试隔离修复
- `host.mjs` 的 `dir` 改为 getter：测试在同一进程里晚设 `DATA_DIR` 时，写入不再落回仓库 `./data`
  （覆盖率跑动时暴露的真实污染；清理后又跑一遍确认不再生成）。
- `act-save-coalesce` 的两个时序断言由固定 `sleep` 改为轮询（覆盖率插桩下不再抖）。
## [0.1.4] - 2026-11-15

### 模型适配（同窗口另一会话提交，随本版一并发布）
- `needsNoThink` 从只认 `3.8` 放宽到全部点号小版本 `Qwen3.x`（3.5/3.8…），无点号的历史命名保持原口径；
  新增 `scripts/probe-model.mjs` 选型探针（不写盘、不回显密钥）。


### 渲染（2026-11-15，参考 Harrowfield / Room at Dawn 的两条）
- **室内外分开曝光**：`render()` 新增 `exposure` 参数并接到片元着色器；室内（`room` 分支）压掉室外太阳直射到 85%、
  曝光提到 1.10，室外保持 1.0。实测：室内截图 52.4% 像素变化且整体更亮更暖；**室外 0.56%（仅动画/天气差异）**，
  确认没有连带改动。
- **炉火闪烁升级**：原先单频 `sin(motionTime*6)`，改为三层频率叠加 + 偶发下探，强度夹在 [0.42, 1.02]，
  仍只由表现层时钟驱动（不进世界 tick、不消费 rng）。
- **炉火加法假体积光**（Harrowfield）：核心火光之外再叠一层更宽、随高度衰减的光晕，强度与闪烁共用 `uHearth.w`。
  实测（夜间 `home` 室内）：6.35% 像素变化，暖光圈明显外扩且更柔。室外不传 `uHearth` ⇒ 零影响。
- 白天验收：把时钟推进到 12:00（服务端 12 次 step）再进同一间屋，室内没有过曝、窗玻璃转日间色，说明曝光分离在昼间也成立。- **窗光"白天因子"通道（已落地，替代原先回退的静态烘焙）**：不新增顶点属性，渲染器接收
  `windows`（窗心 x / 窗 z / 半宽）与 `daylight`（0..1），片元里用 `windowPool()` 以窗为源做
  横向 + 进深 + 高度三重衰减，强度乘 `daylight` ⇒ 白天有、夜里归零。
  验收：正午室内 **11.08%** 像素变化，窗下地板平均色 **(134,97,60) → (211,153,91)**；
  同一采样点夜间 **(103,79,57) → (104,79,57)** 基本不变。
  过程中抓到两个真 bug：① 函数被误插进顶点着色器 ⇒ 整个 3D 初始化失败（截图直接报"不支持 WebGL"）；
  ② `solarLight` 在室内以 `indoor:true` 调用会把 `direct` 置 0，导致白天因子恒为 0 —— 改为用"室外视角"再算一次。
  这两个都是**肉眼/像素差看不出来**的：只有把窗光临时改成纯红注入，才看出通道根本没执行（此前的 3.64% 是闪烁噪声）。
## [0.1.3] - 2026-11-15

### 性能（2026-11-15，按压测结论）
- `TRACE_CAP` 默认 **2000 → 400**（只影响诊断轨迹，不落盘、不参与决策）：
  实测 heap ~166→118 MB、RSS ~433→373 MB，存档体积不变。
- 地形构建加**显式加载态**：首帧不在绘制任务里同步建世界，先让浏览器画出「正在生成地形…」，
  下一个任务再同步构建，构建完强制重绘一帧。
  实测（longtask 观测器）：那一次构建仍是 **967 ms 的长任务**（`paintTerrain` 约 600 ms，
  且它的产物 `terrain` 同时喂碰撞与 3D 可行走性，不能只延后贴图）；加载文案在 250 ms 出现、
  1215 ms 收起 ⇒ 这 967 ms 现在**是可见的加载态**，不再是"画面卡死"。
  彻底的异步化（构建与碰撞解耦 / 移入 Worker）留到功能冻结后，因为需要同时给移动加门禁。
### 清理（性能与一致性）
- 删掉 `buildWorld` 里已无消费者的 2D 对象登记（`objects` 列表与两段 house 登记，约 11 行）：
  2D 视口删除后它仍每轮缓存未命中时构建一次，但没有读取方。实机复测 `renderer="3d"` 正常。

### 压测结论（2026-11-15，本机）
- 服务端：3500 刻后 heap **~191 MB**（t≈3000 起进入平台期，不是泄漏）、RSS ~443 MB、`world.json` **1.5–1.7 MB**
  （占最大的是 15 个角色的记忆各行 400 条 ≈1.6 MB）。`TRACE_CAP=400` 可省约 **48 MB heap / 60 MB RSS**，存档不变。
- 客户端：帧耗时 p50/p95 = **16.7/16.7 ms**，但有 **一次 ~1.0 s 的启动卡顿**（`buildWorld` 同步画地形贴图 + 建场景）；
  页面 JS heap ~123 MB。headless 是软件渲染，真机会更快，但这 1 s 是 CPU 侧工作，真机同样存在。
## [0.1.2] - 2026-11-15

### 重构（web/app.js 阶段 3/4）
- `web/player-move.mjs`：行走几何（`TILE` / `rectGap` / `campBodyWorld` / `exteriorAllows` /
  `detourAroundBodies` / `routeForWalker`）从 `app.js` 抽出。都是纯函数，不读 DOM、不读模块级状态、不消费随机。
  `exteriorAllows` 的返回值由 `undefined` 收紧为真布尔（调用点都在布尔上下文，判定不变）。
- `web/net.mjs`：`postJson()` + `persistNotices()`。后者把"存档失败要不要提示"变成可单测的纯函数，
  DOM 提示留在 `app.js` 的薄包装里。
- `life/player-move.test.mjs`：8 条闸门（矩形距离、身体半径挖边、外部可走性、通路/封死寻路、
  绕人不改写栅格、存档提示判定、POST 形状与非 2xx 抛错），每条都写了变红法。
- `scripts/check.mjs`：新增**具名导出检查**——`node --check` 只查语法，抓不到
  "does not provide an export named"。检查支持 `export const A=1, B=2;` 的多声明符（首版只取第一个，
  造成过 `WORLD_TH` 假阳性，已修）。

### 已知边界
- 未搬的 7 个函数（`stepCampWalker`/`syncPlayerPos`/`savedOuting`/`peripheralStepCap`/`playAct`/
  `comparisonContact`）都抓着 `S`、`life3d`、`sessionStorage` 或 DOM；搬它们要拉一个很宽的上下文对象，
  收益是行数、代价是回归面，冻结前不做。
- **本版本只做 3D（2026-11-15 决定）**：2D 游戏视口与 2D 碰撞工作台已删除，仓库里不再有第二套俯视渲染。
  没有 WebGL 的设备会看到明确说明，入口按钮一并禁用。
  *保留*：`paintTerrain` / `terrainPixels` / `paintForestFloor` / `outskirtsAtlas` / `campOutskirts` 与
  `buildWorld` 的离屏画布——它们产出的正是 3D 着色器采样的 `uGround` 贴图与 `uWater` 掩码，删了就掉地面与水面。
  *受影响*：手工碰撞覆盖（原本只在 localhost 生效、存在浏览器 localStorage）不再参与判定；线上行为不变。
### 修复（审计 2026-11-15）
- **occupancy 存档往返**：判据从"键数相等"改为"逐房间成员集合一致"。引擎会为"去过又离开"的房间保留空数组，
  所以旧判据让真实存档永远走重建分支 —— 同屋顺序被按 `loc` 键序重排（实测 `a2,a1 → a1,a2`），
  且 `save→load→save` 不幂等。现在顺序与空键都保留；存档与 `loc` 冲突时仍然重建。
- **空 `flags` 不落盘**：避免重载后被 `applyInto` 补成 `{}` 从而在第二次落盘时多出一个键。
- 新增 `life/archive-roundtrip.test.mjs` 三条闸门（顺序保留 / 往返幂等 / 冲突必须重建），均已验红。
- **菜单主题不再被世界场景音频接管**：`syncAudioScene` 加 `ui.menu` 守卫（旧实现里 `audio.scene()` 会无条件把
  `state.menu` 置 false，点「主菜单」后菜单曲最多活一次轮询就被营地音乐顶掉）；首次手势解锁后补起菜单主题；
  离开菜单时显式交还。闸门 `frontend.test.mjs` F8（已验红）。
- **渲染连续失败不再每帧刷日志**：加连续失败计数与上限 5；只在第一次 `console.warn`，到上限停试并换成
  「已停止重试」文案；故障提示改为持续可见（此前会被 `renderPlayMode` 每轮重置隐藏，实测截图完全看不到）。
  实测：注入"每帧渲染失败"后日志从 **26 条降到 1 条**。闸门 `frontend.test.mjs` F9（已验红）。
- **存档版本号 `schemaVersion`（默认不改变旧档行为）**：新档写入 1；**旧档没有该键 ⇒ 视为 1 照旧载入**；
  更高版本**只警告不拒载**（否则回滚到旧程序会把线上实例卡死）；非数字则忽略并警告。
  闸门 `life/archive-schema.test.mjs` 四条，均已验红。
- **动作落盘可合并（`ACT_SAVE_COALESCE_MS`，默认 0＝逐位不变）**：开启后窗口内的连点只写一次，
  `stop()` 会把待写盘踢起来。实测每次成功动作整档落盘约 454 KB（加 `.bak` ≈908 KB），
  这是给"点太快导致卡顿"留的开关，默认关。闸门 `life/act-save-coalesce.test.mjs` 两条，均已验红。
## [0.1.1] - 2026-11-13

### 生存机制整合

- 合作任务提供居民候选，移动、采集与施工由居民自身决策执行并计入行动成本和经验。
- 玩家死亡后可继续观察居民、生命周期与生态。聚落危机和衰亡单独记录。
- 角色选择住所和备粮目标后沿基础动作推进，奠基耗材后直接转入施工。野莓使用共享环境存量，旱寒会减缓恢复。
- `GAME_MODE=game` 只推进生存世界。玩家操作、模型审议、睡眠和存档串行处理；默认离线补时上限为 120 刻。

### 新增
- 玩家个人生存：与居民同一套存续/驱动（基础代谢、动作成本、日配给、死亡与终局），不再是无风险的观察者。
- 居民对话：空手 F 打开输入框；自由文本由真实模型（DeepSeek / 本地 qwen32b）生成台词，服务端按关系/心情/性格裁决态度——可拒绝、无视、因等待不耐烦走开、被冒犯后发火甚至动手。模型不可用时退状态条件化模板。

### 变更
- 玩家动作与 AI 同权：全部经规则层 validate 裁决（此前构造请求可在任意地点收种存取）。
- 吃/容器/托盘接线：吃饭回补存续（需托盘餐具）；家里容器成为公仓缺口的第一层缓冲；木托盘有实际用途。
- 繁衍门槛改为「已婚＋同住＋有床」；兑换上限使用 effectiveMods（谷仓 +12 生效）；风暴与预警跟随 world.seed；工具提示 1–8。

### 研究口径
- 基线复抓#14（玩家同权日耗、seed 修正）；G2/P2-4 改测损伤事件，P2-7 改测 won＋存粮＋损伤＋实收（披露见 phase1-plan §20）。

本文件对应 `package.json` 的 `version`。仓库此前没有版本号，也没有 tag；从 `0.1.0` 起按语义化版本走。

## [0.1.0] - 2026-11-09

首个可试玩 + 可复现的版本。此前的 40 次提交（2026-11-07 → 11-08）是它的形成过程，按主题归并如下。

### 新增
- 微型生活世界引擎：13 层架构（时钟 / 载体 / 感受器 / 反射弧 / 调制 / 需求 / 评价 / 动机 / 行为状态 / 规则校验 / 反应器 / 记忆 / 思考层 / 自我维持）。
- 判据装置：消融矩阵、5 seed 复核、受损速度、恢复动力学、代谢账、变异电池（4 套共 28 条变异）。
- `town` 演示世界（8 房间 / 天气 / 工坊 / 交易 / 接济 / 结伴 / 群体规范 / 台词）与 `lab` 研究世界。
- 服务端持久化 + 平台休眠补时 + 内置种子固定历史起点；`/world` `/act` `/ctl` `/chat` `/healthz` 五个端点。
- 测试入口 `npm test`（发现式点名）、静态检查 `npm run lint`、覆盖率 `npm run coverage`（均为 Node 内建，零依赖）。

### 新增（工程面，2026-11-09 收尾）
- `package.json` + `npm run lint / test / coverage / check` 单一入口；测试改为**发现式**点名（不会再漏文件）。
- 静态检查 `scripts/check.mjs`：语法 166 文件、相对 import 图、JSON 解析、库层禁 `console.log`、引擎禁 `Math.random`、测试禁 `.only`。
- 覆盖率取 Node 内建 `--experimental-test-coverage`：行 95.3% / 分支 87.6% / 函数 93.6%（43 个被套件加载的模块）。
- `evidence/` 随仓库发布五份基准读数与配对读数；`EVIDENCE.md` 说明每条结论怎么自验。
- 消融矩阵新增 **`--paired` 配对对照模式**（同一人格、同一 rng 起点，只换通道）。

### 变更（研究口径）
- **装置更正 #1**（`PLAN §37`）：驳回重选后必须再过一次规则层，默认决策路径因此改变，五份面 md5 重标。
- **装置更正 #2**（`PLAN §38`）：习惯层不再绕过规则层（此前 50159 次执行里有 693 次非法动作真的改世界）、
  关系写入统一夹到被侵蚀的上限；五份面再次重标。
- `--viab` 输出增加两行披露（"饥馑"档只在头 55 刻真饥馑），表格数字未变。

### 修复（2026-11-09 三批，均配"注入即变红"的闸门）
- 规则层：习惯分支先 `validate`；`execute()` 入口补结构性裁决。
- 宿主：畸形 URL 不再打死进程；tick 串行化（`step`/`stop`/`reset` 三个绕过口已堵）；tick 异常不再中断整条 tick；
  坏档隔离留底 + `.bak` 轮转；存档写入串行化 + 唯一临时名；结构不完整/字段类型非法的档被识破。
- 安全：`/chat` 默认关闭 + 鉴权 + 与内部同一本预算账；写路由要求 JSON + 同源 + 可选 `CTL_TOKEN`；
  `reset` 需 `confirm`；静态面白名单 + realpath；`/healthz` 不再回显数据目录与供应商端点。
- 数据：人格参数、当日账、评价注入队列、喊住状态、规范播报游标全部随档；记忆落盘 120 → 400 行；
  `occupancy` 顺序随档；`M3_COMMITMENT` 变小不再把合法档当损坏。
- 资源：`trace` 加环形上限（原无上限，约 628 MB/天）；信号监听器不再泄漏。
- 前端：串行轮询 + 后台停轮询；存档失败/tick 异常上页面；重置带确认。

### 已知限制（未修，已登记）
- 默认档不会产生存续损失（三次尝试把稀缺做成内生，均判死）。
- `catchUp` 只补调制与需求，不补代谢与损伤；RNG 状态不落盘；A/B 两侧是两次人格抽样。
- `MAX_CALLS_PER_TICK` 默认关；开启后单拍额度偏向 A 侧（不用于对照实验）。
- 约 80 个一次性测量脚本不在测试覆盖内。

### 改量#12（2026-11-12 §17 产出循环，所有者已裁定「选 A」并完成）
- 新增 `forage/exchange/expand` 三动作；终裁 AI 也自动兑换，玩家与 AI 在自动触发层与 `actuate` 裁决层完全同权。
- `OFF_BASE`/`BASELINE3` 重抓为**复抓#13 = 改量#12 终值**；#11、#12 两版哈希留痕在 `phase-e-sweep.mjs`。
- 按 §18 先例登记：`E1a/E1g` 的「E1 安全网代劳收种」判据作废，改测「AI 自主收种」`aiActions`
  （实测安全网 `forageStats.harvest = 0/1/0`，AI 自主 `harvest = 2/3/4`），作废原因与实测数字写进测试注释。
  `P2-4 / P2-7` 在新平衡下自行恢复，未改判据。`npm run check` → 377/377 全绿。
- HUD 面板重排：11 行压成 2 行 + 2 折叠、地点导航去重、顶栏改为真移动玩家、折叠状态跨轮询保持。
