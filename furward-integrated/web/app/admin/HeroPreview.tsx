"use client";

import { useEffect, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import FurwardLiquid, { type LiquidMode } from "@/app/components/FurwardLiquid";
import "@/app/components/WhiteHero.css";
import { defaultContent, type ImageSlot, type Section } from "@/lib/content";

const MODES: { id: LiquidMode; label: string }[] = [
  { id: "labrador", label: "拉布拉多画面" },
  { id: "robot", label: "机器狗画面" },
  { id: "overlay", label: "叠加对齐" },
  { id: "flow", label: "流动预览" },
];

export function HeroImagePreview({ image }: { image: ImageSlot }) {
  const host = useRef<HTMLDivElement>(null);
  const mode = image.id === "hero-dog" ? "labrador" : "robot";
  return <div ref={host} className="admin-image-preview admin-preview-hero ss-preview-stage">
    <FurwardLiquid dog={image} robot={image} mode={mode} paused host={host} />
    <span>{mode === "labrador" ? "拉布拉多画面" : "机器狗画面"}</span>
  </div>;
}

export default function HeroPreview({ section, onChange }: {
  section: Section;
  onChange: (imageId: string, change: Partial<ImageSlot>) => void;
}) {
  const [mode, setMode] = useState<LiquidMode>("flow");
  const [paused, setPaused] = useState(false);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const dog = section.images.find(image => image.id === "hero-dog");
  const robot = section.images.find(image => image.id === "hero-robot");
  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setPaused(preference.matches);
    // Synchronize an external accessibility preference, including changes while this page is open.
    update();
    preference.addEventListener("change", update);
    return () => preference.removeEventListener("change", update);
  }, []);
  function reset(image: ImageSlot) {
    const original = defaultContent.sections.find(item => item.id === "hero")?.images.find(item => item.id === image.id);
    onChange(image.id, { positionX: original?.positionX ?? 50, positionY: original?.positionY ?? 50, scale: original?.scale ?? 1 });
  }
  return <section className="admin-hero-group" aria-labelledby="hero-preview-title">
    <div className="admin-hero-heading"><div><h2 id="hero-preview-title">首屏组合预览</h2><p>先检查两张图的对齐，再查看与白色首页一致的连续流动效果。</p></div><span>同一画布 · 1536 × 1024</span></div>
    <div className="admin-hero-layout">
      <div className="admin-hero-preview-column">
        <div className="admin-hero-modes" role="group" aria-label="首屏预览方式">{MODES.map(item => <button type="button" key={item.id} aria-pressed={mode === item.id} className={mode === item.id ? "is-active" : ""} onClick={() => setMode(item.id)}>{item.id === "flow" && <Play size={13} />}{item.label}</button>)}</div>
        <div ref={host} className={`admin-hero-stage ss-preview-stage ${mode === "overlay" ? "is-aligning" : ""}`}>
          <FurwardLiquid dog={dog} robot={robot} mode={mode} paused={mode !== "flow" || paused} host={host} onReady={(loaded, error) => { setReady(loaded); setFailed(!!error); }} />
          {mode === "overlay" && <div className="admin-alignment-guides" aria-hidden="true" />}
          {!ready && <p className="admin-hero-load-state" role="status">{failed ? "图片未能加载。请查看原图或重新上传后重试。" : "正在加载两张图片…"}</p>}
        </div>
        <div className="admin-hero-caption"><p aria-live="polite">{!ready ? "图片加载后，即可检查对齐与流动效果。" : mode === "overlay" ? "两张图片各显示 50% 透明度。对齐人物、脚底和主体轮廓。" : mode === "flow" ? paused ? "已暂停在当前画面，可以仔细检查两张图的边界。" : "两张图片沿边界持续流动。移动鼠标或手指可以观察变化。" : mode === "labrador" ? "单独查看人物与拉布拉多画面。" : "单独查看人物与机器狗画面。"}</p>{mode === "flow" && <button className="admin-button admin-flow-toggle" type="button" disabled={!ready} aria-pressed={paused} onClick={() => setPaused(value => !value)}>{paused ? <Play size={14} /> : <Pause size={14} />}{paused ? "继续流动" : "暂停流动"}</button>}</div>
      </div>
      <div className="admin-hero-adjustments">{[dog, robot].filter((image): image is ImageSlot => !!image).map(image => <div className="admin-hero-adjustment" key={image.id}>
        <div className="admin-hero-adjustment-heading"><h3>{image.id === "hero-dog" ? "拉布拉多画面" : "机器狗画面"}</h3><button type="button" className="admin-text-button" onClick={() => reset(image)}>恢复构图</button></div>
        <div className="admin-sliders">
          <label><span>左右</span><input aria-label={`${image.label}左右位置`} type="range" min="0" max="100" value={image.positionX} onChange={event => onChange(image.id, { positionX: Number(event.target.value) })} /><output>{image.positionX}%</output></label>
          <label><span>上下</span><input aria-label={`${image.label}上下位置`} type="range" min="0" max="100" value={image.positionY} onChange={event => onChange(image.id, { positionY: Number(event.target.value) })} /><output>{image.positionY}%</output></label>
          <label><span>大小</span><input aria-label={`${image.label}大小`} type="range" min="50" max="200" step="1" value={Math.round((image.scale ?? 1) * 100)} onChange={event => onChange(image.id, { scale: Number(event.target.value) / 100 })} /><output>{Math.round((image.scale ?? 1) * 100)}%</output></label>
        </div>
      </div>)}<p className="admin-small-note">50% / 50% 表示居中；大小 100% 为原始比例。「恢复构图」还原位置和大小。</p></div>
    </div>
    <p className="admin-hero-recommendation">换图建议：两张都用 1536 × 1024 的透明 PNG 或 WebP，人物位置、地面高度和留白保持一致。下面分别上传两张图片。</p>
  </section>;
}
