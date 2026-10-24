# Lando Norris 参考站素材与结构

参考地址：https://landonorris.com/  
采集日期：2026-10-24（Asia/Shanghai）  
原站 HTML、CSS、公开 JS 用于检查；项目仅保留所需图片、字体，不引入原站跟踪脚本。

## 首屏关键结论

首屏不是视频，而是 WebGL canvas，容器为 `data-gl="head"`。原站 JS 通过头部彩色、透明、深度纹理做立体人像，并叠加可交互 3D 头盔。

WebGL 当前使用原站模型、材质和深度纹理；以下静态备选方案使用原始 `hero-diffuse.webp`（2048 × 2048）配 `hero-alpha.webp`（2048 × 2048）作为透明蒙版，能精准保留原站正面半身人像。彩色纹理边缘有颜色拉伸，必须套蒙版。

```css
.hero-portrait {
  background: url('/reference/hero-diffuse.webp') center / contain no-repeat;
  mask-image: url('/reference/hero-alpha.webp');
  mask-mode: luminance;
  mask-size: 100% 100%;
  mask-repeat: no-repeat;
}
```

头像头顶约在原图高度 19% 处，静态定位时应预留这段空白或将图像上移。原图人物占左右大部分且肩部延伸到底，适合完整视口底部锚定。

`hero-depth.webp` 已作为人物 shader 的深度输入。原站 3D 模型地址为 `https://lando.itsoffbrand.io/gl/models/helmet-21.glb`，真实模型、材质、HDR 和 Draco 解码器均已下载到 `public/reference-motion/`。组件使用自写 Three.js 场景，不直接运行原站整包脚本。Rive 矢量动效与本地运行时也已接入，详见 `motion-reference.md`。

## 页面结构与素材对应

1. 全屏 Hero：暖白背景、顶部左右小按钮，中央 LN + LANDO NORRIS 字标，正面肖像居中。旁边为比赛信息小牌和滚动提示。
2. 宣言大字：深绿背景，Mona Sans 粗体与 Brier 有机曲线字形交替。
3. 横向生活拼贴：不同尺寸图片散布，大量留白，浅底纹；使用 `story-*` 图片、`signature.svg`、`crossed-flags.svg`。
4. ON TRACK / OFF TRACK：两个超大标题和侧脸剪影；`portrait-helmet.webp` 与 `portrait-side.webp` 都有 alpha 通道。
5. 头盔收藏：深色背景、6 个可独立替换透明头盔素材 `helmet-*`。原页面更多头盔年份和款式，本项目优先 2025 Season / Discoball / Dark Glitter / 2024 Porcelain / Japan / 2023 Beachball。
6. 官方商店：以冠军系列服装和产品图为主，`store-01.webp` 是 T 恤平铺（378×484，原站原尺寸），`store-02.webp` 是背面卫衣人物大片（1260×1666），`store-03.webp` 是金色系列字板；`store-04.webp` 提供另一幅商城素材。
7. PARTNERS & CAMPAIGNS：原首页以伙伴 logo 跑马灯和动效为主，已下载 7 个伙伴 logo。首页没有独立合作伙伴摄影，导航 `/partnerships` 当前返回 Not Found，未伪称生活图为品牌 campaign。
8. 社交媒体：`social-track.webp`、`social-offtrack.webp`、`social-lifestyle.webp` 原图均为 1080 像素宽。
9. 页脚：巨大品牌文案、头盔 `footer-helmet.webp`、原站轮廓图案 `pattern-footer.svg`。

## 精确样式参数

- 原站暖白：`#f4f4ed`
- 深绿：`#282c20`
- 荧光黄绿：`#d2ff00`
- 暗黄绿：`#b2c73a`
- 浅绿灰：`#dde1d2`
- 深绿灰：`#3b3c38`
- 正文、主要大写标题：本地 `MonaSans-Variable.woff2`，wght 200–900，wdth 可变。
- 有机曲线强调标题：本地 `Brier-Bold.woff2`，weight 700。
- 轮廓图案：`pattern-nav.svg` / `pattern-footer.svg` 可作为 background-image，opacity 约 0.06–0.12。

所有文件的清晰 key、相对 URL、原始来源、用途、尺寸见 `reference-assets.json`。图片从原始 `src` 下载，不使用 `-p-500` 缩略版本。
