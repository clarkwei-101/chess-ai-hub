// DeepSeek V4 API Route — 连接 DGX Spark 本地部署
import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// DGX Spark DeepSeek V4 端点
const DEEPSEEK_BASE = process.env.DEEPSEEK_BASE_URL || 'http://192.168.1.193:8000';

export interface DeepSeekMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface DeepSeekRequest {
  messages: DeepSeekMessage[];
  model?: string;
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  stop?: string[];
}

export interface DeepSeekChoice {
  index: number;
  message: { role: string; content: string };
  finish_reason: string;
}

export interface DeepSeekResponse {
  id: string;
  model: string;
  choices: DeepSeekChoice[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  error?: { message: string; type: string };
}

// ============ 健康检查 ============
export async function GET() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(`${DEEPSEEK_BASE}/v1/models`, {
      signal: controller.signal,
      headers: { 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY || 'dummy'}` },
    });
    clearTimeout(timeout);

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    return NextResponse.json({
      ok: true,
      data: {
        connected: true,
        baseUrl: DEEPSEEK_BASE,
        models: data.data?.map((m: { id: string }) => m.id) || [],
      },
    });
  } catch (e: unknown) {
    const err = e instanceof Error ? e.message : String(e);
    return NextResponse.json({
      ok: true,
      data: { connected: false, baseUrl: DEEPSEEK_BASE, error: err },
    });
  }
}

// ============ Chat Completion ============
export async function POST(req: NextRequest) {
  try {
    const body: DeepSeekRequest = await req.json();
    const {
      messages,
      stream = false,
      temperature = 0.7,
      max_tokens = 2048,
      top_p = 0.95,
    } = body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return NextResponse.json({ ok: false, error: 'messages required' }, { status: 400 });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);

    const res = await fetch(`${DEEPSEEK_BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY || 'dummy'}`,
      },
      body: JSON.stringify({
        model: body.model || 'deepseek-v4',
        messages,
        stream,
        temperature,
        max_tokens,
        top_p,
        stop: body.stop,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      return NextResponse.json(
        { ok: false, error: errData.error?.message || `HTTP ${res.status}` },
        { status: res.status }
      );
    }

    if (stream) {
      // 流式 SSE
      const encoder = new TextEncoder();
      const stream2 = res.body!;
      return new Response(stream2, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
      });
    }

    const data: DeepSeekResponse = await res.json();
    return NextResponse.json({ ok: true, data });
  } catch (e: unknown) {
    const err = e instanceof Error ? e.message : String(e);
    if (err.includes('abort')) {
      return NextResponse.json({ ok: false, error: 'Request timeout (>120s)' }, { status: 504 });
    }
    return NextResponse.json({ ok: false, error: err }, { status: 500 });
  }
}
