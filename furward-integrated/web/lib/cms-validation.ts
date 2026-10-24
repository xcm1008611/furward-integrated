import type { ImageSlot, Section, SectionItem, SiteContent } from "@/lib/content";
import { FURWARD_SCHEMA_VERSION } from "@/lib/content";

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MEDIA_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpg|png|webp|gif)$/;
const SECTION_IDS = new Set(["hero", "about", "scenes", "companion", "textures", "warmth", "technology", "gallery", "footer"]);
const TECHNOLOGY_IDS = new Set(["perception", "guidance", "dialogue", "touch"]);

export class CmsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CmsValidationError";
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CmsValidationError(`${label}格式不正确。`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, max: number, required = false): string {
  if (typeof value !== "string" || value.length > max || (required && !value.trim())) {
    throw new CmsValidationError(`${label}${required ? "不能为空，且" : ""}最多 ${max} 个字符。`);
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
    throw new CmsValidationError(`${label}包含无效字符。`);
  }
  return value;
}

export function validateLink(value: unknown, label = "链接"): string {
  const link = text(value, label, 2048).trim();
  if (!link || /^#[a-zA-Z0-9_-]*$/.test(link)) return link;
  if (/^\/(?:on-track|off-track|calendar|admin)?(?:#[a-zA-Z0-9_-]+)?$/.test(link)) return link;
  if (/^mailto:[^\s<>@]+@[^\s<>@]+$/i.test(link) && !/%0[ad]/i.test(link)) return link;
  try {
    const url = new URL(link);
    if (url.protocol === "https:" && url.hostname && !url.username && !url.password && !/[\r\n\\]/.test(link)) {
      return url.href;
    }
  } catch { /* Invalid URLs get the same helpful error below. */ }
  throw new CmsValidationError(`${label}请填写 https:// 网页地址、mailto: 邮箱或 #板块名称。`);
}

export function validateImageSrc(value: unknown): string {
  const src = text(value, "图片地址", 512, true);
  if (src.startsWith("/api/media/") && MEDIA_ID_PATTERN.test(src.slice("/api/media/".length))) return src;
  if (/^\/reference\/furward(?:-v3)?\/[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(src) && !src.includes("..") && !src.includes("//")) return src;
  throw new CmsValidationError("图片请从素材库选择，或使用本站 /reference/furward/、/reference/furward-v3/ 下的图片。");
}

function imageSlot(value: unknown): ImageSlot {
  const image = record(value, "图片");
  const id = text(image.id, "图片编号", 80, true);
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new CmsValidationError("图片编号只能包含字母、数字、短横线或下划线。");
  for (const key of ["positionX", "positionY"]) {
    if (typeof image[key] !== "number" || !Number.isFinite(image[key]) || image[key] < 0 || image[key] > 100) {
      throw new CmsValidationError("图片位置必须在 0 到 100 之间。");
    }
  }
  const scale = image.scale === undefined ? 1 : image.scale;
  if (typeof scale !== "number" || !Number.isFinite(scale) || scale < 0.5 || scale > 2) throw new CmsValidationError("图片大小必须在 50% 到 200% 之间。");
  return {
    id,
    label: text(image.label, "图片用途", 100, true),
    src: validateImageSrc(image.src),
    alt: text(image.alt, "图片说明", 300),
    positionX: image.positionX as number,
    positionY: image.positionY as number,
    scale,
  };
}

function section(value: unknown): Section {
  const item = record(value, "板块");
  if (typeof item.id !== "string" || !SECTION_IDS.has(item.id)) throw new CmsValidationError("板块编号不正确。");
  if (typeof item.enabled !== "boolean") throw new CmsValidationError("板块显示状态不正确。");
  if (!Array.isArray(item.images) || item.images.length > 60) throw new CmsValidationError("每个板块最多 60 张图片。");
  const images = item.images.map(imageSlot);
  if (new Set(images.map((image) => image.id)).size !== images.length) throw new CmsValidationError("同一板块的图片编号不能重复。");
  let items: SectionItem[] | undefined;
  if (item.items !== undefined) {
    if (!Array.isArray(item.items) || item.items.length > 20) throw new CmsValidationError("每个板块最多 20 个说明条目。");
    items = item.items.map(value => {
      const entry = record(value, "说明条目");
      const id = text(entry.id, "条目编号", 80, true);
      if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new CmsValidationError("条目编号格式不正确。");
      return { id, title: text(entry.title, "条目标题", 100, true), eyebrow: text(entry.eyebrow, "条目小标题", 150), description: text(entry.description, "条目说明", 2000) };
    });
    if (new Set(items.map(entry => entry.id)).size !== items.length) throw new CmsValidationError("条目编号不能重复。");
  }
  if (item.id === "technology" && (!items || items.length !== 4 || items.some(entry => !TECHNOLOGY_IDS.has(entry.id)))) throw new CmsValidationError("设计思路需要保留感知、引路、对话、触感四个条目。");
  return {
    id: item.id,
    enabled: item.enabled,
    title: text(item.title, "板块标题", 200),
    eyebrow: text(item.eyebrow, "板块小标题", 150),
    description: text(item.description, "板块说明", 2000),
    buttonLabel: text(item.buttonLabel, "按钮文字", 80),
    buttonHref: validateLink(item.buttonHref, "按钮链接"),
    images,
    ...(items ? { items } : {}),
  };
}

export function validateContent(value: unknown): SiteContent {
  const input = record(value, "网站内容");
  if (input.schemaVersion !== FURWARD_SCHEMA_VERSION) throw new CmsValidationError(`内容已升级为绒途 v${FURWARD_SCHEMA_VERSION}，旧版页面或草稿不能直接覆盖。请刷新后台后重新编辑；旧内容仍保留在迁移备份中。`);
  const site = record(input.site, "网站设置");
  if (typeof site.accent !== "string" || !/^#[0-9a-fA-F]{6}$/.test(site.accent)) throw new CmsValidationError("主题色请使用六位颜色值，例如 #d2ff00。");
  if (!Array.isArray(input.sections) || input.sections.length !== SECTION_IDS.size) throw new CmsValidationError("网站需要保留全部 9 个板块；不需要的板块可关闭显示。");
  const sections = input.sections.map(section);
  if (new Set(sections.map((item) => item.id)).size !== SECTION_IDS.size) throw new CmsValidationError("板块编号不能重复。");
  if (sections.reduce((count, item) => count + item.images.length, 0) > 250) throw new CmsValidationError("整个网站最多使用 250 张图片。");
  return {
    schemaVersion: FURWARD_SCHEMA_VERSION,
    site: {
      name: text(site.name, "网站名称", 100, true),
      tagline: text(site.tagline, "网站标语", 200),
      accent: site.accent,
      footerText: text(site.footerText, "页脚文字", 500),
      instagram: validateLink(site.instagram, "Instagram 链接"),
      youtube: validateLink(site.youtube, "YouTube 链接"),
      tiktok: validateLink(site.tiktok, "TikTok 链接"),
    },
    sections,
  };
}

export function validateSavePayload(value: unknown): { content: SiteContent; expectedRevision: number } {
  const input = record(value, "保存内容");
  if (typeof input.expectedRevision !== "number" || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
    throw new CmsValidationError("页面版本不正确，请刷新后台后重试。");
  }
  return { content: validateContent(input.content), expectedRevision: input.expectedRevision };
}

/** The reverse proxy must overwrite X-Forwarded-Proto, not append client input. */
export function getRequestProtocol(request: Request): "http:" | "https:" | null {
  const direct = new URL(request.url).protocol;
  const forwarded = request.headers.get("x-forwarded-proto")?.trim().toLowerCase();
  if (forwarded !== undefined && forwarded !== "http" && forwarded !== "https") return null;
  // A forwarded header can upgrade an internal HTTP hop but cannot downgrade TLS.
  if (direct === "https:" || forwarded === "https") return "https:";
  return direct === "http:" ? "http:" : null;
}

export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site")?.trim().toLowerCase();
  if (fetchSite === "cross-site") return false;
  // CLI clients omit both headers. A browser reporting a different site must
  // not bypass CSRF checks simply by omitting Origin.
  if (origin === null) return !fetchSite || fetchSite === "same-origin" || fetchSite === "none";
  try {
    const protocol = getRequestProtocol(request);
    if (!protocol) return false;
    // Next can construct request.url with an internal localhost hostname.
    // Host identifies the browser's destination; never trust X-Forwarded-Host.
    const host = request.headers.get("host") ?? new URL(request.url).host;
    if (!host || /[\s,\\/?#@]/.test(host)) return false;
    const expected = new URL(`${protocol}//${host}`);
    const source = new URL(origin);
    if (source.username || source.password || source.pathname !== "/" || source.search || source.hash) return false;
    return source.protocol === protocol && source.host === expected.host;
  } catch { return false; }
}

export async function readLimitedBody(request: Request, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const declared = request.headers.get("content-length");
  if (declared && Number(declared) > maxBytes) throw new CmsValidationError("上传内容太大，请缩小后重试。");
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new CmsValidationError("上传内容太大，请缩小后重试。");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
  return body;
}

export function detectImage(bytes: Uint8Array, declaredType: string): { extension: string; type: string } {
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new CmsValidationError("图片不能为空，且每张不能超过 10 MB。");
  const starts = (...signature: number[]) => signature.every((byte, index) => bytes[index] === byte);
  let detected: { extension: string; type: string } | undefined;
  if (starts(0xff, 0xd8, 0xff)) detected = { extension: "jpg", type: "image/jpeg" };
  else if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) detected = { extension: "png", type: "image/png" };
  else if (starts(0x47, 0x49, 0x46, 0x38, 0x37, 0x61) || starts(0x47, 0x49, 0x46, 0x38, 0x39, 0x61)) detected = { extension: "gif", type: "image/gif" };
  else if (starts(0x52, 0x49, 0x46, 0x46) && bytes.length >= 12 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) detected = { extension: "webp", type: "image/webp" };
  if (!detected) throw new CmsValidationError("请选择真实的 JPG、PNG、WebP 或 GIF 图片；不支持 SVG。");
  const normalizedType = declaredType.toLowerCase() === "image/jpg" ? "image/jpeg" : declaredType.toLowerCase();
  if (normalizedType && normalizedType !== detected.type) throw new CmsValidationError("图片格式和文件类型不一致，请重新导出图片后上传。");
  return detected;
}

export function safeDisplayName(value: string): string {
  return (value.split(/[\\/]/).pop() ?? "图片").replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "").trim().slice(0, 140) || "图片";
}
