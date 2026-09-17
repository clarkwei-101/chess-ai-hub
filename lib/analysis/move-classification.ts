// 走子分类 (妙手 / 本手 / 俗手 / 失误 / 不准确)
// AlphaGo 大师视角 + Lichess WDL 算法增强版:
//   - Brilliant (!!): 围棋基于目数变化(scoreLead), 象棋基于胜率+cp 双重判断
//   - Great (!): 目数 gain 3-8 (围棋) / 胜率变化 < 2% (象棋)
//   - Best (!): top1 move
//   - Good (=): top5 内,胜率变化 < 5%
//   - Inaccuracy (?!): 胜率跌 5-10%
//   - Mistake (?): 胜率跌 10-30%
//   - Blunder (??): 胜率跌 >30% 或 scoreCp 跌 >300cp
// 围棋特有: 妙手基于目数变化 (scoreLead 差值), 不依赖胜率变化 (围棋胜率在开局变化极小)
//
// P0-3 升级: AlphaGo 风格妙手检测
//   1. 围棋: 基于 scoreLead 变化 (目数) 检测妙手/佳着, 不依赖胜率
//   2. 象棋: 基于 winRate + cp 双重判断 (与 Lichess 一致)
//   3. 躲避妙手: 若本步后胜率/目数显著提升但对手刚走出失误, 标注"反击妙手"

export type MoveClassification =
  | 'brilliant'   // 妙手
  | 'great'       // 佳着
  | 'best'        // 最强手
  | 'good'        // 本手 (合理选择)
  | 'book'        // 开局定式
  | 'inaccuracy'  // 不准确
  | 'mistake'     // 失误
  | 'blunder'     // 俗手
  | 'forced';     // 必走 (只有 1 个合法)

export interface MoveClassificationInput {
  /** 走子前的胜率 (玩家视角 0-1) */
  prevWinRate: number;
  /** 走子后的胜率 (玩家视角 0-1) */
  currWinRate: number;
  /** 走子前的 scoreLead (围棋: 目数差; 象棋: cp 差) */
  prevScoreLead?: number;
  /** 走子后的 scoreLead */
  currScoreLead?: number;
  /** 走子前的 centipawn (可选, chess/xiangqi 用) */
  prevScoreCp?: number;
  /** 走子后的 centipawn */
  currScoreCp?: number;
  /** 当前走法是否是 engine top1 (multiPv[0]) */
  isEngineTop1?: boolean;
  /** 走法是否在 engine top5 内 (multiPv 0..4) */
  isEngineTopN?: boolean;
  /** 是否是开局的"定式着" (来自 opening book) */
  isBook?: boolean;
  /** 棋种: 'go' 使用 scoreLead 检测妙手, 其他使用 winRate */
  variant?: 'go' | 'chess' | 'xiangqi';
  /** 围棋特有: 对方上一步是否是失误/俗手 (用于反击妙手检测) */
  opponentWasBlunder?: boolean;
}

export interface ClassifiedMove {
  classification: MoveClassification;
  /** 0-5 的可视化严重度 (0=neutral 5=blunder 妙手为 -2 表示正向突出) */
  severity: number;
  /** 胜率变化 (玩家视角, 正=对你好, 负=对你差) */
  winRateDelta: number;
  /** 中文短标签 */
  label: string;
  /** 中文详细解释 (1-2 句) */
  description: string;
}

const CLASS_LABELS: Record<MoveClassification, string> = {
  brilliant: '!!',
  great: '!',
  best: '★',
  good: '○',
  book: '📖',
  inaccuracy: '?!',
  mistake: '?',
  blunder: '??',
  forced: '□',
};

const CLASS_LABELS_CN: Record<MoveClassification, string> = {
  brilliant: '妙手',
  great: '佳着',
  best: '最强手',
  good: '本手',
  book: '定式',
  inaccuracy: '不准确',
  mistake: '失误',
  blunder: '俗手',
  forced: '必走',
};

/** 主分类函数 */
export function classifyMove(input: MoveClassificationInput): ClassifiedMove {
  const wrDelta = input.currWinRate - input.prevWinRate;
  const cpDelta = (input.prevScoreCp !== undefined && input.currScoreCp !== undefined)
    ? input.currScoreCp - input.prevScoreCp
    : undefined;
  const leadDelta = (input.prevScoreLead !== undefined && input.currScoreLead !== undefined)
    ? input.currScoreLead - input.prevScoreLead
    : undefined;

  const isGo = input.variant === 'go';

  // 1. 开局定式优先
  if (input.isBook) {
    return {
      classification: 'book',
      severity: 0,
      winRateDelta: wrDelta,
      label: CLASS_LABELS.book,
      description: '开局定式 · 符合主流棋谱共识',
    };
  }

  // 2. AlphaGo 风格妙手检测
  // 围棋: 基于目数变化 (scoreLead delta) 检测
  // 象棋: 基于胜率 + cp 双重判断
  if (input.isEngineTop1) {
    if (isGo && leadDelta !== undefined) {
      // 围棋妙手: scoreLead 变化 ≥ 8 目 (围棋妙手通常 gain 8+ 目)
      if (leadDelta >= 8) {
        const counter = input.opponentWasBlunder ? ' · 反击妙手' : '';
        return {
          classification: 'brilliant',
          severity: -2,
          winRateDelta: wrDelta,
          label: CLASS_LABELS.brilliant,
          description: `妙手 · 围出 ${leadDelta >= 15 ? '大局' : '厚势'}(目数+${leadDelta.toFixed(1)})${counter}`,
        };
      }
      // 围棋佳着: scoreLead 变化 3-8 目
      if (leadDelta >= 3) {
        return {
          classification: 'great',
          severity: 0,
          winRateDelta: wrDelta,
          label: CLASS_LABELS.great,
          description: `佳着 · 收取目数+${leadDelta.toFixed(1)}`,
        };
      }
    } else if (!isGo && wrDelta > 0.25 && cpDelta !== undefined && cpDelta > 200) {
      // 象棋妙手: 胜率升 >25% 且 cp gain >200
      const counter = input.opponentWasBlunder ? ' · 反击妙手' : '';
      return {
        classification: 'brilliant',
        severity: -2,
        winRateDelta: wrDelta,
        label: CLASS_LABELS.brilliant,
        description: `妙手 · 化被动为主动${counter}`,
      };
    }
  }

  // 3. Best: top1 move (非妙手/佳着)
  if (input.isEngineTop1) {
    return {
      classification: 'best',
      severity: -1,
      winRateDelta: wrDelta,
      label: CLASS_LABELS.best,
      description: isGo && leadDelta !== undefined
        ? `引擎首推${leadDelta > 0 ? `(目数+${leadDelta.toFixed(1)})` : ''}`
        : '引擎首推',
    };
  }

  // 4. Great: top3 但不是 top1, 且胜率变化 < 2%
  if (input.isEngineTopN && Math.abs(wrDelta) < 0.03) {
    return {
      classification: 'great',
      severity: 0,
      winRateDelta: wrDelta,
      label: CLASS_LABELS.great,
      description: '佳着 · 引擎次选之一,胜率基本不变',
    };
  }

  // 5. Good (本手): top5 内, 胜率变化 < 5%
  if (input.isEngineTopN && Math.abs(wrDelta) < 0.05) {
    return {
      classification: 'good',
      severity: 0,
      winRateDelta: wrDelta,
      label: CLASS_LABELS.good,
      description: '本手 · 合理选择',
    };
  }

  // 6. 基于胜率跌幅分类
  if (wrDelta < -0.30 || (cpDelta !== undefined && cpDelta < -300)) {
    return {
      classification: 'blunder',
      severity: 3,
      winRateDelta: wrDelta,
      label: CLASS_LABELS.blunder,
      description: isGo && leadDelta !== undefined
        ? `俗手 · 失地${Math.abs(leadDelta).toFixed(1)}目(胜率跌 ${(Math.abs(wrDelta) * 100).toFixed(0)}%)`
        : `俗手 · 重大失误(胜率跌 ${(Math.abs(wrDelta) * 100).toFixed(0)}%)`,
    };
  }

  if (wrDelta < -0.10 || (cpDelta !== undefined && cpDelta < -150)) {
    return {
      classification: 'mistake',
      severity: 2,
      winRateDelta: wrDelta,
      label: CLASS_LABELS.mistake,
      description: `失误 · 胜率跌 ${(Math.abs(wrDelta) * 100).toFixed(0)}%`,
    };
  }

  if (wrDelta < -0.05 || (cpDelta !== undefined && cpDelta < -80)) {
    return {
      classification: 'inaccuracy',
      severity: 1,
      winRateDelta: wrDelta,
      label: CLASS_LABELS.inaccuracy,
      description: `不准确 · 胜率小跌 ${(Math.abs(wrDelta) * 100).toFixed(0)}%`,
    };
  }

  // 其他 (略优于对手或基本持平)
  return {
    classification: 'good',
    severity: 0,
    winRateDelta: wrDelta,
    label: CLASS_LABELS.good,
    description: '本手 · 形势基本持平',
  };
}

/** 批量分类一组历史走子 */
export interface MoveRecordForClassification {
  move: string;
  san: string;
  winRate?: number;
  scoreCp?: number;
  /** 围棋专用: scoreLead (目数差, from KataGo) */
  scoreLead?: number;
  analysisMultiPv?: string[];
  /** 棋种 */
  variant?: 'go' | 'chess' | 'xiangqi';
}

export function classifyMoveList(
  moves: MoveRecordForClassification[],
  options: {
    isBookMove?: (move: string, index: number) => boolean;
  } = {},
): ClassifiedMove[] {
  const out: ClassifiedMove[] = [];
  for (let i = 0; i < moves.length; i++) {
    const m = moves[i];
    const prev = i > 0 ? moves[i - 1] : null;
    const prevWr = prev?.winRate ?? 0.5;
    const currWr = m.winRate ?? prevWr;
    const prevCp = prev?.scoreCp ?? 0;
    const currCp = m.scoreCp ?? prevCp;
    const prevLead = prev?.scoreLead;
    const currLead = m.scoreLead;

    const top1 = m.analysisMultiPv?.[0];
    const topN = (m.analysisMultiPv ?? []).slice(0, 5);
    const isTop1 = !!top1 && top1 === m.move;
    const isTopN = topN.includes(m.move);
    const isBook = options.isBookMove?.(m.move, i) ?? false;

    // 检测对方上一步是否是失误/俗手 (用于反击妙手检测)
    const opponentPrev = i >= 2 ? moves[i - 2] : null;
    const opponentPrevWr = opponentPrev?.winRate ?? 0.5;
    const opponentPrevCp = opponentPrev?.scoreCp ?? 0;
    const opponentCurrWr = prev?.winRate ?? 0.5;
    const opponentCurrCp = prev?.scoreCp ?? 0;
    const opponentWrDelta = opponentCurrWr - opponentPrevWr;
    const opponentCpDelta = opponentCurrCp - opponentPrevCp;
    const opponentWasBlunder = opponentWrDelta < -0.20 || opponentCpDelta < -200;

    out.push(
      classifyMove({
        prevWinRate: prevWr,
        currWinRate: currWr,
        prevScoreLead: prevLead,
        currScoreLead: currLead,
        prevScoreCp: prevCp,
        currScoreCp: currCp,
        isEngineTop1: isTop1,
        isEngineTopN: isTopN,
        isBook,
        variant: m.variant,
        opponentWasBlunder,
      }),
    );
  }
  return out;
}

export function getClassificationLabel(c: MoveClassification): string {
  return CLASS_LABELS_CN[c];
}

/** 给定 classification 返回 CSS class 颜色 */
export function getClassificationColor(c: MoveClassification): string {
  switch (c) {
    case 'brilliant': return '#22D3EE'; // cyan - 妙手高亮
    case 'great': return '#10B981'; // green
    case 'best': return '#22C55E'; // green
    case 'good': return '#94A3B8'; // silver
    case 'book': return '#A78BFA'; // purple
    case 'inaccuracy': return '#FCD34D'; // yellow
    case 'mistake': return '#FB923C'; // orange
    case 'blunder': return '#EF4444'; // red
    case 'forced': return '#64748B';
  }
}
