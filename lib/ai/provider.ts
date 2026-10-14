/**
 * OpenAI-compatible streaming chat client (server only).
 *
 * 默认走 DeepSeek（便宜、中文好），也可通过环境变量切换任意
 * OpenAI 兼容服务：
 *   AI_PROVIDER=deepseek            # 默认
 *   DEEPSEEK_API_KEY=...            # 必填
 *   DEEPSEEK_BASE_URL=...           # 可选，默认 https://api.deepseek.com/v1
 *   DEEPSEEK_MODEL=...              # 可选，默认 deepseek-chat
 *
 *   AI_PROVIDER=mimo                # 示例：换服务
 *   MIMO_API_KEY / MIMO_BASE_URL / MIMO_MODEL
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

function getProviderConfig(): ProviderConfig {
  const provider = (process.env.AI_PROVIDER || 'deepseek').toLowerCase();
  if (provider === 'deepseek') {
    return {
      baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1',
      apiKey: process.env.DEEPSEEK_API_KEY || '',
      model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    };
  }
  const upper = provider.toUpperCase();
  return {
    baseUrl: process.env[`${upper}_BASE_URL`] || '',
    apiKey: process.env[`${upper}_API_KEY`] || '',
    model: process.env[`${upper}_MODEL`] || '',
  };
}

export function hasApiKey(): boolean {
  return getProviderConfig().apiKey.length > 0;
}

/**
 * 流式请求 chat completion，每收到一段文本就回调 onToken。
 * 上游用标准 OpenAI SSE 格式（data: {"choices":[{"delta":{"content":...}}]}）。
 */
export async function streamChatCompletion(
  messages: ChatMessage[],
  onToken: (text: string) => void,
  opts?: { temperature?: number; maxTokens?: number },
): Promise<void> {
  const cfg = getProviderConfig();
  if (!cfg.apiKey) {
    throw new Error('missing-api-key: 请配置 DEEPSEEK_API_KEY（或对应服务的 API Key）环境变量');
  }
  if (!cfg.baseUrl || !cfg.model) {
    throw new Error('bad-provider-config: 模型服务地址或模型名未配置');
  }

  const res = await fetch(`${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      temperature: opts?.temperature ?? 0.7,
      max_tokens: opts?.maxTokens ?? 4000,
      stream: true,
    }),
  });

  if (!res.ok || !res.body) {
    const bodyText = await res.text().catch(() => '');
    throw new Error(`llm-request-failed: HTTP ${res.status} ${bodyText.slice(0, 200)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') return;
      try {
        const json = JSON.parse(data);
        const delta: string = json.choices?.[0]?.delta?.content ?? '';
        if (delta) onToken(delta);
      } catch {
        /* 跳过残缺的 SSE 行 */
      }
    }
  }
}
