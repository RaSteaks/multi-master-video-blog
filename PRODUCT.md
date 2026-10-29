# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

主要访客是影像技术同好：调色、摄影、HDR 工作流方向的同行与爱好者。他们来读技术文章，并在自己的显示设备（常见 HDR 设备）上观看、对比同一作品的不同母版，以及 SDR / HDR 照片。

发布与管理界面（`/write` 写作台、`/upload` 视频上传、相簿上传、胶片扫描导入，以及 Directus 后台）服务于站点作者本人。

## Product Purpose

面向个人创作者的自托管媒体博客，发布文章、多母版视频项目、SDR / HDR 相簿和 3DGS 内容。

成功意味着：

- **影像按母版意图呈现**：访客看到未经平台二次压缩、色彩准确的原片，并能在 SDR、HDR10、HLG、Dolby Vision 之间切换对比。
- **完全自主掌控**：数据、呈现方式和发布节奏不受第三方平台的规则、算法与广告影响。
- **长期记录与沉淀**：站点是作者影像与技术积累的长期档案。

## Positioning

通用视频与博客平台会统一转码、压缩并常把 HDR 降为 SDR。本站在浏览器内提供同一作品多个母版的切换对比，HDR 设备上的相簿灯箱显示 PQ / HLG 原片，并把上传、转码、存储到呈现的整条链路放在作者自己的服务器上。

## Operating Context

- 访客使用桌面或移动浏览器，显示设备从普通 SDR 屏到 HDR 屏不等。
- 作者通过 Directus CMS、站内写作台和上传 API 发布内容。上传后由 FFmpeg 生成 HLS，FFprobe 提取色彩空间、位深、码率等技术元数据。
- 部署在自托管的 Windows、Linux（systemd）或 Docker Compose 主机上，由 Nginx 提供 HTTPS 与媒体服务，需兼容低内存主机。

## Capabilities and Constraints

功能：文章（Markdown、封面、标签、分类、草稿 / 发布）、站内写作与预览、多母版视频与 HLS 自适应播放、SDR / HDR 配对相簿、胶片扫描导入、文章内嵌 3DGS 查看器、外观与液体背景偏好设置。

硬约束（作者确认）：

- **媒体画面不受装饰影响**：视频、照片和母版对比画面上不得出现改变色彩、亮度或模糊的装饰效果。
- **HDR 体验优先，SDR 可用**：优先保证 HDR 设备上的显示效果，SDR 设备必须能正常打开、正确显示。
- **低配置可运行**：功能与视觉效果要在低内存自托管主机和访客的普通设备上成立。

界面与现有内容目前以简体中文为主。

## Brand Commitments

现有名称：站点标题默认为 "Multi Master Video Blog"（可通过 `SITE_TITLE` 配置）；仓库 README 以「今天色彩空间设对了吗？」为题。

## Evidence on Hand

- 技术文档：`docs/film-scan-color-science.md`、`docs/3dgs-posts.md`、`docs/video-workflow.md`，以及 `docs/kodak-film-data/` 中的第三方胶片技术资料。
- 关于页模板：`apps/web/content/about.example.md`。
- 杜比视界测试素材：`apps/api/test/fixtures/`（仅用于测试）。

目前没有访客评价、受众数据、媒体报道或合作案例，后续工作不得编造。

## Product Principles

1. **母版意图优先**：任何界面层都不能改变作品本身的观感，界面服务于作品的准确呈现。
2. **HDR 是一等公民，SDR 是可靠底线**：为 HDR 设计，为 SDR 兜底。
3. **轻量可自持**：每个功能和效果都要在低配置自托管主机与普通访客设备上站得住。
4. **为长期而建**：内容是长期档案，结构与链接要经得起时间。
