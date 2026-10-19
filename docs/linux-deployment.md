# Linux：少核心、低内存部署

支持 **原生 systemd** 与 **Docker Compose**，面向 1–2 核、2–4GB 内存。两种部署方式使用同一个 `config/resource-profile.cjs`。默认未启用档位时维持原有部署方式；Windows Manager 不管理 Linux 服务。

## 资源档位

设置 `RESOURCE_PROFILE=low-2gb` 或 `low-4gb`。进程环境变量优先于应用 `.env`；服务启动时拒绝非法数字和未知档位。使用 `scripts/run-service.cjs` 才会设置 Node 堆和 CMS 默认资源参数，直接 `node server.cjs` 仍会应用 API 内的限流和图片限制。

| 参数 | low-2gb | low-4gb | 覆盖变量 |
|---|---:|---:|---|
| 重处理并发 | 1 | 1 | `MEDIA_PROCESS_CONCURRENCY` |
| HTTP 等待数 / 超时 | 4 / 60000ms | 4 / 60000ms | `MEDIA_PROCESS_MAX_PENDING` / `MEDIA_PROCESS_QUEUE_TIMEOUT_MS` |
| FFmpeg 线程 | 1 | min(2, 可用 CPU) | `FFMPEG_THREADS` |
| Sharp 并发 / 缓存 | 1 / 16MiB | 1 / 32MiB | `SHARP_CONCURRENCY` / `SHARP_CACHE_MIB` |
| 胶片最大输入像素 | 24,000,000 | 48,000,000 | `FILM_SCAN_MAX_PIXELS` |
| Web / API / CMS 堆 | 256 / 256 / 384MiB | 384 / 512 / 768MiB | `WEB_HEAP_MIB` / `API_HEAP_MIB` / `CMS_HEAP_MIB` |
| 构建堆 / worker | 1024MiB / 1 | 1536MiB / 1 | `BUILD_HEAP_MIB` / `BUILD_WORKERS` |
| Directus 变换并发 | 1 | 1 | `ASSETS_TRANSFORM_MAX_CONCURRENT` |
| CMS 连接池 min / max | 0 / 3 | 0 / 5 | `DB_POOL__MIN` / `DB_POOL__MAX` |
| PostgreSQL shared_buffers / 连接数 | 128MB / 20 | 256MB / 30 | 配置片段或 Compose 变量 |

线程限制不改变编码预设、CRF、色彩转换和 Dolby RPU 校验。HDR 自动 SDR 转换仍需 FFmpeg 的 libplacebo、zscale、apply_dolbyvision 和可用 Vulkan；没有设备时保持原有明确失败和 HDR 母版保留行为，不自动改用另一套转换算法。

像素上限在读取图像头后、完整解码前检查，多页图像累计计算。超限明确拒绝，不降低画质；旧任务的预览、分析、重新发布也检查。提高上限前必须重新测量峰值内存。

`PROCESS_MAX_OUTPUT_BYTES` 默认 16MiB，限制 FFprobe 等结构化输出及 Dolby sidecar；超限失败，不解析截断 JSON。`PROCESS_MAX_LOG_BYTES` 默认 64KiB，只保留子进程诊断尾部。启用低资源档位时使用 `MEDIA_PROCESS_*`，原 `VIDEO_PROCESS_*` 队列参数用于未启用档位时的独立视频队列。视频、胶片分析、预览和发布共享槽位；后台任务不因 HTTP 排队超时丢失。维护模式和重启后依赖已有 Directus 任务记录及磁盘 rollback 记录恢复。

**这些是初始预算，不是 2GB 上的性能或无 OOM 保证。** Node 堆不包含 Buffer、Sharp/libvips、FFmpeg、Vulkan、数据库、文件缓存和容器运行时。2GB 上超大视频解码仍可能超过预算，应以实际输入验证。Directus 参数见[官方配置](https://docs.directus.io/self-hosted/config-options)，数据库并发内存见 [PostgreSQL 资源说明](https://www.postgresql.org/docs/current/runtime-config-resource.html)。

## 原生 systemd 首次安装

以下命令是管理员显式部署步骤，不会由开发测试自动执行。需要 systemd、Node 22（`/usr/bin/node`）、npm、PostgreSQL 17、Nginx、curl、Git、tar、util-linux。示例路径固定为 `/opt/video-blog/current` 和 `/var/lib/video-blog`；改变路径时同步修改单元和 Nginx alias。

1. 创建专用服务用户和持久目录：

   ```bash
   sudo useradd --system --create-home --shell /usr/sbin/nologin video-blog
   sudo install -d -o video-blog -g video-blog /opt/video-blog/releases
   sudo install -d -o video-blog -g video-blog /var/lib/video-blog/{media,uploads,extensions,tmp,content,.private-media/film-scans}
   sudo install -d -m 0750 -g video-blog /etc/video-blog
   ```

2. 将一个已提交版本展开到 `/opt/video-blog/releases/<版本>`，归属 `video-blog`，建立 `/opt/video-blog/current` 符号链接。将 `deployment/linux/{api,web,cms}.env.example` 复制为 `/etc/video-blog/{api,web,cms}.env`，将选定 `profiles/low-*.env.example` 复制为 `/etc/video-blog/resources.env`。填入真实值，文件权限设为 `root:video-blog 0640`。不要把真实凭据写入 Git。

3. PostgreSQL 创建专用数据库和账号。按档位将 `deployment/linux/profiles/postgresql-*.conf` 作为配置 include，审阅后再重启数据库。已有数据库先备份；不更换数据库类型，不自动降低数据库版本。

4. 安装 FFmpeg/FFprobe 并设置 API 环境文件中的绝对路径。验证编译能力：

   ```bash
   cd /opt/video-blog/current
   FFMPEG_PATH=/usr/bin/ffmpeg FFPROBE_PATH=/usr/bin/ffprobe node scripts/check-media-tools.cjs
   ```

   此检查不代表 Vulkan 设备已可用。有 GPU 时，还需给 `video-blog` 添加设备对应组权限，并实际验证 HDR 转换。

5. 安装依赖并在维护窗口构建。2GB 配置至少 2GiB swap；脚本只检查，不自动创建或修改 swap。

   ```bash
   cd /opt/video-blog/current
   sudo -u video-blog env NODE_OPTIONS=--max-old-space-size=768 npm_config_jobs=1 npm ci --no-audit --no-fund
   sudo -u video-blog env CMS_RUNTIME_ONLY=true node --env-file=/etc/video-blog/resources.env --env-file=/etc/video-blog/web.env scripts/run-service.cjs build
   sudo -u video-blog ln -s /var/lib/video-blog/tmp apps/api/tmp
   sudo -u video-blog ln -s /var/lib/video-blog/content/about.md apps/web/content/about.md
   ```

6. 显式 bootstrap，安装服务单元，然后初始化项目模型：

   ```bash
   sudo -u video-blog node --env-file=/etc/video-blog/resources.env --env-file=/etc/video-blog/cms.env scripts/run-service.cjs bootstrap
   sudo cp deployment/linux/systemd/*.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now video-blog-cms
   sudo -u video-blog node --env-file=/etc/video-blog/resources.env --env-file=/etc/video-blog/cms.env scripts/run-service.cjs schema
   ```

   服务启动器会等待 CMS readiness，避免 API 在 CMS 尚未就绪时漏掉启动队列恢复。首次登录可通过 SSH 转发 `8055` 到本机，创建有限权限的服务账号后填写 API/Web 配置；沿用项目的 CMS 权限说明。

7. `systemctl enable --now video-blog-api video-blog-web`。将 `deployment/nginx/blog-routes.conf` 安装为 `/etc/nginx/blog/routes.conf`，将 `linux-nginx.example.conf` 放到 Nginx 的 http-context 配置目录，替换域名和证书路径。在主配置使用 `worker_processes 1`，执行 `nginx -t` 后 reload。

服务只监听回环地址。Nginx 将媒体请求转发到 API 的规范路径与私有目录检查，保留 HEAD/Range；清单重新验证，分片缓存。上传 body 流式转发，不缓存完整大文件到 Nginx 临时目录。不要为媒体添加绕过 API 检查的静态 alias。

### 原生更新与回滚

```bash
sudo bash deployment/linux/update-native.sh /path/to/repository COMMIT_OR_TAG
```

脚本用 flock 防并行更新，要求现有 `current` 版本包含维护接口；从指定提交创建独立 release，以专用用户顺序安装和构建。它先开启维护模式并确认无在途 API 写请求和活跃任务，再停止原来运行的应用服务。构建或就绪检查失败时恢复旧链接和原服务状态，保留失败目录供排查。不自动执行 schema 迁移或修改 PostgreSQL。构建会依次加载 `/etc/video-blog/resources.env` 与 `/etc/video-blog/web.env`，后者覆盖前者，保留 `BUILD_HEAP_MIB`、`BUILD_WORKERS` 和服务端地址等配置。

首次从旧版本迁入时，按首次安装步骤在人工维护窗口切换，不能对不支持 `drain` 动作及 `activeWrites` 诊断的旧版本使用更新脚本。

需要稍后主动回滚时：先开启维护并确认空闲，停止应用服务，将 `current` 指向脚本输出的旧 release，然后启动并检查健康状态。不要删除共享媒体、uploads、数据库和旧 release。旧应用必须兼容当前 schema；数据库回退是独立恢复操作。

## Docker Compose 首次安装

要求 Docker Engine、支持 `env_file.required` 的 Compose v2.24+（也支持 v5）。更新脚本另外需要 Linux bash、flock、awk；不依赖宿主机 Node。推荐在目标 Linux 架构原生构建；跨架构仿真不作为低内存验收。

```bash
cd deployment/docker
cp .env.example .env
printf 'RELEASE_TAG=local\n' > .release.env
# 编辑 .env，填写所有必需值；不要把密码作为 shell 命令参数。
chmod 600 .env
```

`RESOURCE_PROFILE` 与所选 override 保持一致。可创建可选的 `runtime.env` 放非秘密资源覆盖项，例如 `FILM_SCAN_MAX_PIXELS=12000000`、`CMS_HEAP_MIB=384`；环境文件不进 Git。Compose `.env` 用于插值，`runtime.env` 用于应用进程，二者作用不同。

```bash
# 在当前 shell 定义便捷命令；4GB 改用 compose.low-4gb.yaml。
dc() { docker compose --env-file .env --env-file .release.env -f compose.yaml -f compose.low-2gb.yaml "$@"; }
dc --profile setup config --quiet
# 串行构建；不要在 2GB 机器上并行 build 所有服务。
dc build cms
dc build api
dc build web
dc up -d --wait db
dc --profile setup run --rm bootstrap
dc up -d --wait cms
dc --profile setup run --rm schema
```

镜像构建只接收非秘密的网络地址、公开站点 origin、档位；不读取真实 `.env` 或连接 CMS。Web 使用 standalone；动态 CMS 数据首次访问时读取，继续按现有 TTL 缓存。API 镜像构建会验证 FFmpeg 编译能力，如果发行版软件包不满足 libplacebo/Dolby 条件则明确失败，不生成声称完整支持 HDR 的镜像。

先临时通过回环端口创建有限权限服务账号：

```bash
docker compose --env-file .env --env-file .release.env -f compose.yaml -f compose.low-2gb.yaml -f compose.admin-local.yaml up -d --no-deps cms
# 在本机访问 http://127.0.0.1:8055/admin；远程机器请使用 SSH 端口转发。
# 创建服务账号，填写 .env 的 SERVICE_EMAIL / SERVICE_PASSWORD。
dc up -d --force-recreate cms
# 上一步去掉临时端口映射；生产只通过 Nginx 对外提供服务。
dc up -d --wait api web nginx
```

默认入口 `http://localhost:8080`，仅 Nginx 发布端口。PostgreSQL、CMS、API 和 Web 使用服务 DNS，不把容器内地址交给浏览器。

### HTTPS 与 Vulkan

将 `.env` 的 `PUBLIC_URL` 设置为浏览器可访问的 HTTPS 完整 origin（含非标准端口），设置 `TLS_CERT_DIR`，目录内提供已有的 `fullchain.pem` 和 `privkey.pem`，再追加 `-f compose.https.yaml`。HTTP 重定向使用这个 origin；证书只读挂载，不会写入镜像，不自动申请。

有兼容 Mesa Vulkan 设备时，设置 `VULKAN_DEVICE` 和对应的数字 `RENDER_GID`，追加 `-f compose.vulkan.yaml`。只传入指定 render 设备，不使用 privileged。NVIDIA 驱动需单独准备匹配的容器运行时，不假定 Mesa override 对所有 GPU 有效。没有 GPU 的普通浏览、SDR/HLS copy 和胶片功能仍保留；HDR 自动 SDR 不保证可运行。

### 持久化、迁移和备份

命名卷分别保存 PostgreSQL、CMS uploads/extensions、公开媒体、私有胶片、API 临时文件和 About 内容。只有 API 挂载公开/私有媒体卷，Nginx 通过 API 读取公开媒体；大文件临时目录是磁盘卷，不是 tmpfs。About 卷首次从镜像复制默认示例，已有卷不会被新镜像覆盖。日志每个容器最多 3 个 10MB 文件。

从现有部署迁移时：停止写入，使用 `pg_dump -Fc` 导出数据库；新数据库使用 `pg_restore` 恢复，并复制 uploads、extensions、media、私有胶片原档和 About 自定义内容到对应卷，保留正确 UID/GID。不要直接把不同 PostgreSQL 大版本的数据目录挂到新容器。恢复数据库后沿用原 KEY/SECRET，确认服务账号、文件路径和 schema 版本；先在隔离环境验证再切入口。

日常数据库备份示例：

```bash
mkdir -p /secure/backup
dc exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > /secure/backup/video-blog.dump
```

同时备份媒体及 CMS 文件卷，保证记录和文件是同一时间点。普通 `dc down` 保留卷；**更新、停止和应用回滚均不使用 `down -v`**。恢复操作由管理员显式执行。

### Docker 更新与回滚

第一次启动成功后，为后续版本使用唯一标签：

```bash
# 必须在 Linux 上运行；使用同一 .env 和同一 Compose project name。
bash update.sh low-2gb release-2026-10-19-01
# 启用了可选配置时：
ENABLE_HTTPS=true ENABLE_VULKAN=true bash update.sh low-4gb release-2026-10-19-02
```

更新脚本要求当前 CMS/API/Web/Nginx 都运行，开启维护模式后检查媒体工作，再停应用，按 CMS→API→Web 串行构建。禁止复用已有镜像标签。失败时用原镜像 ID 恢复服务；成功后更新 `.release.env` 中的活动标签，并留下 `rollback-<新标签>.json` 和 `rollback-<新标签>.env`；这些本地状态文件不要提交。数据库继续运行，不自动执行 bootstrap/schema，不删除镜像或卷。

稍后回滚：开启维护并确认无活跃任务，使用与当前部署相同的 Compose 文件列表，最后追加 `-f rollback-<标签>.json`，执行 `up -d --no-build --pull never --wait cms api web nginx`，健康后将 `rollback-<标签>.env` 复制回 `.release.env`，再关闭维护，保证之后的普通 Compose 命令仍使用旧版本。镜像回滚不恢复外部 `.env`、Nginx 配置、证书或数据库；配置改变时也要恢复其配套备份。升级 Directus/schema 必须预先备份并单独执行迁移，不能仅靠旧镜像降级数据库。

Compose 资源上限默认总和约为 2GB 档 1632MiB、4GB 档 3264MiB，余量供系统和 Docker 使用。每个服务可通过 `<SERVICE>_MEM_LIMIT`、`<SERVICE>_CPUS` 覆盖；这些是运行限制，不限制 BuildKit 总内存。构建依赖单 worker、堆限制、串行执行和维护窗口，仍须测量。

## 维护与验证

`POST /maintenance` 使用上传 token，body 为 `{"enabled":true|false}`。开启后拒绝新写入，保留读取和任务取消；已经运行的任务继续收尾。`scripts/maintenance.cjs on`（更新脚本使用 `drain` 动作以拒绝旧版检查器）若发现仍有在途 API 写请求或媒体任务会返回非零，保持维护状态；稍后 `check`，或使用 `off` 恢复。更新脚本遇到这种失败会退出并关闭维护，需等待任务结束后重试。

```bash
# 原生：
API_ENV_FILE=/etc/video-blog/api.env node scripts/maintenance.cjs on
API_ENV_FILE=/etc/video-blog/api.env node scripts/maintenance.cjs check
API_ENV_FILE=/etc/video-blog/api.env node scripts/maintenance.cjs off
# Docker：
dc exec -T api node /app/scripts/maintenance.cjs check
```

`GET /health` 返回档位、有效限制、共享队列、视频队列、胶片工作状态、`activeWrites` 在途写请求计数和维护状态，不返回凭据。原生日志用 `journalctl -u video-blog-api` 等命令，容器用 `dc logs`。观察内存请使用 `systemd-cgtop` / `docker stats`、`free -m`、`vmstat` 和 OOM 日志，不能只看 V8 heap。

实现验证：

```bash
npm run test:resources
node --test apps/api/test/performance.test.cjs
npm run test:api
npm run test:web
RESOURCE_PROFILE=low-2gb CMS_RUNTIME_ONLY=true STANDALONE_BUILD=true npm run build:low-memory
```

Linux 上补充 `systemd-analyze verify`、`nginx -t`、两档 Compose config/build/up、初始化、重启恢复、持久化、CMS 登录、Range/HLS、HTTP→HTTPS，以及有设备时的真实 HDR 转换。每档使用至少 20 分钟浏览/媒体读取并发（例如 5 个浏览客户端）加一个代表性媒体任务，记录峰值 RSS、整机可用内存、CPU、任务时长、健康响应和 OOM 事件。测试负载下无 OOM、队列有界、任务结束资源释放、健康检查响应、原有媒体验证通过后才能认定该输入集适用。换成更大素材需重新验收。

### 本次实现的验证记录（2026-10-19）

- macOS / Node v24.13.0：`test:resources` 18/18 通过，包含实际 FFmpeg 线程参数、像素边界、共享队列、流式清理、两档 Compose 解析和 Docker 更新故障注入。
- 性能与胶片 mask 定向测试 20/20 通过；生产构建通过，日志显示 1 个 worker。构建使用不可达的 CMS 地址，CMS 页面仍正确产出为运行时路由。
- API 全量测试 108/137 通过，与原始版本对照的 29 个失败项一致：缺失的 IMF/video-source-format 模块及不可用的测试 FFmpeg 二进制等。前端 131 项测试通过，另一个测试文件因缺失 `video-format` 模块无法加载。
- JavaScript/shell 语法及 `git diff --check` 通过。官方镜像摘要和 Directus 的用户/入口已通过只读 registry 查询核对。
- Docker daemon 未启动，未执行镜像构建、容器初始化或持久化集成测试；本机缺少 systemd/Nginx 及具备 libplacebo 的 FFmpeg，未完成其运行验证、Vulkan 转换或 1核/2GB、2核/4GB 整机负载验收。上面的故障注入测试使用隔离 stub，不等同于容器实测。

### 资源受限的旧胶片任务

调整档位或 `FILM_SCAN_MAX_PIXELS` 后，旧任务可能超过新上限。这类任务保存为 `resource_blocked`，保留原档、来源记录和既有帧，不执行失败清理；即使保存状态暂时失败也保留原档。API 重启会重新检查一次，限制仍不足时保持阻塞，不循环重试。调高限制或迁移到有足够资源的机器后重启 API，即可继续分析；界面的“刷新状态”读取当前结果。只有显式取消或其他真正的处理失败沿用原来的清理行为。

该状态使用现有字符串字段，无数据库类型迁移。显式运行 `setup:cms-schema` / Compose `schema` 会为现有 Directus 状态选择器补充该选项并保留自定义选项。API 与 Web 应一起更新，避免旧界面无法显示这个新状态。

### 审查修复验证（2026-10-20）

- `test:resources` 28/28 通过，包括原档跨重启保留、CMS 状态写入失败时保留、放宽限制后的恢复、显式取消清理、文章上传及断开连接后的回滚计数、拒绝旧版维护检查器，以及原生构建读取真实环境文件覆盖值。
- 性能、胶片生命周期与 mask 定向测试 26/26 通过，低内存单 worker 生产构建通过。API 全量仍为 108/137；前端仍有 131 项通过和一个缺失模块的测试文件，未新增失败。
- 实际 FilmReview 组件的隔离浏览器页面验证了刷新成功/失败、等待时按钮禁用、键盘触发和 375px 窄屏排版；该页面使用模拟状态，不连接真实 CMS。临时页面及服务已清理。
- UI 静态审计仍报告 15 条既有表单/滚动条等问题，本次未扩大到无关界面整改。Docker、systemd 与真实低内存 Linux/Vulkan 验收限制仍同上。

### 与远端私有媒体更新兼容

Linux 和 Docker 的 `/media/` 统一经过 API 的规范路径、私有目录和符号链接检查，不再使用静态 alias。Docker API 的 `private-media` 卷保存 `/app/.private-media/film-scans`，需要随公开媒体和数据库一起备份。已有 Docker 安装若仍将扫描任务放在公开卷的 `film-scans/<任务编号>` 中，应先停写并备份，再将这些任务目录迁移到私有卷并确认文件完整；两个独立卷之间不能依赖自动 rename，跨卷迁移会让 API 启动失败。具体迁移边界见 [安全更新说明](deployment.md#security-update-rollout)，不要搬走同名视频项目的 source/SDR/HDR 目录。

### 合并远端更新验证（2026-10-20）

整合远端私有媒体保护和 IMF 功能后，Linux/Docker 保留 API 媒体权限检查、私有扫描存储迁移和有时效的健康探测缓存；镜像包含共享格式模块，IMF 的 x265 线程池也遵守低资源限制。资源与安全回归合计 47 项通过，前端 136 项通过，单 worker 生产构建通过。远端测试依赖 proper-lockfile 在本机隔离临时目录中补齐后运行，未修改锁文件。

本机旧 API 测试集合为 127/153 通过；余下失败包含缺失的 FFmpeg 测试二进制及旧 VM 测试夹具未注入新增运行上下文，不能据此宣称完整转码验收通过。此前的缺失视频格式模块已由远端更新补齐。Docker/Linux/Vulkan 实机验收仍未执行。
