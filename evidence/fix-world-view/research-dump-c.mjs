// 研究态 C 组（正式规则但无 simClock 的旧档路径）dumpSurv 逐位基线探针。
// 用法：node evidence/fix-world-view/research-dump-c.mjs > <out>.json
// 只读：固定 seed/选项，跑 24 刻后打印 dumpSurv 的 JSON 原文（md5 由闸门测试负责）。
import { createSurvPlay, dumpSurv, tickSurvPlay } from '../../life/survplay.mjs';
import { FORMAL_OPTIONS } from '../../life/balance-probe.mjs';

const sp = createSurvPlay(7, { ...FORMAL_OPTIONS, simTime: false });
for (let i = 0; i < 24; i += 1) await tickSurvPlay(sp);
process.stdout.write(JSON.stringify(dumpSurv(sp)));
