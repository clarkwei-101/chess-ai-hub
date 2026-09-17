'use client';

import { useEffect, useState, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

interface ChessClockProps {
  /** True = this player is currently to move */
  isActive: boolean;
  /** Total remaining time in seconds */
  remainingSec: number;
  /** Label e.g. "你 (黑)" or "AI (白)" */
  label: string;
  /** Optional emoji-less flag/country code */
  flag?: string;
  /** Accent color when active */
  accentColor?: string;
  /** Indicates if this player is the user */
  isUser?: boolean;
}

export function ChessClock({ isActive, remainingSec, label, flag, accentColor = '#22C55E', isUser = false }: ChessClockProps) {
  const fmt = formatTime(remainingSec);
  const isLowTime = remainingSec < 30;
  const isCritical = remainingSec < 10;
  const [hasRunOut, setHasRunOut] = useState(false);
  const lastRemaining = useRef(remainingSec);

  useEffect(() => {
    if (lastRemaining.current > 0 && remainingSec <= 0) {
      setHasRunOut(true);
    }
    lastRemaining.current = remainingSec;
  }, [remainingSec]);

  return (
    <div className={`relative px-4 py-3 rounded-xl border transition-all duration-300 ${
      isActive
        ? 'border-silver-mid/60 bg-black-elevated shadow-lg shadow-black/40'
        : 'border-silver-border/30 bg-black-rich/40'
    }`}
    style={isActive ? { boxShadow: `0 0 0 1px ${accentColor}33, 0 0 24px ${accentColor}22` } : undefined}
    >
      {/* Active indicator pulse */}
      {isActive && (
        <motion.div
          className="absolute inset-0 rounded-xl pointer-events-none"
          initial={{ opacity: 0 }}
          animate={{ opacity: [0.3, 0.6, 0.3] }}
          transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
          style={{ boxShadow: `0 0 0 1px ${accentColor}66 inset` }}
        />
      )}

      <div className="relative flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          {flag && (
            <span className="text-[10px] px-1.5 py-0.5 rounded font-mono bg-silver-mid/10 text-silver-mid shrink-0">
              {flag}
            </span>
          )}
          <div className="min-w-0">
            <div className={`text-sm font-medium truncate ${isActive ? 'text-silver-primary' : 'text-silver-mid'}`}>
              {label}
            </div>
            <div className="text-[10px] text-silver-dim mt-0.5">
              {isUser ? '玩家' : '引擎'}
              {isLowTime && !isCritical && ' · 读秒'}
              {isCritical && ' · 最后机会'}
              {hasRunOut && ' · 超时'}
            </div>
          </div>
        </div>

        {/* Clock display */}
        <div className="flex items-center gap-2 shrink-0">
          <AnimatePresence>
            {isActive && (
              <motion.span
                key="tick"
                initial={{ opacity: 0, scale: 0.5 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.3 }}
                className="w-2 h-2 rounded-full animate-pulse"
                style={{ background: accentColor }}
              />
            )}
          </AnimatePresence>
          <span className={`font-mono text-2xl tabular-nums tracking-tight ${
            isCritical ? 'text-red-400 font-bold' :
            isLowTime ? 'text-amber-300' :
            isActive ? 'text-silver-primary' : 'text-silver-dim'
          }`}>
            {fmt}
          </span>
        </div>
      </div>
    </div>
  );
}

function formatTime(sec: number): string {
  if (sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  if (m > 0) return `${m}:${s.toString().padStart(2, '0')}`;
  return `${sec.toFixed(1)}s`;
}

interface DualClockProps {
  /** Active side: 'player' or 'ai' */
  activeSide: 'player' | 'ai';
  /** Player remaining seconds */
  playerSec: number;
  /** AI remaining seconds */
  aiSec: number;
  /** Player label */
  playerLabel: string;
  /** AI label */
  aiLabel: string;
  /** Player flag */
  playerFlag?: string;
  /** AI flag */
  aiFlag?: string;
  /** Pause the clocks (when game ends) */
  paused?: boolean;
}

/**
 * Dual player chess clock — decrements only the active side's time.
 * Use with 30-min + 10-sec increment style time control.
 */
export function DualClock({ activeSide, playerSec, aiSec, playerLabel, aiLabel, playerFlag, aiFlag, paused = false }: DualClockProps) {
  const [p, setP] = useState(playerSec);
  const [a, setA] = useState(aiSec);

  // Sync from props when they change (e.g. time control reset)
  useEffect(() => { setP(playerSec); }, [playerSec]);
  useEffect(() => { setA(aiSec); }, [aiSec]);

  // Tick down only the active clock
  useEffect(() => {
    if (paused) return;
    const id = setInterval(() => {
      if (activeSide === 'player') setP((v) => Math.max(0, v - 0.1));
      else if (activeSide === 'ai') setA((v) => Math.max(0, v - 0.1));
    }, 100);
    return () => clearInterval(id);
  }, [activeSide, paused]);

  // Increment on move switch (10 sec increment for each move, like blitz)
  // We add this when active side CHANGES (player just moved, now AI's turn)
  const lastSide = useRef(activeSide);
  useEffect(() => {
    if (lastSide.current !== activeSide) {
      // 10-second increment applied to the player who JUST finished
      if (lastSide.current === 'player') setP((v) => v + 10);
      else setA((v) => v + 10);
    }
    lastSide.current = activeSide;
  }, [activeSide]);

  return (
    <div className="space-y-2">
      <ChessClock
        isActive={activeSide === 'player'}
        remainingSec={p}
        label={playerLabel}
        flag={playerFlag}
        accentColor="#22C55E"
        isUser
      />
      <ChessClock
        isActive={activeSide === 'ai'}
        remainingSec={a}
        label={aiLabel}
        flag={aiFlag}
        accentColor="#3B82F6"
        isUser={false}
      />
    </div>
  );
}
