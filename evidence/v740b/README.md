> 历史快照（当时版本），现行口径见 README/CHANGELOG。

# V7.4.0b evidence
- behavior-v740b-30d.json / behavior-v740b-100d.json：seeds 7/13/29，正式配置、玩家闲置；含生命周期（初始/出生刻/阶段/死亡）、逐刻需求、活跃/无动作/有效刻、关系时间序列（talk before/after + 共场）、循环诊断、M3 状态、非扰动哈希、元数据。
- v740b-check.log：npm run check（892/892）。
- 复现：node life/behavior-quality-probe-b.mjs v740b 30|100；node --test life/v740b-observation.test.mjs。
