import { furwardV2Defaults } from './furward-v2-defaults';

export const FURWARD_SCHEMA_VERSION = 3 as const;
export const DRAFT_KEY = 'furward-content-draft-v3';
export const SECTION_IDS = ['hero', 'about', 'scenes', 'companion', 'textures', 'warmth', 'technology', 'gallery', 'footer'] as const;
export type ImageSlot = { id: string; label: string; src: string; alt: string; positionX: number; positionY: number; scale?: number };
export type SectionItem = { id: string; title: string; eyebrow: string; description: string };
export type Section = { id: string; enabled: boolean; title: string; eyebrow: string; description: string; buttonLabel: string; buttonHref: string; images: ImageSlot[]; items?: SectionItem[] };
export type SiteContent = { schemaVersion: typeof FURWARD_SCHEMA_VERSION; site: { name: string; tagline: string; accent: string; footerText: string; instagram: string; youtube: string; tiktok: string }; sections: Section[] };
const image = (id: string, label: string, file: string, alt: string): ImageSlot => ({ id, label, src: `/reference/${/^(scene-|texture-)/.test(file) ? 'furward-v3' : 'furward'}/${file}`, alt, positionX: 50, positionY: 50, scale: 1 });
const sceneNames = [
  ['scene-path', '沿路同行', '视障人士位于人行道盲道上，与绒途机器狗沿路同行的概念画面'],
  ['scene-curve', '转弯引路', '视障人士位于弯道盲道上，绒途机器狗在旁引路的概念画面'],
  ['scene-obstacle', '留意障碍', '视障人士位于盲道上，在绒途机器狗陪伴下留意前方障碍的概念画面'],
  ['scene-step', '台阶停步', '视障人士位于台阶前的提示盲道上，与绒途机器狗一同停步的概念画面'],
  ['scene-signal', '路口等待', '视障人士位于路口等候区的盲道上，与绒途机器狗一起等待的概念画面'],
  ['scene-indoor', '室内相伴', '视障人士位于室内通道的盲道上，绒途机器狗在旁陪伴的概念画面'],
] as const;
export const defaultContent: SiteContent = {
  schemaVersion: FURWARD_SCHEMA_VERSION,
  site: { name: '绒途 Furward', tagline: '让每一步，都有温柔回应。', accent: '#d2ff00', footerText: '向前一步，温柔始终在旁。', instagram: '', youtube: '', tiktok: '' },
  sections: [
    { id: 'hero', enabled: true, title: '摸得到温暖，听得见方向。', eyebrow: '有温度、会对话的 AI 导盲伙伴', description: '绒，是触摸与陪伴；途，是自主前行。温暖地陪你向前，让每一步都有回应。', buttonLabel: '向下探索 / MEET FURWARD', buttonHref: '#about', images: [image('hero-dog', '拉布拉多画面', 'guide-labrador.png', '人与拉布拉多并肩而立'), image('hero-robot', '机器狗画面', 'guide-robot.png', '同一位使用者与绒途机器狗并肩而立')] },
    { id: 'about', enabled: true, title: '让前行，有方向。让陪伴，有温度。', eyebrow: '认识绒途', description: '绒途是一项陪伴与辅助出行的机器狗设计概念。我们把柔软的外观、清楚的回应和对日常环境的关注放在一起，探索更亲近人的科技。页面中的场景用于表达设计方向，并非已验证的产品能力。', buttonLabel: '看看一起走过的路', buttonHref: '#scenes', images: [image('about-main', '绒途产品概念主图', 'robot-3d.png', '绒途机器狗的产品设计概念')] },
    { id: 'scenes', enabled: true, title: '走进日常。', eyebrow: '每一程，都值得被认真对待', description: '沿路、转弯、停步、等待。从室外步道到熟悉的房间，这些概念场景描绘绒途与人共同生活的可能。', buttonLabel: '了解陪伴方式', buttonHref: '#companion', images: sceneNames.map(([id, label, alt]) => image(id, label, `${id}.png`, alt)) },
    { id: 'companion', enabled: true, title: '前路有引导，身边有回应。', eyebrow: '两种关注，一份陪伴', description: '出门时，关注路线与周围环境；停下来时，关注交流与相处。我们希望辅助出行与日常陪伴能自然地融入同一种设计。', buttonLabel: '感受柔软', buttonHref: '#textures', images: [image('companion-guide', '辅助引路概念', 'robot-3d.png', '绒途机器狗辅助出行设计概念'), image('companion-response', '日常回应概念', 'scene-indoor.png', '视障人士位于室内盲道上，与绒途机器狗相伴的概念画面')] },
    { id: 'textures', enabled: true, title: '把柔软，带在身边。', eyebrow: '灵感来自宠物被毛', description: '麦穗，是暖金色短毛；云团，是奶白色长毛；暮灰，是烟灰色顺毛。三种宠物被毛概念，探索柔软、亲切的外观与触感。', buttonLabel: '走近一点', buttonHref: '#warmth', images: [image('texture-wheat', '麦穗 WHEAT', 'texture-wheat.png', '麦穗 WHEAT：暖金色短毛的宠物被毛概念特写'), image('texture-cloud', '云团 CLOUD', 'texture-cloud.png', '云团 CLOUD：奶白色长毛的宠物被毛概念特写'), image('texture-dusk', '暮灰 DUSK', 'texture-dusk.png', '暮灰 DUSK：烟灰色顺毛的宠物被毛概念特写')] },
    { id: 'warmth', enabled: true, title: '科技，也可以很温柔。', eyebrow: '靠近生活的细节', description: '陪伴不只发生在前进时。一个安静的停留，一次自然的靠近，都是我们希望在外观、材质与交互中保留的温度。', buttonLabel: '探索设计思路', buttonHref: '#technology', images: [image('warmth-main', '温暖相伴主图', 'warmth-main.png', '人与绒途机器狗温暖相伴的概念画面'), image('warmth-detail', '暖金短毛细节', 'texture-wheat.png', '绒途麦穗 WHEAT 暖金色短毛的宠物被毛概念细节'), image('warmth-soft', '奶白长毛细节', 'texture-cloud.png', '绒途云团 CLOUD 奶白色长毛的宠物被毛概念细节')] },
    { id: 'technology', enabled: true, title: '理解环境，也在意感受。', eyebrow: '四个设计方向', description: '以下是绒途的概念探索方向。实际辅助出行能力需要经过工程开发、场景测试与使用者验证。', buttonLabel: '浏览概念影像', buttonHref: '#gallery', images: [], items: [
      { id: 'perception', title: '感知', eyebrow: '关注周围', description: '探索对道路、障碍和环境变化的感知，让提示建立在对周围情况的理解之上。' },
      { id: 'guidance', title: '引路', eyebrow: '清楚地向前', description: '探索更容易理解的方向提示与停步反馈，帮助使用者知道接下来该关注什么。' },
      { id: 'dialogue', title: '对话', eyebrow: '让回应自然', description: '探索简洁、明确的交流方式，让日常提问、确认与回应更贴近人的习惯。' },
      { id: 'touch', title: '触感', eyebrow: '温柔的连接', description: '探索柔软材质和可感知的触觉反馈，让人与机器的接触更亲近。' },
    ] },
    { id: 'gallery', enabled: true, title: '一起向前的片刻。', eyebrow: '绒途概念影像', description: '在不同环境里，寻找同样的陪伴感。部分画面为 AI 辅助制作的概念展示，用于表达设计意向。', buttonLabel: '回到开场', buttonHref: '#home', images: sceneNames.map(([file, label, alt], index) => image(`gallery-${index + 1}`, `概念影像 ${index + 1} · ${label}`, `${file}.png`, alt)) },
    { id: 'footer', enabled: true, title: '向前一步，温柔始终在旁。', eyebrow: '绒途 FURWARD', description: '陪伴与辅助出行机器狗设计概念。让每一步，都有温柔回应。', buttonLabel: '回到顶部', buttonHref: '#home', images: [image('footer-main', '页脚机器狗', 'robot-3d.png', '绒途机器狗产品概念')] },
  ],
};
function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
/** Three-way merge: update only unchanged defaults. Match content slots by ID,
 * never by their position, and retain added fields/images in the source. */
function updateUntouchedDefaults(saved: unknown, previous: unknown, next: unknown): unknown {
  if (saved === undefined || JSON.stringify(saved) === JSON.stringify(previous)) return structuredClone(next);
  if (object(saved) && object(next)) {
    const result: Record<string, unknown> = { ...saved };
    for (const [key, value] of Object.entries(next)) {
      result[key] = updateUntouchedDefaults(saved[key], object(previous) ? previous[key] : undefined, value);
    }
    return result;
  }
  if (Array.isArray(saved) && Array.isArray(next) && next.every(item => object(item) && typeof item.id === 'string')) {
    const oldItems = Array.isArray(previous) ? previous : [];
    const updated = next.map(base => updateUntouchedDefaults(
      saved.find(item => object(item) && item.id === base.id),
      oldItems.find(item => object(item) && item.id === base.id),
      base,
    ));
    return [...updated, ...saved.filter(item => !object(item) || !next.some(base => base.id === item.id)).map(item => structuredClone(item))];
  }
  return structuredClone(saved);
}
/** Pure read migration: original legacy JSON remains in storage until a save
 * archives the exact revision. V1 assets never become new-page fallbacks;
 * v2 edits are carried forward using the frozen release baseline. */
export function upgradeContent(saved: unknown): SiteContent {
  if (!object(saved)) throw new Error('网站内容格式不正确。');
  if (!object(saved.site) || !Array.isArray(saved.sections)) throw new Error('网站内容格式不正确。');
  if (saved.schemaVersion === undefined || saved.schemaVersion === 1) return structuredClone(defaultContent);
  if (saved.schemaVersion === 2) {
    const upgraded = updateUntouchedDefaults(saved, furwardV2Defaults, defaultContent) as Record<string, unknown>;
    return upgradeContent({ ...upgraded, schemaVersion: FURWARD_SCHEMA_VERSION });
  }
  if (saved.schemaVersion !== FURWARD_SCHEMA_VERSION) throw new Error('网站内容版本较新，请使用对应版本的网站程序。');
  return {
    schemaVersion: FURWARD_SCHEMA_VERSION,
    site: { ...defaultContent.site, ...saved.site } as SiteContent['site'],
    sections: defaultContent.sections.map(base => {
      const current = (saved.sections as unknown[]).find(item => object(item) && item.id === base.id);
      if (!object(current)) return structuredClone(base);
      if (!Array.isArray(current.images)) throw new Error('网站图片内容格式不正确。');
      const images = base.images.map(slot => {
        const stored = (current.images as unknown[]).find(item => object(item) && item.id === slot.id);
        return object(stored) ? { ...slot, ...stored, scale: stored.scale ?? 1 } as ImageSlot : { ...slot };
      });
      for (const stored of current.images) if (object(stored) && !images.some(slot => slot.id === stored.id)) images.push({ ...stored, scale: stored.scale ?? 1 } as ImageSlot);
      const section = { ...base, ...current, images } as Section;
      if (base.items) {
        if (current.items !== undefined && !Array.isArray(current.items)) throw new Error('网站功能条目格式不正确。');
        section.items = base.items.map(item => {
          const stored = (current.items as unknown[] | undefined)?.find(value => object(value) && value.id === item.id);
          return object(stored) ? { ...item, ...stored } as SectionItem : { ...item };
        });
      }
      return section;
    }),
  };
}
