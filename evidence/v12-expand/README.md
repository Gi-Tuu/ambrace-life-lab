# 证据 · 1.2 荒野扩建 + 居民室内自由移动（2026-11-21）

基线：`main` HEAD `e25a761`（1.2 时间节奏已改）。`master` 不动；未 push、未部署。
所有命令都在仓库根目录跑，Chrome 为本机真实浏览器（CDP）。

## 闸门结果

| 闸门 | 结果 | 证据 |
|---|---|---|
| 全量测试 | **1207/1207 pass**，211 文件，81.3s（基线 1193 + 新增 14） | `full-test.log` |
| 静态检查 | PASS：496 文件 · 211 测试文件 · 架构闸门 351 文件/12 白名单 | `check.log` |
| 金样 | **45/45，diffs 0**（vs `p3-final`） | `golden-compare.json`、`golden-v12-expand.json`、`evidence/redo-p0/v12-expand*.png` |
| 22k parity | 2×11000 点 terrain/walk/height/portal/bridge **全 0** | `parity.json`、`parity.log`、`parity-console.log` |
| 研究五面 md5 | **5/5 与 P3 台账逐位相同**（rerun） | `research-md5.log`、`research-md5.json` |
| quickstart | PASS（走/采集/吃/睡/HUD/死亡后世界继续） | `quickstart-browser.log` |
| 浏览器 A/B | PASS：8 地块全部可站、路线 4–32 点；认领/重复拒绝/3 次施工完工/入口/碰撞；室内 10s 两名居民各移动 0.375、9 个采样点全部可站、loc 不变、玩家不动 | `browser.json`、`browser.log`、`wild-built.png`、`room-indoor.png` |
| 红测（负控）| 去掉 `stepRoomWalk` 钩子 ⇒ `V12-ROOM-05` 红（5 pass/1 fail）；让未认领地块漏进几何 ⇒ `V12-EXP-02` 红（7 pass/1 fail），两处变异都按 sha256 还原 | `red-room-walk.log`、`red-wild-zero-geometry.log` |

## 复现命令

```bash
node scripts/test.mjs
node scripts/check.mjs
node scripts/v12-expand-browser.mjs
node scripts/quickstart-browser.mjs
node scripts/redo-p0-golden.mjs --label v12-expand
node scripts/p2-golden-compare.mjs p3-final v12-expand
PARITY_OUT=v12-expand node scripts/p2-space-parity.mjs
node evidence/v11-research/run-research-md5.mjs --rerun
```

## 探针（可重跑，只读）

- `probe-wild-plots.mjs`：生成确定性/数量/可站/路线逐点可走/耗时（seed 0/7/13/41/72/123456）。
- `probe-wild-e2e.mjs`：认领→施工→完工→房间空间→存档往返（seed 13 / layout 2）。
- `probe-room-walk.mjs`：3 名居民 40 分钟室内走动，逐分钟 walkable/分离采样。

说明：`node scripts/p2-space-parity.mjs` 自身会写 `evidence/<PARITY_OUT>/parity.log`，所以控制台输出另存为
`parity-console.log`，避免与本目录 `parity.log` 冲突。
