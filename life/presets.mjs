// 世界预设（PLAN §28）：lab = 现有研究世界，逐位不变；town = 演示用自由世界。
// 位置顺序对 lab 是语义的一部分（候选清单顺序会进轨迹），不要重排 lab 的键。
export const LAB = Object.freeze({
  id: 'lab',
  locs: { home: '居所', hall: '走廊', watch: '瞭台', store: '公仓' },
  grid: { home: [0, 0], hall: [1, 0], watch: [0, 1], store: [1, 1] },
  outdoor: [],
  weather: false,
  speech: false,
  work: false,
  trade: false,
  companions: false,
  norms: false,
  things: [],
});

export const TOWN = Object.freeze({
  id: 'town',
  locs: { home: '居所', yard: '院子', hall: '走廊', store: '公仓', workshop: '工坊', garden: '菜园', watch: '瞭台', well: '井台' },
  grid: { home: [0, 0], yard: [1, 0], hall: [2, 0], store: [3, 0], workshop: [0, 1], garden: [1, 1], watch: [2, 1], well: [3, 1] },
  outdoor: ['yard', 'garden', 'watch', 'well'],
  weather: true,
  speech: true,
  work: true,
  trade: true,
  companions: true,
  norms: true,
  // 物件只放数据：美术统一后再画，逻辑先按这件事确实存在来跑（§28 A）
  things: [
    { id: 'bench', loc: 'workshop', label: '工作台' },
    { id: 'beds', loc: 'home', label: '床铺' },
    { id: 'crates', loc: 'store', label: '货箱' },
    { id: 'bedsG', loc: 'garden', label: '菜畦' },
    { id: 'bucket', loc: 'well', label: '水桶' },
  ],
});

export const PRESETS = Object.freeze({ lab: LAB, town: TOWN });

export function presetOf(name) {
  return PRESETS[name] ?? LAB;
}
