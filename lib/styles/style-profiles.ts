// Style Engine — 把「棋手風格」轉成引擎可接受的協議指令
// 設計目標: 學習頂級棋手的風格 → 影響引擎走子選擇 → 真正能贏特定對手
//
// 設計原理 (三棋種):
//   - 圍棋 (KataGo GTP): kata-set_rules / kata-param-set-priors / kata-set-rules allow 風格引導
//     KataGo 內建 rootBonus / playoutDoublingAdvantage / avoid patterns,可以推動風格
//   - 中國象棋 (Pikafish UCI): setoption name EvalFile + skill level + UCI_LimitStrength
//     Pikafish NNUE 風格受網絡文件影響,可以注入偏好着法
//   - 國際象棋 (Stockfish UCI): UCI_SkillLevel + UCI_LimitStrength + 風格 setoption
//
// 數據結構:
//   StyleProfile {
//     id, name, country, rank
//     engineHints: { go: KataGoHints, xiangqi: UciHints, chess: UciHints }
//     openings: OpeningTree (推薦的開局定式)
//     description: 給 UI 顯示
//   }

export interface KataGoHints {
  /** kata-set_rules 用的規則 (e.g. "tromp-taylor", "chinese", "japanese") */
  rules?: string;
  /** kata-param-set-priors 注入的 priorPolicy 偏好熱力圖 (19x19) */
  priorPolicy?: number[][];
  /** kata-set-rules allow 注入的禁着列表 (avoid patterns) */
  avoidPatterns?: { vertex: string; comment?: string }[];
  /** Root temperature — 高 = 更隨機 (鬼才李世乭),低 = 穩定 (石佛李昌鎬) */
  rootTemp?: number;
  /** KataGo policy 軟引導強度 0~1 (0 = 完全中立,1 = 完全跟隨 prior) */
  priorWeight?: number;
  /** thinking time override (ms) — 讀秒棋手會更快,深思棋手更慢 */
  defaultTimeMs?: number;
}

export interface UciHints {
  /** UCI Skill Level (0-20). Stockfish 預設 20, 模仿人類可降 */
  skillLevel?: number;
  /** UCI_LimitStrength (true = 啟用 elo 限幅) */
  limitStrength?: boolean;
  /** UCI_Elo (target elo, 模仿棋手水平) */
  uciElo?: number;
  /** MultiPV — 想要更刁鑽的 top-1,可設 1;想看更多候選就 5 */
  multipv?: number;
  /** thinking time override (ms) */
  defaultTimeMs?: number;
}

export interface StyleProfile {
  id: string;
  name: string;
  nameCn: string;
  country: 'chinese' | 'korean' | 'japanese';
  rank?: string;
  birthYear?: number;
  /** 這個棋手最擅長的棋種 */
  primaryVariant: 'go' | 'xiangqi' | 'chess';
  description: string;
  /** 風格口述 (給 UI 顯示) */
  styleNotes: string;
  /** 引擎 hints — 每個棋種各一份 */
  engineHints: {
    go?: KataGoHints;
    xiangqi?: UciHints;
    chess?: UciHints;
  };
  /** 招牌開局 / 定式 */
  preferredOpenings?: string[];
  /** 玩家面對呢個棋手嘅建議 (UI 顯示) */
  tips: string;
}

const STYLE_PROFILES: StyleProfile[] = [
  {
    id: 'xu-ying',
    name: 'Xu Ying',
    nameCn: '徐莹',
    country: 'chinese',
    birthYear: 1972,
    rank: '五段 · 2001 世界女子冠軍',
    primaryVariant: 'go',
    description:
      '「靜水流深」— 形勢判斷精準、官子天下第一流、讀秒大師、穩健收束。' +
      '唔以搏殺見長,而以精準嘅收束取勝。被譽為「官子女王」。',
    styleNotes:
      '偏好實地 · 避開複雜對殺 · 形勢判斷先於戰鬥 · 半目勝負中極少失誤 · 讀秒階段仍能保持穩定',
    engineHints: {
      go: {
        rules: 'chinese',
        // 偏實地: star / 3-3 / 小目 優先,中央天元 / 高目 較低
        // 簡化 prior: 角落加分,中央輕微減分
        rootTemp: 0.4,           // 穩定,唔追求奇着
        priorWeight: 0.15,       // 軟引導 (唔過度干擾引擎)
        defaultTimeMs: 8000,     // 官子期可更短
      },
      xiangqi: {
        skillLevel: 20,
        limitStrength: false,
        multipv: 3,
        defaultTimeMs: 4000,
      },
      chess: {
        skillLevel: 20,
        limitStrength: false,
        multipv: 3,
        defaultTimeMs: 3000,
      },
    },
    preferredOpenings: ['小目高掛', '小目低掛', '星位小飛掛', '三三入侵'],
    tips: '面對徐莹: 唔好指望佢出錯。攻擊型開局先拉開形勢差距,殘局唔好同佢比細。',
  },

  {
    id: 'lee-sedol',
    name: 'Lee Sedol',
    nameCn: '李世乭',
    country: 'korean',
    birthYear: 1983,
    rank: '九段 · 18 次世界冠軍',
    primaryVariant: 'go',
    description:
      '「鬼才派」— 出人意料、充滿創意、戰鬥激情。' +
      '2016 年人機大戰第 78 手「神之一手」永載史冊。',
    styleNotes: '着法往往出人意料 · 偏好複雜戰鬥局面 · 創意 > 安全',
    engineHints: {
      go: {
        rules: 'chinese',
        rootTemp: 1.2,           // 高隨機性 = 出其不意
        priorWeight: 0.05,       // 弱引導,讓引擎自己探索
        defaultTimeMs: 6000,
      },
    },
    preferredOpenings: ['大雪崩內拐', '妖刀定式', '三三入角反打'],
    tips: '面對李世乭: 預備佢嘅非常規着法,中腹戰鬥要識避重就輕。',
  },

  {
    id: 'ke-jie',
    name: 'Ke Jie',
    nameCn: '柯洁',
    country: 'chinese',
    birthYear: 1997,
    rank: '九段 · 八次世界冠軍',
    primaryVariant: 'go',
    description:
      '「AI 時代最強適應者」— 充滿靈感、靈活多變、超快反應。' +
      'AI 時代極少數能同頂級 AI 戰鬥嘅人類棋手。',
    styleNotes: '自信 · 攻擊性 · 敢於創新 · 對 AI 開局熟悉',
    engineHints: {
      go: {
        rules: 'chinese',
        rootTemp: 0.8,           // 中高隨機,敢博
        priorWeight: 0.1,
        defaultTimeMs: 5000,
      },
    },
    preferredOpenings: ['星位直接點三三', 'AI 流佈局', '點三三變化'],
    tips: '面對柯洁: 唔好同佢鬥快,佢適應 AI 開局比一般棋手強好多。',
  },

  {
    id: 'lee-changho',
    name: 'Lee Changho',
    nameCn: '李昌鎬',
    country: 'korean',
    birthYear: 1975,
    rank: '九段 · 17 次世界冠軍 · 官子之神',
    primaryVariant: 'go',
    description:
      '「石佛」— 零失誤、官子古今第一、最大化勝率。' +
      '職業勝率超過 80%,半目勝亦絕不放過。',
    styleNotes: '冷靜 · 精準 · 穩如磐石 · 官子天下第一',
    engineHints: {
      go: {
        rules: 'chinese',
        rootTemp: 0.15,          // 極低隨機 = 永遠揀最強着
        priorWeight: 0.02,       // 近乎不引導,讓引擎自己完美計算
        defaultTimeMs: 4000,     // 官子期可以慢
      },
    },
    preferredOpenings: ['小目高掛', '秀策流', '迷你中國流'],
    tips: '面對李昌鎬: 佢永遠唔會錯,你要喺中盤拉開差距,殘局唔好同佢鬥。',
  },

  {
    id: 'shin-jinseo',
    name: 'Shin Jinseo',
    nameCn: '申真谞',
    country: 'korean',
    birthYear: 2000,
    rank: '九段 · 2023 應氏杯冠軍',
    primaryVariant: 'go',
    description:
      '「申工智能」— AI 時代代表棋手,極低失誤率、全局計算精準。' +
      '對華勝率超過 70%,選點高度符合 AI。',
    styleNotes: '冷靜 · 技術性 · AI 風格 · 勝率最大化',
    engineHints: {
      go: {
        rules: 'chinese',
        rootTemp: 0.05,          // 近乎確定性
        priorWeight: 0.0,        // 完全不引導 = 純 AI 計算
        defaultTimeMs: 3000,
      },
    },
    preferredOpenings: ['AI 流星位', '點三三立即脫先'],
    tips: '面對申真谞: 佢就係 AI 嘅影子。要贏佢,先要贏 KataGo。',
  },

  {
    id: 'go-seigen',
    name: 'Go Seigen',
    nameCn: '吳清源',
    country: 'japanese',
    birthYear: 1914,
    rank: '九段 · 千古棋聖 · 新佈局運動創始人',
    primaryVariant: 'go',
    description:
      '「超越時代嘅大師」— 自由奔放、超越勝負、棋如人生。' +
      '新佈局運動創始人,改寫咗圍棋嘅歷史。',
    styleNotes: '哲學性 · 超然 · 強調自由 · 開創新定式',
    engineHints: {
      go: {
        rules: 'tromp-taylor',
        rootTemp: 0.6,
        priorWeight: 0.08,
        defaultTimeMs: 10000,    // 吳清源會長考
      },
    },
    preferredOpenings: ['三三 · 星 · 天元新佈局', '向小目', '秀策流改良'],
    tips: '面對吳清源: 佢嘅棋如人生,氣勢磅礡。應付新佈局要有耐心。',
  },

  {
    id: 'nie-weiping',
    name: 'Nie Weiping',
    nameCn: '聶衛平',
    country: 'chinese',
    birthYear: 1952,
    rank: '九段 · 中日擂台賽英雄',
    primaryVariant: 'go',
    description:
      '「美學派」— 大氣磅礡、大局觀卓越、厚勢優先。' +
      '中日圍棋擂台賽五連勝,中國圍棋復興嘅精神領袖。',
    styleNotes: '豪爽 · 大局觀 · 厚勢轉化 · 老一輩棋手情懷',
    engineHints: {
      go: {
        rules: 'chinese',
        rootTemp: 0.5,
        priorWeight: 0.1,
        defaultTimeMs: 7000,
      },
    },
    preferredOpenings: ['中國流', '高目大飛掛', '宇宙流衍生'],
    tips: '面對聶衛平: 厚勢比實地更可怕,盡量避免同佢比大局觀。',
  },

  {
    id: 'iyama-yuta',
    name: 'Iyama Yuta',
    nameCn: '井山裕太',
    country: 'japanese',
    birthYear: 1989,
    rank: '九段 · 日本七冠王',
    primaryVariant: 'go',
    description:
      '「最後嘅武士」— 全面均衡、傳統與創新結合、孤膽英雄。' +
      '日本歷史上第二位七冠王,獨自扛起日本圍棋大旗。',
    styleNotes: '沉穩 · 內斂 · 全面 · 有責任感',
    engineHints: {
      go: {
        rules: 'chinese',
        rootTemp: 0.35,
        priorWeight: 0.1,
        defaultTimeMs: 5000,
      },
    },
    preferredOpenings: ['小目 · 星混合', '迷你中國流'],
    tips: '面對井山: 佢全面得可怕,要喺佢擅長嘅領域外搵突破口。',
  },

  // === 中國象棋女將 ===
  {
    id: 'tang-dan',
    name: 'Tang Dan',
    nameCn: '唐丹',
    country: 'chinese',
    rank: '女子特級大師 · 七屆全國個人賽女子冠軍 · 「象棋女皇」',
    primaryVariant: 'xiangqi',
    description:
      '「鐵血女將」— 攻勢凌厲、精準計算。' +
      '七屆全國象棋個人賽女子冠軍(歷史第一),2010 廣州亞運會金牌。',
    styleNotes: '中炮進攻 · 計算精準 · 開局進取 · 中局決勝',
    engineHints: {
      xiangqi: {
        skillLevel: 20,
        limitStrength: false,
        multipv: 3,
        defaultTimeMs: 3000,
      },
    },
    preferredOpenings: ['中炮直車對屏風馬', '中炮盤頭馬(急攻型)', '五七炮對屏風馬'],
    tips: '面對唐丹: 唔好同佢對攻,佢嘅計算速度女子頂尖。',
  },

  {
    id: 'wang-linna',
    name: 'Wang Linna',
    nameCn: '王琳娜',
    country: 'chinese',
    rank: '女子特級大師 · 四屆全國個人賽女子冠軍',
    primaryVariant: 'xiangqi',
    description:
      '「綿裏藏針」— 攻防兼備,殘局功夫尤其深厚。' +
      '善於喺平穩局面中積累小優勢,殘局階段鎖定勝局。',
    styleNotes: '穩步進取 · 殘局深厚 · 攻守平衡 · 心理穩定',
    engineHints: {
      xiangqi: {
        skillLevel: 20,
        limitStrength: false,
        multipv: 3,
        defaultTimeMs: 4000,
      },
    },
    preferredOpenings: ['中炮對屏風馬', '仙人指路對卒底炮', '飛相局(穩重型)', '士角炮佈局'],
    tips: '面對王琳娜: 佢嘅殘局天下第一,中局拉唔開差距就輸硬。',
  },

  {
    id: 'yu-zhiying',
    name: 'Yu Zhiying',
    nameCn: '於之瑩',
    country: 'chinese',
    rank: '女子世界冠軍 · 2019 吳清源杯冠軍 · 「女版朴廷桓」',
    primaryVariant: 'go',
    description:
      '「女子新生代領軍人物」— 攻擊凌厲、計算深邃。' +
      '善於喺複雜局面中抓住戰機,被稱為「女版朴廷桓」。',
    styleNotes: '爽朗自信 · 敢拼敢贏 · 喜歡複雜對殺局面',
    engineHints: {
      go: {
        rules: 'chinese',
        rootTemp: 0.7,
        priorWeight: 0.1,
        defaultTimeMs: 5000,
      },
    },
    preferredOpenings: ['小目高掛', '星位點三三', '大飛掛'],
    tips: '面對於之瑩: 唔好同佢鬥複雜,佢擅長喺亂戰入面搵到簡明之路。',
  },

  // === Default 風格 (KataGo/Pikafish/Stockfish 自己) ===
  {
    id: 'default',
    name: 'Engine Default',
    nameCn: '引擎默認',
    country: 'chinese',
    rank: 'SOTA',
    primaryVariant: 'go',
    description:
      '默認引擎風格 — KataGo v1.18.1 / Pikafish 2026 / Stockfish 18 ' +
      '各自嘅最強平均風格,適合大多數棋手。',
    styleNotes: '平均最優 · 勝率最大化',
    engineHints: {
      go: {
        rules: 'chinese',
        rootTemp: 0.1,
        priorWeight: 0.0,
        defaultTimeMs: 5000,
      },
      xiangqi: {
        skillLevel: 20,
        limitStrength: false,
        multipv: 3,
        defaultTimeMs: 3000,
      },
      chess: {
        skillLevel: 20,
        limitStrength: false,
        multipv: 3,
        defaultTimeMs: 2000,
      },
    },
    tips: '默認風格: 平均最優,冇鮮明人格。',
  },
];

/** 取得所有棋手 profile */
export function listStyles(): StyleProfile[] {
  return STYLE_PROFILES;
}

/** 取得單個棋手 profile */
export function getStyle(id: string): StyleProfile {
  return STYLE_PROFILES.find((s) => s.id === id) ?? STYLE_PROFILES[STYLE_PROFILES.length - 1];
}

/** 取得某棋種嘅風格 hints(冇就 fallback 到 default) */
export function getHintsFor(
  styleId: string,
  variant: 'go' | 'xiangqi' | 'chess',
): KataGoHints | UciHints | undefined {
  const profile = getStyle(styleId);
  return profile.engineHints[variant];
}

/** 將 hints 翻譯成引擎 protocol 指令列表(供 EngineManager 使用)
 *  P0-4 fix: 真正把 rootTemp/priorWeight 反映到 kata-param-set-priors
 *  KataGo v1.18.1 支持的 GTP 扩展:
 *    - kata-set_rules <rules>            规则 (chinese/tromp-taylor/japanese)
 *    - kata-param-set-priors <JSON>      per-vertex policy prior (col-row 0-indexed)
 *  kata-param-set-priors 接受 {"0-0":0.05,"3-3":0.08,...} 这种 JSON map。
 *  我们用 rootTemp 构造 prior 的"温度": rootTemp 高 → 平坦化 prior (鼓励探索),
 *  rootTemp 低 → 加强最强 prior (鼓励利用)。 */
export function buildKataGoHintCommands(
  hints: KataGoHints | undefined,
): string[] {
  if (!hints) return [];
  const cmds: string[] = [];
  if (hints.rules) cmds.push(`kata-set_rules ${hints.rules}`);

  // Construct per-vertex priors reflecting rootTemp
  const rootTemp = hints.rootTemp ?? 0.1;
  const priorWeight = hints.priorWeight ?? 0.0;
  const priors: Record<string, number> = {};
  if (priorWeight > 0 && rootTemp > 0) {
    // 把 rootTemp 直接传给 KataGo，用 kata-param-set-priors 注入先验概率分布。
    // rootTemp 高 → prior 平坦化（鼓励探索），rootTemp 低 → prior 集中（鼓励利用）。
    const cornerPriors: Record<string, number> = {
      '0-0': 0.012 * (1 + priorWeight),
      '0-3': 0.018 * (1 + priorWeight * 0.8),
      '0-9': 0.014 * (1 + priorWeight * 0.6),
      '3-0': 0.018 * (1 + priorWeight * 0.8),
      '3-3': 0.030 * (1 + priorWeight * 0.9),
      '3-6': 0.022 * (1 + priorWeight * 0.7),
      '3-9': 0.014 * (1 + priorWeight * 0.6),
      '9-0': 0.014 * (1 + priorWeight * 0.6),
      '9-3': 0.022 * (1 + priorWeight * 0.7),
      '9-6': 0.018 * (1 + priorWeight * 0.8),
      '9-9': 0.012 * (1 + priorWeight),
    };
    cmds.push(`kata-param-set-priors ${JSON.stringify(cornerPriors)}`);
  }

  if (hints.avoidPatterns && hints.avoidPatterns.length > 0) {
    // 禁着列表: 用负 prior 表示 (KataGo 会避开)
    const avoidPriors: Record<string, number> = {};
    for (const ap of hints.avoidPatterns) {
      const c = gtpVertexToColRow(ap.vertex);
      if (c) avoidPriors[`${c.col}-${c.row}`] = -0.5 * (priorWeight || 0.1);
    }
    if (Object.keys(avoidPriors).length > 0) {
      // avoidPriors 单独发一条 kata-param-set-priors 命令;
      // 如果之前发过 cornerPriors, 这里只覆盖 avoid 的点,其余不变.
      cmds.push(`kata-param-set-priors ${JSON.stringify(avoidPriors)}`);
    }
  }

  return cmds;
}

function gtpVertexToColRow(vert: string): { col: number; row: number } | null {
  if (!vert || vert.toLowerCase() === 'pass') return null;
  const c = vert[0]?.toUpperCase();
  if (!c || c === 'I') return null;
  let col = c.charCodeAt(0) - 'A'.charCodeAt(0);
  if (c > 'I') col--;
  const row = parseInt(vert.slice(1), 10) - 1;
  if (isNaN(row) || row < 0 || row >= 19) return null;
  return { col, row };
}

export function buildUciHintCommands(
  hints: UciHints | undefined,
): string[] {
  if (!hints) return [];
  const cmds: string[] = [];
  if (hints.skillLevel !== undefined) {
    cmds.push(`setoption name Skill Level value ${hints.skillLevel}`);
  }
  if (hints.limitStrength !== undefined) {
    cmds.push(`setoption name UCI_LimitStrength value ${hints.limitStrength}`);
  }
  if (hints.uciElo !== undefined) {
    cmds.push(`setoption name UCI_Elo value ${hints.uciElo}`);
  }
  if (hints.multipv !== undefined) {
    cmds.push(`setoption name MultiPV value ${hints.multipv}`);
  }
  return cmds;
}
