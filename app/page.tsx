'use client';

import Link from 'next/link';
import { motion } from 'framer-motion';
import { useEffect, useState } from 'react';

interface HealthStatus {
  chess: boolean;
  xiangqi: boolean;
  go: boolean;
}

const GAMES = [
  {
    variant: 'go' as const,
    title: 'Go · 围棋',
    subtitle: '19×19 board',
    description: 'Surround territory. KataGo v1.18.1 with policy arrows and ownership heatmap.',
    accent: '#E8E8E8',
    href: '/go',
    aiAgentHref: '/go-agent',
    engine: 'KataGo',
    elo: '13716',
  },
  {
    variant: 'xiangqi' as const,
    title: 'Xiangqi · 中国象棋',
    subtitle: '9×10 board',
    description: 'Across the river. Pikafish 2026 with red/black side selection.',
    accent: '#C0C0C0',
    href: '/xiangqi',
    engine: 'Pikafish',
    elo: 'SOTA',
  },
  {
    variant: 'chess' as const,
    title: 'Chess · 国际象棋',
    subtitle: '8×8 board',
    description: 'From e4 to endgame. Stockfish 18 with NNUE evaluation and multipv analysis.',
    accent: '#8A8A8A',
    href: '/chess',
    engine: 'Stockfish',
    elo: '3700+',
  },
];

export default function HomePage() {
  const [health, setHealth] = useState<HealthStatus | null>(null);

  useEffect(() => {
    fetch('/api/engine/health')
      .then((r) => r.json())
      .then((d) => setHealth(d.data))
      .catch(() => setHealth({ chess: false, xiangqi: false, go: false }));
  }, []);

  return (
    <main className="min-h-screen bg-black-deep">
      {/* Header */}
      <header className="border-b border-silver-border">
        <div className="max-w-7xl mx-auto px-6 py-5 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Logo />
            <div>
              <h1 className="text-silver-primary font-semibold text-lg tracking-wide">Chess AI Hub</h1>
              <p className="text-silver-dim text-xs">AlphaGo-Style Multi-Variant Engine</p>
            </div>
          </div>
          <div className="flex items-center gap-4 text-xs text-silver-dim">
            <span>HKUST AI应用社 · Cyber Foundation</span>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="max-w-7xl mx-auto px-6 pt-20 pb-12">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7 }}
        >
          <h2 className="text-5xl md:text-7xl font-light tracking-tight text-gradient-silver leading-tight">
            Three Games.<br/>One Engine. <span className="text-gradient-glow">Zero Hubris.</span>
          </h2>
          <p className="text-silver-mid mt-6 max-w-2xl text-lg leading-relaxed">
            AlphaGo-style analysis for Go, Xiangqi, and Chess. Real-time win rate, top-3 candidate moves,
            policy arrows, and explainable reasoning behind every recommendation.
          </p>
          <div className="mt-8 flex items-center gap-6 text-sm text-silver-dim">
            <Stat label="Variants" value="3" />
            <Divider />
            <Stat label="Engine" value="SOTA" />
            <Divider />
            <Stat label="Speed" value="ms" />
            <Divider />
            <Stat label="Mode" value="Local" />
          </div>
        </motion.div>
      </section>

      {/* Demo Mode Banner — shown when engines unavailable (e.g. serverless deploy) */}
      {health && !health.chess && !health.xiangqi && !health.go && (
        <section className="max-w-7xl mx-auto px-6 pb-6">
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4 }}
            className="glass rounded-2xl px-6 py-4 border-cyan-500/20 flex flex-col md:flex-row items-start md:items-center gap-3"
          >
            <div className="w-8 h-8 rounded-lg bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center shrink-0">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-cyan-400">
                <circle cx="12" cy="12" r="10"/>
                <path d="M12 8v4M12 16h.01"/>
              </svg>
            </div>
            <div className="flex-1">
              <div className="text-silver-primary text-sm font-medium">Demo Mode · UI Preview</div>
              <div className="text-silver-dim text-xs mt-0.5">
                This serverless build ships the UI only — engine binaries are not bundled. Clone the repo and run{' '}
                <code className="px-1.5 py-0.5 rounded bg-black-elevated text-cyan-300 font-mono text-[11px]">npm run engines:download && npm run dev</code>{' '}
                locally to play against Stockfish / Pikafish / KataGo.
              </div>
            </div>
            <a
              href="https://github.com/clarkwei-101/chess-ai-hub"
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-cyan-400 hover:text-cyan-300 whitespace-nowrap flex items-center gap-1"
            >
              View on GitHub →
            </a>
          </motion.div>
        </section>
      )}

      {/* Game Selector */}
      <section className="max-w-7xl mx-auto px-6 pb-24">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {GAMES.map((g, i) => {
            const ready = health?.[g.variant] ?? false;
            return (
              <motion.div
                key={g.variant}
                initial={{ opacity: 0, y: 30 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: 0.1 + i * 0.1 }}
              >
                <Link href={g.href}>
                  <div className="group glass rounded-2xl p-8 h-full hover:border-silver-mid/40 transition-all duration-300 cursor-pointer relative overflow-hidden">
                    <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500 shimmer pointer-events-none" />
                    <div className="relative z-10">
                      <div className="flex items-start justify-between mb-6">
                        <div className="text-4xl font-light text-gradient-silver">{g.title}</div>
                        <EngineBadge ready={ready} engine={g.engine} />
                      </div>
                      <div className="text-silver-dim text-sm mb-4">{g.subtitle}</div>
                      <p className="text-silver-mid text-sm leading-relaxed mb-6">{g.description}</p>
                      <div className="flex items-center justify-between text-xs text-silver-dim">
                        <span>{g.engine} · Elo {g.elo}</span>
                        <span className="text-silver-mid group-hover:text-silver-primary transition-colors">
                          Enter →
                        </span>
                      </div>
                      {/* AI Agent 入口（仅围棋） */}
                      {g.aiAgentHref && (
                        <Link href={g.aiAgentHref}>
                          <div className="mt-3 pt-3 border-t border-silver-border/20 flex items-center gap-2 text-cyan-400 hover:text-cyan-300 transition-colors text-xs">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2z"/>
                              <path d="M12 8v4l3 3"/>
                            </svg>
                            AI Agent · 大师知识库 →
                          </div>
                        </Link>
                      )}
                    </div>
                  </div>
                </Link>
              </motion.div>
            );
          })}
        </div>

        {/* Visual Mode — Connect Lichess */}
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.45 }}
          className="mt-6"
        >
          <Link href="/visual">
            <div className="group glass rounded-2xl p-8 hover:border-cyan-500/40 transition-all duration-300 cursor-pointer relative overflow-hidden">
              <div className="absolute inset-0 bg-gradient-to-r from-cyan-500/5 via-blue-500/5 to-purple-500/5 opacity-0 group-hover:opacity-100 transition-opacity" />
              <div className="relative z-10 grid grid-cols-1 md:grid-cols-[1fr_auto] gap-6 items-center">
                <div>
                  <div className="flex items-center gap-3 mb-3">
                    <div className="w-10 h-10 rounded-lg bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center">
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-cyan-400">
                        <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z" />
                        <circle cx="12" cy="12" r="3" />
                      </svg>
                    </div>
                    <div>
                      <div className="text-silver-primary font-medium text-lg">Visual Mode</div>
                      <div className="text-silver-dim text-xs">Connect Lichess · AI plays for you</div>
                    </div>
                  </div>
                  <p className="text-silver-mid text-sm leading-relaxed">
                    Paste a Lichess game or board URL. The AI reads the position via the Lichess API, analyzes with Stockfish,
                    and plays the best move — all through a single connection. No screen capture needed.
                  </p>
                </div>
                <div className="flex items-center gap-2 text-cyan-400 text-sm font-medium">
                  Connect Game
                  <span className="text-2xl group-hover:translate-x-1 transition-transform">→</span>
                </div>
              </div>
            </div>
          </Link>
        </motion.div>
      </section>

      {/* Status Footer */}
      <footer className="border-t border-silver-border">
        <div className="max-w-7xl mx-auto px-6 py-5 flex items-center justify-between text-xs text-silver-dim">
          <div className="flex items-center gap-4">
            <HealthDot name="Stockfish 18" ready={!!health?.chess} />
            <HealthDot name="Pikafish 2026" ready={!!health?.xiangqi} />
            <HealthDot name="KataGo v1.18.1" ready={!!health?.go} />
          </div>
          <span>localhost:{typeof window !== 'undefined' ? window.location.port : '3002'} · {new Date().getFullYear()}</span>
        </div>
      </footer>
    </main>
  );
}

function Logo() {
  return (
    <div className="w-10 h-10 rounded-xl border border-silver-mid/30 flex items-center justify-center bg-black-elevated">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="text-silver-primary">
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18M12 3v18M5 5l14 14M19 5L5 19" strokeOpacity="0.4" />
      </svg>
    </div>
  );
}

function EngineBadge({ ready, engine }: { ready: boolean; engine: string }) {
  return (
    <div className={`px-2 py-1 rounded-full text-[10px] tracking-wide font-mono border ${
      ready
        ? 'border-green-500/40 text-green-400 bg-green-500/10'
        : 'border-silver-dark/30 text-silver-dim bg-black-rich'
    }`}>
      {ready ? `${engine} ●` : `${engine} ○`}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-silver-primary text-2xl font-light">{value}</div>
      <div className="text-silver-dim text-xs uppercase tracking-wider mt-1">{label}</div>
    </div>
  );
}

function Divider() {
  return <div className="w-px h-8 bg-silver-border" />;
}

function HealthDot({ name, ready }: { name: string; ready: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <div className={`w-2 h-2 rounded-full ${ready ? 'bg-green-500 animate-pulse-glow' : 'bg-silver-dark'}`} />
      <span>{name}</span>
    </div>
  );
}