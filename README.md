<div align="center">

# 今天色彩空间设对了吗？

**面向个人创作者的自托管博客**

[![Next.js](https://img.shields.io/badge/Next.js-16-black?style=flat-square&logo=next.js)](https://nextjs.org)
[![React](https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=black)](https://react.dev)
[![Directus](https://img.shields.io/badge/Directus-11-64F?style=flat-square&logo=directus&logoColor=white)](https://directus.io)
[![Node.js](https://img.shields.io/badge/Node.js-≥22-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Windows](https://img.shields.io/badge/Windows-11-0078D4?style=flat-square&logo=windows&logoColor=white)](https://www.microsoft.com/windows)

支持文章发布、视频项目管理、HLS 自适应播放、SDR / HDR10 / HLG / Dolby Vision 多母版切换  
Directus CMS 内容管理，Windows 本地服务 + Nginx + HTTPS 全栈部署

</div>

---

## 核心特性

| 特性 | 描述 |
|------|------|
| **多母版视频** | 同一项目支持 SDR · HDR10 · HLG · Dolby Vision · Custom 任意切换 |
| **HLS 自适应播放** | Shaka Player 驱动，浏览器端原生 HLS 流式播放 |
| **自动转码** | 上传即触发 FFmpeg / FFprobe，自动生成 HLS 并提取技术元数据 |
| **Headless CMS** | Directus 11，REST + GraphQL，结构化管理文章与视频项目 |
| **文章博客** | Markdown 正文、封面、标签、分类、草稿/发布状态 |

---

## 技术栈

#### 前端 `apps/web/`

| 技术 | 用途 |
|------|------|
| **Next.js 16** (App Router) | 页面路由、SSR / SSG、API Routes |
| **React 19** | UI 组件与状态管理 |
| **TypeScript 5** | 全量类型安全 |
| **Shaka Player** | 浏览器端 HLS 自适应播放，支持 DRM 与多码率 |
| **React Markdown** | 文章 Markdown 渲染 |

#### 后端 `apps/api/`

| 技术 | 用途 |
|------|------|
| **Node.js ≥ 22** | 上传 · 转码 · 媒体代理服务 |
| **Busboy** | 流式 multipart 文件接收 |
| **FFmpeg** | HLS 切片封装、转码 |
| **FFprobe** | 读取色彩空间、位深、码率等技术元数据 |

#### 管理后台 `apps/cms/directus/`

| 技术 | 用途 |
|------|------|
| **Directus 11** | Headless CMS，提供 REST + GraphQL API 与可视化管理界面 |
| **PostgreSQL** | 主数据库|


---

## 项目结构

```text
multi-master-video-blog/
├── apps/
│   ├── web/                 # 前端站点（Next.js）
│   ├── api/                 # 上传 · 转码 · 媒体代理 API
│   └── cms/directus/        # Directus CMS
├── deployment/
│   ├── nginx/               # Nginx 示例配置
│   └── windows/             # Windows 服务脚本
├── docs/                    # 项目、前端、上传、部署详细说明
├── media/                   # HLS / 媒体文件存储目录
├── scripts/                 # CMS 初始化 · 测试 · 迁移 · 健康检查
├── logs/                    # 本地服务日志
└── README.md
```

---

## 快速开始

### 前置依赖

- **Node.js** `>= 22`
- **FFmpeg** + **FFprobe**（加入系统 PATH 或通过 `.env` 指定路径）
- **PostgreSQL**
- **Windows 11** / Windows Server

### 环境变量配置

<details>
<summary><strong>apps/web/.env.local</strong></summary>

```env
DIRECTUS_URL=
DIRECTUS_EMAIL=
DIRECTUS_PASSWORD=
DIRECTUS_SHOW_DRAFTS=false
```

</details>

<details>
<summary><strong>apps/api/.env</strong></summary>

```env
UPLOAD_API_TOKEN=
MEDIA_ROOT=
DIRECTUS_URL=
DIRECTUS_EMAIL=
DIRECTUS_PASSWORD=
FFMPEG_PATH=
FFPROBE_PATH=
```

</details>

<details>
<summary><strong>apps/cms/directus/.env</strong></summary>

```env
ADMIN_EMAIL=
ADMIN_PASSWORD=
KEY=
SECRET=
DB_CLIENT=pg
DB_HOST=127.0.0.1
DB_PORT=5432
DB_DATABASE=multi_master_video_blog
DB_USER=directus
DB_PASSWORD=
DB_SSL=false
```

</details>

### 本地开发

```powershell
# 1. 安装依赖
npm install

# 2. 初始化 Directus 数据库
npm run bootstrap:cms

# 3. 创建 / 修复 CMS 内容模型
npm run setup:cms-schema

# 4. 分别启动各服务（建议开三个终端）
npm run dev:cms
npm run dev:api
npm run dev:web
```

**本地访问地址**

| 服务 | 地址 |
|------|------|
| 前端 | `http://127.0.0.1:3000` |
| Directus CMS | `http://127.0.0.1:8055` |
| 上传 API | `http://127.0.0.1:8060` |

---

## 常用命令

```powershell
npm run build:web              # 构建前端生产包
npm run dev:web                # 前端开发模式
npm run dev:api                # 上传 API 开发模式
npm run dev:cms                # 启动 Directus
npm run setup:cms-schema       # 创建 / 修复 CMS 内容模型
npm run migrate:cms:postgres   # SQLite → PostgreSQL 迁移入口
npm run test:api               # 检查 API 语法
npm run test:db                # 检查 Directus 数据库（SQLite / PostgreSQL）
npm run test:cms-schema        # 检查 CMS 表、字段、关系
npm run test:cms-crud          # 检查 CMS CRUD 与关联读取
npm run health                 # 检查本地服务健康状态
npm run manager                # 启动本地服务管理面板
```

---

## 内容模型

### `posts` — 文章

| 字段 | 说明 |
|------|------|
| `title` | 标题 |
| `slug` | URL 标识 |
| `body` | Markdown 正文 |
| `cover` | 封面图 |
| `tags` · `category` | 标签与分类 |
| `status` | `draft` / `published` |

### `video_projects` — 视频项目

| 字段 | 说明 |
|------|------|
| `title` · `slug` | 标题与 URL 标识 |
| `description` · `cover` | 描述与封面 |
| `tags` · `category` | 标签与分类 |
| `sort` · `status` | 排序与发布状态 |
| `masters` | 关联的母版列表 |

### `video_masters` — 视频母版

| 字段 | 说明 |
|------|------|
| `type` | `sdr` / `hdr10` / `hlg` / `dolby_vision` / `custom` |
| `hls_url` · `source_url` | HLS 播放地址 · 源文件地址 |
| `codec` · `resolution` | 编码 · 分辨率 |
| `color_space` · `transfer` · `bit_depth` | 色彩空间 · 传递函数 · 位深 |
| `bitrate` | 码率 |
| `dovi_metadata` | Dolby Vision 元数据 |
| `is_default` · `status` | 默认母版 · 状态 |

---

## 上传与播放流程

```
① /upload 页面  ──▶  输入令牌 + 元数据，选择视频文件或 DV Master Package
         │
         ▼
② Upload API    ──▶  保存到 media/  ──▶  调用 FFmpeg 生成 HLS + 提取技术元数据
         │
         ▼
③ Directus CMS  ──▶  写入 video_projects + video_masters
         │
         ▼
④ 前端详情页    ──▶  读取 Directus 数据  ──▶  Shaka Player 播放 HLS
         │
         ▼
⑤ 播放器        ──▶  用户切换 SDR / HDR10 / HLG / Dolby Vision / Custom 母版
```

---

## 部署

详细部署步骤请参考 [docs/](docs/) 目录：

- **Windows 服务** — `deployment/windows/` PowerShell 脚本，注册为系统服务开机自启
- **Nginx** — `deployment/nginx/` 反向代理配置，支持 HLS 静态服务与 HTTPS

---

<div align="center">

Made with care for cinema-grade video publishing on self-hosted infrastructure.

</div>
