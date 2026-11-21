// BGM 成品曲清单：13 个会响的槽位，音源是 Google Flow（AI Pro 账户）生成的纯器乐曲。
// 提示词见 docs/BGM生成提示词-2026-11-18.md（第一批）与 …-第二批-2026-11-19.md（夜曲/倒下/灭绝）；
// 起播点由 start-points.mjs 从每秒响度剖面实测算出，四条硬条件：进入后至少还剩 45 秒、
// 该段 30 秒内起伏 ≤6dB、低于"全曲均值 −12dB"的呼吸格 ≤3、彼此间隔 ≥40 秒。不许手填，A-27 打红。
//
// 第二批（所有者 2026-11-21）：夜曲 ×4 + 倒下 + 灭绝。它们对应三处规则改动——
// 夜不再整段静音、玩家倒下不再只剩心跳、灭绝不再静默。村外与闲日白天仍然不放。
export const MUSIC_TRACKS = {
  menu: { file: 'music/menu.ogg', seconds: 169.3, bytes: 2106832, starts: [17.5, 64, 107] },
  spring: { file: 'music/spring.ogg', seconds: 168.6, bytes: 2151287, starts: [33, 73, 113] },
  summer: { file: 'music/summer.ogg', seconds: 170.1, bytes: 2105767, starts: [30.5, 79.5, 119.5] },
  autumn: { file: 'music/autumn.ogg', seconds: 171.8, bytes: 2053180, starts: [40, 106.5] },
  winter: { file: 'music/winter.ogg', seconds: 173.2, bytes: 2105130, starts: [13, 63.5, 126.5] },
  crisis: { file: 'music/crisis.ogg', seconds: 166.9, bytes: 1934753, starts: [5, 53.5, 94] },
  recovering: { file: 'music/recovering.ogg', seconds: 164.5, bytes: 2033279, starts: [37.5, 96.5] },
  'spring-night': { file: 'music/spring-night.ogg', seconds: 162.0, bytes: 1729099, starts: [32.5, 83.5] },
  'summer-night': { file: 'music/summer-night.ogg', seconds: 174.9, bytes: 1958103, starts: [4, 53, 97.5] },
  'autumn-night': { file: 'music/autumn-night.ogg', seconds: 176.0, bytes: 2098745, starts: [28.5, 69, 111.5] },
  'winter-night': { file: 'music/winter-night.ogg', seconds: 172.9, bytes: 2035463, starts: [13, 56, 124.5] },
  death: { file: 'music/death.ogg', seconds: 166.7, bytes: 1874996, starts: [9, 51.5, 100.5] },
  extinct: { file: 'music/extinct.ogg', seconds: 161.8, bytes: 1848148, starts: [7, 61, 102] },
};

// 素材体积预算：超了就 red，防止有人继续往仓库塞整曲。13 首实测 ≈24.8MB。
export const MUSIC_BYTE_BUDGET = 32 * 1024 * 1024;
