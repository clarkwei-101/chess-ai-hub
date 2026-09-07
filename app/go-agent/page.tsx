'use client';

import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { GoAgentPanel } from '@/components/go-agent/GoAgentPanel';
import Link from 'next/link';

// 围棋 AI Agent 专属页面
// 集成了 KataGo 引擎 + DeepSeek V4 + 30位大师知识库

export default function GoAgentPage() {
  const [kataStatus, setKataStatus] = useState<'checking' | 'ready' | 'error'>('checking');
  const [deepseekStatus, setDeepseekStatus] = useState<'checking' | 'connected' | 'disconnected'>('checking');
  const [kataAnalysis, setKataAnalysis] = useState<{ winRate: number; topMoves: string[] } | null>(null);
  const [moveHistory, setMoveHistory] = useState<string[]>([]);
  const [showIntro, setShowIntro] = useState(true);

  useEffect(() => {
    // 检查引擎状态
    fetch('/api/engine/health')
      .then((r) => r.json())
      .then((d) => {
        if (d.data?.go) setKataStatus('ready');
        else setKataStatus('error');
      })
      .catch(() => setKataStatus('error'));

    // 检查 DeepSeek 状态
    fetch('/api/deepseek')
      .then((r) => r.json())
      .then((d) => setDeepseekStatus(d.data?.connected ? 'connected' : 'disconnected'))
      .catch(() => setDeepseekStatus('disconnected'));
  }, []);

  const allReady = kataStatus === 'ready' && deepseekStatus === 'connected';

  return (
    <div className="min-h-screen bg-black-deep flex flex-col">
      {/* Header */}
      <header className="border-b border-silver-border/30 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link href="/" className="text-silver-dim hover:text-silver-primary text-sm transition-colors">
            ← 返回首页
          </Link>
          <div className="w-px h-4 bg-silver-border/30" />
          <Link href="/go" className="text-silver-dim hover:text-silver-primary text-sm transition-colors">
            ← 基础模式
          </Link>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full ${kataStatus === 'ready' ? 'bg-green-400 animate-pulse' : kataStatus === 'checking' ? 'bg-yellow-400' : 'bg-red-400'}`} />
            <span className="text-xs text-silver-dim">KataGo v1.18.1</span>
          </div>
          <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full ${deepseekStatus === 'connected' ? 'bg-green-400 animate-pulse' : deepseekStatus === 'checking' ? 'bg-yellow-400' : 'bg-red-400'}`} />
            <span className="text-xs text-silver-dim">DeepSeek V4</span>
          </div>
        </div>
      </header>

      {/* Hero */}
      <div className="px-6 pt-6 pb-4">
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <h1 className="text-2xl font-light text-gradient-silver">
            Cyber-Go <span className="text-silver-dim font-thin">· 大师知识库</span>
          </h1>
          <p className="text-silver-dim text-sm mt-1">
            35位中韩日顶尖棋手（含徐莹/於之莹/柯洁/李世石等）× DeepSeek V4 × KataGo · 用大师的思维下棋
          </p>
        </motion.div>
      </div>

      {/* 状态概览 */}
      <div className="px-6 pb-4">
        <div className="grid grid-cols-3 gap-3">
          {[
            { label: '大师棋手', value: '35', sub: '中/韩/日顶尖棋手' },
            { label: 'DeepSeek', value: allReady ? '在线' : '离线', sub: 'DGX Spark' },
            { label: 'KataGo', value: kataStatus === 'ready' ? '就绪' : '启动中', sub: 'Elo ~13716' },
          ].map((stat) => (
            <div key={stat.label} className="bg-black-elevated border border-silver-border/20 rounded-xl p-3">
              <div className="text-silver-primary text-lg font-light">{stat.value}</div>
              <div className="text-xs text-silver-dim">{stat.label}</div>
              <div className="text-[10px] text-silver-dark mt-0.5">{stat.sub}</div>
            </div>
          ))}
        </div>
      </div>

      {/* 主内容区 */}
      <div className="flex-1 px-6 pb-6">
        <AnimatePresence>
          {showIntro && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="mb-4"
            >
              <div className="bg-black-elevated border border-silver-border/30 rounded-2xl p-5">
                <h2 className="text-silver-primary text-base font-medium mb-3">🎯 Cyber-Go 能做什么？</h2>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
                  {[
                    { icon: '♟', title: '大师风格下棋', desc: '选择徐莹·於之莹·李世石·柯洁等35位大师，用他们的棋风分析和建议' },
                    { icon: '📖', title: '深度复盘', desc: '导入棋谱，由 AI 大师逐手分析优缺点，学习大师思维' },
                    { icon: '🎓', title: '个性化学习', desc: '根据你的水平推荐大师风格的学习路径，从入门到精通' },
                  ].map((item) => (
                    <div key={item.title} className="bg-black-rich rounded-xl p-3 border border-silver-border/20">
                      <div className="text-lg mb-1">{item.icon}</div>
                      <div className="text-silver-primary text-xs font-medium">{item.title}</div>
                      <div className="text-silver-dim text-[10px] mt-1 leading-relaxed">{item.desc}</div>
                    </div>
                  ))}
                </div>
                <button
                  onClick={() => setShowIntro(false)}
                  className="mt-4 text-xs text-silver-dim hover:text-silver-primary transition-colors"
                >
                  知道了，开始使用 →
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* AI Agent Panel — 全高模式 */}
        <div className="h-[calc(100vh-280px)] min-h-[500px] rounded-2xl overflow-hidden border border-silver-border/30">
          <GoAgentPanel
            kataAnalysis={kataAnalysis || undefined}
            moveHistory={moveHistory}
            onMoveSuggested={(move) => {
              console.log('Suggested move:', move);
            }}
          />
        </div>

        {/* 快速链接 */}
        <div className="mt-4 flex items-center justify-between text-xs text-silver-dim">
          <div className="flex items-center gap-4">
            <Link href="/go" className="hover:text-silver-primary transition-colors">
              基础模式
            </Link>
            <span className="text-silver-dark">|</span>
            <Link href="/chess" className="hover:text-silver-primary transition-colors">
              国际象棋
            </Link>
            <span className="text-silver-dark">|</span>
            <Link href="/xiangqi" className="hover:text-silver-primary transition-colors">
              中国象棋
            </Link>
          </div>
          <div>
            HKUST AI应用社 · Cyber Foundation
          </div>
        </div>
      </div>
    </div>
  );
}
