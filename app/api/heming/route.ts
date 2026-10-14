/**
 * POST /api/heming —— AI 合盘解读（流式 SSE）
 *
 * 请求体：{ chartA: ZiweiChart, chartB: ZiweiChart, question?: string }
 * 响应：text/event-stream，每行 `data: {"delta":{"text":"..."}}`，以 `data: [DONE]` 结束。
 * 前端 app/heming/page.tsx 已按此契约消费。
 */

import { NextRequest } from 'next/server';
import { streamChatCompletion, hasApiKey } from '@/lib/ai/provider';
import { pairFacts, buildHemingSystemPrompt } from '@/lib/ai/chartFacts';
import type { ZiweiChart } from '@/lib/ziwei/types';

export const runtime = 'nodejs';
export const maxDuration = 180;

interface HemingBody {
  chartA?: ZiweiChart;
  chartB?: ZiweiChart;
  question?: string;
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as HemingBody | null;
  const { chartA, chartB, question } = body ?? {};

  if (!chartA || !chartB) {
    return Response.json({ error: 'bad-request: 需要 chartA 与 chartB' }, { status: 400 });
  }

  if (!hasApiKey()) {
    return Response.json(
      { error: 'missing-api-key: 请配置 DEEPSEEK_API_KEY 环境变量后重新部署' },
      { status: 404 },
    );
  }

  let facts: string;
  try {
    facts = pairFacts(chartA, chartB);
  } catch (e) {
    return Response.json(
      { error: `bad-chart: 命盘数据无法解析 (${e instanceof Error ? e.message : e})` },
      { status: 400 },
    );
  }

  const system = buildHemingSystemPrompt(facts);
  const userContent = question?.trim()
    ? `请重点围绕这个问题做合盘解读：${question.slice(0, 500)}`
    : '请按解读框架给出完整的合盘分析。';

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (t: string) =>
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ delta: { text: t } })}\n\n`));
      try {
        await streamChatCompletion(
          [
            { role: 'system', content: system },
            { role: 'user', content: userContent },
          ],
          send,
          { temperature: 0.7, maxTokens: 4000 },
        );
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
