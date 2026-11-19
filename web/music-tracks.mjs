// BGM 成品曲清单：7 个会响的槽位，音源是 Google Flow（AI Pro 账户）生成的纯器乐曲。
// 提示词与逐曲依据见 docs/BGM生成提示词-2026-11-18.md；起播点由 docs/evidence/start-points.mjs
// 从每秒响度剖面实测算出，四条硬条件：进入后至少还剩 45 秒、该段 30 秒内起伏 ≤6dB、
// 低于"全曲均值 −12dB"的呼吸格 ≤3、彼此间隔 ≥40 秒。不许手填，填错由 A-27 打红。
//
// 这里只列会响的槽位：夜、村外、灭绝、玩家倒下按 audio-events.mjs 的窗口规则本就不播，
// 所以 extinct 没有素材——加了也是永远听不到的字节。
export const MUSIC_TRACKS = {
  menu: { file: 'music/menu.ogg', seconds: 169.3, bytes: 2106832, starts: [17.5, 64, 107] },
  spring: { file: 'music/spring.ogg', seconds: 168.6, bytes: 2151287, starts: [33, 73, 113] },
  summer: { file: 'music/summer.ogg', seconds: 170.1, bytes: 2105767, starts: [30.5, 79.5, 119.5] },
  autumn: { file: 'music/autumn.ogg', seconds: 171.8, bytes: 2053180, starts: [40, 106.5] },
  winter: { file: 'music/winter.ogg', seconds: 173.2, bytes: 2105130, starts: [13, 63.5, 126.5] },
  crisis: { file: 'music/crisis.ogg', seconds: 166.9, bytes: 1934753, starts: [5, 53.5, 94] },
  recovering: { file: 'music/recovering.ogg', seconds: 164.5, bytes: 2033279, starts: [37.5, 96.5] },
};

// 素材体积预算：超了就 red，防止有人继续往仓库塞整曲。
export const MUSIC_BYTE_BUDGET = 16 * 1024 * 1024;
