'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { ArrowDown, ArrowUpRight, ArrowLeft, ArrowRight, Menu, X, Volume2, Square } from 'lucide-react';
import { type ImageSlot, type Section, type SiteContent, upgradeContent, DRAFT_KEY, FURWARD_SCHEMA_VERSION } from '@/lib/content';
import WhiteHero from './components/WhiteHero';
import { useSiteMotion } from './useSiteMotion';
import './furward.css';
import './components/WhiteHero.css';

export function Photo({ image, className = '', eager = false }: { image?: ImageSlot; className?: string; eager?: boolean }) {
  if (!image?.src) return null;
  return <img className={className} src={image.src} alt={image.alt} loading={eager ? 'eager' : 'lazy'} decoding="async" style={{ objectPosition: `${image.positionX}% ${image.positionY}%`, transform: image.scale && image.scale !== 1 ? `scale(${image.scale})` : undefined }} />;
}
function Contours() { return <div className="contours" aria-hidden="true" />; }
function ActionLink({ href, children }: { href: string; children: React.ReactNode }) {
  return <a className="action-link" href={href || '#home'}><span>{children}</span><i><ArrowUpRight size={20}/></i></a>;
}
const sectionNames: Record<string, string> = { home: '首页', about: '认识绒途', scenes: '出行场景', companion: '引路与回应', textures: '触感设计', warmth: '温度与陪伴', technology: '技术理念', gallery: '概念影像' };
function About({ section }: { section: Section }) {
  const words = section.title.match(/[^，。！？、\s]+[，。！？、]?/g) || [section.title];
  return <div id="about"><section className="message-section" data-shared-portrait="false"><Contours/><p className="message-eyebrow">{section.eyebrow}</p><div className="message-typography" aria-hidden="true"><div className="message-line-one">A LITTLE WARMTH. A WAY FORWARD.</div><div className="message-line-two">TOGETHER. FORWARD. TOGETHER. FORWARD.</div></div><div className="message-photo"><Photo image={section.images[0]}/></div><div className="fw-message-mark" aria-hidden="true">F.</div><span className="fw-concept">FURWARD / CONCEPT DESIGN</span></section><section className="manifesto-section"><Contours/><p className="section-kicker">绒，是触摸与陪伴。途，是自主前行。</p><h2 className="manifesto-copy">{words.map((word, index) => <span className={`manifesto-word ${index % 2 ? 'serif' : ''}`} key={index}>{word}</span>)}</h2><p className="manifesto-description">{section.description}</p><ActionLink href={section.buttonHref}>{section.buttonLabel}</ActionLink></section></div>;
}
function Scenes({ section, open }: { section: Section; open: (images: ImageSlot[], index: number) => void }) {
  return <section className="story-section" id="scenes" aria-label={section.title}><div className="story-sticky"><div className="fw-story-heading"><div><p className="fw-kicker">{section.eyebrow}</p><h2>{section.title}</h2></div><p>{section.description}</p><span>SCROLL TO EXPLORE <ArrowRight size={18}/></span></div><div className="story-track">{section.images.map((image, i) => <figure className={`story-card story-card-${i % 4}`} key={image.id}><button onClick={() => open(section.images, i)} aria-label={`放大${image.label}`}><Photo image={image}/><span className="fw-image-arrow"><ArrowUpRight size={23}/></span></button><figcaption><small>0{i + 1}</small>{image.label}</figcaption>{i === 1 && <blockquote>每一次向前，<br/>都值得被<em>回应。</em></blockquote>}</figure>)}</div><span className="fw-story-note">AI 概念场景 · 用于说明设计方向</span><a className="fw-story-next" href={section.buttonHref}>{section.buttonLabel} ↗</a></div></section>;
}
const conversations = [
  { question: '我前面是什么？', answer: '前方是一张桌子，右侧有可通行的区域。' },
  { question: '附近有空椅子吗？', answer: '我先查看周围，找到空椅子后告诉你位置。' },
];
function Companion({ section }: { section: Section }) {
  const [active, setActive] = useState(0);
  const [speaking, setSpeaking] = useState(false);
  const [speechAvailable, setSpeechAvailable] = useState(false);
  useEffect(() => { setSpeechAvailable('speechSynthesis' in window); return () => { window.speechSynthesis?.cancel(); }; }, []);
  const speak = () => {
    if (!speechAvailable) return;
    window.speechSynthesis.cancel();
    if (speaking) { setSpeaking(false); return; }
    const utterance = new SpeechSynthesisUtterance(conversations[active].answer);
    utterance.lang = 'zh-CN'; utterance.rate = .95;
    utterance.onend = utterance.onerror = () => setSpeaking(false);
    setSpeaking(true); window.speechSynthesis.speak(utterance);
  };
  const choose = (index: number) => { window.speechSynthesis?.cancel(); setSpeaking(false); setActive(index); };
  return <section className="track-section" id="companion" aria-label={section.title}><div className="track-half track-on"><div className="track-copy-on"><p className="fw-kicker">{section.eyebrow}</p><h2>引路<span>。</span></h2><p className="fw-companion-title">{section.title}</p><p>{section.description}</p><ActionLink href={section.buttonHref}>{section.buttonLabel}</ActionLink></div><Photo className="track-person-on" image={section.images.find(i => i.id === 'companion-guide')}/><span className="fw-concept">机器狗外观概念</span></div><div className="track-half track-off"><div className="track-copy-off"><p className="fw-kicker">CONVERSE / 陪伴</p><h2>回应<span>。</span></h2><p>把需要说出来，<br/>让方向听得见。</p><div className="fw-conversation"><div className="fw-question-list">{conversations.map((item, i) => <button key={item.question} onClick={() => choose(i)} aria-pressed={active === i}>{item.question}<ArrowUpRight size={16}/></button>)}</div><p className="fw-answer" aria-live="polite">{conversations[active].answer}</p><button className="fw-speak" disabled={!speechAvailable} onClick={speak}>{speaking ? <Square size={15}/> : <Volume2 size={18}/>} {speaking ? '停止播放' : speechAvailable ? '听听示例回应' : '当前浏览器不支持语音，可阅读上方示例'}</button><small>预设对话演示 · 非实时环境识别</small></div></div><Photo className="track-person-off" image={section.images.find(i => i.id === 'companion-response')}/></div></section>;
}
function Textures({ section, open }: { section: Section; open: (images: ImageSlot[], index: number) => void }) {
  const [active, setActive] = useState(0);
  const descriptions = ['细密的暖金短毛，像轻抚拉布拉多的背。', '自然蓬松的奶白长毛，细丝随手掌轻轻伏下。', '柔细顺滑的烟灰被毛，贴近熟悉的宠物触感。'];
  return <section className="helmets-section" id="textures"><div className="helmet-heading"><h2 data-reveal>{section.title}<br/><em>{section.eyebrow}</em></h2><p data-reveal>{section.description}</p></div><div className="helmet-grid">{section.images.map((image, i) => <div className={`fw-texture-item ${active === i ? 'is-selected' : ''}`} key={image.id}><button className="helmet-card" onClick={() => { setActive(i); open(section.images, i); }} aria-label={`放大${image.label}`}><div className="helmet-art"><Photo image={image}/><span className="helmet-orbit" aria-hidden="true">↗</span></div><h3>{image.label}</h3></button><button className="fw-texture-select" onClick={() => setActive(i)} aria-pressed={active === i}>{active === i ? '已选择' : '感受这种触感'} <span>0{i + 1}</span></button></div>)}</div><div className="helmet-footer"><p aria-live="polite">{descriptions[active]}</p><span className="fw-concept">毛发覆盖方案 · AI 材质概念</span><div><ActionLink href={section.buttonHref}>{section.buttonLabel}</ActionLink></div></div></section>;
}
function Warmth({ section }: { section: Section }) {
  return <><section className="helmet-window" aria-label="温暖陪伴概念影像"><div className="helmet-window-frame"><Photo image={section.images[0]}/><div className="fw-window-caption"><span>REACH OUT.</span><p>让陪伴，触手可及。</p><small>AI 概念影像</small></div></div></section><section className="shop-section" id="warmth"><Contours/><div className="shop-copy"><p className="section-kicker">{section.eyebrow}</p><h2 data-reveal>{section.title}</h2><p data-reveal>{section.description}</p><ActionLink href={section.buttonHref}>{section.buttonLabel}</ActionLink></div><div className="shop-photos">{section.images.map((image, i) => <div className={`shop-photo shop-photo-${i}`} key={image.id}><Photo image={image}/><span>{image.label}</span></div>)}</div><p className="fw-warmth-note">柔软覆盖、温度反馈与触摸互动均为设计探索，材料及温控方案尚待验证。</p></section></>;
}
function Technology({ section }: { section: Section }) {
  return <section className="partners-section" id="technology"><div className="partners-heading"><h2 data-reveal>{section.title}<br/><em>{section.eyebrow}</em></h2><p data-reveal>{section.description}</p></div><div className="fw-tech-list">{section.items?.map((item, i) => <article key={item.id} data-reveal><span>0{i + 1}</span><h3>{item.title}<small>{item.eyebrow}</small></h3><p>{item.description}</p></article>)}</div><div className="partner-marquee" tabIndex={0} aria-label="绒途技术方向，悬停或聚焦可暂停"><div className="partner-marquee-track">{[0, 1].map(i => <div className="partner-logos" aria-hidden={i === 1 || undefined} key={i}><span>PERCEIVE</span><span>GUIDE</span><span>CONVERSE</span><span>CONNECT</span></div>)}</div></div><p className="fw-tech-note">语言交互用于表达需求，运动执行由独立控制系统负责。当前页面展示项目理念与概念设计。</p><div className="fw-tech-action"><ActionLink href={section.buttonHref}>{section.buttonLabel}</ActionLink></div></section>;
}
function Gallery({ section, open }: { section: Section; open: (images: ImageSlot[], index: number) => void }) {
  return <section className="social-section" id="gallery"><Contours/><h2 data-reveal>{section.title}<br/><em>{section.eyebrow}</em></h2><div className="social-fan">{section.images.map((image, i) => <button className="social-card" key={image.id} onClick={() => open(section.images, i)} aria-label={`放大${image.label}`}><Photo image={image}/><span>↗</span></button>)}</div><div className="social-links"><p>{section.description}</p><ActionLink href={section.buttonHref}>{section.buttonLabel}</ActionLink></div></section>;
}

export default function PublicSite({ initialContent }: { initialContent: SiteContent }) {
  const [content, setContent] = useState(() => upgradeContent(initialContent));
  const [menuOpen, setMenuOpen] = useState(false);
  const [preview, setPreview] = useState(false);
  const [notice, setNotice] = useState('');
  const [viewer, setViewer] = useState<{ images: ImageSlot[]; index: number } | null>(null);
  const root = useRef<HTMLElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const closeMenu = useRef<HTMLButtonElement>(null);
  const menuDialog = useRef<HTMLDialogElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  useSiteMotion(root, content);
  useEffect(() => {
    const isPreview = new URLSearchParams(window.location.search).get('preview') === '1'; setPreview(isPreview);
    const readDraft = () => { try { const raw = localStorage.getItem(DRAFT_KEY); if (raw) { const draft = JSON.parse(raw); const data = draft.content || draft; if (data.schemaVersion === FURWARD_SCHEMA_VERSION && data.site && Array.isArray(data.sections)) { setContent(upgradeContent(data)); return true; } } } catch { /* Keep the saved version if a browser draft is invalid. */ } return false; };
    if (!(isPreview && readDraft())) fetch('/api/content', { cache: 'no-store' }).then(r => { if (!r.ok) throw new Error(); return r.json() as Promise<{ content: SiteContent }>; }).then(data => setContent(current => { const next = upgradeContent(data.content); return JSON.stringify(current) === JSON.stringify(next) ? current : next; })).catch(() => setNotice('暂时无法刷新内容，正在显示上次读取的版本。'));
    const update = () => { if (isPreview) readDraft(); }; window.addEventListener('storage', update); return () => window.removeEventListener('storage', update);
  }, []);
  useEffect(() => {
    if (!menuOpen && !viewer) return;
    const old = document.body.style.overflow; document.body.style.overflow = 'hidden';
    const container = viewer ? overlay.current : menuDialog.current;
    if (menuOpen && menuDialog.current && !menuDialog.current.open) menuDialog.current.showModal();
    (container?.querySelector('button') as HTMLButtonElement | null)?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setMenuOpen(false); setViewer(null); }
      if (viewer && ['ArrowLeft', 'ArrowRight'].includes(e.key)) { e.preventDefault(); setViewer(v => v ? { ...v, index: (v.index + (e.key === 'ArrowRight' ? 1 : -1) + v.images.length) % v.images.length } : null); }
      if (e.key === 'Tab') { const controls = Array.from(container?.querySelectorAll<HTMLElement>('a,button') || []); const first = controls[0], last = controls.at(-1); if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); } }
    };
    document.addEventListener('keydown', key); return () => { document.body.style.overflow = old; document.removeEventListener('keydown', key); if (menuDialog.current?.open) menuDialog.current.close(); returnFocus.current?.focus({ preventScroll: true }); };
  }, [menuOpen, Boolean(viewer)]);
  useEffect(() => {
    let frame = 0;
    const update = () => { frame = 0; const dark = [...document.querySelectorAll<HTMLElement>('.message-section,.manifesto-section,.story-section,.helmets-section,.partners-section')].some(el => { const r = el.getBoundingClientRect(); return r.top < 60 && r.bottom > 60; }); const header = document.querySelector('.site-header'); header?.classList.toggle('is-dark', dark); const first = document.querySelector('.ss-hero'); header?.classList.toggle('is-past-hero', !first || first.getBoundingClientRect().bottom <= 60); };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); }; window.addEventListener('scroll', schedule, { passive: true }); update(); return () => { window.removeEventListener('scroll', schedule); cancelAnimationFrame(frame); };
  }, []);
  const visibleSections = content.sections.filter(s => s.enabled);
  const available = new Set(visibleSections.map(s => s.id === 'hero' ? 'home' : s.id));
  const nextHref = `#${visibleSections.find(s => s.id !== 'hero')?.id || 'main-content'}`;
  const resolveHref = (href: string) => href.startsWith('#') && !available.has(href.slice(1)) ? nextHref : href;
  const section = (id: string) => { const found = visibleSections.find(s => s.id === id); return found ? { ...found, buttonHref: resolveHref(found.buttonHref) } : undefined; };
  const hero = section('hero'), about = section('about'), scenes = section('scenes'), companion = section('companion'), textures = section('textures'), warmth = section('warmth'), technology = section('technology'), gallery = section('gallery'), footer = section('footer');
  const nav = Object.entries(sectionNames).filter(([id]) => section(id === 'home' ? 'hero' : id));
  const open = (images: ImageSlot[], index: number) => { if (!images.length) return; returnFocus.current = document.activeElement as HTMLElement; setViewer({ images, index }); };
  return <main ref={root} className="public-site fw-site" style={{ '--acid': content.site.accent } as CSSProperties}>
    <a href="#main-content" className="skip-link">跳到主要内容</a>
    {preview && <div className="preview-banner">草稿预览 · 尚未保存到网站<a href="/admin">返回后台</a></div>}
    {notice && <div className="content-notice" role="status">{notice}<button onClick={() => window.location.reload()}>重试</button></div>}
    <header className={`site-header ${hero ? 'has-white-hero' : ''} ${preview ? 'with-preview' : ''}`} ><a className="nav-wordmark" href={hero ? "#home" : "#main-content"} aria-label={`${content.site.name} · 首页`}><em>FUR</em><b>WARD</b></a><a className="fw-header-center" href={resolveHref("#about")}>绒途 / FURWARD</a><div className="header-actions"><a className="store-button" href="/experience"><span>进入城市体验</span><ArrowUpRight size={18}/></a><button ref={menuButton} className="menu-button" aria-label="打开导航菜单" aria-expanded={menuOpen} onClick={() => { returnFocus.current = menuButton.current; setMenuOpen(true); }}><Menu/></button></div></header>
    <dialog ref={menuDialog} className="ss-menu-dialog" aria-labelledby="menu-title" data-lenis-prevent onCancel={event => { event.preventDefault(); setMenuOpen(false); }} onClose={() => setMenuOpen(false)} onClick={event => { if (event.target === event.currentTarget && event.clientX < event.currentTarget.getBoundingClientRect().left) setMenuOpen(false); }}>
      <div className="ss-menu-top"><span className="ss-eyebrow">FURWARD / 探索绒途</span><button ref={closeMenu} type="button" className="ss-menu-close" aria-label="关闭菜单" onClick={() => setMenuOpen(false)}>×</button></div>
      <h2 id="menu-title">每一步，<br/><em>温暖地向前。</em></h2>
      <nav aria-label="展示菜单"><a href="/experience"><span>体验</span>城市引导演示<i>↗</i></a>{hero && <a href="#home" onClick={() => setMenuOpen(false)}><span>01</span>首页演示<i>↗</i></a>}{nav.filter(([id])=>id !== 'home').map(([id,label],i)=><a className="ss-menu-nav-small" key={id} href={`#${id}`} onClick={() => setMenuOpen(false)}><span>{String(i + (hero ? 2 : 1)).padStart(2,'0')}</span>{label}<i>↗</i></a>)}</nav>
      <p>绒途 Furward · 有温度、会对话的 AI 导盲伙伴。</p><a className="ss-menu-caption" href="/admin">中文管理后台 ↗</a>
    </dialog>
    <div id="main-content">{hero && <WhiteHero section={hero} onOpenMenu={button => { returnFocus.current = button; setMenuOpen(true); }}/>} {about && <About section={about}/>} {scenes && <Scenes section={scenes} open={open}/>} {companion && <Companion section={companion}/>} {textures && <Textures section={textures} open={open}/>} {warmth && <Warmth section={warmth}/>} {technology && <Technology section={technology}/>} {gallery && <Gallery section={gallery} open={open}/>}</div>
    {footer && <footer className="site-footer" id="footer"><div className="fw-footer-top"><div><span className="fw-kicker">{footer.eyebrow}</span><p>{footer.description}</p></div><a href={footer.buttonHref}>{footer.buttonLabel} <ArrowUpRight size={22}/></a></div><div className="fw-footer-stage"><Photo className="footer-helmet" image={footer?.images[0]}/><h2>{footer?.title || content.site.footerText}</h2></div><div className="fw-footer-word" aria-hidden="true">FURWARD</div><div className="fw-footer-bottom"><span>© {new Date().getFullYear()} {content.site.name}</span><span>AI 概念设计 · 陪伴的下一种可能</span><a href="/admin">管理网站 ↗</a></div></footer>}
    {viewer && <div className="helmet-modal" role="dialog" aria-modal="true" aria-label={viewer.images[viewer.index].label} ref={overlay} data-lenis-prevent><button className="modal-close" aria-label="关闭图片查看器" onClick={() => setViewer(null)}><X/></button><div className="helmet-modal-image" key={viewer.images[viewer.index].id}><Photo image={viewer.images[viewer.index]}/></div><div className="helmet-modal-footer"><button aria-label="上一张图片" onClick={() => setViewer({ ...viewer, index: (viewer.index - 1 + viewer.images.length) % viewer.images.length })}><ArrowLeft/></button><div><h3>{viewer.images[viewer.index].label}</h3><p>AI 概念影像 · {viewer.index + 1} / {viewer.images.length}</p></div><button aria-label="下一张图片" onClick={() => setViewer({ ...viewer, index: (viewer.index + 1) % viewer.images.length })}><ArrowRight/></button></div></div>}
  </main>;
}
