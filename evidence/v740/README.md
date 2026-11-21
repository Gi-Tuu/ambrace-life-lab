> 历史快照（当时版本），现行口径见 README/CHANGELOG。

# V7.4.0 evidence
- behavior-v740.json：seeds 7/13/29 ×30 日正式游戏，玩家闲置；含身份/人格/阶段/需求、逐居民逐日动作/层级/社交/目标/时段、事件、最终关系、非扰动哈希。
- v740-check.log：npm run check（890/890）。
- 复现：node life/behavior-quality-probe.mjs v740；node --test life/v740-behavior.test.mjs。
