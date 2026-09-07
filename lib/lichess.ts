// Lichess API client — fetches games + sends moves
// Reference: https://lichess.org/api

const LICHESS_API = 'https://lichess.org/api';

export interface LichessGameInfo {
  game_id: string;
  variant: string;
  rated: boolean;
  status: string;
  players: {
    white: { userId?: string; name: string; rating?: number };
    black: { userId?: string; name: string; rating?: number };
  };
  opening?: { eco: string; name: string; ply: number };
  pgn: string;
  fen: string;
  turn: 'white' | 'black';
  winner?: 'white' | 'black';
  analysis_url: string;
}

/** Fetch game info from Lichess public API. */
export async function fetchLichessGame(gameId: string): Promise<LichessGameInfo | null> {
  const trimmed = gameId.trim();
  // Accept full URL or just ID
  const idMatch = trimmed.match(/lichess\.org\/([a-zA-Z0-9]{8,12})/) || trimmed.match(/^([a-zA-Z0-9]{8,12})$/);
  const id = idMatch ? idMatch[1] : null;
  if (!id) return null;
  try {
    const resp = await fetch(`${LICHESS_API}/game/${id}?pgnInJson=true&opening=true&lastFen=true`, {
      headers: { Accept: 'application/x-ndjson' },
    });
    if (!resp.ok) {
      console.error('Lichess API error:', resp.status);
      return null;
    }
    const text = await resp.text();
    const data = JSON.parse(text);
    // Lichess NDJSON returns array
    const gameData = Array.isArray(data) ? data[0] : data;
    return {
      game_id: id,
      variant: gameData.variant ?? 'standard',
      rated: gameData.rated ?? false,
      status: gameData.status ?? 'unknown',
      players: {
        white: {
          userId: gameData.players?.white?.user?.id,
          name: gameData.players?.white?.user?.name ?? gameData.players?.white?.name ?? 'White',
          rating: gameData.players?.white?.rating,
        },
        black: {
          userId: gameData.players?.black?.user?.id,
          name: gameData.players?.black?.user?.name ?? gameData.players?.black?.name ?? 'Black',
          rating: gameData.players?.black?.rating,
        },
      },
      opening: gameData.opening ? { eco: gameData.opening.eco, name: gameData.opening.name, ply: gameData.opening.ply } : undefined,
      pgn: gameData.pgn ?? '',
      fen: gameData.fen ?? gameData.initialFen ?? '',
      turn: gameData.fen ? (gameData.fen.split(' ')[1] === 'w' ? 'white' : 'black') : 'white',
      winner: gameData.winner,
      analysis_url: `https://lichess.org/${id}`,
    };
  } catch (e) {
    console.error('Failed to fetch Lichess game:', e);
    return null;
  }
}

/** Make a move on Lichess via bot API. Requires a Lichess API token with bot permissions. */
export async function lichessPlayMove(gameId: string, uci: string, apiToken: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const resp = await fetch(`${LICHESS_API}/bot/game/${gameId}/move/${uci}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiToken}` },
    });
    if (resp.ok) return { ok: true };
    const err = await resp.text();
    return { ok: false, error: `HTTP ${resp.status}: ${err}` };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

/** Fetch the latest Lichess game from a username (requires OAuth token for private games). */
export async function fetchLatestGame(username: string): Promise<string | null> {
  try {
    const resp = await fetch(`${LICHESS_API}/games/user/${username}?max=1&pgnInJson=true&clocks=false&evals=false&opening=false&ongoing=true`);
    if (!resp.ok) return null;
    const text = await resp.text();
    const games = text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    return games[0]?.id ?? null;
  } catch (e) {
    return null;
  }
}

/** Parse a Lichess board URL into FEN. */
export function parseLichessUrl(url: string): { fen: string } | null {
  // Patterns:
  // https://lichess.org/analysis/board/<FEN-segments>
  // https://lichess.org/board/<FEN-segments>
  // https://lichess.org/<GAME_ID> (live game)
  //
  // Lichess encodes FEN with `/` between ranks/fields and `_` for spaces
  // within a field. The previous regex used `[^\/?]+` which stopped at the
  // first `/`, so URLs like
  //   https://lichess.org/analysis/board/rnbqkbnr/pppppppp/8/8/.../RNBQKBNR_b_KQkq_e3_0_1
  // only captured `rnbqkbnr` (a single rank) — which caused `new Chess(...)`
  // to throw and stall the connect flow.
  //
  // Match everything after `/board/` up to the next `?` or end of string.
  // Standard FEN has 6 space-separated fields (placement / side / castling /
  // ep / halfmove / fullmove). The Lichess URL form encodes the placement
  // ranks with `/` and spaces within a field with `_`. We want to keep the
  // `/` between ranks (FEN uses `/` to separate ranks inside field #1) and
  // only replace `_` with space.
  const boardMatch = url.match(/lichess\.org\/(?:analysis\/)?board\/([^?]+?)(?:\?|$)/);
  if (boardMatch) {
    const fen = boardMatch[1].replace(/_/g, ' ').trim();
    // Sanity check: a full FEN has exactly 6 space-separated fields.
    if (fen.split(/\s+/).length === 6) {
      return { fen };
    }
    // Fall through — looks like a board URL but malformed FEN.
  }
  const gameMatch = url.match(/lichess\.org\/([a-zA-Z0-9]{8,12})(?:\b|$)/);
  if (gameMatch) {
    return null; // game URL — needs API call
  }
  return null;
}
