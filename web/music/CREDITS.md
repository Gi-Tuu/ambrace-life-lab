# BGM 素材来源与授权说明

本目录的 13 个 `.ogg` 是 **AI 生成音乐**，不是代码合成，也不是传统意义上的人工作曲。

## 生成方式

- 工具：**Google Flow Music**（Google DeepMind Lyria 系列）
- 账户权益：作者本人的 **Google AI Pro** 会员
- 生成时间：2026-11-19 至 2026-11-21（以仓库提交时间记录，非精确生成时刻）
- 人工工作：提示词设计、候选筛选、段落剪辑、循环点、音量/场景映射、游戏内触发编排
- 未使用第三方采样、他人录音、他人歌词或艺人声音克隆

> Google 的公开条款说明：Google 不主张用户生成内容的所有权；Google AI Pro 的 Flow Music 权益通常包含商用权，但 Flow Music 自身条款页未逐字写明 “commercial use”。因此本仓库**不主张独占版权**，只声明作者有权在本项目中使用这些生成结果，并保留订阅/生成记录备查。

## 曲目

| 文件 | 用途 |
|---|---|
| `menu.ogg` | 主菜单 |
| `spring.ogg` / `summer.ogg` / `autumn.ogg` / `winter.ogg` | 四季白天 |
| `spring-night.ogg` / `summer-night.ogg` / `autumn-night.ogg` / `winter-night.ogg` | 四季夜晚 |
| `crisis.ogg` | 缺粮/危机 |
| `recovering.ogg` | 恢复期 |
| `death.ogg` | 玩家倒下 |
| `extinct.ogg` | 聚落灭绝 |

## 其他音频

- 环境声 / 音效：`web/audio-data.mjs`、`web/audio-synth.mjs` 代码合成，不含外部音频文件。
- 字体：Fusion Pixel 12px monospaced（SIL OFL 1.1），许可证在 `web/assets/fonts/OFL.txt`。

## 比赛/发布披露建议

手记与提交页应写：

> BGM 由 Google Flow Music（Lyria）在 Google AI Pro 权益下生成，作者完成提示词、筛选、剪辑与游戏内编排；音效由代码合成；字体为 SIL OFL 1.1。

如主办方要求提供授权证明，可私下提交 Google AI Pro 订阅记录与 Flow Music 生成记录；不要把账户凭证、密钥或个人账单信息放进公开仓库。
