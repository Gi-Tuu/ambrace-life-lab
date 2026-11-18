# V7.4.1 evidence
- experiment-v741-30d.json：seeds 7/13/29 × m3 on/off ×30 日，6 组；含 M3 规划器事件（仅真实状态）、关系来源分解、互动后重复选择、移动 3/6/12 刻窗口、元数据、非扰动哈希、agentErrors。
- v741-check.log：npm run check（895/895）。
- 100 日复用 evidence/v740b/behavior-v740b-100d.json（无 M3/关系/移动实验字段）。
- 复现：node life/v741-experiment.mjs 30 v741；node --test life/v741-observation.test.mjs。
