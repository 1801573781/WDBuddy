/**
 * 图像预处理与几何工具（对齐 WDClaude image_processor）
 *
 * 为什么 WDBuddy 必须补这一层：原方案直接把原始图片 base64 塞给视觉模型，
 * 于是出现三类顽固问题：
 * 1. 大图（4K 截图/手机照片）超出模型视觉 token 预算 → 模型"看起来像瞎了"，
 *    只回一句泛泛描述，细节全丢；
 * 2. 扩展名与内容不符（.png 实为 webp/jpeg）或多帧图（gif/webp）→ 端点解码失败，
 *    用户只看到 "HTTP 400"，无从排查；
 * 3. 小字/图例/按钮永远读不清——没有裁剪放大能力，模型只能整图降采样。
 *
 * 本模块复用项目既有的"python 子进程"约定（spec-renderer 已这么做）调用 PIL：
 * 魔数校验 → EXIF 方向修正 → 动图取首帧 → 最长边压缩 → 落盘 PNG 副本；
 * 另提供 region 裁剪上采样与"画框定位图"，构成 view_image 的两阶段协议。
 *
 * 降级原则：环境无 python/PIL 时不阻塞业务，返回 degraded=true 并用原图直传
 *（模型侧仍可处理，只是失去缩放与裁切能力），并在渲染结果中显式告知。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { ProcessedImage, RegionBox } from './types.js';

/** 视觉输入最长边（超过则压缩；与 WDClaude vision.max_long_edge_px 对齐） */
export const DEFAULT_MAX_LONG_EDGE_PX = 1536;
/** 特写裁剪最短边上采样目标（摊满视觉 tile 预算） */
export const DEFAULT_ZOOM_MIN_EDGE = 1024;
/** 裁剪边缘外扩比例（避免裁掉表头/上下文） */
export const DEFAULT_PADDING_RATIO = 0.05;
/** 画框定位图底图长边 */
export const LOCATOR_BASE_LONG_EDGE = 512;
/** 画框线宽（像素） */
export const LOCATOR_BORDER_PX = 3;

interface MagicEntry {
  format: string;
  mime: string;
  magic: readonly number[];
  /** WEBP 需额外校验偏移 8 处的 "WEBP" 标识 */
  extra?: { offset: number; bytes: string };
}

/** 魔数表（防伪扩展名：扩展名与真实格式不一致时以魔数为准） */
const MAGIC_TABLE: readonly MagicEntry[] = [
  { format: 'PNG', mime: 'image/png', magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { format: 'JPEG', mime: 'image/jpeg', magic: [0xff, 0xd8, 0xff] },
  { format: 'GIF', mime: 'image/gif', magic: [0x47, 0x49, 0x46, 0x38] },
  { format: 'BMP', mime: 'image/bmp', magic: [0x42, 0x4d] },
  { format: 'WEBP', mime: 'image/webp', magic: [0x52, 0x49, 0x46, 0x46], extra: { offset: 8, bytes: 'WEBP' } },
];

/** 媒体工作根：临时目录下的独立空间（不污染用户工作空间） */
export function visionWorkRoot(): string {
  const root = path.join(os.tmpdir(), 'wdbuddy-vision');
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function processedDir(): string {
  const d = path.join(visionWorkRoot(), 'processed');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function viewDir(): string {
  const d = path.join(visionWorkRoot(), 'view');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** 魔数嗅探：返回真实格式与 mime；无法识别返回 null（上层按失败处理） */
export function sniffFormat(filePath: string): { format: string; mime: string } | null {
  let head: Buffer;
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      head = Buffer.alloc(16);
      const read = fs.readSync(fd, head, 0, 16, 0);
      head = head.subarray(0, read);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  for (const entry of MAGIC_TABLE) {
    if (head.length < entry.magic.length) continue;
    const hit = entry.magic.every((b, i) => head[i] === b);
    if (!hit) continue;
    if (entry.extra) {
      const slice = head.subarray(entry.extra.offset, entry.extra.offset + entry.extra.bytes.length);
      if (slice.toString('ascii') !== entry.extra.bytes) continue;
    }
    return { format: entry.format, mime: entry.mime };
  }
  return null;
}

/** 纯 Node 读尺寸（PNG/JPEG/GIF/BMP/WEBP），失败返回空串（不抛错） */
export function readDimensions(filePath: string): string {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(filePath);
  } catch {
    return '';
  }
  try {
    if (buf.length > 24 && buf.subarray(1, 4).toString('ascii') === 'PNG') {
      return `${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`;
    }
    if (buf.length > 26 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
      return `${buf.readUInt16LE(6)}x${buf.readUInt16LE(8)}`;
    }
    if (buf.length > 26 && buf[0] === 0x42 && buf[1] === 0x4d) {
      return `${buf.readInt32LE(18)}x${Math.abs(buf.readInt32LE(22))}`;
    }
    if (buf.length > 30 && buf.subarray(8, 12).toString('ascii') === 'WEBP') {
      const chunk = buf.subarray(12, 16).toString('ascii');
      if (chunk === 'VP8X') {
        const w = 1 + buf.readUIntLE(24, 3);
        const h = 1 + buf.readUIntLE(27, 3);
        return `${w}x${h}`;
      }
      if (chunk === 'VP8 ') {
        return `${buf.readUInt16LE(26) & 0x3fff}x${buf.readUInt16LE(28) & 0x3fff}`;
      }
      if (chunk === 'VP8L') {
        const bits = buf.readUInt32LE(21);
        return `${(bits & 0x3fff) + 1}x${((bits >> 14) & 0x3fff) + 1}`;
      }
    }
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) {
          i++;
          continue;
        }
        const marker = buf[i + 1]!;
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return `${buf.readUInt16BE(i + 7)}x${buf.readUInt16BE(i + 5)}`;
        }
        const len = buf.readUInt16BE(i + 2);
        i += 2 + len;
      }
    }
  } catch {
    /* 解析失败按未知处理 */
  }
  return '';
}

/** 执行环境探测：python + PIL 是否可用（结果缓存，避免每次调用都试错） */
let pilAvailable: boolean | null = null;

export function isPilAvailable(): boolean {
  if (pilAvailable !== null) return pilAvailable;
  try {
    execFileSync('python', ['-X', 'utf8', '-c', 'import PIL; print(PIL.__version__)'], {
      timeout: 15000,
      windowsHide: true,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    pilAvailable = true;
  } catch {
    pilAvailable = false;
  }
  return pilAvailable;
}

/** 调 python 执行 PIL 脚本；失败抛错（由调用方决定是否降级） */
function runPil(script: string, payload: unknown): string {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const scriptPath = path.join(os.tmpdir(), `wdbuddy_vision_${stamp}.py`);
  const jsonPath = path.join(os.tmpdir(), `wdbuddy_vision_${stamp}.json`);
  fs.writeFileSync(scriptPath, script, 'utf8');
  fs.writeFileSync(jsonPath, JSON.stringify(payload), 'utf8');
  try {
    return execFileSync('python', ['-X', 'utf8', scriptPath, jsonPath], {
      encoding: 'utf8',
      timeout: 120000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    }).toString();
  } finally {
    try { fs.unlinkSync(scriptPath); } catch { /* 忽略清理失败 */ }
    try { fs.unlinkSync(jsonPath); } catch { /* 忽略清理失败 */ }
  }
}

/* ───────────── 预处理管线：EXIF 修正 + 首帧 + 最长边压缩 + 落盘 PNG ───────────── */

const PREPROCESS_PY = `
import sys, json, hashlib
from PIL import Image, ImageOps
cfg = json.load(open(sys.argv[1], encoding='utf8'))
src, out = cfg['src'], cfg['out']
max_edge = cfg['maxEdge']
img = Image.open(src)
animated = bool(getattr(img, 'is_animated', False))
if animated:
    img.seek(0)
try:
    img = ImageOps.exif_transpose(img)
except Exception:
    pass
if img.mode == 'P':
    img = img.convert('RGBA')
w, h = img.size
if max(w, h) > max_edge:
    scale = max_edge / float(max(w, h))
    img = img.resize((max(1, int(round(w*scale))), max(1, int(round(h*scale)))), Image.LANCZOS)
w, h = img.size
img.save(out, format='PNG')
print(json.dumps({'ok': True, 'width': w, 'height': h, 'animated': animated}))
`;

/**
 * 预处理单张图片（不覆盖原图）。
 * 产物：`<tmp>/wdbuddy-vision/processed/<原名>_<内容hash8>.png`（同图幂等）
 * PIL 不可用或执行失败 → 降级返回原图（degraded=true），不打断任务。
 */
export function preprocessImage(
  srcPath: string,
  opts: { maxLongEdgePx?: number } = {}
): ProcessedImage {
  const maxEdge = opts.maxLongEdgePx ?? DEFAULT_MAX_LONG_EDGE_PX;
  const stat = fs.statSync(srcPath);
  const sniff = sniffFormat(srcPath);
  if (!sniff) {
    throw new Error(`图像魔数校验失败（扩展名与实际内容不符或格式不支持）：${srcPath}`);
  }
  const fallbackDims = readDimensions(srcPath);
  const base: ProcessedImage = {
    path: srcPath,
    originalPath: srcPath,
    dimensions: fallbackDims,
    format: sniff.format,
    mime: sniff.mime,
    animatedFirstFrame: false,
    degraded: true,
  };
  if (!isPilAvailable()) return base;
  const digest = (() => {
    try {
      return createHash('sha1').update(fs.readFileSync(srcPath)).digest('hex').slice(0, 8);
    } catch {
      return String(stat.size);
    }
  })();
  const out = path.join(processedDir(), `${path.basename(srcPath, path.extname(srcPath))}_${digest}.png`);
  try {
    const raw = runPil(PREPROCESS_PY, { src: srcPath, out, maxEdge });
    const res = JSON.parse(raw.trim().split('\n').pop() ?? '{}') as {
      ok?: boolean;
      width?: number;
      height?: number;
      animated?: boolean;
    };
    if (!res.ok || !res.width || !res.height) return base;
    return {
      path: out,
      originalPath: srcPath,
      dimensions: `${res.width}x${res.height}`,
      format: 'PNG',
      mime: 'image/png',
      animatedFirstFrame: Boolean(res.animated),
      degraded: false,
    };
  } catch {
    return base;
  }
}

/* ───────────── region 解析（归一化坐标 / 语义描述） ───────────── */

const REGION_RE = /^\s*(\d*\.?\d+)\s*[,，]\s*(\d*\.?\d+)\s*[,，]\s*(\d*\.?\d+)\s*[,，]\s*(\d*\.?\d+)\s*$/;

/** 解析归一化坐标 region：`x0,y0,x1,y1`（兼容中英文逗号） */
export function parseRegion(text: string): RegionBox {
  const m = REGION_RE.exec(text ?? '');
  if (!m) {
    throw new Error(`region 坐标格式错误：${JSON.stringify(text)}，应为归一化坐标 x0,y0,x1,y1（0-1）`);
  }
  const [x0, y0, x1, y1] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  for (const [name, v] of [['x0', x0], ['y0', y0], ['x1', x1], ['y1', y1]] as const) {
    if (!Number.isFinite(v) || v < 0 || v > 1) {
      throw new Error(`region 坐标 ${name}=${v} 超出 [0,1] 闭区间`);
    }
  }
  if (x1 <= x0 || y1 <= y0) {
    throw new Error(`region 坐标非法（要求 x1>x0 且 y1>y0）：${JSON.stringify(text)}`);
  }
  return { x0, y0, x1, y1 };
}

/** 是否为归一化坐标形式的 region（否则按语义描述处理） */
export function isCoordinateRegion(text: string): boolean {
  try {
    parseRegion(text);
    return true;
  } catch {
    return false;
  }
}

export function regionToString(box: RegionBox): string {
  return `${box.x0},${box.y0},${box.x1},${box.y1}`;
}

export function regionToAnchor(box: RegionBox): string {
  const f = (n: number): string => String(Math.round(n * 1000) / 1000);
  return `(${f(box.x0)},${f(box.y0)})-(${f(box.x1)},${f(box.y1)})`;
}

/* ───────────── 裁剪 + 上采样 / 画框定位图 ───────────── */

const CROP_PY = `
import sys, json
from PIL import Image
cfg = json.load(open(sys.argv[1], encoding='utf8'))
src, out = cfg['src'], cfg['out']
box, pad_ratio, min_edge = cfg['box'], cfg['padRatio'], cfg['minEdge']
img = Image.open(src)
img.load()
w, h = img.size
left, top = box['x0'] * w, box['y0'] * h
right, bottom = box['x1'] * w, box['y1'] * h
pad = pad_ratio * max(right - left, bottom - top)
left = max(0.0, left - pad)
top = max(0.0, top - pad)
right = min(float(w), right + pad)
bottom = min(float(h), bottom + pad)
if right - left < 1 or bottom - top < 1:
    raise SystemExit('裁剪区域过小')
cropped = img.crop((int(round(left)), int(round(top)), int(round(right)), int(round(bottom))))
cw, ch = cropped.size
if min(cw, ch) < min_edge:
    scale = min_edge / float(min(cw, ch))
    cropped = cropped.resize((max(1, int(round(cw*scale))), max(1, int(round(ch*scale)))), Image.LANCZOS)
cropped.save(out, format='PNG')
print(json.dumps({'ok': True, 'width': cropped.size[0], 'height': cropped.size[1]}))
`;

const LOCATOR_PY = `
import sys, json
from PIL import Image, ImageDraw
cfg = json.load(open(sys.argv[1], encoding='utf8'))
src, out = cfg['src'], cfg['out']
box, base_edge, border = cfg['box'], cfg['baseEdge'], cfg['border']
img = Image.open(src).convert('RGB')
w, h = img.size
scale = base_edge / float(max(w, h))
bw, bh = max(1, int(round(w*scale))), max(1, int(round(h*scale)))
base = img.resize((bw, bh), Image.LANCZOS)
sx, sy = bw / float(w), bh / float(h)
left = max(0, int(round(box['x0'] * w * sx)))
top = max(0, int(round(box['y0'] * h * sy)))
right = min(bw, int(round(box['x1'] * w * sx)))
bottom = min(bh, int(round(box['y1'] * h * sy)))
left = min(left, max(0, bw - border - 1))
top = min(top, max(0, bh - border - 1))
right = max(right, min(bw, left + border + 1))
bottom = max(bottom, min(bh, top + border + 1))
ImageDraw.Draw(base).rectangle((left, top, right, bottom), outline=(255, 0, 0), width=border)
base.save(out, format='PNG')
print(json.dumps({'ok': True}))
`;

/**
 * 裁剪链路：外扩裁剪 → 最短边上采样 → 落盘 view 目录（同区域幂等）。
 * PIL 不可用时退化为原图（返回原路径），由上层在结果中标注"未裁剪"。
 */
export function cropAndZoom(
  srcPath: string,
  box: RegionBox,
  opts: { paddingRatio?: number; minEdge?: number } = {}
): { path: string; degraded: boolean } {
  if (!isPilAvailable()) return { path: srcPath, degraded: true };
  const tag = Math.abs(
    [...regionToString(box)].reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) | 0, 7)
  ).toString(36);
  const out = path.join(viewDir(), `${path.basename(srcPath, path.extname(srcPath))}_r${tag}.png`);
  try {
    runPil(CROP_PY, {
      src: srcPath,
      out,
      box,
      padRatio: opts.paddingRatio ?? DEFAULT_PADDING_RATIO,
      minEdge: opts.minEdge ?? DEFAULT_ZOOM_MIN_EDGE,
    });
    return { path: out, degraded: false };
  } catch {
    return { path: srcPath, degraded: true };
  }
}

/** 画框定位图：原图缩至长边 512、ROI 红框合成（防"放大镜迷路"） */
export function annotateLocator(
  srcPath: string,
  box: RegionBox
): { path: string; degraded: boolean } {
  if (!isPilAvailable()) return { path: srcPath, degraded: true };
  const tag = Math.abs(
    [...regionToString(box)].reduce((acc, ch) => (acc * 17 + ch.charCodeAt(0)) | 0, 5)
  ).toString(36);
  const out = path.join(viewDir(), `${path.basename(srcPath, path.extname(srcPath))}_loc${tag}.png`);
  try {
    runPil(LOCATOR_PY, {
      src: srcPath,
      out,
      box,
      baseEdge: LOCATOR_BASE_LONG_EDGE,
      border: LOCATOR_BORDER_PX,
    });
    return { path: out, degraded: false };
  } catch {
    return { path: srcPath, degraded: true };
  }
}

/* ───────────── 拼贴图面板裁剪（不缩放整图，按页裁净保清晰度） ───────────── */

const PANEL_CROP_PY = `
import sys, json
from PIL import Image, ImageOps
cfg = json.load(open(sys.argv[1], encoding='utf8'))
img = Image.open(cfg['src'])
try:
    img = ImageOps.exif_transpose(img)
except Exception:
    pass
img = img.convert('RGB')
w, h = img.size
b = cfg['box']
l = max(0, int(round(b['x0'] * w)))
t = max(0, int(round(b['y0'] * h)))
r = min(w, int(round(b['x1'] * w)))
bo = min(h, int(round(b['y1'] * h)))
if r - l < 16 or bo - t < 16:
    raise SystemExit('面板过小')
c = img.crop((l, t, r, bo))
maxe = cfg.get('maxEdge') or 1600
cw, ch = c.size
if max(cw, ch) > maxe:
    s = maxe / float(max(cw, ch))
    c = c.resize((max(1, int(round(cw * s))), max(1, int(round(ch * s)))), Image.LANCZOS)
c.save(cfg['out'], format='PNG')
print(json.dumps({'ok': True, 'width': c.size[0], 'height': c.size[1]}))
`;

/**
 * 按归一化外接框从**原图**裁剪一页幻灯片（保清晰度，最长边压到 maxEdge）。
 * 与 preprocessImage 的区别：预处理压的是整张拼贴图（24 页拼图压到 1536px
 * 后每页只剩几百像素，视觉模型必然读不清小字），裁剪必须回到原图上做。
 */
export function cropPanelToFile(
  srcPath: string,
  box: RegionBox,
  outPath: string,
  opts: { maxEdge?: number } = {}
): { ok: boolean; path: string; dimensions?: string; degraded: boolean } {
  if (!isPilAvailable()) {
    return { ok: false, path: srcPath, degraded: true };
  }
  try {
    const raw = runPil(PANEL_CROP_PY, {
      src: srcPath,
      out: outPath,
      box,
      maxEdge: opts.maxEdge ?? 1600,
    });
    const res = JSON.parse(raw.trim().split('\n').pop() ?? '{}') as {
      ok?: boolean;
      width?: number;
      height?: number;
    };
    if (!res.ok || !res.width) return { ok: false, path: srcPath, degraded: true };
    return { ok: true, path: outPath, dimensions: `${res.width}x${res.height}`, degraded: false };
  } catch {
    return { ok: false, path: srcPath, degraded: true };
  }
}

/* ───────────── 拼贴网格检测（像素投影法，视觉模型失败时的可靠兜底） ───────────── */

const GRID_PY = `
import sys, json
import numpy as np
from PIL import Image, ImageOps

cfg = json.load(open(sys.argv[1], encoding='utf8'))
img = Image.open(cfg['src'])
try:
    img = ImageOps.exif_transpose(img)
except Exception:
    pass
img = img.convert('RGB')
W0, H0 = img.size
# 关键：投影必须在**原图分辨率**上做。曾把整图缩到长边 1000 再投影，
# 结果页间 3~10px 的细缝被 LANCZOS 插值糊成 <1px 直接消失，每行都判成
# "通栏一块"，产出 13 条横条垃圾页。拼贴图的页缝信息全在这几个像素上，
# 绝不能在投影前缩放；仅当原图极大时才降采样（留足缝宽余量）。
s = 1.0 if max(W0, H0) <= 2400 else 2400.0 / float(max(W0, H0))
a = np.asarray(img.resize((max(8, int(W0*s)), max(8, int(H0*s))), Image.LANCZOS)).astype(np.float32)
H, W, _ = a.shape
gray = a.mean(axis=2)

# 背景色取四条边像素的中位色（拼贴图边缘几乎总是页面留白/底色）
edge = np.concatenate([gray[0:2].ravel(), gray[-2:].ravel(), gray[:, 0:2].ravel(), gray[:, -2:].ravel()])
bg = float(np.median(edge))
# 内容像素 = 与底色差异超过阈值（阈值随全图对比度自适应，避免深色模板误判）
spread = float(np.percentile(np.abs(gray - bg), 99))
thr = max(10.0, min(60.0, spread * 0.35))
mask = np.abs(gray - bg) > thr

def bands(flags, min_len):
    out, start = [], None
    for i, f in enumerate(flags):
        if f and start is None:
            start = i
        elif not f and start is not None:
            if i - start >= min_len:
                out.append((start, i))
            start = None
    if start is not None and len(flags) - start >= min_len:
        out.append((start, len(flags)))
    return out

# 行带：该行有 >=2% 宽度的内容像素即算内容行；极窄带丢弃（多为分隔线/噪点）
row_has = mask.sum(axis=1) > max(2, int(W * 0.02))
row_bands = bands(row_has, max(4, int(H * 0.015)))

def col_groups(y0, y1, gap_px):
    # 行内列组：该列在本行带内 >=5% 高度有内容即算内容列。相邻列组之间的
    # 缝宽若小于 gap_px 就合并——页内同色块常把页间窄缝糊住，必须靠合并消解
    seg = mask[y0:y1, :]
    h_seg = max(1, y1 - y0)
    col_has = seg.sum(axis=0) >= max(1, int(h_seg * 0.05))
    raw = bands(col_has, max(2, int(W * 0.010)))
    if not raw:
        return [[0, W]]
    merged = []
    for b0, b1 in raw:
        if merged and gap_px > (b0 - merged[-1][1]):
            merged[-1][1] = b1
        else:
            merged.append([b0, b1])
    return merged

# 两遍法：先用多组候选缝宽试切，选出"切出最多双列行"的缝宽，再用它统一
# 切所有行。为什么不能单行独立判断：页间距往往只有几像素，单看某一行会被
# 页内同色块糊住；多行投票才能稳定还原真实栏位，也才能正确处理
# "通栏页（封面/结尾横跨两列）+ 双列页"混排——通栏行在该缝宽下天然只有
# 一条列组，自动保持整行。
cands = [max(3, int(W*0.004)), max(3, int(W*0.010)), max(3, int(W*0.020)), max(3, int(W*0.035))]
best_cnt = -1
chosen = cands[0]
for gp in cands:
    cnt = 0
    for (y0, y1) in row_bands:
        if len(col_groups(y0, y1, gp)) >= 2:
            cnt += 1
    if cnt > best_cnt:
        best_cnt = cnt
        chosen = gp

panels = []
for (y0, y1) in row_bands:
    for (x0, x1) in col_groups(y0, y1, chosen):
        if (x1 - x0) >= W * 0.02 and (y1 - y0) >= H * 0.008:
            panels.append({
                'x0': round(x0 / float(W), 4), 'y0': round(y0 / float(H), 4),
                'x1': round(x1 / float(W), 4), 'y1': round(y1 / float(H), 4),
            })

print(json.dumps({'ok': True, 'panels': panels, 'gap': chosen, 'rows': len(row_bands)}, ensure_ascii=False))
`;

/**
 * 像素投影法检测拼贴网格：找"整行/整列都是底色"的留白缝，用缝切页。
 * 为什么需要这条兜底：视觉模型可能把竖长的 24 页全览误判成"单页"，
 * 均分网格又会因为通栏页（封面/结尾横跨两列）而切歪。留白缝检测直接
 * 从像素上还原真实边界，通栏页天然只有一条列带 → 自动识别为整行页。
 */
export function detectPanelGrid(
  srcPath: string
): { ok: boolean; panels: RegionBox[]; degraded: boolean } {
  if (!isPilAvailable()) return { ok: false, panels: [], degraded: true };
  try {
    const raw = runPil(GRID_PY, { src: srcPath });
    const res = JSON.parse(raw.trim().split('\n').pop() ?? '{}') as {
      ok?: boolean;
      panels?: Array<{ x0: number; y0: number; x1: number; y1: number }>;
    };
    const list = (res.panels ?? []).filter(
      (p) => p.x1 - p.x0 > 0.02 && p.y1 - p.y0 > 0.02
    );
    if (!res.ok || list.length === 0) return { ok: false, panels: [], degraded: true };
    // 可信度闸门：全部面板都横跨整幅（单列）时，说明缝检测失败了——真实
    // 多页拼贴必然有横向分栏，或本身就是纯纵向堆叠。前者被误判成单列时
    // 继续用会产出"整行一条"的垃圾页，宁可不给结果让调用方走均分兜底。
    const fullWidth = list.every((p) => p.x1 - p.x0 >= 0.9);
    if (fullWidth && list.length > 1) return { ok: false, panels: [], degraded: true };
    return { ok: true, panels: list, degraded: false };
  } catch {
    return { ok: false, panels: [], degraded: true };
  }
}

/** 组装 data URL（MIME 取真实嗅探结果，避免把 jpg 错标 png） */
export function toDataUrl(filePath: string): { dataUrl: string; mime: string } {
  const sniff = sniffFormat(filePath);
  const mime = sniff?.mime ?? 'image/png';
  const payload = fs.readFileSync(filePath).toString('base64');
  return { dataUrl: `data:${mime};base64,${payload}`, mime };
}
