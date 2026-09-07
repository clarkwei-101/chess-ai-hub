'use client';

import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type { GameVariant } from '@/lib/types';

interface StyleInfo {
  id: string;
  name: string;
  nameCn: string;
  country: 'chinese' | 'korean' | 'japanese';
  rank?: string;
  primaryVariant: GameVariant;
  description: string;
}

interface StyleSelectorProps {
  variant: GameVariant;
  value: string;
  onChange: (styleId: string) => void;
}

const COUNTRY_FLAG: Record<string, string> = {
  chinese: 'CN',
  korean: 'KR',
  japanese: 'JP',
};

export function StyleSelector({ variant, value, onChange }: StyleSelectorProps) {
  const [styles, setStyles] = useState<StyleInfo[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<StyleInfo | null>(null);

  useEffect(() => {
    fetch('/api/engine/set-style')
      .then((r) => r.json())
      .then((d) => {
        if (d.ok) setStyles(d.data.styles);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (styles.length > 0) {
      setSelected(styles.find((s) => s.id === value) ?? styles[styles.length - 1] ?? null);
    }
  }, [styles, value]);

  // 按 primaryVariant 过滤 + 提供 default 兜底
  const filtered = styles.filter((s) => s.primaryVariant === variant || s.id === 'default');
  const grouped = {
    chinese: filtered.filter((s) => s.country === 'chinese'),
    korean: filtered.filter((s) => s.country === 'korean'),
    japanese: filtered.filter((s) => s.country === 'japanese'),
  };

  function handleSelect(id: string) {
    onChange(id);
    setOpen(false);
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 px-3 py-2 rounded-lg border border-silver-mid/30 bg-black-elevated hover:bg-silver-mid/10 transition-colors text-sm"
      >
        <span className="text-silver-dim text-xs">Style · 棋手</span>
        {selected ? (
          <span className="text-silver-primary font-medium">{selected.nameCn}</span>
        ) : (
          <span className="text-silver-dim">Loading...</span>
        )}
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={`text-silver-mid transition-transform ${open ? 'rotate-180' : ''}`}>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.15 }}
            className="absolute right-0 top-full mt-2 w-[420px] max-h-[600px] overflow-y-auto bg-black-rich border border-silver-mid/30 rounded-xl shadow-2xl z-50 p-4"
          >
            {loading && <div className="text-silver-dim text-sm text-center py-4">Loading styles...</div>}

            {!loading && (
              <>
                <div className="text-xs text-silver-dim uppercase tracking-wider mb-3">
                  {variant === 'go' ? '围棋大师风格' : variant === 'xiangqi' ? '中国象棋大师风格' : '国际象棋大师风格'}
                </div>

                {(['chinese', 'korean', 'japanese'] as const).map((country) =>
                  grouped[country].length === 0 ? null : (
                    <div key={country} className="mb-4">
                      <div className="flex items-center gap-2 mb-2">
                        <span className="text-[10px] px-1.5 py-0.5 rounded font-mono bg-silver-mid/10 text-silver-mid">
                          {COUNTRY_FLAG[country]}
                        </span>
                        <span className="text-xs text-silver-dim">
                          {country === 'chinese' ? '中国 / Chinese' : country === 'korean' ? '韩国 / Korean' : '日本 / Japanese'}
                        </span>
                      </div>
                      <div className="space-y-1.5">
                        {grouped[country].map((s) => (
                          <button
                            key={s.id}
                            onClick={() => handleSelect(s.id)}
                            className={`w-full text-left p-2.5 rounded-lg border transition-all ${
                              s.id === value
                                ? 'border-cyan-400/50 bg-cyan-500/10'
                                : 'border-silver-border/40 hover:border-silver-mid/40 hover:bg-silver-mid/5'
                            }`}
                          >
                            <div className="flex items-baseline justify-between gap-2">
                              <span className="text-silver-primary font-medium text-sm">{s.nameCn}</span>
                              {s.rank && <span className="text-[10px] text-silver-dim">{s.rank}</span>}
                            </div>
                            <div className="text-[10px] text-silver-dim mt-0.5">{s.name}</div>
                            <div className="text-xs text-silver-mid mt-1.5 line-clamp-2">{s.description}</div>
                          </button>
                        ))}
                      </div>
                    </div>
                  ),
                )}
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
