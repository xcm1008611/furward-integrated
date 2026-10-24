/** Frozen pre-Furward content, used only by offline migration reports. Never a public fallback. */
import { editorialSections } from './editorial-defaults';
export type ImageSlot = { id: string; label: string; src: string; alt: string; positionX: number; positionY: number };
export type Section = { id: string; enabled: boolean; title: string; eyebrow: string; description: string; buttonLabel: string; buttonHref: string; images: ImageSlot[] };
export type SiteContent = { site: { name: string; tagline: string; accent: string; footerText: string; instagram: string; youtube: string; tiktok: string }; sections: Section[] };
const img = (id: string, label: string, file: string, alt: string): ImageSlot => ({ id, label, src: `/reference/${file}`, alt, positionX: 50, positionY: 50 });
const legacyContent: SiteContent = {
  site: { name: 'LANDO NORRIS', tagline: 'MCLAREN F1 SINCE 2019', accent: '#d2ff00', footerText: 'Always bringing the fight.', instagram: 'https://www.instagram.com/landonorris/', youtube: 'https://www.youtube.com/@LandoNorris', tiktok: 'https://www.tiktok.com/@landonorris' },
  sections: [
    { id: 'hero', enabled: true, title: 'LANDO NORRIS', eyebrow: 'MCLAREN F1 SINCE 2019', description: 'A life on track. A world beyond it.', buttonLabel: 'EXPLORE MY WORLD', buttonHref: '#about', images: [img('hero-portrait', '首页正面人像', 'hero-diffuse.webp', 'Lando Norris 正面肖像'), img('hero-helmet', '首页互动头盔', 'footer-helmet.webp', 'Lando Norris 戴上头盔'), img('hero-logo', '首页顶部品牌 Logo', 'logo-ln.svg', 'LN 品牌标志')] },
    { id: 'about', enabled: true, title: 'THIS IS LANDO.', eyebrow: 'ON TRACK. OFF TRACK.', description: 'Race weekends. Quiet moments. Everything in between. Step into the world of Lando Norris, on the circuit and beyond.', buttonLabel: 'EXPLORE THE HELMETS', buttonHref: '#helmets', images: [img('about-track', '人物介绍左侧赛车照', 'story-car.webp', 'Lando Norris 驾驶迈凯伦赛车'), img('about-life', '人物介绍右侧生活照', 'story-golf.webp', 'Lando Norris 打高尔夫'), img('about-portrait', '人物介绍下方特写', 'story-paddock.webp', 'Lando Norris 在围场'), img('about-signature', '人物介绍签名图', 'signature.svg', 'Lando Norris 签名')] },
    { id: 'helmets', enabled: true, title: 'THE HELMETS.', eyebrow: 'A DIFFERENT SIDE OF THE STORY', description: 'Every race has a story. Every helmet has a personality. Explore the colours, details and designs.', buttonLabel: 'VIEW ON TRACK', buttonHref: '#about', images: [img('helmet-season', 'Season · 2025', 'helmet-season.webp', 'Season 2025 荧光绿头盔'), img('helmet-disco', 'Discoball · 2025', 'helmet-discoball.webp', 'Discoball 2025 镜面头盔'), img('helmet-dark', 'Dark Glitter · 2025', 'helmet-dark.webp', 'Dark Glitter 黑色头盔'), img('helmet-porcelain', 'Porcelain · 2024', 'helmet-porcelain.webp', 'Porcelain 蓝白头盔'), img('helmet-japan', 'Japan · 2024', 'helmet-japan.webp', 'Japan 日本站头盔')] },
    { id: 'shop', enabled: true, title: 'MADE FOR THE FANS.', eyebrow: 'LANDO STORE', description: 'Wear your support. Discover the collection, made to bring a little of the track into your everyday.', buttonLabel: 'VISIT THE STORE', buttonHref: 'https://landonorris.store/', images: [img('shop-main', '商城主展示图', 'store-02.webp', 'Lando Store 冠军纪念服饰'), img('shop-second', '商城辅助展示图', 'store-03.webp', 'Lando Store 冠军纪念产品'), img('shop-detail', '商城产品细节图', 'store-01.webp', 'Lando Store 产品细节')] },
    { id: 'partners', enabled: true, title: 'PARTNERS & CAMPAIGNS.', eyebrow: 'GOOD COMPANY', description: 'Shared ambition. Different perspectives. A look at the people, brands and projects along the way.', buttonLabel: 'FOLLOW THE JOURNEY', buttonHref: 'https://www.instagram.com/landonorris/', images: [img('partner-one', '合作伙伴第一张图片', 'social-offtrack.webp', 'Lando Norris 赛道外的日常'), img('partner-two', '合作伙伴第二张图片', 'social-track.webp', 'Lando Norris 赛车摄影'), img('partner-three', '合作伙伴第三张图片', 'social-lifestyle.webp', 'Lando Norris 生活与合作项目'), img('partner-logo-ralph', '合作品牌 RALPH 标志', 'partner-logo-ralph.svg', 'RALPH'), img('partner-logo-tumi', '合作品牌 TUMI 标志', 'partner-logo-tumi.svg', 'TUMI'), img('partner-logo-hilton', '合作品牌 HILTON 标志', 'partner-logo-hilton.svg', 'HILTON'), img('partner-logo-quadrant', '合作品牌 QUADRANT 标志', 'partner-logo-quadrant.svg', 'QUADRANT'), img('partner-logo-mind', '合作品牌 MIND 标志', 'partner-logo-mind.svg', 'MIND'), img('partner-logo-uber', '合作品牌 UBER 标志', 'partner-logo-uber.svg', 'UBER')] }
  ]
};

const expandedHelmets: ImageSlot[] = [
  {
    "label": "Season · 2025",
    "src": "/reference/helmet-season.webp",
    "alt": "Lando Norris 2025 Season 头盔",
    "positionX": 50,
    "positionY": 50,
    "id": "helmet-season"
  },
  {
    "label": "Season · 2025 · 悬停第二视角",
    "src": "/reference-motion/helmets/helmet-2025-season-hover.webp",
    "alt": "Lando Norris 2025 Season 头盔",
    "positionX": 50,
    "positionY": 50,
    "id": "helmet-season-hover"
  },
  {
    "label": "Discoball · 2025",
    "src": "/reference/helmet-discoball.webp",
    "alt": "Lando Norris 2025 Discoball 头盔",
    "positionX": 50,
    "positionY": 50,
    "id": "helmet-disco"
  },
  {
    "label": "Discoball · 2025 · 悬停第二视角",
    "src": "/reference-motion/helmets/helmet-2025-discoball-hover.webp",
    "alt": "Lando Norris 2025 Discoball 头盔",
    "positionX": 50,
    "positionY": 50,
    "id": "helmet-disco-hover"
  },
  {
    "label": "Dark Glitter · 2025",
    "src": "/reference/helmet-dark.webp",
    "alt": "Lando Norris 2025 Dark Glitter 头盔",
    "positionX": 50,
    "positionY": 50,
    "id": "helmet-dark"
  },
  {
    "label": "Dark Glitter · 2025 · 悬停第二视角",
    "src": "/reference-motion/helmets/helmet-2025-dark-glitter-hover.webp",
    "alt": "Lando Norris 2025 Dark Glitter 头盔",
    "positionX": 50,
    "positionY": 50,
    "id": "helmet-dark-hover"
  },
  {
    "label": "Season · 2024",
    "src": "/reference-motion/helmets/helmet-2024-season.webp",
    "alt": "Lando Norris 2024 Season 头盔",
    "positionX": 50,
    "positionY": 50,
    "id": "helmet-2024-season"
  },
  {
    "label": "Season · 2024 · 悬停第二视角",
    "src": "/reference-motion/helmets/helmet-2024-season-hover.webp",
    "alt": "Lando Norris 2024 Season 头盔",
    "positionX": 50,
    "positionY": 50,
    "id": "helmet-2024-season-hover"
  },
  {
    "label": "Porcelain · 2024",
    "src": "/reference/helmet-porcelain.webp",
    "alt": "Lando Norris 2024 Porcelain 头盔",
    "positionX": 50,
    "positionY": 50,
    "id": "helmet-porcelain"
  },
  {
    "label": "Porcelain · 2024 · 悬停第二视角",
    "src": "/reference-motion/helmets/helmet-2024-porcelain-hover.webp",
    "alt": "Lando Norris 2024 Porcelain 头盔",
    "positionX": 50,
    "positionY": 50,
    "id": "helmet-porcelain-hover"
  },
  {
    "label": "Japan · 2024",
    "src": "/reference/helmet-japan.webp",
    "alt": "Lando Norris 2024 Japan 头盔",
    "positionX": 50,
    "positionY": 50,
    "id": "helmet-japan"
  },
  {
    "label": "Japan · 2024 · 悬停第二视角",
    "src": "/reference-motion/helmets/helmet-2024-japan-hover.webp",
    "alt": "Lando Norris 2024 Japan 头盔",
    "positionX": 50,
    "positionY": 50,
    "id": "helmet-japan-hover"
  },
  {
    "label": "GIF · 2024",
    "src": "/reference-motion/helmets/helmet-2024-gif.webp",
    "alt": "Lando Norris 2024 GIF 头盔",
    "positionX": 50,
    "positionY": 50,
    "id": "helmet-2024-gif"
  },
  {
    "label": "GIF · 2024 · 悬停第二视角",
    "src": "/reference-motion/helmets/helmet-2024-gif-hover.webp",
    "alt": "Lando Norris 2024 GIF 头盔",
    "positionX": 50,
    "positionY": 50,
    "id": "helmet-2024-gif-hover"
  },
  {
    "label": "Dark Mode · 2024",
    "src": "/reference-motion/helmets/helmet-2024-dark-mode.webp",
    "alt": "Lando Norris 2024 Dark Mode 头盔",
    "positionX": 50,
    "positionY": 50,
    "id": "helmet-2024-dark-mode"
  },
  {
    "label": "Dark Mode · 2024 · 悬停第二视角",
    "src": "/reference-motion/helmets/helmet-2024-dark-mode-hover.webp",
    "alt": "Lando Norris 2024 Dark Mode 头盔",
    "positionX": 50,
    "positionY": 50,
    "id": "helmet-2024-dark-mode-hover"
  },
  {
    "label": "Race 100 · 2023",
    "src": "/reference-motion/helmets/helmet-2023-race-100.webp",
    "alt": "Lando Norris 2023 Race 100 头盔",
    "positionX": 50,
    "positionY": 50,
    "id": "helmet-2023-race-100"
  },
  {
    "label": "Race 100 · 2023 · 悬停第二视角",
    "src": "/reference-motion/helmets/helmet-2023-race-100-hover.webp",
    "alt": "Lando Norris 2023 Race 100 头盔",
    "positionX": 50,
    "positionY": 50,
    "id": "helmet-2023-race-100-hover"
  },
  {
    "label": "Las Vegas · 2023",
    "src": "/reference-motion/helmets/helmet-2023-las-vegas.webp",
    "alt": "Lando Norris 2023 Las Vegas 头盔",
    "positionX": 50,
    "positionY": 50,
    "id": "helmet-2023-las-vegas"
  },
  {
    "label": "Las Vegas · 2023 · 悬停第二视角",
    "src": "/reference-motion/helmets/helmet-2023-las-vegas-hover.webp",
    "alt": "Lando Norris 2023 Las Vegas 头盔",
    "positionX": 50,
    "positionY": 50,
    "id": "helmet-2023-las-vegas-hover"
  },
  {
    "label": "Chrome · 2023",
    "src": "/reference-motion/helmets/helmet-2023-chrome.webp",
    "alt": "Lando Norris 2023 Chrome 头盔",
    "positionX": 50,
    "positionY": 50,
    "id": "helmet-2023-chrome"
  },
  {
    "label": "Chrome · 2023 · 悬停第二视角",
    "src": "/reference-motion/helmets/helmet-2023-chrome-hover.webp",
    "alt": "Lando Norris 2023 Chrome 头盔",
    "positionX": 50,
    "positionY": 50,
    "id": "helmet-2023-chrome-hover"
  },
  {
    "label": "Beachball · 2023",
    "src": "/reference/helmet-beachball.webp",
    "alt": "Lando Norris 2023 Beachball 头盔",
    "positionX": 50,
    "positionY": 50,
    "id": "helmet-2023-beachball"
  },
  {
    "label": "Beachball · 2023 · 悬停第二视角",
    "src": "/reference-motion/helmets/helmet-2023-beachball-hover.webp",
    "alt": "Lando Norris 2023 Beachball 头盔",
    "positionX": 50,
    "positionY": 50,
    "id": "helmet-2023-beachball-hover"
  },
  {
    "label": "Basketball · 2022",
    "src": "/reference-motion/helmets/helmet-2022-basketball.webp",
    "alt": "Lando Norris 2022 Basketball 头盔",
    "positionX": 50,
    "positionY": 50,
    "id": "helmet-2022-basketball"
  },
  {
    "label": "Basketball · 2022 · 悬停第二视角",
    "src": "/reference-motion/helmets/helmet-2022-basketball-hover.webp",
    "alt": "Lando Norris 2022 Basketball 头盔",
    "positionX": 50,
    "positionY": 50,
    "id": "helmet-2022-basketball-hover"
  },
  {
    "label": "Season · 2021",
    "src": "/reference-motion/helmets/helmet-2021-season.webp",
    "alt": "Lando Norris 2021 Season 头盔",
    "positionX": 50,
    "positionY": 50,
    "id": "helmet-2021-season"
  },
  {
    "label": "Season · 2021 · 悬停第二视角",
    "src": "/reference-motion/helmets/helmet-2021-season-hover.webp",
    "alt": "Lando Norris 2021 Season 头盔",
    "positionX": 50,
    "positionY": 50,
    "id": "helmet-2021-season-hover"
  },
  {
    "label": "Silverstone · 2020",
    "src": "/reference-motion/helmets/helmet-2020-silverstone.webp",
    "alt": "Lando Norris 2020 Silverstone 头盔",
    "positionX": 50,
    "positionY": 50,
    "id": "helmet-2020-silverstone"
  },
  {
    "label": "Silverstone · 2020 · 悬停第二视角",
    "src": "/reference-motion/helmets/helmet-2020-silverstone-hover.webp",
    "alt": "Lando Norris 2020 Silverstone 头盔",
    "positionX": 50,
    "positionY": 50,
    "id": "helmet-2020-silverstone-hover"
  },
  {
    "label": "Season · 2019",
    "src": "/reference-motion/helmets/helmet-2019-season.webp",
    "alt": "Lando Norris 2019 Season 头盔",
    "positionX": 50,
    "positionY": 50,
    "id": "helmet-2019-season"
  },
  {
    "label": "Season · 2019 · 悬停第二视角",
    "src": "/reference-motion/helmets/helmet-2019-season-hover.webp",
    "alt": "Lando Norris 2019 Season 头盔",
    "positionX": 50,
    "positionY": 50,
    "id": "helmet-2019-season-hover"
  }
];
const expandedStory: ImageSlot[] = [
  {
    "id": "story-award",
    "label": "FIA PRIZE GIVING, 2024",
    "src": "/reference/story-award.webp",
    "alt": "FIA PRIZE GIVING, 2024",
    "positionX": 50,
    "positionY": 50
  },
  {
    "id": "story-trophy",
    "label": "MIAMI GP, 2024",
    "src": "/reference/story-trophy.webp",
    "alt": "MIAMI GP, 2024",
    "positionX": 50,
    "positionY": 50
  },
  {
    "id": "story-dog",
    "label": "BATTERSEA, 2024",
    "src": "/reference/story-dog.webp",
    "alt": "BATTERSEA, 2024",
    "positionX": 50,
    "positionY": 50
  },
  {
    "id": "story-tux",
    "label": "HIGH PERFORMANCE GALA, 2024",
    "src": "/reference-motion/story-tux.webp",
    "alt": "HIGH PERFORMANCE GALA, 2024",
    "positionX": 50,
    "positionY": 50
  },
  {
    "id": "story-plane",
    "label": "BARCELONA, 2024",
    "src": "/reference/story-plane.webp",
    "alt": "BARCELONA, 2024",
    "positionX": 50,
    "positionY": 50
  },
  {
    "id": "story-trophy-2",
    "label": "AUSTRIA, 2020",
    "src": "/reference-motion/story-trophy-2.webp",
    "alt": "AUSTRIA, 2020",
    "positionX": 50,
    "positionY": 50
  },
  {
    "id": "story-win",
    "label": "US, 2024",
    "src": "/reference/story-win.webp",
    "alt": "US, 2024",
    "positionX": 50,
    "positionY": 50
  },
  {
    "id": "about-message",
    "label": "开场消息人物图片",
    "src": "/reference/hero-diffuse.webp",
    "alt": "开场消息人物图片",
    "positionX": 50,
    "positionY": 50
  },
  {
    "id": "track-on",
    "label": "ON TRACK 左侧戴头盔人物",
    "src": "/reference/portrait-helmet.webp",
    "alt": "ON TRACK 左侧戴头盔人物",
    "positionX": 50,
    "positionY": 50
  },
  {
    "id": "track-off",
    "label": "OFF TRACK 右侧生活人物",
    "src": "/reference/portrait-side.webp",
    "alt": "OFF TRACK 右侧生活人物",
    "positionX": 50,
    "positionY": 50
  },
  {
    "id": "helmet-lift",
    "label": "头盔展示前全屏过渡图",
    "src": "/reference/helmet-lift.webp",
    "alt": "头盔展示前全屏过渡图",
    "positionX": 50,
    "positionY": 50
  }
];

export const defaultContent: SiteContent = {
  site: {...legacyContent.site},
  sections: [
    ...legacyContent.sections.map(section => {
      if(section.id==='about') return {...section, title:'Redefining limits, fighting for wins, bringing it all in all ways. Defining a legacy in Formula 1 on and off the track.', eyebrow:'MCLAREN F1 SINCE 2019', description:'Redefining limits, fighting for wins, bringing it all in all ways. Defining a legacy in Formula 1 on and off the track.', buttonLabel:'EXPLORE ON TRACK',buttonHref:'/on-track',images:[...section.images.map(image=>({...image,label:({"about-track":"BRITAIN, 2025","about-life":"MONACO, 2023","about-portrait":"QATAR, 2024"} as Record<string,string>)[image.id]||image.label})),...expandedStory]};
      if(section.id==='helmets') return {...section,title:'HELMETS',eyebrow:'HALL OF FAME',description:'From his iconic blobs to innovative one-off designs, Lando has always been passionate about designing innovative and memorable helmets.',buttonHref:'/on-track',images:expandedHelmets};
      if(section.id==='shop') return {...section,title:"WORLD DRIVERS’ CHAMPION",description:'Celebrate this incredible moment with a collection designed for the fans who never stopped believing. Wear it, frame it, treasure it forever.',images:[...section.images,img('shop-four','商城左侧辅助人像','store-04.webp','Lando Store 冠军系列')]};
      if(section.id==='partners') return {...section,description:'Lando is proud to collaborate with a range of partners, who share his passion for performance across a range of industries.',images:[...section.images,{id:'social-four',label:'社交照片：高尔夫',src:'/reference-motion/social/social-2.webp',alt:'Lando Norris 高尔夫',positionX:50,positionY:50},{id:'social-five',label:'社交照片：围场',src:'/reference-motion/social/social-5.webp',alt:'Lando Norris 赛车围场',positionX:50,positionY:50},{id:'social-six',label:'社交照片：小狗',src:'/reference-motion/social/social-6.webp',alt:'Lando Norris 与小狗',positionX:50,positionY:50},{id:'social-seven',label:'社交照片：日常',src:'/reference/pages/off-social-5.webp',alt:'Lando Norris 轻松日常',positionX:50,positionY:50}]};
      return {...section};
    }),
    ...editorialSections,
  ]
};

/** Add new editable slots without replacing a user's saved images or text.
 * Only unchanged first-release demo copy is upgraded to the reference copy. */
export function upgradeContent(saved: SiteContent): SiteContent {
  return {
    site:{...defaultContent.site,...saved.site},
    sections:defaultContent.sections.map(base=>{
      const existing=saved.sections.find(s=>s.id===base.id);
      if(!existing)return structuredClone(base);
      const legacy=legacyContent.sections.find(s=>s.id===base.id);
      const updated={...base,...existing};
      for(const key of ['title','eyebrow','description','buttonLabel','buttonHref'] as const){
        if(legacy&&existing[key]===legacy[key])updated[key]=base[key];
      }
      updated.images=base.images.map(image=>{
        const savedImage=existing.images.find(i=>i.id===image.id);
        if(!savedImage)return {...image};
        const oldImage=legacy?.images.find(i=>i.id===image.id);
        return {...savedImage,label:oldImage&&savedImage.label===oldImage.label?image.label:savedImage.label};
      });
      for(const image of existing.images)if(!updated.images.some(i=>i.id===image.id))updated.images.push({...image});
      return updated;
    })
  };
}

export { legacyContent as firstReleaseContent };
