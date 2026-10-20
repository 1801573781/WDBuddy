/**
 * 视觉工具（对齐 WDClaude 的 view_image + 级联输入方案）
 *
 * 旧方案的致命问题：图片只在一个特定工具（template.from_image）里被消费，且
 * 目标固定为"生成 PPT 模板 JSON"。用户拿截图问"这个报错怎么修""照着这个图做
 * 一个页面"，主模型根本拿不到图 —— 于是 Agent 只能靠文件名瞎猜（真实事故：
 * 10/16 猜原始响应文件空转一小时）。
 *
 * 新方案提供两个通用工具，让主模型自主决定何时看图、看哪一块：
 * - vision.read：全图/多图结构化理解（一次调用出全部信息，最常用）
 * - view_image：局部特写（先生成画框定位图 + 裁剪上采样，再定向提问），
 *   解决"小字、图例、按钮、表格角落看不清"的顽固问题
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentTool, ToolContext, ToolResult } from '../tools/registry.js';
import { VisionExtractor, isPureImageInstruction, runVisionPipeline } from './extractor.js';
import type { VisionCaller } from './extractor.js';
import {
  annotateLocator,
  cropAndZoom,
  isCoordinateRegion,
  parseRegion,
  regionToAnchor,
  sniffFormat,
  toDataUrl,
} from './image-processor.js';
import { buildLocatorPrompt } from './prompts.js';
import { extractJson } from '@wdbuddy/model-gateway';

/** 单张图片最大字节数（超限提示压缩，避免请求体被端点拒绝） */
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

/** 构造提取器（从注入的 visionChat 组装） */
function makeExtractor(ctx: ToolContext): VisionExtractor | null {
  const caller = ctx.visionChat;
  if (!caller) return null;
  const visionCaller: VisionCaller = (messages, opts) => caller(messages, opts);
  return new VisionExtractor(visionCaller);
}

/** 多模态模型缺失时的统一指引（不让用户去猜哪里配） */
const NO_VISION_HINT =
  '多模态模型未配置。请在 设置 → 模型 → 多模态模型 中添加一个（Base URL + 模型名 + API Key，需为 OpenAI 兼容的多模态端点，如 glm-4v-plus、gpt-4o、qwen-vl-plus），保存后重新发起任务。';

/** 经 fs-guard 做一次访问裁决（工作空间外的图由 policy-engine 先请用户确认，
 *  确认后 grantDirectory 临时授权）。返回面向用户的错误或 null。 */
function assertReadable(ctx: ToolContext, p: string): string | null {
  try {
    ctx.fsGuard.readFile(p, 'binary');
    return null;
  } catch (err) {
    return `读取图片被拒绝：${err instanceof Error ? err.message : String(err)}。若图片在工作空间外，请在权限弹窗中允许，或把图片复制到工作空间内`;
  }
}

/** 读取图片并校验（存在性 / 大小 / 魔数），返回面向用户的错误或 null */
function validateImage(p: string): string | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(p);
  } catch {
    return `图片不存在或无法访问：${p}`;
  }
  if (!stat.isFile()) return `不是文件：${p}`;
  if (stat.size < 512) return `图片文件过小（${stat.size} 字节），疑似路径错误或文件损坏：${p}`;
  if (stat.size > MAX_IMAGE_BYTES) {
    return `图片过大（${(stat.size / 1024 / 1024).toFixed(1)}MB，上限 ${
      MAX_IMAGE_BYTES / 1024 / 1024
    }MB），请先压缩或裁剪后再读：${p}`;
  }
  if (!sniffFormat(p)) {
    return `图片格式不支持或扩展名与内容不符（支持 PNG/JPEG/GIF/BMP/WEBP）：${p}`;
  }
  return null;
}

/* ─────────────────────────── vision.read ─────────────────────────── */

export const visionReadTool: AgentTool = {
  name: 'vision.read',
  description:
    '理解一张或多张图片（截图/设计稿/表格/流程图/照片/报错界面），返回结构化文字：文字内容、布局、细节、不确定区域（归一化坐标）、多图差异。参数：path（必填，图片绝对路径；多图用 paths 数组，最多 5 张）、question（可选，你希望重点回答的问题）。当用户提供图片、或任务需要参照图片内容时，必须先调用本工具再决策，禁止凭文件名猜测图片内容。',
  sensitivity: 'read-only',
  async execute(args, ctx): Promise<ToolResult> {
    const single = typeof args['path'] === 'string' ? (args['path'] as string).trim() : '';
    const many = Array.isArray(args['paths'])
      ? (args['paths'] as unknown[]).filter((v): v is string => typeof v === 'string' && v.trim() !== '')
      : [];
    const paths = many.length > 0 ? many : single ? [single] : [];
    if (paths.length === 0) {
      return { ok: false, output: '缺少 path 参数（图片绝对路径）或 paths 数组', artifacts: [] };
    }
    const extractor = makeExtractor(ctx);
    if (!extractor) return { ok: false, output: NO_VISION_HINT, artifacts: [] };

    // 逐张做可访问性校验（失败即返回，避免浪费视觉调用配额）
    for (const p of paths) {
      const denied = assertReadable(ctx, p);
      if (denied) return { ok: false, output: denied, artifacts: [] };
      const bad = validateImage(p);
      if (bad) return { ok: false, output: bad, artifacts: [] };
    }

    const question = typeof args['question'] === 'string' ? (args['question'] as string).trim() : '';
    // 纯图判定：无问题且无文字说明时的意图画像增强
    const pureImage = isPureImageInstruction(question);

    try {
      const pipeline = await runVisionPipeline(extractor, paths, { pureImage });
      const lines: string[] = [pipeline.message];
      if (question) {
        lines.push(`[本次关注问题] ${question}（若上述提取已覆盖请直接回答，未覆盖请用 view_image 局部特写）`);
      }
      if (pipeline.degradedPaths.length > 0) {
        lines.push(
          `[提示] 以下图片未做压缩/EXIF 修正（环境缺少 python+Pillow，已按原图直传，超大图可能丢失细节）：${pipeline.degradedPaths.join('、')}。安装方式：pip install pillow`
        );
      }
      return { ok: true, output: lines.join('\n'), artifacts: [] };
    } catch (err) {
      return {
        ok: false,
        output: `图像理解失败：${err instanceof Error ? err.message : String(err)}`,
        artifacts: [],
      };
    }
  },
};

/* ─────────────────────────── view_image ─────────────────────────── */

/** 语义 region → 归一化框（调视觉模型定位） */
async function resolveSemanticRegion(
  ctx: ToolContext,
  imagePath: string,
  description: string
): Promise<{ box: { x0: number; y0: number; x1: number; y1: number }; label: string }> {
  const caller = ctx.visionChat;
  if (!caller) throw new Error(NO_VISION_HINT);
  const dataUrl = toDataUrl(imagePath).dataUrl;
  const raw = await caller(
    [{ role: 'user', content: buildLocatorPrompt(description), images: [dataUrl] }],
    { maxTokens: 512, temperature: 0 }
  );
  const data = extractJson(raw) as {
    label?: unknown;
    box?: { x0?: unknown; y0?: unknown; x1?: unknown; y1?: unknown };
  };
  const box = data.box;
  if (!box) throw new Error(`区域定位输出缺少 box 字段：${raw.slice(0, 200)}`);
  const nums = [box.x0, box.y0, box.x1, box.y1].map((v) => Number(v));
  if (!nums.every((v) => Number.isFinite(v) && v >= 0 && v <= 1)) {
    throw new Error(`区域定位坐标非法（需 0-1 归一化）：${JSON.stringify(box)}`);
  }
  const [x0, y0, x1, y1] = nums as [number, number, number, number];
  if (x1 <= x0 || y1 <= y0) {
    throw new Error(`区域定位框非法（要求 x1>x0 且 y1>y0）：${JSON.stringify(box)}`);
  }
  return {
    box: { x0, y0, x1, y1 },
    label: typeof data.label === 'string' && data.label.trim() ? data.label.trim() : description,
  };
}

export const viewImageTool: AgentTool = {
  name: 'view_image',
  description:
    '重看原图或裁剪特写：当 vision.read 的结果里存在 [不确定区域]，或你需要看清某一小块（小字/图例/按钮/表格角落/报错信息）时调用。参数：path（必填，图片绝对路径）、region（可选，归一化坐标 "x0,y0,x1,y1"（0-1）或语义描述如"右上角的表格"、"红色按钮周围 200px"）、focus（可选，定向问题）。返回该区域的结构化解读与画框定位图路径。',
  sensitivity: 'read-only',
  async execute(args, ctx): Promise<ToolResult> {
    const p = typeof args['path'] === 'string' ? (args['path'] as string).trim() : '';
    if (!p) return { ok: false, output: '缺少 path 参数（图片绝对路径）', artifacts: [] };
    const denied = assertReadable(ctx, p);
    if (denied) return { ok: false, output: denied, artifacts: [] };
    const bad = validateImage(p);
    if (bad) return { ok: false, output: bad, artifacts: [] };

    const extractor = makeExtractor(ctx);
    if (!extractor) return { ok: false, output: NO_VISION_HINT, artifacts: [] };

    const regionRaw = typeof args['region'] === 'string' ? (args['region'] as string).trim() : '';
    const focus = typeof args['focus'] === 'string' ? (args['focus'] as string).trim() : '';

    // 1. 解析 region（坐标优先；否则语义定位）
    let box = { x0: 0, y0: 0, x1: 1, y1: 1 };
    let label = '整图';
    if (regionRaw) {
      try {
        if (isCoordinateRegion(regionRaw)) {
          box = parseRegion(regionRaw);
          label = `坐标区域 ${regionToAnchor(box)}`;
        } else {
          const resolved = await resolveSemanticRegion(ctx, p, regionRaw);
          box = resolved.box;
          label = resolved.label;
        }
      } catch (err) {
        return {
          ok: false,
          output: `region 解析失败：${err instanceof Error ? err.message : String(err)}。可用归一化坐标 "x0,y0,x1,y1"（0-1），或用语义描述如"右上角的表格"`,
          artifacts: [],
        };
      }
    }

    // 2. 裁剪 + 上采样（整图时不裁）
    const isWhole = box.x0 === 0 && box.y0 === 0 && box.x1 === 1 && box.y1 === 1;
    const crop = isWhole ? { path: p, degraded: false } : cropAndZoom(p, box);
    // 3. 画框定位图（防放大后迷路）
    const locator = isWhole ? { path: p, degraded: false } : annotateLocator(p, box);

    // 4. 定向特写提取
    let extraction = '';
    try {
      extraction = await extractor.extractFocus(crop.path, focus || label);
    } catch (err) {
      return {
        ok: false,
        output: `局部特写提取失败：${err instanceof Error ? err.message : String(err)}`,
        artifacts: [],
      };
    }

    const lines = [
      `[视觉特写] ${path.basename(p)}`,
      `[区域] ${label}${isWhole ? '' : ` ${regionToAnchor(box)}（归一化坐标，原点左上）`}`,
      `[入口] 原图 ${p}`,
      crop.degraded
        ? '[说明] 环境缺少 python+Pillow，未能裁剪放大，已对整图提问（细节可能不足）：pip install pillow'
        : `[裁剪件] ${crop.path}（已按最短边放大，摊满视觉预算）`,
      locator.degraded ? '' : `[定位图] ${locator.path}（红色 3px 框标出该区域在原图中的位置）`,
      '',
      extraction,
      '',
      '[提示] 若该区域仍看不清，可缩小 region 范围或换更精确的语义描述再次调用 view_image。',
    ].filter((l) => l !== '');

    return { ok: true, output: lines.join('\n'), artifacts: [] };
  },
};
