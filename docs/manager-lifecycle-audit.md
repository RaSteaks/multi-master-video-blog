# Manager 与 Windows 启停检查

本次检查覆盖页面操作、服务端路由、共享 PowerShell 执行器、Windows 启动脚本及本地批处理入口。

## 已修复

- Manager 与 CLI 共用启停实现，并使用 proper-lockfile 跨进程互斥；重叠操作返回 409，不排队重复执行。
- 启动已有监听器时仍检查健康状态；HTTP 与 Manager 数据库查询设定超时。
- 生产构建先停止 Web，避免读写同一个 .next 输出目录；开发模式的 Build + Restart 只执行重启；空构建退出码视为失败。
- 切换模式在健康检查成功后才持久化；失败时恢复此前模式并尝试重新启动，恢复失败会明确报错。
- 整栈启动在依赖失败时停止继续启动；整栈重启的停止阶段失败后仍尝试恢复已停止服务，但保留原失败信息。
- 进程停止容忍正常退出竞态，保留真实失败；祖先遍历保护 Manager/CLI 自身及其父进程，限制祖先类型并检查 PID 重用与循环。
- Manager 启动脚本从脚本位置计算项目根目录、读取配置端口；等待其启动 PID 实际监听，启动退出或超时返回失败；端口由其他程序占用时拒绝误报成功或停止它。
- 页面丢弃操作前的旧状态响应，操作中重新渲染的按钮保持禁用；长操作和错误提示保持可见。
- 页面采用同一确认对话框，支持取消、Escape 和初始取消焦点；令牌保存后 API 重启失败显示错误状态。
- stop-services.ps1 保留仅停止应用进程及 Ports 参数的范围；start-services.ps1 使用完整依赖顺序启动 PostgreSQL、CMS、API、Web。

## 使用

重新加载 Manager（控制 PostgreSQL 通常需要管理员 PowerShell）：

```powershell
npm run manager:restart
```

常用命令仍为 `npm run web:start`、`npm run web:restart`、`npm run api:restart`。统一入口也可直接使用：

```powershell
node scripts/service-control.cjs stack restart-all
node scripts/service-control.cjs cms start
```

Web 默认遵循 MANAGER_WEB_MODE；显式传入 web-service.ps1 的 NpmScript 只覆盖本次 CLI 进程。页面模式显示的是 Manager 配置，不是对外部手动启动进程的模式识别。

## 验证

- 18 项 PowerShell/生命周期回归测试通过：竞态、权限失败、UTF-8、并发锁、失败后释放锁、构建顺序、模式回滚、依赖失败、重启恢复、超时与脚本解析。
- 1 项 Windows 真实进程测试通过：隔离端口上的启动、重复启动、重启 PID 变化、重复停止及启动进程提前退出。
- Edge 无头浏览器隔离测试通过：操作等待/成功/失败、超过 12 秒错误仍可见、对话框取消/确认/Escape/焦点、390px 宽度无横向溢出、无页面异常。
- 所有 Windows PowerShell 脚本语法检查及 git diff --check 通过。
- 可重复运行服务端测试：`npm run test:manager`。启动器测试使用临时目录与测试端口，不控制实际数据库。

## 验证边界与注意事项

- 未对真实 PostgreSQL、CMS、API 或 Web 执行停止/重启，也未执行真实生产构建；生产构建和失败回滚顺序通过隔离测试验证。
- 生产构建期间 Web 会停机；构建本身失败时普通重建操作不会自动恢复旧产物。模式切换会尝试恢复旧模式，恢复仍可能失败。
- 文件锁异常退出后最多需等待约 120 秒变为过期；不要在操作仍运行时手动删除锁。
- 本地 start-*.bat 文件受现有 .gitignore 排除；本机入口已更新，仓库共享实现位于 scripts/service-control.cjs 和 deployment/windows。
- 全仓库 premium UI 静态审查未通过：含既有页面的设计契约/控件问题，且默认扫描把 media 下 .ts 视频分片误当 TypeScript。结果位于 tmp/manager-ui-audit.json；本次未扩展修改无关网站页面，不能据此声称全站 UI 合规。

## Start All 持续占用修复（2026-09-16）

- 根因：Windows PowerShell 已退出后，Start-Process 启动的常驻服务仍持有继承的管道句柄，Node execFile 一直等不到管道关闭，导致 Start All 无法释放操作锁。
- 修复：在确认 PowerShell 退出后留出 250ms 排空输出，再关闭执行器的 stdout/stderr 读取端；保留服务自身的运行状态、文件日志和原有互斥控制。此处理不对仍在运行的 PowerShell 命令强制超时。
- 回归：增加真实 npm 常驻服务测试，检查服务仍健康时启动操作能结束、下一操作能取得锁，以及 stdout/stderr 日志正常写入；完整 `npm run test:manager` 共 22 项通过。
- 实机 Directus 冷启动约 64 秒，超过此前 30 秒等待期限；默认 MANAGER_WAIT_MS 调整为 90000，显式环境变量仍可覆盖。
- 实机验证：经用户 UAC 授权，以管理员身份重载 Manager 后，`POST /manager/api/stack/restart-all` 返回 200；PostgreSQL、CMS、API、Web 均健康，三个应用监听 PID 全部变化，Manager 的 activeOperation 为 null。此前“未对真实服务执行重启”的验证边界仅对应早期检查。
