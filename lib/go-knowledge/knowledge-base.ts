// Go 知识库 — Obsidian 风格结构化知识库
// 包含中/韩/日各 10 名顶尖棋手
// 路径: go-knowledge/{country}/{category}/player-name.md

import * as fs from 'fs';
import * as path from 'path';

export const KNOWLEDGE_BASE_DIR = path.resolve(process.cwd(), 'go-knowledge');

// ============ 类型定义 ============

export interface GoPlayer {
  id: string;
  name: string;
  nameCn: string;
  country: 'chinese' | 'korean' | 'japanese';
  birthYear: number;
  activeYears: string;
  rank: string; // 九段 / 九品 等
  style: string; // 棋风描述
  achievements: string[];
  keyStrategies: string[]; // 主要战略
  famousOpenings: string[]; // 擅长定式
  famousGames: GameRecord[];
  quotes: string[];
  personality: string; // 性格特点
  strengths: string[];
  weaknesses: string[];
}

export interface GameRecord {
  year: number;
  opponent: string;
  result: 'W' | 'B' | 'Draw';
  opening: string;
  highlight: string;
  sgfUrl?: string;
}

export interface StrategyEntry {
  playerId: string;
  name: string;
  description: string;
  examples: string[];
  difficulty: '入门' | '进阶' | '高级' | '大师';
  suitableFor: string[];
}

export interface OpeningEntry {
  name: string;
  playerId: string;
  variation: string;
  description: string;
  typicalMove: string[];
  evaluation: string;
}

// ============ 知识库读取工具 ============

/** 读取目录下所有 .md 文件 */
function readMdFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const raw = fs.readFileSync(path.join(dir, f), 'utf-8');
      return raw;
    });
}

/** 解析单个棋手 .md 文件 */
function parsePlayerFile(raw: string): Partial<GoPlayer> {
  const lines = raw.split('\n');
  const meta: Record<string, string> = {};
  let inFrontmatter = false;
  let frontmatterContent = '';
  let bodyLines: string[] = [];

  for (const line of lines) {
    if (line === '---') {
      if (!inFrontmatter) { inFrontmatter = true; continue; }
      else { inFrontmatter = false; continue; }
    }
    if (inFrontmatter) {
      frontmatterContent += line + '\n';
    } else {
      bodyLines.push(line);
    }
  }

  // 解析 frontmatter
  for (const line of frontmatterContent.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      const val = line.slice(colonIdx + 1).trim();
      meta[key] = val;
    }
  }

  const body = bodyLines.join('\n').trim();

  // 提取 ## 章节
  const sections: Record<string, string> = {};
  let currentSection = '_default';
  const sectionLines: string[] = [];
  for (const line of body.split('\n')) {
    const match = line.match(/^## (.+)/);
    if (match) {
      if (sectionLines.length) sections[currentSection] = sectionLines.join('\n').trim();
      currentSection = match[1].trim();
      sectionLines.length = 0;
    } else {
      sectionLines.push(line);
    }
  }
  if (sectionLines.length) sections[currentSection] = sectionLines.join('\n').trim();

  return {
    id: meta.id || '',
    name: meta.name || '',
    nameCn: meta.nameCn || meta.name || '',
    country: (meta.country as GoPlayer['country']) || 'japanese',
    birthYear: parseInt(meta.birthYear) || 0,
    activeYears: meta.activeYears || '',
    rank: meta.rank || '',
    style: sections['棋风'] || sections['Style'] || '',
    achievements: sections['主要成就']?.split('\n').filter(Boolean) || [],
    keyStrategies: sections['核心战略']?.split('\n').filter(Boolean) || [],
    famousOpenings: sections['擅长定式']?.split('\n').filter(Boolean) || [],
    quotes: sections['经典语录']?.split('\n').filter(Boolean).map((q) => q.replace(/^[-*]\s*/, '')) || [],
    personality: sections['性格特点'] || '',
    strengths: sections['优势']?.split('\n').filter(Boolean) || [],
    weaknesses: sections['劣势']?.split('\n').filter(Boolean) || [],
    famousGames: [],
  };
}

/** 获取所有棋手列表 */
export function getAllPlayers(): GoPlayer[] {
  const countries: GoPlayer['country'][] = ['chinese', 'korean', 'japanese'];
  const all: GoPlayer[] = [];

  for (const country of countries) {
    const profilesDir = path.join(KNOWLEDGE_BASE_DIR, country, 'profiles');
    const files = readMdFiles(profilesDir);
    for (const raw of files) {
      const parsed = parsePlayerFile(raw);
      if (parsed.id) all.push(parsed as GoPlayer);
    }
  }
  return all;
}

/** 按 ID 获取棋手 */
export function getPlayer(id: string): GoPlayer | null {
  const all = getAllPlayers();
  return all.find((p) => p.id === id) || null;
}

/** 按国家获取棋手 */
export function getPlayersByCountry(country: GoPlayer['country']): GoPlayer[] {
  return getAllPlayers().filter((p) => p.country === country);
}

/** 语义检索 — 基于关键词匹配 */
export function searchKnowledge(query: string, topK = 5): Array<{ player: GoPlayer; score: number; matchField: string }> {
  const q = query.toLowerCase();
  const keywords = q.split(/\s+/).filter(Boolean);
  const all = getAllPlayers();
  const results: Array<{ player: GoPlayer; score: number; matchField: string }> = [];

  for (const player of all) {
    let bestScore = 0;
    let bestField = '';

    const fields: Array<[string, string]> = [
      ['name', player.name],
      ['nameCn', player.nameCn],
      ['style', player.style],
      ['personality', player.personality],
      ['achievements', player.achievements.join(' ')],
      ['strategies', player.keyStrategies.join(' ')],
      ['openings', player.famousOpenings.join(' ')],
      ['quotes', player.quotes.join(' ')],
      ['strengths', player.strengths.join(' ')],
      ['weaknesses', player.weaknesses.join(' ')],
    ];

    for (const [field, content] of fields) {
      const c = content.toLowerCase();
      let score = 0;
      for (const kw of keywords) {
        if (c.includes(kw)) score++;
        if (player.name.toLowerCase().includes(kw)) score += 3;
        if (field === 'name' && c.includes(kw)) score += 5;
      }
      if (score > bestScore) {
        bestScore = score;
        bestField = field;
      }
    }

    if (bestScore > 0) {
      results.push({ player, score: bestScore, matchField: bestField });
    }
  }

  return results.sort((a, b) => b.score - a.score).slice(0, topK);
}

/** 构建 RAG context — 拼接检索结果为 prompt 片段 */
export function buildRagContext(query: string, topK = 5): string {
  const results = searchKnowledge(query, topK);
  if (!results.length) return '';

  let ctx = '## 参考知识库（围棋大师风格/战略）\n\n';
  for (const { player, score, matchField } of results) {
    ctx += `### ${player.nameCn}（${player.name}）[${player.country === 'chinese' ? '🇨🇳中国' : player.country === 'korean' ? '🇰🇷韩国' : '🇯🇵日本'}]\n`;
    ctx += `- 棋风: ${player.style}\n`;
    ctx += `- 核心战略: ${player.keyStrategies.join('；')}\n`;
    ctx += `- 擅长定式: ${player.famousOpenings.join('；')}\n`;
    if (player.personality) ctx += `- 性格: ${player.personality}\n`;
    if (player.quotes.length) ctx += `- 经典语录: "${player.quotes[0]}"\n`;
    ctx += `\n`;
  }
  return ctx;
}

/** 获取所有棋手 ID 列表（用于选择） */
export function listPlayerIds(): Array<{ id: string; name: string; nameCn: string; country: string }> {
  return getAllPlayers().map((p) => ({
    id: p.id,
    name: p.name,
    nameCn: p.nameCn,
    country: p.country,
  }));
}
