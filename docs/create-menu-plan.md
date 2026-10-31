# 右下角悬浮按钮（创作菜单）实施方案

本文是交给编码代理的实施说明。按阶段实施，每个阶段完成后先通过验收，再进入下一阶段。所有路径相对于仓库根目录。

> **修订（2026-10-31）：** 第 8 节（第 6 阶段）是作者最新确认的决定，凡与前文冲突，以第 8 节为准。主要变化：悬浮按钮不再承载任何作者功能；首页三张上传卡片改为 project 入口。

### 实施记录（2026-10-30）

- 第 0 阶段：在内置浏览器确认相簿同页弹窗、关闭后的查询参数清理，以及详情管理菜单；未写入现有 CMS 内容。
- 第 1–5 阶段：已实现并逐阶段验收。最终 API 185 项、Web 204 项、安全 38 项、视频上传 12 项测试通过；TypeScript、生产构建和 DESIGN.md 校验通过。
- headless WebKit 的 16 组验收通过，包括会话、同页弹窗、快捷键、滚动、视频避让、四种拖放、任务状态、真实 PNG/视频/文章提交、Bearer 相簿 CRUD 和独立文章令牌边界。真实相簿灯箱另由内置浏览器确认。
- 媒体测试使用本地 `cms/bin/ffmpeg`、`cms/bin/ffprobe` 和 `cms/bin/molten-vk.json` 配置；浏览器测试使用一次性 CMS 数据，不能替代真实部署或 HDR 显示设备的验收。
- 第 4 阶段调研结论：已有逐任务状态接口，新增有界聚合的只读 `/author/tasks`。视频转码没有百分比，因此显示阶段和不定进度环；胶片与已确认上传字节使用真实进度。
- 既有 `lint` 脚本使用当前 Next 版本不支持的 `next lint`；UI 静态审计仍有 15 条既有表单/滚动条等问题，未扩展到无关界面整改。报告保存在验收目录。
- 按会话中的浏览器约束，自动化仅用 headless WebKit/Firefox，不启动 Chrome。
- 同源判断适配 Next 改写 Host 的行为；仅在 `TRUST_PROXY=true` 的私有 API 上使用代理覆盖的外部主机/协议。Nginx 模板同步覆盖 `X-Forwarded-Host`。
- `sendJson` 保留会话模块计算的 `Retry-After`；状态查询不续期、无效时清除两个 cookie。hint 只触发校验，不直接显示“已登录”。
- 客户端增加到期更新、可见性校验、跨标签页同步。Manager 保存配置后重启失败不等于已经吊销旧进程的会话。
- 保存/上传后延后到关闭相簿弹窗时更新列表，避免 `router.refresh()` 与清理查询参数的导航竞争。原相簿 API 测试现使用隔离环境，并核对草稿图片拒绝匿名访问。
- 测试脚本：`tests/create-menu-browser.cjs`；截图、日志、报告：`test-results/create-menu/`。端口 13002/18057/18062 使用一次性 CMS 和媒体目录，不重启用户的服务。

## 0. 当前状态（工作区中，尚未提交）

以下已经实现，后续阶段在此基础上修改，不要重写：

| 文件 | 现状 |
|---|---|
| `apps/web/src/components/ActionMenu.tsx` | 通用的"按钮 + 展开面板"组件。props：`label`（触发按钮的无障碍名称）、`trigger`、`groups`（`{ label?, items: { label, icon, href \| onSelect }[] }[]`）、`placement`（`"up" \| "down"`）、`className`、`triggerClassName`。采用 disclosure 模式，不是 ARIA menu；方向键在菜单项间移动；Esc、点击外部、选择菜单项、路由变化都会关闭面板 |
| `apps/web/src/components/CreateMenu.tsx` | 右下角悬浮按钮，挂在 `apps/web/src/app/layout.tsx` 的 `<body>` 末尾。在 `/`、`/write`、`/upload` 上不渲染（首页保留原有的上传卡片）。菜单分两组：写文章（`/write`）、上传视频（`/upload`）；"相簿"组为上传照片、新建相簿、导入胶片扫描，分别链接到 `/albums?dialog=upload`、`create`、`film`，其中胶片扫描只在非生产环境出现 |
| `apps/web/src/app/globals.css` | 新增 "Action menu" 和 "Create menu" 两节；删除了 `.page-action-link` 和 `.album-toolbar-actions` 相关规则 |
| `apps/web/src/app/posts/page.tsx`、`videos/page.tsx` | 删除了标题右侧的"写文章""上传视频"按钮 |
| `apps/web/src/components/AlbumsToolbar.tsx` | 删除了三个操作按钮，保留弹窗和状态提示。用 `requestedDialog` 跟随 `initialDialog` 的变化，所以已经停留在 `/albums` 时，点菜单也能打开弹窗 |
| `apps/web/src/app/albums/page.tsx` | `?dialog=` 支持 `upload`、`create`、`film` |
| `apps/web/src/components/AlbumGallery.tsx` | 单个相簿页的"上传照片"和"管理模式"合并成一个 `ActionMenu`，触发按钮显示"管理"或"管理中"。嵌入在管理弹窗里时（`embedded`）仍只保留单独的上传按钮 |

**展开和收起动效必须与外观面板（`AppearanceControl` 的 `.bg-control-panel`）保持一致，这是已经确认的要求：**

- 复用关键帧 `bg-panel-reveal`（460ms，`cubic-bezier(0.22, 1, 0.36, 1)`）和 `bg-panel-conceal`（300ms，`cubic-bezier(0.23, 1, 0.32, 1)`）。
- 圆心是触发按钮的中心，半径取到面板最远的角，通过 `--reveal-x`、`--reveal-y`、`--reveal-r` 在 `useLayoutEffect` 里设置。
- 面板在打开或收起过程中保持挂载，收起动画结束后才卸载。
- 打开时焦点移到第一项；按 Esc 或选择按钮类菜单项后，焦点回到触发按钮；点击外部关闭时不移回焦点。
- 打开状态下，触发按钮使用外观按钮的 active 样式（强调色的文字、描边，以及 `--accent-soft` 底色）。不做图标旋转。

**尚未验证：** 相簿页通过 `?dialog=` 打开弹窗，以及单个相簿页的"管理"菜单。这两项需要 Directus（8055）和上传 API（8060）运行时，在浏览器里确认。

## 1. 必须遵守的约束

- **产品约束**（`PRODUCT.md`）：
  - 媒体画面（视频、照片、母版对比）上不得出现装饰。悬浮按钮在媒体播放或查看时必须让开，见第 3 阶段。
  - HDR 优先，SDR 必须可用。
  - 低配置主机和普通设备上必须可用。
- **视觉系统**（`DESIGN.md`、`globals.css` 的 `:root`）：只使用已有的 token，包括 `--surface-*`、`--line*`、`--text*`、`--accent*`、`--accent-2`（D65 钢蓝），以及 `--motion-*`、`--transition-*`。界面文案使用简体中文。
- **毛玻璃写法**：必须先写 `-webkit-backdrop-filter`，再写 `backdrop-filter`。反过来写时，构建会合并掉无前缀那条，Chrome 里就没有模糊。第 6 阶段已按作者要求修正全站 9 处顺序，模糊强度不变。
- **减少动态效果**：遵守 `globals.css` 里已有的全局 `prefers-reduced-motion` 规则。位移、缩放瞬间完成；透明度和颜色允许保留过渡。
- **页面缓存**：根布局和页面组件中不得读取 cookie 或 headers，否则整站会变成动态渲染。身份判断只能在客户端完成。
- **令牌安全**（`docs/deployment.md` 的 "Upload API Security"）：`UPLOAD_API_TOKEN` 不得出现在 `NEXT_PUBLIC_*`、URL、cookie 或任何浏览器存储中。
- **页面划变**：`PageTransition.tsx` 中 View Transition 的根层划变不要改动。

## 2. 第 1 阶段：作者会话与双重身份菜单

### 2.1 目标

访客看到的悬浮按钮只提供阅读工具；作者在当前设备上用 `UPLOAD_API_TOKEN` 登录一次后，6 小时内菜单里会多出创作和相簿操作。服务器只把令牌用来验证，然后签发会话，令牌本身不会留在浏览器里。

### 2.2 已确定的决定

| 项目 | 决定 |
|---|---|
| 登录凭证 | `UPLOAD_API_TOKEN`（在 Manager 的 "Publishing credentials" 面板中设置和更换） |
| 有效期 | 登录后 6 小时，固定期限，不随使用延长 |
| 存储 | 只存在 API 进程内存中。API 重启（包括在 Manager 里更换令牌）后，所有会话失效 |
| 上限 | 16 个会话，超出时淘汰最早的 |

### 2.3 上传 API：新增 `apps/api/src/author-session.cjs`

以 `scripts/manager-auth.cjs` 为蓝本，导出 `createAuthorSessions({ token, now = Date.now })`。

- **会话表**：`Map<sha256(sessionId), { expiresAt, csrf }>`。只保存会话 ID 的摘要。会话 ID 是 32 字节随机数，以十六进制表示；cookie 解析时必须匹配 `/^[a-f0-9]{64}$/`。
- **`signIn(req, res, payload)`**：
  - 请求体必须是对象，且只包含 `token` 一个字段；`token` 为字符串，长度 1 到 512。
  - 用 `crypto.timingSafeEqual` 比较两边的 SHA-256 摘要。
  - 5 分钟窗口内全局失败计数达到 10 次时，返回 429，并附带 `Retry-After`。
  - `UPLOAD_API_TOKEN` 为空或仍是占位值 `__REPLACE_WITH_RANDOM_UPLOAD_TOKEN__` 时，返回 503。
  - 登录成功时，先删除请求里带来的旧会话（防止会话固定攻击），再签发新会话。
- **`status(req, res)`**：会话有效时返回 `{ author: true, expiresAt, csrf }`；无效时返回 `{ author: false }`，同时下发清除 `author_hint` 的 cookie。
- **`signOut(req, res)`**：删除会话，清除两个 cookie。
- **`requireSession(req)`**：本阶段只实现并测试，不接入任何写入接口。要求会话有效、请求头 `X-Author-CSRF` 与会话中的 `csrf` 一致、`Origin` 为本站，且 `Sec-Fetch-Site` 不是 `cross-site`。

**cookie**（`Secure` 的判断与 Manager 相同：`req.socket.encrypted || x-forwarded-proto === "https"`）：

| 名称 | 值 | 属性 |
|---|---|---|
| `author_session` | 会话 ID | `Path=/api; HttpOnly; SameSite=Strict; Max-Age=21600`，必要时加 `Secure` |
| `author_hint` | `1` | `Path=/; SameSite=Strict; Max-Age=21600`，必要时加 `Secure`，**不设** `HttpOnly` |

API 自身的路径没有 `/api` 前缀，这个前缀由 Nginx 和 Next 的 rewrite 加上（见 `apps/web/next.config.mjs`）。`author_session` 的 `Path` 必须是 `/api`，这样浏览器只会在访问 API 时带上它。

**路由**（在 `apps/api/src/server.cjs` 中注册，位置参照 `/articles`、`/albums` 的分发方式）：

| 方法 | API 内部路径 | 浏览器访问路径 | 说明 |
|---|---|---|---|
| POST | `/author/session` | `/api/author/session` | 登录，要求同源。成功时返回 `{ expiresAt, csrf }` |
| GET | `/author/session` | 同上 | 查询登录状态 |
| DELETE | `/author/session` | 同上 | 退出，要求同源并带 `X-Author-CSRF` |

响应一律设置 `Cache-Control: no-store`。错误信息使用中文，且不得回显任何令牌片段。

### 2.4 前端

**新增 `apps/web/src/lib/author-session.ts`：**

- `hasAuthorHint()`：读取 `document.cookie` 中的 `author_hint`。
- `signIn(token)`、`signOut()`、`refreshStatus()`：调用上面三个接口，请求使用 `credentials: "same-origin"`。
- 一个最小的订阅机制（例如 `useSyncExternalStore`）：登录或退出后，菜单无需刷新页面即可切换。
- CSRF 值只保存在模块内存中，不写入任何存储。
- 每个标签页首次加载时，只要存在 `author_hint`，就调用一次 `refreshStatus()` 校验（例如 API 已经重启的情况）。

**新增 `apps/web/src/components/AuthorSignIn.tsx`：**

- 用 `<dialog>` 实现的登录框，只有一个令牌输入框：`type="password"`、`autocomplete="current-password"`，以便浏览器的密码管理器保存。
- 401、429、503 分别给出不同的中文提示。
- 提交后立即清空输入框，令牌不得保存在 state 之外的任何地方。

**修改 `CreateMenu.tsx`：**

| 身份 | 菜单内容 |
|---|---|
| 访客 | 回到顶部；复制本页链接（成功后在菜单项内显示"已复制"）；本页目录（只在 `/posts/[slug]` 出现，把焦点移到文章目录）；底部一行次要样式的"作者登录" |
| 作者 | 访客的全部项目，加上创作组（写文章、上传视频）和相簿组（同现状）；底部显示"已登录 · 剩余 N 小时 · 退出" |

- 显示与否保持现有规则：`/`、`/write`、`/upload` 不显示。
- 某次作者操作返回 401 时，清除 `author_hint` 并提示"登录已过期"。

**文档：**

- `docs/deployment.md` 的 "Upload API Security"：补充"令牌只用于换取 6 小时的内存会话；重启 API 或在 Manager 中更换令牌会使全部会话失效"。
- `docs/upload-api.md`：补充三个新接口。

### 2.5 验收

**单元测试**：新增 `apps/api/test/author-session.test.cjs`，使用 `node:test` 并注入时钟。须覆盖：

- 正确的令牌签发会话，错误的令牌返回 401，第 11 次失败返回 429。
- 第 6 小时整时会话失效，此时 `status` 同时清除 `author_hint`。
- 请求体带多余字段、令牌超长、令牌为占位值时均被拒绝。
- 第 17 个会话会淘汰最早的会话。
- `signOut` 之后旧 cookie 无效。
- 跨站 `Origin` 发起的 `DELETE` 被拒绝。

**端到端测试**（Playwright，headless WebKit 或 Firefox；不启动 Chrome、不使用个人配置）：

1. 访客状态下看不到创作项。
2. 登录后，无需刷新，菜单即出现创作项。
3. 另一个全新的浏览器上下文不受影响。
4. 重启 API 后刷新页面，菜单退回访客状态。
5. 手动写入 `author_hint=1` 后触发校验；`GET /api/author/session` 返回 `author: false`，两个 cookie 被清除，菜单保持访客状态。

**通过标准**：`npm run test:api`、`npm run test:web` 和 `apps/web` 下的 `npx tsc --noEmit -p .` 全部通过。

## 3. 第 2 阶段：实用与美观的第一批改进

1. **跨页面保持不动**：给 `.create-menu` 设置 `view-transition-name: create-menu`，并参照 `.site-header` 的写法，把 `::view-transition-group(create-menu)` 和 `::view-transition-new(create-menu)` 的动画设为 none，旧快照隐藏。这样页面划变时按钮不会被斜线切开。
2. **为媒体让路**：以下任一情况成立时，按钮隐藏，并设置 `inert`、`aria-hidden`：
   - 页面中有正在播放的 `<video>`（监听 `play`、`pause`、`ended` 事件）；
   - 相簿灯箱打开；
   - `document.fullscreenElement` 存在。

   恢复显示时使用透明度过渡。
3. **阅读时退后**：在向下滚动的过程中，按钮缩小到 40px，透明度降到 0.55。满足以下任一条件时恢复：停止滚动 300ms；指针进入右下角 120px 范围；按钮获得焦点；面板处于打开状态。
4. **菜单项副标题**：每项下方加一行小字，颜色用 `--text-secondary`：
   - 上传视频 · SDR / HDR10 / HLG / Dolby Vision
   - 上传照片 · SDR 与 HDR AVIF 配对
   - 导入胶片扫描 · 自动分帧
   - 新建相簿、写文章：保持一行，不加副标题
5. **键盘操作**：
   - 焦点不在输入框、文本域或可编辑区域，且没有按修饰键时，按 `N` 打开或关闭菜单。
   - 菜单打开后，单字母直达：W 写文章、V 上传视频、P 上传照片、A 新建相簿、F 导入胶片扫描。
   - 菜单项右侧用 `<kbd>` 显示对应字母。
   - 访客状态下只响应 `N`。
6. **悬停细节**：悬停时触发按钮的描边改为 `--accent-2`。不使用发光，也不做弹跳。

**验收**：

- 页面划变截图中，按钮完整、位置不变。
- 播放视频时按钮消失，暂停后重新出现。
- 滚动时按钮退后，停止后恢复。
- 只用键盘就能完成"打开菜单，进入上传视频"。
- 开启 `prefers-reduced-motion` 后，没有任何位移或缩放动画。

## 4. 第 3 阶段：情境感知与拖放上传（仅作者）

1. **按页面排序**：当前页面最相关的操作排在最前，并略加强调：
   - 文章列表：写文章
   - 视频列表、视频详情：上传视频
   - 相簿列表：上传照片、新建相簿
2. **上传到此相簿**：在 `/albums/[slug]` 页面，菜单第一项为"上传到此相簿"，链接到 `?action=upload`。`AlbumGallery` 在挂载时读取这个参数并调用 `openUpload()`，处理完后用 `router.replace` 清除参数（参照 `AlbumsToolbar` 的 `clearDialogQuery`）。
3. **拖放上传**：
   - 作者把文件拖入窗口时，按钮放大并显示"松开以上传"。
   - 按文件类型分流：视频 → `/upload`；AVIF、HEIF、JPEG、PNG → 上传照片；TIFF → 导入胶片扫描（仅非生产环境）；`.md` → `/write`。
   - 文件对象无法放进 URL。用模块级的内存暂存（单例，客户端导航时不会丢失）把文件交给目标页，目标页的上传组件挂载时取走。
   - 文件类型无法识别时，提示支持的格式，不进行跳转。

**验收**：在每种页面上，第一项都符合上面的规则；"上传到此相簿"会直接打开当前相簿的上传面板；四类文件分别进入正确的上传流程。

## 5. 第 4 阶段：任务状态与图形（需要先调研）

1. **任务进度环**：视频转码、胶片分帧进行时，触发按钮外圈显示一道细环，表示真实进度；面板顶部列出"进行中的任务"。任务完成时，环短暂显示为 `--success` 色，随后消失。**开始前需要确认**：上传 API 是否已有可查询的任务状态接口（视频的 `upload sessions`、胶片扫描的 jobs）。如果没有，需先补一个只读接口，并要求作者会话。
2. **取景框图标**：把 "+" 换成"取景框四角 + 中心小加号"的自绘 SVG。面板展开时，四个角随圆形展开扩到面板四角；收起时反向。这个效果必须叠加在外观面板同款的圆形展开之上，不能替换它。

## 6. 第 5 阶段：登录后不再手动粘贴令牌

- 受 `UPLOAD_API_TOKEN` 保护的写入接口（视频上传、相簿、照片、胶片扫描）改为同时接受两种方式：Bearer 令牌（原有方式，保留），或"会话 + `X-Author-CSRF`"（`requireSession`）。
- 文章发布接口使用的是 `ARTICLE_API_TOKEN`。只有在它未单独配置、回退到 `UPLOAD_API_TOKEN` 时，才接受会话；单独配置时仍须手动输入令牌，不扩大会话的权限。
- 作者登录后，相簿管理、写作台、视频上传中的令牌输入框显示为"已作为作者登录"，可以展开后改用手动输入。
- 涉及文件：`apps/api/src/server.cjs` 中的鉴权函数（`tokenMatches` 附近）、`apps/web/src/lib/album-management.ts`、`ArticleEditor.tsx`、`UploadVideoForm.tsx`。

**验收**：原有的 Bearer 用法完全不受影响（运行现有的 `npm run test:album-api`、`npm run test:security`）；登录后的三处上传都无需输入令牌；跨站请求和缺少 CSRF 请求头的请求被拒绝。

## 7. 不要做

- 不要在根布局中读取 cookie 或 headers。
- 不要把 `UPLOAD_API_TOKEN` 存进 cookie、localStorage、sessionStorage 或 URL。
- 不要按 IP 或浏览器指纹识别作者。
- 不要加脉冲、呼吸、弹跳或发光动效。
- 不要让按钮盖在正在播放的视频、灯箱或母版对比画面上。
- 不要恢复首页以外各页面上原来的独立上传按钮；首页的上传卡片保持不变。
- 不要修改外观面板本身的动效。

## 8. 第 6 阶段：工具与作者分离、观看体验、首页 project 入口

本阶段在 1–5 阶段的实现上修改，不要推倒重写。作者确认了四项决定：

1. 悬浮按钮保留，它是给所有人用的便携小工具（阅读工具和各页面专属工具），**不与任何作者功能或作者入口融合**。
2. 视频详情页和文章详情页的液体背景**放缓**，不是静止。默认亮度下，文字和视频远亮于背景，注意力自然集中在亮处；放慢运动是为了减少运动对视线的牵引。
3. 观看时界面退场；播放器全屏时整个页面要联动；同时优化手机端。
4. 首页继续展示个人资料，访客看到的三个上传入口改为 project 的跳转入口。

标注"默认方案"的条目是根据现有结构拟定的，作者尚未逐项确认；有不同意见时以作者为准。

### 8.1 悬浮按钮：只保留页面工具

把 `CreateMenu.tsx` 重命名为 `PageTools.tsx`，并删除其中所有作者相关内容：`useAuthorSession`、`useAuthorTasks`、登录框、创作和相簿分组、实验室分组、"上传到此相簿"、任务进度环、拖放逻辑、字母快捷键 W/V/P/A/F/L。保留 `N` 打开菜单。保留外观面板同款的展开和收起动效，以及 `useCreateMenuBehavior` 的避让和退后行为。

**按钮图案（作者确认）：2×2 色卡，全站统一，不随页面变化。** 替换现有的取景框和"＋"，并删除取景框四角的展开动效。

- 自绘 SVG，四个圆角方格（边长 8.5、间距 1.8、圆角 1.1，图形居中于 26×26 画布）。
- 灰阶取值：左上 `#E2E8EE`，右上和左下 `#A9B3BD`，右下 `#737D88`。在按钮底色 `#1e2328` 上，最暗格的对比度为 3.78:1，不要再调暗。
- 展开时四格的灰阶顺时针轮转一格，收起时转回。只改变填充色，时长使用 `--motion-panel-duration`，不做位移、缩放、发光或弹跳；减少动态效果模式下直接切换。
- 按钮的外形保持圆形，展开和收起继续沿用外观面板的圆形动效。

每个页面的工具（默认方案）：

| 页面 | 工具 |
|---|---|
| 文章详情 | 回到顶部（滚动超过一屏后出现）、本页目录、复制本页链接 |
| 视频详情 | 全屏、复制当前时间点链接（`?t=秒`，播放器加载时读取并跳转）、复制本页链接 |
| 相簿详情 | 复制本页链接、回到顶部（滚动超过一屏后出现） |
| 文章、视频、相簿、实验室列表，关于页 | 回到顶部（滚动超过一屏后出现） |

当前没有可用工具时不渲染按钮，例如列表页停在顶部时。首页、`/write`、`/upload` 继续不显示。

### 8.2 作者入口：独立的"工作台"（位置已确认）

作者入口必须在任何页面都能一步到达，但访客看不到。

- **设备标记：** 登录成功时，服务器额外通过 `Set-Cookie` 写入 `author_device=1`（`Path=/; SameSite=Strict; Max-Age=31536000`，不设 `HttpOnly`，HTTPS 下加 `Secure`）。不含任何秘密，只影响显示，不授权。会话过期时不清除；只有"退出并忘记此设备"才清除。必须由服务器写入：Safari 会把 JS 写入的存储限制在约 7 天。
- **`AuthorMenu.tsx`：** 只在存在 `author_device` 时渲染，复用 `ActionMenu`。放在页头的 `site-header-actions` 中，位于 `NavBar` 和 `BackgroundControl` 之间，向下展开。首页没有页头，放在外观按钮左侧，向上展开。服务端不输出这个组件，保持页面可缓存。
- **隐秘（作者确认）：** 入口位置按上面定，并且要做得不起眼：
  - 只有图标，不显示"工作台"等文字，也不加 `title` 提示；无障碍名称用中性的"工具"。
  - 外观与外观按钮完全同一家族（40px 圆形、透明底、`--muted` 色），放在一起时看起来只是另一个普通设置按钮。
  - 静止时不加描边或徽标。任务进行中只显示一个 6px 的小点，不显示进度环和数字。
  - 水合完成后才渲染，不写进服务端 HTML。
  - `/studio` 不进入导航和站点地图，并设置 `noindex`。
- **迁入内容：** 创作、相簿、实验室分组，"上传到此相簿"，任务列表，登录状态与退出。任务详情放在展开后的面板里。
- **会话过期：** 入口继续显示。点击时弹出 `AuthorSignIn`，登录成功后自动继续原来的目标，不需要再点一次。
- **新设备：** 新增 `/studio`，页面只有登录框，设置 `noindex`，不进入导航。支持 `?next=`，但只接受以单个 `/` 开头的站内相对路径，防止开放重定向。另外，`⌘⌥⇧L` / `Ctrl+Alt+Shift+L` 在任意页面打开同一个登录框，界面上没有提示。
- **拖放上传：** 只在有效作者会话下启用。改为全窗口的放置层，不再借用悬浮按钮。
- **页面内的作者控件：** 单个相簿页的"管理"按钮和实验室的新建入口，同样只在存在 `author_device` 时显示。

### 8.3 液体背景放缓

- 在 `LiquidBackground.tsx` 中用 `usePathname` 判断：`/posts/<slug>` 和 `/videos/<slug>` 使用 `READING_SPEED_SCALE = 0.35`，其他页面为 1。
- 实际速度等于用户保存的速度乘以这个系数。用户把速度设为 0 时仍为 0；外观面板里显示的数值不变。
- 从列表页进入详情页时，布局不重新挂载，所以通过已有的 `controller.update` 更新速度，不要重建渲染器。
- CSS 回退层也要同步放缓（`--liquid-duration-*`）。
- 不改变亮度和配色，也不改变用户的外观设置。

### 8.4 观看时界面退场与全屏联动

**为什么不能沿用原生全屏：** 现在用的是 `<video controls>`。原生全屏只放大 video 元素，母版切换条进不了全屏，页面也无从联动。

**统一状态：** 在 `MediaPlayer.tsx` 中维护观看状态，写到 `html[data-watching]` 上，取值为 `idle`、`active`、`fullscreen`，由 CSS 响应。

| 状态 | 触发 | 页面表现 |
|---|---|---|
| 无属性 | 未播放或已暂停 | 正常 |
| `active` | 正在播放，且最近 2.5 秒内有操作 | 正常 |
| `idle` | 正在播放，2.5 秒内没有操作 | 页头、返回按钮、标题说明淡出，只改透明度和 `pointer-events`，不改变布局。播放器画面不受任何影响 |
| `fullscreen` | 进入全屏或沉浸模式 | 页头、页面工具、标题说明全部隐藏；液体背景速度设为 0；退出时恢复滚动位置 |

鼠标移动、触摸、键盘操作、暂停、播放结束都回到 `active` 或无属性。只有键盘操作形成的播放器控件焦点才阻止进入 `idle`；鼠标或触摸留下的焦点不阻止退场。

**桌面和 Android：**

- 设置 `controlsList="nodownload nofullscreen"`，隐藏原生全屏按钮。这个属性只有 Chromium 系浏览器支持，Safari 和 Firefox 仍会显示原生全屏按钮。
- Safari 和 Firefox 上用户仍可能点到原生全屏，此时只有 video 元素全屏。监听 `fullscreenchange` 和 `webkitbeginfullscreen`、`webkitendfullscreen`，让 `html[data-watching]` 进入 `fullscreen`，页面状态保持正确；这种情况下母版切换条不可用，属于已知限制。第一版不做自绘播放控件。
- 在 `.player-controls-row` 加自绘全屏按钮，并支持 `F` 键和双击画面。
- 对 `.player-shell` 调用 `requestFullscreen()`，让母版切换条留在全屏里。切换条只在有操作时出现，随后淡出，不覆盖常驻内容。
- 监听 `fullscreenchange` 同步状态，以处理 Esc 退出。

**手机：**

- **iPhone Safari：** 没有元素级全屏 API。全屏按钮改为进入页内沉浸模式：`position: fixed`、高度 `100dvh`、黑底、留出 `safe-area-inset-*`，母版切换条仍然可用。iOS 原生控件的全屏仍然存在，用 `webkitbeginfullscreen` 和 `webkitendfullscreen` 同步状态。
- **Android：** 进入全屏后，横版视频尝试 `screen.orientation.lock("landscape")`，失败时静默忽略，退出时解锁。
- **竖屏播放：** 播放器吸附在顶部（`position: sticky`，考虑安全区），下方的说明和母版切换条可以滚动。
- **横屏：** 仅对触屏、横屏且视口高度不超过 500px 的手机自动沉浸，排除平板。手动退出后，resize 或重新播放不再自动进入，直到转回竖屏清除这个选择；再转横屏才重新自动沉浸。
- **触摸：** 没有悬停，所以退场计时从最后一次触摸开始，点击页面恢复。触控目标不小于 44px，母版切换条支持横向滚动，保留 `playsInline`。

媒体画面约束：退场和全屏只影响画面周围的元素，不得对视频本身加滤镜、遮罩、亮度或模糊变化。

### 8.5 首页 project 入口

- 把 `(home)/page.tsx` 中的三个 `UploadWidget` 换成 project 入口。沿用 `.orbit-upload`、`.orbit-blog-upload`、`.orbit-album-upload`、`.orbit-post-upload` 这几个类，保持现有各断点的布局；确认无误后可以再重命名。
- 所有访客看到的内容相同，不做客户端替换，避免闪烁。作者的上传入口走工作台。
- **数据：** 取 `external_projects` 中已发布、按 `sort_order` 排序的前 3 条。**不要在首页调用 `getExternalProjects()`**：它内部的 `await connection()` 会让首页变成动态渲染。新增一个走 `directusFetch` 缓存的 `getFeaturedProjects(limit)`，并确认 `lib/revalidate-tags.ts` 能在 project 变更时刷新它。
- **跳转：** `open_mode` 为 `external` 时，新标签页打开 `url`，带 `rel="noopener noreferrer"`；其他情况跳到 `/project` 中的对应项目（实现前先读 `ProjectGallery.tsx`，确认定位方式）。
- **不足 3 个或单行数据无效时：** 用"进入实验室"（`/project`）补位，保留其他有效项目。CMS 读取故障必须让 ISR 再生成失败并保留上一版成功页面，不能把故障转换成空列表或零计数写入缓存；首次无缓存的构建需要 CMS 可用。
- **长标题：** 单行省略，完整标题放在无障碍名称里。
- `SITE_POST_UPLOAD_HREF`、`SITE_ALBUM_UPLOAD_HREF` 不再使用后，从 `site-config.ts`、`.env.example` 和文档中删除。

### 8.6 验收

- 访客（没有 `author_device`）在任何页面都看不到工作台、管理按钮和上传入口；悬浮按钮里没有任何作者项。
- 作者设备的会话过期后，工作台仍然可见；点"上传视频"，登录后自动进入上传页。
- 全新设备打开 `/studio?next=/albums` 能登录并跳转；`?next=https://example.com` 和 `?next=//example.com` 被忽略。
- 文章和视频详情页的液体速度是列表页的 0.35 倍，用户速度为 0 时保持静止，外观面板数值不变。
- 播放 2.5 秒无操作后界面淡出，操作后恢复；淡入淡出期间播放器位置不发生变化。
- 桌面全屏时，母版切换条可用；按 Esc 退出后状态和滚动位置恢复。
- 在 iPhone 和 Android 实机或模拟器上，分别验证全屏或沉浸模式、横竖屏切换和安全区。
- 首页在 1440、1100、900、700、390、360 px 宽度下布局与改动前一致，且 project 为 0、1、3 个以及 CMS 不可用时都正常。
- 首页改动后仍为可缓存页面，用构建输出确认没有变成动态渲染。

### 8.7 本阶段覆盖的旧条目

- 第 2.4 节的"作者"菜单内容、第 3 节第 5 项的字母快捷键、第 4 节和第 5 节中放在悬浮按钮上的内容，全部迁到工作台。
- 第 7 节"首页的上传卡片保持不变"作废，改为第 8.5 节。
- 新增禁止事项：不要把任何作者功能或入口放回悬浮按钮；不要让液体背景在详情页完全静止；不要在首页调用带 `connection()` 的数据函数。

### 8.8 实施顺序

1. 作者入口分离：`author_device`、`AuthorMenu`、`/studio`、`⌘⌥⇧L`，并把作者内容从悬浮按钮迁出。
2. `PageTools`：按页面显示工具、2×2 色卡图案、`?t=` 时间点链接。
3. 液体背景放缓。
4. 观看状态、桌面全屏联动。
5. 手机端：iPhone 沉浸模式、Android 横屏、竖屏吸顶、横屏自动沉浸。
6. 首页 project 入口。
7. 更新 `tests/create-menu-browser.cjs`（作者项已迁出悬浮按钮）、`DESIGN.md`、`docs/deployment.md`。

### 8.9 Review 修复清单（2026-10-31）

审查范围是 `13a0e52` 之后的第 6 阶段改动。按顺序修复。

**作者已决定：**

- 作者入口保留钢笔图标，不用更换。
- 任务完成后，小点多停留几秒：`useAuthorTasks` 中 `completed` 的保持时间从 2500ms 改为 6000ms；`AuthorMenu` 的触发按钮在 `tasks.length > 0 || completed` 时都显示小点。完成状态下小点颜色为 `--success`，尺寸仍为 6px，不加动画、文字或数字。

**P1，必须修复：**

1. `apps/web/src/lib/player-viewing.ts:78`：鼠标点击视频后焦点落在 `<video>` 上，退场计时被直接跳过，界面永远不淡出。改为只在键盘焦点时阻止退场，鼠标点击视频不阻止。在 `tests/phase6-browser.cjs` 中补一条真实点击视频的用例；现有用例用程序调用 `play()`，覆盖不到。
2. `apps/web/src/lib/player-viewing.ts:85-93`：横屏自动沉浸没有记住用户已手动退出，退出全屏时的 `resize` 或再次播放都会重新进入。增加"本次横屏已手动退出"的标记，转回竖屏时清除；并加屏幕高度限制（例如 `max-height: 500px`），不影响平板。

**P2，建议修复：**

3. `⌘⇧L` 是 Safari"显示侧边栏"的快捷键。换一个不冲突的组合，并在 Safari 实测；同步修改第 8.2 节和 `docs/deployment.md`。
4. `apps/web/src/app/albums/page.tsx:113`：空相簿提示还指向已移除的"＋"，访客也能看到。改成中性文案，参照 `AlbumGallery.tsx` 中"整理中"的写法。
5. `apps/web/src/app/(home)/page.tsx:21`：删除 `getCounts()` 的 `.catch`，让生成失败时保留上一版缓存，避免把"0 篇"写进缓存。`getFeaturedProjects` 的错误处理改为只影响 project 卡片，同样不能把 CMS 故障时的结果写进长期缓存。
6. `scripts/setup-revalidate-flows.cjs:23`：在集合列表中加入 `external_projects`，并更新 `docs/deployment.md` 中手动添加的说明。
7. `apps/web/src/lib/author-navigation.ts:3`：用 `new URL` 规范化后再校验，拒绝规范化后以 `//` 开头的路径（如 `/.//evil.com`、`/%2e//evil.com`），并补单元测试。
8. `apps/web/src/lib/directus.ts:56`：`getFeaturedProjects` 逐行校验，一条错误数据不能让全部卡片退回兜底。
9. `apps/web/src/components/MediaPlayer.tsx:320`：`linkTimeConsumed` 改为加载成功后再标记，避免重试时丢失 `?t=`。
10. `apps/web/src/components/PageTools.tsx:44`：`navigator.clipboard` 不存在时走已有的失败提示，不抛未捕获错误。
11. `DESIGN.md`：恢复被删除但仍然有效的规则：6 小时会话与跨标签页行为、快捷键不干扰输入和弹窗、媒体像素不加装饰、指向 `docs/upload-api.md` 的说明。
12. `apps/web/src/lib/player-viewing.ts:149-152`：组件卸载时不要恢复滚动位置，否则离开页面后下一页会跳动。
13. `.master-add`、`.info-toggle` 在触屏上提高到 44px。
14. `apps/web/src/components/AuthorMenu.tsx:50`：`notice` 在路由变化时清除。
15. **任务失败没有提示（本轮采用默认方案）：** `author-tasks.ts` 只跟踪进行中和已完成的状态，失败的任务直接从列表消失。失败时保留小点（颜色 `--danger`），直到作者打开面板查看。
16. **Codex 交叉审查：** 能力检测未确认兼容母版后，视频会卸载并在手动选择时重新挂载。观看监听必须跟随 `activeMaster` 是否存在重新绑定，不能仅依赖母版列表长度。

**修复后的验证：** 在有视频数据的环境里实际运行退场、全屏、Esc 恢复、`?t=` 和 0.35 倍速；运行 `tests/phase6-browser.cjs`、`tests/create-menu-browser.cjs` 和 `next build`，确认首页仍是静态页面。运行 `npm run test:api` 时设置 `FFMPEG_PATH`、`FFPROBE_PATH`、`VK_ICD_FILENAMES`，指向 `cms/bin/`；用系统 ffmpeg 会有 15 项媒体测试失败。

### 8.10 首页入口修订（2026-10-31，覆盖第 8.5 节和第 8.9 节的相关条目）

作者决定：首页只保留**一个**固定的"实验室"入口，链接到 `/project`，不展示具体项目。已实现：

- 首页操作行固定为实验室、GitHub、Bilibili 三项，所有断点已重排。类名改为 `.orbit-lab-entry`。
- 已删除 `getFeaturedProjects`、`projects:list` 标签、`external_projects` 的缓存刷新映射，以及 `scripts/setup-revalidate-flows.cjs` 中的 `external_projects`。
- 第 8.5 节中关于前 3 个 project、补位和长标题的要求作废；第 8.9 节第 6、8 项不再需要；第 5 项中 `getFeaturedProjects` 的部分不再需要。
- 如果已经运行过包含 `external_projects` 的 `setup-revalidate-flows.cjs`，需要在 Directus 中删除名为 `Web cache: external_projects:*` 的三个 Flow，否则它们会收到 400。

### 8.11 本轮交叉修复记录

- 修复前已创建基线提交 `7b8d8fd`，其中保留第 8.9 节的待办记录。
- 第 8.9 节第 1、2、16 项：区分鼠标与键盘焦点；手机横屏手动退出保持到竖屏；500px 高度上限排除平板；观看监听跟随实际视频挂载状态重新绑定。
- 第 4、5、7、9–14 项：更新空相簿文案；计数失败交给 ISR 保留上一版成功页面；规范化登录回跳路径；首次加载重试保留时间点；缺少剪贴板 API 时显示失败提示；恢复有效设计规则；卸载不恢复旧滚动；触屏按钮至少 44px；导航清除旧 notice。
- 钢笔图标保留。完成小点使用成功色并保留 6 秒；第 15 项采用默认方案，失败小点使用危险色，打开面板后清除未读提示，失败详情继续保留。任务详情仅保存在当前客户端会话，退出作者登录时清除。
- 第 6、8 项及第 5 项中的 featured-project 部分由第 8.10 节作废，本轮保留该并行改动，不再恢复已删除的缓存链路。
- 第 3 项代码改为 `⌘⌥⇧L` / `Ctrl+Alt+Shift+L`，使用物理 `KeyL` 兼容 Option 改变字符的键盘布局。Safari 26.2 的原生验证被“允许远程自动化”关闭阻塞；没有更改 Safari 设置，WebKit 页面测试不作为 Safari 应用层快捷键验证。
- 新增 `npm run test:phase6-cache`：生产构建后检查静态首页、CMS 故障时保留成功计数、恢复后的失效刷新，以及真实非 HTTPS 域名下的剪贴板缺失提示。移动端回归使用浏览器触控与方向模拟，不替代真机安全区或 Android 屏幕锁定验证。

### 8.12 回首页的划变（2026-10-31）

回首页时内容约 340ms 才到（开发环境无数据缓存），超过 180ms 的决策窗口，转场被跳过。已修复：删除 `(home)/loading.tsx`；`PageTransition` 新增 `HOME_DECISION_MS = 450`，只用于目标是 `/` 的导航，其他页面仍为 180ms；站点标题链接使用完整预取。涉及首页的转场通过 `html[data-vt-home]` 让页头随页面一起划变，分割线贯穿整个视口高度。

### 8.13 作者快速托盘

- 仅有效作者会话启用；沿用作者菜单的全部创作入口和当前相簿入口，不包含退出或提交操作。
- 在非输入区域按住 Tab 180ms，以当前鼠标坐标为圆心呼出圆形托盘。作者非输入区域的短按 Tab 在松开时前进到下一页内控件，末项回到首项；Shift+Tab 保持原生导航。输入框、编辑区、已有面板、弹窗和全屏状态不接管 Tab。
- 功能沿圆环排列，整块扇区都可选中。移动鼠标高亮功能，松开 Tab 执行；回到圆心的取消区或移出圆盘再松开则取消。也可按下鼠标拖动选项，但松开鼠标本身不会执行。初始光标位于圆心，不默认选中任何功能。
- Esc、窗口失焦、视口变化、路由变化或会话失效均取消。普通作者菜单保留，作为点击与键盘替代入口。
- 使用真实 Link 激活，继续经过写作页的未保存提醒和站内转场；不直接提交、上传或绕过鉴权。
- 圆盘是光圈外观：弧形叶片从近乎圆形的开孔切线旋出，第一项固定在正上方，标签位于各叶片重心；复用原图标与配色，直径 340–352px（标签不缩放，再小时两行标签会碰到叶片边缘），中心 36% 为取消区，透明背景层不改变媒体像素。靠近边缘时先提示向内移动，能留出 12px 边距后才展开，绝不通过挪动圆心来避让；窗口过小时提示使用普通作者菜单。减少动态效果时无入场动画。
- `npm run test:author-tray-browser` 使用隔离 CMS/API 和 headless WebKit；`TRAY_BROWSER=firefox` 可验证 Firefox。证据保存在 `test-results/author-tray-<browser>`。

### 8.12 作者圆盘：会话过期提示（2026-10-31）

作者设备的会话过期时，按住 Tab 显示"登录已过期，点钢笔图标重新登录"，松开后保留约 2.4 秒；不打开圆盘。短按 Tab 仍按原顺序移动焦点，访客不受影响。

### 8.14 失败任务的处理入口（2026-10-31）

- 工具面板里失败或中断的视频任务是一个链接，指向 `/upload?session=<id>`。链接只带任务 ID，读取时仍由上传 API 校验权限，所以其他设备发起的任务也能打开。
- 从链接进入时自动读取任务状态并显示失败原因，不需要再点"恢复上传 / 刷新状态"。服务器不支持原地重试，失败后的主操作是"重新上传"；中断的任务可能已经写入母版，主操作是"已确认，移除此任务"。
- 这两个操作会把任务记入本机的 `author-tasks-dismissed-v1`，任务随即从面板消失，刷新后也不会再亮红点。记录只保存在这台设备上；服务器上的任务仍保留到 `VIDEO_UPLOAD_TTL_HOURS` 到期。
- 胶片任务暂无跳转：`/author/tasks` 不返回相簿 ID，胶片导入窗口也不能按任务打开。
