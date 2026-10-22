# 全库安全与性能审查 — 2026-10-22

后续状态：修复实现、部署顺序和验证限制见 [2026-10-23 修复说明](security-remediation-2026-10-23.md)。下文保留原始审查基线与复现结果。

审查基线：`5e459b84a10ca485751043c4d82a85c144896e15`，`main`，开始时工作区无已跟踪文件改动。覆盖 208 个已跟踪文件的结构与入口，重点追踪 API、前端数据访问和媒体组件、Directus 配置/建模、管理面板、部署与维护脚本、依赖锁文件。对本机额外存在但被 Git 忽略的测试另行标注。

本次产出是审查报告和隔离验证材料，没有修改业务代码、升级依赖、连接生产数据库或部署服务。P1 表示优先处理，P2 表示应安排修复；第三方公告的 Critical/High 与这里的修复优先级分开表达。

## 结论与修复顺序

发现 **12 项需处理的问题：4 项 P1、8 项 P2**。先处理依赖安全更新、公开媒体流的断连清理和匿名统计写入，再处理资源查询放大、上传配额、超时与轮询。另有 4 项需要按数据规模或部署方式验证的优化/加固事项。

| 编号 | 优先级 | 问题 | 证据 |
| --- | --- | --- | --- |
| F01 | P1 | Next.js / Sharp 锁定在已披露高危版本 | 锁文件 + 官方公告 + 部署条件 |
| F02 | P1 | Directus 版本受匿名持久 DoS 影响，公开代理使入口可达 | 锁文件/镜像 + 官方公告 + 路由 |
| F03 | P1 | 媒体下载断连遗留文件描述符 | 实际文件流隔离复现 |
| F04 | P1 | 匿名统计无服务端去重/限流，写入和历史聚合可放大 | 实际处理函数 + 模拟 CMS 复现 |
| F05 | P2 | 单个资源权限判断放大为多次串行 CMS 查询 | 实际权限函数计数 |
| F06 | P2 | 旧视频上传绕过会话配额与接收并发限制 | 实际 multipart 解析器 + 调用链 |
| F07 | P2 | 视频取消发布不撤销已有媒体地址 | 媒体处理函数 + 发布调用链 |
| F08 | P2 | CMS 返回 403 时无效重新登录 | 实际请求函数复现 |
| F09 | P2 | Web CMS 登录与内容获取缺少应用级超时 | 静态调用链 |
| F10 | P2 | 胶片状态轮询在慢响应时重叠且不能取消在途请求 | 静态调用链 |
| F11 | P2 | 重要回归测试被 Git 忽略，干净检出无法复现本机检查 | Git 清单 + 实际测试结果 |
| F12 | P2 | Docker Web 构建缺少预览路由依赖的 API 源文件 | 构建上下文与 import 路径核对 |

## 详细发现

### F01 — P1：更新 Next.js 与图像解码依赖

位置：[Web 依赖声明](../apps/web/package.json)、[API 依赖声明](../apps/api/package.json)、[锁文件](../package-lock.json)、[Next 配置](../apps/web/next.config.mjs)。锁定版本为 Next.js **16.2.6**、Sharp **0.34.5**。

- 官方 [GHSA-p293-qw3h-jr36](https://github.com/vercel/next.js/security/advisories/GHSA-p293-qw3h-jr36) 将 `16.0.0 ≤ next < 16.3.3` 列为受影响版本，涉及 Windows 文件系统上的未认证远程代码执行。本仓库明确支持 Windows，采用 App Router，未启用 Cache Components，符合公告描述的部署条件。未在 Windows 或真实服务器执行漏洞利用。
- [Sharp 的 libheif 公告](https://github.com/lovell/sharp/security/advisories/GHSA-rgj7-g3m4-5g8c) 影响 `<0.35.4` 的不可信图像处理；[librsvg 公告](https://github.com/lovell/sharp/security/advisories/GHSA-wq5f-xc86-pv6w) 影响 `<0.35.5`，RCE 取决于 glibc Linux 等运行条件。本项目确实接收 AVIF 并提供图像变换，不能只根据文件扩展名或 magic bytes 排除解码器风险。SVG 在自有图片上传接口已被拒绝，因此不能将该接口描述成已验证的 SVG 利用入口。
- [Next.js 2026-10-14 官方更新](https://nextjs.org/blog/nextjs-security-update-october-14-2026) 给出 16.4.1 的安全基线，并要求配套修复 Sharp。该公告的 Server Actions / `use cache` 条件没有在本项目代码中找到；不把这些条件性公告算作本项目已证实的利用路径。

建议：在隔离分支升级并锁定已修复的 Next.js 和 Sharp，核对 Next、API、Directus 各自实际打包的解码库，完成 Windows/Linux、AVIF/HDR 与构建回归。更新声明而不更新锁文件不能修复 `npm ci` 部署。

### F02 — P1：Directus 的已知匿名 DoS 入口对外可达

位置：[CMS 依赖](../apps/cms/directus/package.json:11)、[Dockerfile](../deployment/docker/Dockerfile)、[共享 Nginx 路由](../deployment/nginx/blog-routes.conf:28)、[Next rewrites](../apps/web/next.config.mjs)。npm 锁文件与 Docker CMS 镜像均为 **11.17.4**。

[官方 GHSA-gwvv-rr68-cmv6](https://github.com/directus/directus/security/advisories/GHSA-gwvv-rr68-cmv6) 影响 `<12.2.0`，可通过匿名 items 请求的 `deep` 参数污染原型并使进程崩溃；解析发生在集合权限检查之前。仓库代理直接公开 `/items`，因此不需要先取得上传 token。这里的确认依据是版本与入口，不是对真实 CMS 的攻击测试。

另一个 [WebSocket 权限绕过公告](https://github.com/directus/directus/security/advisories/GHSA-97xr-jchp-xm3c) 影响 `<12.1.0`，但需启用 public WebSocket REST。仓库代理包含 `/websocket`，模板没有证明实际启用了 public 模式，所以这是条件性风险，不能宣称当前已能匿名修改数据。

建议：安排 Directus 跨主版本升级的兼容性验证，同时更新 npm 锁文件和 Docker 镜像摘要。升级前应限制不必公开的 CMS 管理/API 入口，并根据实际用途关闭 public WebSocket。仅收紧内容集合权限不能修复上述 DoS。

### F03 — P1：媒体下载断连后文件流没有关闭

位置：[server.cjs:8724](../apps/api/src/server.cjs:8724)。`handleMedia()` 只做 `stream.pipe(res)` 和源错误转发，没有在响应关闭时销毁源，也没有使用会联动清理的 `pipeline()`。

触发：客户端读取一部分大文件后断开，或视频拖动、切换产生请求取消。目标断开后 pipe 会停止输送，但源文件流停留在背压状态，描述符不自动释放。匿名重复请求可耗尽文件描述符，影响后续媒体、上传甚至普通文件操作。

隔离复现：真实 4 MiB 临时文件、真实 `fs.ReadStream`、模拟响应在首块关闭；**5 次断开后 5 个源流仍未销毁，文件描述符仍打开**。验证后显式清理这些源流。

建议：使用 `await pipeline(stream, res)`，妥善处理客户端提前关闭；或绑定响应关闭销毁源并清理监听。为 Range 和普通下载增加断连资源释放回归。

### F04 — P1：匿名统计接口允许持续写入和计算放大

位置：[server.cjs:7889](../apps/api/src/server.cjs:7889)、[聚合查询](../apps/api/src/server.cjs:7802)、[schema 中 analytics_events](../scripts/setup-directus-schema.cjs:965)、[前端去重](../apps/web/src/components/AnalyticsTracker.tsx)。

`POST /api/analytics/events` 没有服务端速率预算或去重。前端 sessionStorage 去重可被绕过；`visitorId` 由调用方自行提供，`X-Forwarded-For` 首项也不可信。每次请求以服务账号读取内容并插入事件，查询内容时没有发布状态检查。后台每轮仍对该条目的全部历史做 `count` / `countDistinct`；1 秒合并只限制聚合启动频率，不限制事件入库。schema 没有为 `analytics_events.item_key` 声明索引，也没有事件保留/清理策略。

隔离复现：同一匿名访客对模拟草稿条目连续提交 **20 次，全部 202，产生 20 次查询和 20 次事件插入**。未对真实数据库压测；表扫描的实际执行计划需在测试数据库用 EXPLAIN 验证。随着历史累积，聚合仍至少需要处理目标条目的历史，返回两行不意味着扫描成本恒定。

建议：在代理和应用两层加预算，服务端按时间窗去重，限制到公开条目并验证 master 所属项目；设置事件保留策略、合适索引，改为增量/分桶统计。匿名分析本身不需要改成管理员登录。

### F05 — P2：图片请求放大为 6–7 次以上 CMS 查询

位置：[asset-access.cjs:24](../apps/api/src/asset-access.cjs:24)、[server.cjs:8814](../apps/api/src/server.cjs:8814)。

每个资源请求依次检查站点设置、文章封面、文件描述、视频、相簿、照片及派生图。普通相簿照片可能需要 6 次权限查询再取字节，HLG 派生图需要 7 次。304 请求也会执行整条权限链。文章内联图还会对正文做 contains 搜索并分页取正文验证，数据量增长时成本更高。入口没有独立的请求预算或按资源合并在途授权查询。

隔离计数：随机合法 UUID 的未命中请求产生 **7 次串行 CMS 请求**。一屏 30 张相簿照片的约 180 次授权查询是根据代码路径计算的工作量，不是线上实测延迟。

建议：建立资源到所属内容的显式、可索引关联，合并同一资源的在途查询，增加有界负缓存和入口限流。必须保留取消发布后的撤销语义；不能简单设置长期 public 授权缓存来掩盖查询成本。

### F06 — P2：旧版整包上传绕过新版配额

位置：[server.cjs:524](../apps/api/src/server.cjs:524)、[server.cjs:8268](../apps/api/src/server.cjs:8268)、[video-upload-store.cjs](../apps/api/src/video-upload-store.cjs)。

新版会话有总量、并发会话、磁盘余量和保留时间限制；旧 `/uploads/videos` 仍可用，只在每个文件上应用 `MAX_UPLOAD_BYTES`，最多 500 文件，累积的 `uploadBytes` 没有用于拒绝总量。更关键的是，接收和落盘发生在处理槽申请之前，不受新版存储配额约束。即便 Nginx 单请求上限为 4 GiB，多次/并发请求仍可堆满临时磁盘；直连 API/Next 的边界与 Nginx 也不一致。

隔离复现：将单文件限制缩为 64 字节，实际解析器接受 3 个各 60 字节的包文件，总计 **180 字节**。这证明缺少总量限制，不是把单文件限制误当成已有总量契约。并发/配额绕过依据接收调用顺序与独立会话实现。需要有效上传 token，因此不归类为匿名攻击。

建议：为旧入口单独设置接收并发和共享磁盘预算、请求累计上限；或者完成兼容迁移后关闭旧入口。不要让缓慢网络接收长期占用转码槽。

### F07 — P2：取消发布不能收回已有视频文件地址

位置：[server.cjs:8669](../apps/api/src/server.cjs:8669)、[媒体缓存策略](../apps/api/src/server.cjs:8921)、[source 文件保存](../apps/api/src/server.cjs:1831)。

`handleMedia()` 只验证规范路径和私有胶片目录，没有查询项目 `published` 或母版状态。视频源档、HLS 和 package 保存在 MEDIA_ROOT。知道地址的人在项目取消发布后仍可读取；普通媒体还会得到一周公开缓存及额外 stale 窗口。

隔离复现：只在临时 MEDIA_ROOT 放入文件，无任何 CMS 记录或凭证，HEAD 返回 **200**。其与取消发布的关系由路由完全没有 CMS 状态检查确认。本报告没有宣称可枚举随机 UUID；以前拿到链接的人无需枚举。

如果产品的“草稿/取消发布”只表示从目录隐藏，应明确这是 unlisted 语义；若希望其提供隐私，需加入发布/所有权校验，并将原档移入私有存储、使用受控下载或签名地址。已被客户端下载的内容无法通过撤销追回。

### F08 — P2：403 触发无效登录并放大认证压力

位置：[server.cjs:3525](../apps/api/src/server.cjs:3525)、[资产获取重试](../apps/api/src/server.cjs:8755)。

`directusRequest()` 将 401 和 403 一并处理为 token 失效：作废缓存、重新登录、重复原请求。最小权限服务账号遇到无权访问的集合时，新的 token 仍然没有权限。`canReadAsset()` 又主动容忍各集合的 403，所以图片权限链中会自然发生这种情况。

隔离复现：模拟 CMS 对一个请求返回 403，实际请求函数产生 **2 次相同请求 + 1 次重新登录**。它会影响其他并发请求共用的 token 缓存，可能导致登录限额耗尽和额外排队。

建议：只有证据表明 token 过期/无效时刷新，一般 403 直接交给调用者处理；对文件上传与资源读取保持一致的错误分类。

### F09 — P2：Web CMS 请求缺少截止时间

位置：[directus.ts:229](../apps/web/src/lib/directus.ts:229)、[directus.ts:285](../apps/web/src/lib/directus.ts:285)、[RootLayout](../apps/web/src/app/layout.tsx:36)。

普通内容 fetch 与登录没有 AbortSignal。共享 `pendingToken` 会使所有首次请求等待同一个未完成登录；RootLayout 又等待站点设置，能将 CMS 卡顿传播到全站。预览资源 fetch 虽有 10 秒超时，但其前置 `getToken()` 登录仍不受这个期限保护。Next/底层 HTTP 最终可能超时，但应用没有符合交互预算的截止时间。

建议：为登录与内容获取分别设置短且可配置的超时，传播取消信号，定义 CMS 不可用时的展示策略，并测试“连接已建立但不返回”的故障。这里只确认缺少应用级边界，没有编造线上阻塞时长。

### F10 — P2：胶片状态轮询重叠

位置：[FilmScanImport.tsx:146](../apps/web/src/components/FilmScanImport.tsx:146)、[album-management.ts:121](../apps/web/src/lib/album-management.ts:121)、[server.cjs:6322](../apps/api/src/server.cjs:6322)。

`setInterval(async …, 1400)` 不等待前一请求完成，albumApiRequest 默认无超时。响应慢于 1.4 秒时会持续增加在途请求；effect 清理只清定时器，不取消已发出的请求，也没有防止旧响应覆盖新状态。每次状态查询还读取 job、sources、frames，后两者使用全量列表，后台任务繁忙时压力反而增加。

建议：改为请求完成后再安排下一轮，绑定 AbortController 与请求序号，后台标签页退避；将进度查询与完整帧列表查询分开。静态确认，未执行浏览器压力测试。

### F11 — P2：本机回归检查无法在干净检出复现

位置：[.gitignore:16](../.gitignore:16)、[根测试脚本](../package.json)、[测试夹具](../tests/review-regressions.test.cjs:137)。

`.gitignore` 排除所有前端 `*.test.*`、`*.spec.*` 和 `scripts/test-*`。本机运行通过的 14 个前端测试文件并没有被 Git 跟踪；API 测试仅有两个显式例外被跟踪。README/package.json 引用的多个 `scripts/test-*` 也不在跟踪清单中。这会使安全更新与性能回归依赖开发者机器残留文件，而不是版本库中可复现的检查。

已跟踪测试当前还有一个夹具失败：模拟 request 没有 `setTimeout()` / `once()`，新增 dispatch 逻辑在计数前抛错。仅在内存补齐这两个方法后，原 `review-regressions` 套件 7/7 通过；未修改生产逻辑或提交测试修复，不把这个失败误报为实际维护计数漏洞。

建议：将测试与非秘密夹具纳入版本库，把发布体积排除留给 `.dockerignore`/打包配置；修复失真的 HTTP 夹具，并在干净检出上执行 CI。

### F12 — P2：Docker Web 构建缺少跨 workspace 依赖

位置：[Dockerfile:14](../deployment/docker/Dockerfile:14)、[预览路由](../apps/web/src/app/internal/preview/assets/[id]/route.ts:3)。

Web 构建阶段复制 `config`、`shared`、`apps/web` 和 launcher，但预览路由静态导入了 `apps/api/src/asset-access.cjs` 与 `media-security.cjs`。这两个模块在该构建阶段不存在，后面的 api stage COPY 不能补全前面的 web-build stage；`DIRECTUS_SHOW_DRAFTS` 为 false 也不会消除静态模块解析需求。

建议：显式复制这两个受控模块，或将跨服务复用代码移入已复制的 shared 目录，再验证完整镜像构建。这是源文件与路径核对确认的构建缺口；本次未执行 Docker build，不能声称已有容器构建日志。

## 额外优化与部署检查

以下不计入上述 12 项，适合通过实际数据规模/运行环境进一步验证：

1. **胶片预览重复处理完整分辨率。** `server.cjs:6377–6444` 先生成 raw/density 两个全尺寸 TIFF 并运行 FFmpeg，然后才在 `renderFilmFrame()` 使用 maximumDimension 缩小。颜色负片每次调整都会重复这一过程。建议缓存与源文件/裁切/mask 绑定的中间结果，或验证颜色一致性后使用独立低分辨率预览流程，最终导出保留全精度。未做实际胶片延迟/RSS 基准。
2. **相簿列表过度读取关系。** `directus.ts:178` 获取相簿内照片列表来计算数量；`server.cjs:4321` 的管理列表使用 `limit=-1` 并展开完整照片/派生字段。建议列表改用聚合数量和代表封面，按需分页加载选中相簿。嵌套关系还依赖 Directus 默认 limit，需同时验证大相簿是否被截断。
3. **离线迁移逐表全量读入。** `migrate-directus-sqlite-to-postgres.cjs:194–212` 在插入分批前已经通过 sqliteAll 取完整表。历史 analytics 数据大时，低内存主机可能 OOM。建议按主键/keyset 流式迁移，保留事务与校验。没有连接实际数据库或执行迁移。
4. **公开 health 的诊断信息与可选 CMS 暴露。** `/api/health` 返回绝对媒体路径、工具路径和内部 CMS URL；可将公开健康检查缩为状态，把详细诊断置于鉴权后。`/assets`、`/uploads` 是原生 CMS 代理，不经过自有 canReadAsset；实际是否泄漏取决于部署中的 Directus public 文件权限，本次未读取真实权限，不能认定已发生绕过。

## 已验证的保护与未成立的怀疑

- 私有胶片路径迁移、规范路径/符号链接检查、图片归属判断、管理会话/CSRF、资源队列等已有隔离回归通过。它们不能抵消上面的独立入口问题，但无需在修复时整体重写。
- 管理面板命令使用固定动作清单与 PowerShell 参数转义，文件日志只读取末尾；本次没有得到可成立的未认证命令注入证据。
- Markdown 默认安全 URL 处理、图片上传格式限制、预览 token 固定同源目标已有明确保护；未把未使用的危险 API 当成 XSS 证据。
- HLS 网络访问怀疑做了本机回环验证，当前 FFprobe 用 `file,crypto,data` 白名单拒绝 HTTP，监听器收到 0 次请求。DASH 样例被识别为无效输入，属于验证不充分。**没有将任意 FFmpeg SSRF 作为已确认发现**；不同部署二进制仍应单独验证。
- 204 个已跟踪文本文件的私钥头、GitHub token、AWS access-key 特征扫描未命中。它不是高熵秘密扫描，也没有审计 Git 历史，因此不能得出“仓库历史没有任何秘密”的结论。

## 检查结果与材料

环境：macOS，Node 24.13.0，npm 11.6.2。媒体重跑使用 `/opt/homebrew/bin/ffmpeg` 与 `/opt/homebrew/bin/ffprobe`；并不等于已验证部署使用的 Node 22/Windows/Linux 二进制。

| 检查 | 结果 |
| --- | --- |
| 已跟踪 Node 测试，11 个文件 | **90/91 通过**；1 个失真 request 夹具失败 |
| 本机全部 Node 测试，含被忽略的额外测试 | 系统 FFmpeg 重跑 **210/224 通过**；13 个涉及 Vulkan/libplacebo 能力不可用，另 1 个为上述夹具 |
| 夹具诊断，仅在内存补齐模拟 HTTP 方法 | 原 regression 套件 **7/7 通过** |
| Web Vitest，本机存在的 14 个文件 | **136/136 通过**；这些文件不在 Git 跟踪清单中 |
| TypeScript `--noEmit --incremental false` | 通过 |
| API / Manager `node --check`、维护脚本 `bash -n` | 通过 |
| 本报告隔离复现 | 6 组观察符合断言，结果保存在 JSON |
| `npm audit --omit=dev --ignore-scripts --json` | 成功查询并因发现问题返回非零；128 个受影响包条目：8 critical / 49 high / 60 moderate / 11 low |

npm 的数量包含依赖链传播与不同利用前提，**不是 128 个独立、可直接利用的站点漏洞**。扫描输出还未覆盖本报告从官方页面补充核对的所有最新公告，因此不能以一次 audit 结果代替可达性分析。

材料位于 `test-results/security-performance-audit-2026-10-22/`（按现有规则不提交 Git）：

- `reproduce.cjs`、`reproduction-results.json`、`reproduction.log`：六组隔离复现。
- `npm-audit.json`、`dependency-summary.json`：锁定依赖审计和公告索引。
- `tracked-tests.log`：版本库可提供的 Node 测试结果。
- `node-tests.log`、`node-tests-unsandboxed.log`、`node-tests-system-ffmpeg.log`：初次沙箱限制、静态二进制缺失、系统 FFmpeg 重跑的完整记录。
- `maintenance-fixture-diagnosis.log`、`web-tests.log`、`typecheck.log`：专项诊断、前端测试和类型检查记录。
- `probe-network.cjs`、`probe-network-results.json`、`probe-network.log`：仅回环网络目标的媒体探测记录。
- `secret-signature-scan.json`：扫描范围与不含秘密内容的摘要。

未执行浏览器交互/视觉测试、生产压测、真实 CMS 权限检查、Windows/Linux 宿主机验证、Docker 完整构建或数据库 EXPLAIN；没有启动 Chrome 或使用个人浏览器配置。本次确认的是代码、锁定版本和隔离复现结果，性能优化效果仍需修复后在目标环境测量。
