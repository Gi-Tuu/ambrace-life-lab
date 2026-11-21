# 证据索引（怎么从仓库内自己核对这些结论）

这个文件回答一个问题：**README 里那些话，我在这个仓库里怎么自己验一遍。**

所有命令都在仓库根、零第三方依赖、离线可跑。五份面的数字是 2026-11-09 在本机（Node v24.18.0）实测的；
换机器/换 Node 版本可能不同，那属于环境差异，不是否定证据——但 `evidence/*.log` 的 md5 是按
"完整 stdout 以 LF 换行存盘"算的，重跑应当逐字节一致。2026-11-21（v1.6.0）重跑五份面仍 5/5 逐位相同。

## 一、五份基准读数（已随仓库发布）

```bash
npm test                                  # 221 个测试文件 / 1261 条断言（2026-11-21，v1.6.0；日志 evidence/v16-livestock/full-test.log）
node life/run.mjs --report > /tmp/report.log    # 四条件消融矩阵
node life/run.mjs --sweep  > /tmp/sweep.log     # 5 seed 复核
node life/run.mjs --viab   > /tmp/viab.log      # 受损速度
node life/run.mjs --recover> /tmp/recover.log   # 恢复动力学（机械侧 + 观察侧）
node life/run.mjs --metab  > /tmp/metab.log     # 代谢与进食实测账
md5sum /tmp/{report,sweep,viab,recover,metab}.log
```

| 面 | 文件 | md5（LF 存盘） |
|---|---|---|
| report | `evidence/report.log` | `19a2803182a5a63ae944120dd0a528bc` |
| sweep | `evidence/sweep.log` | `22f76c48897713ddcee9bae8f767e31b` |
| viab | `evidence/viab.log` | `86da5c0a4a0e26b082fbfb54fd6c1736` |
| recover | `evidence/recover.log` | `feac239b364b8a771042d3996529181e` |
| metab | `evidence/metab.log` | `e0a23df93d8fa7c9e5db7d2ccc9a76cf` |

> 2026-11-18 主路径拆分后重跑五份面，五份 md5 与上表逐位相同；重跑副本与哈希清单见 `evidence/score/baseline-surfaces/` 与 `evidence/score/research-md5.txt`。

> 注意：`--viab` 的输出末尾多两行**披露文字**（"饥馑档只在头 55 刻真饥馑"），这两行是 2026-11-09 加的；
> 表格本身与加披露之前逐字节相同。`--sweep`/`--report` 的输出依赖 seed 列表，默认固定。

## 二、"闸门能变红"怎么自己验

三套变异电池（把源码复制到临时目录、施加一条变异、要求它瞄准的闸门真的红）：

```bash
node life/o1o9-mutation-battery.mjs      # 13 条
node life/m6p-mutation-battery.mjs       # 4 条
node life/m6lp-mutation-battery.mjs      # 4 条
node life/m4-mutation-battery.mjs        # 7 条（2026-11-09 补，之前只存在日志里）
```

每条都要求：未变异对照必须先全绿、锚点必须唯一命中、变异必须打红指定闸门。任一条不满足即 `exit 1`。

## 三、README 各句话对应的证据

| README 的说法 | 怎么验 | 限制 |
|---|---|---|
| "行为由内部状态驱动" | `npm test` 里的 `life.test.mjs` 归因/钳制用例 + `--report` 的 P1a 列 | 单 seed 读数是弱证据，multi-seed 才看 `--sweep` |
| "切断通道后行为分布改变" | `--report` 的 C2 vs C2-neg 两行 | **该矩阵不是同随机流对照**（掩码被哈希进角色种子）；同种子臂在 `coupling.test.mjs` / `m6-*.test.mjs` / `o9-event-first.test.mjs` 里 |
| "每条判据配负向对照" | `life/host-layers.test.mjs`（B 侧永不叠层）、`m3.test.mjs` 闸门④、变异电池 | 负向对照的有效性由变异电池自己验 |
| "不可逆损伤" | `--viab` / `--recover`；`life.test.mjs` 的 L13 用例 | 默认档（town）跑 3600 刻仍 0 掉档；能看到掉档的是离线 lab 与 `WORK_CAP=0` 情景 |
| "语言层不是语义理解" | `life/speech.mjs` 顶部注释 + `town.test.mjs` T4/T5 | 台词是状态条件化模板；玩家输入是六类正则 |
| "可复现" | 上面五份 md5 + `m3-baseline-*.json` 行为指纹 | 只在同 Node 大版本、同 seed 下逐位 |

## 四、明确不保证的

- **真实模型链路**：`BRAIN=model` 需要自备端点/密钥（见 `.env.example`）。仓库内只有一个**假上游**测试
  （`life/model-path.test.mjs`），它验的是预算闸门/退替身/坏 JSON，不验供应商的真实质量。
- **外部基线**：部分 M5 训练脚本读 `D:/Codex-Projects/output/` 下的历史日志，仓库不保证能复现（README 已声明）。
- **线上实例**：部署在平台上的行为依赖平台休眠策略与是否配置了 `CTL_TOKEN`，仓库无法自证。
- **覆盖率只统计被套件加载的模块**（以 `npm run coverage` 最后一次输出为准）：2026-11-21 这轮报告的模块行是 **170 个**；`scripts/*.mjs`（66 个生成/检查/探针脚本）与 `docs/*.mjs` 的一次性测量脚本不在其中，它们是离线装置，不在运行时路径上。
- **覆盖率插桩下没有全绿（v1.6.0，2026-11-21 两轮实跑）**：

  | 轮次 | 通过 | 行 | 分支 | 函数 | 耗时 | 红条 |
  |---|---:|---:|---:|---:|---:|---|
  | 早前记录（原始日志未随仓库留底） | 1259/1261 | 90.62% | 85.86% | 89.62% | 99.2s | `life/camp-compare-entry.test.mjs`（`TELEPORT` vs `OUT_OF_REACH`）、`life/v11-offline-restart.test.mjs`（1200.1 vs 1200） |
  | 本轮复核（2026-11-21 23:48，`evidence/v16-livestock/coverage-2026-11-21.log`） | 1258/1261 | 90.58% | 85.84% | 89.62% | 111.3s | `life/audit5-data.test.mjs`（6 进程写 `index.json.lock` 报 EPERM，Windows/临时目录相关）、`life/v11-offline-restart.test.mjs`（同上浮点）、`life/v13-ghost-host.test.mjs`（幽魂分钟 180.03 → 240.0005 的整点判断） |

  两轮共同结论：**插桩跑不到全绿**，红条在 2–3 条之间随机器/时序漂移（上一版文档把红条写成固定两条，本轮未能复现同样的两条）。未插桩的全量证据是 **1261/1261**（`evidence/v16-livestock/full-test.log`）。**本次文档刷新没有改业务代码去修这些用例**；对外写覆盖率请用"约 90.6% / 85.9% / 89.6%，插桩非全绿"，不要写"覆盖率全绿"，也不要把某一次的红条清单当固定已知红。

## 五、角色证据（2026-11-18 起，1.6.0 继续沿用）

| 证据 | 文件 | 怎么复现 |
|---|---|---|
| 5 分钟真实路径（Chrome） | `evidence/v16-livestock/quickstart-browser.log`（1.6.0）/ `evidence/score/quickstart-browser.log`（0.1.5） | `node scripts/quickstart-browser.mjs`（需本机 Chrome；`REQUIRE_CHROME=1` 强制） |
| 作者侧消融/负控 | `evidence/score/baseline.json` | `node scripts/score-baseline.mjs --ticks 240 --seeds 7,13 --repeats 2`；说明与未验证声明见 [`BENCHMARK.md`](./BENCHMARK.md) |
| 五份面拆分后重跑 | `evidence/score/baseline-surfaces/*.log` + `research-md5.txt` | 五条 `node life/run.mjs --…` 命令；md5 应与上表逐位相同 |
| 1.6.0 全量/金标/对等/研究面 | `evidence/v16-livestock/{full-test,check,golden-compare,parity,research-md5}.log` | `npm test`、`npm run lint`、`node scripts/redo-p0-golden.mjs`、`node scripts/p2-space-parity.mjs`、`npm run research:md5`；1.6.0 读数 1261/1261、golden 45 键 20 同 25 变（逐项见 `golden-compare.log`）、22k parity 0、研究 md5 5/5 |

> 再次强调：`baseline.json` 是**作者侧**消融/负控，不是外部独立基准，也不是第三方验证；不要把它写成“外部验证通过”。

## 六、配对对照（2026-11-09 新增，用来回答"这条差异能不能归因到通道"）

默认的 `simulate` 把 `condition` 与 `channelMask` 一起哈希进每个角色的种子，所以
`--report` 里 C2 与 C2-neg 的两行之差里混了"换了一条随机流"。要归因，用配对模式：

```bash
node life/run.mjs --report --paired      # 两臂共用同一种子 + 同一条 rng 起点，只让通道不同
```

留底：`evidence/report-paired.log`（md5 `199e8ca4df3cb459dbeaf54d7ec35f18`）。实测（seed=7, 400 刻）：

| 条件 | P1a 钳制m KL | 主动发起 | 审议率 | 驳回 |
|---|---|---|---|---|
| C0 | 0 | 573 | 0.476 | 42 |
| C1 | 0 | 573 | 0.476 | 42 |
| **C2** | **0.6032** | **975** | **0.686** | **84** |
| C2-neg | 0 | 573 | 0.476 | 42 |

两条结论：

1. **C2 与 C2-neg 的分离是干净的**：同一个个体、同一串噪声，只把承重通道接上/切断，KL 从 0 到 0.603、
   主动发起 573→975、驳回 42→84。这条差异可以归因到通道，不是随机流。
2. **C0 / C1 / C2-neg 三行逐位相同**：`channelsFor` 只区分 `'C2'` 与"其他"，所以"四条件矩阵"实际上是
   **C2 对三个同一张表的对照**（C0 另有一条"跳过记忆检索"的特判）。读 `--report` 时不要把它当成四个不同的机制档。

闸门：`life/life.test.mjs` 里的"配对对照"用例同时钉住两件事——配对模式下两臂人格逐位相同，
默认模式下两臂人格确实不同（把这条限制本身变成可检测的断言）。