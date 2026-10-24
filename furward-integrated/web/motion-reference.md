# 原站动效研究与真实动画资产

研究对象：[Lando Norris 官网](https://landonorris.com/)。记录日期：2026-10-24。依据公开 HTML、CSS、原站三份 JavaScript 与实际下载的二进制资源。本文区分原站精确参数与本项目实现建议，不代表所有动效都已经接入。

## 交付文件

- `public/reference-motion/manifest.json`：GLB、HDR、纹理、解码器与 Rive 来源清单。
- `public/reference-motion/content-expansion.json`：16 款头盔，包含 `src`、`hoverSrc`、年份和名称；还包含 2 张缺失故事图、5 张菜单照片、伙伴和页脚装饰 SVG。
- `public/reference-motion/inner-pages.json`：On Track / Off Track 图组映射，已统一引用 `/reference/pages`；完整内页图片来源为 `.taste-skill/editorial/assets.json`。研究时重复下载的未使用图片已清理。
- `public/reference-motion/social-expansion.json`：原站七张社交卡片海报，按原顺序，已有素材复用不重复下载。
- `app/components/RiveMark.tsx`：独立的真正 Rive 播放组件。
- 原始人物彩色、深度、透明贴图仍复用 `public/reference/hero-{diffuse,depth,alpha}.webp`。

公开源码：

- [当前金色头盔版本脚本](https://lando.itsoffbrand.io/dev-js/lando.OFF+BRAND.gold-android-fix-03.js)
- [原荧光绿等多皮肤版本脚本](https://lando.itsoffbrand.io/dev-js/lando.OFF+BRAND.js)
- [包含完整导航、菜单、内页逻辑的脚本](https://assets.itsoffbrand.io/lando/dev-js/lando-by-OFF+BRAND.js)

不应直接把整个原站脚本注入本项目。它绑定原站 DOM、全局 GSAP/Lenis、Taxi 导航及外部服务；本项目应接入公开资源并重建交互逻辑。

## 真实模型可用性

`helmet.glb`（139,492 bytes）包含 `helmet`、`glass`、`plastic` 三个 mesh；只有几何数据和 UV，没有内置材质、贴图、动画 clip。压缩格式为 `KHR_draco_mesh_compression`，需要 `GLTFLoader` 配 `DRACOLoader`，解码目录 `/reference-motion/draco/`。本地已包含 wasm wrapper、wasm decoder 与 JavaScript decoder。

`disco.glb`（358,984 bytes）包含独立镜面碎片 mesh 与 14 个 lens-flare 定位节点，也是 Draco 格式，没有动画 clip。原站动画均由代码驱动，不能通过 AnimationMixer 自动播放出完整效果。

常用贴图：

| 对象 | 本地资源 | 原站材质要点 |
| --- | --- | --- |
| 头盔主体 | `helmet-lime.webp`、`helmet-gold.webp`、`helmet-dark.webp`、`helmet-grid.webp`、`helmet-google.webp`、`helmet-disco.webp` | MeshPhysicalMaterial，metalness 1，roughness .05，normalMap，HDR envMapIntensity 3 |
| 面罩 | `glass-base.webp`、`glass-normal.webp`、`glass-roughness.webp`、`helmet-metallic.webp` | MeshPhysicalMaterial，envMapIntensity 1.5 |
| 透明塑料边缘 | `plastic-matcap.webp` | MeshMatcapMaterial，transparent true，opacity .25，DoubleSide |
| 环境反射 | `hdr-light.hdr`、`hdr-faded.hdr` | RGBELoader，EquirectangularReflectionMapping |
| 镜面特效 | `disco-matcap.webp`、`disco-mask.webp`、`disco-lensflare.webp` | shader 对局部 Y 坐标做 reveal，镜面高光根据朝向显示 |

GLTF 模型贴图必须 `flipY=false`；人物平面贴图保留默认 `flipY=true`。彩色贴图设 SRGBColorSpace，normal/roughness/metalness 数据贴图不设 sRGB。原站曾将 head depth 设为 sRGB，这一点会改变位移强弱，需结合截图检查。

当前 gold 脚本的 Lime/Dark/Grid/Google 全部引用 gold 皮肤；旧版脚本的真实多皮肤 URL 均仍可下载，已经本地化。

## 首屏人物与头盔

### 人物是带位移的平面，不是人物 GLB

原站使用 `PlaneGeometry(1,1,128,128)`，MeshPhysicalMaterial 设置 depth displacementMap、displacementScale .25、alphaMap、normalMap、roughnessMap 和 metalnessMap。正面纹理需要透明蒙版，否则边缘扩展像素会显示出来。

- PerspectiveCamera FOV 15，near .1，far 1000。
- 桌面相机 z=3；宽度≤768 时 z=3.75。
- 人物 position.y：桌面 0、移动 -.05。
- 鼠标缓动 ease .025；旋转强度 .075 radians。
- rotation.y = easedPointer.x × .075。
- rotation.x = -easedPointer.y × .075 × (1 - scrollProgress)。
- camera.x = easedPointer.x × .02；camera.y = -easedPointer.y × .02。

### 头盔是真实 3D，覆盖头部，身体保留

- helmet group scale = (6.9, 6.9, 7.1)。
- position = (0, .05, 0)，移动端 y=0。
- 复制人物旋转后，rotation.x/y 各除以 1.5；rotation.x 再加 PI×.06（约10.8°）。
- 头盔单独渲染到 render target，再根据 alpha 合成到人物画面。
- 人物不整体隐藏。头盔揭示区域里把人物 diffuse 与 `head-shadow.webp` 混合，给脖子加阴影；头盔本身遮住脸。
- hover 进入：1.5s，expo.inOut；离开：1s，expo.inOut。
- 曲线扫描揭示逻辑：`boundary = uv.y + sin(uv.x*PI)*sin(progress*PI)*.2`；`reveal = step(1-boundary, progress)`。
- 完整效果还叠加鼠标流体轨迹，轨迹所到之处局部揭示头盔并改变背景色。这不是普通的整张透明度切换。
- 轮廓背景使用时间推进的噪声，speed .1，cursor intensity .15，cursor scale 3。

初始头部 reveal 参数为 1.1s。滚动第一屏时 camera group.z 0→-1，滤镜 uFilter 0→1，跨度约一个视口；图像由全屏缩进 `.marquee-gl-target` 的目标宽高，并转深绿单色。**Message from Lando 中的正面头像是同一个 WebGL 场景连续缩小，不是视频，也不是另一张生活照。** 滤镜源码为先把透明背景混入 vec3(.05)，再 grayscale → contrast .8 → 亮度乘 .75 → 与 COLOR_FILTER 做 hardlight。滚过约 viewportHeight / 2.25 后，鼠标揭示与线框效果关闭，时长 .25s。

## 首页所有主要滚动段落

| 段落 | 原站触发与节奏 | 实现要点 |
| --- | --- | --- |
| Hero Message / 字母过渡 | 字母 y100%→0，.8s power3.out，stagger .02；图片 alpha0/y1rem→1/0 | 随 hero eyebrow tracker 滚动 scrub；手机标题使用椭圆 clip 收起 |
| 大字与宣言 | 椭圆 clip ellipse(20% 0%)→ellipse(100% 120%)，1.5s power2.inOut | 单行 y±40%→0；字母从中间 stagger amount=.015×字数；top95%只触发一次 |
| 高亮小字 | .6s 文字 clip 展开 + .6s 荧光矩形 scaleX→0 | 每行 stagger .15s；遮盖层在文字开始 .3s 后退去 |
| 横向拼贴 | x=-(trackWidth-viewportWidth)，ease none，scrub1 | start top bottom / end bottom bottom；仅≥992桌面；内图各自 x0→4rem 的视差 |
| ON / OFF TRACK 双图 | 人物从左右±20rem→0，power2.out；字从±5rem→0 | 图片 start top bottom/end bottom bottom；文字结束更早 at60% bottom |
| 抬头盔大图 | y0→-20vh，scale1→1.1 | start top bottom/end bottom top，scrub |
| Helmet Hall of Fame | 4列错位 y=0/5/10/15rem→0 | start top bottom/end bottom top，scrub；不是原生水平轮播 |
| 头盔 hover | 第二视角图以 ellipse(100% 120% at50%0%) 揭示 | 每款已有 base 与 hover 两个真图；不可只让同图放大冒充 |
| 商店椭圆窗口 | ellipse(70% 0% at50%0%)→ellipse(70%100% at50%0%) | start top bottom/end bottom center，scrub |
| 商店产品照片 | y0→-4rem | start top bottom/end bottom top，scrub |
| 品牌跑马灯 | xPercent -100 无限线性循环，随滚动方向改变 timeScale 正负 | 从可见前200px才初始化，手机速度倍率 .25/.5 |
| 社交扇形卡片 | angle[-21,-14,-7,0,7,14,21]°，scale[.7756,.8498,.9346,1,…] | 弹开 1.2s elastic.out(1,.75)，stagger总量 .2s from center；hover聚焦并挤开邻卡 |
| 页脚 | 巨大字、轮廓装饰、原站 Rive signature_play | 进入视口后播放，滚出视口停止渲染 |

原站平滑滚动采用 Lenis：lerp .1、smoothWheel true、touchMultiplier2、syncTouch true；其 raf 由 GSAP ticker 驱动，ScrollTrigger 随 Lenis scroll 更新。

### 可选真实 3D 滚动头盔

原站 helmet-scroll scene：相机 FOV20、z2；模型 scale6。一个暂停的1秒timeline由滚动进度驱动，group.rotation.y 从 PI/2.2→PI×4（超过一整圈），power1.inOut；helmet.rotation.x 先 PI/12→-PI/10，后半段到 PI/20。不是视频或帧序列。

## 全屏菜单与页面转场

- 菜单整体从 ellipse(120% 0% at50%0%) 到 ellipse(120%100% at50%20%)，.8s power3.out。
- 照片延迟 .15s；每张 .8s，stagger .06s，同样椭圆揭示。
- 链接延迟 .35s；.6s back.out(1.2)，stagger .08s，y20→0。
- 关闭使用同一个 timeline 的 reverse，timeScale1.5。
- 两列菜单照片随鼠标Y相反方向移动±6rem，2s power2.out。
- 背景纹理在 .6s 后显现到 opacity .12。
- 悬停链接逐字向上翻，.6s power3.out，stagger .02s；对应照片 .2s 显现，其余 .3s 隐藏。
- 打开菜单停止 Lenis，关闭恢复；按钮有 aria-expanded 与键盘 Enter/Space 支持。
- 跨页使用 `page-transition.riv`，artboard/stateMachine 均 `page-transition`，布尔输入 `initial`、`transition-out`、`transition-in`。进入后约500ms隐藏遮罩。

页脚的头盔是静态 `/reference/footer-helmet.webp`，不是真实 GL 场景；签名调用 `signature/signature_play` 与 `color_lime`，不传 scroll。

## Rive 原始矢量动画

资源均已实际下载，均为几 KB 至几十 KB：

| 文件 | artboard | stateMachine | 输入/用途 |
| --- | --- | --- | --- |
| signature.riv | signature | signature_scroll | 数字 `scroll` 0–1000；布尔 `color_lime` |
| signature.riv | signature | signature_play | 滚到视口后播放签名笔画 |
| reef.riv | helmet-reef | helmet-reef_scroll / helmet-reef_play | 描边头盔；scroll输入或直接play；color_green-off-white-2/color_lime |
| reef.riv | off-icons | off-icons | 生活图标装饰动画 |
| phrases.riv | phrase_on | phrase_on | ON TRACK 风格装饰 |
| phrases.riv | collabs | page_home | 合作伙伴页中的装饰图形 |
| btn-ui.riv | arrow | arrow | 按钮箭头 |
| btn-ui.riv | hamburger | hamburger | 布尔 hover/close/color-transparent/color-white |
| ln4.riv | logo | logo | 布尔 logo-active/hover/color_dark-green/color_white/color_lime |
| page-transition.riv | page-transition | page-transition | 页面进入退出遮罩 |
| circuits.riv | circuits | circuits | 赛道描边，原站当前输入 austin |

`RiveMark` 默认使用本地 `/reference-motion/rive/runtime.wasm`，避免依赖线上第三方 wasm CDN。调用示例：

```tsx
<RiveMark
  src="/reference-motion/rive/signature.riv"
  artboard="signature"
  stateMachine="signature_scroll"
  scroll
  colorInput="color_lime"
  className="hero-signature"
/>
<RiveMark
  src="/reference-motion/rive/phrases.riv"
  artboard="collabs"
  stateMachine="page_home"
  className="partners-rive"
/>
```

组件在客户端动态 import Rive，SSR 不访问 window；使用容器真实尺寸设置 canvas，DPR上限2，ResizeObserver调整；IntersectionObserver与document visibility暂停不可见动画；scroll模式用数字输入0–1000和惯性缓动；卸载时移除监听并cleanup实例。初始容器比例3:1，加载后采用artboard真实比例，调用方可通过class设置height。定位建议使用外部wrapper（例如absolute居中），避免组件内部relative定位覆盖外层设计。赛道可传 `trackInput="austin" colorInput="color_lime"`；切换 trackInput 会重建实例，旧赛道不会残留。

## 内页导航与内容结构

原站的 `/on-track`、`/off-track`、`/calendar` 均可访问；`/partnerships` 当前返回 Not Found。

- On Track：深色首屏人物/赛车，横向照片，F1 Career Since2019、wins/poles/average finish/fastest laps、年份成绩、pre-F1时间线、2026赛程、头盔收藏、社交卡片、页脚。
- Off Track：巨大 OFF TRACK 首屏、滚动照片云、Personal Projects，项目有 padel tennis、photography & film、LEGO、golf，之后社交与页脚。
- Calendar：Upcoming2026 calendar、赛程、按年F1 All Results、倒计时、赛道可视化与页脚。数据属于参考站内容，后续应由后台编辑或接入可靠数据源；本次没有生成虚构赛程。

## 验证记录

已核验所有下载请求成功、GLB header 与 JSON chunk 可解析、mesh 名称和 Draco 扩展。人物阴影贴图已目视检查，真实为脖子阴影而不是删除人物的蒙版。动画参数来自源码，不是凭截图猜测。2026-10-24 已在独立 Chrome 页 localhost:5173 核验：signature 与 collabs 均为 `data-rive-state="ready"`；canvas 根据容器像素比获得真实绘制尺寸；截图观察到签名从首笔到完整笔画，并在 partners 区看到真实 Collabs 手绘文字，而非静态占位图。该独立测试页控制台 error 记录为空。RiveMark 类型错误已修；最新 `npx tsc --noEmit` 全量检查退出码为 0。四份素材映射共 114 个本地路径均存在。全部 public 静态资源目前约 14.64 MiB（后续其他代理增补会变化）。
