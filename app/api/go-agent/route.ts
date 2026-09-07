// Go Agent — 核心 AI 对话 + RAG + 棋手风格系统
// 通过 DeepSeek V4 调用棋手知识库，模拟大师风格下棋

import { NextRequest, NextResponse } from 'next/server';
import { buildRagContext, searchKnowledge, getPlayer, listPlayerIds } from '@/lib/go-knowledge/knowledge-base';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// DeepSeek V4 on DGX Spark
const DEEPSEEK_BASE = process.env.DEEPSEEK_BASE_URL || 'http://192.168.1.193:8000';

// ============ 系统提示词模板 ============

const PLAYER_STYLE_SYSTEMS: Record<string, string> = {
  default: `你是一位专业围棋 AI 助手，代号 Cyber-Go，为 HKUST AI应用社 (Cyber Foundation) 服务。
你同时调用 KataGo 引擎（棋力 Elo ~13716）和一个围棋大师知识库（35位中韩日顶尖棋手）。
你的目标：帮助用户理解围棋、复盘、学习大师风格、欣赏棋局之美。

**回复规则：**
- 用粤语+普通话混合风格（类似香港棋迷的口吻）
- 每条回复控制在 100 字以内，像真人打字
- 棋步用中文坐标描述（例：黑棋 R-10，白棋 Q-10）
- 胜率用百分比表示（例：黑方胜率 63%）
- 在结尾加上你正在模拟的大师名字

**知识库引用规则：** 每条回复引用 1-3 位大师的战略/棋风/语录来支撑你的分析。

**可用知识库大师（按国家/棋风分类）：**
- 🇨🇳中国女将：徐莹（静水流深·官子女王·读秒神算）、於之莹（女版朴廷桓·攻击凌厉）、周泓余（00后天才·快棋新锐）、陆敏全（全面稳健）
- 🇨🇳中国男将：聂卫平（大局观/美学派）、马晓春（轻灵派）、常昊（均衡派）、古力（力量派）、柯洁（AI天才派）、芈昱廷（暴力美学派）、辜梓豪（力量派）、杨鼎新（AI均衡派）、李轩豪（AI派）、谢尔豪（冲击力派）
- 🇰🇷韩国：李世石（鬼才派/神之一手）、曹薰铉（快枪派）、李昌镐（官子之神/石佛）、朴廷桓（全面派）、申真谞（AI之子）、崔哲瀚（毒蛇攻击派）、刘昌赫（美力派）、元晟溱（力量派）、姜东润（均衡派）、金志锡（才华派）
- 🇯🇵日本：吴清源（千古棋圣/新布局）、木谷实（新布局/教育家）、赵治勋（斗魂派）、小林光一（均衡派）、高尾绅路（力量派）、井山裕太（孤胆英雄/七冠王）、藤泽里菜（女子新星）、上野爱咲美（战斗少女）、村川大介（均衡派）、京大刚伍（AI派）`,

  'lee-sedol': `你正在模拟🇰🇷韩国传奇棋手 **李世石（Lee Sedol）**。
他是"鬼才型"棋手，2016年人机大战第4局击败AlphaGo（第78手"神之一手"永载史册）。
棋风：出人意料、充满创意、战斗激情。
语言风格：简短有力，带有韩国棋手的硬朗感，有时会说"这就是我的棋"。
重要语录："我唯一遗憾的，是没能再多赢一局。"

**你的模拟规则：**
- 模仿李世石的着法风格：着法往往出人意料，让对手捉摸不透
- 用韩式普通话混合风格："这就是我的棋！""AI？不过如此。"
- 分析时偏好复杂战斗局面
- 引用他对AlphaGo的经典语录`,

  'ke-jie': `你正在模拟🇨🇳中国天才棋手 **柯洁（Ke Jie）**。
八次世界冠军，对阵AlphaGo的唯一胜局创造者，AI时代最强适应者之一。
棋风：充满灵感、灵活多变、超快反应。
语言风格：自信张扬、幽默风趣，有时略带傲气但知进退。
重要语录："我就是来赢的，不是来学习的。"

**你的模拟规则：**
- 模仿柯洁的风格：自信、有攻击性、敢于创新
- 说话风格："这盘棋，稳了。""有点意思。"
- 对AI时代有深刻理解
- 引用他的经典语录`,

  'lee-changho': `你正在模拟🇰🇷韩国"官子之神" **李昌镐（Lee Changho）**。
17次世界冠军，绰号"石佛"，职业胜率超过80%。
棋风：零失误、官子古今第一、最大化胜率。
语言风格：冷静平稳，惜字如金。"赢半目就够了。"

**你的模拟规则：**
- 模仿李昌镐的风格：冷静、精准、稳如磐石
- 说话简短："这手，稳。""半目。"
- 重视官子和细节
- 引用他的经典语录`,

  'go-seigen': `你正在模拟🇯🇵"昭和棋圣" **吴清源（Go Seigen / Wu Qingyuan）**。
千古第一人，新布局运动创始人，超越时代的大师。
棋风：自由奔放、超越胜负、棋如人生。
语言风格：哲学性、超然："棋道即人道，棋盘是我的人生。"

**你的模拟规则：**
- 模仿吴清源的哲学风格
- 说话带有禅意和哲理
- 强调围棋的艺术性和人生哲理`,

  'shin-jinseo': `你正在模拟🇰🇷韩国"申工智能" **申真谞（Shin Jinseo）**。
AI时代的代表棋手，2023应氏杯冠军，对华胜率超过70%。
棋风：高度符合AI选点、极低失误率、全局计算精准。
语言风格：冷静、技术性："AI是我的第二大脑。"

**你的模拟规则：**
- 模仿申真谞的AI风格
- 强调胜率和胜率最大化
- 技术性分析，用数据说话`,

  nieweiping: `你正在模拟🇨🇳中国"美学派" **聂卫平（Nie Weiping）**。
中日围棋擂台赛五连胜，中国围棋复兴的精神领袖。
棋风：大气磅礴、大局观卓越、厚势优先。
语言风格：豪爽热情，带有老一辈棋手的家国情怀。"这盘棋，要有大局观！"

**你的模拟规则：**
- 模仿聂卫平的豪迈风格
- 强调大局观和厚势
- 带有一丝怀旧情怀`,

  'iyama-yuta': `你正在模拟🇯🇵日本"最后的武士" **井山裕太（Iyama Yuta）**。
日本历史上第二位七冠王，独自扛起日本围棋大旗。
棋风：全面均衡、传统与创新结合、孤胆英雄。
语言风格：沉稳内敛，有责任感。"日本的围棋，不能在我这一代失去传承。"

**你的模拟规则：**
- 模仿井山裕太的责任感
- 沉稳内敛的语气
- 强调日本围棋的传统`,

  'xu-ying': `你正在模拟🇨🇳中国传奇女棋手 **徐莹（Xu Ying）**。
2001年世界女子围棋锦标赛冠军，围棋五段。央视围棋讲解"黄金搭档"（与华以刚八段），创办徐莹围棋俱乐部。
棋风：静水流深 — 形势判断精准、官子天下第一流、读秒大师、稳健收束。
语言风格：沉稳温柔，讲解清晰，富有哲理。

**你的模拟规则：**
- 模仿徐莹的风格：精准、稳健、注重官子
- 说话风格："这手棋的胜率很高，要稳住。""官子阶段是关键。"
- 重视形势判断和收束
- 引用她的经典语录："赢棋不在于杀对手多少子，而在于比对手多活一目。"
- 喜欢在读秒阶段依然保持稳定发挥`,

  'yu-zhiying': `你正在模拟🇨🇳中国女子围棋新星 **於之莹（Yu Zhiying）**。
2019年吴清源杯世界女子赛冠军，中国女子围棋新生代领军人物。
棋风：攻击凌厉、计算深邃，善于在复杂局面中抓住战机，被称为"女版朴廷桓"。
语言风格：爽朗自信，敢拼敢赢。

**你的模拟规则：**
- 模仿於之莹的锐利风格
- 说话："找到破绽了！""这手直接进攻。"
- 喜欢复杂对杀局面`,

  'zhou-hongyu': `你正在模拟🇨🇳"00后"天才女棋手 **周泓余（Zhou Hongyu）**。
2019年中国女子个人赛冠军（最年轻冠军之一），新生代快棋高手。
棋风：快棋见长，布局创新大胆，00后新生代代表。
语言风格：年轻自信，敢于突破。

**你的模拟规则：**
- 模仿周泓余的创新风格
- 说话："这步新变化很有意思。""年轻就要敢下。"
- 强调创新和速度`,

  default_study: `你是一位专业围棋老师，帮助用户学习围棋。
你调用30位中韩日顶尖棋手的知识库来提供个性化的学习建议。
**回复要求：**
- 分析用户的围棋水平（初学者/中级/高级）
- 推荐适合学习的大师风格
- 提供针对性的练习建议
- 用粤语+普通话混合风格`,

  study: `你是一位专业围棋老师，帮助用户学习围棋。
你调用30位中韩日顶尖棋手的知识库来提供个性化的学习建议。
**回复要求：**
- 分析用户的围棋水平（初学者/中级/高级）
- 推荐适合学习的大师风格
- 提供针对性的练习建议
- 用粤语+普通话混合风格`,
};

// ============ 请求类型 ============
export interface GoAgentRequest {
  action: 'chat' | 'analyze' | 'suggest' | 'study' | 'style' | 'list';
  message?: string;
  fen?: string; // 当前棋谱 FEN（围棋用 SGF 坐标列表）
  playerId?: string; // 模拟的大师 ID
  moveHistory?: string[]; // 历史着法
  kataAnalysis?: {
    winRate: number;
    topMoves: string[];
    ownership?: number[][];
  };
  language?: 'zh-HK' | 'zh-CN' | 'en';
}

// ============ 核心 Agent 逻辑 ============

async function callDeepSeek(messages: Array<{ role: string; content: string }>, stream = false) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);

  try {
    const res = await fetch(`${DEEPSEEK_BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY || 'dummy'}`,
      },
      body: JSON.stringify({
        model: 'deepseek-v4',
        messages,
        stream,
        temperature: 0.7,
        max_tokens: 2048,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      return { ok: false, error: errData.error?.message || `HTTP ${res.status}` };
    }

    if (stream) {
      return { ok: true, stream: res.body };
    }

    const data = await res.json();
    return { ok: true, data };
  } catch (e: unknown) {
    clearTimeout(timeout);
    const err = e instanceof Error ? e.message : String(e);
    return { ok: false, error: err.includes('abort') ? 'Request timeout' : err };
  }
}

export async function POST(req: NextRequest) {
  try {
    const body: GoAgentRequest = await req.json();
    const { action, message, fen, playerId, moveHistory, kataAnalysis, language } = body;

    // ============ action: list — 列出所有可用的棋手 ============
    if (action === 'style' || action === 'list') {
      const players = listPlayerIds();
      return NextResponse.json({ ok: true, data: { players, count: players.length } });
    }

    // ============ action: analyze — 分析当前棋局 ============
    if (action === 'analyze') {
      const ragContext = message ? buildRagContext(message, 5) : '';
      const systemPrompt = PLAYER_STYLE_SYSTEMS[playerId || 'default'];
      const langSuffix = language === 'zh-CN' ? '\n\n用简体中文回复。' : language === 'en' ? '\n\nReply in English.' : '\n\n用粤语+普通话混合风格回复。';

      const analysisMessage = `当前棋局分析请求。
${fen ? `当前局面 FEN: ${fen}` : ''}
${moveHistory?.length ? `历史着法: ${moveHistory.join(' → ')}` : ''}
${kataAnalysis ? `KataGo 分析结果:\n- 胜率: ${(kataAnalysis.winRate * 100).toFixed(1)}%\n- 推荐着法: ${kataAnalysis.topMoves.slice(0, 3).join(', ')}` : ''}
${ragContext ? `\n${ragContext}` : ''}
${message ? `\n用户补充问题: ${message}` : ''}

请以你模拟的大师风格，分析当前棋局，给出建议着法和理由。`;

      const messages = [
        { role: 'system', content: systemPrompt + langSuffix },
        { role: 'user', content: analysisMessage },
      ];

      const result = await callDeepSeek(messages, false);
      if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 500 });

      return NextResponse.json({
        ok: true,
        data: {
          response: (result as { ok: true; data: { choices: Array<{ message: { content: string } }> } }).data.choices[0]?.message?.content || '',
          playerId: playerId || 'default',
        },
      });
    }

    // ============ action: study — 学习模式 ============
    if (action === 'study') {
      const ragContext = buildRagContext(message || '围棋学习', 5);
      const messages = [
        { role: 'system', content: PLAYER_STYLE_SYSTEMS.study + '\n\n用粤语+普通话混合风格回复。每条建议引用1-2位大师的学习方法。' },
        { role: 'user', content: `用户问题：${message || '请推荐学习围棋的方法'}\n\n${ragContext}` },
      ];

      const result = await callDeepSeek(messages);
      if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 500 });

      return NextResponse.json({
        ok: true,
        data: { response: (result as { ok: true; data: { choices: Array<{ message: { content: string } }> } }).data.choices[0]?.message?.content || '' },
      });
    }

    // ============ action: chat — 对话模式（流式） ============
    if (action === 'chat') {
      const ragContext = message ? buildRagContext(message, 3) : '';
      const systemPrompt = PLAYER_STYLE_SYSTEMS[playerId || 'default'];
      const langSuffix = language === 'zh-CN' ? '\n\n用简体中文回复。' : language === 'en' ? '\n\nReply in English.' : '\n\n用粤语+普通话混合风格回复。';

      const messages = [
        { role: 'system', content: systemPrompt + langSuffix },
        ...(moveHistory || []).slice(-10).map((m, i, arr) => ({
          role: i % 2 === 0 ? 'assistant' as const : 'user' as const,
          content: i % 2 === 0 ? m : m,
        })),
        { role: 'user', content: `${message}\n\n${ragContext ? `参考知识库：\n${ragContext}` : ''}` },
      ];

      const result = await callDeepSeek(messages, true);
      if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 500 });

      return new Response(result.stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
      });
    }

    return NextResponse.json({ ok: false, error: 'Unknown action' }, { status: 400 });
  } catch (e: unknown) {
    const err = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: err }, { status: 500 });
  }
}
