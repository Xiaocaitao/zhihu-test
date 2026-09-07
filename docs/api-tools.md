# 官方 API → Tool 覆盖清单

核对日期：2026-08-31。来源：[官方文档中心](https://developer.zhihu.com/docs?key=authorization)。按文档实际给出的 endpoint 封装，不按产品优先级筛选。共 **21 个工具：20 个网络操作 + 1 个授权 URL 构造器**。

除 OAuth 两行外，基础域名均为 `https://developer.zhihu.com`。通用鉴权是 `Authorization: Bearer <Access Secret>` 和秒级 `X-Request-Timestamp`，属于客户端基础设施，不另造登录/验密 API。

| Tool | Method / endpoint | 工具参数 → 官方字段 | 官方文档 |
|---|---|---|---|
| `search_zhihu` | GET `/api/v1/content/zhihu_search` | `query` → Query；`count` → Count（1–10） | [知乎搜索](https://developer.zhihu.com/docs?key=zhihu_search) |
| `search_global` | GET `/api/v1/content/global_search` | `query`、`count`（1–20）、`filter`、`search_db` → Query/Count/Filter/SearchDB | [全网搜索](https://developer.zhihu.com/docs?key=global_search) |
| `get_zhihu_quota` | GET `/api/v1/quota` | `api_ids` 数组 → 逗号分隔的 APIIDs；可省略 | [额度](https://developer.zhihu.com/docs?key=quota) |
| `get_zhihu_hot_list` | GET `/api/v1/content/hot_list` | `limit` → Limit（1–30，默认 30） | [热榜](https://developer.zhihu.com/docs?key=hot_list) |
| `ask_zhihu` | POST `/v1/chat/completions` | `model`、`messages`、`stream`；JSON 或 SSE 响应 | [直答](https://developer.zhihu.com/docs?key=zhida) |
| `list_knowledge_bases` | GET `/api/v1/knowledge/bases` | `scope` → Scope（all/created/subscribed） | [知识库列表](https://developer.zhihu.com/docs?key=knowledge_bases) |
| `list_knowledge_items` | GET `/api/v1/knowledge/bases/{KnowledgeBaseID}/items` | `knowledge_base_id` 路径；`cursor`、`limit` → Cursor/Limit（1–20） | [知识库内容](https://developer.zhihu.com/docs?key=knowledge_base_items) |
| `upload_knowledge_file` | POST `/api/v1/knowledge/files` | 本地 `file_path` → multipart **File**；可选 `knowledge_base_id` → KnowledgeBaseID | [知识库上传](https://developer.zhihu.com/docs?key=knowledge_file_upload) |
| `search_knowledge` | POST `/api/v1/knowledge/search` | `query`、`knowledge_base_ids`、`recall_scopes`、`limit` → Query/KnowledgeBaseIDs/RecallScopes/Limit | [知识库检索](https://developer.zhihu.com/docs?key=knowledge_search) |
| `get_user_contents` | GET `/api/v1/user/contents` | `content_type` 必填；`offset`、`limit`（1–50）、`sort_field`、`sort_order` → PascalCase | [用户创作](https://developer.zhihu.com/docs?key=user_contents) |
| `get_user_followees` | GET `/api/v1/user/followees` | `offset`、`limit`（1–50） → Offset/Limit | [关注](https://developer.zhihu.com/docs?key=user_followees) |
| `get_user_collections` | GET `/api/v1/user/collections` | `limit` → Limit；无分页 | [近期收藏](https://developer.zhihu.com/docs?key=user_collections) |
| `get_user_favlists` | GET `/api/v1/user/favlists` | `limit` → Limit；无分页 | [收藏夹](https://developer.zhihu.com/docs?key=user_favlists) |
| `get_favlist_contents` | GET `/api/v1/user/favlist_contents` | `favlist_url_token`、`offset`、`limit` → FavlistUrlToken/Offset/Limit | [收藏夹内容](https://developer.zhihu.com/docs?key=favlist_contents) |
| `upload_pdf_file` | POST `/resources/v1/files` | 本地 `file_path` → multipart **file**；仅 PDF | [PDF](https://developer.zhihu.com/docs?key=pdf_parse) |
| `create_pdf_parse_task` | POST `/api/v1/pdf-parse/tasks` | `file_id` → JSON file_id；可选 `idempotency_key` → Header Idempotency-Key | [PDF](https://developer.zhihu.com/docs?key=pdf_parse) |
| `get_pdf_parse_task` | GET `/api/v1/pdf-parse/tasks/{task_id}` | `task_id` 路径 | [PDF](https://developer.zhihu.com/docs?key=pdf_parse) |
| `create_ppt_generation_task` | POST `/api/v1/ppt-generation/tasks` | `resource_url`、`num_pages`（6–21）→ JSON；可选 `idempotency_key` → Header | [PPT](https://developer.zhihu.com/docs?key=ppt_generation) |
| `get_ppt_generation_task` | GET `/api/v1/ppt-generation/tasks/{task_id}` | `task_id` 路径 | [PPT](https://developer.zhihu.com/docs?key=ppt_generation) |
| `get_zhihu_oauth_authorization_url` | 构造 GET `https://openapi.zhihu.com/authorize` URL | 工具输入 `{}`；服务端 appId/redirectUri → app_id/redirect_uri；response_type=code | [OAuth](https://developer.zhihu.com/docs?key=zhihu_oauth_integrated) |
| `exchange_zhihu_oauth_code` | POST `https://openapi.zhihu.com/access_token` | 工具输入 `{}`；服务端配置 → form app_id/app_key/grant_type/redirect_uri/code | [OAuth](https://developer.zhihu.com/docs?key=zhihu_oauth_integrated) |

## 协议细节

- 用户创作/关注 `Limit` 最大 50；最新收藏三份文档只给默认 20，未声明上限，因此客户端不猜测最大值。Offset 接受安全整数或十进制 Int64 字符串；收藏夹及知识库 ID 使用字符串。
- 知识库 Cursor 原样传递；用户分页使用 `Paging.NextOffset`，不将两种分页机制混用。两个不分页收藏接口拒绝 Offset。
- 知识库检索两个范围字段至少一个非空；同时传入取并集。Limit 数的是文档，不是片段。Content 保持 `string[]`。
- 知识库首次使用须在 [直答知识库](https://zhida.zhihu.com/repositories/square)完成初始化。
- 上传均限制非空、普通文件、100 MiB。知识库支持 pdf/md/txt/ppt/pptx/xlsx/xls/docx/doc/webp/png/jpg/mobi/epub/csv/azw3；PDF 上传只接受 PDF。两个 multipart 的字段名分别是 `File` 和 `file`，不能混淆；boundary 由 fetch 生成。
- PDF 文件上传后应在 24 小时内创建任务。PPT 只接受官方列出的知乎回答和专栏文章链接。
- 所有任务查询仅查一次。查询成功与任务成功分开判断；任务失败保留 `error` 字段，下载结果不自动打开。
- 写操作、用户数据、知识库、热榜和额度都不缓存；只有两个搜索工具缓存成功响应。POST 不重试，也不根据请求体合并调用；幂等键由服务端处理，返回 `meta.idempotent_replayed`。
- 默认短请求 15 秒，上传/直答 200 秒；超时、取消或网络断开不表示服务端写操作已回滚。
- OAuth 只有用户数据请求携带 `X-OAuth-Token`。通用接口仍是 Access Secret 身份。令牌不进入工具 JSON；换码结果是安全的授权状态映射，不是原始 token 响应。
- 直答仅封装文档保证的 model/messages/stream。支持三模型枚举和原始消息数组；具体多轮语义及模型权限由平台决定。SSE 支持心跳、跨网络包 UTF-8、CRLF/LF、错误帧及 [DONE] 检查。

## 不虚构的能力

- OAuth 文档提到“获取用户信息”，未提供 endpoint/请求响应，不能据此猜 `/user` 或其他 URL。
- 未给 refresh token、撤销、解绑、scope/PKCE 或 state 回传的正式协议，未增加这些工具。授权地址构造器不是生产 OAuth 登录实现。
- Skill/MCP/CLI 文档是接入方式，不是额外业务 API；不重复封装。
- API 返回的 result.url / OriginUrl 是结果地址，未额外暴露可请求任意 URL 的下载或 HTTP 工具，避免 SSRF 和凭证转发。

## 改造前链路与影响检查

原链路：`scripts/tool.ts → createZhihuTools/execute → Zod → ZhihuClient → fetch → Code/Message/Data → ToolResult`。

| 分类 | 已找到 | 未找到 / 不确定 | 改造风险 |
|---|---|---|---|
| 入口 | 命令行入口 scripts/tool.ts | HTTP 路由、RPC、MQ 消费、定时任务未找到 | 保持 CLI 和原 3 个工具兼容 |
| 传输层 | execute handler、工具注册、schema request/response | controller、HTTP router、中间件未找到 | 响应协议扩展到 JSON/SSE/form |
| 参数校验 | 必填、类型、范围、凭证检查 | 状态机、幂等、防重复提交及完整业务规则未找到 | 新增文件、ID、PPT URL、范围约束；幂等依赖服务端 |
| 业务逻辑 | ZhihuClient HTTP 封装 | application/domain service、manager、usecase、领域模型、状态流转未找到 | 不引入产品业务逻辑 |
| 数据库 | 无 | DAO、repository、mapper、SQL、ORM、事务、migration、索引、乐观锁、软删除均未找到 | 无迁移 |
| 跨服务 | fetch、15 秒超时、不重试 | RPC client、服务发现、熔断、降级未找到 | 固定两个官方域名，拒绝重定向 |
| 副作用 | 内存缓存读写/淘汰、并发请求去重 | MQ 发送/消费、异步任务、通知、审计、搜索索引更新未找到 | 新增上传和远端任务提交，不增加后台自动轮询 |
| 配置发布 | package.json、tsconfig、ZHIHU_ACCESS_SECRET | 功能/灰度/降级开关、发布回滚流程未找到 | 新增服务端 OAuth 与文件白名单；无部署操作 |
| 可观测性 | CLI JSON 结果/错误 | 监控指标、trace、告警未找到 | 不记录凭据、用户资料或原始错误响应 |
| 测试 | 单元/协议级 Mock、固定测试数据 | 真实接口集成、端到端测试未找到 | 继续 Mock，不能声称线上全量联调通过 |
| 外部协议 | 具体 endpoint 已核对 | OAuth 用户信息 endpoint、state/PKCE/刷新协议不确定 | 保留文档缺口，不猜造 |
