> 历史快照（当时版本），现行口径见 README/CHANGELOG。

# v15-chat 证据

1.5 玩家自由对话 + 居民互聊模型措辞（2026-11-21）。报告：`docs/回报-1.5-自由对话-2026-11-21.md`（docs/ 按仓库规则不入库，留在工作区）。

- `full-test.log`：全量 **1248/1248**（219 个测试文件；1.4 基线 1238 + 本轮 10 条 V15）。
- `check.log`：静态/架构检查通过（语法 516 文件、测试 219、架构 363 文件/12 白名单）。
- `quickstart-browser.log`：起服→生存→走→采集→吃→睡→死亡转幽魂 PASS。
- `golden.log` / `golden-compare.log`：**45/45，diffs 0**（vs `p3-final`）；截图与 JSON 在 `evidence/redo-p0/v15-chat*`。
- `parity*.log/json`：2×11000 点 terrain/walk/height/portal **全 0**。
- `research-md5.log`：研究五面 **5/5** 逐位相同（33.1s）。
- `browser.json` / `browser.log` / `browser-run.log` / `free-input.png` / `thinking.png` / `free-multiturn.png`：自由输入框与 4 个快捷话题同时可见、等待时“对方正在想…”、两轮上下文引用、快捷话题仍可用、关闭后世界钟继续走。
- `red-context.log`：删掉 prompt 的会话摘要/最近对话 → V15-01 红（不能接“你刚才说…”）。
- `red-fallback.log`：删掉模板回退 → V15-03/08 红（NO_LINE / 超时不 ok）。
- `red-lock.log` / `red-lock-control.log`：把模型等待放进 `queueAct` → 普通输入 350ms 未返回（RED）；还原后 350ms 内返回（OK）。
- `red-budget.log`：去掉 `modelChannel` 预算闸门 → 预算耗尽后仍走模型（V15-09 红）。
- `red-ui-row.log` / `red-ui-row.png`：再次隐藏 `#talkRow` → 浏览器闸门红（“自由输入框没有显示”）。

复现命令见报告第 7 节。所有模型闸门只使用本机 127.0.0.1 假供应商，不读取/回显 `.env` 的真实 key 或端点。
