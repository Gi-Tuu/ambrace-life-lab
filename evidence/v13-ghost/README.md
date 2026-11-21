> 历史快照（当时版本），现行口径见 README/CHANGELOG。

# 证据 · 1.3 幽魂观察（2026-11-21）

基线：`main` HEAD `b66607c`（1.2.0）。`master` / tag `v1.2.0` 未动；**未 push、未部署**。
所有命令在仓库根目录运行，浏览器闸门用本机真实 Chrome（CDP headless）。

## 闸门结果

| 闸门 | 结果 | 证据 |
|---|---|---|
| 全量测试 | **1230/1230 pass**，215 文件，73.2s（1.2 基线 1215 + 新增 15） | `full-test.log` |
| 静态检查 | PASS：语法 505 文件 · 测试 215 · 架构闸门 356 文件/12 白名单 | `check.log` |
| 金样 | **45/45，diffs 0**（vs `p3-final`） | `golden-compare.json`、`evidence/redo-p0/v13-ghost*.json/png` |
| 22k parity | 2×11000 点 terrain/walk/height/portal/bridge **全 0** | `parity.json`、`parity*.log` |
| 研究五面 md5 | **5/5 与 P3 台账逐位相同**（rerun，35.2s） | `research-md5.log`、`research-md5.json` |
| quickstart | PASS：走 2.1 tile / 3.0 tile/s；死亡后横幅「你已化为幽魂」、世界 970→972、动作被拒、镜头平移 6.999/缩放 | `quickstart-browser.log`、`evidence/score/quickstart-browser.log` |
| 幽魂浏览器 | PASS：睡梦中死→幽魂；7 类动作全 `PLAYER_DEAD`；WASD 平移 8.399、滚轮缩放、点居民跟随 a1；+120 游戏分世界推进、居民动作 3994→4050；刷新仍观察；灭绝 `ended/extinct` 且刷新后持久 | `browser.json`、`browser.log`、`ghost-observe.png`、`ghost-reload.png`、`extinct.png` |
| 红测（负控） | 4 处变异全部按预期变红，逐字节还原 | `red-action-gate.log`、`red-ghost-persist.log`、`red-sleep-death.log`、`red-camera-pick.log` |

## 红测（负控）说明

| 变异 | 期望红 | 实测 |
|---|---|---|
| 去掉 `survAct` 顶部幽魂闸门（`if (false && …)`） | 幽魂动作被放行 | `GHOST-02` 红（7 pass / 1 fail） |
| `restoreGhost` 直接 `return null` | 旧档（无 `ghost` 字段）不能补齐 | `GHOST-04` 红（7/1） |
| 去掉睡眠循环的“死亡当刻 break” | 睡梦中死不转幽魂/睡眠跑完 | `V13-GHOST-HOST` 红（0/1） |
| 居民点选投影用 `VIEW_W` 而非画布 backing 宽度 | 点居民无法跟随（焦点落到地面） | `v13-ghost-browser` 红：`点居民没有跟随：期望 a1 …follow:null` |

## 复现命令

```bash
node scripts/test.mjs
CHECK_INPROCESS=1 node --experimental-vm-modules scripts/check.mjs
node scripts/quickstart-browser.mjs
node scripts/v13-ghost-browser.mjs
node scripts/redo-p0-golden.mjs --label v13-ghost
node scripts/p2-golden-compare.mjs p3-final v13-ghost
PARITY_OUT=v13-ghost node scripts/p2-space-parity.mjs
node evidence/v11-research/run-research-md5.mjs --rerun
```

说明：
- `scripts/p2-space-parity.mjs` 自身写 `evidence/v13-ghost/parity.log`，控制台另存 `parity-console.log`。
- `research-md5.json` 是工具固定输出（`evidence/v11-research/`），此处留一份快照；`research-md5.log` 是本次 rerun 的控制台记录。
- 金样采集文件按惯例落在 `evidence/redo-p0/`（`v13-ghost.json` + 3 张 png），对照结果在本目录与 `evidence/redo-p2/golden-compare.json`。
