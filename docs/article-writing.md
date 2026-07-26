# 网站内写文章

网站提供 `/write` 页面，用于直接编写 Markdown 文章、上传封面和正文图片，再由 Node API 将文件和文章写入 Directus。浏览器不会持有 Directus 账号，也不会直接调用 Directus 的写接口。

## 架构与数据流

```text
浏览器 /write
    │
    │ POST /api/articles
    │ multipart/form-data + 文章令牌
    ▼
Nginx /api/
    │
    │ 去掉 /api 前缀
    ▼
Node API 127.0.0.1:8060/articles
    ├── 校验令牌、字段、文件类型和大小
    ├── 将封面与正文图片上传到 Directus Files
    ├── 将 article-image://... 占位符替换为站内图片 URL
    └── 在 Directus posts 集合中创建或更新文章
```

Directus 中使用的文章字段是：

| 字段 | 类型与用途 |
|---|---|
| `title` | 必填标题 |
| `slug` | 必填、唯一的 URL 标识 |
| `content` | 替换完图片占位符后的 Markdown |
| `cover_image` | Directus 文件 UUID |
| `tags` | JSON 字符串数组 |
| `category` | 可选分类 |
| `published` | `false` 为草稿，`true` 为发布 |
| `created_at`、`updated_at` | 文章时间 |

不要使用 README 旧示例中的 `body`、`cover` 或 `status` 作为 Directus 字段名。

## 配置

在 `apps/api/.env` 中设置：

```env
ARTICLE_API_TOKEN=replace-with-a-long-random-token
MAX_ARTICLE_UPLOAD_BYTES=67108864
MAX_ARTICLE_IMAGE_BYTES=12582912
MAX_ARTICLE_MARKDOWN_BYTES=2097152
MAX_ARTICLE_IMAGES=24
```

各项含义如下：

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `ARTICLE_API_TOKEN` | 回退到 `UPLOAD_API_TOKEN` | 写文章接口的共享令牌；生产环境应单独显式配置 |
| `MAX_ARTICLE_UPLOAD_BYTES` | 64 MiB | 一次文章 multipart 请求的总上传上限 |
| `MAX_ARTICLE_IMAGE_BYTES` | 12 MiB | 每个封面或正文图片的上限 |
| `MAX_ARTICLE_MARKDOWN_BYTES` | 2 MiB | Markdown 正文的 UTF-8 字节上限 |
| `MAX_ARTICLE_IMAGES` | 24 | 一篇文章允许上传的正文图片数量 |

如果 `ARTICLE_API_TOKEN` 和回退用的 `UPLOAD_API_TOKEN` 都为空，文章发布接口会保持禁用并返回 `503`。示例文件中的 `__REPLACE_WITH_RANDOM_ARTICLE_TOKEN__` 是禁用哨兵值，必须替换为随机令牌；API 不会接受该值。修改 `.env` 后需要重启 API 服务。

API 还使用以下仅服务端可见的 Directus 配置：

```env
DIRECTUS_URL=http://127.0.0.1:8055
DIRECTUS_EMAIL=article-service@example.com
DIRECTUS_PASSWORD=replace-with-service-account-password
```

生产环境建议使用权限受限的 Directus 服务账号，并按当前 Node API 启用的文章、视频、分析与资产代理功能授予最小权限；如果需要更严格的隔离，可进一步拆分文章专用凭据。不要将 Directus 密码或 `ARTICLE_API_TOKEN` 写入 `NEXT_PUBLIC_*` 环境变量、前端源码、URL 查询参数或 Git。

## 页面使用

1. 打开 `/write`。
2. 在访问令牌输入框中填写 `ARTICLE_API_TOKEN`。
3. 填写标题和 `slug`。`slug` 只能包含小写英文字母、数字和连字符，例如 `directus-image-workflow`。
4. 可选填写分类和标签，并选择一张封面图。
5. 在编辑器中编写 Markdown。可以通过工具栏插入正文图片和普通链接，并在预览区检查结果。
6. 选择“保存草稿”或“发布”，然后提交。

页面向外部地址 `POST /api/articles` 发送 `multipart/form-data`。认证可使用以下任一请求头：

```http
X-Article-Token: <token>
```

```http
Authorization: Bearer <token>
```

表单契约如下：

| 字段 | 形式 | 说明 |
|---|---|---|
| `title` | 文本 | 文章标题 |
| `slug` | 文本 | 唯一 URL 标识 |
| `content` | 文本 | Markdown，可包含正文图片占位符 |
| `category` | 文本 | 可选 |
| `tags` | JSON 文本 | 字符串数组，例如 `["Directus","Markdown"]` |
| `published` | 文本布尔值 | `false` 保存草稿，`true` 发布 |
| `cover` | 单个文件 | 可选封面图 |
| `inlineImages` | 重复文件字段 | 正文图片，顺序必须与清单一致 |
| `inlineImageManifest` | JSON 文本 | 正文图片的 `key`、`name`、`alt` 清单 |
| `articleId` | 正整数文本 | 首次创建后由页面自动带回；存在时更新该文章 |
| `removeCover` | 文本布尔值 | 更新时是否清除已有封面 |

字段级限制：`title` 和 `slug` 最长 200 字符，`category` 最长 100 字符；最多 30 个标签，每项最长 64 字符；图片清单中的 `name` 最长 255 字符、`alt` 最长 300 字符。发布文章时正文不能为空；草稿可保留空正文，但当前 `/write` 页面仍要求先填写正文再提交。

首次提交不带 `articleId`，API 创建文章并返回 ID；页面会保留这个 ID，之后可继续保存同一草稿、将草稿发布或更新已发布文章。未带自身 `articleId` 却重复使用已有 `slug`，或把 slug 改成其他文章正在使用的值，都会返回 `409`。

## 正文图片占位符

浏览器无法在 Directus 文件上传完成前知道图片 UUID，因此编辑阶段使用临时占位符：

```markdown
![系统架构](article-image://architecture-1)
```

与它对应的清单是：

```json
[
  {
    "key": "architecture-1",
    "name": "architecture.png",
    "alt": "系统架构"
  }
]
```

同一个请求中，第一个 `inlineImages` 文件对应清单第一项，第二个文件对应第二项，以此类推。`key` 必须唯一，并与 Markdown 中 `article-image://<key>` 的值完全一致。

Node API 会依次执行：

1. 校验正文中的占位符、图片清单和上传文件能够一一对应。
2. 将图片上传到 Directus Files，取得文件 UUID。
3. 把 `article-image://<key>` 替换为 `/api/assets/<文件 UUID>`。
4. 将替换后的 Markdown 写入 `posts.content`。

因此 Directus 中保存的是最终可渲染的 Markdown，不是本地文件路径、Base64 图片或临时占位符。封面不写入 Markdown，而是把上传结果 UUID 写入 `posts.cover_image`。

支持的图片格式为 JPEG、PNG、WebP、GIF 和 AVIF。文件扩展名、浏览器提交的 MIME 类型和文件内容应保持一致。普通链接不需要清单，例如：

```markdown
[Directus 文档](https://directus.io/docs/)
```

## 草稿与发布

“保存草稿”提交 `published=false`；“发布”提交 `published=true`。第一次保存后，当前页面会在后续请求中携带返回的 `articleId`，所以可以继续更新草稿并直接发布。已发布文章继续保存时会保持发布状态。网站读取文章时默认附加 `published=true` 过滤条件，所以草稿写入 Directus 后不会出现在公开文章列表或详情页。

`articleId` 目前保存在当前编辑器会话中；刷新或关闭页面后，仍可在 Directus 中管理已保存草稿，但 `/write` 暂不提供按 ID 重新载入旧草稿的界面。

开发环境可以用 `DIRECTUS_SHOW_DRAFTS=true` 查看草稿，生产环境应保持为 `false`。如果设置了 `DIRECTUS_REVALIDATE`，新发布内容可能要等待对应的缓存周期；默认值 `0` 使用无缓存读取。

## Nginx 路由

生产环境的外部接口是 `/api/articles`，Node API 内部端点是 `/articles`。`proxy_pass` 末尾的 `/` 负责去掉 `/api/` 前缀：

```nginx
location /api/ {
    proxy_pass http://127.0.0.1:8060/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}
```

同时确保 `client_max_body_size` 不小于 `MAX_ARTICLE_UPLOAD_BYTES`。`127.0.0.1:8060` 和 Directus 的 `127.0.0.1:8055` 应只在本机监听，公网只开放 HTTPS 的 443 端口。站内正文图片使用 `/api/assets/<uuid>`，该地址也会通过同一 `/api/` 代理交给 Node API。

## 安全要点

- 生产环境必须使用 HTTPS，否则文章令牌和正文会以明文传输。
- 使用足够长的随机 `ARTICLE_API_TOKEN`，并定期轮换；不要与 Directus 管理员密码相同。
- `/write` 页面可被访问不等于获得写权限，真正的写入保护由 API 令牌完成。若网站面向不可信公网，建议再增加账号登录、IP 限制或反向代理访问控制。
- 不要直接从浏览器调用 Directus `/files` 或 `/items/posts`，也不要把 Directus 管理员令牌返回给浏览器。
- 保持上传数量、单文件、正文和总请求限制；Nginx 与 Node API 两层都应有限制。
- 对外部链接和图片替代文本进行人工检查。不要在 Markdown 中粘贴未知脚本、敏感信息或内部管理地址。
- 数据库与 Directus 上传目录需要一起备份；文章正文仅保存正文图片 URL，不能替代文件备份。

## 故障排查

| 现象 | 检查项 |
|---|---|
| `401 Missing or invalid article API token` | 令牌是否与 `apps/api/.env` 一致；请求是否使用 `X-Article-Token` 或 Bearer；修改后是否重启 API |
| `503 Article publishing is disabled` | `ARTICLE_API_TOKEN` 和 `UPLOAD_API_TOKEN` 是否都为空 |
| 外部 `/api/articles` 返回 `404` | Nginx `/api/` 是否带尾部斜杠代理到 `127.0.0.1:8060/`；不要把外部路径直接代理成内部 `/api/articles` |
| `413` 或请求在 Nginx 被拒绝 | 检查 `client_max_body_size`、总请求上限、单图片上限、Markdown 上限和图片数量 |
| `400` 字段校验失败 | 检查必填字段、slug 格式、`tags` JSON，以及占位符、清单、文件顺序是否一一对应 |
| `415` 图片被拒绝 | 检查图片扩展名、请求 MIME 与真实文件签名是否一致；不支持 SVG |
| slug 冲突 | 在 Directus `posts` 中检查同名 slug，并为新文章使用唯一值 |
| 取消或断网后状态不确定 | 请求可能已到达服务端；先在文章库或 Directus 中确认是否已保存，再决定是否重试 |
| Directus 登录或写入失败 | 检查 `DIRECTUS_URL`、服务账号密码和 `posts`/Files 权限；确认 Directus 仅在本机可达 |
| 文章已保存但网站不可见 | 检查 `published` 是否为 `true`，以及 `DIRECTUS_SHOW_DRAFTS` 和 `DIRECTUS_REVALIDATE` |
| 封面或正文图片损坏 | 检查 Directus Files 中是否存在对应 UUID，并确认 `/api/assets/<uuid>` 能通过 Nginx 到达 Node API |

出现失败时先查看 Node API 和 Directus 日志。日志中不要打印请求令牌、Directus 密码或完整的敏感正文。
