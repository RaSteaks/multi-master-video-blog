# 在 Post 文章中展示 3DGS

Post 页面支持将带有 `3dgs` 语言标记的 Markdown 代码块渲染为交互式 Gaussian Splat 查看器。

## 1. 准备场景文件

建议将网页交付文件放在：

```text
media/
└── 3dgs/
    └── courtyard/
        ├── scene.sog
        └── poster.webp
```

支持以下场景入口：

- `.sog`
- `.ply`
- `.compressed.ply`
- `.meta.json`
- `.lod-meta.json`

网页发布优先使用 `.sog`；原始 `.ply` 通常更大，更适合编辑和归档。

## 2. 在 Directus 文章正文中插入

````markdown
## 交互式 3DGS 成果

```3dgs
{
  "title": "庭院扫描",
  "src": "/media/3dgs/courtyard/scene.sog",
  "poster": "/media/3dgs/courtyard/poster.webp",
  "height": 620,
  "background": "#050708",
  "cameraPosition": [0, 0, 2.5],
  "target": [0, 0, 0],
  "position": [0, 0, 0],
  "rotation": [0, 0, 0],
  "scale": [1, 1, 1]
}
```
````

发布后，读者点击封面上的 `Explore in 3D` 才会下载场景并启动 WebGL/WebGPU 渲染。

## 3. 配置字段

| 字段 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `src` | 是 | — | 场景文件 URL；建议使用站内 `/media/3dgs/...` 路径 |
| `title` | 否 | `Interactive 3DGS scene` | 查看器标题 |
| `poster` | 否 | 网格占位图 | 加载前显示的封面 |
| `height` | 否 | `620` | 桌面端高度，范围会限制在 360–820 px |
| `background` | 否 | `#050708` | 场景背景色，使用十六进制颜色 |
| `cameraPosition` | 否 | `[0, 0, 2.5]` | 初始相机坐标 |
| `target` | 否 | `[0, 0, 0]` | 相机环绕中心 |
| `position` | 否 | `[0, 0, 0]` | 场景位移 |
| `rotation` | 否 | `[0, 0, 0]` | 场景欧拉旋转角度 |
| `scale` | 否 | `[1, 1, 1]` | 场景缩放，三个值均不能为 0 |

## 4. 操作方式

- 左键拖动：环绕
- 右键拖动：平移
- 滚轮：缩放
- 触摸拖动或双指操作：移动端查看
- `Full screen`：进入全屏

## 5. 外部文件

`src` 和 `poster` 也支持 `https://` 或 `http://` URL。外部服务器需要允许网站域名跨域读取场景文件；为了访问稳定性和隐私，生产环境优先使用本站 `/media/` 路径。
