'use client';

import { Analysis, GameVariant, PvLine } from '@/lib/types';

interface MoveListProps {
  lines: PvLine[];
  variant: GameVariant;
  onPick?: (move: string) => void;
}

export function MoveList({ lines, variant, onPick }: MoveListProps) {
  if (lines.length === 0) {
    return (
      <div className="text-silver-dim text-sm py-6 text-center">
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-silver-mid mr-2 animate-thinking" />
        Waiting for engine...
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      {lines.slice(0, 5).map((line) => {
        const pct = Math.round(line.winRate * 100);
        const isFirst = line.id === 1;
        return (
          <button
            key={line.id}
            onClick={() => onPick?.(line.move)}
            className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-all hover:bg-silver-mid/10 ${
              isFirst ? 'bg-silver-mid/5 border border-silver-mid/20' : 'border border-transparent'
            }`}
          >
            <div className={`text-xs font-mono w-6 text-center ${isFirst ? 'text-green-400' : 'text-silver-dim'}`}>
              #{line.id}
            </div>
            <div className="flex-1 text-left">
              <div className={`font-mono text-sm ${isFirst ? 'text-silver-primary font-medium' : 'text-silver-mid'}`}>
                {line.move}
                {line.pv.length > 1 && (
                  <span className="text-silver-dim ml-2 text-xs">
                    {line.pv.slice(1, 6).join(' ')}
                  </span>
                )}
              </div>
              {line.scoreCp !== undefined && (
                <div className="text-[10px] text-silver-dim font-mono mt-0.5">
                  {Math.abs(line.scoreCp) > 9000
                    ? line.scoreCp > 0
                      ? '+Mate'
                      : '-Mate'
                    : `${line.scoreCp >= 0 ? '+' : ''}${(line.scoreCp / 100).toFixed(2)}`}
                </div>
              )}
            </div>
            <div className="text-right">
              <div className={`text-sm font-light ${line.winRate > 0.5 ? 'text-green-400' : 'text-silver-dim'}`}>
                {pct}%
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}