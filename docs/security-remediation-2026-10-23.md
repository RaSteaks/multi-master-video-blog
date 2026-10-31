# 安全与性能修复：部署和验证

对应 [2026-10-22 审查](security-performance-audit-2026-10-22.md)。业务代码和部署文件已修复，生产环境尚未部署或迁移。

## 已单独推送的 Next.js 更新

提交 `3a54df1c4aa269a25eb5be727e1482bdaaeb9201` 已推送到 `origin/main`：Next.js 固定为 16.4.1，其图像解码依赖为 Sharp 0.35.5。已通过生产构建和 136 项 Web 测试。

仅部署这笔提交：安装更新后的 Web 依赖、重新构建并重启 **Web**。Windows 生产环境使用 `npm run web:rebuild-restart`；Linux 重启 `video-blog-web`；Docker 重建并替换 `web` 容器。其他服务无需因这笔独立提交重启。

## 后续修复范围

| 审查项 | 实现 |
| --- | --- |
| F01 | API Sharp 更新为 0.35.5；有补丁的传递依赖使用明确的 npm overrides，锁文件已重新解析验证 |
| F02 | Directus 12.5.0；bootstrap 在监听前撤销应用集合的匿名 CMS 授权，CMS 启动会拒绝遗留授权；在线 schema 更新同步清理权限缓存 |
| F03 | 媒体流改用 pipeline，完整下载与 Range 请求断开都会关闭源描述符 |
| F04 | 入口速率预算、持久去重、仅允许公开内容/所属已验证母版、游标增量计数、数据库索引及非破坏性容量上限 |
| F05 | 资源归属提示和文章主键定位减少重复查询，正文按单条有界读取并共享在途快照，合并在途请求、限制并发与速率，短暂缓存拒绝；允许结果始终重新检查当前发布状态 |
| F06 | 旧 multipart 在接收前申请独立槽位，与可恢复上传共享磁盘/会话配额，增加请求累计字节与 part 数量限制 |
| F07 | 视频内容和源文件必须有当前公开且 ready/verified 的 CMS 所有者；条件请求先鉴权；取消长期公开缓存 |
| F08 | 只有 401 刷新 CMS token，403 直接报告权限拒绝；健康探测也复用并合并登录 |
| F09 | Web 登录/内容请求有截止时间；释放失败响应；启动等待遵循 Next 的环境文件优先级 |
| F10 | 胶片轮询完成后才安排下一次，支持取消、后台退避；进度与完整帧列表分离 |
| F11 | 测试与非秘密夹具进入版本控制范围；修复失真的 HTTP 模拟对象；声明 Playwright 开发依赖，浏览器测试使用 headless WebKit/Firefox |
| F12 | Web 构建复制共享安全模块；API 明确声明 proper-lockfile；CMS 从同一审计锁文件构建，避免官方镜像绕过 overrides |

额外优化也已处理：胶片私有 density 预览缓存每任务最多一个、最多 64 MiB，导出不使用缓存；相簿列表仅取摘要/聚合数量，详情按选中相簿分页读取；SQLite 迁移在一致读快照内按主键分批；公开 API health 仅返回状态，详细诊断需要上传 token。

## 必须先了解的兼容变化

### Directus 12 的权限与健康检查

Directus 12 Core 不保证自定义行权限规则生效，见 [官方 v12 说明](https://github.com/directus/directus/releases/tag/v12.0.0)。本项目改为：**CMS 不匿名公开应用集合/文件，公开访问由 Web/API 的发布状态检查控制**。不需要为这条安全边界激活商业许可，也不会自动替用户申请、购买或激活许可。

`config/private-cms-collections.json` 是封锁清单；只撤销无 user、无 role 的匿名策略对这些集合的授权，服务账号和其他集合的策略保留。bootstrap 的封锁在 CMS 启动前进行，避免升级后、执行在线 schema 前出现曝光窗口。若仍有遗留授权，CMS 启动失败并提示先迁移。

Web/API 必须配置有效的 `DIRECTUS_EMAIL` / `DIRECTUS_PASSWORD`，不能再依赖匿名 CMS 读取。服务账号应具备项目所需集合权限，并包含新字段：`analytics_events.dedupe_key`、`analytics_events.first_visitor`、`analytics_items.last_event_id`。API 会在打开监听前校验新统计字段可读，防止部分升级被误报为就绪。

Directus 12 `/server/health` 需要认证。启动器、Manager、CLI 和容器健康检查均改为使用 `scripts/directus-health.cjs`，仍检查真实的数据库/存储健康结果，403 不算成功。优先使用 `DIRECTUS_HEALTH_EMAIL` / `DIRECTUS_HEALTH_PASSWORD`；否则使用服务账号或 CMS 的 bootstrap 管理员账号。Docker 对应可选 `CMS_HEALTH_EMAIL` / `CMS_HEALTH_PASSWORD`。账号密码更改后需要同步运行环境。

CMS 使用 **Node 22 LTS，22.12.0 及以上的 22.x**；验证版本为 22.23.1。启动器为 isolated-vm 加上 `--no-node-snapshot`。Docker 安装所需原生构建工具，并将 isolated-vm / SQLite 的编译并发限制为 1。

### 内容、统计与缓存

- `/media` 的视频路径须匹配已公开项目的 ready/verified 母版 HLS 目录或精确源文件 URL。其他包文件不会随目录被匿名公开。已发布文章引用的被动图片/3DGS 文件保留支持。脱离 CMS 的本地品牌素材需在 `PUBLIC_MEDIA_FILES` 明确列出相对路径；不要用通配符开放目录。
- 同一内容、事件、母版、访客在同一 30 分钟窗口内仅记录一次。前端自行生成 visitor ID 不能绕过服务端预算。可信 Nginx 必须覆盖 `X-Real-IP`；仅在 API 不被公网直连时设置 `TRUST_PROXY=true`，不信任客户端的 `X-Forwarded-For`。
- 历史统计总数保留。升级时对旧统计做一次核对且不降低已保留总数；新计数按 `last_event_id` 增量推进，CMS 写失败后可继续补齐，不再反复扫描整条历史。默认 `ANALYTICS_MAX_EVENTS=1000000`；容量用短时缓存计数和在途保守预留控制，存在有界的并发余量。达到上限后暂停新增事件并返回 503，**不会自动删除旧记录**。扩容或制定归档方案后再恢复采集。
- 资源授权的正向结果不做长期缓存，因此取消发布会立即阻止新的资源/304 请求。短暂负缓存可能让刚重新公开的图片延迟约 2 秒恢复；升级时应清理旧 CDN 缓存；已被用户下载或缓存的文件无法追回。
- 相簿管理列表现在是分页摘要，`GET /albums/:id/manage` 获取选中相簿详情。前端和集成脚本已同步；第三方客户端应相应调整。

## 部署顺序

以下是需要在部署环境执行的操作，本次开发没有执行这些生产动作。跨 Directus 主版本升级前，备份数据库、uploads、媒体和当前发布版本；数据库迁移后的回滚不能只换回旧镜像，必须恢复匹配的数据库备份。

1. 在维护窗口进入 API drain，确认在途写入/媒体工作结束，停止 **Web、API、CMS**。保留 PostgreSQL。首次跨版本更新不要只运行仅更新 API/Web 的 Manager “Update application”。
2. 用 Node 22 安装新锁文件依赖。原生安装执行 `npm ci`，让必要的原生模块完成安装；不要直接以 `--ignore-scripts` 作为完整生产安装。Docker 重建 CMS/API/Web；构建阶段已经显式处理原生绑定。
3. 在 CMS 停止时执行 `npm run bootstrap:cms`（Linux launcher 使用相同 cms/resources 环境文件；Docker 使用 setup profile 的 bootstrap）。它升级 Directus 系统 schema，并封锁遗留匿名应用授权。
4. 启动 **CMS**，执行 `npm run setup:cms-schema` / Docker schema 服务；检查服务账号对新增统计字段的权限。该步骤新增字段、索引并同步匿名权限撤销。
5. 使用正确环境重新构建 **Web**，再启动 **API、Web**。API 新 schema 校验、CMS 认证健康检查和 Web 页面均应成功。
6. 安装此次 Nginx 配置，先验证配置再 **reload Nginx**。新增的 `blog_analytics` limit_req_zone 位于 http context，不能只复制 server-context 的 routes 文件而漏掉 zone。
7. 若运行 Windows Manager，**重启 Manager** 以加载新的认证健康探测；重新登录。最后验证公开页面、受保护文件、取消发布撤销和上传恢复。

因此，后续整批修复的服务范围是：**CMS、API、Web 重启，Manager（若使用）重启，Nginx reload；PostgreSQL 无需因代码修复重启**。数据库 schema 更新仍然必需。维护完成后按正常流程关闭 maintenance。

## 验证证据

产物位于 `test-results/security-remediation-2026-10-22/`，按仓库规则本地保留，不提交截图、日志和运行时数据。

- `security-final.log`：56 项专项检查通过，包括文件描述符关闭、即时撤销、归属提示、统计重放/失败恢复、共享配额、预览缓存、SQLite 主键分页、认证健康探测和 bootstrap 权限封锁。
- `web-tests-final.log`：136 项前端测试通过。
- `cms-integration/report.json`：真实 Directus 12 + API + 临时 SQLite 的 6 项集成场景通过；使用实际部署启动器，无生产凭证或数据。
- `browser/report.json`：headless WebKit 的 5 组场景通过，无 page error；覆盖摘要/详情、失败重试、加载中防重复、390px 布局、Escape 和慢速轮询。内置浏览器也检查了管理流程。
- `browser/*.png`、`browser/trace.zip`：截图及交互轨迹。
- `build-final.log`：Node 22 的 production standalone 构建通过；`typecheck-1.log` 等保留类型检查记录。
- `static-media-tests.log`：使用项目内静态媒体工具补验的 10 项检查通过，包括真实编码/探测、16-bit 负片像素一致性和 PNG 位深。未改动全局 Homebrew 安装。
- `manager-tests-final.log`：27 项通过、7 项 Windows 专属检查在 macOS 明确跳过。
- `all-tests-static-final.log`：静态工具的一轮完整回归 238 项中 223 项通过，15 个高级媒体检查因工具缺少 Vulkan/libplacebo、RGB JPEG 2000 或 Dolby Vision 探测能力而未通过。后续新增检查单独纳入上述 56 项专项回归。
- `all-tests-final.log`：系统工具的一轮完整回归 236 项中 213 项通过；23 项被缺失的 `libbluray.2.dylib` 阻断。没有改写媒体断言来制造通过结果。

本机 Docker daemon、Nginx CLI 不可用，因此没有宣称实际容器构建或 `nginx -t` 已通过。已验证 Compose 配置、构建源依赖和原生 standalone 构建。PostgreSQL 实机迁移/执行计划和 Windows 服务实机验证仍需在目标环境执行。

UI 静态规范审计保留在 `ui-audit.json`，与 `ui-audit-baseline.json` 一致，保留 15 项既有表单/native validation、textarea 和 scrollbar 等设计规范提示；本次没有将其当作安全检查通过的证据，也没有为满足通用设计规则而进行无关全站重设计。

## 剩余上游公告

生产依赖审计从 **128 个包条目（8 critical）降至 7 个包条目（0 critical）**，对应两项尚无官方修复版本的公告及依赖链传播：

- [braces 深层模式栈耗尽](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)：来自 PM2 的 chokidar 3。项目用 Directus start + systemd/独立启动器，不启用 PM2 watcher；没有发现将远程模式字符串传给它的路径。
- [sprintf-js 不受限精度参数](https://github.com/advisories/GHSA-hp3w-g68c-fv3c)：来自可选 SQL Server 驱动 tedious。项目支持 PostgreSQL/SQLite；已检查的 tedious 调用使用固定格式字符串，不将数据当格式字符串。

这说明当前已检查路径缺少公告所需的输入条件，**不代表上游代码已经打补丁或审计清零**。保留 `npm-audit-final.json`，后续上游发布补丁后应更新并复测。没有降级 Directus、伪造版本或禁用安全审计来隐藏告警。

## 复现命令

在 Node 22 和完整依赖安装下运行：

```sh
npm run test:web
node --test tests/security-remediation.test.cjs tests/security.test.cjs tests/resources.test.cjs tests/review-regressions.test.cjs
npm run test:cms-security
CMS_RUNTIME_ONLY=true npm run build:web
```

浏览器验证需要 Playwright WebKit：先 `npx playwright install webkit`，在一个终端运行 `HOLD_FIXTURE=1 npm run test:cms-security`，待显示 fixture ready 后在另一个终端运行 `npm run test:security-browser`；最后结束 fixture，测试会清理临时进程/数据库。也可通过 `PLAYWRIGHT_MODULE` 与 `WEBKIT_EXECUTABLE_PATH` 指定已经安装的测试运行库和 WebKit。不会连接个人浏览器配置或启动 Chrome。
