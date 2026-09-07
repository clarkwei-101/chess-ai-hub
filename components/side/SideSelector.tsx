'use client';

import { Side } from '@/lib/types';

interface SideSelectorProps {
  variant: 'chess' | 'xiangqi' | 'go';
  sides: readonly Side[];
  value: Side;
  onChange: (side: Side) => void;
}

const LABELS: Record<string, { en: string; cn: string; color: string }> = {
  white: { en: 'White', cn: '白方', color: '#E8E8E8' },
  black: { en: 'Black', cn: '黑方', color: '#5A5A5A' },
  red: { en: 'Red', cn: '红方', color: '#D14545' },
};

export function SideSelector({ sides, value, onChange }: SideSelectorProps) {
  return (
    <div className="flex items-center gap-1 px-2 py-1 rounded-lg bg-black-elevated border border-silver-border">
      <span className="text-[10px] text-silver-dim uppercase tracking-wider mr-1 px-1">Side</span>
      {sides.map((side) => {
        const info = LABELS[side] || { en: side, cn: side, color: '#888' };
        const isActive = value === side;
        return (
          <button
            key={side}
            onClick={() => onChange(side)}
            className={`px-3 py-1 rounded text-xs transition-all ${
              isActive
                ? 'bg-silver-mid/20 text-silver-primary'
                : 'text-silver-dim hover:text-silver-mid'
            }`}
            style={isActive ? { boxShadow: `inset 0 0 0 1px ${info.color}` } : {}}
          >
            <span style={{ color: isActive ? info.color : undefined }}>{info.cn}</span>
          </button>
        );
      })}
    </div>
  );
}