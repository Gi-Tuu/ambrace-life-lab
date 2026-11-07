// L9 规则/校验层。它管「能不能」，与模型「想不想」彻底分开（§2.1 依赖铁律 3）。
// 这段是从旧原型里唯一保留下来的东西：意图合法性 + 驳回原因回喂 + 要求重新决策。
import { BASE_KINDS, LOCS } from './body.mjs';
import { isNight } from './clock.mjs';
import { reachableOf } from './coupling.mjs';

export function validate(world, agentId, intent) {
  const here = world.loc[agentId];
  const others = (world.occupancy[here] ?? []).filter((x) => x !== agentId);
  const kind = intent?.kind;
  const fail = (code, why) => ({ ok: false, code, why });

  if (!kind || !BASE_KINDS[kind]) return fail('NOT_AN_ACTION', `规则层不认识 ${kind}`);
  if (kind === 'eat' && world.pantry <= 0) return fail('DEPLETED', '存粮缸已空，世界没有可消耗的食物');
  if (kind === 'eat' && here !== 'home' && here !== 'store') return fail('NOT_PRESENT', `取粮得在居所或公仓，你在 ${here}`);
  if (kind === 'talk' && !others.length) return fail('NO_TARGET', `${here} 没有可对话的对象`);
  if (kind === 'talk' && !others.includes(intent.target)) return fail('WRONG_TARGET', `${intent.target} 不在同一处`);
  // M4 消费者④：闭门的人在世界里确实叫不到（不是"他心里不想理你"）。others 已由 body 侧排除不可达者，
  // 这里再查一次是为了让"叫不到"成为**规则层的裁决**，而不是某处过滤的副作用。
  if (kind === 'talk' && !reachableOf(world.agents[intent.target])) return fail('SECLUDED', `${world.agents[intent.target]?.name ?? intent.target} 躲起来了，这会儿叫不到`);
  if (kind === 'move_to' && !LOCS[intent.to]) return fail('NO_LOC', `没有 ${intent.to} 这个地方`);
  if (kind === 'take_shared') {
    if (!intent.target) return fail('NO_TARGET', '没指定拿谁的');
    if ((world.stash[intent.target] ?? 0) <= 0) return fail('DEPLETED', `${world.agents[intent.target]?.name} 门口已经空了`);
    if (world.loc[intent.target] === here) return fail('WITNESSED', `${world.agents[intent.target]?.name} 正在场，这条路走不通`);
  }
  if (intent.target === agentId) return fail('SELF_TARGET', '不能对自己执行该动作');
  // 行为层看不见的硬规则：保证校验层真的会变红，而不是永远绿灯
  if (kind === 'look_out' && isNight(world.t)) return fail('LOCKED_HOUR', '夜里瞭台封禁，这不是意志问题');
  return { ok: true, code: 'OK' };
}

export const impulseOf = (kind) => BASE_KINDS[kind]?.impulse ?? 0.5;

// S3：传话的合法性由规则层裁决，与"想不想说"彻底分开（和 validate 同一条铁律）。
// 关键一条：**不知道的人不能传**——NPC 之间传播必须检查 known 集合，否则"信息套利"退化成"谣言广播"。
// 玩家例外：这个 demo 里玩家是全知观察者，套利发生在"谁被告知"，不是"谁能打听到"。
export function canTell(world, tellerId, targetId, secretId, { presence = true } = {}) {
  const fail = (code, why) => ({ ok: false, code, why });
  const secret = (world.secrets ?? []).find((s) => s.id === secretId);
  if (!secret) return fail('NO_SECRET', `没有这条秘密 ${secretId}`);
  if (targetId === tellerId) return fail('SELF_TARGET', '不能把话告诉自己');
  if (!world.loc[targetId]) return fail('NO_TARGET', `${targetId} 不在这个世界里`);
  // presence=false 只用于离线消融：那里没有玩家实体（把"你"塞进世界会让 NPC 多出一个可对话对象，
  // 动到所有已发表读数）。在场性本身由 host 路径与单独的单测覆盖。
  if (presence && world.loc[targetId] !== world.loc[tellerId]) return fail('NOT_TOGETHER', `${world.agents[targetId]?.name ?? targetId} 不在你这里，话传不过去`);
  if (tellerId !== 'p1' && !secret.known.has(tellerId)) return fail('IGNORANT', '传话者自己并不知道这件事');
  if (secret.known.has(targetId)) return fail('REDUNDANT', '对方已经知道了，再说一遍不该改变任何东西');
  return { ok: true, code: 'OK', secret };
}

// 告知之后的认知后果：只改 known 集合。世界事实、库存、位置一律不动——
// 那些必须是被告知者的**行为**造成的，否则"信息改变世界"这句话是我们在替它编。
export function markKnown(secret, who) {
  secret.known.add(who);
  return secret;
}

// 动作身份：路径级（带对象/目的地），不再只有 kind
export const actionId = (a) => a.id ?? `${a.kind}${a.target ? ':' + a.target : ''}${a.to ? ':' + a.to : ''}`;
