# 测试说明

测试按执行环境和实际行为组织。修复优先复用所属模块的已有测试或浏览器流程；
不为每个修复新建文件、npm 命令或一套测试服务器，也不通过检查源码字符串代替运行行为。
只有现有覆盖无法验证的重要行为，才增加必要断言。

## 常用入口

在仓库根目录使用 Node 22 和 npm：

| 命令 | 范围与条件 |
| --- | --- |
| `npm test` | 顺序运行下列三组，每组一次；任一失败即停止 |
| `npm run test:web` | `apps/web/src/lib/*.test.ts`，Vitest，前端纯逻辑 |
| `npm run test:node` | `tests/*.test.cjs` 与 `scripts/test-manager-*.cjs`，隔离目录、服务和进程 |
| `npm run test:api` | `apps/api/test/*.test.cjs`，包含真实媒体文件处理 |

`test:node` 取代原来名不符实的 `test:resources`，也包含原来的 security、video-upload、
cms-insights 和 manager 子集。external-projects 已包含在 `test:api`。
不再为这些子集重复维护 npm 命令；定位时直接选择文件，例如：

```sh
node --test tests/security.test.cjs tests/security-remediation.test.cjs
node --test tests/deployment.test.cjs
npm --workspace @multi-master-video-blog/web run test -- src/lib/external-projects.test.ts
```

API 定向测试也可从 `apps/api` 执行 `node --test test/<名称>.test.cjs`。
真实媒体测试需要匹配的 `FFMPEG_PATH` / `FFPROBE_PATH`；HDR 转换还需要可用的
libplacebo/Vulkan、对应编解码器及 Dolby RPU 支持。能力不足应报告实际失败，不能
删掉测试或改为无条件跳过。Windows 进程测试在非 Windows 平台明确跳过；Docker
Compose 解析检查需要 Docker CLI，镜像构建另行执行。

## 单元与服务测试归属

| 目录 | 保留的行为覆盖 |
| --- | --- |
| `apps/web/src/lib` | 文章/相簿/网站数据解析、作者任务、排序、路由、图片请求、播放器选源/切换、色彩与图形、手势及主题偏好 |
| `apps/api/test` | CMS 客户端与认证、资产缓存/预设、HTTP、网站与排序、相簿、胶片分析/清理、归档/对象存储、HLS/IMF/SDR 与来源格式 |
| `tests/security*.test.cjs` | 权限撤销、上传边界、私有文件隔离、会话及服务故障恢复 |
| `tests/resources.test.cjs`、`review-regressions.test.cjs`、`media-runtime.test.cjs` | 资源限制、恢复/维护流程、真实媒体进程参数 |
| `tests/deployment.test.cjs`、`storage-config.test.cjs`、`web-build-types.test.cjs` | 部署故障恢复、配置隔离、生产 TypeScript 配置 |
| `tests/manager-*.test.cjs`、`scripts/test-manager-*.cjs` | Manager 会话、配置备份、Git 更新、任务展示和进程生命周期 |
| `tests/video-upload.test.cjs`、`directus-insights.test.cjs` | 断点上传/恢复与 Insights 修复工具 |
| `tests/film-resource-state.test.cjs`、`hlg-ramp.test.cjs` | 资源受限状态的实际渲染与生成的 HLG 图片信号 |

## 按需浏览器与集成验证

这些测试成本较高，不放入默认 `npm test`。根据改动选择已有流程，直接运行表中的脚本。
浏览器使用 headless WebKit 或 Firefox，不启动 Chrome，不连接个人浏览器配置。
不同脚本可能共用固定端口，应串行执行。日志、报告和截图保留在 `test-results/`。

| 功能 | 脚本（`node tests/…`） |
| --- | --- |
| 网站创建/编辑/发布与 iframe 生命周期 | `project-browser.cjs` |
| 网站布局/分组/排序、移动端目录及分页 | `project-layouts-browser.cjs` |
| 支持页、静态加载与导航 | `support-browser.cjs`（包含生产构建） |
| 图片浏览器缓存与权限撤销 | `asset-cache-browser.cjs`（包含生产构建；缓存算法由 API 单元测试负责） |
| 首页、列表一致性、路由切换、排序 | `home-browser.cjs`、`list-pages-browser.cjs`、`route-wipe-browser.cjs`、`sort-browser.cjs` |
| 作者登录、任务托盘、创建菜单 | `author-session-browser.cjs`、`author-tray-browser.cjs`、`create-menu-browser.cjs` |
| 相簿、文章目录、视频上传与播放 | `album-lightbox-browser.cjs`、`article-toc-follow-browser.cjs`、`video-upload-browser.cjs`、`media-player-browser.cjs` |
| 页面工具、沉浸播放、HDR/SDR 切换 | `phase6-browser.cjs`（需 FFmpeg） |
| 首页生产缓存、失效重验证与非安全来源剪贴板 | `phase6-cache.cjs`（包含生产构建） |
| Manager 登录、配置、仓库、任务与更新 | `manager-login-browser.cjs`、`manager-config-browser.cjs`、`manager-repo-browser.cjs`、`manager-tasks-browser.cjs`、`manager-update-browser.cjs` |
| 本地 OSS 协议与内容存储 | `content-storage-integration.cjs`，也可用 `npm run test:content-storage` |

上述流程自行创建隔离 fixture。以下检查需要额外准备：

- `article-editor-browser.cjs`：先启动测试用 Web 服务，地址可由 `ARTICLE_EDITOR_BASE_URL` 指定。
- `motion-panels-browser.cjs`：使用测试用 Web 服务，地址可由 `MOTION_TEST_URL` 指定。
- `npm run test:cms-security`：临时 SQLite 和真实 Directus；使用 `--no-node-snapshot`。
  如需接着运行 `security-browser.cjs`，先用 `HOLD_FIXTURE=1` 保留该隔离 fixture。
- `node scripts/test-liquid-fluid-webgl.cjs`：隔离 Firefox WebGL 检查，对照工作区与 HEAD；
  结果保存在命令输出标明的临时目录。

网站流程可通过 `PROJECT_BROWSER=firefox` 切换引擎；排序通过 `SORT_ENGINE=firefox`。
不再提供 Chromium/CDP 专用触摸测试；触摸设备上的拖动仍需按平台单独验收。

## 连接已有服务的操作检查

以下命令独立保留，不纳入默认测试。它们读取部署环境，部分会创建、修改或清理 CMS
测试数据，必须针对明确指定的测试安装执行：

| 命令 | 用途 |
| --- | --- |
| `npm run test:db` | 数据库连接和结构 |
| `npm run test:cms-schema` | CMS 表、字段、关系、权限及预设 |
| `npm run test:cms-crud` | CMS 写入、关联读取及清理 |
| `npm run test:album-api` | 运行中的 API/Directus 相簿流程；支持 `ALBUM_API_ENV_FILE` |
| `npm run test:film-scan-cleanup` | 运行中的胶片扫描清理流程 |

前端构建使用 `npm run build:web`。浏览器测试自带构建时，不必再为同一份代码重复构建。
