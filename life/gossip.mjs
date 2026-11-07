// S3 传话：把"能不能说"（规则层）与"说了之后登记给谁"（认知）与"影响到谁"（评价注入）串起来。
// 三段分开写，是为了让负向对照能落在**中间那刀**上：⑨ 关掉时登记照旧发生，但不许产生任何后果。
import { canTell, markKnown } from './rules.mjs';

export function tell(world, tellerId, targetId, secretId, opts = {}) {
  const v = canTell(world, tellerId, targetId, secretId, opts);
  if (!v.ok) return { ...v, told: false };
  markKnown(v.secret, targetId);
  const target = world.agents[targetId];
  if (target?.receive) target.receive(world, v.secret, tellerId);
  return { ok: true, code: 'OK', secret: v.secret.id, detail: v.secret.detail, target: targetId, told: true };
}

// 自动挑一条"关于别人、且对方还不知道"的秘密来讲。
// 排序必须确定（按 id 字典序），否则同一颗种子两次跑出不同的套利对象，实验就不可复现。
export function pickSecret(world, targetId) {
  const cands = (world.secrets ?? [])
    .filter((s) => s.about !== targetId && !s.known.has(targetId) && s.holder !== targetId)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return cands[0] ?? null;
}

// 一轮传话：把每个人还不知道的第一条秘密讲给他。
// presence 默认 true（页面/host 路径里玩家是实体，不在同一处就该被驳回）；
// 离线消融传 presence:false —— 那里没有玩家实体，把"你"塞进世界会让 NPC 多出一个可对话对象，动到全部已发表读数。
export function gossipRound(world, { presence = true } = {}) {
  const out = [];
  for (const targetId of Object.keys(world.agents)) {
    if (targetId === 'p1') continue;
    const secret = pickSecret(world, targetId);
    // 没得可讲也要留一行：套利空间被传完之后，"还能不能继续套利"这件事必须能从读数里看出来
    if (!secret) {
      out.push({ 对: world.agents[targetId]?.name ?? targetId, ok: false, code: 'NOTHING_TO_TELL', why: '关于别人且对方还不知道的秘密已经讲完了' });
      continue;
    }
    const r = tell(world, 'p1', targetId, secret.id, { presence });
    out.push({ 对: world.agents[targetId]?.name ?? targetId, 秘密: secret.id, ...r });
  }
  return out;
}
