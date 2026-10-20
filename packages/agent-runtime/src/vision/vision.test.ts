/**
 * 视觉链路回归测试（固化本次重构的关键行为，防止回退）
 *
 * 覆盖的"历史坑"：
 * 1. 视觉模型不按格式输出（无块头/分区缺项/坐标非法）时必须降级而非抛错；
 * 2. 渲染 B 消息必须带路径锚点与信任提示（主模型据此判断能否重看原图）；
 * 3. region 坐标非法要给出可读错误（避免静默裁剪出空白图）；
 * 4. 图片格式嗅探必须按魔数而非扩展名（jpg 被错标 png 会 400）；
 * 5. 宽松 JSON 解析必须能救回嵌套截断（旧实现补括号顺序错误，必然失败）。
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { VisionExtractor, isPureImageInstruction } from './extractor.js';
import type { VisionExtractionResult } from './types.js';
import { isCoordinateRegion, parseRegion, readDimensions, sniffFormat, toDataUrl } from './image-processor.js';
import { looseParseJson } from '../tools/pptx/design-spec.js';

const ASSET_A = {
  path: 'D:/tmp/a.png',
  originalPath: 'D:/tmp/a.png',
  dimensions: '800x600',
  format: 'PNG',
  mime: 'image/png',
  animatedFirstFrame: false,
  degraded: false,
};

const ASSET_B = { ...ASSET_A, path: 'D:/tmp/b.png', originalPath: 'D:/tmp/b.png' };

function extractor(): VisionExtractor {
  return new VisionExtractor(async () => '');
}

const TWO_IMAGE_OUTPUT = `===== 图 1 =====
[文字内容]
标题：季度汇报
| 季度 | 销量 |
[布局]
左右两栏
[细节]
主色 #1e3a8a
[不确定区域]
(0.1,0.2)-(0.3,0.25): 数字模糊
===== 图 2 =====
[文字内容]
第二部分
[差异]
配色一致，版式不同`;

describe('VisionExtractor 分区解析', () => {
  it('多图分区解析：文字/布局/细节/不确定区域/差异全部落位', () => {
    const r = extractor().parseFullOutput(TWO_IMAGE_OUTPUT, [ASSET_A, ASSET_B], false);
    expect(r.extractions).toHaveLength(2);
    expect(r.extractions[0]!.textContent).toContain('标题：季度汇报');
    expect(r.extractions[0]!.layout).toBe('左右两栏');
    expect(r.extractions[0]!.details).toContain('1e3a8a');
    expect(r.extractions[0]!.uncertainRegions).toHaveLength(1);
    expect(r.extractions[0]!.uncertainRegions[0]!.reason).toBe('数字模糊');
    expect(r.diff).toContain('配色一致');
    expect(r.intentProfile).toBeNull();
  });

  it('块头数量与图片数不符 → 整体降级为原文，不抛错', () => {
    const raw = '===== 图 1 =====\n[文字内容]\n只有一个块';
    const r = extractor().parseFullOutput(raw, [ASSET_A, ASSET_B], false);
    expect(r.extractions).toHaveLength(2);
    expect(r.extractions[0]!.textContent).toContain('只有一个块');
    // 降级后仍保留每张图的路径锚点（可继续 view_image 重看）
    expect(r.extractions[1]!.path).toBe('D:/tmp/b.png');
  });

  it('完全无分区标签的输出 → 降级不阻塞', () => {
    const raw = '这张图片是一张深色背景的幻灯片，上面有金色标题。';
    const r = extractor().parseFullOutput(raw, [ASSET_A], false);
    expect(r.extractions[0]!.textContent).toBe(raw);
  });

  it('非法不确定区域坐标被丢弃（不污染结果）', () => {
    const raw = '===== 图 1 =====\n[文字内容]\nx\n[不确定区域]\n(1.2,0.2)-(0.3,0.25): 越界\n(0.4,0.4)-(0.2,0.6): 顺序错\n(0.1,0.1)-(0.2,0.2): 正常';
    const r = extractor().parseFullOutput(raw, [ASSET_A], false);
    expect(r.extractions[0]!.uncertainRegions).toHaveLength(1);
    expect(r.extractions[0]!.uncertainRegions[0]!.reason).toBe('正常');
  });

  it('纯图模式解析出意图画像分区', () => {
    const raw = '===== 图 1 =====\n[文字内容]\n报错窗口\n[意图画像]\n这是报错截图，建议定位堆栈并修复';
    const r = extractor().parseFullOutput(raw, [ASSET_A], true);
    expect(r.intentProfile).toContain('建议定位堆栈');
  });
});

describe('VisionExtractor.renderB', () => {
  it('渲染结果包含路径锚点、坐标锚点与信任提示', () => {
    const r = extractor().parseFullOutput(TWO_IMAGE_OUTPUT, [ASSET_A, ASSET_B], true);
    const text = extractor().renderB(r as VisionExtractionResult, true);
    expect(text).toContain('[视觉提取] x2');
    expect(text).toContain('[图1] D:/tmp/a.png (800x600, PNG)');
    expect(text).toContain('(0.1,0.2)-(0.3,0.25): 数字模糊');
    expect(text).toContain('[差异]');
    expect(text).toContain('view_image');
  });

  it('动图标注首帧说明', () => {
    const r = extractor().parseFullOutput(TWO_IMAGE_OUTPUT, [{ ...ASSET_A, animatedFirstFrame: true }], false);
    const text = extractor().renderB(r, false);
    expect(text).toContain('仅取首帧');
  });
});

describe('纯图判定', () => {
  it('空与纯标点判定为纯图', () => {
    expect(isPureImageInstruction('')).toBe(true);
    expect(isPureImageInstruction('  ，。！ ')).toBe(true);
  });

  it('含实质文字不是纯图', () => {
    expect(isPureImageInstruction('看看这个报错怎么修')).toBe(false);
  });
});

describe('region 解析', () => {
  it('归一化坐标解析成功（兼容中文逗号）', () => {
    expect(parseRegion('0.1，0.2，0.5，0.6')).toEqual({ x0: 0.1, y0: 0.2, x1: 0.5, y1: 0.6 });
    expect(isCoordinateRegion('0.1,0.2,0.5,0.6')).toBe(true);
  });

  it('语义描述不是坐标', () => {
    expect(isCoordinateRegion('右上角的表格')).toBe(false);
  });

  it('越界与顺序错误抛可读错误', () => {
    expect(() => parseRegion('1.2,0,0.5,0.5')).toThrow(/超出/);
    expect(() => parseRegion('0.5,0.2,0.1,0.6')).toThrow(/x1>x0/);
  });
});

describe('图片格式嗅探与尺寸', () => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );

  it('按魔数识别 PNG（忽略扩展名）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-vision-'));
    const fake = path.join(dir, 'looks-like.jpg');
    fs.writeFileSync(fake, png);
    expect(sniffFormat(fake)).toEqual({ format: 'PNG', mime: 'image/png' });
    expect(readDimensions(fake)).toBe('1x1');
    expect(toDataUrl(fake).dataUrl.startsWith('data:image/png;base64,')).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('非图片内容不误判', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-vision-'));
    const txt = path.join(dir, 'a.png');
    fs.writeFileSync(txt, '这不是图片');
    expect(sniffFormat(txt)).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('宽松 JSON（template.from_image 通道）', () => {
  it('嵌套截断按栈顺序补齐', () => {
    const hand = '{"name":"测试模板","colors":[{"hex":"#111111"},{"hex":"#222222"';
    const r = looseParseJson(hand) as { colors: unknown[] };
    expect(r.colors).toHaveLength(2);
  });

  it('注释 + 尾逗号混合仍可解析', () => {
    const hand = `{
      "name": "深蓝模板", // 模板名
      "colors": [ { "hex": "#050836", }, ],
    }`;
    const r = looseParseJson(hand) as { name: string };
    expect(r.name).toBe('深蓝模板');
  });

  it('括号平衡扫描不会把内层 } 当作根闭合', () => {
    const text = '分析结果：{"name":"A","colors":[{"hex":"#000000"}]} 以上。';
    const r = looseParseJson(text) as { name: string };
    expect(r.name).toBe('A');
  });
});
