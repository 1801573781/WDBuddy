/**
 * template.from_image — 图片 → PPT 克隆模板（视觉链路入口工具）
 *
 * 流程：读图（base64）→ 视觉模型提取 DesignSpec（JSON）→ 校验归一化
 * → python-pptx 渲染为模板 pptx → 引擎级自检（scanTemplate 槽位角色）
 * → 注册到用户模板目录（模版库可见、office.generate template 参数可用）。
 *
 * 视觉模型调用经 ToolContext.visionChat 注入（Main 配置 VisionConfig）；
 * 未配置时给出明确指引（引导用户到设置页配置视觉模型）。
 */
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import type { AgentTool, ToolContext, ToolResult } from './registry.js';
import { makeArtifact } from './registry.js';
import {
  buildSpecPrompt,
  parseSpecFromText,
  parseSpec,
  parsePanelsFromText,
  looseParseJson,
  type PanelInfo,
} from './pptx/design-spec.js';
import { renderSpecToPptx } from './pptx/spec-renderer.js';
import { registerUserTemplate } from './pptx/clone-registry.js';
import { scanTemplate } from './pptx/template-clone.js';
import { invalidateTemplatesPreviewCache } from './templates-preview.js';
import {
  preprocessImage,
  sniffFormat,
  toDataUrl,
  cropPanelToFile,
  detectPanelGrid,
  readDimensions,
  visionWorkRoot,
} from '../vision/image-processor.js';
import { EXTRACT_FULL_PROMPT, PANELS_PROMPT, buildPanelSpecPrompt } from '../vision/prompts.js';
import type { DesignSpec, SpecColor, SpecSlide } from '@wdbuddy/shared-types';

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** 工作空间根（响应落盘位置；无工作空间时退化为系统临时目录） */
function workspaceRootOf(ctx: ToolContext): string {
  return ctx.workspaceRoots[0] ?? os.tmpdir();
}

/** 结构化描述 → DesignSpec（JSON 直出失败时的第二通道：
 *  先让视觉模型自由转述图像（分区文本），再单独要求它基于转述输出 JSON。
 *  相比"一次赌严格 JSON"，转述阶段容错高，第二段只做格式转换，成功率显著提升） */
async function specFromDescription(
  visionChat: ToolContext['visionChat'],
  dataUrl: string,
  userName: string
): Promise<DesignSpec | null> {
  if (!visionChat) return null;
  try {
    const description = await visionChat(
      [{ role: 'user', content: EXTRACT_FULL_PROMPT, images: [dataUrl] }],
      { maxTokens: 4096, temperature: 0.1 }
    );
    const text = await visionChat(
      [
        {
          role: 'user',
          content: `下面是一张幻灯片设计图的详细结构化转述。请据此输出 DesignSpec JSON（只输出 JSON，不要解释）。\n${userName ? `模板名固定用「${userName}」。` : ''}\n\n${buildSpecPrompt()}\n\n【图像转述】\n${description.slice(0, 12000)}`,
        },
      ],
      { maxTokens: 8192, temperature: 0.1 }
    );
    return parseSpecFromText(text);
  } catch {
    return null;
  }
}

/** 面板识别：先问"这张图是单页还是拼贴，每页在哪"，再按框裁原图。
 *  单页图直接返回整幅框（不裁剪，省一次子进程）。 */
async function detectPanels(
  visionChat: ToolContext['visionChat'],
  dataUrl: string,
  aspectHint = ''
): Promise<{ layout: 'single' | 'collage'; panels: PanelInfo[] }> {
  const fallback = { layout: 'single' as const, panels: [{ index: 1, kind: 'unknown', box: { x0: 0, y0: 0, x1: 1, y1: 1 } }] };
  if (!visionChat) return fallback;
  try {
    const text = await visionChat(
      [{ role: 'user', content: PANELS_PROMPT + aspectHint, images: [dataUrl] }],
      { maxTokens: 4096, temperature: 0 }
    );
    return parsePanelsFromText(text);
  } catch {
    return fallback;
  }
}

/** 面板级提取结果：文字槽 + 该页风格 */
interface PanelExtract {
  kind: string;
  vibe?: string;
  tone?: { bg?: string; text?: string; accent?: string };
  slots: NonNullable<DesignSpec['slides']>[number]['slots'];
}

/** 单页精确提取（输入必须是**已裁净**的单页图，最长边 1600 保小字清晰）。
 *  与旧链路的关键差别：旧链路把 24 页拼贴图整图压到 1536px 后一次性提取，
 *  每页只剩几十像素高——模型不可能读出小字与几何，只能"编"出一个大概版式，
 *  这就是生成两页与原图毫不相干的直接原因。 */
async function extractPanel(
  visionChat: ToolContext['visionChat'],
  panelDataUrl: string,
  hintKind: string
): Promise<PanelExtract | null> {
  if (!visionChat) return null;
  const prompt = `${buildPanelSpecPrompt()}\n\n（参考：该页在拼贴全览图中被识别为 kind≈${hintKind}，可据此校正，但以本图实际内容为准。）`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const extra = attempt === 0 ? '' : '\n上次输出不是合法 JSON。请直接以 { 开头、} 结尾，不要围栏与解释。';
    let text = '';
    try {
      text = await visionChat(
        [{ role: 'user', content: prompt + extra, images: [panelDataUrl] }],
        { maxTokens: 6144, temperature: 0.1 }
      );
    } catch {
      continue;
    }
    let json: unknown = null;
    try {
      json = looseParseJson(text);
    } catch {
      json = null;
    }
    if (!json || typeof json !== 'object') continue;
    const obj = json as Record<string, unknown>;
    const rawSlots = Array.isArray(obj['slots']) ? obj['slots'] : [];
    if (rawSlots.length === 0) continue;
    try {
      // 借道 parseSpec 的归一化（颜色/几何/对齐/角色全域收敛），只拼一个最小 spec
      const toneRaw = (obj['tone'] ?? {}) as Record<string, unknown>;
      // 色板必须保证 2 个合法 hex，否则 parseSpec 直接抛"色板颜色少于 2 个"
      const safeHex = (v: unknown, dflt: string): string =>
        typeof v === 'string' && /^#?[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(v.trim()) ? v.trim() : dflt;
      const normalized = parseSpec({
        name: 'tmp',
        colors: [
          { hex: safeHex(toneRaw['bg'], '#0e1e3c'), usage: '主背景' },
          { hex: safeHex(toneRaw['text'], '#ffffff'), usage: '正文文字' },
          { hex: safeHex(toneRaw['accent'], '#35d6ff'), usage: '强调一' },
        ],
        slides: [{ kind: typeof obj['kind'] === 'string' ? obj['kind'] : hintKind, slots: rawSlots }],
      });
      // tone 必须取 parseSpec 归一化后的合法 hex（原始输出常是"深蓝"或
      // 缺 # 的散串，直接透传给 python 渲染器会在 int(h,16) 处抛错）
      const pick = (usage: string): string | undefined =>
        normalized.colors.find((c) => (c.usage ?? '') === usage)?.hex;
      const pageBg = pick('主背景') ?? '#0e1e3c';
      const slots = normalized.slides[0]?.slots ?? [];
      // 背景遮罩兜底：视觉模式靠 bg 盖住原图像素文字，模型漏填就会让
      // 原图字与新文字重影（改字后旧字仍在，功能上等于不可用）
      for (const s of slots) {
        if (s.type === 'text' && !s.bg) s.bg = pageBg;
      }
      return {
        kind: normalized.slides[0]?.kind ?? 'content',
        vibe: typeof obj['vibe'] === 'string' ? obj['vibe'].slice(0, 60) : undefined,
        tone: {
          bg: pick('主背景'),
          text: pick('正文文字'),
          accent: pick('强调一'),
        },
        slots,
      };
    } catch {
      continue;
    }
  }
  return null;
}

export const templateFromImageTool: AgentTool = {
  name: 'template.from_image',
  description:
    '把一张幻灯片设计参考图（jpg/png/webp）转化为可复用的 PPT 克隆模板：视觉模型分析图片的色板/版式/槽位几何，程序化重建为 .pptx 模板并注册到模版库。参数：image（图片绝对路径）、name（可选，模板名，缺省由视觉模型命名）。产物直接用于 office.generate 的 template 参数。前置条件：设置中已配置视觉模型（Vision Provider）。图片建议为单页或几页的幻灯片设计图',
  sensitivity: 'write',
  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    const image = typeof args['image'] === 'string' ? (args['image'] as string).trim() : '';
    if (!image) {
      return { ok: false, output: '缺少 image 参数（设计参考图的绝对路径）', artifacts: [] };
    }
    // 视觉模型注入检查
    if (!ctx.visionChat) {
      return {
        ok: false,
        output:
          '多模态模型未配置。请在 设置 → 模型 → 多模态模型 中添加一个（Base URL / 模型名 / API Key，需为 OpenAI 兼容的多模态端点，如 GLM-4V / GPT-4o / Qwen-VL）。添加后重新发起任务即可使用 template.from_image。',
        artifacts: [],
      };
    }

    // 1) 读图（fsGuard 允许 full 权限或工作空间内；default 权限工作空间外读
    //    会被拒——提示用户把图放进工作空间或开 full）
    let prepared;
    try {
      // 先用 fsGuard 做一次访问裁决（越界即抛错，给出可操作提示）
      ctx.fsGuard.readFile(image, 'binary');
      // 魔数校验 / EXIF 修正 / 动图取首帧 / 最长边压缩：
      // 4K 截图直传会挤爆视觉 token 预算，模型只能给泛泛描述——这是
      // "读图很差"的主因之一，必须先过预处理管线
      prepared = preprocessImage(image);
    } catch (err) {
      return {
        ok: false,
        output: `读取图片失败：${String(err)}。若图片在工作空间外，请把它复制到工作空间内，或使用完全访问权限`,
        artifacts: [],
      };
    }
    const sniff = sniffFormat(prepared.path);
    if (!sniff) {
      return { ok: false, output: `图片格式无法识别（支持 PNG/JPEG/GIF/BMP/WEBP）：${image}`, artifacts: [] };
    }
    const size = fs.statSync(prepared.path).size;
    if (size > 10 * 1024 * 1024) {
      return {
        ok: false,
        output: `图片过大（${(size / 1024 / 1024).toFixed(1)}MB，上限 10MB），请先行压缩：${image}`,
        artifacts: [],
      };
    }
    // data URL 的 MIME 取真实魔数（旧实现按扩展名硬编码，jpg 常被错标 png）
    const dataUrl = toDataUrl(prepared.path).dataUrl;

    // ── 主路径：拼贴感知的逐页高保真重建（visual 模式）──
    // 旧链路是"整图 → 一次 DesignSpec → 程序化矢量重建"，对拼贴全览图三重失效：
    //  (1) 整图压到 1536px 后，24 页拼图里每页只剩几十像素高，小字与几何根本读不出来；
    //  (2) 提示词要求"逐页输出全部槽位几何"，一次生成 24 页坐标必然截断/幻觉，
    //      模型只能退回泛化描述，产出与原图毫不相干的页面；
    //  (3) 矢量图元只有矩形/圆/线，无法表达星空/渐变/光晕/照片/发光图标——
    //      还原度上限由表达力决定，换提示词也修不了。
    // 新链路：定位每页 → 回原图裁净 → 逐页只提取文字槽 → 参考图像素铺底 + 文字可编辑。
    // 逐页单图提取把"多页几何一次生成"降维成"单页几何一次生成"，这是精度的分水岭。
    const nameArg = typeof args['name'] === 'string' ? (args['name'] as string).trim() : '';
    let panelSpec: DesignSpec | null = null;
    let panelNote = '';
    try {
      // 纵横比提示：单页幻灯片必然是 16:9（或 4:3）的横向画幅；参考图若
      // 明显是竖长条（如 500×1266），那它在物理上就不可能是单页——
      // 模型误判为 single 时必须纠正，否则会拿整张拼图当一页铺底
      const dims = readDimensions(image).split('x').map((v) => Number(v));
      const iw = dims[0] ?? 0;
      const ih = dims[1] ?? 0;
      const ratio = iw > 0 && ih > 0 ? iw / ih : 0;
      const wideEnough = ratio >= 1.2;
      const aspectHint = ratio > 0
        ? `\n\n【本图客观信息】原图像素 ${iw}x${ih}（宽高比 ${ratio.toFixed(2)}）。${
            wideEnough
              ? '画幅接近单页横向幻灯片。'
              : '画幅明显不是横向幻灯片（16:9≈1.78），极大概率是多页拼贴，请务必逐页给出 panel 框。'
          }`
        : '';
      const detected = await detectPanels(ctx.visionChat, dataUrl, aspectHint);
      // 上限 24：参考图本身就是"整份模板全览"（常见 13 行 × 2 列），
      // 截断会直接丢页——而模板的价值恰恰在于页型齐全
      let panels = detected.panels.slice(0, 24);
      let panelSource = panels.length > 1 ? '模型定位' : '整图';
      // 三级兜底：模型给不出多页框时，回到像素层用"留白缝投影"切页。
      // 为什么不能只靠模型：竖长的整份模板全览极易被误判成单页，而均分
      // 网格又会被通栏页（封面/结尾横跨两列）切歪；留白缝是真实边界，
      // 通栏页天然只有一条列带 → 自动识别成整行页。
      if (panels.length === 1) {
        const grid = detectPanelGrid(image);
        if (grid.ok && grid.panels.length > 1) {
          panels = grid.panels.map((b, i) => ({ index: i + 1, kind: 'unknown', box: b }));
          panelSource = '像素留白缝检测';
        } else if (ratio > 0 && ratio < 1.0) {
          // 最后兜底：均分网格（2 列）。宁可留白缝，也不能把整份全览压成一张
          const rows = Math.min(16, Math.max(2, Math.round(ih / (iw / 2))));
          panels = [];
          for (let r = 0; r < rows; r++) {
            for (let c = 0; c < 2; c++) {
              panels.push({
                index: panels.length + 1,
                kind: 'unknown',
                box: { x0: c / 2, y0: r / rows, x1: (c + 1) / 2, y1: (r + 1) / rows },
              });
            }
          }
          panelSource = '均分网格兜底';
        }
      }
      const collage = panels.length > 1;
      const panelDir = path.join(visionWorkRoot(), `panels_${Date.now().toString(36)}`);
      fs.mkdirSync(panelDir, { recursive: true });
      const slides: SpecSlide[] = [];
      const colors: SpecColor[] = [];
      let vibe: string | undefined;
      let skipped = 0;
      for (const panel of panels) {
        let panelPath = prepared.path;
        {
          const out = path.join(panelDir, `p${String(panel.index).padStart(2, '0')}.png`);
          // 关键：裁剪必须回**原图**做（prepared 已压到 1536，再裁只会更糊）。
          // 单页图同样走这一步：统一裁净 + 控制在 1600px，兼顾清晰度与体积
          const crop = cropPanelToFile(image, panel.box, out, { maxEdge: 1600 });
          if (crop.ok) {
            panelPath = crop.path;
          } else if (collage) {
            // 拼贴图却裁不开（PIL 缺失/面板框异常）：若继续，会把整张拼图
            // 重复塞给每一页，产出 N 份相同且错位的页面。直接放弃逐页链路，
            // 回到整图提取（至少只产 1 页）。
            throw new Error('拼贴面板裁剪不可用（需 python + PIL），已回退整图提取');
          } else {
            panelPath = prepared.path;
          }
        }
        const panelUrl = toDataUrl(panelPath).dataUrl;
        const extracted = await extractPanel(ctx.visionChat, panelUrl, panel.kind);
        if (!extracted || extracted.slots.length === 0) {
          skipped++;
          continue;
        }
        if (extracted.tone?.bg) colors.push({ hex: extracted.tone.bg, usage: '主背景' });
        if (extracted.tone?.text) colors.push({ hex: extracted.tone.text, usage: '正文文字' });
        if (extracted.tone?.accent) colors.push({ hex: extracted.tone.accent, usage: '强调一' });
        vibe = vibe ?? extracted.vibe;
        slides.push({
          kind: extracted.kind,
          templateName: nameArg || '图片模板',
          sourceImage: panelPath,
          slots: extracted.slots,
        });
      }
      if (slides.length > 0) {
        // 色板去重（逐页 tone 大量重复），保留前 8 个用途
        const seen = new Set<string>();
        const palette: SpecColor[] = [];
        for (const c of colors) {
          const h = c.hex.toLowerCase();
          if (seen.has(h)) continue;
          seen.add(h);
          palette.push(c);
          if (palette.length >= 8) break;
        }
        if (palette.length < 2) {
          palette.push({ hex: '#0e1e3c', usage: '主背景' }, { hex: '#ffffff', usage: '正文文字' });
        }
        panelSpec = {
          name: nameArg || '图片模板',
          vibe: vibe ?? '由参考图逐页还原',
          colors: palette,
          font: '微软雅黑',
          // 默认视觉模式：像素承载不可重建的视觉，文字槽承载用户要改的内容
          mode: 'visual',
          image: prepared.path,
          slides,
        };
        panelNote = collage
          ? `${panelSource}：${panels.length} 页 → 成功还原 ${slides.length} 页${skipped > 0 ? `（跳过 ${skipped} 页）` : ''}`
          : `单页设计图 → 已还原 ${slides.length} 页`;
      }
    } catch (err) {
      panelNote = `逐页重建不可用（${String(err).slice(0, 120)}），回退整图提取`;
    }

    // 2) 视觉模型提取 DesignSpec（最多 2 次重试：JSON 解析失败反馈重试）。
    //    每次原始响应都落盘存档（workspace/vision-response-*.md）：失败时
    //    Agent/用户可直接读原始输出排查，不再"黑盒报错+去工作空间猜文件"
    //    （10/16 事故：Agent 找不到原始响应，被开发残留 .txt 误导空转 1 小时）
    const userName = nameArg;
    let spec: DesignSpec | null = panelSpec;
    let lastErr = '';
    let lastRawFile = '';
    // 逐页重建已成功 → 不再跑整图提取（整图提取是拼贴图的"低清猜测"，
    // 结果必然更差；只有逐页链路整体失败时才回退）
    for (let attempt = 0; spec === null && attempt < 2; attempt++) {
      const extra = attempt === 0 ? '' : `\n上次输出解析失败：${lastErr.slice(0, 300)}。请严格按 JSON 格式重新输出：直接以 { 开头、} 结尾，不要 markdown 围栏、不要注释、字符串内不要出现未转义引号，不要遗漏必填字段。`;
      const text = await ctx.visionChat(
        [
          { role: 'system', content: buildSpecPrompt() },
          {
            role: 'user',
            content: `请分析这张幻灯片设计图，输出 DesignSpec JSON。${userName ? `模板名固定用「${userName}」。` : ''}${extra}`,
            images: [dataUrl],
          },
        ],
        { maxTokens: 8192 }
      );
      // 落盘存档（工作空间根，一次一份带时间戳；fsGuard 写入失败不阻断主流程）
      const stamp = Date.now().toString(36);
      const dumpPath = path.join(workspaceRootOf(ctx), `vision-response-${stamp}.md`);
      try {
        ctx.fsGuard.writeFile(
          dumpPath,
          `# 视觉模型原始响应（template.from_image 第 ${attempt + 1} 次调用）\n\n图片：${image}\n\n---\n\n${text}\n`
        );
        lastRawFile = dumpPath;
      } catch {
        /* 落盘失败不阻断：报错信息里已含 500 字符预览 */
      }
      try {
        spec = parseSpecFromText(text);
        break;
      } catch (err) {
        lastErr = String(err instanceof Error ? err.message : err);
      }
    }
    // 第三通道兜底：严格 JSON 两次都失败时，改为"先自由转述图像、再格式化"。
    // 视觉模型写长文字比写严格 JSON 稳得多，转述后再转 JSON 成功率显著提升
    if (!spec) {
      spec = await specFromDescription(ctx.visionChat, dataUrl, userName);
    }
    if (!spec) {
      return {
        ok: false,
        output: [
          `视觉模型输出解析失败（重试 2 次）：${lastErr}`,
          lastRawFile
            ? `原始响应已存档：${lastRawFile}（可直接 fs.read 查看模型到底输出了什么；若为纯文字描述而非 JSON，说明该模型不适合此任务，请建议用户更换视觉模型，如 glm-4v-plus / gpt-4o / qwen-vl-plus）`
            : '（原始响应落盘失败，见上方 500 字符预览）',
          '排查指引：① 读原始响应确认模型输出形态；② 若模型反复输出长文字说明，属模型能力不匹配，不要在本地反复解析——建议用户换用视觉模型后重试。',
        ].join('\n'),
        artifacts: [],
      };
    }
    if (spec.slides.length === 0) {
      return {
        ok: false,
        output: `视觉模型判定图片非幻灯片设计图（vibe：${spec.vibe ?? '无'}）。请提供单页或多页幻灯片设计参考图`,
        artifacts: [],
      };
    }
    // 回退链路（整图提取）同样走视觉铺底：即便槽位坐标是猜的，至少背景
    // 与参考图一致，不会出现"两页与原图毫不相干"的成品
    if (!spec.image) spec.image = prepared.path;
    if (!spec.mode) spec.mode = 'visual';
    for (const sl of spec.slides) {
      if (!sl.sourceImage) sl.sourceImage = prepared.path;
    }

    // 3) 渲染为模板 pptx（python-pptx；产物落临时目录，注册后进用户模板目录）
    const tmpOut = path.join(os.tmpdir(), `wd_tplimg_${Date.now()}.pptx`);
    const render = renderSpecToPptx(spec, tmpOut);
    if (!render.ok) {
      return { ok: false, output: `模板渲染失败（python 侧）：${render.output}`, artifacts: [] };
    }

    // 4) 引擎级自检：scanTemplate 确认可被克隆引擎识别
    const scan = scanTemplate(tmpOut);
    if (!scan.ok || scan.pages.length === 0) {
      try { fs.unlinkSync(tmpOut); } catch { /* */ }
      return { ok: false, output: `渲染产物未通过克隆引擎自检：${scan.error ?? '无可用页面'}。${render.output.slice(0, 500)}`, artifacts: [] };
    }

    // 5) 注册到用户模板目录（模版库可见 + template 参数可引用）
    const tags = ['图片生成', '自定义', ...spec.colors.slice(0, 3).map((c) => c.usage ?? '色板')].slice(0, 6);
    const reg = registerUserTemplate({
      pptxPath: tmpOut,
      name: userName || spec.name,
      vibe: spec.vibe ?? '由图片生成的自定义模板',
      tags,
    });
    if (!reg.ok) {
      try { fs.unlinkSync(tmpOut); } catch { /* */ }
      return { ok: false, output: `模板注册失败：${reg.error}`, artifacts: [] };
    }
    invalidateTemplatesPreviewCache();

    // 6) 模板文件本体也作为 artifact 交付（预览/归档）
    const tplBuf = fs.readFileSync(reg.file);
    const art = makeArtifact(
      ctx.taskId,
      'file',
      reg.file,
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      sha256(tplBuf)
    );
    ctx.onArtifact?.(art);
    try { fs.unlinkSync(tmpOut); } catch { /* */ }

    // 7) 输出摘要（模板 id / 引用方式 / 版式构成）
    const kinds = [...new Set(scan.pages.map((p) => p.kind))];
    const colors = spec.colors.slice(0, 5).map((c) => c.hex).join(' ');
    return {
      ok: true,
      output: [
        `已从图片生成 PPT 克隆模板「${userName || spec.name}」并注册到模版库：`,
        `  📄 模板文件：${reg.file}（${tplBuf.length} 字节，${scan.pages.length} 页）`,
        `  🎨 色板：${colors}`,
        `  🧩 版式：${kinds.join(' / ')}`,
        `  🖼 还原方式：${(spec.mode ?? 'visual') === 'vector' ? '矢量重建（仅几何图元，还原度有限）' : '视觉铺底（参考图像素复刻 + 文字可编辑）'}`,
        panelNote ? `  🔍 解析：${panelNote}` : '',
        `  ▶ 使用方式：office.generate 传 template="${reg.id}"（或模板名），即可用此模板克隆生成演示文稿`,
        `  自检：${render.output.includes('SELF_CHECK PASSED') ? '通过' : '通过（含警告）'}`,
      ]
        .filter((line) => line !== '')
        .join('\n'),
      artifacts: [art],
    };
  },
};
