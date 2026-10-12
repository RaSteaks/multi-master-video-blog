# 页面切换与渲染性能优化施工方案

> 本文是可执行的性能优化方案，不是单纯的改动清单。施工顺序以“先测量、再改动、可回滚”为原则。
>
> 适用范围：`apps/web` Next.js 16.2.6 / React 19 前台、Directus 数据读取、Node 资产代理和 Windows Nginx 生产部署。

## 0. 结论与边界

当前最值得保留的方向有三条：

1. 为 Directus 只读请求启用短时 Data Cache，减少重复 CMS 往返。
2. 让导航入场动画只在真正较慢的导航上出现，避免动画成为固定的感知延迟。
3. 以 tags + webhook 做长期按需失效，再把缓存时间从几十秒提高到小时级。

需要纠正的方向：

- 列表图片的尺寸、懒加载和首图优先级已经大部分实现，不应再把“所有图片缺尺寸”作为主任务。
- 当前资产代理只允许受管的 `key` preset，不能直接添加 `blur=` 参数。
- 生产环境的 `/api/` 由 Nginx 转发到 Node API 8060，不会自动进入 Next Route Handler。
- Data Cache、Full Route Cache、浏览器资产缓存是三个不同层次，不能用一个“ISR 已开启”概括全部效果。

本方案不会强行把 CMS 页面改成全静态页面，也不会为了追求缓存而暴露草稿或牺牲内容更新可靠性。

## 1. 当前代码基线

### 1.1 数据请求

`apps/web/src/lib/directus.ts` 已有统一的 `directusFetch()`：

```ts
const cacheOptions =
  REVALIDATE_SECONDS > 0
    ? { next: { revalidate: REVALIDATE_SECONDS } }
    : { cache: "no-store" as const };
```

当前行为：

- `DIRECTUS_REVALIDATE=0` 时，业务 Directus GET 请求不进入 Next Data Cache。
- `DIRECTUS_REVALIDATE>0` 时，业务 GET 请求使用 `next.revalidate`。
- Directus 登录请求必须继续使用 `cache: "no-store"`，不能缓存 access token 响应。
- 未显式设置环境变量时，生产代码默认使用 30 秒，开发环境默认使用 0 秒。
- 首页的文章、视频和相簿数量已经在 `getCounts()` 内部使用 `Promise.all()`，不应重复改成串行请求。

### 1.2 路由缓存边界

以下情况必须按动态页面处理：

- `/about` 显式声明了 `dynamic = "force-dynamic"` 和 `revalidate = 0`。
- `/albums` 读取页面 `searchParams`，需要根据查询参数控制上传对话框。
- 动态 slug 页面没有可直接假设的构建期完整路径集合。

启用 Data Cache 后，页面中的 Directus 数据可以复用，但不代表所有页面都会进入 Full Route Cache。共享 Root Layout 也不会因为每次客户端导航都必然重新执行；`getSiteSettings()` 主要影响首次请求、硬刷新和实际发生服务端渲染的场景。

### 1.3 图片现状

当前以下图片已经声明了尺寸和加载策略：

- 首页头像：`apps/web/src/app/page.tsx`
- 文章列表、视频列表、相簿列表卡片：对应列表 `page.tsx`
- 文章详情封面与目录封面：`apps/web/src/app/posts/[slug]/page.tsx`
- 相簿画廊缩略图：`apps/web/src/components/AlbumGallery.tsx`

列表卡片 CSS 也已经使用固定 `aspect-ratio`。因此不能继续按“全量补 width/height”的假设施工。

仍值得检查的对象：

- About 页面封面使用未经过 preset 的资产，且 `.about-cover` 取消了通用 hero 的固定比例。
- Markdown 正文图片由 ReactMarkdown 默认渲染，通常没有服务端尺寸信息，可能在图片到达时产生 CLS。
- 编辑器中的本地预览图片不属于公开页面首屏，不应混入首要优化指标。

### 1.4 视觉合成与资产代理

当前实际选择器是：

```css
.site-header {
  backdrop-filter: blur(48px) saturate(200%) brightness(1.06);
}

.site-bg {
  filter: blur(var(--user-bg-blur, var(--site-bg-blur, 8px)));
}
```

当前不存在 `.site-header.elevated` 这个选择器。资产代理 `apps/api/src/server.cjs` 只接受受管 preset 的 `key` 参数，并拒绝其它查询参数。因此以下 URL 不能直接采用：

```text
/api/assets/<id>?key=site-background&blur=14
```

### 1.5 导航转场

`PageTransition` 当前通过：

- `usePathname()` 判断页面分区；
- `key={pathname}` 重新挂载页面表面；
- 全局 click 监听设置 `route-transition-pending`；
- CSS 对白名单页面统一播放入场动画。

当前动画与“导航实际耗时”无关，因此快速导航也会播放约 220ms 的主动画和级联延迟。

### 1.6 生产路由

生产 Nginx 当前约定：

- `/` → Next 3000
- `/api/` → Node API 8060
- `/admin/` → Directus 8055
- `/media/` → 本地媒体目录

因此不能默认把 Next 的 `/api/revalidate` 当作生产可达的失效入口。

## 2. 目标、非目标和验收口径

### 2.1 目标

以下是建议的相对目标，必须先记录基线，再根据真实数据确认：

| 指标 | 目标 |
|---|---|
| 热路径服务端 TTFB | 相比当前基线下降 20% 以上，或 Directus 等待不再占主要比例 |
| 同一进程内重复 Directus GET | 缓存有效期内不重复访问源站 |
| 首屏 CLS | 不因本次改动恶化；公开页面目标不高于 0.1 |
| LCP | 不因动画、背景图或缓存改动恶化 |
| INP / 长任务 | 不引入新的长任务；滚动时主线程保持可交互 |
| 导航体验 | 快速导航不被固定入场动画阻塞，慢导航仍有明确反馈 |
| 内容更新 | 短缓存模式最多滞后 30 秒；webhook 模式以成功失效为前提达到秒级 |

### 2.2 必须记录的指标

不能只看 FPS。每轮测试至少记录：

- Directus 请求数量、单次耗时和是否命中缓存；
- 浏览器导航的 RSC 请求 TTFB、响应大小和请求数量；
- LCP、CLS、INP、长任务、首次绘制和图片字节数；
- 低性能设备或 CPU 限制下的滚动长任务和合成帧率；
- 内容发布后旧数据持续时间；
- 失败请求、401 重试、资产 4xx/5xx。

## 3. 阶段 0：建立基线

### 3.1 环境

分别测试：

1. `npm run dev:web`：验证开发体验，不把开发缓存误当成生产缓存。
2. `next build` + `next start`：验证生产数据缓存和路由行为。
3. 真实 Nginx 域名路径：验证 `/api/`、资产和 webhook 路由。

开发环境建议保持：

```dotenv
DIRECTUS_REVALIDATE=0
DIRECTUS_SHOW_DRAFTS=true
```

生产环境建议使用单独的未提交环境文件或服务进程环境：

```dotenv
DIRECTUS_REVALIDATE=30
DIRECTUS_SHOW_DRAFTS=false
```

不要为了生产性能直接把开发用的 `apps/web/.env.local` 改成 30 秒；这会让本地内容编辑出现等待旧数据的错觉。生产服务可使用 `.env.production.local`、Windows 服务环境变量或部署脚本注入值。

### 3.2 路由矩阵

至少录制以下路径的冷启动、硬刷新、客户端导航和重复访问：

```text
/
/posts
/posts/<slug>
/videos
/videos/<slug>
/albums
/albums?dialog=upload
/about
```

每条路径分别记录：

- 首次 Directus 请求数量和总耗时；
- 第二次请求是否仍访问 Directus；
- 页面是否为动态渲染；
- 关键图片是否在布局计算前有尺寸；
- 导航是否出现不必要的进度条或入场动画。

### 3.3 基线交付物

施工前保存：

- Chrome Performance trace：桌面、移动模拟各一份；
- Network HAR 或关键请求截图；
- `npm run build:web` 输出；
- Directus 和 Node API 日志片段；
- 当前生产环境变量的非敏感配置清单。

没有基线时，不得把“速度质变”“主要瓶颈”等结论写成验收结果。

## 4. 阶段 1：启用 Directus Data Cache

优先级：P0。风险：中。回滚：把生产 `DIRECTUS_REVALIDATE` 改回 0 并重启 Web 服务。

### 4.1 施工内容

原则上不重写 `directusFetch()`，先只调整生产配置：

```dotenv
DIRECTUS_REVALIDATE=30
DIRECTUS_SHOW_DRAFTS=false
```

检查项：

- Directus 使用只读服务账号；
- 生产账号不能读取草稿；
- `DIRECTUS_URL`、账号和密码只存在服务端环境；
- `DIRECTUS_REVALIDATE` 不进入 `NEXT_PUBLIC_*`；
- 修改环境后重启 Web 服务，避免旧进程继续使用 0。

### 4.2 数据缓存的正确预期

启用 `next.revalidate` 后，Directus GET 响应进入 Next Data Cache；它能减少源站往返，但不自动改变所有页面的动态/静态分类。不要为了让构建输出显示为静态而删除 `/about` 的动态语义或强行缓存带查询参数的页面。

Next 官方文档说明了 `next.revalidate`、Data Cache 和 `next.tags` 的区别：

- https://nextjs.org/docs/app/api-reference/functions/fetch
- https://nextjs.org/docs/app/guides/caching-without-cache-components

### 4.3 生产验证

用相同路径连续访问两次：

1. 第一次允许 Directus 请求发生；
2. 第二次观察 Directus 日志和 Web 端 TTFB；
3. 修改一条测试内容；
4. 确认最多在 30 秒内出现新内容；
5. 确认草稿不会因为缓存出现在公开页面。

如果缓存没有命中，优先检查：

- 进程是否仍读取 `DIRECTUS_REVALIDATE=0`；
- 是否在开发服务器而不是生产服务器测试；
- 是否有动态路由/请求 API 导致整页动态；
- Directus 请求 URL 或请求选项是否每次变化；
- 401 重试是否造成新的请求键。

## 5. 阶段 2：补齐真正的布局稳定性

优先级：P1。风险：低到中。回滚：保留现有 preset 和 CSS aspect-ratio。

### 5.1 不做全量 Directus 尺寸查询

列表卡片使用 `content-card`、`content-hero`、`album-cover` 等 preset，输出比例和尺寸已经由 preset 与 CSS 共同确定。不要把 Directus 原始 `width/height` 直接当作裁剪后图片的尺寸，否则原图比例与输出比例可能不一致。

### 5.2 About 封面

二选一：

**优先方案：固定 preset。**

- 将 About 封面改为 `content-hero`；
- 使用 `width={1600}`、`height={900}`；
- 由 `object-fit: cover` 负责裁剪；
- 如果设计必须保留原始比例，则使用第二种方案。

**保真方案：读取真实文件元数据。**

- 查询 `cover_image.width` 和 `cover_image.height`；
- 类型中补充可选的文件元数据；
- 渲染时只对未经过裁剪的原图使用真实尺寸；
- 对缺失或异常元数据提供固定比例回退。

### 5.3 Markdown 正文图片

正文图片是更可能产生 CLS 的剩余对象。建议在文章写入时保存上传文件的宽高，或让 Markdown 渲染器输出带尺寸的图片包装器：

- 上传阶段读取 Directus 文件元数据；
- 将图片 ID、宽、高和替代文字作为文章图片元数据保存；
- 渲染时输出 `width`、`height`、`loading="lazy"`、`decoding="async"`；
- 元数据缺失时使用可见占位容器，不伪造原图比例。

不得通过给所有图片统一写死 `1200 × 675` 来掩盖真实比例问题。

### 5.4 图片验收

- 首页和列表首图保持 `fetchPriority="high"`；
- 非首屏图片保持 lazy；
- 画廊、灯箱和编辑器预览不要抢占首屏优先级；
- Chrome Lighthouse 的 CLS 不因图片加载发生明显跳变；
- 真实移动网络下首屏图片字节数不因补字段而增加明显负担。

## 6. 阶段 3：降低合成与绘制成本

优先级：P1。风险：中。必须通过视觉回归和 Performance trace 验收。

### 6.1 Header 毛玻璃

修改实际的 `.site-header`，不要创建无调用方的 `.site-header.elevated`。

建议采用两档实验，而不是直接认定某个值：

| 实验 | blur | saturate | 目的 |
|---|---:|---:|---|
| A | 48px | 200% | 当前基线 |
| B | 24px | 150% | 性能候选 |
| C | 16px | 140% | 低端设备候选 |

每档测试：滚动长页面、快速拖动滚动条、窗口缩放、移动模拟和高 DPR 显示器。只有在文字可读性、边界质感和帧率均可接受时才提交。

不要先添加持久性的 `will-change: filter` 或 `will-change: transform`；它可能增加显存和合成层压力。

### 6.2 全屏背景图

当前 CSS blur 同时服务于：

- Directus 默认背景；
- 用户选择的背景图；
- localStorage 中的实时模糊滑杆；
- 自定义背景层。

因此第一阶段只允许做低风险调整：

- 保留 CSS blur 作为用户预览和回退；
- 通过基线决定默认 blur 是否从 8/14 下调；
- 保持现有 `site-background` 和 `site-background-thumb` preset；
- 不发送未经代理允许的 `blur=` 查询参数。

如果实测确认全屏 blur 是主要瓶颈，再单独立项做预生成资源：

1. 在上传/媒体处理阶段生成固定模糊档位，而不是每次请求实时变换；
2. 在 Directus preset、Node API allowlist、Web URL 生成器和测试中同时增加受管 key；
3. 仅对默认站点背景使用预生成图；
4. 用户实时滑杆和自定义图仍保留 CSS blur；
5. 为每个新 preset 配置独立的缓存和回滚策略。

这条路径不能用一个 URL 参数改动替代完整的资产管线改动。

### 6.3 其他绘制优化

只有在长列表实际造成布局/绘制开销时，才对列表项试验：

```css
.long-list-item {
  content-visibility: auto;
  contain-intrinsic-size: 0 420px;
}
```

必须检查键盘焦点、锚点跳转、滚动恢复和 Safari 兼容性；不应对小型列表默认启用。

## 7. 阶段 4：让导航动画服从实际耗时

优先级：P1。风险：中。回滚：保留当前白名单动画逻辑，撤销慢导航开关。

### 7.1 目标状态机

| 状态 | 时间 | 行为 |
|---|---:|---|
| idle | 0ms | 无进度条、无额外动画 |
| pending-fast | 0–100ms | 等待导航完成，不显示明显反馈 |
| pending-slow | >100ms | 显示细进度条，可允许入场动画 |
| committed-fast | 路由完成 | 直接显示新内容 |
| committed-slow | 路由完成 | 新页面播放一次入场动画 |
| canceled | 导航取消/失败 | 清除 timer、进度条和 aria-busy |

80ms 不是固定正确值，初始建议在 80–120ms 范围内测试。阈值必须以真实导航 TTFB 和用户感知为准。

### 7.2 实施要点

- 用 `useRef` 保存 timer、导航 ID 和“下一页是否应播放动画”的瞬时状态；
- pathname 变化时，先捕获本次导航是否已进入 `pending-slow`，再清理旧 timer；
- 不能在 pathname effect 中无条件立刻把新页面的动画状态重置为 false，否则慢导航动画可能刚挂载就被取消；
- 动画状态应在新页面挂载后保持到主动画结束，或由 `animationend`/受控超时清理；
- 处理键盘激活 Link、连续点击、取消导航、后退/前进和 `router.push()`；
- `prefers-reduced-motion` 下不启用进度动画和入场动画；
- 进度条可以通过 CSS 延迟显现，避免快速导航出现闪烁；
- 保留 `aria-busy`，但必须确保任何异常路径都能清除。

对于局部 Link 提示，优先评估 Next 的 `useLinkStatus`；它适合 Link 内部的 pending 状态，不能未经改造直接替代全局页面转场。

### 7.3 验收场景

- 已预取页面：不播放 220ms 入场动画；
- Directus 延迟 300ms、1s、3s：有反馈但不白屏；
- 快速连续点击不同 Link：只保留最后一次导航状态；
- 导航被编辑器未保存保护取消：所有状态复原；
- 浏览器后退/前进：不遗留 progress bar；
- reduced-motion：无明显移动和淡入。

## 8. 阶段 5：按需失效与长缓存

优先级：P2。风险：中到高。必须在短缓存模式稳定后实施。

### 8.1 Tags 设计

不要只使用一个全局 `posts` tag，也不要接受请求体中任意用户提供的 tag。建议使用固定映射：

```text
site-settings
posts:list
posts:item:<id>
posts:slug:<slug>
videos:list
videos:item:<id>
videos:slug:<slug>
albums:list
albums:item:<id>
albums:slug:<slug>
```

列表请求绑定 list tag，详情和 metadata 请求绑定对应 item/slug tag。修改一个文章时只失效文章详情、文章列表和必要的首页统计，不要清空全部 CMS 缓存。

### 8.2 Web 端接口

建议使用不与现有 `/api/` 冲突的内部路径：

```text
POST /internal/revalidate
```

实现位置：

```text
apps/web/src/app/internal/revalidate/route.ts
```

接口要求：

- 只接受 POST；
- 校验服务端环境变量中的 secret，优先使用专用请求头；
- 根据 `collection` 和 `action` 做白名单映射；
- 不接受任意路径、任意 tag 或任意函数名；
- 对重复 webhook 保持幂等；
- 记录成功、拒绝、异常和触发的 tag；
- 未授权请求返回 401/403，不泄露缓存内部信息。

Next 16 的 `revalidateTag` 使用带 profile 的新签名，例如：

```ts
revalidateTag("posts:list", "max");
```

内容博客通常适合 stale-while-revalidate；如果某个管理操作要求写后立即读到自己的修改，再单独评估 Server Action 的 `updateTag`，不要对所有公共读取都使用强制过期。

参考：

- https://nextjs.org/docs/app/guides/upgrading/version-16
- https://nextjs.org/docs/app/api-reference/functions/revalidateTag
- https://nextjs.org/docs/app/api-reference/functions/revalidatePath

### 8.3 生产路由和 Directus Flow

推荐优先让同机 Directus Flow 调用：

```text
http://127.0.0.1:3000/internal/revalidate
```

这样绕过 Nginx 的 `/api/` → 8060 规则。如果必须从公网域名调用，则需要在 Nginx 中增加精确的 `/internal/revalidate` 路由到 3000，并保留 secret、访问日志和来源限制。

Flow 事件至少覆盖：

- `posts` create/update/delete；
- `video_projects` create/update/delete；
- `albums` 及相簿照片的 create/update/delete；
- `site_settings` update。

Flow 必须配置失败重试或人工告警。没有重试和监控时，不能把 TTL 从 30 秒直接提升到 3600 秒。

### 8.4 长缓存切换条件

只有同时满足以下条件后才改为小时级：

- 预发布环境连续验证 webhook 成功率；
- Directus 内容变更能在目标时间内触发对应 tag；
- 删除、改 slug、改发布状态、改相簿照片均有测试；
- webhook 失败时有告警；
- 可一键把 `DIRECTUS_REVALIDATE` 回退到 30。

建议初次切换使用 300–600 秒观察，再升到 3600 秒，而不是一步到小时级。

## 9. 阶段 6：可选的服务端与资源优化

这些项目不属于第一轮必做项：

### 9.1 服务端并行化

- 保持独立 Directus 请求使用 `Promise.all()`；
- 不要为了“看起来并行”重复请求同一个 URL；
- Next fetch 在同一次渲染中的相同 URL/选项会做请求级 memoization；
- 如果未来增加非 fetch 的文件读取、数据库查询或权限检查，再考虑 `React.cache()` 或独立缓存。

### 9.2 Suspense 与流式输出

Root Layout 的站点设置会影响背景、主题和控件，不能在没有占位策略时贸然拆成异步空壳。若基线证明某个非首屏区域阻塞明显，再把该区域拆成 Suspense 子树，并为占位内容提供稳定高度，避免用更快的首屏换来 CLS。

### 9.3 Bundle 与重型组件

当前已有若干 `next/dynamic`。继续优化前先查看生产 bundle：

- Shaka/播放器只在视频详情实际需要时加载；
- Gaussian Splat、上传和编辑器只在对应功能激活时加载；
- 不要为了导航速度手动预加载所有重型模块；
- 若用户明确表现出下一步意图，再对 hover/focus 做定向 preload。

## 10. 文件变更清单

| 阶段 | 预计文件 | 变更性质 |
|---|---|---|
| 基线 | 无；记录日志、trace、HAR | 只读验证 |
| Data Cache | 生产环境变量、`docs/frontend.md` | 配置与文档 |
| 图片稳定性 | About 页面、Markdown 图片元数据相关代码 | 局部功能改动 |
| 合成优化 | `apps/web/src/app/globals.css` | CSS 参数实验 |
| 导航动画 | `apps/web/src/components/PageTransition.tsx`、相关 CSS | 状态机改动 |
| 按需失效 | `apps/web/src/app/internal/revalidate/route.ts`、`directus.ts` | 新增接口与 tag 映射 |
| 资产预模糊（可选） | Directus preset、`apps/api/src/server.cjs`、Web URL 生成器、测试 | 跨服务改动 |
| Nginx（若走公网 webhook） | `deployment/nginx/windows-nginx.example.conf` | 生产路由改动 |

不要把真实密码、webhook secret、Directus token 或生产 Nginx 配置写入 Git。

## 11. 验证与回滚

### 11.1 每阶段必跑

```powershell
npm run build:web
npm run test:web
npm run web:health
```

如果某条命令需要运行服务或真实 Directus，则在预发布/生产镜像中执行，不用开发服务器结果替代。

### 11.2 缓存回滚

```dotenv
DIRECTUS_REVALIDATE=0
```

重启 Web 服务后重新验证内容实时性。保留 tags 和失效接口不会影响 `no-store` 模式，但 webhook 仍应可安全返回。

### 11.3 动画回滚

- 恢复当前白名单动画；
- 保留 reduced-motion 分支；
- 关闭慢导航阈值，不删除 pending 清理逻辑；
- 如果出现焦点或取消导航问题，优先回滚状态机，不回滚数据缓存。

### 11.4 资产回滚

- 新 preset 必须与旧 preset 并存一段时间；
- Web 先停止生成新 URL，再删除旧 preset；
- 资产代理拒绝未知参数的安全策略不能放宽为任意 Directus transform。

## 12. 最终验收清单

- [ ] 开发环境仍能实时看到 Directus 修改。
- [ ] 生产环境 `DIRECTUS_SHOW_DRAFTS=false`。
- [ ] 生产环境重复访问能证明 Data Cache 生效。
- [ ] 没有把 Data Cache 误报为所有页面 Full Route Cache。
- [ ] About 封面和 Markdown 图片不存在明显 CLS。
- [ ] `.site-header` 的实际选择器已修改并完成视觉回归。
- [ ] 没有发送会被资产代理拒绝的 `blur=` URL。
- [ ] 快速导航不再被固定动画延迟，慢导航仍有反馈。
- [ ] 取消、后退、前进、reduced-motion 场景均通过。
- [ ] webhook 入口不与生产 `/api/` Node API 路由冲突。
- [ ] `revalidateTag` 使用 Next 16 兼容签名。
- [ ] webhook 失败有重试/告警，且可以一键回到 30 秒 TTL。
- [ ] `npm run build:web`、`npm run test:web` 和健康检查通过。

## 13. 参考资料

- Next.js `fetch` 与 Data Cache：https://nextjs.org/docs/app/api-reference/functions/fetch
- Next.js 缓存模型：https://nextjs.org/docs/app/guides/caching-without-cache-components
- Next.js 16 缓存 API 变化：https://nextjs.org/docs/app/guides/upgrading/version-16
- Next.js `useLinkStatus`：https://nextjs.org/docs/app/api-reference/functions/use-link-status
- React DOM resource hints：https://react.dev/reference/react-dom#resource-preloading-apis
