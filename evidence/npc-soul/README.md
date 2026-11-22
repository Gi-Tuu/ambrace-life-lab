# evidence/npc-soul — 1.6 灵魂能力：持久对话记忆 + 居民主动搭话

日期：2026-11-22 · 执行：npc-soul（本地 `main`，未 push、未部署） · 代码 HEAD：`a75d328`（A/B）+ `8d71e0c`（C）

## 结论

| 项 | 读数 | 文件 |
|---|---|---|
| 新闸门红→绿 | 实现前 **0 pass / 9 fail**；实现后 12/12 绿 | `red.log`、`full-test.log` |
| 全量 | **1288 / 1288 pass，fail 0，84.7 s** | `full-test.log` |
| 静态检查 | 通过：语法 535 文件、测试文件 231、架构闸门 373 文件/12 白名单 | `lint.log` |
| golden | **45/45，diffs 0**（vs `v16-livestock`）；vs 旧 `p3-final` 仍 20 同 25 变（与 v16-livestock 基线逐项相同，不是本次引入） | `golden.json`、`golden-run.log`、`golden-compare-vs-v16.log`、`golden-compare.log`、`npc-soul-*.png` |
| 22k parity | 2×11000 点 terrain/walk/height/portal 全 0 | `parity.log` |
| 研究 md5 | 5/5 与 P3 台账逐位相同 | `research-md5.log` |
| quickstart | PASS（起服→走→采集→吃→睡→死亡转幽魂） | `quickstart-browser.log` |
| 浏览器气泡 | **ok:true**：独立 `BUTTON#playerCall`、可见、真鼠标命中 `#playerCallText`，点击后服务端拒绝过期气泡并 toast「这句话已经过去了。」 | `browser.log`、`browser.json`、`bubble.png` |

## 复现命令

```powershell
node --test life/v16-npc-soul.test.mjs life/v16-npc-soul-ui.test.mjs life/v16-npc-soul-host.test.mjs
npm test
npm run lint
node scripts/p2-space-parity.mjs
node scripts/redo-p0-golden.mjs --label npc-soul
node scripts/p2-golden-compare.mjs v16-livestock npc-soul
node scripts/p2-golden-compare.mjs p3-final npc-soul
npm run research:md5
npm run quickstart:browser
node scripts/npc-soul-browser.mjs
```

## 判据覆盖

- **SOUL-01**：关面板→重开，summary/recent/turns 还在，prompt 能接“上次…”；
- **SOUL-02**：摘要 ≤200 字/≤3 段、recent ≤8 条、单条 ≤120 字；不写关系/loc/store/busy；
- **SOUL-03**：入档/读档逐位一致、旧档无字段可读、研究态无字段、compare 不触发；
- **SOUL-04**：打开响应/居民视图展示摘要，且不夹带 `world.secrets`/关系明细；
- **SOUL-05**：靠近触发一次，`/world` 只给 `id/name/text/at/expires`，模板引用真实状态；
- **SOUL-06**：冷却 360 分、每居民每日 2 次、太远/幽灵/同居民对话中/离线都静默；
- **SOUL-07**：模型 fire-and-forget，tick 不阻塞；失败/空/无效/过期均保留模板；
- **SOUL-08**：fromSpeech 在 2.5 格可开面板/续聊；普通 F 仍 1.6；走远拒绝；
- **SOUL-09**：前端有独立气泡、记忆行、居民面板“上次聊天”，不是 toast；
- **SOUL-10..12**：模型车道 80 token、成功/超时/空分账不污染 chatter、连续失败开 breaker 后不再发请求。

## 变红法（实现前红时的断言原文在 `red.log`）

- 删 `closeResidentDialogue` / `finishFreeSay` 的 `rememberDialogue` ⇒ SOUL-01 红；
- 把 `maybePlayerSpeech` 的模型调用改成 `await` ⇒ SOUL-07 的 `tick 被模型等待阻塞` 红；
- 去掉 `fromSpeech` 服务端复核（或放宽普通入口）⇒ SOUL-08 红；
- 去掉 `compareSide` 标记 ⇒ SOUL-03 的 compare 断言红；
- 删 `#playerCall` / `#talkMemory` / `pointer-events:auto` ⇒ SOUL-09 或浏览器 evidence 红。

## 已知边界（明说）

1. 浏览器 `bubble.png` 用的是**注入页面视图的 fake speech**（目标选了玩家 p1 以便稳定锚定）；它验证的是“气泡 DOM + 真鼠标点击 + 请求发出”。**服务端真实触发的 2.5 格气泡→点击开面板**由 SOUL-08 在模块层覆盖，未做同一页面的端到端（原因：真实触发要等整点 worldTick，浏览器里靠 `GAME_MS_PER_MINUTE=100` 也不稳定）。
2. 没有真 27B 模型调用：模型成功/超时/空/breaker 都是本地桩。
3. 未验手机触控、读屏；`#playerCall` 只做了桌面 hover/focus。
4. `evidence/redo-p2*`、`evidence/v11-research/*.json`、`evidence/score/quickstart-browser.log` 被本次 gate 重新生成（工作树 M），**未纳入本单提交**。
