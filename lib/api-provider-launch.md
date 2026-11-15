# API 提供方启动候选

此模块只负责构造一次性 Codex app-server 启动参数，不修改已有 ChatGPT 登录、Codex 配置、Revit 工具目录或正在运行的服务。客户端有默认关闭的内部注入候选；它尚未接入面板或运行中的服务，不是可交付的 API 连接功能。

`internal-api-client.mjs` 提供内部组合候选，固定使用现有 model-workspace 和完整 Revit 工具目录校验。该 profile 已声明项目动态工具，因此调用 `start()` 前必须由可信组合方为 `dynamic-tool-request` 注册请求 owner；没有 owner 时客户端拒绝启动。单独创建该对象不会提供工具所有权，测试中的拒绝处理器也不证明项目工具已接通。它不启动服务、不提供用户界面或付费系统。面板的 ChatGPT 确认流程不会确认此模式；内部确认及路由仍需实现。若未来由 BuildX 统一提供收费服务，公司的共享 API Key 必须留在受控服务端，不能随此客户端模块分发到用户电脑。

现阶段不会向产品用户显示 API 模式或收取密钥。**启动候选当前严格限制为内部显式启用的字面回环 HTTP 测试，且只接受公开的固定测试标记，不接收真实 Key；HTTPS 和所有非回环地址在构造启动器时被拒绝。** 此测试开关不暴露给用户页面或 HTTP 接口。这比此前可创建远程启动器的候选更受限：真实服务端凭据边界未完成前，不支持真实提供商或客户自带 Key。模块不推断是否与供应商兼容，配置有效、进程启动或模型列表返回均不能证明 AI 请求或 Revit 工具调用成功。

`createApiProviderLaunch` 产生仅包含公开配置的 `configOverrides`，以及 `describe()`、`start()`、`dispose()`。`describe().identity` 只含 `type: 'api_key'`、随机 `providerId`、随机 `providerRevision` 和 `model`，并始终标记未验证；它不含密钥、密钥摘要或 URL。随机 provider ID 避免与已有静态同名 provider 表合并。`start()` 只允许使用一次，由可信宿主传入进程执行器、可执行文件、现有 profile 的启动参数和普通环境变量对象。公开测试标记通过子进程环境变量传递，不写入命令行或配置文件；之后释放模块持有的引用。JavaScript 字符串不可保证内存擦除。

每次启动生成独立随机环境变量名，以减少既有静态 MCP `env_vars` 意外转发测试标记；旧固定变量也从新子进程环境中移除。这不能阻止同一用户的恶意进程或能够读取父进程环境的插件，不能作为密钥隔离边界。恢复真实 API 能力前，必须先完成受控服务端密钥保管与访问控制、网关和凭据生命周期，并验证真实供应商认证、Responses 流式和工具调用；不得读取、复制、清除已有 ChatGPT 凭据。客户端的 API 身份仅表示测试配置归属，`modelAvailability` 保持 `unverified`，不代表推理成功。

运行 `node --test tests/api-provider-launch.test.mjs tests/internal-api-client.test.mjs` 可验证隔离单元测试，包含一个仅接收合成测试值的 Node 进程。`workbench/experiments/api-provider/` 下的真实 Codex 测试使用回环模拟 Responses/MCP，但**回环模型地址和临时 Codex 目录不能证明整个进程强制离线**。2026-10-29 的一次独立探针中，Codex 后代 Git 访问了 GitHub，专属临时目录中出现已获取的对象包和 `curated-sync` 引用；同批其他测试是否发生外联未知。该次没有连接真实模型供应商或 Revit 的证据，但不能声称没有外网活动。此前相关文档中的“完全无外网”表述不成立。未建立并验证覆盖全部后代的强制离线隔离前，不再运行真实 Codex 探针；它也不能证明任何真实供应商兼容。
