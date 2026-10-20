/**
 * OpenAI 兼容协议基座（ADR-0005）
 * DeepSeek/GLM/Kimi/MiniMax/混元/自定义均兼容 OpenAI Chat Completions 协议，
 * 仅 base URL 与 model 名不同，统一复用此实现。
 */
import type { ChatStreamRequest, ChatCompletion, ChatMessage, Delta } from '@wdbuddy/shared-types';
import type { ModelProvider } from '../types.js';

export interface OpenAiCompatOptions {
  id: ModelProvider['id'];
  displayName: string;
  baseUrl: string;
  apiModel: string;
}

/** 解析 OpenAI SSE data 行为 Delta */
export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): AsyncIterable<Delta> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') return;
        try {
          const json = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: string } }>;
          };
          const text = json.choices?.[0]?.delta?.content;
          if (text) yield { type: 'text', text };
        } catch {
          /* 忽略无法解析的心跳行 */
        }
      }
    }
  } finally {
    reader.releaseLock();
    if (signal?.aborted) reader.cancel().catch(() => undefined);
  }
}

/** 按 base64 头部魔数推断图片 MIME（旧实现恒为 image/png，
 *  把 jpg/webp 错标成 png 会让部分视觉端点直接拒收） */
export function inferImageMime(base64Payload: string): string {
  const head = base64Payload.slice(0, 24);
  if (head.startsWith('/9j/')) return 'image/jpeg';
  if (head.startsWith('iVBORw0KGgo')) return 'image/png';
  if (head.startsWith('R0lGOD')) return 'image/gif';
  if (head.startsWith('UklGR')) return 'image/webp';
  if (head.startsWith('Qk')) return 'image/bmp';
  return 'image/png';
}

/** 组装多模态消息：含 images 的 ChatMessage → OpenAI 多部分 content 数组。
 *  纯文本消息原样透传（现有调用方零影响）；图片统一转 base64 data URL */
export function buildApiMessages(
  messages: ChatMessage[]
): Array<Record<string, unknown>> {
  return messages.map((m) => {
    if (!m.images || m.images.length === 0 || m.role === 'assistant') {
      return { role: m.role, content: m.content };
    }
    // 多模态 user 消息：[{type:'text'},{type:'image_url'}...]（OpenAI 协议）
    const parts: Array<Record<string, unknown>> = [
      { type: 'text', text: m.content },
    ];
    for (const img of m.images) {
      let url: string;
      if (/^[a-z]+:\/\//i.test(img) || img.startsWith('data:')) {
        url = img;
      } else {
        const mime = inferImageMime(img);
        url = `data:${mime};base64,${img}`;
      }
      parts.push({ type: 'image_url', image_url: { url } });
    }
    return { role: m.role, content: parts };
  });
}

/** 创建 OpenAI 兼容 Provider */
export function createOpenAiCompatProvider(opts: OpenAiCompatOptions): ModelProvider {
  return {
    id: opts.id,
    displayName: opts.displayName,
    baseUrl: opts.baseUrl,
    apiModel: opts.apiModel,

    async *chatStream(req: ChatStreamRequest, apiKey: string): AsyncIterable<Delta> {
      const res = await fetch(`${opts.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: opts.apiModel,
          messages: buildApiMessages(req.messages),
          max_tokens: req.maxTokens,
          temperature: req.temperature,
          stream: true,
        }),
        signal: req.signal,
      });
      if (!res.ok || !res.body) {
        throw new Error(`[model-gateway] ${opts.displayName} HTTP ${res.status}: ${await res.text()}`);
      }
      yield* parseSseStream(res.body, req.signal);
    },

    async chat(req: ChatStreamRequest, apiKey: string): Promise<ChatCompletion> {
      const res = await fetch(`${opts.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: opts.apiModel,
          messages: buildApiMessages(req.messages),
          max_tokens: req.maxTokens,
          temperature: req.temperature,
        }),
        signal: req.signal,
      });
      if (!res.ok) {
        throw new Error(`[model-gateway] ${opts.displayName} HTTP ${res.status}: ${await res.text()}`);
      }
      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      return {
        content: json.choices?.[0]?.message?.content ?? '',
        usage: {
          promptTokens: json.usage?.prompt_tokens ?? 0,
          completionTokens: json.usage?.completion_tokens ?? 0,
        },
        model: opts.apiModel,
      };
    },
  };
}
