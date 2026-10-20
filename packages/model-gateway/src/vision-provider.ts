/**
 * VisionProvider — 视觉理解模型（OpenAI 兼容多模态协议）
 * 用途：template.from_image 的"图片 → DesignSpec"提取。
 * 与普通 chat provider 的差异：消息携带 image_url，模型必须具备视觉能力
 *（如 GLM-4V / Kimi-vision / 自定义兼容端点）。
 *
 * 独立于 ModelId 联合类型：视觉模型是"能力"而非"路由目标"，经
 * RuntimeProviderConfig.visionConfig 注入（用户在设置页配置 baseUrl/apiModel/apiKey）。
 */
import type { ChatMessage } from '@wdbuddy/shared-types';
import { VisionClient } from './vision-client.js';

export interface VisionConfig {
  /** 兼容端点，如 https://open.bigmodel.cn/api/paas/v4 */
  baseUrl: string;
  /** 视觉模型名，如 glm-4v-plus / gpt-4o / qwen-vl-plus */
  apiModel: string;
  /** API Key（Main 从钥匙串注入，不落盘） */
  apiKey: string;
  /** 图片传输形态：data_url（默认）| raw（部分 GLM 网关只接受裸 base64） */
  base64Mode?: 'data_url' | 'raw';
  /** 细节档位（OpenAI 协议 low/high/auto） */
  detail?: 'low' | 'high' | 'auto';
  /** 单次调用超时（毫秒） */
  timeoutMs?: number;
  /** 失败重试次数 */
  retries?: number;
}

/**
 * 视觉模型调用（非流式：结构化提取场景无需流式，一次性输出最稳）。
 * 统一委托 VisionClient：形态回退（data URL / 裸 base64）+ 重试 + 超时，
 * 避免旧实现"一次 400 直接失败、用户看不懂错误"的问题。
 */
export async function visionChat(
  cfg: VisionConfig,
  messages: ChatMessage[],
  opts: { maxTokens?: number; temperature?: number; signal?: AbortSignal } = {}
): Promise<string> {
  return new VisionClient(cfg).chat(messages, opts);
}

/** 从模型输出提取 JSON（容错：```json 围栏 / 前后杂文） */
export function extractJson(text: string): unknown {
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const raw = fence ? fence[1]! : text;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('输出中未找到 JSON 对象');
  return JSON.parse(raw.slice(start, end + 1));
}
