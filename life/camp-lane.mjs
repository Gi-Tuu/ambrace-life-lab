// 三态调度的纯判定（交接单 §4.4）。抽成独立模块，便于闸门直接测、也避免测试导入 host 单例。
//   watched            → 真模型（节点优先，付费按 S1 规则）
//   无人 + 主营地      → 真模型（只记节点账，付费硬关）
//   无人 + 分名字营地  → 确定性替身（询问不发出，两本账都不涨）
//   无人且未开启无人运行 → 替身（研究态默认）
export function modelLaneFor({ campKey = 'MAIN', watched = false, unattendedOn = false } = {}) {
  if (watched) return 'watched';
  if (!unattendedOn) return 'off';
  return campKey === 'MAIN' ? 'node' : 'idle';
}
