'use client';

import { motion } from 'framer-motion';

interface WinRateBarProps {
  value: number; // 0~1
  label: string;
  sublabel?: string;
}

export function WinRateBar({ value, label, sublabel }: WinRateBarProps) {
  const pct = Math.max(0, Math.min(1, value));
  const isWinning = pct > 0.5;
  return (
    <div>
      <div className="flex items-baseline justify-between mb-3">
        <div>
          <div className="text-3xl font-light text-silver-primary tracking-tight">{label}</div>
          {sublabel && <div className="text-xs text-silver-dim mt-1 font-mono">{sublabel}</div>}
        </div>
        <div
          className={`text-xs uppercase tracking-wider font-medium ${
            isWinning ? 'text-green-400' : pct < 0.5 ? 'text-red-400' : 'text-silver-dim'
          }`}
        >
          {isWinning ? 'Winning' : pct < 0.5 ? 'Losing' : 'Even'}
        </div>
      </div>
      <div className="relative h-2 rounded-full bg-black-elevated overflow-hidden">
        <motion.div
          className="absolute left-0 top-0 h-full"
          style={{
            width: `${pct * 100}%`,
            background: isWinning
              ? 'linear-gradient(90deg, #22C55E 0%, #4ADE80 100%)'
              : 'linear-gradient(90deg, #EF4444 0%, #F87171 100%)',
          }}
          animate={{ width: `${pct * 100}%` }}
          transition={{ duration: 0.3, ease: 'easeOut' }}
        />
        <div className="absolute left-1/2 top-0 h-full w-px bg-silver-mid/30" />
      </div>
      <div className="flex justify-between mt-1 text-[10px] text-silver-dim">
        <span>0%</span>
        <span>50%</span>
        <span>100%</span>
      </div>
    </div>
  );
}