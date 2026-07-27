# 相簿与 HDR 照片

网站提供两个公开路由：

- `/albums`：已发布相簿的接触印样列表；“新建相簿”和“上传照片”只在这里出现。
- `/albums/[slug]`：已发布照片网格、无障碍灯箱和令牌保护的管理模式。

顶部导航仅提供“相簿”入口，不包含管理按钮。公开的服务端查询同时过滤
`albums.published=false` 和 `album_photos.published=false`。

## 数据模型

`albums`：

| 字段 | 说明 |
|------|------|
| `title` | 必填标题，最多 200 字符 |
| `slug` | 必填且唯一；创建后不再修改 |
| `description` | 可选说明 |
| `cover_image` | Directus SDR 文件 UUID |
| `published` | 公开或草稿 |
| `photos` | 指向 `album_photos` 的一对多别名 |

`album_photos`：

| 字段 | 说明 |
|------|------|
| `album_id` | 所属相簿；删除相簿时级联删除记录 |
| `sdr_image` | 必选 SDR 文件 |
| `hdr_image` | 可选 HDR AVIF 文件 |
| `caption` / `alt_text` | 画面说明与无障碍替代文本 |
| `hdr_transfer` | `pq` 或 `hlg` |
| `hdr_primaries` / `hdr_bit_depth` | FFprobe 得到的色域与位深 |
| `published` / `sort_order` | 发布状态与相簿内顺序 |

运行 `npm run setup:cms-schema` 会创建或补齐集合、字段、文件关系、
一对多关系及两个命名资源预设：

- `album-cover`：960×640、cover、WebP。
- `album-thumb`：720×720、contain、WebP。

页面和 Node 资产代理只会请求 `?key=album-cover` 或
`?key=album-thumb`；灯箱原图不带转换参数。Directus 的命名预设和
`key` 访问方式见 [Directus 文件接口](https://docs.directus.io/reference/files)。

## 新建相簿

在 `/albums` 点击“新建相簿”，输入 `UPLOAD_API_TOKEN`、标题、可选
slug、说明和发布状态。相簿默认立即发布。

- 显式 slug 只允许小写英文字母、数字和连字符。
- 未填写 slug 时，会先从英文标题生成。
- 中文等无法生成 ASCII slug 的标题使用
  `album-YYYYMMDD-短ID`。
- slug 创建后不能通过网页或 API 修改。
- 草稿不会出现在公开页面；在上传弹窗验证令牌并加载管理列表后可见。
  选择草稿后可直接打开完整管理工作区，无需先公开相簿。

## 上传与配对

上传弹窗有 SDR 与 HDR 两个拖放区。配对键是“去掉最后一个扩展名、
忽略大小写并 Unicode NFC 规范化”的文件名。例如：

```text
Night.Walk.JPG  ↔  night.walk.avif
portrait.webp   ↔  （无 HDR，合法）
```

以下情况会阻止整批提交：

- SDR 或 HDR 内出现重复配对键。
- HDR 没有同名 SDR。
- manifest 包含未知照片，或 SDR 照片没有 manifest 条目。
- 超过 24 张、单文件超过 64 MiB，或整批超过 512 MiB（默认值）。
- 扩展名、声明 MIME 与文件签名不一致。
- SDR AVIF 使用 PQ / HLG，或 HDR AVIF 不满足 HDR 合同。

服务端先接收到临时目录，再对整批执行 FFprobe：

- SDR：JPEG、PNG、WebP 或非 HDR AVIF。
- HDR：静态 AV1 AVIF，PQ (`smpte2084`) 或 HLG
  (`arib-std-b67`)，10 或 12 bit。
- SDR 与 HDR 的宽高比相对误差不得超过 0.5%。

所有文件完成验证后才开始写 Directus。每个文件带有本批唯一的对账
标记；Directus 响应中断时，API 会按标记及 SDR 文件关系重新发现已经
提交的文件和照片，再先逆序删除 `album_photos`、后逆序删除上传文件。
服务端不执行转码、色调映射或自动生成另一个动态范围版本。

## 封面、顺序与发布

- 没有封面时，本批第一张已发布 SDR 自动成为封面。
- “设为封面”只接受当前相簿的已发布照片，并写入其 SDR 文件。
- 当前封面照片被删除或取消发布时，API 自动选择排序最前的下一张
  已发布照片；没有候选时清空封面。
- 管理模式可前移/后移照片，并一次提交完整 ID 顺序。
- 照片可编辑说明、替代文本和发布状态；文件本身不能直接替换。
- 删除照片需要确认，并删除记录及其专属 SDR/HDR 文件。若记录已删除但
  文件清理失败，API 返回 `202` 和待清理文件 ID，网页明确显示部分失败。
- 网页不提供整本相簿删除；需要隐藏时把相簿切换为草稿。

所有成功的网页操作都会刷新服务端内容。

## HDR 显示与回退

封面和网格固定加载 SDR 命名预设。灯箱使用：

```html
<picture>
  <source
    media="(dynamic-range: high)"
    type="image/avif"
    srcset="/api/assets/HDR_FILE_ID"
  />
  <img src="/api/assets/SDR_FILE_ID" alt="..." />
</picture>
```

`dynamic-range: high` 表示浏览器和输出设备具备高峰值亮度、高对比度
和超过每通道 8 bit 的色深；规范也说明能力存在不代表 HDR 模式始终
处于启用状态。详见
[Media Queries Level 5](https://www.w3.org/TR/mediaqueries-5/#dynamic-range)。

AVIF 能承载 SDR、HDR 与 WCG，见
[AOM AVIF 规范](https://aomediacodec.github.io/av1-avif/)。
当 HDR source 加载或解码失败，灯箱移除 HDR 候选并立即重新加载 SDR。
支持的浏览器还会渐进应用 `dynamic-range-limit: no-limit`；Safari 26
的 HDR 图片与该属性说明见
[WebKit 发布说明](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/)。

灯箱支持左右方向键、Esc、关闭后的焦点恢复，以及移动端上一张/下一张
按钮。

## API

以下路由全部使用 `UPLOAD_API_TOKEN`：

| 方法 | 路由 | 用途 |
|------|------|------|
| `GET` | `/api/albums/manage` | 列出公开/草稿相簿及全部照片 |
| `POST` | `/api/albums` | 新建相簿 |
| `PATCH` | `/api/albums/:id` | 编辑标题、说明、发布状态 |
| `POST` | `/api/albums/:id/photos` | 批量上传 SDR/HDR |
| `PATCH` | `/api/albums/:id/photos/:photoId` | 编辑照片元数据和发布状态 |
| `DELETE` | `/api/albums/:id/photos/:photoId` | 删除照片及专属文件 |
| `POST` | `/api/albums/:id/photos/reorder` | 保存完整照片 ID 顺序 |
| `PUT` | `/api/albums/:id/cover` | 设置封面照片 |

浏览器通过 `Authorization: Bearer <token>` 发送令牌。组件不会调用
`localStorage`、`sessionStorage` 或 IndexedDB 保存令牌。

## 上线验证

```powershell
npm run setup:cms-schema
npm run test:cms-schema
npm run test:cms-crud
npm run test:api
npm run test:album-api
npm run test:web
npm run build:web
npm run api:restart
npm run web:restart
npm run health
```

测试至少应包含 SDR-only、SDR/HDR 成对、草稿过滤、无效令牌、重复或
孤立 HDR、8-bit HDR、错误传递函数、宽高比不符、超限、回滚、封面
切换、排序、键盘灯箱和移动端导航。

首版明确不支持 HEIC、JPEG XL、Ultra HDR JPEG、自动 SDR/HDR 转换、
EXIF/地点/标签筛选、私密访客鉴权或原位替换图片文件。
