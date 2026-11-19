// 营地动作的“静态前置”单一实现（ARCH5-01/02 之后的 ARCH5 剩余收敛）：
// 只放不依赖世界时刻/连续位置、且 validateCamp 与 campAction 都需要的前置（工具/品类）。
// 位置、容器、库存数量、场地状态仍留在 campAction（依赖解析后的 site），后续按动作族再搬。
import { CAMP_TOOLS } from '../shared/camp-interaction.mjs';

const fail = (code) => ({ ok: false, code });

export function campStaticPrecheck(world, body) {
  const kind = String(body?.kind ?? '');
  const item = body?.type;
  if (kind === 'camp_chop' && body?.tool !== 'axe') return fail('NEED_TOOL');
  if (kind === 'camp_craft') {
    const site = world?.loc?.p1;
    if (!['workshop', 'yard'].includes(site)) return fail('NOT_WORKBENCH');
    if (item !== 'tray') return fail('BAD_ITEM');
  }
  if (kind === 'camp_plant' && body?.tool !== 'hoe') return fail('NEED_TOOL');
  if (kind === 'camp_water' && body?.tool !== 'bucket') return fail('NEED_TOOL');
  if (kind === 'camp_collect') {
    if (!Object.hasOwn(CAMP_TOOLS, String(item ?? ''))) return fail('BAD_ITEM');
    if (body?.tool !== CAMP_TOOLS[item]) return fail('NEED_TOOL');
  }
  return null;
}
