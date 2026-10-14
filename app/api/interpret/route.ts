/**
 * POST /api/interpret —— AI 命盘解读（流式 SSE）
 *
 * 请求体：{ chart: ZiweiChart, messages: [{ role: 'user'|'assistant', content }] }
 * 响应：text/event-stream，每行 `data: {"delta":{"text":"..."}}`，以 `data: [DONE]` 结束。
 * 前端 ChatPanel / InsightPanel 已按此契约消费。
 */

import { NextRequest } from 'next/server';
import { streamChatCompletion, hasApiKey } from '@/lib/ai/provider';
import { chartToFacts, buildInterpretSystemPrompt } from '@/lib/ai/chartFacts';
import type { ZiweiChart } from '@/lib/ziwei/types';

export const runtime = 'nodejs';
export const maxDuration = 120;

interface InterpretBody {
  chart?: ZiweiChart;
  messages?: { role: 'user' | 'assistant'; content: string }[];
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as InterpretBody | null;
  const chart = body?.chart;
  const messages = body?.messages;

  if (!chart || !Array.isArray(messages) || messages.length === 0) {
    return Response.json({ error: 'bad-request: 需要 chart 与 messages' }, { status: 400 });
  }

  if (!hasApiKey()) {
    // 前端把 404 理解为"接口未实现"；无 Key 时同样走这个语义，
    // 用户看到的提示会引导去配置 API Key。
    return Response.json(
      { error: 'missing-api-key: 请配置 DEEPSEEK_API_KEY 环境变量后重新部署' },
      { status: 404 },
    );
  }

  let facts: string;
  try {
    facts = chartToFacts(chart);
  } catch (e) {
    return Response.json(
      { error: `bad-chart: 命盘数据无法解析 (${e instanceof Error ? e.message : e})` },
      { status: 400 },
    );
  }

  const system = buildInterpretSystemPrompt(facts);
  const llmMessages = [
    { role: 'system' as const, content: system },
    ...messages.slice(-12).map((m) => ({
      role: m.role === 'assistant' ? ('assistant' as const) : ('user' as const),
      content: String(m.content).slice(0, 4000),
    })),
  ];

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (t: string) =>
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ delta: { text: t } })}\n\n`));
      try {
        await streamChatCompletion(llmMessages, send, { temperature: 0.7, maxTokens: 4000 });
      } catch (e) {
        const msg = e instanceof Error ? e.message : '未知错误';
        send(`\n\n（解读中断：${msg}，请检查 API Key 与网络后重试）`);
      }
      controller.enqueue(enc.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
