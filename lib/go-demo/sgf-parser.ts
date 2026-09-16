// SGF (Smart Game Format) parser — for Demo Mode game replay
// Reference: https://www.red-bean.com/sgf/
//
// We parse only the main line (no branching).

export interface SgfGame {
  metadata: {
    event?: string;
    round?: string;
    date?: string;
    playerBlack?: string;
    playerWhite?: string;
    blackRank?: string;
    whiteRank?: string;
    result?: string;
    rules?: string;
    size?: number;
    komi?: number;
    source?: string;
  };
  /** Sequential moves as GTP coords (e.g. "D16", "Q4", "pass") */
  moves: string[];
}

/** SGF column letter → 0-indexed col (a=0..h=7, i SKIPPED, j=9..t=18) */
function sgfColToNum(c: string): number {
  const upper = c.toUpperCase();
  const code = upper.charCodeAt(0) - 'A'.charCodeAt(0);
  return upper >= 'I' ? code - 1 : code;
}

/** 0-indexed col → SGF column letter (skip 'i') */
function numToSgfCol(col: number): string {
  return col < 8
    ? String.fromCharCode('a'.charCodeAt(0) + col)
    : String.fromCharCode('a'.charCodeAt(0) + col + 1);
}

/** SGF row letter → 1-indexed row (a=1..s=19, i SKIPPED) */
function sgfRowToNum(c: string): number {
  const upper = c.toUpperCase();
  if (upper < 'A' || upper > 'T' || upper === 'I') return NaN;
  const code = upper.charCodeAt(0) - 'A'.charCodeAt(0);
  return upper >= 'I' ? code : code + 1;
}

/** 1-indexed row → SGF row letter */
function numToSgfRow(row: number): string {
  if (row < 1 || row > 19) return '';
  return row <= 8
    ? String.fromCharCode('a'.charCodeAt(0) + row - 1)
    : String.fromCharCode('a'.charCodeAt(0) + row);
}

/** SGF coord (e.g. "pd") → GTP vertex (e.g. "P4") */
export function sgfToGtp(sgfCoord: string): string {
  if (!sgfCoord || sgfCoord === '' || sgfCoord.toLowerCase() === 'tt') return 'pass';
  if (sgfCoord.length < 2) return 'pass';
  const colChar = sgfCoord[0].toUpperCase();
  const row = sgfRowToNum(sgfCoord[1]);
  if (isNaN(row)) return 'pass';
  return `${colChar}${row}`;
}

/** GTP vertex → SGF coord */
export function gtpToSgf(gtp: string): string {
  if (!gtp || gtp === 'pass' || gtp.toLowerCase() === 'tt') return '';
  if (gtp.length < 2) return '';
  const colChar = gtp[0].toUpperCase();
  const row = parseInt(gtp.slice(1), 10);
  if (isNaN(row) || row < 1 || row > 19) return '';
  const col = sgfColToNum(colChar);
  if (col < 0 || col > 18) return '';
  return `${numToSgfCol(col)}${numToSgfRow(row).toLowerCase()}`;
}

/** Parse a raw SGF string into structured game data */
export function parseSgf(sgf: string): SgfGame {
  const game: SgfGame = { metadata: {}, moves: [] };
  let pos = 0;
  const len = sgf.length;

  // Skip whitespace and find the opening '('
  while (pos < len && /\s/.test(sgf[pos])) pos++;
  if (pos >= len || sgf[pos] !== '(') {
    throw new Error(`SGF: expected '(' at ${pos}, got '${sgf[pos]}'`);
  }
  pos++; // consume '('

  let isFirstNode = true;

  while (pos < len) {
    // Skip whitespace
    while (pos < len && /\s/.test(sgf[pos])) pos++;
    if (pos >= len) break;

    if (sgf[pos] === ')') {
      pos++; // consume ')' — end of root node
      continue;
    }

    if (sgf[pos] !== ';') {
      pos++; // skip unexpected char
      continue;
    }
    pos++; // consume ';'

    // Read all properties in this node
    const node: Record<string, string> = {};
    while (pos < len) {
      // Skip whitespace
      while (pos < len && /\s/.test(sgf[pos])) pos++;
      if (pos >= len) break;

      const ch = sgf[pos];
      // End of node: ';' or '(' or ')'
      if (ch === ';' || ch === '(' || ch === ')') break;

      // Property name: uppercase letters
      if (!/[A-Z]/.test(ch)) {
        pos++; // skip unknown char
        continue;
      }

      let name = '';
      while (pos < len && /[A-Z]/.test(sgf[pos])) {
        name += sgf[pos++];
      }
      if (!name) continue;

      // Property values: each is [...]
      const values: string[] = [];
      while (pos < len) {
        while (pos < len && /\s/.test(sgf[pos])) pos++;
        if (pos >= len || sgf[pos] !== '[') break;
        pos++; // consume '['
        let val = '';
        while (pos < len && sgf[pos] !== ']') {
          if (sgf[pos] === '\\' && pos + 1 < len) {
            pos++; // escape — skip backslash
            val += sgf[pos++];
          } else {
            val += sgf[pos++];
          }
        }
        if (pos < len && sgf[pos] === ']') pos++; // consume ']'
        values.push(val);
      }
      node[name] = values.join('');
    }

    // Process this node
    if (isFirstNode) {
      isFirstNode = false;
      game.metadata.size = node.SZ ? parseInt(node.SZ, 10) : 19;
      game.metadata.event = node.EV;
      game.metadata.round = node.RO;
      game.metadata.date = node.DT;
      game.metadata.playerBlack = node.PB;
      game.metadata.playerWhite = node.PW;
      game.metadata.blackRank = node.BR;
      game.metadata.whiteRank = node.WR;
      game.metadata.result = node.RE;
      game.metadata.rules = node.RU;
      game.metadata.komi = node.KM ? parseFloat(node.KM) : undefined;
      game.metadata.source = node.SO;
    } else {
      // Move node
      if (node.B !== undefined) {
        game.moves.push(sgfToGtp(node.B));
      } else if (node.W !== undefined) {
        game.moves.push(sgfToGtp(node.W));
      }
    }
  }

  return game;
}

/** Detect player names from a filename like "9ga-gokifu-20050125-Duan_Rong-Xu_Ying.sgf" */
export function extractPlayersFromFilename(filename: string): { black: string; white: string } {
  const base = filename.replace(/\.sgf$/i, '');
  const parts = base.split('-');
  if (parts.length >= 2) {
    return {
      black: parts[parts.length - 2].replace(/_/g, ' '),
      white: parts[parts.length - 1].replace(/_/g, ' '),
    };
  }
  return { black: 'Unknown', white: 'Unknown' };
}

