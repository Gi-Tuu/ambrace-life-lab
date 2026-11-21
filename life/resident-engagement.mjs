// 对话意愿：忙且累会拒绝，社交已满足会敷衍，信任低会冷淡。
// 从 dialogue.mjs 抽出，供旧 free talk 与 1.5 正式自由对话共用，避免 resident-dialogue 反向 import dialogue。
export const BUSY = new Set(['work', 'build', 'gather', 'harvest', 'plant', 'repair', 'camp_chop', 'camp_collect']);

const trustOf = (npc) => npc.relations?.map?.get?.('p1')?.trust ?? 30;
const energyOf = (npc) => npc.drives?.v?.energy ?? 0.7;
const socialOf = (npc) => npc.drives?.v?.social ?? 0.5;

export function engagementOf(world, npc) {
  const trust = trustOf(npc), energy = energyOf(npc), social = socialOf(npc);
  const busy = BUSY.has(npc.last?.kind ?? '');
  const arche = npc.traits?.archetype ?? '谨慎';
  if ((busy && energy < 0.35) || social > 0.78) return 'refuse';
  if (trust < 20 || (arche === '孤僻' && trust < 45)) return 'reluctant';
  return 'open';
}
