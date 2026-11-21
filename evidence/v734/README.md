> 历史快照（当时版本），现行口径见 README/CHANGELOG。

# V7.3.4 evidence
- fair-v734-cap{1,2,6,8}.json：30 日 on/off × seeds 7/13/29，字段含 HEAD/ticks/activeDays/popPeak/eligible/underfunded/executedEpisodes/wait/labor。
- fair-v734-long{100,200}-cap{1,8}.json：100/200 日 on/off 配对。
- v734-check.log：npm run check（882/882）。
- 生成命令：node life/fair-sched-probe.mjs（FAIR_DECISION_CAP=...）；node life/fair-long-probe.mjs 100|200。
