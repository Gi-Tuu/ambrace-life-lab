# V7.3.3 证据说明

- `fair-sched-cap{1,2,6,8}-v733.json`：FAIR on/off × seeds 7/13/29 × 30 日，cap 1/2/6/8；字段含 HEAD、ticks、popPeak/popAvg、peakEligible、underfundedTicks、granted、wait、两类空闲、人口/存粮/劳动。
- `fair-long-100-v732.json` / `fair-long-200-v732.json`：固定 seeds 100/200 日 on/off，含 P2 字段（ticksRun/popPeak/popAvg/peakEligible/underfunded/granted/wait/runtime）。
- `v732-check.log`：npm run check 输出（877/877，生成时全绿）。
- 生成命令：`node life/fair-sched-probe.mjs`（FAIR_DECISION_CAP=1/2/6/8）、`node life/fair-long-probe.mjs 100|200`。
