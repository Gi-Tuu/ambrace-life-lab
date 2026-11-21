> 历史快照（当时版本），现行口径见 README/CHANGELOG。

# evidence/fix-audio — 环境床 / BGM 平衡 / BGM 边界修复证据（2026-11-21）

- 被修仓库：`E:\Competition\AMBRACElife`，`main` @ `b66f88a`；`master` @ `e5016d6` 未动。
- 输入：`docs/体验审计-音频建造-2026-11-21.md`、`evidence/exp-audit-audio/`。
- 报告：`docs/回报-体验修复-音频-2026-11-21.md`。
- 约束：未 push、未部署、未改版本/tag。

## 文件

| 文件 | 内容 |
|---|---|
| `measure-audio.mjs` | 前后测量脚本：ffmpeg EBU R128/volumedetect + mock WebAudio 跑真实 `web/audio.mjs` + 边界矩阵 + 峰值余量 |
| `measure.log` | 完整可读输出（正文数字的出处） |
| `measurements-after.json` | 机器可读：修复前审计层数、修复后层/缓冲/增益、BGM/床 LUFS、边界矩阵、峰值余量 |
| `tests-audio-after.log` | `node --test life/audio.test.mjs`：**35/35 pass**（A-01…A-35） |
| `tests-full-isolated.log` | 隔离 worktree（b66f88a + 本修复）全量：**1179/1179 pass，fail 0** |
| `tests-before.log` | 主工作区改动前基线：1175 条，1173 pass，2 fail（磁盘/慢模型计时阈值） |
| `tests-full-draft.log` | 主工作区同跑（含并行 `fix-world-view` 未提交改动）：1176/1179；3 条失败均在几何/空间/研究快照，不在音频 |
| `quickstart-after.log`、`quickstart-after.txt` | 真 Chrome quickstart PASS（走/采集/吃/睡/死亡后世界继续；txt 为控制台 PASS 行） |
| `golden/audio-fix.json`、`golden/audio-fix-*.png` | 隔离 worktree 的 golden 采集 |
| `golden-capture.log`、`golden-compare.log` | 采集日志 + 对照 `p2-fixes`：**45/45，diffs 0** |
| `lint-after.log` | `npm run lint` 通过（489 文件 / 207 测试文件 / 347 文件架构闸门） |

## 复现

```powershell
cd E:\Competition\AMBRACElife
node evidence/fix-audio/measure-audio.mjs
node --test life/audio.test.mjs
npm run lint

# 全量：建议在 b66f88a + 本修复的干净 worktree 跑（避免并行未提交改动）
npm test

# quickstart（需本机 Chrome）
node scripts/quickstart-browser.mjs

# golden
node scripts/redo-p0-golden.mjs --label audio-fix
node scripts/p2-golden-compare.mjs p2-fixes audio-fix
```

## 口径

- 素材级 LUFS 用 ffmpeg ebur128 实测（压缩器之前、master=1）；有效电平含 `master=0.7` 与代码增益。
- 层数 = 真实 `createBufferSource()` 且 `loop=true` 的源；缓冲 = `renderAmbience()` 真实渲染的
  交织立体声采样（测试断言 2 声道、长度 > 0、存在非零样本）。
- 峰值和是“最响 BGM + 最响床 + 最响单条 SFX@0.8”的保守相加；总线压缩器的非线性未逐样本模拟。
- 主工作区当时有并行 `fix-world-view` 未提交改动；本目录的隔离全量/golden 不包含它们。
