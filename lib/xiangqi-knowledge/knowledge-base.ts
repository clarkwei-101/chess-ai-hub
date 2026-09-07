// 中国象棋知识库 — Obsidian 风格结构化知识库
// 包含中国顶尖象棋大师
// 路径: xiangqi-knowledge/{country}/player-name.md

import * as fs from 'fs';
import * as path from 'path';

export const XQ_KNOWLEDGE_BASE_DIR = path.resolve(process.cwd(), 'xiangqi-knowledge');

// ============ 类型定义 ============

export interface XqPlayer {
  id: string;
  name: string;
  nameCn: string;
  country: string;
  gender?: string;
  birthYear: number;
  activeYears: string;
  rank: string;
  title?: string;
  style: string;
  achievements: string[];
  keyStrategies: string[];
  famousOpenings: string[];
  quotes: string[];
  personality: string;
  strengths: string[];
  weaknesses: string[];
}

// ============ 知识库读取工具 ============

function readMdFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const raw = fs.readFileSync(path.join(dir, f), 'utf-8');
      return raw;
    });
}

function parseXqPlayerFile(raw: string): Partial<XqPlayer> {
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

  for (const line of frontmatterContent.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      const val = line.slice(colonIdx + 1).trim();
      meta[key] = val;
    }
  }

  const body = bodyLines.join('\n').trim();

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
    country: meta.country || 'chinese',
    gender: meta.gender,
    birthYear: parseInt(meta.birthYear) || 0,
    activeYears: meta.activeYears || '',
    rank: meta.rank || '',
    title: meta.title,
    style: sections['棋风'] || '',
    achievements: sections['主要成就']?.split('\n').filter(Boolean) || [],
    keyStrategies: sections['核心战略']?.split('\n').filter(Boolean) || [],
    famousOpenings: sections['擅长布局']?.split('\n').filter(Boolean) || [],
    quotes: sections['经典语录']?.split('\n').filter(Boolean).map((q) => q.replace(/^[-*]\s*/, '')) || [],
    personality: sections['性格特点'] || '',
    strengths: sections['优势']?.split('\n').filter(Boolean) || [],
    weaknesses: sections['劣势']?.split('\n').filter(Boolean) || [],
  };
}

export function getAllXqPlayers(): XqPlayer[] {
  const kbDir = XQ_KNOWLEDGE_BASE_DIR;
  if (!fs.existsSync(kbDir)) return [];
  const countries = fs.readdirSync(kbDir).filter((d) =>
    fs.statSync(path.join(kbDir, d)).isDirectory()
  );
  const all: XqPlayer[] = [];
  for (const country of countries) {
    const profilesDir = path.join(kbDir, country);
    const files = readMdFiles(profilesDir);
    for (const raw of files) {
      const parsed = parseXqPlayerFile(raw);
      if (parsed.id) all.push(parsed as XqPlayer);
    }
  }
  return all;
}

export function getXqPlayer(id: string): XqPlayer | null {
  return getAllXqPlayers().find((p) => p.id === id) || null;
}

export function searchXqKnowledge(query: string, topK = 5): Array<{ player: XqPlayer; score: number; matchField: string }> {
  const q = query.toLowerCase();
  const keywords = q.split(/\s+/).filter(Boolean);
  const all = getAllXqPlayers();
  const results: Array<{ player: XqPlayer; score: number; matchField: string }> = [];

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

export function buildXqRagContext(query: string, topK = 5): string {
  const results = searchXqKnowledge(query, topK);
  if (!results.length) return '';

  let ctx = '## 参考知识库（象棋大师风格/战略）\n\n';
  for (const { player, score, matchField } of results) {
    ctx += `### ${player.nameCn}（${player.name}）${player.title ? `[${player.title}]` : ''}\n`;
    ctx += `- 棋风: ${player.style}\n`;
    ctx += `- 核心战略: ${player.keyStrategies.join('；')}\n`;
    ctx += `- 擅长布局: ${player.famousOpenings.join('；')}\n`;
    if (player.personality) ctx += `- 性格: ${player.personality}\n`;
    if (player.quotes.length) ctx += `- 经典语录: "${player.quotes[0]}"\n`;
    ctx += `\n`;
  }
  return ctx;
}

export function listXqPlayerIds(): Array<{ id: string; name: string; nameCn: string; country: string; gender?: string }> {
  return getAllXqPlayers().map((p) => ({
    id: p.id,
    name: p.name,
    nameCn: p.nameCn,
    country: p.country,
    gender: p.gender,
  }));
}
