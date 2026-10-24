'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUpRight, Menu, ShoppingBag, X } from 'lucide-react';
import type { ImageSlot, Section, SiteContent } from '@/lib/content';
import { editorialSections, races, sourceDate, type Race } from '@/lib/editorial-defaults';
import HeroScene from './HeroScene';
import RiveMark from './RiveMark';
import '../editorial.css';

type PageKind = 'ontrack' | 'offtrack' | 'calendar';
const links = [['HOME', '/'], ['ON TRACK', '/on-track'], ['OFF TRACK', '/off-track'], ['CALENDAR', '/calendar']];
const helmetNames = ['Season · 2025', 'Discoball · 2025', 'Dark Glitter · 2025', 'Season · 2024', 'Porcelain · 2024', 'Japan · 2024', 'GIF Helmet · 2024', 'Dark Mode · 2024', 'Race 100 · 2023', 'Las Vegas · 2023', 'Chrome · 2023', 'Beach Ball · 2023', 'Basketball · 2022', 'Season · 2021', 'Silverstone · 2020', 'Season · 2019'];
const seasonResults = [['2025', '1ST', '18'], ['2024', '2ND', '13'], ['2023', '6TH', '7'], ['2022', '7TH', '1'], ['2021', '6TH', '4'], ['2020', '9TH', '1'], ['2019', '11TH', '0']];
const wins = [
  ['BRAZIL', '09 NOV 2025', '1:32:01.596', 'brazil'], ['UNITED KINGDOM', '06 JUL 2025', '1:37:15.735', 'uk'],
  ['MONACO', '25 MAY 2025', '1:40:33.843', 'monaco'], ['AUSTRALIA', '16 MAR 2025', '1:42:06.304', 'australia'],
  ['ABU DHABI', '08 DEC 2024', '1:26:33.291', 'abu'], ['SINGAPORE', '22 SEP 2024', '1:40:52.571', 'singapore'], ['MIAMI', '05 MAY 2024', '1:30:49.876', 'miami'],
];
function Photo({ image, className = '', eager = false }: { image?: ImageSlot; className?: string; eager?: boolean }) {
  if (!image) return null;
  return <img className={className} src={image.src} alt={image.alt} loading={eager ? 'eager' : 'lazy'} decoding="async" style={{ objectPosition: `${image.positionX}% ${image.positionY}%` }} />;
}
function Signature({ image, className = '' }: { image?: ImageSlot; className?: string }) {
  return <div className={`ed-signature ${className}`}>{image?.src === '/reference/signature.svg' ? <RiveMark src="/reference-motion/rive/signature.riv" artboard="signature" stateMachine="signature_scroll" scroll colorInput="color_lime" /> : <Photo image={image}/>}</div>;
}
function SourceNote({ path = 'calendar' }: { path?: string }) {
  return <p className="ed-source">原站资料快照 · {sourceDate} · <a href={`https://landonorris.com/${path}`} target="_blank" rel="noreferrer">查看来源 <ArrowUpRight size={12}/></a><span>赛程和成绩以原站最新发布为准</span></p>;
}
function Seasons({ compact = false }: { compact?: boolean }) {
  return <div className={`ed-seasons ${compact ? 'ed-seasons-compact' : ''}`}>
    <div className="ed-season-row ed-table-label"><span>SEASON</span><span>FINISH</span><span>PODIUMS</span></div>
    {seasonResults.map(row => <div className="ed-season-row" key={row[0]}><strong>{row[0]}</strong><span>{row[1]}</span><span>{row[2]}</span></div>)}
  </div>;
}
function useEditorialMotion(root: React.RefObject<HTMLElement | null>, kind: PageKind, content: SiteContent) {
  useEffect(() => {
    let disposed = false;
    let cleanup = () => {};
    Promise.all([import('gsap'), import('gsap/ScrollTrigger')]).then(([{ gsap }, { ScrollTrigger }]) => {
      if (disposed || !root.current) return;
      gsap.registerPlugin(ScrollTrigger);
      const media = gsap.matchMedia();
      media.add('(prefers-reduced-motion: no-preference)', () => {
        const ctx = gsap.context(() => {
          gsap.from('.ed-main-title > span,.ed-calendar-heading h1', { yPercent: 25, opacity: 0, duration: 1, stagger: .13, ease: 'power3.out', clearProps: 'transform,opacity' });
          gsap.utils.toArray<HTMLElement>('[data-ed-reveal]').forEach(item => gsap.from(item, { y: 45, opacity: 0, duration: .85, ease: 'power3.out', scrollTrigger: { trigger: item, start: 'top 94%', once: true }, clearProps: 'transform,opacity' }));
          gsap.utils.toArray<HTMLElement>('.ed-podium-photo').forEach((photo, i) => gsap.fromTo(photo, { y: 70 + i * 12, rotation: (i % 2 ? -1 : 1) * 8 }, { y: -50, rotation: (i % 2 ? -1 : 1) * 2, ease: 'none', scrollTrigger: { trigger: '.ed-podium', start: 'top bottom', end: 'bottom top', scrub: .8 } }));
          gsap.utils.toArray<HTMLElement>('.ed-off-float').forEach((photo, i) => gsap.fromTo(photo, { y: 40 + i * 10 }, { y: -55, ease: 'none', scrollTrigger: { trigger: '.ed-off-hero', start: 'top top', end: 'bottom top', scrub: .7 } }));
          gsap.utils.toArray<HTMLElement>('.ed-fan a').forEach((photo, i) => gsap.fromTo(photo, { rotation: 0, y: 80 }, { rotation: (i - 2.5) * 7, y: Math.abs(i - 2.5) * 10, ease: 'power2.out', scrollTrigger: { trigger: '.ed-fan', start: 'top 95%', end: 'top 35%', scrub: .8 } }));
        }, root);
        return () => ctx.revert();
      });
      cleanup = () => media.revert();
      document.fonts.ready.then(() => { if (!disposed) ScrollTrigger.refresh(); });
    }).catch(() => { /* The complete layout remains usable without optional animation modules. */ });
    return () => { disposed = true; cleanup(); };
  }, [root, kind, content]);
}
function OnTrack({ section, openGallery }: { section: Section; openGallery: (images: ImageSlot[], index: number) => void }) {
  const image = (id: string) => section.images.find(item => item.id === id);
  const podium = section.images.filter(item => item.id.startsWith('on-podium-'));
  const gallery = section.images.filter(item => item.id.startsWith('on-gallery-'));
  const helmets = section.images.filter(item => item.id.startsWith('on-helmet-'));
  const [year, setYear] = useState('ALL');
  const [activeWin, setActiveWin] = useState(0);
  const current = races.find(race => race.id === 'austin')!;
  return <>
    <section className="ed-on-hero" id="top">
      <h1 className="ed-main-title ed-on-title" aria-label={section.title}>{section.title === 'ON TRACK' ? <><span>ON</span><span>TRACK</span></> : <span>{section.title}</span>}</h1>
      <div className="ed-helmet-host"><HeroScene helmet portrait={{ id: 'empty', label: '', src: '/reference/pages/empty.svg', alt: '', positionX: 50, positionY: 50 }} helmetImage={image('on-hero-helmet')}/></div>
      <div className="ed-on-intro"><div className="ed-biography"><span>{section.eyebrow}</span><span>26 Y.O</span><span>BRISTOL, UK 🇬🇧</span></div><p>{section.description}</p><Signature image={image('ontrack-signature')}/>
        <a href="/calendar" className="ed-race-ticket"><span>ROUND {current.round} · 2026</span><strong>{current.circuit}</strong><span>{current.country} · {current.dates} {current.month}<ArrowUpRight size={25}/></span></a>
        <a className="ed-inline-link" href="#career">EXPLORE THE CAREER <ArrowDown size={17}/></a>
      </div>
    </section>
    <section className="ed-podium" aria-labelledby="podium-title">
      <div className="ed-podium-number"><p>THE VIEW FROM THE TOP</p><h2 id="podium-title">49</h2><span>PODIUMS</span></div>
      {podium.map((photo, i) => <button type="button" key={photo.id} className={`ed-podium-photo ed-podium-photo-${i}`} onClick={() => openGallery(podium, i)} aria-label={`放大${photo.label}`}><Photo image={photo}/></button>)}
    </section>
    <section className="ed-career ed-section-pad" id="career">
      <div className="ed-section-heading" data-ed-reveal><h2>FORMULA 1<br/><em>CAREER</em></h2><p>From his McLaren debut in 2019 to race wins around the world. A career built one lap at a time.</p></div>
      <div className="ed-stat-strip">{[['13', 'RACE WINS'], ['19', 'POLE POSITIONS'], ['6.28', 'AVERAGE FINISH'], ['18', 'FASTEST LAPS']].map(([value, label]) => <div key={label}><strong>{value}</strong><span>{label}</span></div>)}</div>
      <div className="ed-career-grid"><figure data-ed-reveal><Photo image={image('on-career')}/><figcaption>AUSTRALIA · 2025</figcaption></figure><div><Seasons compact/><SourceNote path="on-track"/></div></div>
    </section>
    <section className="ed-wins ed-section-pad"><div className="ed-section-heading" data-ed-reveal><h2>RACE<br/><em>HIGHLIGHTS</em></h2><p>Moments that made the journey.<br/>Selected victories, 2024–2025.</p></div>
      <div className="ed-wins-layout"><div className="ed-win-list"><div className="ed-win-row ed-table-label"><span>GRAND PRIX</span><span>DATE</span><span>RESULT</span></div>{wins.map(([country, date, time, id], i) => <button key={id} className={`ed-win-row ${activeWin === i ? 'is-active' : ''}`} onClick={() => setActiveWin(i)} aria-pressed={activeWin === i}><span>{country}</span><span>{date}</span><span>1ST <ArrowUpRight size={15}/></span><small>{time}</small></button>)}</div><button className="ed-win-image" onClick={() => openGallery([image(`on-win-${wins[activeWin][3]}`)!], 0)} aria-label={`放大 ${wins[activeWin][0]} 获胜照片`}><Photo image={image(`on-win-${wins[activeWin][3]}`)}/><span>{wins[activeWin][0]} · FIRST PLACE ↗</span></button></div>
    </section>
    <section className="ed-photo-strip" aria-label="赛场摄影长廊"><div className="ed-photo-strip-heading"><span>FROM THE TRACKSIDE</span><span>SCROLL TO EXPLORE →</span></div><div className="ed-photo-rail">{gallery.map((photo, i) => <button key={photo.id} onClick={() => openGallery(gallery, i)} aria-label={`放大${photo.label}`}><Photo image={photo}/><span>0{i + 1} / 05</span></button>)}</div></section>
    <section className="ed-junior ed-section-pad"><div className="ed-section-heading" data-ed-reveal><h2>BEFORE<br/><em>FORMULA 1</em></h2><p>2007—2019<br/>Where the racing story began.</p></div><div className="ed-junior-layout"><figure><Photo image={image('on-junior-1')}/><Photo image={image('on-junior-2')}/></figure><div className="ed-junior-results">{[['2018', 'FIA FORMULA 2', '2ND'], ['2017', 'FIA FORMULA 3 EUROPEAN', 'CHAMPION'], ['2016', 'FORMULA RENAULT EUROCUP', 'CHAMPION'], ['2016', 'FORMULA RENAULT NEC', 'CHAMPION'], ['2016', 'TOYOTA RACING SERIES', 'CHAMPION'], ['2015', 'MSA FORMULA BRITISH F4', 'CHAMPION'], ['2014', 'CIK-FIA KARTING WORLD', 'CHAMPION'], ['2013', 'WORLD KARTING KFJ', 'CHAMPION']].map(([year, series, result]) => <div key={year + series}><span>{year}</span><strong>{series}</strong><span>{result}</span></div>)}</div></div></section>
    <section className="ed-helmet-collection ed-section-pad" id="helmets"><div className="ed-section-heading" data-ed-reveal><h2>THE<br/><em>HELMETS</em></h2><p>Same driver. A different story.<br/>Explore the collection, 2019–2025.</p></div><div className="ed-filters" aria-label="按头盔年份筛选">{['ALL', '2025', '2024', '2023', '2022', '2021', '2020', '2019'].map(value => <button key={value} onClick={() => setYear(value)} aria-pressed={year === value}>{value}</button>)}</div><div className="ed-helmet-grid">{helmets.map((photo, i) => year === 'ALL' || helmetNames[i]?.includes(year) ? <button key={photo.id} onClick={() => openGallery(helmets, i)} aria-label={`查看头盔 ${helmetNames[i]}`}><Photo image={photo}/><span>{helmetNames[i]}<ArrowUpRight size={18}/></span></button> : null)}</div></section>
  </>;
}
const projects = [
  { id: 'padel', title: <>PADEL<br/><em>TENNIS</em></>, subtitle: 'OFF THE GRID. ON THE COURT.', copy: 'A little friendly competition between race weekends. Padel is one of Lando’s favourite ways to stay active away from Formula 1.', captions: ['Miami, 2024', 'Singapore, 2024', 'Miami, 2024'] },
  { id: 'photo', title: <>PHOTOGRAPHY<br/><em>& FILM</em></>, subtitle: 'THROUGH A DIFFERENT LENS', copy: 'People, places and the moments in between. A closer look at life through Lando’s camera.', captions: ['Monaco, 2023', 'London, 2024', 'Miami, 2023', 'Behind the lens'], href: 'https://www.instagram.com/lando.jpg/', link: 'FOLLOW LANDO.JPG' },
  { id: 'lego', title: <>LEGO: ART OF<br/><em>THE BRICK</em></>, subtitle: 'WITH NATHAN SAWAYA', copy: 'Lando’s 2024 helmet became a Lego sculpture, built by artist Nathan Sawaya. The design was built one brick at a time.', captions: ['Australia, 2024', 'Australia, 2024', 'Australia, 2024'] },
  { id: 'golf', title: <>MASTERING<br/><em>THE GREEN</em></>, subtitle: '2006—CURRENT', copy: 'Trading the circuit for the course. Another game of precision, patience and finding the right line.', captions: ['Australia, 2024', 'Australia, 2024', 'Australia, 2024'] },
];
function OffTrack({ section, site, openGallery }: { section: Section; site: SiteContent['site']; openGallery: (images: ImageSlot[], index: number) => void }) {
  const image = (id: string) => section.images.find(item => item.id === id);
  const heroImages = section.images.filter(item => item.id.startsWith('off-hero-'));
  const social = section.images.filter(item => item.id.startsWith('off-social-'));
  return <>
    <section className="ed-off-hero" id="top"><h1 className="ed-main-title ed-off-title" aria-label={section.title}>{section.title === 'OFF TRACK' ? <><span>OFF</span><span>TRACK</span></> : <span>{section.title}</span>}</h1><div className="ed-off-meta"><span>Lando Norris</span><span>26 y.o</span><span>◎</span></div><div className="ed-off-intro"><span className="ed-kicker">{section.eyebrow}</span><p>{section.description}</p><Signature image={image('offtrack-signature')}/><a className="ed-inline-link" href="#projects">PERSONAL PROJECTS <ArrowDown size={17}/></a></div><button className="ed-off-main-photo" onClick={() => openGallery(heroImages, 0)} aria-label="放大生活页首屏照片"><Photo image={heroImages[0]} eager/></button><div className="ed-off-collage" aria-label="生活照片拼贴">{heroImages.slice(1).map((photo, i) => <button className={`ed-off-float ed-off-float-${i}`} key={photo.id} onClick={() => openGallery(heroImages, i + 1)} aria-label={`放大${photo.label}`}><Photo image={photo}/></button>)}</div></section>
    <section className="ed-personal-heading ed-section-pad" id="projects"><span className="ed-kicker">A WORLD BEYOND THE TRACK</span><h2 data-ed-reveal>PERSONAL<br/><em>PROJECTS</em></h2></section>
    {projects.map((project, index) => { const photos = section.images.filter(item => item.id.startsWith(`off-${project.id}-`)); return <section className={`ed-project ed-project-${project.id} ed-section-pad`} key={project.id}><div className="ed-project-intro" data-ed-reveal><span className="ed-project-index">0{index + 1}</span><h3>{project.title}</h3><div><span className="ed-kicker">{project.subtitle}</span><p>{project.copy}</p>{project.href && <a href={project.href} target="_blank" rel="noreferrer" className="ed-inline-link">{project.link}<ArrowUpRight size={18}/></a>}</div></div><div className="ed-project-gallery">{photos.map((photo, i) => <figure key={photo.id} className={`ed-project-photo ed-project-photo-${i}`} data-ed-reveal><button onClick={() => openGallery(photos, i)} aria-label={`放大${photo.label}`}><Photo image={photo}/><span>↗</span></button><figcaption>{project.captions[i]}</figcaption></figure>)}<div className="ed-project-quote"><p>IT’S HOW<br/>YOU <em>PROGRESS.</em></p><Photo image={image('offtrack-signature')}/></div></div></section>; })}
    <section className="ed-social ed-section-pad"><h2 data-ed-reveal>WHAT’S UP<br/><em>ON SOCIALS</em></h2><div className="ed-fan">{social.map(photo => <a href={site.instagram} target="_blank" rel="noreferrer" key={photo.id} aria-label="在 Instagram 查看 Lando"><Photo image={photo}/><ArrowUpRight/></a>)}</div><div className="ed-social-links"><span>Follow Lando on social media</span>{[['INSTAGRAM', site.instagram], ['TIKTOK', site.tiktok], ['YOUTUBE', site.youtube], ['TWITCH', 'https://www.twitch.tv/landonorris']].map(([label, href]) => <a key={label} href={href} target="_blank" rel="noreferrer">{label}<ArrowUpRight size={15}/></a>)}</div></section>
  </>;
}
function Schedule({ race }: { race: Race }) {
  return <div className="ed-schedule"><div className="ed-schedule-row ed-table-label"><span>SESSION</span><span>DATE</span><span>UK TIME</span><span>RESULT</span><span>TIME / GAP</span></div>{race.sessions.map(session => <div className="ed-schedule-row" key={session.name}><strong>{session.name}</strong><span>{session.date}</span><span>{session.time}</span><span>{session.result}</span><span>{session.gap}</span></div>)}<small>*UK TIME · “—” 表示原站尚未填写</small></div>;
}
function Calendar({ section }: { section: Section }) {
  const [selectedId, setSelectedId] = useState('austin');
  const [filter, setFilter] = useState('UPCOMING');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const selectedIndex = races.findIndex(race => race.id === selectedId);
  const selected = races[selectedIndex];
  const filtered = races.filter(race => filter === 'ALL' || (filter === 'UPCOMING' ? race.upcoming : !race.upcoming));
  const image = (id: string) => section.images.find(item => item.id === id);
  const navigate = (step: number) => setSelectedId(races[(selectedIndex + step + races.length) % races.length].id);
  return <>
    <section className="ed-calendar-heading" id="top"><h1><span>{section.eyebrow}</span><em>{section.title}</em></h1><Signature image={image('calendar-signature')}/></section>
    <section className="ed-calendar-intro ed-section-pad"><p>{section.description}</p><div className="ed-standing"><span>STANDING</span><strong>6<sup>TH</sup></strong></div><div className="ed-standing"><span>ROUND</span><strong>18</strong></div><div className="ed-calendar-jumps"><a className="ed-outline-link" href="#track-vis">TRACK VISUALISER <ArrowDown size={16}/></a><a className="ed-outline-link" href="#calendar-list">CALENDAR LIST <ArrowDown size={16}/></a></div></section>
    <section className="ed-track-visualiser ed-section-pad" id="track-vis" aria-label="赛道可视化"><div className="ed-track-label"><Photo image={image(`cal-flag-${selected.id}`)}/><h2>{selected.circuit}</h2></div><div className="ed-track-dashboard"><div className="ed-track-metrics"><div><span>WHEN</span><strong>{selected.dates}</strong><em>{selected.month}</em></div><div><span>LENGTH</span><strong>{selected.length}<small> KM</small></strong></div><div><span>DISTANCE</span><strong>{selected.distance}<small> KM</small></strong></div><div><span>LAPS</span><strong>{selected.laps}</strong></div><div><span>FIRST COMPETED</span><strong>{selected.first || '—'}</strong></div></div><div className="ed-circuit-display"><div className="ed-circuit-drawing">{selected.id === 'madrid' ? <div className="ed-circuit-pending"><strong>MADRING</strong><span>CIRCUIT MAP COMING SOON</span></div> : <RiveMark key={selected.id} src="/reference-motion/rive/circuits.riv" artboard="circuits" stateMachine="circuits" colorInput="color_lime" trackInput={selected.id}/>}</div><div className="ed-circuit-caption"><span>ROUND {selected.round}</span><strong>{selected.country}</strong><span>{selected.upcoming ? '2026 RACE WEEKEND' : `FINISH · ${selected.finish}`}</span></div></div><Schedule race={selected}/><div className="ed-track-controls"><button onClick={() => navigate(-1)} aria-label="上一条赛道"><ArrowLeft/></button><label>SELECT A CIRCUIT<select value={selected.id} onChange={event => setSelectedId(event.target.value)}>{races.map(race => <option value={race.id} key={race.id}>{race.country} · {race.circuit}</option>)}</select></label><button onClick={() => navigate(1)} aria-label="下一条赛道"><ArrowRight/></button></div></div></section>
    <div className="ed-source-wrap"><SourceNote/></div>
    <section className="ed-calendar-list ed-section-pad" id="calendar-list"><div className="ed-calendar-list-top"><h2>THE 2026<br/><em>SEASON</em></h2><div className="ed-filters" aria-label="筛选赛程">{['UPCOMING', 'RESULTS', 'ALL'].map(value => <button key={value} onClick={() => setFilter(value)} aria-pressed={filter === value}>{value === 'UPCOMING' ? 'UPCOMING · 6' : value === 'RESULTS' ? 'RESULTS · 18' : 'ALL · 24'}</button>)}</div></div><div className="ed-race-row ed-table-label"><span>ROUND</span><span>LOCATION</span><span>WHEN</span><span>{filter === 'UPCOMING' ? 'LAPS' : 'FINISH'}</span><span>{filter === 'UPCOMING' ? 'DISTANCE' : 'FASTEST LAP'}</span><span/></div>{filtered.map(race => <div className={`ed-race-entry ${expandedId === race.id ? 'is-expanded' : ''}`} key={race.id}><button className="ed-race-row" onClick={() => { setExpandedId(expandedId === race.id ? null : race.id); setSelectedId(race.id); }} aria-expanded={expandedId === race.id} aria-controls={`race-${race.id}`}><span>{race.round}<Photo image={image(`cal-flag-${race.id}`)}/></span><strong>{race.country}<small className="ed-mobile-result">{race.upcoming ? `${race.laps} LAPS · ${race.distance} KM` : `${race.finish} · ${race.fastest}`}</small></strong><span>{race.date}</span><span>{filter === 'UPCOMING' ? race.laps : race.finish}</span><span>{filter === 'UPCOMING' ? `${race.distance} KM` : race.fastest}</span><span>{expandedId === race.id ? '−' : '+'}</span></button>{expandedId === race.id && <div className="ed-race-details" id={`race-${race.id}`}><div><span className="ed-kicker">{race.circuit}</span><p>{race.length} KM<br/>{race.laps} LAPS</p><a href="#track-vis" className="ed-inline-link">VIEW CIRCUIT <ArrowUpRight size={16}/></a></div><Schedule race={race}/></div>}</div>)}</section>
    <section className="ed-all-results ed-section-pad"><div className="ed-section-heading" data-ed-reveal><h2>FORMULA 1<br/><em>ALL RESULTS</em></h2><p>The seasons so far.<br/>Championship finish and podiums.</p></div><Seasons/><SourceNote/></section>
  </>;
}
export default function EditorialPage({ kind, initialContent }: { kind: PageKind; initialContent: SiteContent }) {
  const [content, setContent] = useState(initialContent);
  const [preview, setPreview] = useState(false);
  const [notice, setNotice] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [viewer, setViewer] = useState<{ images: ImageSlot[]; index: number } | null>(null);
  const root = useRef<HTMLElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLElement | null>(null);
  useEditorialMotion(root, kind, content);
  useEffect(() => {
    const isPreview = new URLSearchParams(window.location.search).get('preview') === '1';
    setPreview(isPreview);
    const readDraft = () => { try { const raw = localStorage.getItem('lando-content-draft'); if (raw) { const saved = JSON.parse(raw); const draft = saved.content || saved; if (draft.site && Array.isArray(draft.sections)) { setContent(draft); return true; } } } catch { /* Ignore invalid browser cache; keep server content. */ } return false; };
    if (!(isPreview && readDraft())) fetch('/api/content', { cache: 'no-store' }).then(response => { if (!response.ok) throw new Error(); return response.json(); }).then((data: unknown) => { const response = data as { content?: SiteContent }; if (response.content?.site && Array.isArray(response.content.sections)) setContent(response.content); }).catch(() => setNotice('暂时无法刷新内容，正在显示上次读取的版本。'));
    const update = () => { if (isPreview) readDraft(); };
    window.addEventListener('storage', update); return () => window.removeEventListener('storage', update);
  }, []);
  useEffect(() => {
    if (!menuOpen && !viewer) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const first = overlay.current?.querySelector<HTMLElement>('button,a'); first?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setMenuOpen(false); setViewer(null); }
      if (viewer && ['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); setViewer(value => value ? { ...value, index: (value.index + (event.key === 'ArrowRight' ? 1 : -1) + value.images.length) % value.images.length } : null); }
      if (event.key === 'Tab') { const controls = Array.from(overlay.current?.querySelectorAll<HTMLElement>('a,button,select') || []); const first = controls[0], last = controls[controls.length - 1]; if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); } }
    };
    window.addEventListener('keydown', keyboard); return () => { document.body.style.overflow = previousOverflow; window.removeEventListener('keydown', keyboard); trigger.current?.focus(); };
  }, [menuOpen, Boolean(viewer)]); // Viewer index changes keep focus in the open dialog.
  const fallback = editorialSections.find(section => section.id === kind)!;
  const saved = content.sections.find(section => section.id === kind);
  const section = saved ? { ...fallback, ...saved, images: fallback.images.map(image => saved.images.find(item => item.id === image.id) || image) } : fallback;
  const logo = content.sections.find(item => item.id === 'hero')?.images.find(item => item.id === 'hero-logo');
  const footerImage = content.sections.find(item => item.id === 'hero')?.images.find(item => item.id === 'hero-helmet');
  const openGallery = (images: ImageSlot[], index: number) => { trigger.current = document.activeElement as HTMLElement; setViewer({ images: images.filter(Boolean), index }); };
  const changePhoto = (step: number) => setViewer(value => value ? { ...value, index: (value.index + step + value.images.length) % value.images.length } : null);
  return <main ref={root} className={`editorial-page ed-${kind}`} style={{ '--acid': content.site.accent } as CSSProperties}>
    <a className="ed-skip" href="#ed-content">跳到主要内容</a>
    {preview && <div className="ed-preview">草稿预览 · 尚未保存到网站 <a href="/admin">返回后台</a></div>}
    {notice && <div className="ed-notice" role="status">{notice}</div>}
    <header className={`ed-header ${preview ? 'ed-with-preview' : ''}`}><a href="/" className="ed-wordmark" aria-label={`${content.site.name} · 首页`}>{content.site.name === 'LANDO NORRIS' ? <><em>LANDO</em><b>NORRIS</b></> : content.site.name}</a><a className="ed-header-logo" href="/" aria-label="返回首页"><Photo image={logo}/></a><div className="ed-header-actions"><a href="https://store.landonorris.com/" target="_blank" rel="noreferrer" className="ed-store"><ShoppingBag size={20}/><span>STORE</span></a><button aria-label="打开导航菜单" aria-expanded={menuOpen} onClick={() => { trigger.current = document.activeElement as HTMLElement; setMenuOpen(true); }}><Menu size={26}/></button></div></header>
    <div id="ed-content">{section.enabled ? kind === 'ontrack' ? <OnTrack section={section} openGallery={openGallery}/> : kind === 'offtrack' ? <OffTrack section={section} site={content.site} openGallery={openGallery}/> : <Calendar section={section}/> : <section className="ed-unavailable"><h1>{section.title}</h1><p>此页面正在更新。</p><a href="/">返回首页 ↗</a></section>}</div>
    <footer className="ed-footer"><div className="ed-footer-links"><div><span>PAGES</span>{links.map(([label, href]) => <a key={href} href={href}>{label}</a>)}<a href="/admin">中文管理后台 ↗</a></div><div><span>FOLLOW ON</span>{[['INSTAGRAM', content.site.instagram], ['YOUTUBE', content.site.youtube], ['TIKTOK', content.site.tiktok]].map(([label, href]) => <a key={label} href={href} target="_blank" rel="noreferrer">{label}</a>)}</div><a className="ed-back-top" href="#top">BACK TO TOP <ArrowUpRight size={22}/></a></div><div className="ed-footer-finale"><Photo image={footerImage}/><h2>{content.site.footerText}</h2></div><div className="ed-footer-bottom"><span>© 2026 {content.site.name} · 独立复刻演示</span><a href="https://landonorris.com/" target="_blank" rel="noreferrer">参考原站 <ArrowUpRight size={13}/></a><a href="/admin">管理网站</a></div></footer>
    {menuOpen && <div className="ed-menu" ref={overlay} role="dialog" aria-modal="true" aria-label="网站导航"><div className="ed-menu-top"><span>{content.site.name}</span><button onClick={() => setMenuOpen(false)} aria-label="关闭导航菜单"><X/></button></div><nav>{links.map(([label, href], index) => <a href={href} key={href}><small>0{index + 1}</small>{label}<ArrowUpRight/></a>)}</nav><div className="ed-menu-bottom"><span>A LIFE ON TRACK. A WORLD BEYOND IT.</span><a href="/admin">中文管理后台 <ArrowUpRight size={19}/></a></div></div>}
    {viewer && <div className="ed-viewer" ref={overlay} role="dialog" aria-modal="true" aria-label="图片查看器"><button className="ed-viewer-close" onClick={() => setViewer(null)} aria-label="关闭图片查看器"><X/></button><Photo image={viewer.images[viewer.index]}/><div className="ed-viewer-controls"><button onClick={() => changePhoto(-1)} disabled={viewer.images.length < 2} aria-label="上一张图片"><ArrowLeft/></button><div><p>{viewer.images[viewer.index]?.label}</p><span>{viewer.index + 1} / {viewer.images.length}</span></div><button onClick={() => changePhoto(1)} disabled={viewer.images.length < 2} aria-label="下一张图片"><ArrowRight/></button></div></div>}
  </main>;
}
