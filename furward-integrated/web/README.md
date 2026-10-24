# 绒途 Furward · 品牌网站与中文换图后台

一个完整长首页：开场恢复为参考站的白色首屏，使用等高线背景、大字暗纹和点击播放的三段双图动效；第二屏起保留黑色、荧光绿和大字排版，以及原有滚动动效。向下可浏览品牌理念、日常场景、陪伴、宠物被毛、技术和图片集。

本说明对应白色首屏 v3，荧光绿首屏 v2 的代码、图片与服务器数据已单独备份。

本交付包包含首页三段动效串联更新；该更新尚未部署到下列现有公网入口。

| 用途 | 现有公网入口 |
| --- | --- |
| 前台，直接发给访客 | [https://8.147.109.174:8087/](https://8.147.109.174:8087/) |
| 中文后台，管理员使用 | [https://8.147.109.174:8087/admin](https://8.147.109.174:8087/admin) |

**现有后台密码不变。前台无需登录；后台使用独立密码，不需要 ChatGPT 账号、GPT API 或 OpenAI 密钥。** 密码不记录在本文中。

## 日常使用从这里开始

- [使用说明.md](./使用说明.md)：按页面顺序换图、调整首屏双图、预览和保存。
- [自己服务器部署.md](./自己服务器部署.md)：Node 24 / Docker 独立部署、备份、迁移与回滚。
- 源码导出：运行 `npm run export:source`，ZIP 位于 `outputs/`。导出不包含密码、数据库、上传文件或 `node_modules`。

源码文件夹与现有服务器的 Compose 项目仍使用 `lando-studio` 名称。这是部署标识，保留它可以继续使用原有持久数据卷。

## 换图只需这一条流程

**使用概览 → 选择区块 → 上传替换或从素材库选择 → 调整画面 → 预览草稿 → 保存修改。**

上传成功只是把图片放进素材库和草稿；点击「保存修改」成功后，访客才会看到更新。

后台按首页顺序排列 9 个区域：首屏、品牌介绍、日常场景、陪伴时刻、材质细节、温暖瞬间、技术与能力、图片集、页脚与联系。共有 24 个图片位置；同一素材可重复用于不同位置，各处可独立替换。

首屏有「拉布拉多画面」「机器狗画面」两个独立图片位置。推荐都使用 **1536 × 1024 像素的透明 PNG / WebP**，人物位置、大小和脚底对齐。后台提供「拉布拉多画面」「机器狗画面」「叠加对齐」「流动预览」，流动预览可暂停，并可调整左右、上下和大小。

前台打开时显示完整拉布拉多画面。点击「播放演示」后，约 6 秒内依次展示拉布拉多、流动视角和机器狗，结束后停留在机器狗画面。播放中可暂停或继续，结束后可重新播放。三个阶段提示不可点击；鼠标移动、点击图片和触摸滑动不会触发转场。

## 网站范围

- 一个完整长首页，菜单跳转到本页区域；桌面和手机均可浏览。
- 首屏点击播放三段连贯动效，支持暂停、继续和重播；后续滚动动效独立保留，系统选择减少动态效果时使用简短淡化。
- 中文图片后台、素材库、文字与链接编辑、四项技术条目编辑、草稿预览、版本冲突保护。
- 独立密码登录；未配置密码时，上传和保存不会开放。
- Node 24 + SQLite + 文件存储，或 Docker 持久卷；源码可独立运行。

旧地址会转到首页相应区域：`/on-track` → `/#scenes`，`/off-track` → `/#companion`，`/calendar` → `/#technology`。旧版三个内页不再作为独立展示页，后台也不再显示这些栏目。

六张日常场景呈现人物在盲道上与机器狗同行；三种宠物被毛概念分别是「麦穗」暖金色短毛、「云团」奶白色长毛、「暮灰」烟灰色顺毛。场景与被毛中包含 AI 概念图，用于表达设计意向，不代表已经生产或验证的实物能力。「听听示例回应」朗读预设文字，使用浏览器语音功能；不是实时 AI 对话，也不识别周围环境。网站没有接入机器人控制、导航或支付系统。

## 本机快速运行

安装 Node.js 24，在项目文件夹运行：

```sh
npm ci
npm run setup:admin
npm run dev:selfhost -- --port 3000
```

然后访问 `http://localhost:3000`，后台为 `http://localhost:3000/admin`。保持终端运行。已有 `.env.production` 时无需重新设置密码，设置工具也不会覆盖它。

首次设置会生成 `.env.production` 和 `.admin-credentials`，请私下保管。Docker 用户可直接使用临时 Node 24 容器设置密码，无需在宿主机安装 Node，详见部署说明。

## 数据保存在哪里

| 内容 | 保存位置 |
| --- | --- |
| 未保存草稿 | 当前浏览器本地存储，Furward 使用独立草稿版本 |
| 已保存文字、图片地址与位置 | `DATA_DIR/content.sqlite` |
| 上传图片原文件 | `DATA_DIR/uploads/` |
| 管理员配置 | `.env.production`，单独保管 |

Node 默认数据目录是 `./data`；Docker 为命名卷内的 `/app/data`。源码 ZIP 与 Git 不包含这些运行数据。后台下载的 JSON 也不包含图片原文件，搬迁前请做完整服务器备份。

v3 使用独立草稿键 `furward-content-draft-v3`。从 v2 升级时，只替换仍与旧默认值相同的字段；自定义文字、上传图片和构图会保留。读取不会改写原 JSON，第一次保存 v3 会先备份原版本；素材库不删除。v1 旧站内容保留备份并使用 Furward 默认展示，需人工重新选择旧自定义素材的用途。旧格式保存请求会被拒绝，旧草稿不自动套用。迁移命令与回滚方法见部署说明。

## 已保留的荧光绿完整版本

白色版更新前，荧光绿首屏版本已完整保留：

| 备份类型 | 位置 / 标识 |
| --- | --- |
| Git 标签 | `furward-fusion-v1-20261024` |
| 服务器镜像 | `lando-studio-web:furward-fusion-v1-20261024` |
| 服务器完整数据备份 | `/app/data/backups/furward-fusion-v1-20261024` |
| 服务器私有独立备份目录 | `/opt/lando-studio/backups/furward-fusion-v1-20261024/` |

私有目录包含 `source.zip`、`data/` 和 `.env.production`。它用于管理员恢复源码、数据和配置，不是公开下载目录；不要放进网站静态资源或源码交付 ZIP。回滚时程序与数据要使用这一组匹配版本，并继续保留现有数据卷。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm run setup:admin` | 新安装首次设置密码；现有服务器不用重设 |
| `npm run build:selfhost` | 构建独立生产版本 |
| `BIND_ADDRESS=127.0.0.1 PORT=3000 npm run start:selfhost` | 启动生产服务 |
| `node --test scripts/furward-test.mjs scripts/test-cms.mjs scripts/test-admin.mjs` | 内容迁移、后台与鉴权检查 |
| `npm run test:selfhost` | 数据持久化与备份恢复检查 |
| `npm run backup:selfhost -- ./backups/新日期` | 完整备份 Node 数据 |
| `npm run export:source` | 导出源码 ZIP |

导出的源码 ZIP 中，默认 `dev`、`build`、`start` 已切到独立 Node 运行方式；`:selfhost` 别名仍保留。Docker 现有服务器统一使用 `docker compose -p lando-studio ...`，不能删除既有数据卷。

## 主要代码位置

| 文件 / 目录 | 用途 |
| --- | --- |
| `app/PublicSite.tsx`、`app/furward.css`、`app/useSiteMotion.ts` | 长首页、视觉样式与滚动动效 |
| `app/components/WhiteHero.tsx`、`WhiteHero.css`、`FurwardLiquid.tsx` | 白色首屏、样式与前后台共用的流动效果 |
| `app/admin/` | 中文管理后台与首屏组合预览 |
| `app/api/` | 登录、内容、素材接口 |
| `lib/content.ts`、`lib/furward-v2-defaults.ts`、`lib/cms-validation.ts` | v3 默认内容、冻结的 v2 比对基线与保存校验 |
| `lib/cms-store-node.ts`、`lib/selfhost-database.mjs` | 自部署数据存取 |
| `public/reference/furward/`、`public/reference/furward-v3/` | 原始透明图，以及新版盲道场景和宠物被毛图 |
| `scripts/furward-migrate.mjs` | 旧内容审核、备份及迁移 |

日常换图使用后台；不要用修改默认文件的方式覆盖已保存内容。旧参考资产与内容基线保留用于兼容、溯源和迁移，不作为 Furward 前台回退。使用自有图片替换时，请确认拥有相应使用权。
