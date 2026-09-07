# Chess AI Hub — 项目手册

> AlphaGo 风格的棋类 AI 助手 · 围棋 / 中国象棋 / 国际象棋 · 实时胜率 + 走子解释
> HKUST AI应用社 · Cyber Foundation · 2026-08-30

---

## 1. 目标

**Goal**: 制作一个像 DeepMind AlphaGo 一样的棋类 AI 助手,统一支持围棋、中国象棋、国际象棋,提供:

1. **三棋种通吃** — Go (19×19) / Xiangqi (9×10) / Chess (8×8)
2. **选边功能** — 用户自由选择执哪一方
3. **实时胜率** — 每次落子后即时更新胜率 / 局面评估
4. **走子解释** — AI 推荐的下一步 + 为什么下这里(policy / ownership / 关键变化)
5. **多线分析** — Top-N 推荐着法 + principal variation
6. **棋谱导入 + 复盘** — SGF / PGN / WTHOR (国际象棋)
7. **零兼容性错误** — 所有 build / typecheck / 端到端流程全部通过
8. **单机个人使用** — 不做联机

**Set as Goal**: 自包含,自验证,100% 完成才算 done。

---

## 2. 技术栈

| 层 | 选型 | 理由 |
|---|---|---|
| Frontend | Next.js 14 + Tailwind CSS + Framer Motion + GSAP | 与现有项目 (cyber-foundation, ai-showcase-web) 一致,黑银主题统一 |
| 棋盘渲染 | 自研 SVG 组件 | 三棋种差异大,SVG 比 Canvas 灵活;无第三方依赖风险 |
| 引擎通信 | Node.js child_process + line-buffered stdin/stdout | UCI / UCCI / GTP 都是文本行协议 |
| 国际象棋引擎 | **Stockfish 18** (NNUE, SFNNv10) | SOTA, 官方 UCI |
| 中国象棋引擎 | **Pikafish 2026-01-02** (Stockfish xiangqi fork) | SOTA 中文象棋, UCI |
| 围棋引擎 | **KataGo v1.18.1** (Metal GPU on macOS) | SOTA Go, 内置 analysis 模式,GTP |
| 围棋规则 | 自研 (Tromp-Taylor + Chinese rules toggle) | 不依赖外部服务 |
| 中国象棋规则 | `cc-core` 思路,自研 | 简单逻辑 |
| 国际象棋规则 | `chess.js` (轻量, 100KB) | 行业标准 |
| 棋谱解析 | `chess.js` (PGN) / 自研 (SGF / WTHOR) | 标准库 |

---

## 3. 架构

```
┌─────────────────────────────────────────────────────────┐
│ Browser (localhost:3001)                                │
│  Next.js 14 SPA                                         │
│  ┌─────────────────┐  ┌──────────────────────────┐    │
│  │  棋盘组件 SVG    │  │  分析面板                 │    │
│  │  - GoBoard      │  │  - 胜率条 (Win Rate Bar)   │    │
│  │  - XiangqiBoard │  │  - Top 3 着法 + PV        │    │
│  │  - ChessBoard   │  │  - 走子解释 (policy/owner)│    │
│  └─────────────────┘  └──────────────────────────┘    │
│          │ HTTP/SSE            │                        │
└──────────┼─────────────────────┼────────────────────────┘
           │                     │
           ▼                     ▼
┌──────────────────────────────────────────────────────────┐
│ Next.js API Routes (Server)                               │
│  /api/engine/start    /api/engine/move                   │
│  /api/engine/analyze  /api/engine/stop                   │
│  /api/game/load (PGN/SGF/WTHOR)                          │
│  EngineManager (Singleton)                                │
│    ├─ StockfishUCI   (进程,stdin/stdout)                  │
│    ├─ PikafishUCCI   (进程,stdin/stdout)                  │
│    └─ KataGoGTP      (进程,stdin/stdout,Metal GPU)        │
└──────────────────────────────────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────────────────────┐
│ Engines (Local processes on Mac Studio)                   │
│  engines/stockfish  engines/pikafish  engines/katago     │
│  networks/  (KataGo neural net ~150MB)                    │
└──────────────────────────────────────────────────────────┘
```

**未来扩展**: DGX Spark (192.168.1.193) 可作为 KataGo 的 GPU 后备加速 (CUDA backend),但默认用本地 Metal 已经够用。

---

## 4. 引擎抽象层

所有引擎通过统一接口 `EngineAdapter<TState, TMove, TAnalysis>` 暴露:

```typescript
interface EngineAdapter<TRule, TMove, TAnalysis> {
  start(): Promise<void>
  stop(): Promise<void>
  newGame(rule: TRule, side: Side): Promise<void>
  applyMove(move: TMove): Promise<{ state: TRule; legal: boolean }>
  undoMove(): Promise<TRule | null>
  analyze(opts: AnalyzeOptions): AsyncIterable<TAnalysis>
  getLegalMoves(): Promise<TMove[]>
}
```

每个引擎的具体实现:

```typescript
class StockfishUCI extends EngineAdapter<ChessState, UciMove, UciAnalysis> {
  // UCI: uci, isready, ucinewgame, position [startpos | fen] moves..., go [infinite|depth|movetime|...]
  // info depth ... score cp/mate ... pv ...    →  parse → Analysis
  // bestmove e2e4
}

class PikafishUCCI extends EngineAdapter<XiangqiState, UcciMove, UcciAnalysis> {
  // UCCI: e.g.ucci, isready, position [startpos | fen] moves..., go [infinite|depth|movetime|...]
  // 注意:UCCI 是中文象棋专属协议,与 UCI 类似但 move 格式用中文字符
}

class KataGoGTP extends EngineAdapter<GoState, GtpMove, GtpAnalysis> {
  // GTP: boardsize, clear_board, play, genmove, kata-genmove_analyze, kata-showboard
  // kata-genmove_analyze 在每 N 访次输出: info turn visits winrate scoreLead policy ownership pv
}
```

---

## 5. 数据流

1. **用户点击棋盘** → 触发 `applyMove(move)`
2. **EngineAdapter** → 校验合法性 → 同步状态 → 返回 `legal: true/false`
3. **前端** 立即更新棋盘 + 计算简易评估 (Zobrist hash)
4. **后台** 异步调用 `analyze({depth, multipv: 3})`
5. **EngineAdapter** → 持续 stream analysis → SSE 推到前端
6. **前端** 收到 analysis → 更新胜率条 / Top-N 着法 / 走子解释

---

## 6. UI 设计 (Cyber Foundation 风格)

**色板**:
- Background: `#000000` / `#0A0A0A` / `#121212`
- Surface: `#1A1A1A` / `#222`
- Border: `#2A2A2A` / `#333`
- Silver Primary: `#E8E8E8`
- Silver Mid: `#C0C0C0`
- Silver Dim: `#8A8A8A`
- Accent Glow: `#FFFFFF` 渐变 + glow shadow

**布局**:
- **左**: 棋盘区 (responsive, 棋种自适应尺寸)
- **中**: 分析面板 (胜率条 + Top-3 着法 + 走子解释)
- **右**: 棋谱 + 选边 + 控制

**微交互**:
- 落子有 SVG 动画 (0.2s fade-in + scale)
- 推荐着法有 glow pulse 提示
- 胜率条颜色渐变 (绿→黄→红)
- 棋谱节点可点击跳转

---

## 7. 棋种差异适配

| 维度 | 围棋 (Go) | 中国象棋 (Xiangqi) | 国际象棋 (Chess) |
|---|---|---|---|
| 棋盘 | 19×19 | 9×10 | 8×8 |
| 选边术语 | 黑/白 | 红/黑 | 白/黑 |
| Move 表达 | `(col,row)` GTPCoord | 中文坐标 e.g. `h2e2` | UCI e.g. `e2e4` |
| 规则库 | 自研 Tromp-Taylor + Chinese scoring | 自研 (含楚河汉界) | `chess.js` |
| 胜负判定 | territory scoring (Chinese) | 将死/困毙 | checkmate/stalemate/draw |
| Engine 协议 | GTP | UCCI | UCI |
| 评估单位 | winrate 0~1 | centipawn + winrate | centipawn + winrate |
| 解释维度 | policy + ownership + pv | pv + score | pv + score + classification |

**统一抽象**: 三棋种共用 `EngineAdapter` 但内部实现完全独立。棋盘组件是 `<Board variant="go" | "xiangqi" | "chess">`。

---

## 8. 文件结构

```
chess-ai-hub/
├─ PROJECT.md                          ← 你正在读的
├─ README.md                           ← 启动说明
├─ package.json
├─ next.config.mjs
├─ tailwind.config.ts                  ← 黑银配色主题
├─ tsconfig.json
├─ vercel.json                         ← (备用,不部署)
├─ .gitignore
├─ app/
│  ├─ layout.tsx                       ← 全局 layout + 主题
│  ├─ page.tsx                         ← 入口 (棋种选择)
│  ├─ globals.css
│  ├─ go/page.tsx                      ← 围棋大厅
│  ├─ xiangqi/page.tsx                 ← 中国象棋大厅
│  ├─ chess/page.tsx                   ← 国际象棋大厅
│  └─ api/
│     ├─ engine/start/route.ts
│     ├─ engine/move/route.ts
│     ├─ engine/analyze/route.ts       ← SSE streaming
│     ├─ engine/stop/route.ts
│     └─ game/load/route.ts            ← PGN/SGF/WTHOR 导入
├─ components/
│  ├─ ui/                              ← 通用组件
│  │  ├─ Button.tsx
│  │  ├─ GlassCard.tsx
│  │  └─ EngineStatus.tsx
│  ├─ board/
│  │  ├─ Board.tsx                     ← 路由 3 棋种
│  │  ├─ GoBoard.tsx                   ← 19×19
│  │  ├─ XiangqiBoard.tsx              ← 9×10
│  │  ├─ ChessBoard.tsx                ← 8×8
│  │  └─ BoardCoord.tsx                ← 坐标标签
│  ├─ analysis/
│  │  ├─ WinRateBar.tsx                ← 胜率条
│  │  ├─ MoveList.tsx                  ← Top-N 推荐着法
│  │  ├─ Explanation.tsx               ← 走子解释
│  │  └─ PvLine.tsx                    ← Principal Variation
│  ├─ side/
│  │  └─ SideSelector.tsx              ← 红方/黑方 选边
│  └─ control/
│     ├─ GameControl.tsx               ← 新对局 / 悔棋 / 让 AI 下
│     └─ ImportPanel.tsx               ← 棋谱导入
├─ lib/
│  ├─ engine/
│  │  ├─ EngineAdapter.ts              ← 抽象基类
│  │  ├─ StockfishUCI.ts               ← 国际象棋
│  │  ├─ PikafishUCCI.ts               ← 中国象棋
│  │  ├─ KataGoGTP.ts                  ← 围棋
│  │  ├─ EngineManager.ts              ← 单例管理
│  │  └─ protocols/
│  │     ├─ uci.ts                     ← UCI 协议解析
│  │     ├─ ucci.ts                    ← UCCI 协议解析
│  │     └─ gtp.ts                     ← GTP 协议解析
│  ├─ rules/
│  │  ├─ chess.ts                      ← chess.js wrapper
│  │  ├─ xiangqi.ts                    ← 中国象棋规则
│  │  └─ go.ts                         ← 围棋规则 (Tromp-Taylor)
│  ├─ types.ts                         ← 全局类型
│  └─ i18n.ts                          ← 简单 i18n (en + zh)
├─ engines/                            ← 二进制引擎 (gitignore,首次启动下载)
│  ├─ stockfish                        ← mac arm64 binary
│  ├─ pikafish
│  ├─ katago
│  └─ networks/
│     └─ kata1-b18c384nbt-autov2.bin   ← KataGo NN (~150MB)
├─ scripts/
│  └─ download-engines.sh              ← 启动时检查/下载引擎
└─ public/
   └─ (无静态资源)
```

---

## 9. 里程碑

### Phase 1 — 骨架 (0.5 天)
- [ ] Next.js 14 + Tailwind 黑银主题
- [ ] 首页棋种选择
- [ ] 引擎下载脚本
- [ ] EngineManager 单例 (启动 / 停止 / 健康检查)

### Phase 2 — 国际象棋 (1 天)
- [ ] Stockfish 18 下载 + 启动测试
- [ ] UCI 协议解析
- [ ] 8×8 棋盘组件
- [ ] 选边 (白/黑)
- [ ] 实时胜率 (centipawn + winrate)
- [ ] Top-3 推荐着法
- [ ] PGN 导入

### Phase 3 — 中国象棋 (1 天)
- [ ] Pikafish 2026 下载 + 启动测试
- [ ] UCCI 协议解析
- [ ] 9×10 棋盘组件 (含楚河汉界)
- [ ] 选边 (红/黑)
- [ ] 中国象棋规则自研 (走子/吃子/将军/将死)
- [ ] 实时胜率

### Phase 4 — 围棋 (1 天)
- [ ] KataGo v1.18.1 下载 + Metal 启动测试
- [ ] GTP 协议解析 (含 kata-genmove_analyze 扩展)
- [ ] 19×19 棋盘组件
- [ ] 选边 (黑/白)
- [ ] 围棋规则自研 (Tromp-Taylor + Chinese scoring)
- [ ] Policy + Ownership 热力图
- [ ] SGF 导入

### Phase 5 — 走子解释 (0.5 天)
- [ ] 三棋种统一 Explanation 组件
- [ ] 围棋 policy 热力图
- [ ] 中国象棋 / 国际象棋 关键变化高亮
- [ ] 走子推荐理由 (rule-based + engine 反馈)

### Phase 6 — 复盘 (0.5 天)
- [ ] 棋谱历史时间线
- [ ] 关键节点标记
- [ ] 跳转到任意局面
- [ ] 错误着法高亮 (基于 Stockfish classification)

### Phase 7 — 验收 (0.5 天)
- [ ] typecheck 通过
- [ ] build 通过
- [ ] 三棋种路由 smoke test
- [ ] 完整对局: 选边 → 下棋 → AI 回应 → 实时胜率 → 走子解释
- [ ] 零 console error / 零 404

---

## 10. 验收标准 (Definition of Done)

- [ ] `npm run dev` 在 localhost:3001 启动,无任何 console 错误
- [ ] 首页可正常切换三棋种
- [ ] 国际象棋: 可选白/黑,完整下完一局,胜率实时更新,推荐着法可见
- [ ] 中国象棋: 可选红/黑,完整下完一局,胜率实时更新,推荐着法可见
- [ ] 围棋: 可选黑/白,完整下完一局,胜率实时更新,policy 热力图可见
- [ ] 三棋种棋谱导入正常 (PGN / SGF / WTHOR)
- [ ] 所有路由无 404
- [ ] 响应式适配 (桌面 / 笔记本, 不要求移动端)
- [ ] 黑银配色统一, Cyber Foundation 风格一致
- [ ] `npx tsc --noEmit` 通过
- [ ] `npm run build` 通过

---

## 11. 已知风险与缓解

| 风险 | 缓解 |
|---|---|
| KataGo Metal 启动失败 (某些 Mac 上) | 备选 Eigen CPU 后端,降级不影响功能 |
| Pikafish UCCI 中文坐标解析 | 自研 parser,边界条件单测 |
| 围棋规则 (自杀/打劫/终局 territory) | Tromp-Taylor 简化版本 + Chinese toggle |
| 引擎启动慢 (KataGo NN load ~5s) | 引擎启动与页面切换解耦,显示 loading |
| Next.js SSE streaming 与 Next 14 cache 冲突 | 用 `dynamic = 'force-dynamic'` 标记 API routes |
| EngineManager 单例在 dev hot reload 多实例 | 用 globalThis 锁 + pid 校验 |

---

## 12. 后续扩展 (不在本次 goal)

- [ ] DGX Spark KataGo CUDA 后备 (加速大模型分析)
- [ ] KataZero 风格自训练模型 (微调)
- [ ] 联机模式 (WebSocket)
- [ ] 棋谱数据库 + AI 推演对局
- [ ] 移动端适配
- [ ] 多语言 i18n (zh-Hant / ja / ko)

---

## 13. 引用

**Stockfish 18** — https://github.com/official-stockfish/Stockfish
**Pikafish 2026-01-02** — https://github.com/official-pikafish/Pikafish
**KataGo v1.18.1** — https://github.com/lightvector/KataGo
**Chessground** — https://github.com/lichess-org/chessground (UI 灵感)
**Sabaki / Lizzie** — Go GUI 灵感
**Cyber Foundation** — https://cyber-foundation-ten.vercel.app (风格母版)
