# 像素工作台

> **文档状态：现行（2026-11-21 随 v1.6.0 刷新）。** 工作台已移出运行时目录 `web/`，现位于 `tools/pixel-editor/`（P0，2026-11-19）。

入口：`tools/pixel-editor/pixel-editor.html`，也可双击根目录「打开像素工作台.cmd」。建议使用 Chrome 或 Edge（需要 File System Access API）。

## 选图与编辑

素材现为 **20 张 PNG**：16 张地形 tile + 4 张 HUD 头像（`web/assets/actions/portrait_*.png`）。打开即展示这批素材的缩略图，可按分类或中文名称/文件名搜索。索引是 `tools/pixel-editor/editor-catalog.js`，由 `node scripts/editor-catalog.mjs` 或 `npm run actions` 更新；连接项目根目录后，浏览器会重新枚举实际 PNG，不依赖预置索引。

点击图片进入编辑。第一次编辑时浏览器会要求选择项目根目录 AMBRACElife，这是本地文件读写授权。

「返回素材库」不丢弃当前修改。重新点击同一素材继续编辑；有未保存修改时切换其他素材会询问是否放弃。刷新或关闭前先保存，未保存内容不保证跨页面重载保留。

## 保存

「保存素材与覆盖稿」同时更新实际 PNG 和 `tools/pixel-editor/pixel-overrides.json`（覆盖稿）与 `asset-collisions.json`（碰撞稿）。覆盖稿保存整张素材的色板索引。

重新生成时应用覆盖稿的**只有头像**：`npm run actions`（`scripts/gen-actions.mjs`）会重画 4 张 `portrait_*.png` 并套用覆盖稿。**16 张地形 tile 已没有生成器**（旧的 `gen-pixel-assets.mjs` / `pack-assets.mjs` / `npm run assets` 已在 1.5 前删除），直接改 tile 就是改 PNG 本身——改完必须跑 `npm run art` 重钉 `art-hashes.json`，并在 `CHANGELOG.md` 里写明"外观变了"，否则 `npm run check`（含 `art:check`）会红。

删除某项覆盖前先备份；覆盖稿不是修改历史，撤销记录只在当前编辑会话中存在。「导出 PNG 副本」用于额外备份，不会写回项目。

该工具不修改引擎、世界状态或服务端，也不在 Docker 镜像里。

## 验证状态

上一版文档里的「313/313 回归 + 95 张素材」是 2D 素材管线时代的读数，**已不适用**。本轮文档刷新（2026-11-21）没有重跑工作台的浏览器回归；现行全量闸门是 221 个测试文件 / 1261 条（`npm test`），其中不包含工作台 UI 的自动化用例。工作台改动请按"保存 → `npm run actions`（头像）或直接改 PNG（地形 tile）→ `npm run art` → `npm run check` → 真机看一眼"走。
