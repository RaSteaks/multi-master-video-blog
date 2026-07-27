<div align="center">

# 今天色彩空间设对了吗？

**面向个人创作者的自托管博客**

[![Next.js](https://img.shields.io/badge/Next.js-16-black?style=flat-square&logo=next.js)](https://nextjs.org)
[![React](https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=black)](https://react.dev)
[![Directus](https://img.shields.io/badge/Directus-11-64F?style=flat-square&logo=directus&logoColor=white)](https://directus.io)
[![Node.js](https://img.shields.io/badge/Node.js-≥22-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Windows](https://img.shields.io/badge/Windows-11-0078D4?style=flat-square&logo=windows&logoColor=white)](https://www.microsoft.com/windows)

支持文章发布、SDR / HDR 相簿、视频项目管理、HLS 自适应播放、SDR / HDR10 / HLG / Dolby Vision 多母版切换
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
| **站内写作台** | `/write` 直接编写与预览 Markdown，统一上传封面和正文图片后由 Directus 入库 |
| **HDR 相簿** | `/albums` 页内新建相簿、批量配对 SDR 与 HDR AVIF；网格使用 SDR，HDR 设备的灯箱优先显示 PQ / HLG 原片 |

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
| **Node.js ≥ 22** | 视频上传 · 转码 · 文章发布 · 媒体代理服务 |
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
UPLOAD_API_TOKEN=__REPLACE_WITH_RANDOM_UPLOAD_TOKEN__
ARTICLE_API_TOKEN=__REPLACE_WITH_RANDOM_ARTICLE_TOKEN__
MEDIA_ROOT=
DIRECTUS_URL=
DIRECTUS_EMAIL=
DIRECTUS_PASSWORD=
MAX_ARTICLE_UPLOAD_BYTES=67108864
MAX_ARTICLE_IMAGE_BYTES=12582912
MAX_ARTICLE_MARKDOWN_BYTES=2097152
MAX_ARTICLE_IMAGES=24
MAX_ALBUM_UPLOAD_BYTES=536870912
MAX_ALBUM_IMAGE_BYTES=67108864
MAX_ALBUM_PHOTOS=24
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
npm run test:album-api         # 对运行中的 API / Directus 执行相簿集成测试并清理测试数据
npm run test:db                # 检查 Directus 数据库（SQLite / PostgreSQL）
npm run test:cms-schema        # 检查 CMS 表、字段、关系
npm run test:cms-crud          # 检查 CMS CRUD 与关联读取
npm run test:web               # 前端单元测试
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
| `content` | Markdown 正文 |
| `cover_image` | Directus 封面文件 UUID |
| `tags` · `category` | 标签与分类 |
| `published` | `false` 草稿 / `true` 发布 |

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

### `albums` / `album_photos` — SDR / HDR 相簿

| 集合 | 关键字段 |
|------|----------|
| `albums` | `title` · 唯一 `slug` · `description` · `cover_image` · `published` · `photos` |
| `album_photos` | `album_id` · 必选 `sdr_image` · 可选 `hdr_image` · `caption` · `alt_text` · HDR transfer / primaries / bit depth · `published` · `sort_order` |

相簿封面与网格只使用 SDR 预设资源；灯箱以 SDR 原图为保底，并仅在
`(dynamic-range: high)` 匹配时尝试 HDR AVIF。

---

## 文章编写流程

```text
① /write 页面  ──▶  编写 Markdown，选择封面与正文图片，实时预览
         │
         ▼
② Article API   ──▶  校验 ARTICLE_API_TOKEN、字段和图片
         │
         ▼
③ Directus      ──▶  上传 Files，替换正文图片占位符，创建或更新 posts 记录
         │
         ▼
④ /posts        ──▶  已发布文章自动出现在列表与详情页
```

完整配置、表单契约与故障排查见 [docs/article-writing.md](docs/article-writing.md)。

---

## 视频上传与播放流程

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

## 相簿与 HDR 照片流程

```text
① /albums 页标题区 ──▶ 新建公开相簿或草稿；选择目标相簿
          │
          ▼
② SDR / HDR 拖放区 ──▶ 以忽略大小写的去扩展名文件名配对
          │
          ▼
③ Album API       ──▶ 校验签名、FFprobe 元数据、位深、PQ/HLG 与宽高比
          │
          ▼
④ Directus        ──▶ 整批上传文件与 album_photos；失败时逆序回滚
          │
          ▼
⑤ 网格 / 灯箱      ──▶ 缩略图固定 SDR；HDR 显示设备优先 HDR，失败回退 SDR
```

完整的格式约束、接口、管理模式和上线检查见
[docs/albums.md](docs/albums.md)。

---

## 部署

详细部署步骤请参考 [docs/](docs/) 目录：

- **网站内写文章** — [docs/article-writing.md](docs/article-writing.md)，包含 `/write`、文章图片与 Directus 发布链路
- **相簿与 HDR 照片** — [docs/albums.md](docs/albums.md)，包含文件配对、验证、管理接口和显示回退
- **Windows 服务** — `deployment/windows/` PowerShell 脚本，注册为系统服务开机自启
- **Nginx** — `deployment/nginx/` 反向代理配置，支持 HLS 静态服务与 HTTPS

---

<div align="center">

Made with care for cinema-grade video publishing on self-hosted infrastructure.

</div>
