// EngineManager — 三棋种引擎单例管理
// 启动/停止 UCI (Stockfish + Pikafish) / GTP (KataGo) 进程并管理 stdio

import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import * as readline from 'readline';
import * as path from 'path';
import * as fs from 'fs';
import { Analysis, GameVariant, EngineStatus, EngineState } from '../types';
import { parseUciLine, buildAnalysis as buildUciAnalysis, UciAnalysisRaw, UciOptions } from './protocols/uci';
import { parseGtpInfoLine, buildGtpAnalysis, GtpAnalysisRaw, gtpMoveToCoord } from './protocols/gtp';
import { buildUciHintCommands, buildKataGoHintCommands, getStyle, StyleProfile } from '../styles/style-profiles';

const ENGINE_DIR = path.resolve(process.cwd(), 'engines');
const STOCKFISH_BIN = path.join(ENGINE_DIR, 'stockfish');
const PIKAFISH_BIN = path.join(ENGINE_DIR, 'pikafish');
const KATAGO_BIN = path.join(ENGINE_DIR, 'katago');
const KATAGO_MODEL = path.join(ENGINE_DIR, 'networks', 'kata1-tf2-b10c384-s2941M-d5872M.bin.gz');
const KATAGO_CONFIG = path.join(ENGINE_DIR, 'gtp.cfg');

export interface EngineSession {
  variant: GameVariant;
  proc: ChildProcess;
  rl: readline.Interface;
  emitter: EventEmitter;
  status: EngineStatus;
  currentAnalysis?: Analysis;
  lastError?: string;
  // UCI 累积状态
  uciPendingByPv: Map<number, UciAnalysisRaw>;
  // GTP 累积状态
  gtpPending: GtpAnalysisRaw | null;
  gtpBoardSize: number;
  gtpPlayerColor: 'B' | 'W';
  pendingCommand?: 'uci-analyze' | 'gtp-analyze';
  cmdCounter: number;
  // 共享: 当前棋局 move 列表 (UCI / UCCI 用 moves..., GTP 用 play 累积)
  // UCI: 'position startpos moves e2e4 e7e5 ...'
  // GTP: 不用这个, 引擎自己维护 board 状态
  moveHistory: string[];
  // 当前 FEN (UCI 起始位置)
  currentFen?: string;
  // 是否在分析中
  analyzing: boolean;
  // KataGo ownership 请求状态
  ownershipRequested: boolean;
  lastOwnership: number[][] | null;
  // 当前风格 (棋手 profile) — 影响引擎 hint + thinking time
  currentStyleId: string;
  // 已注册的 proc 监听器 (供 stop() 清理,避免 restart 时累积)
  procListeners: {
    stderr: (buf: Buffer) => void;
    stdout: ((buf: Buffer) => void) | null;
    exit: (code: number | null, signal: NodeJS.Signals) => void;
    error: (err: Error) => void;
  };
  // Resolves when the engine is truly idle (bestmove received for UCI, stop confirmed for GTP)
  idleResolve?: () => void;
}

export class EngineManager {
  private static _instance: EngineManager;
  static get instance(): EngineManager {
    if (!EngineManager._instance) {
      // 在 globalThis 上 pin 住 instance, 避免 Next.js dev hot reload 重置导致 spawn 旧 session 残留
      const g = globalThis as unknown as { __engineManager?: EngineManager };
      if (g.__engineManager) {
        EngineManager._instance = g.__engineManager;
      } else {
        EngineManager._instance = new EngineManager();
        g.__engineManager = EngineManager._instance;
      }
    }
    return EngineManager._instance;
  }

  // Per-variant analyze mutex — serialize concurrent analyze() calls so they
  // don't interleave 'go infinite' / 'stop' commands and leave the engine in a
  // stuck state. Each variant has its own queue.
  private analyzeQueues: Map<GameVariant, Promise<unknown>> = new Map();

  /** Serialize per-variant analyze requests so concurrent callers don't fight over the engine. */
  private async withAnalyzeLock<T>(variant: GameVariant, fn: () => Promise<T>): Promise<T> {
    const prev = this.analyzeQueues.get(variant) ?? Promise.resolve();
    let release: () => void = () => {};
    const next = new Promise<void>((r) => { release = r; });
    this.analyzeQueues.set(variant, prev.then(() => next));
    try {
      await prev;
      return await fn();
    } finally {
      release();
      // Cleanup: if no further calls, drop the entry
      if (this.analyzeQueues.get(variant) === prev.then(() => next)) {
        this.analyzeQueues.delete(variant);
      }
    }
  }

  /** Dev-only: 清理所有 sessions + 子进程 (用于 hot reload 时清理 orphan) */
  async cleanupAll(): Promise<void> {
    const variants: GameVariant[] = ['chess', 'xiangqi', 'go'];
    await Promise.all(variants.map((v) => this.stop(v).catch(() => {})));
  }

  private sessions: Map<string, EngineSession> = new Map();

  /** 检查引擎二进制存在 */
  static health(): Record<GameVariant, boolean> {
    return {
      chess: fs.existsSync(STOCKFISH_BIN),
      xiangqi: fs.existsSync(PIKAFISH_BIN),
      go: fs.existsSync(KATAGO_BIN) && fs.existsSync(KATAGO_MODEL),
    };
  }

  /** 获取引擎状态 */
  getState(variant: GameVariant): EngineState {
    const id = `${variant}:default`;
    const sess = this.sessions.get(id);
    if (!sess) {
      return { variant, status: 'idle' };
    }
    return {
      variant,
      status: sess.status,
      currentAnalysis: sess.currentAnalysis,
      lastError: sess.lastError,
    };
  }

  /** 启动引擎 (如未启动) */
  async ensureStarted(variant: GameVariant): Promise<EngineSession> {
    const id = `${variant}:default`;
    let sess = this.sessions.get(id);
    if (sess && sess.status !== 'errored' && sess.status !== 'stopped') {
      return sess;
    }
    sess = await this.start(variant);
    return sess;
  }

  async start(variant: GameVariant): Promise<EngineSession> {
    const id = `${variant}:default`;
    const existing = this.sessions.get(id);
    // If a good session already exists, return it without restarting.
    // This prevents repeatedly killing/re-spawning engines when multiple
    // browser tabs call /api/engine/start simultaneously.
    if (existing) {
      // Detect stale session: process already dead/exited but state stuck
      const procAlive = existing.proc && !existing.proc.killed && existing.proc.exitCode === null && existing.proc.signalCode === null;
      if (existing.status !== 'errored' && existing.status !== 'stopped' && procAlive) {
        return existing;
      }
      // Stale: clean up + respawn
      try {
        existing.proc.kill('SIGKILL');
      } catch {}
      this.sessions.delete(id);
    }

    let bin: string;
    let args: string[] = [];
    if (variant === 'chess') {
      bin = STOCKFISH_BIN;
    } else if (variant === 'xiangqi') {
      bin = PIKAFISH_BIN;
    } else {
      bin = KATAGO_BIN;
      args = ['gtp', '-model', KATAGO_MODEL, '-config', KATAGO_CONFIG];
    }

    if (!fs.existsSync(bin)) {
      throw new Error(`Engine binary not found: ${bin}. Run: npm run engines:download`);
    }

    const proc = spawn(bin, args, {
      cwd: process.cwd(),
      env: { ...process.env, LD_LIBRARY_PATH: '' }, // avoid inheriting CUDA libs
    });

    const emitter = new EventEmitter();
    const rl = readline.createInterface({ input: proc.stdout });

    const sess: EngineSession = {
      variant,
      proc,
      rl,
      emitter,
      status: 'starting',
      uciPendingByPv: new Map(),
      gtpPending: null,
      gtpBoardSize: 19,
      gtpPlayerColor: 'B',
      cmdCounter: 0,
      moveHistory: [],
      analyzing: false,
      ownershipRequested: false,
      lastOwnership: null,
      currentStyleId: 'default',
      procListeners: {
        stderr: () => {},
        stdout: null,
        exit: () => {},
        error: () => {},
      },
    };
    this.sessions.set(id, sess);

    // KataGo quirk: stderr 走 "GTP ready" + 生命周期日志。
    // 我们把 stderr 行也送进 handleLine,让 waitFor / 分析解析统一从一处走。
    sess.procListeners.stderr = (buf: Buffer) => {
      const text = buf.toString();
      const lines = text.split(/\r?\n/);
      for (const ln of lines) {
        if (!ln) continue;
        this.handleLine(sess, ln);
      }
    };
    proc.stderr?.on('data', sess.procListeners.stderr);

    // KataGo quirk: kata-analyze 把多个 `info move ...` 段合并在同一行 (空格分隔,不是换行),
    // readline 接口会把整行当作一个事件派发。
    // 我们自己接 stdout: 先按行分,再检测单行内是否含多段 'info ',分别送进 handleLine。
    // 关键: 不要给 '= ' 等 GTP reply 强加 'info ' 前缀,否则会把 '= Q16' 变成 'info = Q16' 丢失响应。
    if (variant === 'go') {
      sess.procListeners.stdout = (buf: Buffer) => {
        const raw = buf.toString();
        const lines = raw.split(/\r?\n/);
        for (const ln of lines) {
          const trimmed = ln.trim();
          if (!trimmed) continue;
          if (/info\s/.test(trimmed)) {
            // 单行内含多段 'info ', 按 'info ' 拆开分别送
            const segments = trimmed.split(/(?=info\s)/);
            for (const seg of segments) {
              const s = seg.trim();
              if (!s) continue;
              this.handleLine(sess, s);
            }
          } else {
            // 普通 GTP reply ('= ' / '? ' / '! ' / 错误信息) — 原样送
            this.handleLine(sess, trimmed);
          }
        }
      };
      proc.stdout?.on('data', sess.procListeners.stdout);
    } else {
      rl.on('line', (line) => this.handleLine(sess, line));
    }

    sess.procListeners.exit = (code) => {
      sess.status = 'stopped';
      sess.emitter.emit('exit', { variant, code });
    };
    sess.procListeners.error = (err) => {
      sess.status = 'errored';
      sess.lastError = err.message;
      sess.emitter.emit('error', { variant, message: err.message });
    };
    proc.on('exit', sess.procListeners.exit);
    proc.on('error', sess.procListeners.error);

    // 等待引擎就绪
    if (variant === 'go') {
      // KataGo GTP: 等 'GTP ready' 信号 (从 stderr 来)
      await this.waitFor(sess, /GTP ready/, 60000);
      // 初始设置 board
      this.sendLine(sess, 'boardsize 19');
      this.sendLine(sess, 'clear_board');
      this.sendLine(sess, 'komi 7.5');
      // 等所有 reply
      await this.waitFor(sess, /^[=?] /m, 5000).catch(() => {});
      sess.gtpBoardSize = 19;
      sess.gtpPlayerColor = 'B';
    } else {
      // UCI: 发送 'uci' 命令 + 等 uciok
      this.sendLine(sess, 'uci');
      await this.waitFor(sess, /uciok/, 30000);
      // 设置选项: MultiPV 3, Threads 4, Hash 128
      this.sendLine(sess, 'setoption name MultiPV value 3');
      this.sendLine(sess, 'setoption name Threads value 8');
      this.sendLine(sess, 'setoption name Hash value 128');
      // Pikafish NNUE: 显式指定 EvalFile 路径 (Pikafish 从 cwd 找 pikafish.nnue)
      if (variant === 'xiangqi') {
        const nnuePath = path.join(process.cwd(), 'pikafish.nnue');
        if (fs.existsSync(nnuePath)) {
          this.sendLine(sess, `setoption name EvalFile value ${nnuePath}`);
        }
      }
      this.sendLine(sess, 'isready');
      await this.waitFor(sess, /readyok/, 10000);
    }

    sess.status = 'ready';
    return sess;
  }

  async stop(variant: GameVariant): Promise<void> {
    const id = `${variant}:default`;
    const sess = this.sessions.get(id);
    if (!sess) return;
    try {
      this.sendLine(sess, 'quit');
    } catch {}
    try {
      sess.rl.close();
    } catch {}
    // 先移除所有 proc 监听器,避免 stop 时事件触发导致累积
    try {
      sess.proc.stderr?.off('data', sess.procListeners.stderr);
      if (sess.procListeners.stdout) {
        sess.proc.stdout?.off('data', sess.procListeners.stdout);
      }
      sess.proc.off('exit', sess.procListeners.exit);
      sess.proc.off('error', sess.procListeners.error);
    } catch {}
    try {
      sess.proc.kill('SIGTERM');
    } catch {}
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        try {
          sess.proc.kill('SIGKILL');
        } catch {}
        resolve();
      }, 3000);
      sess.proc.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
    this.sessions.delete(id);
  }

  /**
   * 切换棋手风格 — 立即把对应的 UCI/GTP hint 推送给引擎。
   * 下次 aiMove/analyze 自动按新风格计算。
   */
  async setStyle(variant: GameVariant, styleId: string): Promise<{ ok: boolean; style: StyleProfile; applied: string[] }> {
    const sess = await this.ensureStarted(variant);
    const profile = getStyle(styleId);
    sess.currentStyleId = profile.id;
    const applied: string[] = [];

    if (variant === 'go') {
      const cmds = buildKataGoHintCommands(profile.engineHints.go);
      for (const c of cmds) {
        try {
          this.sendLine(sess, c);
          applied.push(c);
        } catch {}
      }
      // 等所有 reply 落定 (KataGo 標準 reply 用 '= ' / '? ' / '! ' 開頭)
      // 唔用 waitFor,因為 SSE analyze stream 嘅 'info ' 行可能誤觸發
      if (cmds.length > 0) {
        await new Promise((r) => setTimeout(r, 200));
      }
    } else {
      const cmds = buildUciHintCommands(profile.engineHints[variant]);
      for (const c of cmds) {
        try {
          this.sendLine(sess, c);
          applied.push(c);
        } catch {}
      }
      // UCI 是 fire-and-forget, 唔需要等 reply
      if (cmds.length > 0) {
        await new Promise((r) => setTimeout(r, 50));
      }
      // Pikafish NNUE: 总是重新指定 EvalFile (兜底)
      if (variant === 'xiangqi') {
        const nnuePath = path.join(process.cwd(), 'pikafish.nnue');
        if (fs.existsSync(nnuePath)) {
          try {
            this.sendLine(sess, `setoption name EvalFile value ${nnuePath}`);
            applied.push('setoption name EvalFile value ...');
          } catch {}
        }
      }
    }

    return { ok: true, style: profile, applied };
  }

  /** 获取当前引擎风格 ID */
  getStyleId(variant: GameVariant): string {
    const sess = this.sessions.get(`${variant}:default`);
    return sess?.currentStyleId ?? 'default';
  }

  /** 新对局 */
  async newGame(variant: GameVariant, fen?: string): Promise<void> {
    const sess = await this.ensureStarted(variant);
    // Stop any ongoing analysis first (UCI engines ignore ucinewgame while searching).
    // Use pendingCommand as the authoritative "engine is busy" flag — stopAnalyze()
    // sets analyzing=false BEFORE the engine responds with bestmove, so we must
    // also check pendingCommand to detect that the engine is still winding down.
    if (sess.pendingCommand === 'uci-analyze' || sess.pendingCommand === 'gtp-analyze') {
      try {
        sess.proc.stdin?.write('stop\n');
      } catch {}
      // UCI: wait for bestmove so the engine is truly idle before sending new commands.
      // GTP (KataGo): bestmove is not emitted on stop; a short delay suffices.
      if (variant !== 'go') {
        await this.waitFor(sess, /bestmove/, 5000).catch(() => {});
      } else {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    sess.uciPendingByPv.clear();
    sess.gtpPending = null;
    sess.currentAnalysis = undefined;
    sess.moveHistory = [];

    if (variant === 'go') {
      this.sendLine(sess, 'boardsize 19');
      this.sendLine(sess, 'clear_board');
      this.sendLine(sess, 'komi 7.5');
      await this.waitFor(sess, /^[=?] /m, 3000).catch(() => {});
      sess.gtpBoardSize = 19;
      sess.gtpPlayerColor = 'B';
      sess.ownershipRequested = false;
      sess.lastOwnership = null;
    } else {
      this.sendLine(sess, 'ucinewgame');
      const startFen = fen ?? fenForVariant(variant);
      sess.currentFen = startFen;
      this.sendLine(sess, `position fen ${startFen}`);
      this.sendLine(sess, 'isready');
      await this.waitFor(sess, /readyok/, 5000);
    }
  }

  /**
   * 应用一步并同步引擎棋盘状态。
   * 国际象棋/中国象棋: UCI 'position ... moves X Y Z ...'
   * 围棋: GTP 'play <color> <vertex>'
   *
   * 返回: { legal: boolean } — KataGo 不在 move 上返回错误,我们用 stderr 中的 'illegal' 判断
   */
  async applyMove(variant: GameVariant, move: string): Promise<{ legal: boolean }> {
    const sess = await this.ensureStarted(variant);
    // Stop any ongoing analysis first — use pendingCommand so we catch the
    // wind-down window after stopAnalyze() has cleared sess.analyzing.
    if (sess.pendingCommand === 'uci-analyze' || sess.pendingCommand === 'gtp-analyze') {
      try {
        sess.proc.stdin?.write('stop\n');
      } catch {}
      if (variant !== 'go') {
        await this.waitFor(sess, /bestmove/, 5000).catch(() => {});
      } else {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    if (variant === 'go') {
      const color = sess.gtpPlayerColor;
      // 监听 stderr 一行以检测 illegal move
      let illegalDetected = false;
      const onLine = (line: string) => {
        if (/illegal move/i.test(line)) illegalDetected = true;
      };
      sess.emitter.on('line', onLine);
      try {
        this.sendLine(sess, `play ${color} ${move}`);
        // wait for "? " or "= " reply
        await this.waitFor(sess, /^[=?] /m, 5000).catch(() => {});
        sess.gtpPlayerColor = color === 'B' ? 'W' : 'B';
        return { legal: !illegalDetected };
      } finally {
        sess.emitter.off('line', onLine);
      }
    } else {
      // UCI 棋种: 验证着法格式
      const uciPattern = variant === 'chess'
        ? /^[a-h][1-8][a-h][1-8][qrbn]?$/i
        : /^[a-i][1-9][a-i][0-9]$/i;
      if (!uciPattern.test(move)) {
        return { legal: false };
      }
      sess.moveHistory.push(move);
      this.sendLine(sess, 'position startpos moves ' + sess.moveHistory.join(' '));
      this.sendLine(sess, 'isready');
      const ready = await this.waitFor(sess, /readyok/, 3000).catch(() => false);
      return { legal: ready !== false };
    }
  }

  /**
   * 悔棋 — 撤销最后一步。
   * UCI: 不支持单步 undo, 重新 position 用减少后的 move history
   * GTP: 直接发 'undo' 命令
   */
  async undoMove(variant: GameVariant): Promise<{ legal: boolean }> {
    const sess = await this.ensureStarted(variant);
    if (sess.pendingCommand === 'uci-analyze' || sess.pendingCommand === 'gtp-analyze') {
      try {
        sess.proc.stdin?.write('stop\n');
      } catch {}
      if (variant !== 'go') {
        await this.waitFor(sess, /bestmove/, 5000).catch(() => {});
      } else {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    if (variant === 'go') {
      this.sendLine(sess, 'undo');
      const ok = await this.waitFor(sess, /^[=?] /m, 5000).catch(() => null);
      if (ok === null) return { legal: false };
      // 反转颜色
      sess.gtpPlayerColor = sess.gtpPlayerColor === 'B' ? 'W' : 'B';
      return { legal: true };
    } else {
      if (sess.moveHistory.length === 0) return { legal: false };
      sess.moveHistory.pop();
      this.sendLine(sess, 'position startpos moves ' + sess.moveHistory.join(' '));
      this.sendLine(sess, 'isready');
      const ok = await this.waitFor(sess, /readyok/, 3000).catch(() => null);
      return { legal: ok !== null };
    }
  }

  /** AI 生成下一步 (KataGo 走子后返回 GTP vertex, UCI 返回 'bestmove e2e4') */
  async genMove(variant: GameVariant, opts: { timeMs?: number; maxVisits?: number; styleId?: string } = {}): Promise<string | null> {
    const sess = await this.ensureStarted(variant);
    if (opts.styleId && opts.styleId !== sess.currentStyleId) {
      await this.setStyle(variant, opts.styleId);
    }
    const profile = getStyle(sess.currentStyleId);

    if (variant === 'go') {
      // 同 aiMove: 先打断可能正在跑的 kata-analyze
      if (sess.analyzing) {
        try {
          sess.proc.stdin?.write('\n');
        } catch {}
        await new Promise((r) => setTimeout(r, 100));
      }
      const color = sess.gtpPlayerColor;
      const profileMs = (profile.engineHints.go as { defaultTimeMs?: number } | undefined)?.defaultTimeMs;
      const timeMs = opts.timeMs ?? profileMs ?? 15000; // 15s for Go AI thinking
      const cmd = `kata-genmove_analyze ${color} ${timeMs}`;
      sess.pendingCommand = 'gtp-analyze';
      sess.gtpPending = null;
      sess.uciPendingByPv.clear();
      const captured: string[] = [];
      const onResp = (line: string) => {
        // 兼容 '= Q16' (传统 GTP) 与 'play Q16' (kata-genmove_analyze)
        if (/^=\s/.test(line) || /^play\s/.test(line)) captured.push(line);
      };
      sess.emitter.on('gtp-response', onResp);
      try {
        this.sendLine(sess, cmd);
        // 等待 "= <move>" 或 "play <move>" reply — KataGo Metal GPU 需要更长超时
        await this.waitFor(sess, /^(=|play)\s/m, timeMs + 60000).catch(() => {});
      } finally {
        sess.emitter.off('gtp-response', onResp);
        sess.pendingCommand = undefined;
      }
      if (captured.length === 0) return null;
      const last = captured[captured.length - 1];
      // 兼容 '= R16' 与 'play R16' 两种 reply 格式
      const moveName = last.replace(/^(?:=|play)\s+/, '').trim().split(/\s+/)[0];
      if (moveName) {
        sess.moveHistory.push(moveName);
        sess.gtpPlayerColor = color === 'B' ? 'W' : 'B';
      }
      return moveName || null;
    } else {
      const profileMs = (profile.engineHints[variant] as { defaultTimeMs?: number } | undefined)?.defaultTimeMs;
      const timeMs = opts.timeMs ?? profileMs ?? 5000; // 5s for UCI engine (Stockfish / Pikafish)
      sess.pendingCommand = 'uci-analyze';
      sess.uciPendingByPv.clear();
      let best: string | null = null;
      const onBest = (mv: string) => {
        best = mv;
      };
      sess.emitter.on('bestmove', onBest);
      try {
        this.sendLine(sess, `go movetime ${timeMs} multipv 3`);
        await this.waitFor(sess, /bestmove/, timeMs + 10000).catch(() => {});
      } finally {
        sess.emitter.off('bestmove', onBest);
        sess.pendingCommand = undefined;
      }
      if (best) sess.moveHistory.push(best);
      return best;
    }
  }

  /**
   * 分析当前局面 — 持续 yield analysis,直到调用 stopAnalyze()。
   * 国际象棋/中国象棋 (UCI): 收到 bestmove 时退出
   * 围棋 (GTP kata-analyze): 持续 yield 直到 stopAnalyze() 发 stop
   *
   * Event-driven: 不再 setInterval 轮询,直接监听 'analysis' / 'gtp-info' 事件。
   * 第一个 analysis 立即 yield,后续每个新 analysis 立即 yield。
   */
  async *analyze(variant: GameVariant, opts: UciOptions = {}): AsyncGenerator<Analysis, void, void> {
    const sess = await this.ensureStarted(variant);
    sess.uciPendingByPv.clear();
    sess.gtpPending = null;

    const startTime = Date.now();

    // If a previous search is still flagged (client disconnected mid-loop), we MUST
    // wait for it to finish before sending a new 'go infinite'. Without this, Stockfish
    // ignores our new command. For UCI, send 'stop' and wait for bestmove. For GTP, give
    // the engine a moment to wind down.
    if (sess.analyzing || sess.pendingCommand !== undefined) {
      if (variant === 'go') {
        try { sess.proc.stdin?.write('\n'); } catch {}
        await new Promise((r) => setTimeout(r, 400));
      } else {
        try { sess.proc.stdin?.write('stop\n'); } catch {}
        await this.waitFor(sess, /bestmove/, 8000).catch(() => {});
        const deadline = Date.now() + 4000;
        while (sess.pendingCommand !== undefined && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 50));
        }
      }
      sess.analyzing = false;
      sess.pendingCommand = undefined;
    }

    sess.analyzing = true;

    if (variant === 'go') {
      const color = sess.gtpPlayerColor;
      const interval = 100; // ms — 100ms = 10 reports/s (fast updates, not overwhelming)
      sess.pendingCommand = 'gtp-analyze';
      this.sendLine(sess, `kata-analyze ${color} ${interval / 10}`);

      // Event-driven queue: push every new gtpPending immediately when handleLine arrives
      const queue: Analysis[] = [];
      let resolveNext: ((v: Analysis | null) => void) | null = null;
      let stopped = false;

      const onInfo = () => {
        if (!sess.gtpPending) return;
        const analysis = buildGtpAnalysis({
          raw: sess.gtpPending,
          engine: 'KataGo v1.18.1',
          boardSize: sess.gtpBoardSize,
          playerColor: color,
          ownership: sess.lastOwnership ?? undefined,
        });
        sess.currentAnalysis = analysis;
        sess.gtpPending = null;
        if (resolveNext) {
          const r = resolveNext;
          resolveNext = null;
          r(analysis);
        } else {
          queue.push(analysis);
        }
      };
      sess.emitter.on('gtp-info', onInfo);

      try {
        // First yield ASAP: wait for the first 'gtp-info' event (no polling delay)
        while (!stopped && Date.now() - startTime < 300_000) {
          let next: Analysis | null = null;
          if (queue.length > 0) {
            next = queue.shift()!;
          } else {
            next = await new Promise<Analysis | null>((resolve) => {
              resolveNext = resolve;
            });
          }
          if (!next) break;
          yield next;
          if (!sess.analyzing) break;
        }
      } finally {
        stopped = true;
        sess.emitter.off('gtp-info', onInfo);
        sess.pendingCommand = undefined;
      }
    } else {
      const depth = opts.depth ?? 22;
      const multipv = opts.multipv ?? 3;
      sess.pendingCommand = 'uci-analyze';
      this.sendLine(sess, `go infinite multipv ${multipv}`);

      // Event-driven queue for UCI info lines
      const queue: Analysis[] = [];
      let resolveNext: ((v: Analysis | null) => void) | null = null;
      let stopped = false;

      const onAnalysis = () => {
        if (sess.uciPendingByPv.size === 0) return;
        const lines = Array.from(sess.uciPendingByPv.values());
        const a = buildUciAnalysis({
          variant: variant as 'chess' | 'xiangqi',
          lines,
          engine: variant === 'chess' ? 'Stockfish 18' : 'Pikafish 2026-01-02',
        });
        if (a) {
          sess.currentAnalysis = a;
          // Drain the pending snapshot so we only emit once per UCI info burst
          sess.uciPendingByPv.clear();
          if (resolveNext) {
            const r = resolveNext;
            resolveNext = null;
            r(a);
          } else {
            queue.push(a);
          }
        }
      };
      const onBest = () => {
        // bestmove means engine is done — exit analyze loop
        stopped = true;
        // Signal that the engine is now truly idle (for mutex callers waiting on stopAnalyze)
        sess.idleResolve?.();
        if (resolveNext) {
          const r = resolveNext;
          resolveNext = null;
          r(null);
        }
      };
      sess.emitter.on('analysis', onAnalysis);
      sess.emitter.on('bestmove', onBest);

      try {
        while (!stopped && sess.analyzing && Date.now() - startTime < 300_000) {
          let next: Analysis | null = null;
          if (queue.length > 0) {
            next = queue.shift()!;
          } else {
            next = await new Promise<Analysis | null>((resolve) => {
              resolveNext = resolve;
            });
          }
          if (!next) break;
          yield next;
        }
      } finally {
        stopped = true;
        sess.emitter.off('analysis', onAnalysis);
        sess.emitter.off('bestmove', onBest);
        sess.pendingCommand = undefined;
      }
    }
    sess.analyzing = false;
  }

  /** Stop analysis and return a promise that resolves when the engine is truly idle. */
  stopAnalyze(variant: GameVariant): Promise<void> {
    const sess = this.sessions.get(`${variant}:default`);
    if (!sess) return Promise.resolve();
    if (sess.pendingCommand === undefined) return Promise.resolve();

    sess.analyzing = false;

    if (variant === 'go') {
      try { sess.proc.stdin?.write('\n'); } catch {}
      setTimeout(() => {
        sess.pendingCommand = undefined;
        sess.idleResolve?.();
      }, 300);
      return Promise.resolve();
    }

    // UCI: set up idle promise BEFORE sending stop, so we can chain with next analyze.
    // handleLine will call sess.idleResolve() when bestmove arrives.
    let resolveIdle: () => void = () => {};
    const idlePromise = new Promise<void>((r) => { resolveIdle = r; });
    const orig = sess.idleResolve;
    sess.idleResolve = () => { orig?.(); resolveIdle(); };

    try { sess.proc.stdin?.write('stop\n'); } catch {}
    sess.emitter.emit('stop-analyze');

    return idlePromise;
  }

  /** Returns a promise that resolves when the engine is idle (bestmove received). */
  idleWhen(variant: GameVariant): Promise<void> {
    const sess = this.sessions.get(`${variant}:default`);
    if (!sess || sess.pendingCommand === undefined) return Promise.resolve();
    return new Promise<void>((r) => {
      const orig = sess!.idleResolve;
      sess!.idleResolve = () => { orig?.(); r(); };
    });
  }

  /** 让 AI 替玩家执子走棋 (KataGo: kata-genmove; UCI: go + bestmove) */
  async aiMove(variant: GameVariant, opts: { timeMs?: number; maxVisits?: number; styleId?: string } = {}): Promise<{ move: string | null; analysis?: Analysis; style?: StyleProfile }> {
    const sess = await this.ensureStarted(variant);
    // 如果用户传了 styleId, 先 setStyle 让引擎 hint 生效
    let activeStyle: StyleProfile | undefined;
    if (opts.styleId && opts.styleId !== sess.currentStyleId) {
      const r = await this.setStyle(variant, opts.styleId);
      activeStyle = r.style;
    } else {
      activeStyle = getStyle(sess.currentStyleId);
    }

    if (variant === 'go') {
      // 如果之前在跑 kata-analyze (来自 SSE 流),先发空行打断,避免与 kata-genmove_analyze 抢输出
      if (sess.analyzing) {
        try {
          sess.proc.stdin?.write('\n');
        } catch {}
        await new Promise((r) => setTimeout(r, 100));
      }
      const color = sess.gtpPlayerColor;
      // 用 profile 嘅 defaultTimeMs (冇就 15s)
      const profileMs = (activeStyle.engineHints.go as { defaultTimeMs?: number } | undefined)?.defaultTimeMs;
      const timeMs = opts.timeMs ?? profileMs ?? 15000;
      const interval = 250;
      sess.gtpPending = null;
      sess.uciPendingByPv.clear();
      sess.analyzing = true;
      sess.pendingCommand = 'gtp-analyze';
      this.sendLine(sess, `kata-genmove_analyze ${color} ${timeMs}`);

      const captured: string[] = [];
      const onResp = (line: string) => {
        // 兼容两种 GTP response 格式:
        // - 传统 '= R16' / '= pass' / '= resign'
        // - kata-genmove_analyze 直接 'play R16' (kata-analyze 系列不带 '=' 前缀)
        if (/^=\s/.test(line) || /^play\s/.test(line)) {
          captured.push(line);
        }
      };
      sess.emitter.on('gtp-response', onResp);

      try {
        // poll for bestmove-like response (= <move>) while streaming analysis
        const start = Date.now();
        while (captured.length === 0 && sess.analyzing) {
          await new Promise((r) => setTimeout(r, interval));
          if (sess.gtpPending) {
            const a = buildGtpAnalysis({
              raw: sess.gtpPending,
              engine: 'KataGo v1.18.1',
              boardSize: sess.gtpBoardSize,
              playerColor: color,
              ownership: sess.lastOwnership ?? undefined,
            });
            sess.currentAnalysis = a;
          }
          if (Date.now() - start > timeMs + 60000) break;
        }
      } finally {
        sess.emitter.off('gtp-response', onResp);
        sess.analyzing = false;
        sess.pendingCommand = undefined;
      }

      if (captured.length === 0) return { move: null, style: activeStyle };
      const last = captured[captured.length - 1];
      // 兼容 '= R16' / '= pass' 与 'play R16' / 'play pass' 两种格式
      const moveName = last.replace(/^(?:=|play)\s+/, '').trim().split(/\s+/)[0];
      if (moveName) {
        sess.moveHistory.push(moveName);
        sess.gtpPlayerColor = color === 'B' ? 'W' : 'B';
      }
      return { move: moveName || null, analysis: sess.currentAnalysis, style: activeStyle };
    } else {
      const profileMs = (activeStyle.engineHints[variant] as { defaultTimeMs?: number } | undefined)?.defaultTimeMs;
      const timeMs = opts.timeMs ?? profileMs ?? 4000;
      // Stop any ongoing infinite analysis first
      if (sess.analyzing) {
        try { sess.proc.stdin?.write('stop\n'); } catch {}
        await new Promise((r) => setTimeout(r, 100));
      }
      sess.uciPendingByPv.clear();
      sess.analyzing = true;
      sess.pendingCommand = 'uci-analyze';
      const multipv = (activeStyle.engineHints[variant] as { multipv?: number } | undefined)?.multipv ?? 3;
      this.sendLine(sess, `go movetime ${timeMs} multipv ${multipv}`);
      let best: string | null = null;
      const onBest = (mv: string) => {
        best = mv;
      };
      sess.emitter.on('bestmove', onBest);
      try {
        const start = Date.now();
        while (!best && Date.now() - start < timeMs + 10000) {
          await new Promise((r) => setTimeout(r, 200));
        }
      } finally {
        sess.emitter.off('bestmove', onBest);
        sess.analyzing = false;
        sess.pendingCommand = undefined;
      }
      if (best) {
        sess.moveHistory.push(best);
        // Sync engine position with the move we just made
        this.sendLine(sess, 'position startpos moves ' + sess.moveHistory.join(' '));
        this.sendLine(sess, 'isready');
        await this.waitFor(sess, /readyok/, 3000).catch(() => {});
      }
      return { move: best, analysis: sess.currentAnalysis, style: activeStyle };
    }
  }

  // ============ private ============

  private sendLine(sess: EngineSession, line: string) {
    if (!sess.proc.stdin?.writable) throw new Error('engine stdin closed');
    sess.proc.stdin.write(line + '\n');
  }

  private waitFor(sess: EngineSession, pattern: RegExp, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (ok: boolean, err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        sess.emitter.off('line', onLine);
        if (ok) resolve();
        else reject(err ?? new Error(`Engine timeout waiting for ${pattern}`));
      };
      const t = setTimeout(() => finish(false), timeoutMs);
      const onLine = (got: string) => {
        if (pattern.test(got)) finish(true);
      };
      sess.emitter.on('line', onLine);
    });
  }

  private handleLine(sess: EngineSession, line: string) {
    // Always emit so waitFor() can match
    sess.emitter.emit('line', line);

    if (sess.variant === 'go') {
      // GTP response handling
      if (line.startsWith('info ')) {
        const parsed = parseGtpInfoLine(line);
        if (parsed) {
          if (parsed.rootInfo || (parsed.moveInfos && parsed.moveInfos.size > 0)) {
            if (!sess.gtpPending) sess.gtpPending = { moveInfos: new Map(), rootInfo: undefined };
            if (parsed.rootInfo) sess.gtpPending.rootInfo = parsed.rootInfo;
            if (parsed.moveInfos) {
              for (const [k, v] of parsed.moveInfos.entries()) {
                sess.gtpPending.moveInfos!.set(k, v);
              }
            }
            // Notify analyze() loop of new pending data (event-driven, no polling)
            sess.emitter.emit('gtp-info', parsed);
          }
        }
      } else if (line === '') {
        // ignore
      } else if (/^\d+\s/.test(line) || /^=\s/.test(line) || /^[!?]\s/.test(line) || /^play\s/.test(line)) {
        // GTP 响应 (success / error / pass / resign)
        // kata-genmove_analyze 可能回复 'play R16' (无 '=' 前缀),也兼容传统 '= R16'
        sess.emitter.emit('gtp-response', line);
      } else if (/error|exception|fatal|illegal/i.test(line)) {
        sess.lastError = line;
        sess.emitter.emit('error', { variant: sess.variant, message: line });
      }
    } else {
      // UCI
      const parsed = parseUciLine(line);
      if (!parsed) return;
      if (parsed.readyok) {
        sess.emitter.emit('readyok');
      } else if (parsed.bestmove !== undefined) {
        sess.pendingCommand = undefined;
        // Notify idleWhen() so next request can start
        sess.idleResolve?.();
        sess.emitter.emit('bestmove', parsed.bestmove);
      } else if (parsed.multipv !== undefined) {
        sess.uciPendingByPv.set(parsed.multipv, parsed);
        sess.emitter.emit('analysis', parsed);
      } else if (parsed.depth !== undefined) {
        sess.uciPendingByPv.set(1, parsed);
        sess.emitter.emit('analysis', parsed);
      }
    }
  }
}

/** Variant 的起始 FEN */
function fenForVariant(variant: GameVariant): string {
  if (variant === 'chess') {
    return 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  }
  // Xiangqi standard starting FEN (Pikafish 格式):
  // Rank 0 = 黑方底线 (board row 0), Rank 9 = 红方底线 (board row 9)
  // 黑将 at e0 (row 0, col 4), 红帅 at e9 (row 9, col 4) — 将帅对脸于中线
  return 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1';
}

export const engineManager = EngineManager.instance;
