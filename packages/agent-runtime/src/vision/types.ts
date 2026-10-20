/**
 * 视觉链路数据类型（对齐 WDClaude 级联方案的数据结构）
 *
 * 设计动机：WDBuddy 原方案把"图片直接塞进主模型 + 要求主模型吐 JSON 设计规格"
 * 当唯一通路，导致：
 * 1. 主模型既要推理任务又要读像素，任务越复杂读图越差；
 * 2. 输出要求严格 JSON，视觉模型经常吐长文字 → 解析失败黑盒报错；
 * 3. 没有区域定位能力，细节（小字、图例、按钮）永远读不清；
 * 4. 失败无降级，直接卡死步骤。
 *
 * 新方案把"读图"独立成旁路能力（VisionClient + VisionExtractor），
 * 输出结构化分区文本注入主模型上下文，与主模型推理解耦。
 */

/** 无法可靠识别的区域（归一化 0-1 坐标，原点左上） */
export interface UncertainRegion {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  reason: string;
}

/** 单图提取结果（path 为原图磁盘绝对路径，是 view_image 重看的锚点） */
export interface ImageExtraction {
  path: string;
  dimensions: string;
  format: string;
  textContent: string;
  layout: string;
  details: string;
  uncertainRegions: UncertainRegion[];
  animatedFirstFrame: boolean;
  /** 解析失败时的整段原文（降级不阻塞，对齐 WDClaude 4.5） */
  raw: string;
}

/** 多图提取容器 */
export interface VisionExtractionResult {
  extractions: ImageExtraction[];
  /** 多图差异对比，单图为空 */
  diff: string;
  /** 仅纯图模式非空（用户没给文字说明时的意图画像） */
  intentProfile: string | null;
}

/** 预处理产物（不覆盖原图；path 指向压缩后的 PNG 副本） */
export interface ProcessedImage {
  path: string;
  originalPath: string;
  /** 形如 "1920x1080" */
  dimensions: string;
  /** "PNG" / "JPEG" ... */
  format: string;
  mime: string;
  /** gif/webp 动图只取首帧时为 true */
  animatedFirstFrame: boolean;
  /** 预处理是否被降级跳过（无 python/PIL 时直接用原图） */
  degraded: boolean;
}

/** 归一化外接框（0-1 闭区间） */
export interface RegionBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** 视觉链路错误（fail-fast，信息面向用户） */
export class VisionFatalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VisionFatalError';
  }
}
