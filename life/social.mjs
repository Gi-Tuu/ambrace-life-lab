// M7 补充层：自发转述（第三人声誉）。
// 只做一件事：同处一室的两个人，知道的人把"关于第三者且对方还不知道"的事讲出去。
// 不新增动作、不新增世界状态——登记走 secrets.known，后果走既有 receive()/assess()（⑨ 通道可切断）。
import { tell } from './gossip.mjs';

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function socialRound(world, { presence = true } = {}) {
  const out = [];
  const ids = Object.keys(world.agents ?? {})
    .filter((id) => id !== 'p1')
    .sort();
  for (const teller of ids) {
    const here = world.loc[teller];
    if (!here) continue;
    // 每人每轮最多传一条：顺序确定，避免同一颗种子跑出不同的套利对象
    const target = ids.find((t) => t !== teller && world.loc[t] === here);
    if (!target) continue;
    const secret = (world.secrets ?? [])
      // 必须是"关于第三者"：当事人自曝（holder===teller）不是声誉传播，讲给受害者也不是
      .filter((s) => s.known.has(teller) && !s.known.has(target) && s.holder !== target && s.about !== target && s.holder !== teller)
      .sort(byId)[0];
    if (!secret) continue;
    const r = tell(world, teller, target, secret.id, { presence });
    if (r.told) out.push({ teller, target, secret: secret.id, detail: secret.detail });
  }
  return out;
}
