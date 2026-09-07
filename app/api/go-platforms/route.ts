// Go 网站集成 — 弈城 / 野狐 / OGS / KGS 连接层
// 支持：读取棋谱、分析连接、实时观战

import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ============ 类型定义 ============

export interface GoPlatform {
  id: string;
  name: string;
  nameCn: string;
  region: 'cn' | 'intl';
  baseUrl: string;
  supportedActions: ('watch' | 'analysis' | 'profile')[];
  authRequired: boolean;
  icon: string;
}

export interface GameRecord {
  id: string;
  platform: string;
  blackPlayer: string;
  whitePlayer: string;
  result: string;
  date: string;
  handicap: number;
  komi: number;
  boardSize: number;
  moves: string[];
  url: string;
}

// ============ 平台注册表 ============

export const PLATFORMS: GoPlatform[] = [
  {
    id: 'yicheng',
    name: 'Yike (Yicheng)',
    nameCn: '弈城围棋',
    region: 'cn',
    baseUrl: 'https://www.yichengw.com',
    supportedActions: ['watch', 'profile'],
    authRequired: true,
    icon: '♟',
  },
  {
    id: 'yefox',
    name: 'Yefox (Wild Fox)',
    nameCn: '野狐围棋',
    region: 'cn',
    baseUrl: 'https://www.yihuk.com',
    supportedActions: ['watch', 'profile', 'analysis'],
    authRequired: true,
    icon: '🦊',
  },
  {
    id: 'ogs',
    name: 'Online-Go.com',
    nameCn: 'OGS 国际围棋',
    region: 'intl',
    baseUrl: 'https://ogs.dev',
    supportedActions: ['watch', 'profile', 'analysis'],
    authRequired: false,
    icon: '⬆',
  },
  {
    id: 'kgs',
    name: 'KGS',
    nameCn: 'KGS 围棋',
    region: 'intl',
    baseUrl: 'https://www.gokgs.com',
    supportedActions: ['watch', 'profile'],
    authRequired: false,
    icon: '🏯',
  },
  {
    id: 'foxwq',
    name: 'Fox Weiqi (FoxGo)',
    nameCn: '腾讯围棋(微信)',
    region: 'cn',
    baseUrl: 'https://weiqi.qq.com',
    supportedActions: ['watch', 'analysis'],
    authRequired: true,
    icon: '🦊',
  },
];

// ============ API 端点 ============

export async function GET(req: NextRequest) {
  const action = req.nextUrl.searchParams.get('action');
  const platform = req.nextUrl.searchParams.get('platform');
  const gameId = req.nextUrl.searchParams.get('gameId');

  try {
    // 列出所有平台
    if (action === 'list-platforms') {
      return NextResponse.json({ ok: true, data: { platforms: PLATFORMS } });
    }

    // 获取平台详情
    if (action === 'platform-info' && platform) {
      const p = PLATFORMS.find((x) => x.id === platform);
      if (!p) return NextResponse.json({ ok: false, error: 'Platform not found' }, { status: 404 });
      return NextResponse.json({ ok: true, data: p });
    }

    // 获取 OGS 公开棋谱（无需认证）
    if (action === 'fetch-ogs' && gameId) {
      const res = await fetch(`https://ogs.dev/api/v1/games/${gameId}/sgf`, {
        headers: { 'User-Agent': 'chess-ai-hub/1.0' },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return NextResponse.json({ ok: false, error: `HTTP ${res.status}` }, { status: 502 });
      const sgf = await res.text();
      return NextResponse.json({ ok: true, data: { sgf, gameId } });
    }

    // 获取 FoxGo 公开棋谱
    if (action === 'fetch-foxwq' && gameId) {
      // FoxGo 部分棋谱有公开接口
      const res = await fetch(`https://weiqi.qq.com/cgi-bin/lz_cgi/GetGameRecord`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ game_id: gameId }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return NextResponse.json({ ok: false, error: `HTTP ${res.status}` }, { status: 502 });
      const data = await res.json();
      return NextResponse.json({ ok: true, data });
    }

    return NextResponse.json({ ok: false, error: 'Unknown action' }, { status: 400 });
  } catch (e: unknown) {
    const err = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: err }, { status: 500 });
  }
}

// ============ SGF 解析工具（服务端辅助） ============

/**
 * 解析 SGF 字符串，提取基本信息
 */
export function parseSgfBasic(sgf: string): {
  black?: string;
  white?: string;
  result?: string;
  date?: string;
  komi?: number;
  handicap?: number;
  boardSize?: number;
  moves: string[];
} {
  const get = (key: string): string | undefined => {
    const m = sgf.match(new RegExp(`${key}\\[([^\\]]+)\\]`, 'i'));
    return m?.[1];
  };

  const getInt = (key: string): number | undefined => {
    const v = get(key);
    return v ? parseInt(v, 10) : undefined;
  };

  // 提取所有着法
  const moves: string[] = [];
  const moveMatches = sgf.matchAll(/;[BW]\[([a-z]{2})\]/gi);
  for (const m of moveMatches) {
    moves.push(m[1].toUpperCase());
  }

  return {
    black: get('PB'),
    white: get('PW'),
    result: get('RE'),
    date: get('DT'),
    komi: getInt('KM'),
    handicap: getInt('HA'),
    boardSize: getInt('SZ') || 19,
    moves,
  };
}
