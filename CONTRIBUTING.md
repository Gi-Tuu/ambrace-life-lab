# 参与 / 复现说明

这个仓库是单人项目，没有值班表、没有工单委员会。下面的约定是作者自己用的，第三方照着做也能跑。

## 环境

- Node **22+**（零第三方依赖，不需要 `npm install`）
- 可选：Docker（镜像用法见 `Dockerfile`）

## 三条命令

```bash
npm run lint      # 静态检查：语法 + import 图 + JSON + 引擎纪律 + 测试纪律
npm test          # 39 个测试文件 / 299 条断言（发现式，自动点名 life/*.test.mjs）
npm run coverage  # 同上，附带 Node 内建覆盖率
```

`npm run check` 等于 lint + test。

## 提交前的最小要求

1. **`npm run check` 全绿**。
2. **研究面不变**：如果改动可能影响默认决策路径，跑五份面并与 `evidence/*.log` 的 md5 对比
   （方法见 `EVIDENCE.md`）。变了就必须在 `CHANGELOG.md` 与台账里写清"装置更正"，并重标基线。
3. **新增闸门必须能变红**：这个项目的规矩是"不能变红的闸门不算闸门"。做法：改完之后手工把修复撤掉一次，
   确认对应测试真的红，再改回来；或者补进 `life/*-mutation-battery.mjs`。
4. **不要为了好看改判据线**。负结果照实写。

## 一些刻意的设计约束（改之前请先读）

- 默认关的可选层（`m3` / `coupling` / `eventFirst` / `cfUsage` / `plasticGate` / `lpExplore` / `M5_ENABLED` / `WORK_CAP`）
  **关闭时必须与不设该开关逐位相同**：不消费随机数、不写状态字段。
- 库层（`life/host.mjs` 及各引擎模块）**不许 `console.log`**——会撞 `node --test` 的子进程消息通道（踩过）。
- 引擎里**不许 `Math.random`**，随机一律走 `life/rng.mjs`，否则同种子不可复现。
- 以上两条由 `npm run lint` 强制执行，不是口头约定。

## 反馈

见 `README.md` 的「反馈」一节。
