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
const KATAGO_CONFIG = path.join(ENGINE_DIR, 'gtp.cfg');

/** Auto-detect the KataGo network file in engines/networks/ — order matters:
 *  tf2 (smaller, faster on Metal) → b18c384 (stronger) → b10c192 (fallback).
 *  We probe both .bin.gz and .bin variants since the bootstrap script gunzips on download.
 */
function detectKataGoModel(): string | null {
  const candidates = [
    'kata1-tf2-b10c384-s2941M-d5872M.bin.gz',
    'kata1-tf2-b10c384-s2941M-d5872M.bin',
    'kata1-b18c384nbt-autov2.bin.gz',
    'kata1-b18c384nbt-autov2.bin',
    'kata1-b10c192nbt-adamxantidiag.bin.gz',
    'kata1-b10c192nbt-adamxantidiag.bin',
  ];
  for (const name of candidates) {
    const p = path.join(ENGINE_DIR, 'networks', name);
    if (fs.existsSync(p)) return p;
  }
  // last-ditch: any *.bin.gz in networks/
  try {
    const files = fs.readdirSync(path.join(ENGINE_DIR, 'networks'));
    const found = files.find((f) => f.endsWith('.bin.gz') || f.endsWith('.bin'));
    if (found) return path.join(ENGINE_DIR, 'networks', found);
  } catch {}
  return null;
}
const KATAGO_MODEL = detectKataGoModel();

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
  // AbortController for the currently running analyze() generator.
  // When a new analyze() starts before the previous one ends (race), we call
  // analyzeAbort?.abort() to wake its while-loop and let it return cleanly.
  analyzeAbort?: AbortController;
  // Per-analyze session token — Symbol-based guard so info lines from a stale
  // analyze (still in KataGo's stdout buffer) are ignored by the new analyze.
  gtpAnalyzeToken?: symbol;
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

  /** 检查引擎二进制 + 网络文件存在 */
  static health(): Record<GameVariant, boolean> {
    return {
      chess: fs.existsSync(STOCKFISH_BIN),
      xiangqi: fs.existsSync(PIKAFISH_BIN),
      go: fs.existsSync(KATAGO_BIN) && fs.existsSync(KATAGO_MODEL ?? ''),
    };
  }

  /** Diagnostics — for the /api/engine/diagnostics route, so users can self-debug */
  static diagnostics(): {
    engines: Record<GameVariant, { binary: string; binaryExists: boolean; binaryExec: boolean; extra?: Record<string, unknown> }>;
    modelPath: string | null;
    gtpConfig: string;
    cwd: string;
    hint: string | null;
  } {
    const canExec = (p: string) => {
      try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; }
    };
    const engines = {
      chess: { binary: STOCKFISH_BIN, binaryExists: fs.existsSync(STOCKFISH_BIN), binaryExec: canExec(STOCKFISH_BIN) },
      xiangqi: {
        binary: PIKAFISH_BIN,
        binaryExists: fs.existsSync(PIKAFISH_BIN),
        binaryExec: canExec(PIKAFISH_BIN),
        extra: { nnue: path.join(process.cwd(), 'pikafish.nnue'), nnueExists: fs.existsSync(path.join(process.cwd(), 'pikafish.nnue')) },
      },
      go: {
        binary: KATAGO_BIN,
        binaryExists: fs.existsSync(KATAGO_BIN),
        binaryExec: canExec(KATAGO_BIN),
        extra: { model: KATAGO_MODEL ?? null, config: KATAGO_CONFIG, configExists: fs.existsSync(KATAGO_CONFIG) },
      },
    };
    const allReady = engines.chess.binaryExec && engines.xiangqi.binaryExec && engines.go.binaryExec && engines.go.extra?.configExists;
    const hint = allReady
      ? null
      : 'Some engines are missing. Run `npm run engines:download` (or `bash scripts/download-engines.sh`) to install. See /api/engine/diagnostics for details.';
    return {
      engines,
      modelPath: KATAGO_MODEL ?? null,
      gtpConfig: KATAGO_CONFIG,
      cwd: process.cwd(),
      hint,
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
      if (!KATAGO_MODEL) {
        throw new Error('KataGo neural network not found in engines/networks/. Run: npm run engines:download');
      }
      bin = KATAGO_BIN;
      args = ['gtp', '-model', KATAGO_MODEL, '-config', KATAGO_CONFIG];
    }

    if (!fs.existsSync(bin)) {
      const diag = EngineManager.diagnostics();
      const detail = `Engine binary not found: ${bin}\n` +
        `Run: npm run engines:download  (or  bash scripts/download-engines.sh)\n` +
        `Diagnostics: ${JSON.stringify(diag, null, 2)}`;
      throw new Error(detail);
    }

    const proc = spawn(bin, args, {
      cwd: process.cwd(),
      env: { ...process.env, LD_LIBRARY_PATH: '' }, // avoid inheriting CUDA libs
      // 给 KataGo stdout/stderr 大 buffer (1MB),否则 kata-analyze 一次写 27KB+ info 行
      // 会填满默认 16KB pipe buffer 导致 KataGo 阻塞 write,后续命令不被处理
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Increase pipe buffer to 1MB to prevent KataGo from blocking on stdout writes
    if (proc.stdout) (proc.stdout as any)._writableState = Object.assign((proc.stdout as any)._writableState || {}, { highWaterMark: 1024 * 1024 });
    if (proc.stderr) (proc.stderr as any)._writableState = Object.assign((proc.stderr as any)._writableState || {}, { highWaterMark: 1024 * 1024 });

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

    // KataGo quirk: kata-analyze 把多个 `info move ...` 段合并在同一行 (空格分隔,不是换行)。
    // 关键洞察: parseGtpInfoLine 的 move 子段 while 循环本身就能处理一行内的所有 move 段,
    // 所以我们整行送 handleLine 一次,就能一次性把 52 个 candidates 全 parse 到 moveInfos。
    // 之前把一行 split 成多段、每段单独 handleLine 的写法导致 gtpPending.moveInfos 永远只有 1 个,
    // 因为 onInfo 处理后立即 gtpPending=null,后续 segments 在空白 gtpPending 上累积后又被清空。
    if (variant === 'go') {
      // Async batch processor: KataGo 在 kata-analyze 时一次性写 ~12KB info 行到 stdout,
      // 同步处理会阻塞 event loop 数秒导致 pipe buffer 满 → KataGo 阻塞 write → 死锁。
      // 用微任务 + 批处理让出 event loop。
      const batchQueue: string[] = [];
      let batchScheduled = false;
      const processBatch = () => {
        batchScheduled = false;
        // 一次最多处理 50 行,留出空隙给 socket/SSE
        const slice = batchQueue.splice(0, 50);
        for (const line of slice) {
          // 整行送 handleLine,parseGtpInfoLine 内部循环会处理所有 segments
          this.handleLine(sess, line.trim());
        }
        if (batchQueue.length > 0) {
          batchScheduled = true;
          setImmediate(processBatch);
        }
      };
      sess.procListeners.stdout = (buf: Buffer) => {
        const raw = buf.toString();
        const lines = raw.split(/\r?\n/);
        for (const ln of lines) {
          if (ln.trim()) batchQueue.push(ln);
        }
        if (!batchScheduled && batchQueue.length > 0) {
          batchScheduled = true;
          setImmediate(processBatch);
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

    // 等待引擎就绪 — 使用并行选项发送以加速启动
    if (variant === 'go') {
      // KataGo GTP: 等 'GTP ready' 信号 (从 stderr 来)
      await this.waitFor(sess, /GTP ready/, 60000);
      // 初始设置 board 并等待 reply,确保 board 状态已就绪。
      // 不做 warmup kata-analyze: SSE analyze 自然触发首次推理,更可靠。
      this.sendLine(sess, 'boardsize 19');
      await this.waitFor(sess, /^[=?]/, 5000).catch(() => {});
      this.sendLine(sess, 'clear_board');
      await this.waitFor(sess, /^[=?]/, 5000).catch(() => {});
      this.sendLine(sess, 'komi 7.5');
      await this.waitFor(sess, /^[=?]/, 5000).catch(() => {});
      sess.gtpBoardSize = 19;
      sess.gtpPlayerColor = 'B';
    } else {
      // UCI: 发送 'uci' 命令 + 等 uciok — 并行设置选项以减少启动延迟
      this.sendLine(sess, 'uci');
      await this.waitFor(sess, /uciok/, 30000);
      // 串行设置: Stockfish/Pikafish 的选项必须在 isready 之前完成,否则会丢选项
      this.sendLine(sess, 'setoption name MultiPV value 3');
      // Pikafish NNUE 引擎在 Apple Silicon 上吃单核;Threads>1 反而拖慢
      const threads = variant === 'xiangqi' ? 1 : 8;
      this.sendLine(sess, `setoption name Threads value ${threads}`);
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
    await this.stopOngoingAnalysis(variant);

    // Capture pre-clear state so we can decide whether to reset KataGo's board.
    // (Note: previously this check happened AFTER clearing, so it was always false
    //  and we never reset KataGo's internal board — causing subsequent moves to
    //  build on the wrong position.)
    const goBoardDirty =
      variant === 'go' &&
      (sess.moveHistory.length > 0 || sess.currentAnalysis !== undefined);

    sess.uciPendingByPv.clear();
    sess.gtpPending = null;
    sess.currentAnalysis = undefined;
    sess.moveHistory = [];

    if (variant === 'go') {
      // After restartGoEngine, the board is already initialized (boardsize 19, clear_board, komi 7.5).
      // Skip redundant init to avoid double-sending commands and confusing the reply queue.
      if (goBoardDirty) {
        // Board was modified — reset it. Each command must wait for its own reply before
        // sending the next, so use a separate await per command.
        this.sendLine(sess, 'boardsize 19');
        await this.waitFor(sess, /^[=?]/, 5000).catch(() => {});
        this.sendLine(sess, 'clear_board');
        await this.waitFor(sess, /^[=?]/, 5000).catch(() => {});
        this.sendLine(sess, 'komi 7.5');
        await this.waitFor(sess, /^[=?]/, 5000).catch(() => {});
      }
      // else: board is already clean (restartGoEngine already set it up)
      sess.gtpBoardSize = 19;
      sess.gtpPlayerColor = 'B';
      sess.ownershipRequested = false;
      sess.lastOwnership = null;
      // 强制清除 pending 状态,确保后续 analyze() 不会误判
      sess.pendingCommand = undefined;
      sess.analyzing = false;
    } else {
      this.sendLine(sess, 'ucinewgame');
      const startFen = fen ?? fenForVariant(variant);
      sess.currentFen = startFen;
      this.sendLine(sess, `position fen ${startFen}`);
      this.sendLine(sess, 'isready');
      await this.waitFor(sess, /readyok/, 5000);
    }
  }

  /** 私有: 强停任何正在跑的 analyze (await 引擎真正 idle) */
  private async stopOngoingAnalysis(variant: GameVariant): Promise<void> {
    const sess = this.sessions.get(`${variant}:default`);
    if (!sess) return;
    if (sess.pendingCommand !== 'uci-analyze' && sess.pendingCommand !== 'gtp-analyze') return;
    // RACE FIX: capture pendingCommand + analyzeAbort BEFORE yielding to event loop.
    // A concurrent new analyze() could overwrite these. Only clear if they STILL match
    // when we wake up. We use a per-call unique token (the abort controller reference)
    // to distinguish "ours" from "theirs" — both use the same pendingCommand string value,
    // so a string compare isn't enough.
    const capturedPending = sess.pendingCommand;
    const capturedAbort = sess.analyzeAbort;
    if (!capturedAbort) return; // No active analyze to stop
    if (process.env.CHESS_DEBUG) console.log(`[stopOngoingAnalysis] ${variant} pending=${sess.pendingCommand}`);
    try {
      sess.proc.stdin?.write(variant === 'go' ? '\n' : 'stop\n');
    } catch {}
    // 关键: 给引擎一个 flush time,然后等真正的 idle 信号
    sess.analyzing = false;
    if (variant !== 'go') {
      await this.waitFor(sess, /bestmove/, 5000).catch(() => {});
      const deadline = Date.now() + 4000;
      while (sess.analyzeAbort === capturedAbort && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
    } else {
      // KataGo: kata-analyze 不会立刻停止 — 它需要完成当前 batch 然后 emit '='。
      // 关键:KataGo 在收到 '\n' 后会完成当前 batch 然后 emit '='。如果 maxVisits=5000
      // (gtp.cfg),KataGo 约 3-5s 完成搜索。我们等 30s 以确保KataGo 真正 idle。
      // 如果超时,后续 commands 会进入 KataGo 队列,导致 board state 混乱。
      // RACE-FIX: 用 analyzeAbort 引用作为 token,只有当 analyzeAbort 仍是 ours 时才
      // 接受 reply。新的 analyze 会替换 analyzeAbort,我们的 wait 自然提前结束。
      const t0 = Date.now();
      const ourStopPattern = /^=$/;
      await new Promise<void>((resolve) => {
        let done = false;
        const finish = () => { if (!done) { done = true; clearTimeout(to); sess.emitter.off('line', onLine); resolve(); } };
        const onLine = (line: string) => {
          // 只有当我们仍然是 analyzeAbort 的主人才接受 reply
          if (sess.analyzeAbort !== capturedAbort) { finish(); return; }
          if (ourStopPattern.test(line)) finish();
        };
        const to = setTimeout(finish, 30000);
        sess.emitter.on('line', onLine);
      });
      if (process.env.CHESS_DEBUG) console.log(`[stopOngoingAnalysis go] waited ${Date.now()-t0}ms for '='`);
      // 额外 500ms 让剩余 info 行 flush 到我们这边
      await new Promise((r) => setTimeout(r, 500));
    }
    // Only clear state if it's STILL ours (RACE FIX — string compare is OK here because
    // a new analyze always sets pendingCommand to the same canonical value, but we use
    // analyzeAbort as the authoritative token: if a new analyze took over analyzeAbort,
    // we MUST NOT clear state it now owns).
    if (sess.analyzeAbort === capturedAbort) {
      sess.pendingCommand = undefined;
      sess.analyzeAbort = undefined;
      capturedAbort.abort();
    } else {
      // New analyze has taken over — only abort our (already-finished) generator
      capturedAbort.abort();
    }
    sess.analyzing = false;
    // Hard safety net: if pendingCommand is STILL set AND analyzeAbort is still ours after
    // all the above, the engine is stuck. For Go, don't restart — just clear state. The next
    // kata-analyze naturally overrides the old one. For UCI, kill and respawn the engine.
    // RACE-FIX: only fire hard reset if analyzeAbort is still ours (a new analyze
    // could have taken over with its own analyzeAbort reference).
    if (sess.pendingCommand !== undefined && sess.analyzeAbort === capturedAbort) {
      if (process.env.CHESS_DEBUG) console.log(`[stopOngoingAnalysis] HARD RESET — pendingCommand=${sess.pendingCommand} still set`);
      if (variant === 'go') {
        sess.pendingCommand = undefined;
        sess.analyzing = false;
        sess.idleResolve?.();
      } else {
        try { sess.proc.kill('SIGKILL'); } catch {}
        await new Promise((r) => setTimeout(r, 500));
        this.sessions.delete(`${variant}:default`);
        try { await this.start(variant); } catch {}
        sess.pendingCommand = undefined;
        sess.analyzing = false;
        sess.idleResolve?.();
      }
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
    await this.stopOngoingAnalysis(variant);
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
        // KataGo sometimes replies with bare `=` (no trailing space) — use a permissive
        // pattern that matches both `=` and `= <payload>` / `? illegal move` / `? <error>`.
        await this.waitFor(sess, /^[=?]/, 8000).catch(() => {});
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
    await this.stopOngoingAnalysis(variant);
    if (variant === 'go') {
      this.sendLine(sess, 'undo');
      const ok = await this.waitFor(sess, /^[=?]/, 5000).catch(() => null);
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
      // NOTE: KataGo GTP kata-genmove_analyze syntax is:
      //   kata-genmove_analyze <color> <time in seconds> [analysis interval in centiseconds]
      // timeMs is in milliseconds, convert to seconds.
      const timeSec = Math.ceil((timeMs ?? 15000) / 1000);
      const cmd = `kata-genmove_analyze ${color} ${timeSec}`;
      sess.pendingCommand = 'gtp-analyze';
      sess.gtpPending = null;
      sess.uciPendingByPv.clear();
      const captured: string[] = [];
      let resolvedReply: string | null = null;
      const onResp = (line: string) => {
        // 兼容 '= Q16' (传统 GTP) 与 'play Q16' (kata-genmove_analyze) — KataGo 偶尔只发
        // 裸 `=` (no payload, kata-analyze 中断信号余波)。带 payload 才是真正的着法。
        if (/^=/.test(line) || /^play/.test(line)) {
          captured.push(line);
          const payload = line.replace(/^(?:=|play)\s*/, '').trim();
          if (payload.length > 0 && resolvedReply === null) {
            resolvedReply = line;
          }
        }
      };
      sess.emitter.on('gtp-response', onResp);
      try {
        this.sendLine(sess, cmd);
        // 等待带 payload 的 reply; KataGo Metal GPU 需要更长超时
        await this.waitFor(sess, /^(=|play)/, timeMs + 60000).catch(() => {});
      } finally {
        sess.emitter.off('gtp-response', onResp);
        sess.pendingCommand = undefined;
      }
      let replyLine: string | null = resolvedReply;
      if (!replyLine) {
        const withPayload = captured.find((l) => l.replace(/^(?:=|play)\s*/, '').trim().length > 0);
        replyLine = withPayload ?? null;
      }
      if (!replyLine) return null;
      const moveName = replyLine.replace(/^(?:=|play)\s+/, '').trim().split(/\s+/)[0];
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
    // P0-1 fix: 重置 ownership 累积器 (跨新 analyze session)
    // NOTE: ownership 数据不再从 kata-analyze info 行获取 (kata-analyze 不输出 ownership)。
    // ownership 通过 engineManager.requestOwnership() 在分析完成后单独拉取。
    (sess as any).ownershipAcc = [];

    const startTime = Date.now();

    // If a previous search is still flagged (client disconnected mid-loop), we MUST
    // wait for it to finish before sending a new 'go infinite'. Without this, Stockfish
    // ignores our new command. For UCI, send 'stop' and wait for bestmove. For GTP, give
    // the engine a moment to wind down.
    // 如果上一轮 analyze 还挂着 (race condition),强制退出 — 共用辅助函数避免重复逻辑
    await this.stopOngoingAnalysis(variant);

    sess.analyzing = true;

    if (variant === 'go') {
      const color = sess.gtpPlayerColor;
      // Use kata-raw-nn 0 + lz-genmove_analyze in a loop? No — simpler: just use kata-analyze.
      // KataGo v1.18.1 kata-analyze 在 visits 累积后 emit 间隔指数增长 (issue #155),
      // 因此 intervalCs 设小 (10 = 0.1s) 强迫 KataGo 频繁 emit 当前快照。
      // 大于 100 (1秒) 的 intervalCs 在 M3 Ultra 上 ~3 秒后基本不再 emit。
      // 实际 SSE 流还是会被 KataGo 内部 maxVisits (config 5000) 终结,KataGo 完成搜索后
      // emit 最终 info + reply,前端会基于该 snapshot 显示,需要重新触发新一轮分析时再次
      // 调用 analyze()。这与 Sabaki/Lichess 的 kata-analyze 行为一致。
      const intervalCs = 10;
      sess.pendingCommand = 'gtp-analyze';

      // Event-driven queue: push every new gtpPending immediately when handleLine arrives
      const queue: Analysis[] = [];
      let resolveNext: ((v: Analysis | null) => void) | null = null;
      let stopped = false;

      // SESSION MARKER: register listener FIRST, then gate it on a per-analyze token.
      // This prevents stale info lines from a PREVIOUS analyze (still in KataGo's stdout
      // buffer after the previous `\n` interrupt) from polluting our gtpPending.
      // Old code did send → setImmediate → register; in that window stale info lines
      // could set gtpPending and confuse the next analyze.
      const sessionToken = Symbol('go-analyze-session');
      // P0-5 fix: dedup — KataGo 早期 emit 频繁且常常是同样的低-visits snapshot,
      // 用 (top1.move + scoreCp + visits) hash 跳过重复 yield,降低前端闪烁+带宽
      let lastYieldKey = '';
      const onInfo = (parsed: any) => {
        if (sess.gtpAnalyzeToken !== sessionToken) return; // Stale — not our session
        if (process.env.CHESS_DEBUG) console.log(`[gtp-info go] event fires: gtpPending=${!!sess.gtpPending} session=${sess.variant}`);
        if (!sess.gtpPending) return;
        if (process.env.CHESS_DEBUG) console.log(`[gtp-info go] building analysis`);
        const analysis = buildGtpAnalysis({
          raw: sess.gtpPending,
          engine: 'KataGo v1.18.1',
          boardSize: sess.gtpBoardSize,
          playerColor: color,
          ownership: sess.lastOwnership ?? undefined,
        });
        sess.currentAnalysis = analysis;
        sess.gtpPending = null;
        if (process.env.CHESS_DEBUG) console.log(`[gtp-info] build: lines=${analysis.multiPv.length} depth=${analysis.depth}`);
        // Dedup key: top move + scoreCp + visits (粗粒度足够判等)
        const top = analysis.multiPv[0];
        const dedupKey = `${top?.move}|${analysis.scoreCp}|${analysis.winRate.toFixed(3)}|${analysis.depth}`;
        if (dedupKey === lastYieldKey) {
          if (process.env.CHESS_DEBUG) console.log(`[analyze go] dedup skip: ${dedupKey}`);
          return; // skip — 同样的 snapshot 不重发
        }
        lastYieldKey = dedupKey;
        if (resolveNext) {
          const r = resolveNext;
          resolveNext = null;
          r(analysis);
        } else {
          queue.push(analysis);
        }
      };
      sess.emitter.on('gtp-info', onInfo);
      const abort = new AbortController();
      sess.analyzeAbort = abort;

      // CRITICAL: clear gtpPending + claim sessionToken BEFORE sending the command.
      // handleLine updates gtpPending and emits 'gtp-info'. Our listener fires only
      // if gtpAnalyzeToken matches sessionToken. By claiming it now, info lines that
      // arrive AFTER this point and before our cleanup run are ours.
      sess.gtpPending = null;
      sess.gtpAnalyzeToken = sessionToken;

      // P0-1 fix:kata-analyze 语法只接受 color + interval (cs)，不含 ownership/pvOwnership。
      // KataGo v1.18.1 GTP: ownership 需单独通过 kata-ownership <color> 命令获取。
      // 因此 kata-analyze 只发 `kata-analyze <color> <intervalCs>`。
      // ownership 在分析完成后通过 engineManager.requestOwnership() 单独拉取。
      const cmd = `kata-analyze ${color} ${intervalCs}`;
      this.sendLine(sess, cmd);
      if (process.env.CHESS_DEBUG) console.log(`[analyze] sent: ${cmd}`);

      const onAbort = () => {
        stopped = true;
        if (resolveNext) {
          const r = resolveNext;
          resolveNext = null;
          r(null);
        }
      };
      abort.signal.addEventListener('abort', onAbort);

      try {
        // First yield ASAP: wait for the first 'gtp-info' event (no polling delay)
        while (!stopped && !abort.signal.aborted && Date.now() - startTime < 300_000) {
          let next: Analysis | null = null;
          if (queue.length > 0) {
            next = queue.shift()!;
          } else {
            next = await new Promise<Analysis | null>((resolve) => {
              resolveNext = resolve;
            });
          }
          if (process.env.CHESS_DEBUG) console.log(`[analyze go] got next: lines=${next?.multiPv.length} stopped=${stopped} aborted=${abort.signal.aborted}`);
          if (!next) break;
          yield next;
          if (!sess.analyzing || abort.signal.aborted) break;
        }
      } finally {
        stopped = true;
        sess.emitter.off('gtp-info', onInfo);
        abort.signal.removeEventListener('abort', onAbort);
        // RACE FIX: token-based cleanup using `abort` (this generator's AbortController).
        // We are the OWNER of state if sess.analyzeAbort is still `abort` — meaning no
        // other analyze has taken over. Clear both pendingCommand and analyzeAbort ONLY
        // in that case. A concurrent stopAnalyze / stopOngoingAnalysis will skip our
        // state via the same check.
        if (sess.analyzeAbort === abort) {
          sess.pendingCommand = undefined;
          sess.analyzeAbort = undefined;
          // Release the session token so any late-arriving stale info lines from
          // this analyze are ignored by future listeners (a no-op since we just
          // removed the listener, but keeps session state consistent).
          sess.gtpAnalyzeToken = undefined;
        }
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
      const abort = new AbortController();
      sess.analyzeAbort = abort;
      // 当 abort 被触发时,让正在等待 next 的 Promise 立刻以 null resolve,
      // 不然 generator 卡在 await Promise 上无法退出
      const onAbort = () => {
        stopped = true;
        if (resolveNext) {
          const r = resolveNext;
          resolveNext = null;
          r(null);
        }
      };
      abort.signal.addEventListener('abort', onAbort);

      try {
        while (!stopped && sess.analyzing && !abort.signal.aborted && Date.now() - startTime < 300_000) {
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
        abort.signal.removeEventListener('abort', onAbort);
        // RACE FIX: token-based cleanup using `abort` (this generator's AbortController).
        // We are the OWNER of state if sess.analyzeAbort is still `abort` — meaning no
        // other analyze has taken over. Clear both pendingCommand and analyzeAbort ONLY
        // in that case. A concurrent stopAnalyze / stopOngoingAnalysis will skip our
        // state via the same check.
        if (sess.analyzeAbort === abort) {
          sess.pendingCommand = undefined;
          sess.analyzeAbort = undefined;
        }
      }
    }
    sess.analyzing = false;
  }

  /**
   * Force-restart a stalled KataGo engine after stopAnalyze times out.
   * Kills the process and re-initializes it so the next analyze() call works.
   * Called ONLY for the 'go' variant when kata-analyze refuses to stop.
   *
   * Concurrency guard: if a restart is already in progress, subsequent callers
   * wait for the in-flight restart to complete rather than racing.
   */
  private async restartGoEngine(sess: EngineSession): Promise<void> {
    // Prevent concurrent restarts from multiple callers (e.g. stopAnalyze timeout
    // firing at the same time as stopOngoingAnalysis hard-reset)
    if ((sess as any).__restarting) return;
    (sess as any).__restarting = true;
    try {
      if (process.env.CHESS_DEBUG) console.log('[KataGo] restarting stalled engine...');

      // Kill the old process first — do NOT send 'quit' (stdin may already be closed)
      try { sess.proc.kill('SIGKILL'); } catch {}
      // Close readline interface from the dead process
      try { sess.rl.close(); } catch {}

      // Remove stale listeners from the old (dead) process.
      // This prevents the OLD process's stdout/stderr callbacks from firing
      // on the new process after restart.
      try { sess.proc.stderr?.off('data', sess.procListeners.stderr); } catch {}
      try {
        if (sess.procListeners.stdout) sess.proc.stdout?.off('data', sess.procListeners.stdout);
      } catch {}
      try { sess.proc.off('exit', sess.procListeners.exit); } catch {}
      try { sess.proc.off('error', sess.procListeners.error); } catch {}

      // Give the OS a moment to release the old process's file descriptors
      await new Promise((r) => setTimeout(r, 300));

      // Re-spawn a fresh KataGo process
      // P1-2 fix: 必须用 try/finally 正确清理 __restarting 标志。即使 KATAGO_MODEL
      // 不存在,提前 return 也要让 finally 块运行,否则标志永久 stuck=true,后续
      // restart 调用全部被 guard 拦下,KataGo 永远无法恢复。
      if (!KATAGO_MODEL) {
        if (process.env.CHESS_DEBUG) console.error('[KataGo] no model found — cannot restart');
        // 抛错让上层捕获 — finally 仍会运行,因为 throw 走 try-finally 路径
        throw new Error('KataGo neural network not found; cannot restart');
      }
      const proc = spawn(KATAGO_BIN, ['gtp', '-model', KATAGO_MODEL, '-config', KATAGO_CONFIG], {
        cwd: process.cwd(),
        env: { ...process.env, LD_LIBRARY_PATH: '' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      if (proc.stdout) (proc.stdout as any)._writableState = Object.assign((proc.stdout as any)._writableState || {}, { highWaterMark: 1024 * 1024 });
      if (proc.stderr) (proc.stderr as any)._writableState = Object.assign((proc.stderr as any)._writableState || {}, { highWaterMark: 1024 * 1024 });

      // Install new process — all sendLine calls from here use sess.proc
      sess.proc = proc;
      const rl = readline.createInterface({ input: proc.stdout });
      sess.rl = rl;

      // Re-register listeners on the fresh process
      sess.procListeners.stderr = (buf: Buffer) => {
        const text = buf.toString();
        const lines = text.split(/\r?\n/);
        for (const ln of lines) {
          if (!ln) continue;
          this.handleLine(sess, ln);
        }
      };
      proc.stderr?.on('data', sess.procListeners.stderr);

      const batchQueue: string[] = [];
      let batchScheduled = false;
      const processBatch = () => {
        batchScheduled = false;
        const slice = batchQueue.splice(0, 50);
        for (const line of slice) {
          this.handleLine(sess, line.trim());
        }
        if (batchQueue.length > 0) {
          batchScheduled = true;
          setImmediate(processBatch);
        }
      };
      sess.procListeners.stdout = (buf: Buffer) => {
        const raw = buf.toString();
        const lines = raw.split(/\r?\n/);
        for (const ln of lines) {
          if (ln.trim()) batchQueue.push(ln);
        }
        if (!batchScheduled && batchQueue.length > 0) {
          batchScheduled = true;
          setImmediate(processBatch);
        }
      };
      proc.stdout?.on('data', sess.procListeners.stdout);

      sess.procListeners.exit = () => { sess.status = 'stopped'; };
      sess.procListeners.error = (err: Error) => { sess.status = 'errored'; sess.lastError = err.message; };
      proc.on('exit', sess.procListeners.exit);
      proc.on('error', sess.procListeners.error);

      // Wait for GTP ready, then send init commands — each blocks on its reply
      // so the board is GUARANTEED initialized when this function returns.
      // Without blocking, subsequent kata-analyze commands race with board init.
      await this.waitFor(sess, /GTP ready/, 30000).catch(() => {});
      this.sendLine(sess, 'boardsize 19');
      await this.waitFor(sess, /^[=?]/, 5000).catch(() => {});
      this.sendLine(sess, 'clear_board');
      await this.waitFor(sess, /^[=?]/, 5000).catch(() => {});
      this.sendLine(sess, 'komi 7.5');
      await this.waitFor(sess, /^[=?]/, 5000).catch(() => {});

      sess.status = 'ready';
      // Reset ALL engine state so subsequent operations see a CLEAN session.
      // Without this, stopOngoingAnalysis() sees pendingCommand='gtp-analyze' from the
      // interrupted kata-analyze and sends an extra newline, breaking the next command.
      sess.pendingCommand = undefined;
      sess.analyzing = false;
      sess.gtpPending = null;
      sess.uciPendingByPv.clear();
      sess.moveHistory = [];
      sess.idleResolve?.();
      if (process.env.CHESS_DEBUG) console.log('[KataGo] restart complete');
    } finally {
      (sess as any).__restarting = false;
    }
  }

  /** Stop analysis and return a promise that resolves when the engine is truly idle. */
  stopAnalyze(variant: GameVariant): Promise<void> {
    const sess = this.sessions.get(`${variant}:default`);
    if (!sess) return Promise.resolve();
    if (sess.pendingCommand === undefined) return Promise.resolve();

    // Abort the generator's while loop first
    sess.analyzing = false;
    if (sess.analyzeAbort) {
      const ac = sess.analyzeAbort;
      sess.analyzeAbort = undefined;
      ac.abort();
    }

    if (variant === 'go') {
      try { sess.proc.stdin?.write('\n'); } catch {}
      // Wait up to 2s for the engine to confirm stop. If it times out, do NOT restart —
      // just clear state and let the next analyze() start fresh. Restarting here would kill
      // the KataGo process that the subsequent SSE stream needs.
      //
      // RACE FIX: use analyzeAbort as the token — pendingCommand string ('gtp-analyze')
      // is the same for old + new analyzes so we can't distinguish them by string compare.
      // Only clear state if `analyzeAbort` is still ours.
      const capturedAbort = sess.analyzeAbort;
      return new Promise<void>((resolve) => {
        let settled = false;
        const settle = () => {
          if (settled) return;
          settled = true;
          clearTimeout(t);
          // Only clear state if analyzeAbort is STILL ours. A new analyze may have already
          // overwritten it with its own AbortController.
          if (sess.analyzeAbort === capturedAbort) {
            sess.pendingCommand = undefined;
            sess.analyzeAbort = undefined;
          }
          sess.idleResolve?.();
          resolve();
        };
        const t = setTimeout(() => {
          if (process.env.CHESS_DEBUG) console.log('[stopAnalyze go] timeout — clearing state, no restart');
          settle();
        }, 2000);
        // KataGo 偶爾只回裸 `=` (無 payload),用 [=?] 而非 [=?] 匹配
        const onLine = (line: string) => {
          // 如果 abort 已被替换(新 analyze 接管),立刻返回
          if (sess.analyzeAbort !== capturedAbort) { settle(); return; }
          if (/^[=?]/.test(line)) settle();
        };
        sess.emitter.on('line', onLine);
        sess.emitter.once('gtp-response', () => settle());
      });
    }

    // UCI: set up idle promise BEFORE sending stop
    let resolveIdle: () => void = () => {};
    const idlePromise = new Promise<void>((r) => { resolveIdle = r; });
    const orig = sess.idleResolve;
    sess.idleResolve = () => { orig?.(); resolveIdle(); };

    try { sess.proc.stdin?.write('stop\n'); } catch {}
    sess.emitter.emit('stop-analyze');

    return idlePromise;
  }

  /** P1-7 fix: 请求 KataGo ownership heatmap (预期归属每个交叉点)
   *  KataGo v1.18.1 支持 kata-ownership <color>,返回 361 个 -1..1 的 ownership 值。
   *  返回 19x19 的 number[][] 数组。 */
  async requestOwnership(variant: GameVariant): Promise<number[][] | null> {
    if (variant !== 'go') return null;
    const sess = this.sessions.get(`${variant}:default`);
    if (!sess || sess.status !== 'ready') return null;
    await this.stopOngoingAnalysis(variant).catch(() => {});
    const color = sess.gtpPlayerColor === 'B' ? 'W' : 'B'; // 当前要走子的颜色 (analysis 后是对手视角)
    const reply = await this.sendGtpSync(sess, `kata-ownership ${color}`, 8000);
    if (!reply) return null;
    // reply 形如: =ownership
    //   <19个数字> <19个数字> ... 共 361 个 -1..1
    const m = reply.match(/^=\s*ownership\s*([\s\S]*)$/i);
    if (!m) return null;
    const tokens = m[1].trim().split(/\s+/);
    if (tokens.length < 361) return null;
    const grid: number[][] = [];
    for (let r = 0; r < 19; r++) {
      const row: number[] = [];
      for (let c = 0; c < 19; c++) {
        row.push(parseFloat(tokens[r * 19 + c]) || 0);
      }
      grid.push(row);
    }
    sess.lastOwnership = grid;
    return grid;
  }

  /** P1-9 fix: 请求 KataGo 最终 territory 计分 (kata-final_score)
   *  返回 { winner: 'B' | 'W' | '?', score: number, resign?: boolean } */
  async requestFinalScore(variant: GameVariant): Promise<{ winner: 'B' | 'W' | '?'; score: number; resign?: boolean } | null> {
    if (variant !== 'go') return null;
    const sess = this.sessions.get(`${variant}:default`);
    if (!sess || sess.status !== 'ready') return null;
    const reply = await this.sendGtpSync(sess, 'kata-final_score', 10000);
    if (!reply) return null;
    // reply: = B+5.5 (territory win) 或 = B+R / = W+T (resign by opponent) 或 = 0 (tie)
    // 格式: = <color><+|-|><score>[R|T]
    // resign 格式: B+R = 黑方认输(白赢), W+R = 白方认输(黑赢)
    // tie 格式: = 0
    const resignMatch = reply.match(/^=\s*([BW])\+([RT])/i);
    if (resignMatch) {
      const resigner = resignMatch[1].toUpperCase();
      const winner: 'B' | 'W' = resigner === 'B' ? 'W' : 'B';
      return { winner, score: 0, resign: true };
    }
    const m = reply.match(/^=\s*([BW])([+-])([0-9.]+)/i);
    if (!m) return null;
    const winner = m[1].toUpperCase() as 'B' | 'W';
    const sign = m[2] === '-' ? -1 : 1;
    const score = sign * parseFloat(m[3]);
    return { winner, score, resign: false };
  }

  /** 私有: 同步发送 GTP 命令并等响应 (1 round-trip) */
  private sendGtpSync(sess: EngineSession, cmd: string, timeoutMs: number): Promise<string | null> {
    return new Promise((resolve) => {
      let resolved = false;
      const done = (v: string | null) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(t);
        sess.emitter.off('line', onLine);
        resolve(v);
      };
      const t = setTimeout(() => done(null), timeoutMs);
      const onLine = (line: string) => {
        if (line.startsWith('=') || line.startsWith('?')) done(line);
      };
      sess.emitter.on('line', onLine);
      try {
        this.sendLine(sess, cmd);
      } catch {
        done(null);
      }
    });
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
  async aiMove(variant: GameVariant, opts: { timeMs?: number; maxVisits?: number; styleId?: string } = {}): Promise<{ move: string | null; analysis?: Analysis; style?: StyleProfile; source?: 'book' | 'engine' }> {
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
      // NOTE: KataGo GTP kata-genmove_analyze syntax is:
      //   kata-genmove_analyze <color> <time in seconds> [analysis interval in centiseconds]
      const timeSec = Math.ceil((timeMs ?? 15000) / 1000);
      this.sendLine(sess, `kata-genmove_analyze ${color} ${timeSec}`);

      const captured: string[] = [];
      let resolvedReply: string | null = null;
      const onResp = (line: string) => {
        // 兼容三种 GTP response 格式:
        // - 传统 '= R16' / '= pass' / '= resign'
        // - kata-genmove_analyze 直接 'play R16' (kata-analyze 系列不带 '=' 前缀)
        // - 裸 '=' (空 payload, KataGo 中断 kata-analyze 时的 stop 余波, 不算完成)
        if (/^=/.test(line) || /^play/.test(line)) {
          captured.push(line);
          const payload = line.replace(/^(?:=|play)\s*/, '').trim();
          // 只有带 payload 的 reply 才算完成 — 裸 '=' 可能是 kata-analyze 中断信号
          if (payload.length > 0 && resolvedReply === null) {
            resolvedReply = line;
          }
        }
      };
      sess.emitter.on('gtp-response', onResp);

      try {
        // poll for bestmove-like response (= <move>) while streaming analysis
        const start = Date.now();
        while (resolvedReply === null && sess.analyzing) {
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

      // Fallback 1: 如果 timeout 后 captured 仍有裸 '=' 但没 payload, 检查 captured 是否有任何 payload
      // Fallback 2: 没有 reply → 失败
      let replyLine: string | null = resolvedReply;
      if (!replyLine) {
        const withPayload = captured.find((l) => l.replace(/^(?:=|play)\s*/, '').trim().length > 0);
        replyLine = withPayload ?? null;
      }
      if (!replyLine) return { move: null, analysis: sess.currentAnalysis, style: activeStyle };
      // 兼容 '= R16' / '= pass' 与 'play R16' / 'play pass' 两种格式
      const moveName = replyLine.replace(/^(?:=|play)\s+/, '').trim().split(/\s+/)[0];
      if (moveName) {
        sess.moveHistory.push(moveName);
        sess.gtpPlayerColor = color === 'B' ? 'W' : 'B';
      }
      return { move: moveName || null, analysis: sess.currentAnalysis, style: activeStyle };
    } else {
      // P0-3 fix: 象棋开局库 (前 12 着) 优先于引擎 — 避免 Pikafish 重复推算已知最佳开局
      if (variant === 'xiangqi') {
        try {
          const { getNextXiangqiMove } = await import('../xiangqi-opening-book');
          const bookMove = getNextXiangqiMove(sess.moveHistory);
          if (bookMove && sess.moveHistory.length < 12) {
            // 直接用 book move, 同步引擎位置
            sess.moveHistory.push(bookMove);
            this.sendLine(sess, 'position startpos moves ' + sess.moveHistory.join(' '));
            this.sendLine(sess, 'isready');
            await this.waitFor(sess, /readyok/, 3000).catch(() => {});
            return { move: bookMove, analysis: sess.currentAnalysis, style: activeStyle, source: 'book' as const };
          }
        } catch {}
      }
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

  private async sendLine(sess: EngineSession, line: string) {
    if (!sess.proc.stdin?.writable) throw new Error('engine stdin closed');
    // KataGo 在跑 kata-analyze 时持续 emit ~12KB info 行,
    // 如果 stdout pipe 满(KataGo 阻塞 write),stdin 也可能受影响。
    // 当 write 返回 false 表示内部 buffer 满,需等 'drain' 事件后再继续,否则后续 write 全阻塞。
    try {
      const ok = sess.proc.stdin.write(line + '\n', (err) => {
        if (err && process.env.CHESS_DEBUG) {
          console.warn(`[sendLine ${sess.variant} ${line}] write err: ${err.message}`);
        }
      });
      if (ok === false) {
        // stdin 内部 buffer 满 — 等待 drain 事件
        // drain 表示 KataGo 已消费 buffer 中的数据,可以继续写
        const drainPromise = new Promise<void>((resolve) => {
          sess.proc.stdin!.once('drain', resolve);
        });
        const timeout = new Promise<void>((resolve) => setTimeout(resolve, 2000));
        await Promise.race([drainPromise, timeout]);
      }
    } catch (e: any) {
      if (process.env.CHESS_DEBUG) console.warn(`[sendLine ${sess.variant} ${line}] exc: ${e.message}`);
    }
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
    if (process.env.CHESS_DEBUG) {
      // Go: only log a sample to avoid spamming
      if (sess.variant !== 'go' || Math.random() < 0.02 || line.startsWith('=') || line.startsWith('?')) {
        console.log(`[${sess.variant} ${line.length < 200 ? line : line.slice(0, 200) + '...'}]`);
      }
    }

    if (sess.variant === 'go') {
      // GTP response handling
      if (line.startsWith('info ')) {
        const parsed = parseGtpInfoLine(line);
        if (process.env.CHESS_DEBUG) console.log(`[handle-go] info line parsed=${!!parsed} rootInfo=${!!parsed?.rootInfo} moves=${parsed?.moveInfos?.size ?? 0}`);
        if (parsed) {
          if (!sess.gtpPending) sess.gtpPending = { moveInfos: new Map(), rootInfo: undefined };
          if (parsed.rootInfo) sess.gtpPending.rootInfo = parsed.rootInfo;
          if (parsed.moveInfos) {
            for (const [k, v] of parsed.moveInfos.entries()) {
              sess.gtpPending.moveInfos!.set(k, v);
            }
          }
          // P0-1 fix: 累积 ownership tokens 跨多次 info 行调用,KataGo 可能分批 emit.
          // 达到 361 (19x19) tokens 时转 2D 网格存储到 gtpPending.ownership.
          if (parsed.ownershipRaw && parsed.ownershipRaw.length > 0) {
            const sessAny = sess as any;
            if (!sessAny.ownershipAcc) sessAny.ownershipAcc = [];
            sessAny.ownershipAcc.push(...parsed.ownershipRaw);
            // 满了 19x19 = 361 个 → 转 2D
            if (sessAny.ownershipAcc.length >= 361 && !sess.gtpPending.ownership) {
              const tokens = sessAny.ownershipAcc.slice(0, 361);
              const grid: number[][] = [];
              for (let r = 0; r < 19; r++) {
                const row: number[] = [];
                for (let c = 0; c < 19; c++) {
                  row.push(tokens[r * 19 + c] ?? 0);
                }
                grid.push(row);
              }
              sess.gtpPending.ownership = grid;
              // 保留余数 (虽然罕见) 以便跨多个 snapshot 也能更新
              sessAny.ownershipAcc = sessAny.ownershipAcc.slice(361);
            }
          }
          // Notify analyze() loop of new pending data (event-driven, no polling)
          if (process.env.CHESS_DEBUG) console.log(`[handle-go] EMIT gtp-info: moves=${sess.gtpPending.moveInfos?.size ?? 0}`);
          sess.emitter.emit('gtp-info', parsed);
        }      } else if (line === '') {
        // ignore
      // GTP 响应 — KataGo 偶爾只回裸 `=` (無 payload) 或 `? illegal move` (有 payload)。
      // 之前用 /^=\s/ 要求 \s 后缀会把裸 `=` 漏掉,导致 gtp-response 事件不触发,
      // stopOngoingAnalysis 等 listener 永远收不到 reply。
      // 改成 /^=|/ /^[!?]/ /^\d+/ / 任意前缀,只要行首是 `=` 或 `?` 或 cmd-id 数字或 `play`。
      } else if (/^\d+\s/.test(line) || /^=[^\n]?/.test(line) || /^[!?]\s?/.test(line) || /^play/.test(line)) {
        // GTP 响应 (success / error / pass / resign / kata-genmove_analyze 'play R16')
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
