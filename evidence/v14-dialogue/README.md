> 历史快照（当时版本），现行口径见 README/CHANGELOG。

# v14-dialogue 证据

1.4 玩家主动对话 + 居民注意力（2026-11-21）。报告：`docs/回报-1.4-主动对话-2026-11-21.md`（docs/ 按仓库规则不入库）。

- `full-test.log` / `check.log`：全量 1238/1238、静态/架构检查。
- `quickstart-browser.log`：quickstart 真实浏览器。
- `golden.log` / `golden-compare.log`：45/45，diffs 0；截图与 JSON 在 `evidence/redo-p0/v14-dialogue*`。
- `parity.log` / `parity.json` / `parity-console.log`：2×11000 点全 0。
- `research-md5.log`：研究五面 5/5 逐位相同；台账在 `evidence/v11-research/research-md5.json`。
- `browser.json` / `browser.log` / `dialogue-bubble.png` / `dialogue-panel.png`：名字气泡、4 话题、两轮、关闭、世界钟继续走。
- `red-*.log`：四条变异红测（attention 跳过点、清理、话题按钮、朝向）。
