'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

// ============ 类型定义 ============

export interface PlayerOption {
  id: string;
  name: string;
  nameCn: string;
  country: 'chinese' | 'korean' | 'japanese';
  style: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  playerId?: string;
  timestamp: number;
}

interface GoAgentPanelProps {
  fen?: string;
  moveHistory?: string[];
  kataAnalysis?: {
    winRate: number;
    topMoves: string[];
  };
  onMoveSuggested?: (move: string) => void;
}

// ============ 国家旗帜 ============
const FLAG: Record<string, string> = {
  chinese: '🇨🇳',
  korean: '🇰🇷',
  japanese: '🇯🇵',
};

// ============ 预设大师风格面板 ============
const STYLE_GROUPS: Array<{
  label: string;
  flag: string;
  players: PlayerOption[];
}> = [
  {
    label: '🇨🇳 中国',
    flag: '🇨🇳',
    players: [
      { id: 'xu-ying', name: 'Xu Ying', nameCn: '徐莹', country: 'chinese', style: '静水流深·官子女王·读秒神算' },
      { id: 'yu-zhiying', name: 'Yu Zhiying', nameCn: '於之莹', country: 'chinese', style: '女版朴廷桓·攻击凌厉' },
      { id: 'zhou-hongyu', name: 'Zhou Hongyu', nameCn: '周泓余', country: 'chinese', style: '00后天才·快棋新锐' },
      { id: 'lu-minquan', name: 'Lu Minquan', nameCn: '陆敏全', country: 'chinese', style: '全面稳健·稳定输出' },
      { id: 'ke-jie', name: 'Ke Jie', nameCn: '柯洁', country: 'chinese', style: 'AI天才/自信张扬' },
      { id: 'nie-weiping', name: 'Nie Weiping', nameCn: '聂卫平', country: 'chinese', style: '大局观/美学派' },
      { id: 'ma-xiaochun', name: 'Ma Xiaochun', nameCn: '马晓春', country: 'chinese', style: '轻灵飘逸' },
      { id: 'chang-hao', name: 'Chang Hao', nameCn: '常昊', country: 'chinese', style: '均衡稳健' },
      { id: 'gu-li', name: 'Gu Li', nameCn: '古力', country: 'chinese', style: '力量派' },
      { id: 'mi-yuting', name: 'Mi Yuting', nameCn: '芈昱廷', country: 'chinese', style: '暴力美学' },
      { id: 'gu-zihao', name: 'Gu Zihao', nameCn: '辜梓豪', country: 'chinese', style: '力量派' },
      { id: 'yang-dingxin', name: 'Yang Dingxin', nameCn: '杨鼎新', country: 'chinese', style: 'AI均衡' },
      { id: 'li-xuanhao', name: 'Li Xuanhao', nameCn: '李轩豪', country: 'chinese', style: 'AI派' },
      { id: 'xie-erhao', name: 'Xie Erhao', nameCn: '谢尔豪', country: 'chinese', style: '冲击力' },
    ],
  },
  {
    label: '🇰🇷 韩国',
    flag: '🇰🇷',
    players: [
      { id: 'lee-sedol', name: 'Lee Sedol', nameCn: '李世石', country: 'korean', style: '鬼才派/神之一手' },
      { id: 'lee-changho', name: 'Lee Changho', nameCn: '李昌镐', country: 'korean', style: '官子之神/石佛' },
      { id: 'shin-jinseo', name: 'Shin Jinseo', nameCn: '申真谞', country: 'korean', style: '申工智能/AI之子' },
      { id: 'cho-hunhyun', name: 'Cho Hunhyun', nameCn: '曹薰铉', country: 'korean', style: '快枪派' },
      { id: 'park-junghwan', name: 'Park Junghwan', nameCn: '朴廷桓', country: 'korean', style: '全面派' },
      { id: 'choe-cheolhan', name: 'Choe Cheolhan', nameCn: '崔哲瀚', country: 'korean', style: '毒蛇攻击' },
      { id: 'ryu-changhyuk', name: 'Ryu Changhyuk', nameCn: '刘昌赫', country: 'korean', style: '美力派' },
      { id: 'won-seongjin', name: 'Won Seongjin', nameCn: '元晟溱', country: 'korean', style: '力量派' },
      { id: 'kang-dongyun', name: 'Kang Dongyun', nameCn: '姜东润', country: 'korean', style: '均衡派' },
      { id: 'kim-jihyeok', name: 'Kim Jihyeok', nameCn: '金志锡', country: 'korean', style: '才华派' },
    ],
  },
  {
    label: '🇯🇵 日本',
    flag: '🇯🇵',
    players: [
      { id: 'go-seigen', name: 'Go Seigen', nameCn: '吴清源', country: 'japanese', style: '千古棋圣/新布局' },
      { id: 'kitani-minoru', name: 'Kitani Minoru', nameCn: '木谷实', country: 'japanese', style: '新布局/教育家' },
      { id: 'cho-chikun', name: 'Cho Chikun', nameCn: '赵治勋', country: 'japanese', style: '斗魂派' },
      { id: 'kobayashi-koichi', name: 'Kobayashi Koichi', nameCn: '小林光一', country: 'japanese', style: '均衡派' },
      { id: 'iyama-yuta', name: 'Iyama Yuta', nameCn: '井山裕太', country: 'japanese', style: '孤胆英雄/七冠王' },
      { id: 'takao-shinji', name: 'Takao Shinji', nameCn: '高尾绅路', country: 'japanese', style: '力量派' },
      { id: 'fujisawa-rina', name: 'Fujisawa Rina', nameCn: '藤泽里菜', country: 'japanese', style: '女子新星' },
      { id: 'ueno-asami', name: 'Ueno Asami', nameCn: '上野爱咲美', country: 'japanese', style: '战斗少女' },
      { id: 'murakawa-daisuke', name: 'Murakawa Daisuke', nameCn: '村川大介', country: 'japanese', style: '均衡派' },
      { id: 'kyo-kengo', name: 'Kyo Kengo', nameCn: '京大刚伍', country: 'japanese', style: 'AI派' },
    ],
  },
];

const ALL_PLAYERS = STYLE_GROUPS.flatMap((g) => g.players);

// ============ 平台集成 ============
const PLATFORMS: Array<{ id: string; name: string; nameCn: string; supported: boolean }> = [
  { id: 'ogs', name: 'OGS', nameCn: '国际围棋', supported: true },
  { id: 'kgs', name: 'KGS', nameCn: 'KGS围棋', supported: true },
  { id: 'yefox', name: 'Yefox', nameCn: '野狐围棋', supported: true },
  { id: 'foxwq', name: 'FoxGo', nameCn: '腾讯围棋', supported: true },
  { id: 'yicheng', name: 'Yike', nameCn: '弈城围棋', supported: false },
];

// ============ 组件 ============

export function GoAgentPanel({ fen, moveHistory, kataAnalysis, onMoveSuggested }: GoAgentPanelProps) {
  const [selectedPlayer, setSelectedPlayer] = useState<PlayerOption>(ALL_PLAYERS[0]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [deepseekStatus, setDeepseekStatus] = useState<'checking' | 'connected' | 'disconnected'>('checking');
  const [activeTab, setActiveTab] = useState<'chat' | 'style' | 'platforms' | 'study'>('chat');
  const [platformGameId, setPlatformGameId] = useState('');
  const [studyTopic, setStudyTopic] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // 检查 DeepSeek 连接状态
  useEffect(() => {
    fetch('/api/deepseek')
      .then((r) => r.json())
      .then((d) => setDeepseekStatus(d.data?.connected ? 'connected' : 'disconnected'))
      .catch(() => setDeepseekStatus('disconnected'));
  }, []);

  // 自动滚动
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // 发送消息
  const sendMessage = useCallback(async (text: string, forceAction?: 'chat' | 'study' | 'analyze') => {
    if (!text.trim()) return;

    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: text,
      timestamp: Date.now(),
    };

    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setIsLoading(true);

    try {
      const action = forceAction || (text.startsWith('学习') || text.startsWith('怎么') || text.startsWith('如何') ? 'study' : 'chat');

      const res = await fetch('/api/go-agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          message: text,
          playerId: selectedPlayer.id,
          fen,
          moveHistory,
          kataAnalysis,
          language: 'zh-HK',
        }),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${errText.slice(0, 200)}`);
      }

      const ct = res.headers.get('content-type') || '';
      const isStream = ct.includes('text/event-stream');

      if (isStream) {
        // 流式响应（SSE）
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let fullContent = '';

        const assistantMsg: ChatMessage = {
          id: `assistant-${Date.now()}`,
          role: 'assistant',
          content: '',
          playerId: selectedPlayer.id,
          timestamp: Date.now(),
        };
        setMessages((prev) => [...prev, assistantMsg]);

        let buffer = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // 按 SSE 协议按双换行分块解析
          const parts = buffer.split(/\r?\n\r?\n/);
          buffer = parts.pop() || '';

          for (const part of parts) {
            const lines = part.split(/\r?\n/);
            for (const line of lines) {
              if (!line.startsWith('data:')) continue;
              const payload = line.slice(5).trim();
              if (!payload || payload === '[DONE]') continue;
              try {
                const obj = JSON.parse(payload);
                const delta = obj?.choices?.[0]?.delta?.content;
                if (typeof delta === 'string' && delta) {
                  fullContent += delta;
                  setMessages((prev) =>
                    prev.map((m) => (m.id === assistantMsg.id ? { ...m, content: fullContent } : m))
                  );
                }
              } catch {
                // 忽略非 JSON 行（如注释/心跳）
              }
            }
          }
        }
      } else {
        // 非流式响应
        const data = await res.json();
        if (data.ok && data.data?.response) {
          const assistantMsg: ChatMessage = {
            id: `assistant-${Date.now()}`,
            role: 'assistant',
            content: data.data.response,
            playerId: selectedPlayer.id,
            timestamp: Date.now(),
          };
          setMessages((prev) => [...prev, assistantMsg]);
        } else {
          throw new Error(data.error || data.data?.error || '未知错误');
        }
      }
    } catch (err) {
      const errMsg: ChatMessage = {
        id: `error-${Date.now()}`,
        role: 'assistant',
        content: `❌ 网络错误：${err instanceof Error ? err.message : String(err)}。请检查服务器端到 DeepSeek 的连接（DGX Spark 地址：http://192.168.1.193:8000）。`,
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, errMsg]);
    } finally {
      setIsLoading(false);
    }
  }, [selectedPlayer, fen, moveHistory, kataAnalysis]);

  // 快速提示词
  const quickPrompts = [
    { label: '分析这步棋', text: '帮我分析当前局面的优劣' },
    { label: '推荐着法', text: '推荐最佳着法' },
    { label: '学习大师', text: `以${selectedPlayer.nameCn}的风格分析` },
    { label: '复盘', text: '复盘一下这盘棋的关键时刻' },
  ];

  return (
    <div className="flex flex-col h-full bg-black-rich border-l border-silver-border/30">
      {/* 顶部状态栏 */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-silver-border/30">
        <div className="flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full ${deepseekStatus === 'connected' ? 'bg-green-400 animate-pulse' : deepseekStatus === 'disconnected' ? 'bg-red-400' : 'bg-yellow-400'}`} />
          <span className="text-xs text-silver-dim">
            {deepseekStatus === 'connected' ? 'DeepSeek V4 ● DGX Spark' : deepseekStatus === 'disconnected' ? 'DeepSeek V4 ○ 未连接' : '检查连接...'}
          </span>
        </div>
        <div className="text-xs text-silver-dim">
          Cyber-Go × {selectedPlayer.nameCn}
        </div>
      </div>

      {/* Tab 导航 */}
      <div className="flex border-b border-silver-border/30">
        {([
          { key: 'chat', label: '对话' },
          { key: 'style', label: '大师风格' },
          { key: 'platforms', label: '棋谱导入' },
          { key: 'study', label: '学习' },
        ] as const).map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`flex-1 py-2.5 text-xs font-medium transition-colors ${
              activeTab === tab.key
                ? 'text-silver-primary border-b-2 border-silver-primary'
                : 'text-silver-dim hover:text-silver-mid'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* 内容区 */}
      <div className="flex-1 overflow-y-auto">
        {/* ===== Chat Tab ===== */}
        <AnimatePresence mode="wait">
          {activeTab === 'chat' && (
            <motion.div
              key="chat"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              className="flex flex-col h-full"
            >
              {/* 当前大师 */}
              <div className="px-4 py-2 border-b border-silver-border/20">
                <div className="flex items-center gap-2">
                  <span className="text-lg">{FLAG[selectedPlayer.country]}</span>
                  <div>
                    <div className="text-sm text-silver-primary font-medium">{selectedPlayer.nameCn}</div>
                    <div className="text-xs text-silver-dim">{selectedPlayer.style}</div>
                  </div>
                </div>
              </div>

              {/* 消息列表 */}
              <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
                {messages.length === 0 && (
                  <div className="text-center py-8 text-silver-dim text-sm">
                    <div className="mb-4">🎯 开始与 {selectedPlayer.nameCn} 对弈</div>
                    <div className="text-xs text-silver-dark space-y-1">
                      <div>• 问他分析当前局面</div>
                      <div>• 请他推荐着法</div>
                      <div>• 学习他的棋风特点</div>
                    </div>
                  </div>
                )}

                {messages.map((msg) => (
                  <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                      msg.role === 'user'
                        ? 'bg-silver-primary/20 text-silver-primary rounded-br-sm'
                        : msg.content.includes('⚠️') || msg.content.includes('❌')
                        ? 'bg-red-500/10 text-red-400'
                        : 'bg-silver-dark/20 text-silver-mid rounded-bl-sm'
                    }`}>
                      {msg.content}
                      {msg.role === 'assistant' && msg.playerId && (
                        <div className="mt-1.5 pt-1.5 border-t border-silver-border/20 text-xs text-silver-dim">
                          — {ALL_PLAYERS.find((p) => p.id === msg.playerId)?.nameCn || 'Cyber-Go'}
                        </div>
                      )}
                    </div>
                  </div>
                ))}

                {isLoading && (
                  <div className="flex justify-start">
                    <div className="bg-silver-dark/20 rounded-2xl rounded-bl-sm px-4 py-3">
                      <div className="flex gap-1">
                        {[0, 1, 2].map((i) => (
                          <div key={i} className="w-1.5 h-1.5 bg-silver-dim rounded-full animate-bounce"
                            style={{ animationDelay: `${i * 0.15}s` }} />
                        ))}
                      </div>
                    </div>
                  </div>
                )}

                <div ref={messagesEndRef} />
              </div>

              {/* 快速提示 */}
              {messages.length === 0 && (
                <div className="px-4 pb-2">
                  <div className="flex flex-wrap gap-1.5">
                    {quickPrompts.map((p) => (
                      <button
                        key={p.label}
                        onClick={() => sendMessage(p.text)}
                        className="px-2.5 py-1 rounded-full text-xs bg-silver-dark/20 text-silver-mid hover:bg-silver-dark/40 transition-colors border border-silver-border/20"
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* 输入框 */}
              <div className="p-3 border-t border-silver-border/30">
                <div className="flex gap-2">
                  <textarea
                    ref={inputRef}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        sendMessage(input);
                      }
                    }}
                    placeholder={`问 ${selectedPlayer.nameCn}...`}
                    rows={1}
                    className="flex-1 bg-black-elevated border border-silver-border/30 rounded-xl px-3 py-2 text-sm text-silver-mid placeholder-silver-dark resize-none focus:outline-none focus:border-silver-primary/50 transition-colors"
                  />
                  <button
                    onClick={() => sendMessage(input)}
                    disabled={!input.trim() || isLoading}
                    className="px-4 py-2 rounded-xl bg-silver-primary/20 text-silver-primary text-sm font-medium hover:bg-silver-primary/30 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    发送
                  </button>
                </div>
              </div>
            </motion.div>
          )}

          {/* ===== Style Tab ===== */}
          {activeTab === 'style' && (
            <motion.div
              key="style"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              className="p-4 space-y-4"
            >
              <div className="text-xs text-silver-dim mb-2">
                选择一位大师风格，当前：<span className="text-silver-primary">{selectedPlayer.nameCn}</span>
              </div>
              {STYLE_GROUPS.map((group) => (
                <div key={group.label}>
                  <div className="text-xs text-silver-dim mb-2 font-medium">{group.label}</div>
                  <div className="grid grid-cols-2 gap-1.5">
                    {group.players.map((p) => (
                      <button
                        key={p.id}
                        onClick={() => {
                          setSelectedPlayer(p);
                          setActiveTab('chat');
                        }}
                        className={`p-2.5 rounded-xl text-left transition-all text-xs ${
                          selectedPlayer.id === p.id
                            ? 'bg-silver-primary/20 border border-silver-primary/50 text-silver-primary'
                            : 'bg-black-elevated border border-silver-border/20 text-silver-mid hover:border-silver-border/50 hover:text-silver-primary'
                        }`}
                      >
                        <div className="font-medium text-sm">{FLAG[p.country]} {p.nameCn}</div>
                        <div className="text-silver-dim text-[10px] mt-0.5">{p.style}</div>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </motion.div>
          )}

          {/* ===== Platforms Tab ===== */}
          {activeTab === 'platforms' && (
            <motion.div
              key="platforms"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              className="p-4 space-y-4"
            >
              <div className="text-xs text-silver-dim">
                导入棋谱进行深度分析
              </div>
              <div className="space-y-2">
                {PLATFORMS.map((p) => (
                  <div key={p.id} className="p-3 bg-black-elevated rounded-xl border border-silver-border/20">
                    <div className="flex items-center justify-between mb-2">
                      <div>
                        <div className="text-sm text-silver-primary font-medium">{p.nameCn} ({p.name})</div>
                        <div className="text-xs text-silver-dim mt-0.5">
                          {p.supported ? '✓ 支持导入' : '🚧 开发中'}
                        </div>
                      </div>
                      {p.supported && (
                        <div className="w-2 h-2 rounded-full bg-green-400" />
                      )}
                    </div>
                    {p.supported && (
                      <div className="flex gap-2">
                        <input
                          type="text"
                          placeholder={`${p.nameCn} 棋谱 ID`}
                          value={platformGameId}
                          onChange={(e) => setPlatformGameId(e.target.value)}
                          className="flex-1 bg-black-rich border border-silver-border/30 rounded-lg px-2.5 py-1.5 text-xs text-silver-mid placeholder-silver-dark focus:outline-none focus:border-silver-primary/50"
                        />
                        <button
                          onClick={async () => {
                            if (!platformGameId.trim()) return;
                            const actionMap: Record<string, string> = {
                              ogs: 'fetch-ogs',
                              kgs: 'fetch-ogs',
                              yefox: 'fetch-foxwq',
                              foxwq: 'fetch-foxwq',
                            };
                            const action = actionMap[p.id];
                            try {
                              const res = await fetch(`/api/go-platforms?action=${action}&gameId=${platformGameId}`);
                              const d = await res.json();
                              if (d.ok) {
                                setMessages((prev) => [
                                  ...prev,
                                  {
                                    id: `system-${Date.now()}`,
                                    role: 'system',
                                    content: `✅ 成功从 ${p.nameCn} 导入棋谱 ID: ${platformGameId}`,
                                    timestamp: Date.now(),
                                  },
                                ]);
                              } else {
                                setMessages((prev) => [
                                  ...prev,
                                  {
                                    id: `error-${Date.now()}`,
                                    role: 'assistant',
                                    content: `⚠️ ${p.nameCn} 导入失败：${d.error}`,
                                    timestamp: Date.now(),
                                  },
                                ]);
                              }
                            } catch {
                              setMessages((prev) => [
                                ...prev,
                                {
                                  id: `error-${Date.now()}`,
                                  role: 'assistant',
                                  content: `❌ ${p.nameCn} 连接失败`,
                                  timestamp: Date.now(),
                                },
                              ]);
                            }
                          }}
                          className="px-3 py-1.5 bg-silver-primary/20 text-silver-primary text-xs rounded-lg hover:bg-silver-primary/30 transition-colors"
                        >
                          导入
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
              <div className="text-xs text-silver-dim mt-3">
                💡 提示：输入棋谱 URL 或 ID，系统将自动解析棋局并由 AI 大师进行深度复盘。
              </div>
            </motion.div>
          )}

          {/* ===== Study Tab ===== */}
          {activeTab === 'study' && (
            <motion.div
              key="study"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              className="p-4 space-y-4"
            >
              <div className="text-xs text-silver-dim">
                选择学习主题，获取个性化围棋指导
              </div>
              <div className="grid grid-cols-2 gap-2">
                {[
                  { label: '开局基础', icon: '♟', topic: '围棋开局基础：星位、小目、三三的优劣势' },
                  { label: '死活题', icon: '⚔', topic: '如何提高死活题计算能力' },
                  { label: '定式学习', icon: '📖', topic: '常见定式的理解与应用' },
                  { label: '官子技巧', icon: '🎯', topic: '官子收束技巧与最大化策略' },
                  { label: '中盘战斗', icon: '🔥', topic: '中盘作战的思路与技巧' },
                  { label: '布局理论', icon: '🗺', topic: '布局理论：如何构建大局观' },
                ].map((item) => (
                  <button
                    key={item.label}
                    onClick={() => {
                      setStudyTopic(item.topic);
                      setActiveTab('chat');
                      sendMessage(item.topic, 'study');
                    }}
                    className="p-3 bg-black-elevated rounded-xl border border-silver-border/20 text-left hover:border-silver-border/50 transition-colors"
                  >
                    <div className="text-lg mb-1">{item.icon}</div>
                    <div className="text-sm text-silver-primary font-medium">{item.label}</div>
                  </button>
                ))}
              </div>

              <div className="mt-4">
                <div className="text-xs text-silver-dim mb-2">自定义学习主题</div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    placeholder="输入想学习的内容..."
                    value={studyTopic}
                    onChange={(e) => setStudyTopic(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && studyTopic.trim()) {
                        setActiveTab('chat');
                        sendMessage(studyTopic, 'study');
                      }
                    }}
                    className="flex-1 bg-black-elevated border border-silver-border/30 rounded-xl px-3 py-2 text-sm text-silver-mid placeholder-silver-dark focus:outline-none focus:border-silver-primary/50"
                  />
                  <button
                    onClick={() => {
                      if (studyTopic.trim()) {
                        setActiveTab('chat');
                        sendMessage(studyTopic, 'study');
                      }
                    }}
                    className="px-4 py-2 bg-silver-primary/20 text-silver-primary text-sm rounded-xl hover:bg-silver-primary/30 transition-colors"
                  >
                    学习
                  </button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
