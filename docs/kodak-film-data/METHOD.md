# 检索、保存与复现说明

## 范围与检索顺序

本次以柯达胶片为对象，优先查找官网的摄影胶片、电影摄影胶片、电影中间片/拷贝片/声底/分色存档片、航空胶片及技术参考资料。再通过历史索引补充停产、改版及特殊用途胶片。

主要入口：

- [Kodak 摄影胶片](https://www.kodak.com/en/still-film/)
- [Kodak 电影摄影胶片](https://www.kodak.com/en/motion/products/camera-films/)
- [Kodak 电影后期胶片](https://www.kodak.com/en/motion/products/post/)
- [Kodak 航空成像](https://www.kodak.com/en/advanced-materials/product/aerial-imaging/)
- [Kodak Professional 资料索引](https://www.kodakprofessional.com/en-gb/node/133)
- [历史摄影胶片技术文件索引](https://125px.com/techdocs/kodak/)
- [历史电影胶片文件](https://125px.com/docs/motionpicture/kodak/)
- [历史未分类技术文件](https://125px.com/docs/unsorted/kodak/)

检索包括 PORTRA、EKTAR、GOLD、ULTRA MAX、PRO IMAGE、COLORPLUS、EKTACHROME、KODACHROME、ELITE、T-MAX、TRI-X、PLUS-X、PANATOMIC-X、VERICHROME、TECHNICAL PAN、HIE/EIR、VISION/VISION2/VISION3、EASTMAN/EXR、AEROCHROME/AEROCOLOR、IMAGELINK 等系列。名称命中不等于每个地区、年份和乳剂版本都有独立数据表。

## 保存的数据

- PDF 原始字节，以及 SHA-256、来源地址、重定向地址、托管类别、页数、下载时间。
- 按页提取的全文；文件中可包含感光度、冲洗条件、特性曲线、光谱灵敏度、光谱染料密度、MTF、颗粒度及互易律数据。不同资料所含项目不同。
- 历史索引直接给出的型号名称、胶片代码、感光度标签、出版编号和版本日期。目录服务器的修改时间不当作出版日期。
- 密度关键词页与明确曲线标题页，仅作定位。尚未逐条人工转录数值，也未把图形数字化为可用于扫描标定的 RGB 曲线数组。
- 官网产品页和历史索引 HTML 源码快照。网页链接失效和文件下载失败均保留记录。

## 分类与质量

分类按型号记录、文件名、首页文字与来源路径自动判断，属于检索分类，可能需人工微调。综合手册和相邻技术资料放在 reference-and-unclassified，不计作独立型号。

312 份去重 PDF 已通过 SHA-256、可打开性和页数检查；254 份检出明确曲线标题。43 份唯一 PDF 可由官方域名下载。历史索引中提取到 96 组“名称＋胶片代码”，这不是本库全部型号的统计，也不代表 96 种独立乳剂。

28 份原文件产生解析警告（例如字体、ICC 色彩配置或内容流问题），4 份未检出 Kodak/Eastman 文字，经首页渲染抽查，四份均可见 Kodak 标识，属于图像页或文字编码导致的检索缺失。人工核对记录保存在 overrides.json；其中 2475 首页可见曲线。详细名单见 [validation.json](validation.json)，逐文件警告见 [manifest.json](manifest.json)。保留原始字节，不通过重新导出来掩盖问题。重要曲线应打开 PDF 逐页核对。

## Git 保存范围

原始 PDF、网页快照和提取文本保存在本地，并由项目 .gitignore 忽略；索引、来源清单、人工核对记录和采集脚本可提交。新检出仓库中的本地资料链接需要先执行下面的采集命令恢复文件。

## 复现与增补

从项目根目录执行（Python 3.10+；需要 requests、PyMuPDF）：

~~~powershell
python scripts/collect-kodak-film-data.py --discover --max-pages 140
python scripts/index-kodak-film-data.py
~~~

下载请求使用线程池；PDF 校验、文本提取和归档在主线程逐份执行，避免多个线程同时调用 PyMuPDF。可运行 `python scripts/test-collect-kodak-film-data.py` 进行离线回归测试。

第一步发现来源并下载，已成功保存的文件可复用；第二步校验、整理分类并生成索引。补充的明确来源放入 extra-sources.json。未分类历史目录仅选取 E/F/TI/P255 和胶片相关文件名，避免将全部化学品和设备文档混入。

覆盖缺口见 [SOURCES.md](SOURCES.md)。本库为本地研究资料，未公开发布；不能保证囊括柯达百余年历史的全部型号。
