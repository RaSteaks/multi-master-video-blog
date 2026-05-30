计划大纲

## 一、项目名称

项目名称：`multi-master-video-blog`

项目定位：一个支持文章发布、视频上传、多母版视频管理、HDR 播放和个人媒体展示的自托管博客系统。

部署环境：

* 本地 Windows 服务器
* ffmpeg
* node js
* PostgreSQL


---

## 二、项目目标

本项目旨在搭建一个可部署在 Windows 本地服务器上的媒体博客系统，支持用户在后台手动上传视频、填写标题和简介，并为同一个视频配置多个播放母版，例如 SDR、HDR10、HLG、Dolby Vision 等。

前台页面需要能够以博客或作品集的形式展示内容，并在视频播放器中提供不同母版的切换选项。

系统需要支持：

* 本地文件存储
* HLS 视频播放
* HDR 视频展示
* HTTPS 域名访问
* 后台内容管理
* Windows 本地部署
* 与现有 Nginx 集成

---

## 三、核心功能

### 1. 前台博客展示

* 首页展示最新文章或视频内容
* 支持文章详情页
* 支持视频详情页
* 支持封面图、标题、简介、发布时间
* 支持分类或标签
* 支持响应式布局，适配桌面端和移动端
* 支持深色主题，适合影像类内容展示

### 2. 后台内容管理

* 管理员登录
* 创建、编辑、删除文章
* 创建、编辑、删除视频项目
* 自定义标题
* 自定义简介
* 上传封面图
* 设置是否发布
* 设置排序或置顶

### 3. 视频上传与管理

* 支持手动上传视频文件或 HLS 文件
* 支持为同一个视频添加多个母版
* 每个母版可设置：

  * 母版名称
  * 母版类型：SDR / HDR10 / HLG / Dolby Vision
  * 视频地址
  * 编码格式
  * 分辨率
  * 色彩空间
  * Transfer Function
  * 备注
* 支持设置默认播放母版

### 4. 视频播放

* 前台集成视频播放器
* 支持 HLS 播放
* 支持 SDR / HDR / Dolby Vision 等多个母版切换
* 切换母版时保留当前播放时间
* 播放失败时自动回退到默认 SDR 母版
* 支持 poster 封面
* 支持全屏播放
* 支持移动端播放

### 5. HDR 支持

* 支持上传 HDR10、HLG、Dolby Vision 等视频母版
* 前台显示当前母版的技术信息
* 检测当前设备是否可能支持 HDR
* 对不支持 HDR 的设备显示提示
* 默认优先播放 SDR，HDR 由用户手动切换

---

## 四、推荐技术栈

### 前端

* Next.js
* TypeScript
* Tailwind CSS
* Shaka Player 或 Video.js

### 后台 CMS

优先方案：

* Directus


### 数据库

开发阶段：

* SQLite

正式部署：

* PostgreSQL

### 服务端（Windows 本地部署）

当前环境：

* Windows 11 / Windows Server
* Nginx
* Node.js LTS

项目仓库只提供 Nginx 示例配置，用于说明前台、后台、上传目录和媒体目录如何与现有 Nginx 集成。

### 是否需要 Docker

Docker 不是必须。

本项目支持两种运行方式：

#### 方案 A：纯 Windows 本地运行（推荐当前阶段）

直接运行：

* Next.js / Astro
* Directus
* PostgreSQL
* Node.js 服务

优点：

* 更符合当前已有环境
* 不需要学习 Docker
* 更容易直接访问本地文件
* 更方便调试视频路径
* 与现有 Nginx 集成简单

适合：

* 个人博客
* 本地服务器
* 单机部署
* 开发阶段

#### 方案 B：Docker 部署（后期可选）

Docker 的作用：

* 隔离运行环境
* 统一依赖版本
* 简化迁移
* 方便备份和重建
* 避免 Node.js / PostgreSQL 环境冲突

但 Docker 并不是必须条件。

当前阶段建议：

* 不强制使用 Docker
* 优先完成功能开发
* 后期如果需要迁移或重构，再考虑 Docker 化

### HTTPS

* 使用已有域名证书
* Nginx 手动配置 SSL
* 不使用 Certbot 自动申请
* SSL 证书和私钥不放入 GitHub 仓库
* 仓库中只保留 Nginx 示例配置文件

### 视频存储

* Windows 本地磁盘
* 路径示例：

```text
D:\multi-master-video-blog\media\
```

---

## 五、数据模型设计

### 1. Post / Article 文章表

字段：

* id
* title
* slug
* summary
* content
* cover_image
* tags
* category
* published
* created_at
* updated_at

### 2. Video Project 视频项目表

字段：

* id
* title
* slug
* description
* cover_image
* poster_image
* category
* tags
* published
* sort_order
* created_at
* updated_at

### 3. Video Master 视频母版表

字段：

- id
- project_id
- label
- type
- hls_url
- file_url
- codec
- resolution_width
- resolution_height
- color_space
- transfer_function
- bit_depth
- bitrate_mbps
- is_default
- sort_order
- status
- uploaded_at
- notes
- created_at
- updated_at

母版类型：

* sdr
* hdr10
* hlg
* dolby_vision
* custom


## 内容与上传规范

- 所有 slug 只能使用小写英文、数字和短横线
- 数据库中保存的是网页访问 URL，不保存本地硬盘绝对路径
- 每个 Video Project 至少需要一个 Video Master
- 每个 Video Project 必须有且只能有一个默认 Video Master
- 默认母版建议使用 SDR
- HLS URL 必须指向 master.m3u8
- HLS 文件目录必须与 Video Project 的 slug 保持一致
- HDR10 / HLG / Dolby Vision 母版必须填写 codec、color_space、transfer_function 和 bit_depth
- 大型视频文件不进入 Git 仓库
- media/ 目录默认由服务器本地磁盘管理

---


## 六、文件目录规划

```text
multi-master-video-blog/
├── apps/
│   ├── web/
│   │   ├── src/
│   │   ├── public/
│   │   └── package.json
│   │
│   └── cms/
│       └── directus/
│
├── media/
│   └── project-a/
│       ├── sdr/
│       │   └── master.m3u8
│       ├── hdr10/
│       │   └── master.m3u8
│       ├── hlg/
│       │   └── master.m3u8
│       └── dolby-vision/
│           └── master.m3u8
│
├── deployment/
│   └── nginx/
│       ├── windows-nginx.example.conf
│       └── README.md
│
├── README.md
└── docs/
    ├── project-plan.md
    ├── video-workflow.md
    └── deployment.md
```

Windows 本地部署建议路径：

```text
D:\multi-master-video-blog\
```

说明：

* `media/` 用于存放本地 HLS 视频文件。
* `deployment/nginx/` 只存放 Nginx 示例配置和部署说明。
* 不在 GitHub 仓库中存放真实 SSL 证书。
* 不在 GitHub 仓库中存放真实私钥文件。
* 真实 Nginx 配置仍然放在 Windows Nginx 的实际配置目录中。

---

## 七、前台页面规划

### 1. 首页

路径：`/`

功能：

* 展示博客标题和简介
* 展示最新文章
* 展示最新视频
* 支持进入视频详情页

### 2. 文章列表页

路径：`/posts`

功能：

* 显示所有文章
* 支持分类和标签筛选

### 3. 文章详情页

路径：`/posts/[slug]`

功能：

* 显示文章标题、正文、封面图、发布时间
* 支持 Markdown 内容

### 4. 视频列表页

路径：`/videos`

功能：

* 显示所有视频项目
* 显示封面、标题、简介
* 支持点击进入详情页

### 5. 视频详情页

路径：`/videos/[slug]`

功能：

* 显示视频标题和简介
* 显示视频播放器
* 自动生成母版切换按钮
* 显示当前母版技术信息
* 显示封面、标签、发布时间

### 6. 关于页面

路径：`/about`

功能：

* 显示个人介绍
* 显示联系方式
* 显示社交链接

---

## 八、播放器设计

播放器组件名称：

```text
MediaPlayer
```

输入数据：

```ts
type VideoMaster = {
  label: string;
  type: "sdr" | "hdr10" | "hlg" | "dolby_vision" | "custom";
  hlsUrl: string;
  codec?: string;
  resolution?: string;
  colorSpace?: string;
  transferFunction?: string;
  bitDepth?: string;
  isDefault?: boolean;
};
```

核心逻辑：

* 默认加载 `isDefault = true` 的母版
* 如果没有默认母版，则加载第一个母版
* 用户点击按钮后切换 HLS 地址
* 切换时记录当前播放时间
* 切换完成后跳回原播放时间
* 如果 HDR / Dolby Vision 播放失败，回退到 SDR
* 显示错误提示

---

## 九、视频处理流程

### 推荐流程

1. 在 DaVinci Resolve 或其他软件中导出视频母版
2. 分别生成 SDR、HDR10、HLG、Dolby Vision 版本
3. 将每个版本打包为 HLS
4. 上传 HLS 文件夹到本地 Windows 服务器
5. 在后台创建视频项目
6. 为视频项目添加多个母版地址
7. 前台自动读取并播放

### 视频目录示例

```text
/media/night-city/sdr/master.m3u8
/media/night-city/hdr10/master.m3u8
/media/night-city/hlg/master.m3u8
/media/night-city/dolby-vision/master.m3u8
```

---

## 十、部署规划

### 本地开发

推荐方式：

* 使用 Node.js 本地运行
* 使用 SQLite 或 PostgreSQL
* 前端使用开发服务器运行
* 视频文件使用本地 Windows 路径
* 使用 localhost 调试

可选：

* 后期可增加 Docker 支持
* 但 MVP 阶段不强制 Docker

### 正式部署（Windows 本地服务器）

服务器环境：

* Windows 11 / Windows Server
* 已部署 Windows Nginx
* PostgreSQL
* Node.js LTS

部署路径：

```text
D:\multi-master-video-blog\
├── apps\
│   ├── web\
│   └── cms\
├── media\
├── deployment\
└── docs\
```

Nginx 路由：

```text
/          → 前台博客
/admin/   → 后台 CMS
/media/   → 视频文件
/uploads/ → 图片上传目录
```

HTTPS：

* 使用已有 SSL 证书
* Nginx 手动配置 HTTPS
* 支持公网域名访问
* 真实证书路径在 Windows Nginx 中配置
* 仓库只保留 `windows-nginx.example.conf`

---

## 十一、Nginx 示例配置规划

仓库中提供：

```text
deployment/nginx/windows-nginx.example.conf
deployment/nginx/README.md
```

用途：

* 说明如何将 `/` 转发到前台服务
* 说明如何将 `/admin/` 转发到后台 CMS
* 说明如何将 `/media/` 映射到本地视频目录
* 说明如何配置 HLS 所需的 MIME 类型
* 说明如何配置缓存策略
* 说明如何引用已有 HTTPS 证书

示例配置中只允许出现占位符：

```text
example.com
C:/path/to/fullchain.pem
C:/path/to/privkey.pem
D:/multi-master-video-blog/media/
```

禁止在仓库中提交：

```text
真实域名
真实公网 IP
真实 SSL 私钥
真实数据库密码
真实后台密钥
```

---

## 十二、安全要求

* 后台必须登录后访问
* 视频上传目录禁止执行脚本
* 禁止目录浏览
* 限制上传文件类型
* 限制上传文件大小
* HTTPS 必须开启
* 只开放 80 和 443 端口
* Windows 防火墙限制无关端口
* 数据库不直接暴露到公网
* 定期备份数据库和媒体文件
* `.env` 文件不提交到仓库
* SSL 证书私钥不提交到仓库
* `media/` 可根据实际情况选择是否纳入 Git 追踪，默认建议不追踪大型视频文件

建议 `.gitignore` 包含：

```gitignore
.env
.env.local
.env.production
node_modules/
dist/
.next/
.astro/
directus/database/
directus/uploads/
media/
*.pem
*.key
*.crt
```

---

## 十三、开发阶段规划

### 第一阶段：项目初始化

目标：

* 创建 GitHub 仓库
* 初始化前端项目
* 初始化 CMS
* 配置 Node.js 运行环境
* 配置基础 README
* 添加 `.gitignore`
* 添加 Nginx 示例配置目录

交付内容：

* 可运行的前端页面
* 可访问的后台 CMS
* 基础项目结构
* `deployment/nginx/windows-nginx.example.conf`

### 第二阶段：内容模型搭建

目标：

* 创建文章模型
* 创建视频项目模型
* 创建视频母版模型
* 建立视频项目和母版之间的关联

交付内容：

* 后台可以创建文章
* 后台可以创建视频项目
* 后台可以添加多个视频母版

### 第三阶段：前台页面开发

目标：

* 首页
* 文章列表页
* 文章详情页
* 视频列表页
* 视频详情页
* 关于页面

交付内容：

* 前台可以读取 CMS 数据
* 内容发布后前台自动显示

### 第四阶段：播放器开发

目标：

* 集成 Shaka Player
* 支持 HLS 播放
* 支持母版切换
* 支持播放失败回退
* 显示母版技术信息

交付内容：

* 视频详情页可以播放 HLS
* 可以切换 SDR / HDR10 / HLG / Dolby Vision

### 第五阶段：上传与媒体管理

目标：

* 支持封面图上传
* 支持视频文件路径管理
* 支持手动填写 HLS 地址
* 后期可扩展 ZIP 上传和自动解压

交付内容：

* 管理员可以上传封面图
* 管理员可以配置视频播放地址

### 第六阶段：部署上线

目标：

* 配置现有 Windows Nginx
* 配置 HTTPS
* 配置生产环境变量
* 配置公网访问
* 配置 Windows 开机自启动
* 完成服务器部署文档

交付内容：

* 网站可以通过域名访问
* 后台可以通过域名访问
* 视频可以正常播放
* Nginx 示例配置已整理在 `deployment/nginx/`

---

## 十四、后续扩展功能

* ZIP 上传 HLS 文件夹并自动解压
* 后台自动生成 HLS 地址
* 上传 MP4 后自动转码为 HLS
* 视频访问权限控制
* 私密视频链接
* 访问统计
* 评论系统
* 多用户作者系统
* 图片画廊
* Before / After 对比组件
* RSS Feed
* SEO 优化
* Sitemap 自动生成
* 暗色 / 亮色主题切换

---

## 十五、README 初始说明

项目简介：

```text
Multi Master Video Blog is a self-hosted media blog system designed for creators who need video upload, HLS playback, HDR video support, and multi-master video switching.
```

核心特性：

```text
- Self-hosted blog
- Video upload support
- HLS video playback
- SDR / HDR10 / HLG / Dolby Vision master switching
- Custom title and description
- CMS-based content management
- Windows local server deployment
- HTTPS domain support
- Existing Nginx integration
```

---

## 十六、最小可用版本目标

MVP 需要完成：

* 管理员可以创建视频项目
* 管理员可以填写标题和简介
* 管理员可以上传封面图
* 管理员可以添加多个视频母版地址
* 前台可以展示视频项目
* 前台可以播放默认视频母版
* 前台可以切换不同母版
* 网站可以部署到 Windows 本地服务器
* 网站支持 HTTPS 域名访问
* 视频可以通过公网正常播放
* 仓库提供 Windows Nginx 示例配置
* 仓库不包含真实 SSL 证书和私钥
