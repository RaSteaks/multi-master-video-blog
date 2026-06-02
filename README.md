# Multi Master Video Blog

面向个人创作者的自托管媒体博客系统，支持文章发布、视频项目管理、HLS 播放、SDR/HDR10/HLG/Dolby Vision 多母版切换，以及 Windows 本地服务器 + Nginx + HTTPS 部署。

## 技术栈

- 前端：Next.js App Router，包含首页、文章列表/详情、视频列表/详情、上传页和关于页。
- CMS：Directus，使用 `posts`、`video_projects`、`video_masters` 三类内容模型。
- 上传 API：Node.js + Busboy + FFmpeg，支持上传视频、封面、海报和 Dolby Vision master package。
- 播放器：Shaka Player，支持 HLS、母版切换、HDR 能力提示、SDR 回退和 Dolby Vision 元数据显示。
- 部署：提供 Windows 服务脚本和 Nginx 示例配置。

- `apps/web`：Next.js 16、React 19、TypeScript、Shaka Player、React Markdown
- `apps/api`：Node.js、Busboy、ffmpeg-static、ffprobe-static
- `apps/cms/directus`：Directus 11，本地默认使用 SQLite
- `deployment/windows`：Windows PowerShell 服务脚本
- `deployment/nginx`：Windows Nginx 反向代理与 HLS 示例

## 项目结构

```text
multi-master-video-blog/
├─ apps/
│  ├─ web/                 # 前端站点
│  ├─ api/                 # 上传、转码、媒体代理 API
│  └─ cms/directus/        # Directus CMS
├─ deployment/
│  ├─ nginx/               # Nginx 示例配置
│  └─ windows/             # Windows 服务脚本
├─ docs/                   # 项目、前端、上传、部署说明
├─ media/                  # 本地 HLS/媒体文件目录
├─ scripts/                # CMS 初始化、测试、健康检查脚本
├─ logs/                   # 本地服务日志
└─ README.md
```

## 环境准备

- Node.js `>=22`
- Windows 11 / Windows Server
- FFmpeg / FFprobe
- Directus 本地 `.env`


复制环境变量示例：

```powershell
Copy-Item apps\web\.env.example apps\web\.env.local
Copy-Item apps\api\.env.example apps\api\.env
Copy-Item apps\cms\directus\.env.example apps\cms\directus\.env
```

按需修改：

- `apps/web/.env.local`：`DIRECTUS_URL`、`DIRECTUS_EMAIL`、`DIRECTUS_PASSWORD`、站点文案配置
- `apps/api/.env`：`UPLOAD_API_TOKEN`、`MEDIA_ROOT`、`DIRECTUS_*`、`FFMPEG_PATH`、`FFPROBE_PATH`
- `apps/cms/directus/.env`：`ADMIN_EMAIL`、`ADMIN_PASSWORD`、`KEY`、`SECRET`、数据库配置

## 本地开发

安装依赖：

```powershell
npm install
```

初始化 Directus，并创建/修复内容模型：

```powershell
npm run bootstrap:cms
npm run setup:cms-schema
```

分别启动服务：

```powershell
npm run dev:cms
npm run dev:api
npm run dev:web
```

默认地址：

- 前端：`http://127.0.0.1:3000`
- Directus：`http://127.0.0.1:8055`
- 上传 API：`http://127.0.0.1:8060`

## 常用命令

```powershell
npm run build:web          # 构建前端
npm run test:api           # 检查 API 语法
npm run test:db            # 检查 Directus SQLite 数据库
npm run test:cms-schema    # 检查 CMS 表、字段、关系
npm run test:cms-crud      # 检查 CMS CRUD 和关联读取
npm run health             # 检查本地服务健康状态
npm run manager            # 启动本地服务管理面板
```

Windows 服务脚本：

```powershell
npm run web:start
npm run api:start
npm run manager:start
npm run web:status
npm run api:health
```

## 内容模型

`posts`：

- 标题、slug、摘要、Markdown 正文、封面、标签、分类、发布状态、创建/更新时间

`video_projects`：

- 标题、slug、描述、封面、海报、标签、分类、发布状态、排序、母版关联

`video_masters`：

- 所属视频项目、标签、类型、HLS URL、源文件 URL、编码、分辨率、色彩空间、传递函数、位深、码率、Dolby Vision 元数据、默认母版、状态、备注

母版类型：

- `sdr`
- `hdr10`
- `hlg`
- `dolby_vision`
- `custom`

## 上传与播放流程

1. 在 `/upload` 页面输入上传令牌和视频元数据。
2. 选择普通视频文件，或上传完整 Dolby Vision master package 文件夹。
3. API 将源文件保存到 `media/`，调用 FFmpeg/FFprobe 生成 HLS 并读取技术元数据。
4. API 写入 Directus 的 `video_projects` 与 `video_masters`。
5. 前端视频详情页读取 Directus 数据，通过 Shaka Player 播放 HLS。
6. 用户可在播放器中切换 SDR/HDR10/HLG/Dolby Vision/custom 母版。
