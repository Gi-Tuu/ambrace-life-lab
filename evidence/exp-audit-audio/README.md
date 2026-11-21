> 历史快照（当时版本），现行口径见 README/CHANGELOG。

# evidence/exp-audit-audio — 音频/建造体验审计证据（2026-11-21，只读）

被审仓库：`E:\Competition\AMBRACElife`，实际 HEAD `b66f88a`（`git describe` = `v1.1.1-2-gb66f88a`；
用户基线 `e5016d6` = tag `v1.1.1`，落后 2 个 BGM 提交）。审计未修改任何产品代码，未 push。

## 文件
| 文件 | 内容 |
| --- | --- |
| `probe-audio-build.mjs` | 探针：BGM 窗口矩阵 / proximity / mock WebAudio 跑真实 `web/audio.mjs` / ffmpeg 响度实测 / 住宅地块枚举 |
| `probe-audio-build.log` | 探针完整输出（本报告所有实测数字的出处） |
| `measurements.json` | 同一批测量的机器可读结果（窗口矩阵、床接线轨迹、13 首 BGM 与 6 条环境床的 LUFS/峰值） |
| `tests-audio.log` | `node --test life/audio.test.mjs` 复跑结果：31/31 通过（说明闸门没覆盖床接线缺陷） |
| `tests-construction.log` | `node --test life/construction-access.test.mjs life/camp-districts.test.mjs life/peripheral-reach.test.mjs`：19/19 通过 |
| `diff-v111-to-head.txt` | `e5016d6..HEAD` 在 `web/audio*.mjs`、`web/music-tracks.mjs` 的差异（夜/灭绝/倒下三处窗口改动来源） |
| `v111-bed-lines.txt` | v1.1.1 版本 `web/audio.mjs` 中 setBed/renderAmbience 的原始行（证明床接线缺陷不是 HEAD 新引入） |

## 复现
```
node evidence/exp-audit-audio/probe-audio-build.mjs
node --test life/audio.test.mjs
node --test life/construction-access.test.mjs life/camp-districts.test.mjs life/peripheral-reach.test.mjs
```
环境：Windows + Node v24.18.0 + ffmpeg 8.1.2（PATH 中，用于 EBU R128 / volumedetect 实测）。
环境床与 BGM 的响度是**素材文件**级测量；浏览器内还有 master 音量 0.7 与一个总线压缩器（见报告 §3.5），
探针未模拟压缩器的非线性，报告中的"有效 LUFS"是压缩器之前的电平。
