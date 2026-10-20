/**
 * VisionExtractor — 视觉提取协议编排（对齐 WDClaude vision_extractor）
 *
 * 核心思想：把"读图"变成一次结构化转述，主模型只读文本。
 * 输出用分区标签（[文字内容]/[布局]/[细节]/[不确定区域]/[差异]/[意图画像]），
 * 解析器对畸形输出做降级（整段原文塞进 textContent），永不因解析失败卡死任务。
 *
 * 对比 WDBuddy 旧方案（design-spec 要求视觉模型直出严格 JSON）：
 * - JSON 是一次性赌注：少个引号就整体失败，且报错对用户毫无信息量；
 * - 分区文本天然容错：能解析几段就用几段，剩余原文兜底；
 * - 主模型拿到的是"看得懂的文字"，不需要它自己去猜 JSON 语义。
 */
import {
  EXTRACT_FULL_PROMPT,
  EXTRACT_FOCUS_PROMPT,
  INTENT_PROFILE_PROMPT,
  TRUST_HINT,
} from './prompts.js';
import { preprocessImage, toDataUrl } from './image-processor.js';
import type {
  ImageExtraction,
  ProcessedImage,
  UncertainRegion,
  VisionExtractionResult,
} from './types.js';

/** 视觉调用注入签名（由 Runtime 从 VisionConfig 构造） */
export type VisionCaller = (
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string; images?: string[] }>,
  opts?: { maxTokens?: number; temperature?: number }
) => Promise<string>;

export const DEFAULT_MAX_IMAGES = 5;

/** 分区标签集合（顺序无关，按出现位置切分） */
const SECTION_NAMES = ['文字内容', '布局', '细节', '不确定区域', '差异', '意图画像'] as const;
type SectionName = (typeof SECTION_NAMES)[number];

const SECTION_RE = new RegExp(
  `^\\[(?:${SECTION_NAMES.join('|')})\\]\\s*$`,
  'gm'
);
const PER_IMAGE_RE = /=====\s*图\s*(\d+)\s*=====/g;
const UNCERTAIN_RE =
  /\((\d*\.?\d+)\s*[,，]\s*(\d*\.?\d+)\)\s*[-–]\s*\((\d*\.?\d+)\s*[,，]\s*(\d*\.?\d+)\)\s*[:：]\s*(.+)/;

/** 纯图判定：用户文字说明为空或仅标点/空白 */
const PUNCT_STRIP = /[\s，。；、！？：,.;:!?~·…—\-（）()【】[\]{}"'`]/g;

export function isPureImageInstruction(text: string): boolean {
  return !(text ?? '').replace(PUNCT_STRIP, '');
}

/** 按分区标签切分文本 → { 分区名: 内容 } */
function splitSections(text: string): Partial<Record<SectionName, string>> {
  const out: Partial<Record<SectionName, string>> = {};
  const matches = [...text.matchAll(SECTION_RE)];
  if (matches.length === 0) return out;
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]!;
    const raw = /^\[(.+)\]$/.exec(m[0]!.trim());
    const name = raw?.[1] as SectionName | undefined;
    if (!name) continue;
    const start = m.index! + m[0]!.length;
    const end = i + 1 < matches.length ? matches[i + 1]!.index! : text.length;
    const body = text.slice(start, end).trim();
    // 同名分区保留首次出现（多图块内不会重名）
    if (out[name] === undefined) out[name] = body;
  }
  return out;
}

/** 解析不确定区域行（坐标越界/顺序非法的行直接丢弃，不抛错） */
function parseUncertain(text: string): UncertainRegion[] {
  const regions: UncertainRegion[] = [];
  for (const rawLine of (text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^[-*•]\s*/, '');
    if (!line || line === '无' || /^none$/i.test(line)) continue;
    const m = UNCERTAIN_RE.exec(line);
    if (!m) continue;
    const [x0, y0, x1, y1] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
    if (![x0, y0, x1, y1].every((v) => Number.isFinite(v) && v >= 0 && v <= 1)) continue;
    if (x1 <= x0 || y1 <= y0) continue;
    regions.push({ x0, y0, x1, y1, reason: m[5]!.trim() });
  }
  return regions;
}

/** 单图块 → ImageExtraction；无任何分区标签时返回 null（触发整体降级） */
function parseOneImage(block: string, asset: ProcessedImage): ImageExtraction | null {
  const sections = splitSections(block);
  if (Object.keys(sections).length === 0) return null;
  return {
    path: asset.originalPath,
    dimensions: asset.dimensions,
    format: asset.format,
    textContent: sections['文字内容'] ?? '',
    layout: sections['布局'] ?? '',
    details: sections['细节'] ?? '',
    uncertainRegions: parseUncertain(sections['不确定区域'] ?? ''),
    animatedFirstFrame: asset.animatedFirstFrame,
    raw: '',
  };
}

/** 解析失败降级：整段原文塞进首图 textContent（WDClaude 4.5 同策略） */
function degrade(raw: string, assets: ProcessedImage[]): VisionExtractionResult {
  const extractions: ImageExtraction[] = assets.map((asset, idx) => ({
    path: asset.originalPath,
    dimensions: asset.dimensions,
    format: asset.format,
    textContent: idx === 0 ? raw : '(提取原文已附于图 1)',
    layout: '',
    details: '',
    uncertainRegions: [],
    animatedFirstFrame: asset.animatedFirstFrame,
    raw: idx === 0 ? raw : '',
  }));
  return { extractions, diff: '', intentProfile: null };
}

export class VisionExtractor {
  constructor(
    private readonly call: VisionCaller,
    private readonly opts: { maxImagesPerRequest?: number; maxTokens?: number } = {}
  ) {}

  get maxImagesPerRequest(): number {
    return this.opts.maxImagesPerRequest ?? DEFAULT_MAX_IMAGES;
  }

  /* ───────────── 全景提取（阶段一） ───────────── */

  async extractFull(assets: ProcessedImage[], pureImage: boolean): Promise<VisionExtractionResult> {
    if (assets.length === 0) throw new Error('视觉提取收到空图像清单');
    if (assets.length > this.maxImagesPerRequest) {
      throw new Error(
        `图像数超出上限（${assets.length} > ${this.maxImagesPerRequest}），请分批提供图片`
      );
    }
    const prompt = pureImage
      ? `${EXTRACT_FULL_PROMPT}\n\n${INTENT_PROFILE_PROMPT}`
      : EXTRACT_FULL_PROMPT;
    const images = assets.map((a) => toDataUrl(a.path).dataUrl);
    const raw = await this.call(
      [{ role: 'user', content: prompt, images }],
      { maxTokens: this.opts.maxTokens ?? 8192, temperature: 0.1 }
    );
    return this.parseFullOutput(raw, assets, pureImage);
  }

  /** 解析视觉模型输出为结构化结果（公开：供测试与 template.from_image 复用） */
  parseFullOutput(
    raw: string,
    assets: ProcessedImage[],
    pureImage: boolean
  ): VisionExtractionResult {
    const headers = [...raw.matchAll(PER_IMAGE_RE)];
    let blocks: string[];
    if (headers.length > 0) {
      blocks = headers.map((h, i) => {
        const start = h.index! + h[0].length;
        const end = i + 1 < headers.length ? headers[i + 1]!.index! : raw.length;
        return raw.slice(start, end);
      });
      // 图头数与图像数不符 → 整体降级（模型漏写/多写块头）
      if (blocks.length !== assets.length) return degrade(raw, assets);
    } else {
      // 无块头：单图可容忍（模型直接输出分区），多图必须降级
      if (assets.length !== 1) return degrade(raw, assets);
      blocks = [raw];
    }

    const extractions: ImageExtraction[] = [];
    for (let i = 0; i < assets.length; i++) {
      const parsed = parseOneImage(blocks[i]!, assets[i]!);
      if (parsed === null) return degrade(raw, assets);
      extractions.push(parsed);
    }

    // 差异 / 意图画像通常挂在最后一个块尾部
    const tailSections = splitSections(blocks[blocks.length - 1] ?? raw);
    return {
      extractions,
      diff: tailSections['差异'] ?? '',
      intentProfile: pureImage ? (tailSections['意图画像'] || null) : null,
    };
  }

  /* ───────────── 定点特写（阶段二，view_image 使用） ───────────── */

  async extractFocus(imagePath: string, focus: string): Promise<string> {
    const dataUrl = toDataUrl(imagePath).dataUrl;
    const prompt = `${EXTRACT_FOCUS_PROMPT}\n\nfocus 定向任务：${focus || '无（该区域结构化描述）'}`;
    return this.call([{ role: 'user', content: prompt, images: [dataUrl] }], {
      maxTokens: 4096,
      temperature: 0.1,
    });
  }

  /* ───────────── B 消息渲染 ───────────── */

  renderB(result: VisionExtractionResult, pureImage: boolean): string {
    const n = result.extractions.length;
    const lines: string[] = [`[视觉提取] x${n}`];
    if (pureImage) lines.push('[用户未提供文字说明，以下为图像内容提取与意图画像]');
    result.extractions.forEach((ex, idx) => {
      lines.push(`[图${idx + 1}] ${ex.path} (${ex.dimensions || '尺寸未知'}, ${ex.format})`);
      if (ex.animatedFirstFrame) lines.push('[说明] 动图为多帧，仅取首帧');
      if (ex.textContent) lines.push(`[文字内容]\n${ex.textContent}`);
      if (ex.layout) lines.push(`[布局]\n${ex.layout}`);
      const detail = (ex.details ?? '').trim();
      if (detail && detail !== '无') lines.push(`[细节]\n${detail}`);
      if (ex.uncertainRegions.length > 0) {
        const body = ex.uncertainRegions
          .map((r) => `(${r.x0},${r.y0})-(${r.x1},${r.y1}): ${r.reason}`)
          .join('\n');
        lines.push(`[不确定区域]\n${body}`);
      }
    });
    if (result.diff) lines.push(`[差异]\n${result.diff}`);
    if (pureImage && result.intentProfile) lines.push(`[意图画像]\n${result.intentProfile}`);
    lines.push(TRUST_HINT);
    return lines.join('\n');
  }

  /** B 摘要（用于记忆/任务标题等需要短描述的场合） */
  static briefSummary(result: VisionExtractionResult): string {
    const parts: string[] = [];
    for (const ex of result.extractions) {
      const head = ex.textContent.trim().split(/\r?\n/)[0]?.slice(0, 60) ?? '';
      const name = ex.path.split(/[\\/]/).pop() ?? ex.path;
      parts.push(head ? `${name}: ${head}` : name);
    }
    if (result.diff) parts.push(`diff: ${result.diff.trim().slice(0, 80)}`);
    if (result.intentProfile) parts.push(`intent: ${result.intentProfile.trim().slice(0, 60)}`);
    return parts.join('; ');
  }
}

/* ───────────── 流水线入口（工具层调用） ───────────── */

export interface VisionPipelineResult {
  result: VisionExtractionResult;
  /** 渲染好的 B 消息（注入主模型上下文） */
  message: string;
  /** 预处理降级的图片路径清单（无 python/PIL 时原图直传） */
  degradedPaths: string[];
}

/**
 * 级联方案完整流水线：预处理 → 全景提取 → 渲染 B。
 * 任何失败抛出 VisionFatalError 语义的 Error（含失败清单与建议）。
 */
export async function runVisionPipeline(
  extractor: VisionExtractor,
  imagePaths: string[],
  opts: { pureImage: boolean }
): Promise<VisionPipelineResult> {
  if (imagePaths.length === 0) throw new Error('未提供任何图片路径');
  const assets: ProcessedImage[] = [];
  const failed: string[] = [];
  const degradedPaths: string[] = [];
  for (const p of imagePaths) {
    try {
      const asset = preprocessImage(p);
      if (asset.degraded) degradedPaths.push(p);
      assets.push(asset);
    } catch (err) {
      failed.push(`${p}（${err instanceof Error ? err.message : String(err)}）`);
    }
  }
  if (failed.length > 0) {
    throw new Error(
      `图像预处理失败，失败清单：${failed.join('；')}。建议确认文件存在、格式为 PNG/JPEG/GIF/BMP/WEBP 且未损坏`
    );
  }
  const result = await extractor.extractFull(assets, opts.pureImage);
  return { result, message: extractor.renderB(result, opts.pureImage), degradedPaths };
}
