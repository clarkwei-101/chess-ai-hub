'use client';

import { Analysis, GameVariant } from '@/lib/types';

interface ExplanationProps {
  analysis: Analysis | null;
  variant: GameVariant;
}

export function Explanation({ analysis, variant }: ExplanationProps) {
  if (!analysis) {
    return (
      <div className="text-silver-dim text-sm">
        Start the engine to see reasoning behind each move.
      </div>
    );
  }

  const wr = analysis.winRate;
  const reasons: string[] = [];

  if (analysis.scoreMate !== undefined) {
    if (analysis.scoreMate > 0) {
      reasons.push(`Forced mate in ${analysis.scoreMate} moves.`);
    } else {
      reasons.push(`Forced mate against you in ${-analysis.scoreMate} moves.`);
    }
  } else if (analysis.scoreCp !== undefined) {
    const pawns = analysis.scoreCp / 100;
    if (Math.abs(pawns) > 5) {
      reasons.push(`Position is ${pawns > 0 ? 'clearly winning' : 'clearly losing'} (${pawns > 0 ? '+' : ''}${pawns.toFixed(1)} pawns).`);
    } else if (Math.abs(pawns) > 2) {
      reasons.push(`Material edge of ${pawns > 0 ? '+' : ''}${pawns.toFixed(1)} pawns.`);
    } else if (Math.abs(pawns) > 0.5) {
      reasons.push(`Slight edge from positional pressure.`);
    } else {
      reasons.push(`Roughly equal position.`);
    }
  }

  // 围棋: policy + ownership
  if (variant === 'go' && analysis.policy) {
    const top = analysis.multiPv[0];
    if (top) {
      reasons.push(`Engine recommends ${top.move} based on neural net policy (${Math.round(top.winRate * 100)}% win rate).`);
    }
    if (analysis.ownership) {
      const blackTerr = analysis.ownership.flat().filter((v) => v > 0.3).length;
      const whiteTerr = analysis.ownership.flat().filter((v) => v < -0.3).length;
      reasons.push(`Expected territory: Black ${blackTerr} / White ${whiteTerr}.`);
    }
  }

  // 国际象棋/中国象棋: top move 解释
  if (variant !== 'go' && analysis.multiPv[0]) {
    const top = analysis.multiPv[0];
    const wrDiff = (top.winRate - 0.5) * 100;
    if (Math.abs(wrDiff) > 20) {
      reasons.push(`Best move ${top.move} swings evaluation by ${Math.abs(wrDiff).toFixed(0)}% in your favor.`);
    } else {
      reasons.push(`Engine sees multiple reasonable moves; ${top.move} is the principal choice.`);
    }
    if (top.pv.length > 4) {
      reasons.push(`Continuation: ${top.pv.slice(0, 6).join(' ')}.`);
    }
  }

  // Depth info
  if (analysis.depth > 0) {
    reasons.push(`Analysis depth: ${analysis.depth}${analysis.selDepth ? ` (seldepth ${analysis.selDepth})` : ''}.`);
  }

  return (
    <div className="space-y-2">
      {reasons.map((r, i) => (
        <div key={i} className="text-sm text-silver-mid leading-relaxed pl-3 border-l border-silver-border">
          {r}
        </div>
      ))}
      {analysis.multiPv.length > 1 && (
        <div className="mt-3 pt-3 border-t border-silver-border">
          <div className="text-[10px] uppercase tracking-wider text-silver-dim mb-2">Alternatives considered</div>
          <div className="flex flex-wrap gap-2">
            {analysis.multiPv.slice(1, 5).map((p) => (
              <span key={p.id} className="px-2 py-0.5 rounded text-[11px] font-mono bg-black-rich text-silver-mid">
                {p.move} · {Math.round(p.winRate * 100)}%
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}