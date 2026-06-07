# Multi Master Video Blog

面向个人创作者的自托管媒体博客系统，支持文章发布、视频项目管理、HLS 播放、SDR/HDR10/HLG/Dolby Vision 多母版切换、Directus CMS 内容管理，以及 Windows 本地服务 + Nginx + HTTPS 部署。


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
├─ scripts/                # CMS 初始化、测试、迁移、健康检查脚本
├─ logs/                   # 本地服务日志
└─ README.md
```

## 环境准备

- Node.js `>=22`
- Windows 11 / Windows Server
- FFmpeg / FFprobe
- Directus 本地 `.env`
- PostgreSQL
按需修改：

- `apps/web/.env.local`：`DIRECTUS_URL`、`DIRECTUS_EMAIL`、`DIRECTUS_PASSWORD`、`DIRECTUS_SHOW_DRAFTS`、站点文案配置
- `apps/api/.env`：`UPLOAD_API_TOKEN`、`MEDIA_ROOT`、`DIRECTUS_*`、`FFMPEG_PATH`、`FFPROBE_PATH`
- `apps/cms/directus/.env`：`ADMIN_EMAIL`、`ADMIN_PASSWORD`、`KEY`、`SECRET`、数据库配置

## 本地开发

安装依赖：

```powershell
npm install
```

初始化 Directus 数据库：

```powershell
npm run bootstrap:cms
```

启动 Directus：

```powershell
npm run dev:cms
```

在另一个终端创建/修复内容模型：

```powershell
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

## 公开与私密内容

`posts` 和 `video_projects` 都有 `published` 字段：

- `published=true`：前端公开显示
- `published=false`：前端列表、详情页和首页统计默认不显示

前端通过 `DIRECTUS_SHOW_DRAFTS` 控制是否预览未发布内容：

```env
DIRECTUS_SHOW_DRAFTS=false
```

生产环境建议保持 `false`。本地调试时可以临时设置：

```env
DIRECTUS_SHOW_DRAFTS=true
```


## 数据库

本地使用 PostgreSQL：

```env
DB_CLIENT=pg
DB_HOST=127.0.0.1
DB_PORT=5432
DB_DATABASE=multi_master_video_blog
DB_USER=directus
DB_PASSWORD=replace-with-postgres-password
DB_SSL=false
```

## 常用命令

```powershell
npm run build:web             # 构建前端
npm run dev:web               # 开发模式启动前端
npm run dev:api               # 开发模式启动上传 API
npm run dev:cms               # 启动 Directus
npm run setup:cms-schema      # 创建/修复 CMS 内容模型
npm run migrate:cms:postgres  # SQLite 到 PostgreSQL 迁移脚本入口
npm run test:api              # 检查 API 语法
npm run test:db               # 检查 Directus 数据库，兼容 SQLite/PostgreSQL
npm run test:cms-schema       # 检查 CMS 表、字段、关系
npm run test:cms-crud         # 检查 CMS CRUD 和关联读取
npm run health                # 检查本地服务健康状态
npm run manager               # 启动本地服务管理面板
```


## 内容模型

`posts`：

- 标题、slug、Markdown 正文、封面、标签、分类、发布状态、创建/更新时间

`video_projects`：

- 标题、slug、描述、封面、标签、分类、发布状态、排序、母版关联

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
2. 选择普通视频文件，或上传完整 Dolby Vision master package。
3. API 将源文件保存到 `media/`，调用 FFmpeg/FFprobe 生成 HLS 并读取技术元数据。
4. API 写入 Directus 的 `video_projects` 与 `video_masters`。
5. 前端视频详情页读取 Directus 数据，通过 Shaka Player 播放 HLS。
6. 用户可在播放器中切换 SDR/HDR10/HLG/Dolby Vision/custom 母版。

## 技术栈

- `apps/web`：Next.js 16、React 19、TypeScript、Shaka Player、React Markdown
- `apps/api`：Node.js、Busboy、FFmpeg、FFprobe
- `apps/cms/directus`：Directus 11，当前默认 PostgreSQL，保留 SQLite 旧数据迁移支持
- `deployment/windows`：Windows PowerShell 服务脚本
- `deployment/nginx`：Windows Nginx 反向代理与 HLS 示例配置
