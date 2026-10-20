/**
 * VisionClient — 视觉旁路客户端（对齐 WDClaude vision_client）
 *
 * 旧实现（vision-provider.ts 的 visionChat）有三个硬伤，直接导致"WDBuddy 读图
 * 效果很差"：
 * 1. **形态不兼容**：只发 data URL。智谱 GLM 系列的部分网关只吃裸 base64，
 *    收到 data URL 会返回 400，而旧代码直接把 400 抛给上层，用户只看到
 *    "HTTP 400: invalid image"，完全不知道是格式问题。
 * 2. **零重试**：网络抖动/模型偶发空响应直接失败，任务卡死。
 * 3. **无超时**：模型挂起时整个 Runtime 步骤无限等待（心跳还在，用户只能干等）。
 *
 * 新实现：
 * - 双形态发送：默认 data URL，命中"图片格式/解码"类 400 时自动改用裸 base64
 *   重试一次（同一请求内完成，不浪费时间）；
 * - 重试 2 次 + 指数退避 + AbortSignal 超时；
 * - 错误信息聚合：状态码 + 响应体前 300 字符 + 已尝试形态 + 模型名，让用户/主
 *   模型能直接定位问题（模型不支持视觉 / Key 无效 / 图片过大）。
 */
import type { ChatMessage } from '@wdbuddy/shared-types';

export interface VisionConfig {
  /** 兼容端点，如 https://open.bigmodel.cn/api/paas/v4 */
  baseUrl: string;
  /** 视觉模型名，如 glm-4v-plus / gpt-4o / qwen-vl-plus */
  apiModel: string;
  /** API Key */
  apiKey: string;
  /** 图片传输形态：data_url（默认）| raw（裸 base64，部分 GLM 网关要求） */
  base64Mode?: 'data_url' | 'raw';
  /** 细节档位（OpenAI 协议支持 low/high/auto；不支持的端点会忽略该字段） */
  detail?: 'low' | 'high' | 'auto';
  /** 超时（毫秒），默认 120s */
  timeoutMs?: number;
  /** 最大重试次数，默认 2 */
  retries?: number;
}

export interface VisionCallOptions {
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_RETRIES = 2;

/** 命中这些关键词的 400，判定为"图片载荷形态不被接受"，切换 base64 形态重试 */
const BASE64_MODE_HINTS = [
  'image',
  'image_url',
  'base64',
  'data url',
  'invalid image',
  'decode',
  'unsupported',
  '格式',
  '图片',
];

/** 从模型输出提取首个 JSON 对象（容忍 ```json 围栏与前后杂文） */
export function extractJson(text: string): unknown {
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const raw = fence?.[1] ?? text;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('输出中未找到 JSON 对象');
  return JSON.parse(raw.slice(start, end + 1));
}

/** 把 ChatMessage（含 images）组装为 OpenAI 多模态 content parts */
function buildVisionMessages(
  messages: ChatMessage[],
  mode: 'data_url' | 'raw',
  detail: string
): Array<Record<string, unknown>> {
  return messages.map((m) => {
    if (m.role === 'assistant' || !m.images || m.images.length === 0) {
      return { role: m.role, content: m.content };
    }
    const parts: Array<Record<string, unknown>> = [{ type: 'text', text: m.content }];
    for (const img of m.images) {
      let url = img;
      if (!/^[a-z]+:\/\//i.test(img) && !img.startsWith('data:')) {
        // 裸 base64：剥离可能存在的 data: 前缀后按目标形态重装
        const bare = img.replace(/^data:[^;]+;base64,/, '');
        url = mode === 'raw' ? bare : `data:image/png;base64,${bare}`;
      } else if (mode === 'raw' && img.startsWith('data:')) {
        url = img.replace(/^data:[^;]+;base64,/, '');
      }
      parts.push({ type: 'image_url', image_url: { url, detail } });
    }
    return { role: m.role, content: parts };
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class VisionClient {
  private readonly cfg: VisionConfig;
  private readonly timeoutMs: number;
  private readonly retries: number;

  constructor(cfg: VisionConfig) {
    this.cfg = cfg;
    this.timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retries = cfg.retries ?? DEFAULT_RETRIES;
  }

  /** 端点信息（错误信息与结果标注用） */
  get modelName(): string {
    return this.cfg.apiModel;
  }

  /** 单轮调用（含形态回退 + 重试）。全部失败抛错，信息面向用户。 */
  async chat(messages: ChatMessage[], opts: VisionCallOptions = {}): Promise<string> {
    const preferred = this.cfg.base64Mode ?? 'data_url';
    const modeOrder: Array<'data_url' | 'raw'> =
      preferred === 'raw' ? ['raw', 'data_url'] : ['data_url', 'raw'];
    const errors: string[] = [];

    for (let attempt = 0; attempt <= this.retries; attempt++) {
      for (const mode of modeOrder) {
        try {
          return await this.callOnce(messages, mode, opts);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          errors.push(`[${mode}] ${message}`);
          // 形态问题的 400：立即换形态重试（不消耗退避时间）
          if (this.looksLikePayloadError(message) && mode !== modeOrder[modeOrder.length - 1]) {
            continue;
          }
          break;
        }
      }
      if (attempt < this.retries) {
        await sleep(600 * Math.pow(2, attempt));
      }
    }
    throw new Error(
      `视觉模型调用失败（model=${this.cfg.apiModel}，已重试 ${this.retries} 次）：${errors
        .slice(-4)
        .join(' | ')}`
    );
  }

  private looksLikePayloadError(message: string): boolean {
    if (!/40[01]/.test(message)) return false;
    const lower = message.toLowerCase();
    return BASE64_MODE_HINTS.some((h) => lower.includes(h.toLowerCase()));
  }

  private async callOnce(
    messages: ChatMessage[],
    mode: 'data_url' | 'raw',
    opts: VisionCallOptions
  ): Promise<string> {
    const detail = this.cfg.detail ?? 'auto';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('视觉调用超时')), this.timeoutMs);
    const external = opts.signal;
    const onExternalAbort = (): void => controller.abort(new Error('已取消'));
    external?.addEventListener('abort', onExternalAbort, { once: true });
    try {
      const res = await fetch(`${this.cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.cfg.apiKey}`,
        },
        body: JSON.stringify({
          model: this.cfg.apiModel,
          messages: buildVisionMessages(messages, mode, detail),
          max_tokens: opts.maxTokens ?? 8192,
          temperature: opts.temperature ?? 0.1,
          stream: false,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
      }
      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: unknown } }>;
        error?: { message?: string };
      };
      if (json.error?.message) throw new Error(`接口返回错误：${json.error.message}`);
      const content = json.choices?.[0]?.message?.content;
      if (typeof content === 'string') return content;
      // 部分端点把 content 返回为分段数组
      if (Array.isArray(content)) {
        return content
          .map((part) => (typeof part === 'string' ? part : (part?.text as string | undefined) ?? ''))
          .join('');
      }
      return '';
    } finally {
      clearTimeout(timer);
      external?.removeEventListener('abort', onExternalAbort);
    }
  }
}

/** 兼容旧调用形态：一次性构造客户端并调用（template.from_image / 兼容层使用） */
export async function visionChat(
  cfg: VisionConfig,
  messages: ChatMessage[],
  opts: VisionCallOptions = {}
): Promise<string> {
  return new VisionClient(cfg).chat(messages, opts);
}
