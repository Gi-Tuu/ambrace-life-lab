// 声音清单：游戏里"会发生的事"逐条登记，并标注它有没有对应的音。
//
// 为什么写成代码而不是文档：清单一旦是文档，就会和 audio-data.mjs 的配方表各漂各的。
// life/audio.test.mjs 的 A-07/A-08 直接拿这张表对账 ⇒ 有音无主、有主无音都会红。
//
// status：ready 已发声 / silent 刻意不出声（必须写 reason）/ planned 还没做（必须写 reason）。

export const SOUND_INVENTORY = [
  // ── 劳动与交互 ──
  { id: 'chop', cat: '劳动', zh: '砍伐（斧落木）', trigger: 'camp_chop / gather wood', status: 'ready' },
  { id: 'quarry', cat: '劳动', zh: '采石（镐击岩）', trigger: 'gather stone / quarry', status: 'ready' },
  { id: 'gather', cat: '劳动', zh: '采集（枝叶翻动）', trigger: 'camp_collect / forage', status: 'ready' },
  { id: 'forage', cat: '劳动', zh: '野莓搜寻（更轻）', trigger: 'forage', status: 'ready' },
  { id: 'plant', cat: '劳动', zh: '播种（土声）', trigger: 'camp_plant / plant', status: 'ready' },
  { id: 'water', cat: '劳动', zh: '浇水（水线）', trigger: 'camp_water', status: 'ready' },
  { id: 'harvest', cat: '劳动', zh: '收获入仓（容器）', trigger: 'harvest / camp_collect crop', status: 'ready' },
  { id: 'build', cat: '劳动', zh: '施工（两连锤）', trigger: 'build', status: 'ready' },
  { id: 'repair', cat: '劳动', zh: '维修（锤+石）', trigger: 'repair', status: 'ready' },
  { id: 'craft', cat: '劳动', zh: '制作（木+金属件）', trigger: 'camp_craft', status: 'ready' },
  { id: 'eat', cat: '劳动', zh: '进食（碗落+吞咽）', trigger: 'camp_eat', status: 'ready' },
  { id: 'store', cat: '劳动', zh: '存入容器', trigger: 'camp_store / deposit', status: 'ready' },
  { id: 'withdraw', cat: '劳动', zh: '取出容器', trigger: 'camp_take / withdraw', status: 'ready' },
  { id: 'exchange', cat: '劳动', zh: '兑换（铜币声）', trigger: 'exchange', status: 'ready' },
  { id: 'expand', cat: '劳动', zh: '扩建（三连击）', trigger: 'expand', status: 'ready' },
  { id: 'facility', cat: '劳动', zh: '使用设施（门+室内一声）', trigger: 'facility_use / 进屋', status: 'ready' },
  { id: 'road', cat: '劳动', zh: '铺路 / 拆路', trigger: 'road_lay / road_remove', status: 'ready' },
  { id: 'lookout', cat: '劳动', zh: '瞭望（风+远眺）', trigger: 'look_out', status: 'ready' },
  { id: 'rest', cat: '劳动', zh: '歇息（坐下）', trigger: 'rest / house_work', status: 'ready' },
  { id: 'move', cat: '劳动', zh: '走路', trigger: 'move / move_to', status: 'silent',
    reason: '脚步会盖住劳动声，且玩家高频移动时变成噪声' },

  // ── 生物 ──
  { id: 'chicken', cat: '生物', zh: '鸡鸣', trigger: '鸡在岗/受惊/产蛋', status: 'ready' },
  { id: 'cow', cat: '生物', zh: '牛叫', trigger: '牛群状态变化', status: 'ready' },
  { id: 'sheep', cat: '生物', zh: '羊叫', trigger: '剪毛/挤奶', status: 'ready' },
  { id: 'bird', cat: '生物', zh: '林鸟啼鸣', trigger: '白天林地环境声', status: 'ready' },
  { id: 'deer', cat: '生物', zh: '鹿（警觉短哼）', trigger: '外围靠近', status: 'ready' },
  { id: 'rabbit', cat: '生物', zh: '兔（蹬地）', trigger: '外围惊动', status: 'ready' },
  { id: 'fox', cat: '生物', zh: '狐（短促尖叫）', trigger: '外围惊动', status: 'ready' },
  { id: 'alarm', cat: '生物', zh: '畜群受惊', trigger: '屠宰/灾害惊扰', status: 'ready' },
  { id: 'slaughter', cat: '生物', zh: '屠宰（闷击）', trigger: 'animal_slaughter', status: 'ready' },
  { id: 'feed', cat: '生物', zh: '喂食（谷物洒落）', trigger: 'animal_feed', status: 'ready' },
  { id: 'treeFall', cat: '生物', zh: '树倒', trigger: '砍伐完成那一刻', status: 'ready' },
  { id: 'regrow', cat: '生物', zh: '树再生（嫩芽）', trigger: '再生到熟', status: 'planned',
    reason: '世界侧没有"再生完成"事件，需要规则层给出可听时刻才做，不为声音改规则' },

  // ── 生命周期 ──
  { id: 'birth', cat: '生命', zh: '出生（上行琶音）', trigger: 'sv.births 增加', status: 'ready' },
  { id: 'adult', cat: '生命', zh: '成年（清亮两音）', trigger: '阶段跃迁 child→adult', status: 'ready' },
  { id: 'elder', cat: '生命', zh: '老年（低沉两音）', trigger: '阶段跃迁 adult→elder', status: 'ready' },
  { id: 'death', cat: '生命', zh: '死亡（下行长音）', trigger: 'sv.deaths 增加', status: 'ready' },
  { id: 'marriage', cat: '生命', zh: '成婚（双声部合流）', trigger: 'spouses 新增', status: 'ready' },
  { id: 'widow', cat: '生命', zh: '丧偶（独声回落）', trigger: '配偶离世结算', status: 'planned',
    reason: '与 death 事件同源，会连响两声；等死亡只播一次的节流做完再定' },
  { id: 'playerDown', cat: '生命', zh: '玩家倒下（低频长音）', trigger: 'player.dead', status: 'ready' },
  { id: 'milestone', cat: '生命', zh: '阶段目标达成（和弦）', trigger: 'sv.won 变 true', status: 'ready' },
  { id: 'sleep', cat: '生命', zh: '入睡（渐弱）', trigger: 'camp_sleep', status: 'ready' },

  // ── 天气与灾害 ──
  { bed: true, id: 'rain', cat: '天气', zh: '雨声底', trigger: 'weather=rain', status: 'ready' },
  { bed: true, id: 'wind', cat: '天气', zh: '风底（寒潮/风暴）', trigger: 'weather=cold', status: 'ready' },
  { id: 'storm', cat: '天气', zh: '雷暴两连', trigger: 'disasterToday=storm', status: 'ready' },
  { id: 'cold', cat: '天气', zh: '寒潮（冰晶泛音）', trigger: 'disasterToday=coldsnap', status: 'ready' },
  { id: 'drought', cat: '天气', zh: '干旱（干裂噪声）', trigger: 's.drought 变 true', status: 'ready' },
  { bed: true, id: 'night', cat: '天气', zh: '夜虫', trigger: 'phase=夜', status: 'ready' },
  { bed: true, id: 'day', cat: '天气', zh: '白日微风', trigger: 'phase=晨/昼/暮', status: 'ready' },

  // ── 聚落状态 ──
  { id: 'crisisEnter', cat: '聚落', zh: '进入缺粮危机（低音下沉）', trigger: 'settlement→crisis', status: 'ready' },
  { bed: true, id: 'crisis', cat: '聚落', zh: '危机心跳（随缺口天数加密）', trigger: 'settlement=crisis/recovering', status: 'ready' },
  { id: 'recover', cat: '聚落', zh: '危机缓解（回升三音）', trigger: 'crisis→recovering', status: 'ready' },
  { id: 'extinct', cat: '聚落', zh: '聚落灭绝（空场长音）', trigger: 'settlement=extinct', status: 'ready' },
  { id: 'ration', cat: '聚落', zh: '每日配给（公仓一勺）', trigger: '跨日且有配给', status: 'ready' },
  { id: 'shortfall', cat: '聚落', zh: '配给不足（空仓敲击）', trigger: '跨日 shortfall>0', status: 'ready' },

  // ── 建造状态 ──
  { id: 'foundation', cat: '建造', zh: '奠基（木框落地）', trigger: 'plan 成功', status: 'ready' },
  { id: 'frameUp', cat: '建造', zh: '上框架（两声递进）', trigger: 'phase foundation→frame', status: 'ready' },
  { id: 'complete', cat: '建造', zh: '竣工（锤+和弦）', trigger: 'phase→complete', status: 'ready' },
  { id: 'damaged', cat: '建造', zh: '建筑受损（断裂+碎落）', trigger: 'integrity 跨档下降', status: 'ready' },

  // ── 合作与交谈 ──
  { id: 'coopAccept', cat: '合作', zh: '居民答应协助', trigger: 'decision=assist', status: 'ready' },
  { id: 'coopRefuse', cat: '合作', zh: '居民拒绝', trigger: 'decision=refuse', status: 'ready' },
  { id: 'coopAlt', cat: '合作', zh: '居民提出替代', trigger: 'decision=alternative', status: 'ready' },
  { id: 'coopExit', cat: '合作', zh: '工人中途退出', trigger: 'c.exits 增加', status: 'planned',
    reason: '载荷里 exits 只有总数、无时刻，做不出"哪一刻退"的声音；需要世界侧给事件时刻' },
  { id: 'talk', cat: '交谈', zh: '答应交谈', trigger: 'RESIDENT_TALKED', status: 'ready' },
  { id: 'talkIgnore', cat: '交谈', zh: '无视你', trigger: 'decision=ignore', status: 'ready' },
  { id: 'talkLeave', cat: '交谈', zh: '不耐烦走开', trigger: 'leaveTalk', status: 'ready' },
  { id: 'insult', cat: '交谈', zh: '被辱骂（刺耳短音）', trigger: 'decision=insult', status: 'ready' },
  { id: 'attack', cat: '交谈', zh: '被动手（闷击+受击）', trigger: 'RESIDENT_HURT / attack', status: 'ready' },

  // ── 界面 ──
  { id: 'click', cat: '界面', zh: '按钮/工具选择', trigger: 'UI 点击', status: 'ready' },
  { id: 'deny', cat: '界面', zh: '被规则层拒绝（统一一声）', trigger: '17+ 个反馈码', status: 'ready' },
  { id: 'dlgOpen', cat: '界面', zh: '弹窗打开', trigger: '6 个对话框', status: 'ready' },
  { id: 'dlgClose', cat: '界面', zh: '弹窗关闭', trigger: '同上', status: 'ready' },
  { id: 'bagOpen', cat: '界面', zh: '背包展开', trigger: 'E / 背包', status: 'ready' },
  { id: 'modeSwitch', cat: '界面', zh: '模式/视角切换', trigger: '生存游玩、世界全景、研究对照', status: 'ready' },
  { id: 'audioToggle', cat: '界面', zh: '音量档位确认音', trigger: '声音按钮', status: 'ready' },
];

export const inventoryByStatus = (status) => SOUND_INVENTORY.filter((x) => x.status === status);
export const inventoryCount = () => SOUND_INVENTORY.length;
export const inventoryCats = () => [...new Set(SOUND_INVENTORY.map((x) => x.cat))];
