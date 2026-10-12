# 按需失效联调记录（2026-09-16）

## 本轮已落实

- 生产本地环境文件生成 32 字节随机 REVALIDATE_SECRET，未输出密钥，git check-ignore 确认忽略。DIRECTUS_REVALIDATE=30、DIRECTUS_SHOW_DRAFTS=false 保持。
- Directus 11.17.4 上建立 15 条 active 事件 Flow：posts / video_projects / albums / album_photos / site_settings × create/update/delete，均指向 http://127.0.0.1:3000/internal/revalidate。
- 使用 action（提交后）触发，原始 $trigger 作为 JSON 请求体；每次最多三次 HTTP 尝试，耗尽后记录 [revalidate-failed] 和错误消息。不发送外部通知。activity 级审计避免完整执行日志记录请求密钥。日志尚无主动告警消费者，因此不满足小时级 TTL 的监控门槛。
- scripts/setup-revalidate-flows.cjs 可创建缺失 Flow；同名已有 Flow 保留不覆盖。若配置中断留下 inactive Flow 或需轮换密钥，必须检查并修复该 Flow，不能把重新执行脚本视为修复成功。
- About 的 CMS 正文、本地 Markdown 回退和文章详情复用 MarkdownImage；CMS About 的封面与正文元数据批量查询。原始资产注入真实宽高，带裁剪 preset 的 URL 不套用原图比例。外部图片、缺失元数据仍无尺寸保证。
- webhook 的 null、数组等 JSON 根节点返回无有效映射，避免空值触发异常；增加回归测试。

## 已验证结果

- npm run build:web：通过，含 TypeScript 检查。
- npm run test:web：8 个文件，102 项测试通过。
- npm run web:health：通过。但该检查针对现有 3000 开发进程，只证明页面可用，不能证明按需失效已上线。
- 真实 Web 服务账号登录 Directus：200；GET /files?fields=id,width,height 返回 200，样例图片 4229 × 2850。
- 真实 posts create/update/delete 已触发 Flow；仅使用本轮临时草稿并全部清理。失败分支及日志确实执行。
- 临时 next start 3001 生产实例启动成功，认证 POST /internal/revalidate 返回 200、albums:list。两次 /posts 完整响应约 751/40 ms，/about 约 102/41 ms。这些不是浏览器 TTFB，也不是优化前后对比。
- 同期 CMS 日志切片未观察到 GET，但第一轮也未观察到；不足以证明冷请求到源站、热请求命中 Data Cache。后续唯一 slug 冷缓存探针因临时服务不可达未完成，#4 仍待验收。
- 文章 Flow 曾临时指向 3001 进行联调，最终全部恢复到 3000；仍因下面的 IP 拒绝而未到达 Web。

## 新发现的实际阻塞

1. Directus 默认请求 IP 限制阻止回环 webhook。实测日志：Requested domain "127.0.0.1" resolves to a denied IP address。不能把 Flow active 当作端到端成功。未清空 IMPORT_IP_DENY_LIST 或放宽全局 SSRF 防护；需评估受限的同机访问方案后再重启 CMS 验证。
2. 3000 仍运行旧开发服务，未加载生产密钥，实际认证 POST 仍返回 503。项目 web:start / web:stop 均被持续活跃的 logs/service-operation.lock 拒绝，未删除锁或强杀其所有者。需先解决 Manager 正在持有的服务操作，再启动生产服务。
3. 浏览器工具初始化发生 Windows 沙箱错误，无法完成真实页面截图、交互走查、Performance trace 或 HAR。

## 对原清单的修正与剩余项

- #10 不是正确性缺口：getPost / getVideoProject / getAlbum 的详情 fetch 本来就同时绑定 list 和 slug 标签。albums:list 失效覆盖相册详情，照片删除或迁移也不会只靠 TTL。代价是全相册详情失效而非精准失效；已纠正相反的代码注释。
- #1 密钥已落盘但 3000 尚未生效；#2 Flow 已配置但回环受阻；#3 成功端到端仍未通过。
- #5 文件读取权限和返回结构通过；#8 健康检查已运行；#9 尺寸注入已补齐，视觉 CLS 验收仍待浏览器。
- #4 完整缓存命中证据、#6 导航阈值与边界、#7 blur 视觉/帧率、#15 八路由矩阵及桌面/移动 trace、HAR 尚未完成。缺少历史测量，不声称性能提升比例。
- #11 保持 30s，不进入 300–600s 观察期；#12–14 可选优化本轮未扩展。
- 前端技能静态审计运行后报 63 项历史/临时目录问题，主要为原生控件决策和滚动条规范；不能宣称全仓 UI 审计通过。原有 premium-audit.json 已恢复，本轮输出保留于 logs/revalidate-premium-audit.json。

## 下一轮验收顺序

先恢复 Manager 服务操作及受限的 Directus → Web 请求，再启动 3000 生产模式。验证无密钥 401、正确密钥 200、真实五集合事件成功；覆盖删除、slug/发布状态变更、照片迁移与失败恢复。随后用可观测冷请求与热请求证明 Data Cache，并补浏览器基线。确认失败监控可用后才考虑 300–600s TTL。
