"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDownToLine, ArrowUpRight, Check, ChevronRight, CircleHelp, ExternalLink, ImagePlus, Images, LayoutDashboard, LogOut, Menu, Save, SlidersHorizontal, Upload, X } from "lucide-react";
import { DRAFT_KEY, FURWARD_SCHEMA_VERSION, type ImageSlot, type Section, type SiteContent } from "@/lib/content";
import HeroPreview, { HeroImagePreview } from "./HeroPreview";

type Revision = number;
type ContentResponse = { content: SiteContent; revision: Revision; updatedAt: string | null };
type MediaItem = { id: string; url: string; name: string; type: string; size: number; createdAt: string };
type Draft = { content: SiteContent; baseRevision: Revision; savedAt: string };
type View = "overview" | "hero" | "about" | "scenes" | "companion" | "textures" | "warmth" | "technology" | "gallery" | "footer" | "media" | "help";
type Target = { sectionId: string; imageId: string };
type ImageAdvice = { text: string; warning: boolean };
const SECTION_INFO: Record<string, { name: string; description: string; size: string; location: string }> = {
  hero: { name: "首屏 · 双图流动", description: "分别管理拉布拉多与机器狗画面。两张图片使用同一画布，可在下方对齐后查看白色首页的连续流动效果。", size: "1536 × 1024 px，透明 PNG 或 WebP", location: "首页第 1 区 · 开场画面" },
  about: { name: "品牌介绍", description: "介绍 Furward 的理念，用图片与文字讲述陪伴的意义。", size: "1600 × 1200 px，横图 4:3", location: "首页第 2 区 · 品牌介绍" },
  scenes: { name: "日常场景", description: "展示产品融入日常生活的不同场景。图片顺序与前台展示一致。", size: "1600 × 1200 px，横图 4:3", location: "首页第 3 区 · 日常场景" },
  companion: { name: "陪伴时刻", description: "用一张主要画面和简短文字，介绍日常陪伴。", size: "1600 × 1200 px，横图 4:3", location: "首页第 4 区 · 陪伴时刻" },
  textures: { name: "材质细节", description: "展示表面、触感与产品细节。近景照片更容易看清材质。", size: "1200 × 1200 px，正方形", location: "首页第 5 区 · 材质细节" },
  warmth: { name: "温暖瞬间", description: "用生活化的摄影，呈现人与机器狗之间的互动。", size: "1600 × 1200 px，横图 4:3", location: "首页第 6 区 · 温暖瞬间" },
  technology: { name: "技术与能力", description: "编辑感知、引导、对话和触感四项能力，以及这个区块的标题与介绍。", size: "1600 × 1200 px，横图 4:3", location: "首页第 7 区 · 技术与能力" },
  gallery: { name: "图片集", description: "管理首页下方的图片集，按顺序替换每一张展示图。", size: "1200 × 1500 px，竖图 4:5", location: "首页第 8 区 · 图片集" },
  footer: { name: "页脚与联系", description: "管理页面最后的收尾文字、图片与联系按钮。", size: "1600 × 1200 px，横图 4:3", location: "首页第 9 区 · 页脚" },
};
const VIEW_NAMES: Record<View, string> = { overview: "使用概览", hero: "首屏 · 双图流动", about: "品牌介绍", scenes: "日常场景", companion: "陪伴时刻", textures: "材质细节", warmth: "温暖瞬间", technology: "技术与能力", gallery: "图片集", footer: "页脚与联系", media: "素材库", help: "使用帮助" };
const MODULE_VIEWS: View[] = ["hero", "about", "scenes", "companion", "textures", "warmth", "technology", "gallery", "footer"];

function isLogoAsset(imageId: string) { return /logo|mark/i.test(imageId); }
function imageSizeHint(sectionId: string, imageId: string) {
  if (isLogoAsset(imageId)) return "800 × 400 px，透明背景 PNG，等比完整展示";
  return SECTION_INFO[sectionId]?.size ?? "1600 × 1200 px";
}
async function inspectHeroFile(file: File): Promise<ImageAdvice> {
  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(file);
    const canvas = document.createElement("canvas");
    canvas.width = 192; canvas.height = 128;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("无法检查透明度");
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let transparent = false;
    for (let i = 3; i < pixels.length; i += 4) { if (pixels[i] < 250) { transparent = true; break; } }
    const issues: string[] = [];
    if (!["image/png", "image/webp"].includes(file.type)) issues.push("建议使用透明 PNG 或 WebP");
    if (bitmap.width !== 1536 || bitmap.height !== 1024) issues.push("建议两张图片都为 1536 × 1024，保持相同画布");
    if (!transparent) issues.push("预览检测未发现透明背景，可能盖住页面背景或另一张图");
    return { warning: issues.length > 0, text: `已选图片 ${bitmap.width} × ${bitmap.height} px。${issues.length ? issues.join("；") + "。图片仍可使用，请检查叠加和流动效果。" : "尺寸符合建议，预览检测到透明背景。请再检查两张图的主体对齐。"}` };
  } catch {
    return { warning: true, text: "暂时无法读取图片尺寸和透明度。图片仍可上传，请使用 1536 × 1024 的透明 PNG / WebP，并在组合预览中检查对齐。" };
  } finally { bitmap?.close(); }
}

function humanDate(value: string | null) {
  if (!value || Number.isNaN(Date.parse(value))) return "尚未保存";
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}
function fileSize(bytes: number) { return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`; }
async function responseJson<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (response.status === 401) window.dispatchEvent(new Event("admin-session-expired"));
  if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : typeof data.message === "string" ? data.message : "操作没有完成，请稍后重试。");
  return data as T;
}
function Field({ label, value, onChange, note, multiline = false, placeholder }: { label: string; value: string; onChange: (value: string) => void; note?: string; multiline?: boolean; placeholder?: string }) {
  return <label className="admin-field"><span>{label}</span>{multiline ? <textarea value={value} onChange={e => onChange(e.target.value)} rows={3} /> : <input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} />}{note && <small>{note}</small>}</label>;
}
function UploadButton({ onUpload, busy, label = "上传替换", className = "" }: { onUpload: (file: File) => void; busy: boolean; label?: string; className?: string }) {
  const input = useRef<HTMLInputElement>(null);
  return <><button type="button" className={`admin-button ${className}`} disabled={busy} onClick={() => input.current?.click()}><Upload size={15} />{busy ? "正在上传…" : label}</button><input ref={input} className="admin-file-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={event => { const file = event.target.files?.[0]; if (file) onUpload(file); event.target.value = ""; }} /></>;
}

export default function AdminClient() {
  const [view, setView] = useState<View>("overview");
  const [content, setContent] = useState<SiteContent | null>(null);
  const [savedJson, setSavedJson] = useState("");
  const [revision, setRevision] = useState<Revision>(0);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [imageAdvice, setImageAdvice] = useState<Record<string, ImageAdvice>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState<{ type: "success" | "error" | "info"; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState("");
  const [pendingDraft, setPendingDraft] = useState<Draft | null>(null);
  const [conflict, setConflict] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [mediaLoading, setMediaLoading] = useState(true);
  const [mediaError, setMediaError] = useState("");
  const [mediaSearch, setMediaSearch] = useState("");
  const [mediaTarget, setMediaTarget] = useState<Target | null>(null);
  const [mediaSelection, setMediaSelection] = useState<MediaItem | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const leaving = useRef(false);
  const dialog = useRef<HTMLDivElement>(null);
  const dirty = content !== null && JSON.stringify(content) !== savedJson;

  const load = useCallback(async () => {
    try {
      const data = await responseJson<ContentResponse>(await fetch("/api/content", { cache: "no-store" }));
      setLoadError(""); setContent(data.content); setSavedJson(JSON.stringify(data.content)); setRevision(data.revision); setUpdatedAt(data.updatedAt);
      try {
        const cached = localStorage.getItem(DRAFT_KEY);
        if (cached) {
          const draft = JSON.parse(cached) as Draft;
          if (draft.content?.schemaVersion === FURWARD_SCHEMA_VERSION && Array.isArray(draft.content.sections) && typeof draft.baseRevision === "number" && JSON.stringify(draft.content) !== JSON.stringify(data.content)) setPendingDraft(draft);
          else localStorage.removeItem(DRAFT_KEY);
        }
      } catch { setNotice({ type: "info", text: "浏览器暂时无法读取本地草稿。你仍然可以编辑并保存到网站。" }); }
    } catch (error) { setLoadError(error instanceof Error ? error.message : "网站内容读取失败，请重试。"); }
    finally { setLoading(false); }
  }, []);
  // This fetch callback updates state only after the awaited network response.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const expired = () => setSessionExpired(true);
    window.addEventListener("admin-session-expired", expired);
    return () => window.removeEventListener("admin-session-expired", expired);
  }, []);
  useEffect(() => {
    if (loading || !content || pendingDraft) return;
    try {
      if (dirty) localStorage.setItem(DRAFT_KEY, JSON.stringify({ content, baseRevision: revision, savedAt: new Date().toISOString() }));
      else localStorage.removeItem(DRAFT_KEY);
    } catch { /* Saving to the server remains available when browser storage is full. */ }
  }, [content, dirty, loading, pendingDraft, revision]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { if (!leaving.current) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const loadMedia = useCallback(async () => {
    try { const data = await responseJson<{ items: MediaItem[] }>(await fetch("/api/media", { cache: "no-store" })); setMedia(data.items); setMediaError(""); }
    catch (error) { setMediaError(error instanceof Error ? error.message : "素材读取失败。"); }
    finally { setMediaLoading(false); }
  }, []);
  // Loading flags are set by user actions; this callback resolves the external media request.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { if (view === "media" || mediaTarget) void loadMedia(); }, [view, mediaTarget, loadMedia]);
  useEffect(() => {
    if (!mediaTarget) return;
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMediaTarget(null);
      if (event.key !== "Tab") return;
      const focusable = dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input, a[href], [tabindex="0"]');
      if (!focusable?.length) return;
      const first = focusable[0]; const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", handleKey);
    return () => { document.removeEventListener("keydown", handleKey); previous?.focus(); };
  }, [mediaTarget]);

  function changeView(next: View) { if (next === "media" && view !== "media") { setMediaLoading(true); setMediaError(""); } setView(next); setMenuOpen(false); }
  function reload() { setLoading(true); setLoadError(""); void load(); }
  function reloadMedia() { setMediaLoading(true); setMediaError(""); void loadMedia(); }
  function openMedia(target: Target) { setMediaSelection(null); setMediaSearch(""); setMediaLoading(true); setMediaError(""); setMediaTarget(target); }
  async function logout() {
    if (loggingOut || saving || uploading) return;
    setLoggingOut(true);
    try {
      await responseJson(await fetch("/api/admin/logout", { method: "POST" }));
      leaving.current = true;
      window.location.assign("/admin/login");
    } catch { setNotice({ type: "error", text: "退出未完成，请稍后再试。" }); }
    finally { setLoggingOut(false); }
  }
  function updateSection(sectionId: string, change: Partial<Section>) {
    setContent(current => current && ({ ...current, sections: current.sections.map(section => section.id === sectionId ? { ...section, ...change } : section) }));
  }
  function updateImage(target: Target, change: Partial<ImageSlot>) {
    setContent(current => current && ({ ...current, sections: current.sections.map(section => section.id === target.sectionId ? { ...section, images: section.images.map(img => img.id === target.imageId ? { ...img, ...change } : img) } : section) }));
  }
  async function upload(file: File, target?: Target) {
    if (file.size > 10 * 1024 * 1024) { setNotice({ type: "error", text: "图片超过 10 MB。请先压缩图片，再重新上传。" }); return; }
    if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type)) { setNotice({ type: "error", text: "请选择 JPG、PNG、WebP 或 GIF 图片。" }); return; }
    setUploading(target ? `${target.sectionId}/${target.imageId}` : "library"); setNotice(null);
    try {
      const advice = target?.sectionId === "hero" ? await inspectHeroFile(file) : undefined;
      const form = new FormData(); form.append("file", file);
      const { item } = await responseJson<{ item: MediaItem }>(await fetch("/api/media", { method: "POST", body: form }));
      setMedia(current => [item, ...current.filter(existing => existing.id !== item.id)]);
      if (target) { updateImage(target, { src: item.url }); if (advice) setImageAdvice(current => ({ ...current, [target.imageId]: advice })); }
      setNotice({ type: "success", text: target ? "图片已上传并放入当前草稿。点击右上角「保存修改」后，访客才能看到新图片。" : "图片已加入素材库。到对应页面区块点击「从素材库选择」，就能使用它。" });
    } catch (error) { setNotice({ type: "error", text: error instanceof Error ? error.message : "图片上传失败，请重试。" }); }
    finally { setUploading(""); }
  }
  async function save() {
    if (!content || saving || pendingDraft || uploading || !dirty) return;
    setSaving(true); setNotice(null); setConflict(false);
    try {
      const response = await fetch("/api/content", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content, expectedRevision: revision }) });
      if (response.status === 409) { setConflict(true); throw new Error("网站内容已在其他页面更新。你的草稿已保留，请先下载备份，再载入最新版本，避免覆盖新的修改。"); }
      const data = await responseJson<ContentResponse>(response);
      setContent(data.content); setSavedJson(JSON.stringify(data.content)); setRevision(data.revision); setUpdatedAt(data.updatedAt);
      try { localStorage.removeItem(DRAFT_KEY); } catch { /* The saved server content remains authoritative. */ }
      setNotice({ type: "success", text: "已保存，前台网站现在会显示这些修改。" });
    } catch (error) { setNotice({ type: "error", text: error instanceof Error ? error.message : "保存失败，草稿还在，请重试。" }); }
    finally { setSaving(false); }
  }
  function previewDraft() {
    if (!content) return;
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ content, baseRevision: revision, savedAt: new Date().toISOString() })); window.open(`/?preview=1#${MODULE_VIEWS.includes(view) && view !== "hero" ? view : "home"}`, "_blank", "noopener,noreferrer"); }
    catch { setNotice({ type: "error", text: "浏览器没有允许本地草稿存储，暂时无法预览。请允许此网站的本地存储后重试。" }); }
  }
  function downloadBackup(value = content) {
    if (!value) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify({ content: value, baseRevision: revision, savedAt: new Date().toISOString() }, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = `网站内容备份-${new Date().toISOString().slice(0, 10)}.json`; link.click(); URL.revokeObjectURL(url);
  }
  function restoreDraft() {
    if (!pendingDraft) return;
    if (pendingDraft.content.schemaVersion !== FURWARD_SCHEMA_VERSION) { setNotice({ type: "error", text: "这份草稿不适用于当前网站版本，无法恢复。请先下载备份，再使用当前网站内容。" }); return; }
    setContent(pendingDraft.content); setRevision(pendingDraft.baseRevision);
    setNotice({ type: "info", text: pendingDraft.baseRevision === revision ? "已恢复未保存草稿。检查图片和文字后，再点击「保存修改」。" : "已恢复旧版本草稿。网站已有更新，保存时会检查版本；建议先下载备份，再对照最新网站整理修改。" });
    setPendingDraft(null);
  }
  function discardDraft() { try { localStorage.removeItem(DRAFT_KEY); } catch {} setPendingDraft(null); setNotice({ type: "info", text: "已放弃本地草稿，当前显示的是已保存的网站内容。" }); }
  async function backupAndReload() { downloadBackup(); try { localStorage.removeItem(DRAFT_KEY); } catch {} setConflict(false); setNotice(null); setPendingDraft(null); setLoading(true); setLoadError(""); await load(); }

  const orderedSections = MODULE_VIEWS.flatMap(id => content?.sections.find(section => section.id === id) ?? []);
  const activeSection = orderedSections.find(section => section.id === view);
  const filteredMedia = media.filter(item => item.name.toLowerCase().includes(mediaSearch.toLowerCase()));
  const imageCount = content?.sections.reduce((count, section) => count + section.images.length, 0) ?? 0;

  function mediaGrid(selectable: boolean) {
    if (mediaLoading) return <div className="admin-empty" role="status">正在读取素材…</div>;
    if (mediaError) return <div className="admin-empty"><p>{mediaError}</p><button className="admin-button" onClick={reloadMedia}>重新读取</button></div>;
    if (!filteredMedia.length) return <div className="admin-empty"><Images size={28} /><h3>{mediaSearch ? "没有找到这张图片" : "素材库暂时没有图片"}</h3><p>{mediaSearch ? "试试更短的文件名，或清空搜索条件。" : "上传第一张图片后，就能在各个页面区块重复使用。"}</p></div>;
    return <div className="admin-media-grid">{filteredMedia.map(item => <button type="button" className={`admin-media-item ${mediaSelection?.id === item.id ? "is-selected" : ""}`} key={item.id} onClick={() => setMediaSelection(item)} aria-pressed={mediaSelection?.id === item.id}><div className="admin-media-image"><img src={item.url} alt={item.name} loading="lazy" />{mediaSelection?.id === item.id && <span className="admin-selected-mark"><Check size={15} /></span>}</div><strong title={item.name}>{item.name}</strong><small>{fileSize(item.size)}{!selectable && ` · ${humanDate(item.createdAt)}`}</small></button>)}</div>;
  }

  return <div className="admin-shell" data-ui>
    <aside className={`admin-sidebar ${menuOpen ? "is-open" : ""}`}>
      <a className="admin-brand" href="/" target="_blank" rel="noopener noreferrer" aria-label="在新标签页打开 Furward 网站首页"><span className="admin-brand-mark" aria-hidden="true">F</span><span>FURWARD<span className="admin-brand-sub">内容管理</span></span></a>
      <div className="admin-workspace"><span className="admin-workspace-dot" />网站内容管理</div>
      <nav aria-label="后台导航">
        <button className={`admin-nav-item ${view === "overview" ? "is-active" : ""}`} onClick={() => changeView("overview")} aria-current={view === "overview" ? "page" : undefined}><LayoutDashboard size={17} />使用概览</button>
        <p className="admin-nav-label">页面区块</p>
        {MODULE_VIEWS.map((id, index) => <button className={`admin-nav-item ${view === id ? "is-active" : ""}`} onClick={() => changeView(id)} key={id} aria-current={view === id ? "page" : undefined}><span className="admin-nav-index">0{index + 1}</span>{VIEW_NAMES[id]}</button>)}
        <p className="admin-nav-label">管理工具</p>
        <button className={`admin-nav-item ${view === "media" ? "is-active" : ""}`} onClick={() => changeView("media")} aria-current={view === "media" ? "page" : undefined}><Images size={17} />素材库</button>
        <button className={`admin-nav-item ${view === "help" ? "is-active" : ""}`} onClick={() => changeView("help")} aria-current={view === "help" ? "page" : undefined}><CircleHelp size={17} />使用帮助</button>
      </nav>
      <div className="admin-sidebar-footer"><p>你的每一次更新<br />都从这里开始。</p><a href="/" target="_blank" rel="noreferrer">打开前台网站<ArrowUpRight size={16} /></a></div>
    </aside>
    {menuOpen && <button className="admin-menu-scrim" aria-label="关闭导航" onClick={() => setMenuOpen(false)} />}
    <div className="admin-body">
      <header className="admin-topbar"><div className="admin-breadcrumb"><button type="button" className="admin-menu-button" aria-label={menuOpen ? "关闭菜单" : "打开菜单"} aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}>{menuOpen ? <X size={20} /> : <Menu size={20} />}</button><span>网站管理</span><ChevronRight size={14} /><strong>{VIEW_NAMES[view]}</strong></div><button className="admin-text-button" onClick={() => void logout()} disabled={loggingOut || saving || !!uploading}><LogOut size={14} />{loggingOut ? "正在退出…" : "退出登录"}</button></header>
      <main className="admin-sheet">
        <header className="admin-page-header"><div><h1>{VIEW_NAMES[view]}</h1><p>{view === "overview" ? "找到你想修改的位置，然后换上自己的图片。" : activeSection ? SECTION_INFO[activeSection.id]?.description : view === "media" ? "上传过的图片都在这里，同一张图片可以重复使用。" : "不需要写代码，三步完成一次网站更新。"}</p></div><div className="admin-header-actions"><span className={`admin-save-state ${dirty ? "is-dirty" : ""}`}><i />{dirty ? "有未保存修改" : loading ? "读取中" : "与网站一致"}</span><button className="admin-button admin-preview-button" disabled={!content || !!pendingDraft} onClick={previewDraft}><ExternalLink size={15} />预览草稿</button><button className="admin-button admin-primary" disabled={!dirty || saving || !!uploading || !!pendingDraft} onClick={() => void save()}><Save size={15} />{saving ? "保存中…" : "保存修改"}</button></div></header>
        {pendingDraft && <section className="admin-recovery" aria-label="恢复未保存草稿"><div><strong>发现一份未保存草稿</strong><p>来自 {humanDate(pendingDraft.savedAt)}。请先选择恢复或放弃，避免覆盖之前的修改。</p></div><div className="admin-inline-actions"><button className="admin-button" onClick={discardDraft}>放弃草稿</button><button className="admin-button admin-primary" onClick={restoreDraft}>恢复草稿</button></div></section>}
        {notice && <div role={notice.type === "error" ? "alert" : "status"} className={`admin-notice admin-notice-${notice.type}`}><span>{notice.type === "success" && <Check size={16} />}{notice.text}</span><button aria-label="关闭提示" onClick={() => setNotice(null)}><X size={16} /></button></div>}
        {sessionExpired && <div role="alert" className="admin-notice admin-notice-error"><span>登录已过期。草稿还在，请重新登录后回到此页继续操作。</span><a className="admin-button" href="/admin/login" target="_blank" rel="noopener noreferrer">重新登录<ExternalLink size={14} /></a></div>}
        {conflict && <div className="admin-conflict-actions"><button className="admin-button" onClick={() => downloadBackup()}><ArrowDownToLine size={15} />下载我的草稿备份</button><button className="admin-button" onClick={() => void backupAndReload()}>备份并载入最新版本</button></div>}
        {loading ? <div className="admin-loading" role="status"><span>正在读取你的网站内容…</span>{[1, 2, 3, 4].map(n => <div className="admin-skeleton" key={n} />)}</div> : loadError ? <div className="admin-empty"><h2>暂时无法读取网站</h2><p>{loadError}</p><button className="admin-button" onClick={reload}>重新读取</button></div> : content && <fieldset className="admin-editor" disabled={saving || !!pendingDraft}>
          {view === "overview" && <>
            <div className="admin-overview-heading"><div><h2>按页面位置，找到你的图片</h2><p>{orderedSections.length} 个区块 · {imageCount} 张图片 · 点击任一区块开始编辑</p></div><span>上次保存 {humanDate(updatedAt)}</span></div>
            <div className="admin-section-list">{orderedSections.map((section, index) => <button type="button" className="admin-section-row" key={section.id} onClick={() => changeView(section.id as View)}><span className="admin-section-order">0{index + 1}</span><div className={`admin-section-thumb admin-thumb-${section.id}`}>{section.images[0] ? <img src={section.images[0].src} alt="" style={{ objectPosition: `${section.images[0].positionX}% ${section.images[0].positionY}%` }} /> : <SlidersHorizontal size={25} aria-hidden="true" />}</div><div className="admin-section-identity"><h3>{SECTION_INFO[section.id]?.name ?? section.title}</h3><p>{SECTION_INFO[section.id]?.location}</p></div><span className="admin-section-amount">{section.images.length ? `${section.images.length} 张图片` : `${section.items?.length ?? 0} 项内容`}</span><span className="admin-section-visibility">{section.enabled ? "显示中" : "已隐藏"}</span><span className="admin-section-edit">编辑区块<ChevronRight size={16} /></span></button>)}</div>
            <div className="admin-overview-bottom"><div className="admin-workflow"><h2>第一次使用？从这里开始</h2><ol><li><strong>选择区块</strong><span>按照图片所在位置，点击上方对应名称。</span></li><li><strong>上传图片</strong><span>预览画面，可拖动滑条调整主体位置。</span></li><li><strong>保存修改</strong><span>确认预览后保存，前台网站立即更新。</span></li></ol><button className="admin-text-button" onClick={() => changeView("help")}>查看完整使用说明<ArrowUpRight size={15} /></button></div><div className="admin-site-settings"><h2>网站基本信息</h2><Field label="网站名称" value={content.site.name} onChange={name => setContent({ ...content, site: { ...content.site, name } })} /><Field label="网站简介" value={content.site.tagline} onChange={tagline => setContent({ ...content, site: { ...content.site, tagline } })} /></div></div>
          </>}
          {activeSection && <>
            <div className="admin-section-toolbar"><div><span className="admin-location-label">前台位置</span><strong>{SECTION_INFO[activeSection.id]?.location}</strong></div><label className="admin-toggle-label"><span>在网站上显示此区块</span><input type="checkbox" checked={activeSection.enabled} onChange={e => updateSection(activeSection.id, { enabled: e.target.checked })} /><span className="admin-toggle" /></label></div>
            {!activeSection.enabled && <p className="admin-inline-note">此区块当前已隐藏。你仍然可以编辑，重新打开显示开关并保存后，访客就能看见。</p>}
            {activeSection.id === "hero" && <HeroPreview section={activeSection} onChange={(imageId, change) => updateImage({ sectionId: "hero", imageId }, change)} />}
            <div className="admin-editor-tabs">{activeSection.images.length > 0 ? <><span className="is-active">图片 · {activeSection.images.length}</span><a href="#section-copy">文字与链接<ArrowDownToLine size={13} /></a></> : <span className="is-active">文字与技术能力</span>}</div>
            <div className="admin-image-list">{activeSection.images.map((img, index) => {
              const target = { sectionId: activeSection.id, imageId: img.id };
              const busy = uploading === `${activeSection.id}/${img.id}`;
              return <article className="admin-image-editor" key={img.id}>
                <div className="admin-image-visual">{activeSection.id === "hero" ? <HeroImagePreview image={img} /> : <div className={`admin-image-preview admin-preview-${activeSection.id} ${isLogoAsset(img.id) ? "admin-preview-logo" : ""}`}>
                  <img src={img.src} alt={img.alt || img.label} style={{ objectPosition: `${img.positionX}% ${img.positionY}%`, transform: `scale(${img.scale ?? 1})` }} />
                  <span>画面预览</span>
                </div>}<p>{activeSection.id === "hero" ? "1536 × 1024 画布中的单张素材" : isLogoAsset(img.id) ? "标志等比完整显示，保留透明背景" : "画面裁切预览；不同设备会略有调整"}</p></div>
                <div className="admin-image-controls"><div className="admin-image-title"><div><span>图片 {String(index + 1).padStart(2, "0")}</span><h3>{img.label}</h3></div><span className="admin-file-kind">{img.src.split(".").pop()?.split("?")[0]?.toUpperCase().slice(0, 5) || "图片"}</span></div>
                  <p className="admin-dimensions">建议尺寸：{imageSizeHint(activeSection.id, img.id)} · 最大 10 MB</p>
                  <div className="admin-inline-actions"><UploadButton busy={!!uploading} label={busy ? "正在上传…" : "上传替换"} onUpload={file => void upload(file, target)} /><button className="admin-button" disabled={!!uploading} onClick={() => openMedia(target)}><Images size={15} />从素材库选择</button><a className="admin-text-button" href={img.src} target="_blank" rel="noopener noreferrer">查看原图<ExternalLink size={13} /></a></div>
                  {imageAdvice[img.id] && <p className={`admin-image-advice ${imageAdvice[img.id].warning ? "is-warning" : ""}`} role="status">{imageAdvice[img.id].text}</p>}
                  <div className="admin-image-fields"><Field label="图片名称" value={img.label} onChange={label => updateImage(target, { label })} /><Field label="图片说明" value={img.alt} onChange={alt => updateImage(target, { alt })} note="帮助无法看见图片的访客理解内容。" /></div>
                  {activeSection.id === "hero" ? <p className="admin-small-note">位置与大小在上方「首屏组合预览」调整。选「叠加对齐」可以同时对照两张图片。</p> : <>
                    <div className="admin-focus-heading"><SlidersHorizontal size={14} /><strong>调整画面位置</strong><button type="button" className="admin-text-button" onClick={() => updateImage(target, { positionX: 50, positionY: 50, scale: 1 })}>恢复居中</button></div>
                    <div className="admin-sliders"><label><span>左右</span><input aria-label={`${img.label}左右位置`} type="range" min="0" max="100" value={img.positionX} onChange={e => updateImage(target, { positionX: Number(e.target.value) })} /><output>{img.positionX}%</output></label><label><span>上下</span><input aria-label={`${img.label}上下位置`} type="range" min="0" max="100" value={img.positionY} onChange={e => updateImage(target, { positionY: Number(e.target.value) })} /><output>{img.positionY}%</output></label></div>
                    <p className="admin-small-note">主体被裁掉时，移动滑条调整。</p>
                  </>}
                </div>
              </article>;
            })}</div>
            <section className="admin-copy-editor" id="section-copy"><div><h2>文字与链接</h2><p>文字和图片会一起保存。按钮链接可以填写完整网址、mailto:邮箱地址，或本页位置，例如 #about、#technology。</p></div><div className="admin-copy-fields"><Field label="小标题" value={activeSection.eyebrow} onChange={eyebrow => updateSection(activeSection.id, { eyebrow })} /><Field label="大标题" value={activeSection.title} onChange={title => updateSection(activeSection.id, { title })} /><Field label="介绍文字" value={activeSection.description} onChange={description => updateSection(activeSection.id, { description })} multiline /><div className="admin-paired-fields"><Field label="按钮文字" note={activeSection.id === "hero" ? "首屏探索链接的文字；机器狗、拉布拉多和流动视角由访客独立切换。" : undefined} value={activeSection.buttonLabel} onChange={buttonLabel => updateSection(activeSection.id, { buttonLabel })} /><Field label="按钮链接" value={activeSection.buttonHref} onChange={buttonHref => updateSection(activeSection.id, { buttonHref })} placeholder="#technology 或 https://你的网站" /></div></div></section>
            {activeSection.id === "technology" && <section className="admin-technology-editor" aria-labelledby="technology-items-title"><div><h2 id="technology-items-title">四项技术能力</h2><p>每一项的标题和说明，都会显示在前台对应的能力介绍中。</p></div><div className="admin-technology-items">{activeSection.items?.map((item, index) => <div className="admin-technology-item" key={item.id}><h3>能力 {String(index + 1).padStart(2, "0")}</h3><Field label="小标题" value={item.eyebrow} onChange={eyebrow => updateSection(activeSection.id, { items: activeSection.items?.map(current => current.id === item.id ? { ...current, eyebrow } : current) })} /><Field label="能力名称" value={item.title} onChange={title => updateSection(activeSection.id, { items: activeSection.items?.map(current => current.id === item.id ? { ...current, title } : current) })} /><Field label="能力说明" value={item.description} onChange={description => updateSection(activeSection.id, { items: activeSection.items?.map(current => current.id === item.id ? { ...current, description } : current) })} multiline /></div>)}</div></section>}
          </>}
          {view === "media" && <><div className="admin-media-toolbar"><label className="admin-search-field"><span className="admin-sr-only">按文件名查找图片</span><input placeholder="按文件名查找图片" value={mediaSearch} onChange={e => setMediaSearch(e.target.value)} /></label><UploadButton busy={!!uploading} label="上传新图片" onUpload={file => void upload(file)} /></div><p className="admin-inline-note">支持 JPG、PNG、WebP、GIF，单张不超过 10 MB。上传到素材库不会自动替换网站图片。</p>{mediaGrid(false)}{mediaSelection && <div className="admin-media-details"><div><strong>{mediaSelection.name}</strong><p>{fileSize(mediaSelection.size)} · 上传于 {humanDate(mediaSelection.createdAt)}</p></div><a className="admin-button" href={mediaSelection.url} target="_blank" rel="noreferrer">查看原图<ExternalLink size={14} /></a></div>}</>}
          {view === "help" && <div className="admin-help"><section className="admin-help-main"><h2>替换图片，只要三步</h2><ol><li><span>01</span><div><h3>找到这张图片所在的区块</h3><p>左侧导航对应首页从上到下的九个区块。不确定是哪一块时，回到「使用概览」查看缩略图，再点击「编辑区块」。</p></div></li><li><span>02</span><div><h3>上传新图，确认画面</h3><p>点击「上传替换」选择电脑上的图片。已上传的图片可从「素材库」重复使用。调整位置，然后点「预览草稿」查看整页效果。</p></div></li><li><span>03</span><div><h3>点击「保存修改」</h3><p>右上角出现「有未保存修改」，代表前台还没有更新。点击保存，看到成功提示后，打开前台网站查看结果。</p></div></li></ol><button className="admin-button" onClick={() => changeView("hero")}><ImagePlus size={16} />现在编辑首屏双图</button></section><section className="admin-help-tips"><h2>图片怎么选？</h2><dl><dt>首屏的两张图片</dt><dd>一张是人物与拉布拉多，一张是同一人物与机器狗。推荐都用 1536 × 1024 的透明 PNG 或 WebP，并让人物、主体大小与地面高度保持一致。</dd><dt>怎样检查对齐？</dt><dd>选择「叠加对齐」，两张图片会各显示 50% 透明度。用左右、上下、大小滑条对齐轮廓，再点「流动预览」检查持续变化的边界。可以「暂停流动」仔细查看，再「继续流动」。恢复构图可以还原默认位置和大小。</dd><dt>上传提示尺寸或背景不同</dt><dd>这是效果建议，不会阻止上传。图片带不透明底色时，可能遮住另一张图和页面背景；建议换成透明 PNG / WebP。尺寸不同仍可使用，但需要仔细调整对齐。</dd><dt>其他照片</dt><dd>推荐 WebP 或 JPG，每个图片编辑区都有建议尺寸。单张最大 10 MB，尽量控制在 1–2 MB，网站打开更快。</dd><dt>切换区块会丢失修改吗？</dt><dd>不会。九个区块共用一份草稿。关闭页面前请保存；重新进入时若发现本地草稿，可以选择恢复或放弃。旧版网站草稿不会套用到 Furward。</dd><dt>预览与保存有什么区别？</dt><dd>「预览草稿」只在你的浏览器里展示尚未保存的修改。点击「保存修改」后，访客才会看到更新。</dd><dt>为什么保存时提示版本冲突？</dt><dd>另一标签页已更新网站。先下载草稿备份，再载入最新版本，重新填写需要保留的修改，避免互相覆盖。</dd></dl></section></div>}
        </fieldset>}
        <footer className="admin-canvas-footer"><span>FURWARD · 网站内容管理</span><a href="/" target="_blank" rel="noreferrer">查看已保存的网站<ArrowUpRight size={13} /></a></footer>
      </main>
    </div>
    {mediaTarget && <div className="admin-modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setMediaTarget(null); }}><div className="admin-modal" role="dialog" aria-modal="true" aria-labelledby="media-dialog-title" ref={dialog}><header><div><h2 id="media-dialog-title">从素材库选择图片</h2><p>选中图片后，点击「使用这张图片」。</p></div><button className="admin-icon-button" aria-label="关闭素材库" onClick={() => setMediaTarget(null)}><X size={20} /></button></header><div className="admin-modal-content"><label className="admin-search-field"><span className="admin-sr-only">查找素材</span><input value={mediaSearch} onChange={event => setMediaSearch(event.target.value)} placeholder="按文件名查找图片" /></label>{mediaGrid(true)}</div><footer><span>{mediaSelection ? mediaSelection.name : "尚未选择图片"}</span><div className="admin-inline-actions"><button className="admin-button" onClick={() => setMediaTarget(null)}>取消</button><button className="admin-button admin-primary" disabled={!mediaSelection} onClick={() => { if (!mediaSelection) return; updateImage(mediaTarget, { src: mediaSelection.url }); if (mediaTarget.sectionId === "hero") setImageAdvice(current => ({ ...current, [mediaTarget.imageId]: { warning: false, text: "已从素材库选用。请确认是同一画布的透明图片，并在上方叠加预览中检查对齐。" } })); setMediaTarget(null); setNotice({ type: "info", text: "已将图片放入草稿，点击「保存修改」后才对前台生效。" }); }}>使用这张图片</button></div></footer></div></div>}
  </div>;
}
