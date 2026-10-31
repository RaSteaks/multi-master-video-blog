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
Directus CMS 内容管理，支持 Windows、Linux systemd 和 Docker Compose 部署，配合 Nginx 提供 HTTPS 与媒体服务

</div>

---

## 核心特性

| 特性 | 描述 |
|------|------|
| **多母版视频** | 同一项目支持 SDR · HDR10 · HLG · Dolby Vision · Custom 任意切换 |
| **HLS 自适应播放** | Shaka Player 驱动，浏览器端原生 HLS 流式播放 |
| **自动转码** | 上传即触发 FFmpeg / FFprobe，自动生成 HLS 并提取技术元数据 |
| **Headless CMS** | Directus 12，REST + GraphQL，结构化管理文章与视频项目 |
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
| **Directus 12** | Headless CMS，提供 REST + GraphQL API 与可视化管理界面 |
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
│   ├── windows/             # Windows 服务脚本
│   ├── linux/               # systemd 单元、低内存配置、维护更新脚本
│   └── docker/              # 镜像、Compose、HTTPS/Vulkan override
├── docs/                    # 项目、前端、上传、部署详细说明
├── media/                   # HLS / 媒体文件存储目录
├── scripts/                 # CMS 初始化 · 测试 · 迁移 · 健康检查
├── logs/                    # 本地服务日志
└── README.md
```

---

## 快速开始

### 前置依赖

- **Node.js 22 LTS** `>= 22.12.0 < 23`
- **FFmpeg** + **FFprobe**（加入系统 PATH 或通过 `.env` 指定路径）
- **PostgreSQL**
- **Windows 11** / Windows Server 或 **Linux**；生产安装见 [部署](#部署)
- Docker 部署只需宿主机 Docker 环境，按下方 [Docker 步骤](#deploy-docker)安装

### 环境变量配置

<details>
<summary><strong>apps/web/.env.local</strong></summary>

```env
DIRECTUS_URL=
DIRECTUS_EMAIL=
DIRECTUS_PASSWORD=
DIRECTUS_SHOW_DRAFTS=false
DIRECTUS_REVALIDATE=30
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
npm run repair:cms-insights    # 只读检查部署环境中缺少聚合函数的 Insights 折线图
npm run migrate:cms:postgres   # SQLite → PostgreSQL 迁移入口
npm run test:api               # API 语法与单元、媒体回归测试
npm run test:album-api         # 对运行中的 API / Directus 执行相簿集成测试并清理测试数据
npm run test:db                # 检查 Directus 数据库（SQLite / PostgreSQL）
npm run test:cms-schema        # 检查 CMS 表、字段、关系
npm run test:cms-crud          # 检查 CMS CRUD 与关联读取
npm run test:web               # 前端单元测试
npm run test:external-projects # 独立网站数据、封面和发布权限测试
npm run test:project-browser   # 隔离 CMS 与 headless WebKit 项目页验证
npm run test:article-editor-browser # 启动 dev:web 后，以 headless WebKit 检查文章预览滚动
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

从安全审查前的版本升级，请先阅读 [安全更新部署顺序](docs/security-remediation-2026-10-23.md)。
Directus 12 涉及数据库迁移、认证健康检查和匿名 CMS 权限收口，不能只重启旧构建。

| 部署方式 | 入口 | 适用环境 |
|----------|------|----------|
| Linux 原生服务 | [systemd 部署步骤](#deploy-linux) | 已有 PostgreSQL、Nginx，希望直接管理进程 |
| Docker Compose | [Docker 部署步骤](#deploy-docker) | 希望用容器管理应用、数据库和持久化存储 |
| Windows 本地服务 | [部署说明](docs/deployment.md) · `deployment/windows/` | Windows 11 / Windows Server |

Linux 与 Docker 共用 `low-2gb`、`low-4gb` 资源档位，默认将重处理并发和前端构建 worker 限制为 1。2GB 机器本机构建需预先配置至少 **2GiB swap**，构建期间使用维护窗口。内存预算、迁移和完整回滚说明见 [Linux 部署指南](docs/linux-deployment.md)。

<a id="deploy-linux"></a>

### Linux 原生部署（systemd）

#### 1. 准备环境与目录

需要 **systemd、Node.js 22、npm、PostgreSQL 17、Nginx、FFmpeg / FFprobe、Git、curl、tar、util-linux**。服务单元使用 `/usr/bin/node`，请确认该路径安装的是 Node 22。FFmpeg 需匹配 FFprobe 版本；HDR 自动生成 SDR 还需要 libplacebo、zscale、Dolby Vision 支持和可用 Vulkan。

以下是**首次安装**步骤，从仓库根目录执行，并使用已包含部署文件的已提交版本。已有安装请使用后面的更新流程。

```bash
resource_profile=low-2gb            # 4GB 机器改为 low-4gb
release_dir=/opt/video-blog/releases/initial

sudo useradd --system --create-home --shell /usr/sbin/nologin video-blog
sudo install -d -o video-blog -g video-blog "$release_dir"
sudo install -d -o video-blog -g video-blog /var/lib/video-blog/{media,uploads,extensions,tmp,content,.private-media/film-scans}
sudo install -d -o root -g video-blog -m 0750 /etc/video-blog

# 仅导出已提交源码，不复制本机环境文件、依赖或媒体。
git archive HEAD | sudo tar -x -C "$release_dir"
sudo chown -R video-blog:video-blog "$release_dir"
sudo ln -s "$release_dir" /opt/video-blog/current
cd /opt/video-blog/current
```

#### 2. 创建数据库、填写配置

在已运行的 PostgreSQL 中创建账号和数据库；交互输入密码，不放进命令行：

```bash
sudo -u postgres createuser --pwprompt directus
sudo -u postgres createdb --owner=directus video_blog

sudo install -o root -g video-blog -m 0640 \
  "deployment/linux/profiles/$resource_profile.env.example" /etc/video-blog/resources.env
for service in api web cms; do
  sudo install -o root -g video-blog -m 0640 \
    "deployment/linux/$service.env.example" "/etc/video-blog/$service.env"
done
sudoedit /etc/video-blog/cms.env /etc/video-blog/api.env /etc/video-blog/web.env
```

填写以下字段，所有真实值保存在 `/etc/video-blog/`，不要提交到 Git：

| 配置文件 | 需要填写或核对 |
|----------|----------------|
| `cms.env` | `PUBLIC_URL`（公开站点地址）、`KEY`、`SECRET`、数据库连接、管理员邮箱与密码 |
| `api.env` | CMS 服务账号、上传/文章 token、FFmpeg/FFprobe 路径；媒体根目录保持 `/var/lib/video-blog/media` |
| `web.env` | 同一 CMS 服务账号、`REVALIDATE_SECRET` |
| `resources.env` | `RESOURCE_PROFILE` 与机器内存档位一致 |

`DIRECTUS_URL` 保持 `http://127.0.0.1:8055`；`PUBLIC_URL` 是浏览器访问地址。API/Web 的服务账号在第 4 步创建后填写。可用 `openssl rand -hex 32` 分别生成密钥和 token。

PostgreSQL 的低内存示例位于 `deployment/linux/profiles/postgresql-low-2gb.conf` 和 `postgresql-low-4gb.conf`。按实际数据库安装路径配置 include，审阅后重启数据库；已有数据库先备份。

#### 3. 安装依赖、构建前端

```bash
sudo -u video-blog env NODE_OPTIONS=--max-old-space-size=768 npm_config_jobs=1 \
  npm ci --no-audit --no-fund

FFMPEG_PATH=/usr/bin/ffmpeg FFPROBE_PATH=/usr/bin/ffprobe \
  node scripts/check-media-tools.cjs

sudo -u video-blog env CMS_RUNTIME_ONLY=true node \
  --env-file=/etc/video-blog/resources.env --env-file=/etc/video-blog/web.env \
  scripts/run-service.cjs build

# 可写数据放在 release 目录之外，更新源码时保留。
sudo -u video-blog ln -s /var/lib/video-blog/tmp apps/api/tmp
sudo -u video-blog ln -s /var/lib/video-blog/content/about.md apps/web/content/about.md
```

工具检查会确认 FFmpeg 的编译能力；实际 Vulkan 设备还需要运行转换任务验证。自定义 About 内容可写入 `/var/lib/video-blog/content/about.md`，没有该文件时使用默认内容。

#### 4. 初始化 CMS、启动服务

```bash
sudo -u video-blog node \
  --env-file=/etc/video-blog/resources.env --env-file=/etc/video-blog/cms.env \
  scripts/run-service.cjs bootstrap

sudo cp deployment/linux/systemd/*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now video-blog-cms

sudo -u video-blog node \
  --env-file=/etc/video-blog/resources.env --env-file=/etc/video-blog/cms.env \
  scripts/run-service.cjs schema
```

CMS 监听 `127.0.0.1:8055`。远程安装时，在自己的电脑执行 `ssh -L 8055:127.0.0.1:8055 user@server`，然后打开 `http://127.0.0.1:8055/admin`。使用管理员账号登录，创建满足项目内容/文件操作需求的有限权限服务账号，将其邮箱和密码填写到 `/etc/video-blog/api.env` 与 `web.env`，再启动应用：

```bash
sudo systemctl enable --now video-blog-api video-blog-web
CMS_ENV_FILE=/etc/video-blog/cms.env node scripts/directus-health.cjs
curl --fail --retry 30 --retry-connrefused --retry-delay 2 http://127.0.0.1:8060/health
curl --fail --silent --retry 30 --retry-connrefused --retry-delay 2 http://127.0.0.1:3000/ > /dev/null
```

#### 5. 配置 Nginx 与 HTTPS

```bash
sudo install -d /etc/nginx/blog
sudo install -m 0644 deployment/nginx/blog-routes.conf /etc/nginx/blog/routes.conf
sudo install -m 0644 deployment/nginx/linux-nginx.example.conf /etc/nginx/conf.d/video-blog.conf
sudoedit /etc/nginx/conf.d/video-blog.conf
# 将 example.com 和证书路径替换为实际值；使用已有证书。
sudo nginx -t
sudo systemctl reload nginx
```

Nginx 主配置在少核心机器上使用 `worker_processes 1`，并确保包含 `conf.d/*.conf`。媒体通过 API 的规范路径与私有目录检查；不要添加静态媒体 alias。对外只开放 Nginx 的 HTTP/HTTPS 端口；3000、8055、8060 和数据库保持内网访问。

#### 日常管理与更新

```bash
sudo systemctl status video-blog-cms video-blog-api video-blog-web
sudo journalctl -u video-blog-api -n 100

# 从包含目标提交的 Git 仓库构建新 release；替换路径和提交号。
sudo bash deployment/linux/update-native.sh /path/to/repository COMMIT_OR_TAG
```

更新脚本检查维护状态、暂停应用服务、在独立目录构建，再切换 `current`。构建或就绪检查失败时恢复旧 release 和原服务状态。首次从不支持 `drain` 写请求检查的旧版本迁入，应按首次安装流程安排人工维护窗口。数据库 schema 升级和备份需要单独执行，不随应用更新自动运行。

<a id="deploy-docker"></a>

### Docker Compose 部署

#### 1. 准备环境与配置

需要 **Docker Engine 已启动、Docker Compose v2.24+ 或 v5**。应用依赖和 FFmpeg 在镜像内安装，不需要宿主机 Node/PostgreSQL。Linux 更新脚本另需 bash、flock、awk。以下步骤从仓库根目录开始：

```bash
cd deployment/docker
cp .env.example .env
printf 'RELEASE_TAG=local\n' > .release.env
chmod 600 .env
# 用编辑器填写 .env；后续更新不要重新覆盖 .release.env。
```

在 `.env` 中设置：

- `RESOURCE_PROFILE=low-2gb` 或 `low-4gb`；下方 Compose override 选择相同档位。
- `PUBLIC_URL`：浏览器访问的完整站点地址，例如本机 `http://localhost:8080`，远程服务器则填写实际域名和端口。
- `DB_PASSWORD`、`DIRECTUS_KEY`、`DIRECTUS_SECRET`、`ADMIN_EMAIL`、`ADMIN_PASSWORD`。
- `SERVICE_EMAIL`、`SERVICE_PASSWORD`：预先填写稍后将在 CMS 创建的服务账号信息；Compose 初始化时也要求这两个值非空。
- `UPLOAD_API_TOKEN`、`ARTICLE_API_TOKEN`、`REVALIDATE_SECRET`：分别生成随机值。

`.release.env` 保存当前应用镜像标签；更新脚本会维护它。可选的 `runtime.env` 用于覆盖非秘密资源参数，详细变量见 [资源档位说明](docs/linux-deployment.md#资源档位)。

#### 2. 串行构建、初始化数据库和 CMS

```bash
resource_profile=low-2gb            # 4GB 机器改为 low-4gb
# 以下函数在 deployment/docker 目录、当前 shell 中使用。
dc() {
  docker compose --env-file .env --env-file .release.env \
    -f compose.yaml -f "compose.$resource_profile.yaml" "$@"
}

dc --profile setup config --quiet
# 少内存机器逐个构建，避免多个镜像同时编译。
dc build cms
dc build api
dc build web

dc up -d --wait db
dc --profile setup run --rm bootstrap
dc up -d --wait cms
dc --profile setup run --rm schema
```

首次初始化按“数据库 → Directus bootstrap → CMS → 项目 schema”执行。普通重启不需要重复 bootstrap/schema。Web 镜像构建不连接 CMS，也不传入 CMS 密码；API 镜像构建会检查 FFmpeg 的必要能力。

#### 3. 创建服务账号、启动站点

临时开放 CMS 的宿主机回环端口，以便创建服务账号：

```bash
docker compose --env-file .env --env-file .release.env \
  -f compose.yaml -f "compose.$resource_profile.yaml" -f compose.admin-local.yaml \
  up -d --no-deps cms
```

访问 `http://127.0.0.1:8055/admin`，远程服务器使用 SSH 端口转发。以管理员登录，创建与 `.env` 中 `SERVICE_EMAIL` / `SERVICE_PASSWORD` 一致、具备项目所需权限的服务账号，然后移除临时端口并启动应用：

```bash
dc up -d --force-recreate --wait cms
dc up -d --wait api web nginx
dc ps
dc logs --tail 100 cms api web
```

默认通过 `http://localhost:8080` 访问站点，后台为 `/admin/`。远程访问请使用服务器实际地址。仅 Nginx 对外发布端口；PostgreSQL、CMS、API、Web 通过容器内部网络连接。

#### 可选：HTTPS 和 Vulkan

若要使用 HTTPS，应在首次构建前将 `.env` 的 `PUBLIC_URL` 设为公开 HTTPS origin，设置 `TLS_CERT_DIR`，并在该目录放入 `fullchain.pem`、`privkey.pem`。将 `dc` 定义替换为：

```bash
dc() {
  docker compose --env-file .env --env-file .release.env \
    -f compose.yaml -f "compose.$resource_profile.yaml" -f compose.https.yaml "$@"
}
```

随后使用这个函数执行上述构建、初始化和启动步骤。默认 HTTPS 宿主机端口是 `8443`，可通过 `HTTPS_PORT` 改为 `443`；`PUBLIC_URL` 必须与实际公开端口一致。证书只读挂载，不写入镜像。已有站点改变公开 origin 后，需要按更新流程重新构建 Web。

有兼容 Mesa Vulkan 设备时，设置 `VULKAN_DEVICE` 和数字 `RENDER_GID`，在相同的 Compose 文件列表末尾、`"$@"` 前追加 `-f compose.vulkan.yaml`。不使用 privileged。没有合适设备时，HDR 自动生成 SDR 无法保证可运行；普通浏览与 HLS copy 等功能仍保留。

#### 持久化、更新与回滚

数据库、Directus uploads/extensions、公开媒体、私有胶片、上传临时文件和 About 内容使用独立命名卷；Nginx 通过 API 访问媒体，不直接挂载这些文件卷。普通 `dc down` 会保留卷，**更新或停止时不要使用 `down -v`**。数据库和媒体文件需要一起备份，迁移与恢复步骤见 [完整指南](docs/linux-deployment.md#持久化迁移和备份)。

```bash
# 首次安装完成且四个应用服务运行后，使用未使用过的新标签更新。
bash update.sh "$resource_profile" release-001

# 如果部署使用 HTTPS/Vulkan，更新时也传入对应选项。
ENABLE_HTTPS=true ENABLE_VULKAN=true bash update.sh "$resource_profile" release-002
```

更新脚本先进入维护状态，确认没有在途 API 写请求或媒体处理，再暂停应用并串行构建；失败时尝试恢复原镜像，保留数据库和数据卷。成功后更新 `.release.env`，并生成 `rollback-<标签>.json` / `.env`，用于后续显式回滚。不要重复使用已有发布标签。schema 迁移、外部配置和数据库恢复不包含在镜像回滚中。

Linux 实机、容器和 Vulkan 的验收范围及当前验证结果见 [维护与验证](docs/linux-deployment.md#维护与验证)。

### 其他说明

- **网站内写文章** — [文章发布说明](docs/article-writing.md)，包含 `/write`、文章图片与 Directus 发布链路。
- **相簿与 HDR 照片** — [相簿说明](docs/albums.md)，包含文件配对、验证、管理接口和显示回退。
- **Windows 服务** — [部署说明](docs/deployment.md) 与 `deployment/windows/` PowerShell 脚本。

---

<div align="center">

Made with care for cinema-grade video publishing on self-hosted infrastructure.

</div>
