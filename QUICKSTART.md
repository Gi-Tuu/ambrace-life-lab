# 5 分钟快速开始

目标：从零到看见一个会自己走、会吃饭、会睡觉、会死的世界。下列路径保留 1.6.0 历史实跑记录，日志见 [`evidence/v16-livestock/quickstart-browser.log`](./evidence/v16-livestock/quickstart-browser.log)。当前源码核对 main `709f02b`（包版本仍 1.6.0）；后续改动的当前浏览器/线上验收及多人采样待核实，历史记录不是当前部署证明。

## 3 条命令

需要 Node **22+**，零第三方依赖（不需要 `npm install`）。

```bash
git clone https://github.com/Gi-Tuu/ambrace-life-lab.git && cd ambrace-life-lab
node --version                                  # 应为 v22 或更高
GAME_MODE=game GAME_RULES=1 node serve.mjs      # 打开 http://localhost:7860
```

Windows PowerShell 第 3 条改成：

```powershell
$env:GAME_MODE='game'; $env:GAME_RULES='1'; node serve.mjs
```

> `GAME_RULES=1` 才启用正式游戏规则层（研究世界的读数不受影响）。不设这两个变量时默认是研究态（`GAME_MODE=research`、`GAME_RULES` 关），世界仍会跑，但不等同正式游戏配置；当前线上配置待核实。端口用 `PORT` 改，存档目录用 `DATA_DIR` 改。

## 5 分钟真实路径

| 时间 | 做什么 | 实际按钮 / 读数 |
|---|---|---|
| 0:00 | 起服后打开 `http://localhost:7860` | 菜单出现「生存模式」卡片 |
| 0:30 | 进游戏 | 点 **「继续生存」**；没有存档时点 **「新开一局」**。名字营地输入名字后点 **「进入 / 开新营地」**（名字/key 仅定位，凭据是浏览器的 `camp_owner` cookie；同名非 owner 不能接管，已登记营地的 `/world` 只给访客摘要投影） |
| 1:00 | 走 | **WASD / 方向键**走路，**Shift** 奔跑；页面顶部 **「生存游玩」** 进入单世界，**「世界全景」** 切俯视 |
| 1:30 | 看 HUD | 左上 `季节 / 第 N 天 / 天气`；`体力 · 存续 · 今日动作已用 N 分`。时间是一条连续游戏钟（默认 1 游戏分 = 6 秒真实时间，1 天 1440 分 = 144 现实分钟）；`今日动作已用` 只是日统计，不限制行动。正式路径**没有**「每刻 60 分池」，也不会返回 `TIME_WAIT`——那是研究态/旧路径的兼容码 |
| 2:00 | 采集 | 走到 **瞭台 / 井台**，按 **3** 选 **镐**，靠近石堆按 **F**（或点石堆）；到 **院子 / 树林** 按 **2** 选 **斧** 采木。种子档里院子木料可能已采空，瞭台/井台更稳 |
| 2:45 | 吃 | 走到 **公仓**，点谷仓，选 **「在公仓吃一份」**（只有能量 ≤ 0.6 时按钮可用；每天一份）。也可以回居所点餐桌，先放食物再吃，但需要木托盘 |
| 3:30 | 睡 | 回 **居所**，点床，选 **「躺下睡觉」**。白天返回约 4 刻，夜间睡到天亮；HUD 的世界时间随之前进 |
| 4:15 | 死亡后转幽魂观察 | 让存续归零（不吃饭/受伤）。页面出现 **「你已化为幽魂，聚落仍在继续」**：世界刻仍在前进，居民继续生活；用 **WASD 平移镜头、滚轮缩放、点居民跟随**，HUD 切到「幽魂观察」，可暂停/倍速。点 **「重新开始（放弃观察）」** 才会手动开新一局；真正的终局只有聚落灭绝 |
| 5:00 | 自查 | 页面左上「研究面板」可看事件/回放；`/healthz` 看服务与存档状态 |

> 上面这条路径由 `node scripts/quickstart-browser.mjs` 用真实 Chrome 跑过（1.6.0 复跑）：起服 → 点「继续生存」 → 按 D 走路（位移 2.15） → 瞭台采石（0→2） → 公仓吃一份（17→16） → 睡觉（4 刻，世界刻 966→970） → 死亡后转幽魂横幅出现、世界刻 970→972、动作被拒、镜头可平移/缩放。日志原文见 `evidence/v16-livestock/quickstart-browser.log`；完整幽魂/灭绝路径见 `node scripts/v13-ghost-browser.mjs`。

## 哪些默认关 / 研究态怎么开

- **机制层默认关**：M3 目标承诺、M4 耦合调制只在 **「研究对照 A/B」** 页面出现，且只叠加在 A 侧；B 侧是切断状态通道的负向对照。演示开关不落盘，重启回到关。
- **正式游戏规则层默认关**：`GAME_RULES=1` 才启用游戏价目/分类粮仓/灯火燃料等；研究世界逐位保持旧表。`GAME_MODE=game` 只推进生存单世界，`research`（默认）同时推进旧城镇 A/B 研究预设。
- **真实模型默认关**：默认 `BRAIN=local`，居民走确定性替身。要接模型：`cp .env.example .env`，填 `MODEL_PROVIDERS` / `MODEL_KEYS` / `MODEL_NAME` 并设 `BRAIN=model`，再 `node --env-file=.env serve.mjs`。没配端点时世界照常跑。
- **研究态**：离线复现用 `node life/run.mjs --report` 等五份面（见 [EVIDENCE.md](./EVIDENCE.md)）；在线研究态是默认的 `GAME_MODE=research`，不要开 `GAME_RULES`。作者侧消融/负控见 [BENCHMARK.md](./BENCHMARK.md)。
- **死亡**：玩家个人死亡＝化为幽魂，继续观察世界（不能操作角色）；聚落灭绝才是这一局真正的终局。两种情况下自然生态都继续演化。

## 存档与对照在哪

| 内容 | 路径（默认 `DATA_DIR=./data`） |
|---|---|
| 主营地 | `data/world.json`（每次保存留 `world.json.bak`） |
| 名字营地 | `data/saves/<32hex>.json.gz` + `data/saves/index.json` + `saves/<key>.owner.json` |
| A/B 对照 | `data/comparison.json` |
| 坏档隔离 | `data/quarantine/`（启动失败时保留现场，不覆盖） |

正式游戏的居民自由输入走 `resident-dialogue.mjs`：服务端定态度/关系后果，模型只写措辞，不可用时退模板。`npc-memory.mjs` 将事件、对话、承诺、知识统一持久化并跨会话检索；研究/对照路径不启用该统一层。

名字营地在线备份为 `/export`、`/import`，须配置独立 `SAVE_EXPORT_TOKEN`（默认关闭），仅覆盖名字营地，导入不覆盖已有 owner 的营地；备份包含归属信息，应私下保存，详见 SECURITY.md。

停服后可用 `node scripts/archive-saves.mjs` 归档三种存档并在恢复前校验哈希。`data/` 不入库；换 `DATA_DIR` 即可开一份干净世界。

## 卡住了先看

1. 页面一直「正在连接生存世界…」：看终端有没有 `就绪`；端口被占就设 `PORT`。
2. 点了采集没反应：HUD 会显示失败原因（如「这里的资源采空了」「太远了，得走过去」「体力不够」「手上还有没做完的动作」）。旧研究态的「本刻可用时间已用完 / 每刻 60 分池」在正式路径已不再出现。
3. 页面提示「当前入口的生存服务版本较旧」：用仓库根目录的 `node serve.mjs`，不要用其它静态服务器。
4. 想从零重来：停服删 `data/`（或换 `DATA_DIR`），再起服；页面点「重新开始」只重置当前营地，不删旧档。

更细的模块边界与已知限制见 [ARCHITECTURE.md](./ARCHITECTURE.md)；完整变更见 [CHANGELOG.md](./CHANGELOG.md)。
