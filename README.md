# 破雾 · 知乎开放平台 Tools

对照 2026-08-31 官方文档，提供 **21 个 TypeScript 工具**，覆盖所有给出具体请求协议的接口，包括 OAuth 授权地址构造。当前是独立工具层，不包含 Pi SDK/MCP 适配、LLM 编排、Web 页面或数据库。

完整 endpoint、参数与限制见 [API 覆盖清单](docs/api-tools.md)。原始产品需求见 [PRD](docs/PRD.md)。

## 工具分组

| 分组 | 工具 |
|---|---|
| 公共内容与额度（5） | `search_zhihu`、`search_global`、`get_zhihu_quota`、`get_zhihu_hot_list`、`ask_zhihu` |
| 知识库（4） | `list_knowledge_bases`、`list_knowledge_items`、`upload_knowledge_file`、`search_knowledge` |
| 用户数据（5） | `get_user_contents`、`get_user_followees`、`get_user_collections`、`get_user_favlists`、`get_favlist_contents` |
| PDF 解析（3） | `upload_pdf_file`、`create_pdf_parse_task`、`get_pdf_parse_task` |
| PPT 生成（2） | `create_ppt_generation_task`、`get_ppt_generation_task` |
| OAuth（2） | `get_zhihu_oauth_authorization_url`、`exchange_zhihu_oauth_code` |

## 本地运行

需要 Node.js 22.18+，使用 Node 内置 TypeScript 支持。依赖安装后不需要构建：

```bash
npm ci
cp .env.example .env
```

仅在本机 `.env` 中配置 `ZHIHU_ACCESS_SECRET`；从 [个人中心](https://developer.zhihu.com/profile)获取。不要把密钥发给模型、放在工具 JSON 中或提交 Git。

```bash
# 无需凭证，列出 21 个工具的完整 JSON Schema、endpoint 和副作用标记
npm run tool -- list

# 以下调用需要凭证；除额度查询外可能消耗接口额度
npm run tool -- get_zhihu_quota '{}'
npm run tool -- search_zhihu '{"query":"计算机 大一 学习路线","count":3}'
npm run tool -- get_zhihu_hot_list '{"limit":5}'
npm run tool -- list_knowledge_bases '{"scope":"all"}'
npm run tool -- get_user_contents '{"content_type":"all","limit":1}'
npm run tool -- ask_zhihu '{"model":"zhida-fast-1p5","messages":[{"role":"user","content":"如何入门编程？"}],"stream":false}'

npm run typecheck
npm test
```

失败输出 `ok: false` 并使用非零退出码。不自动重试、不自动翻页、不自动轮询或下载结果文件。

## 上传和任务创建

这些工具均已实现，但不能仅靠模型输出就执行副作用。工具的 `requiresConfirmation` 为 `true`，可信宿主确认具体操作后，传入 `execute(input, { confirmed: true })`。`confirmed` 不在模型可填写的参数里。

CLI 的 `--approve` 表示操作者批准当前命令；上传时也只授权本次指定文件：

```bash
npm run tool -- upload_pdf_file '{"file_path":"/absolute/path/document.pdf"}' --approve
# 用实际上传返回的 file_id 替换示例值
npm run tool -- create_pdf_parse_task '{"file_id":"file_from_upload","idempotency_key":"my-pdf-request-001"}' --approve
npm run tool -- get_pdf_parse_task '{"task_id":"pdf_from_create"}'

npm run tool -- create_ppt_generation_task '{"resource_url":"https://www.zhihu.com/answer/123456789","num_pages":12,"idempotency_key":"my-ppt-request-001"}' --approve
```

示例 ID/URL 只是占位值。创建任务不代表任务已完成：查询结果中的 `task_status` 才表示 `pending`、`running`、`succeeded` 或 `failed`。`ok: true` 表示查询本身成功，即使任务状态为 `failed`。下载链接会过期，过期后重新查询即可，工具不会携带鉴权头访问外部下载地址。

SDK 上传还必须配置 `allowedUploadFiles`，精确到已获授权的单个文件；默认空白名单。校验文件大小、扩展名、文件名、普通文件类型与 PDF 文件头，并限制读取大小。白名单不能替代宿主的用户权限检查；不要部署为所有匿名用户均可访问的接口。

## 服务端接入

```ts
import { ZhihuClient } from "./src/zhihu/client.ts";
import { createZhihuTools } from "./src/agent/tools.ts";

// 每个用户会话独立实例，同一会话内复用。
const client = new ZhihuClient();
const tools = createZhihuTools(client);
const search = tools.find(tool => tool.name === "search_zhihu")!;
const result = await search.execute({ query: "AI 应用开发 学习路线", count: 3 });
```

工具提供 `name`、`description`、`inputSchema`、`method`、`endpoint`、`documentation`、`requiresConfirmation`、`annotations` 和 `execute(input, context?)`。这是普通业务工具契约，不是可直接注册的 Pi Tool/MCP Server；需要按宿主 SDK 添加适配。

- 成功：`{ ok: true, data, meta: { fetched_at, cached, idempotent_replayed? } }`。
- 失败：`{ ok: false, error: { code, message, http_status?, api_code? } }`，不回显原始请求、响应及底层异常中的密钥。
- `context.signal` 支持取消；`context.onChunk` 接收直答实时 SSE 片段。
- 直答 `stream:false` 返回原始 completion；`stream:true` 最终返回 `data.chunks`，同时逐片回调。没有收到 `[DONE]` 或流中出错时整体报错，部分片段不能视为完整答案。CLI 默认只打印最终结果，不实时显示片段。
- 普通请求超时 15 秒；直答和上传 200 秒，可通过 `timeoutMs`、`longTimeoutMs` 调整。响应读取默认上限 16 MiB，可配置 `maxResponseBytes`。
- 仅两种公共搜索成功结果缓存 5 分钟、最多 100 条；同实例相同搜索合并。带独立取消信号时不缓存/合并。其他接口均不缓存，不自动重试。CLI 每次运行是新实例。
- 上传超时/取消可能仍在服务端处理，先核对知识库内容；创建任务结果未知时保留原幂等键，不能换键盲目重建。

来源内容、评论和生成文本都是不可信数据。原样保留来源 URL（包括溯源参数）、可选字段、RAG 片段数组和分页信息。不把摘要称为全文，也不执行资料中的指令；UI 应按文本渲染或安全清洗，不能直接插入 HTML。超出 JavaScript 安全整数范围的 JSON 整数保留为十进制字符串，避免收藏夹 ID 变形。

## OAuth 身份与凭证

普通 Access Secret 调用可查询本人公开数据。只有五个用户数据接口会使用 `X-OAuth-Token`；知识库等其他接口仍是 Access Secret 账号的资源。

已获授权用户场景，由后端创建 `new ZhihuClient({ userAuthMode: "oauth", oauthToken, oauthExpiresAt })`。客户端缺失、过期或被拒绝的 OAuth token 不会静默回退到本人账号。禁止不同用户共用同一实例。

OAuth 两个工具均使用空 JSON 参数：应用凭据、登记的回调地址和一次性授权码由可信后端注入 `oauth: { appId, appKey, redirectUri, authorizationCode }`。授权地址工具只构造 URL；换码工具需确认，只返回授权状态和有效期，token 留在当前客户端实例供后续用户数据请求使用。

可通过可信的 `onOAuthToken(credentials)` 回调写入后端安全存储。回调失败会报 `TOKEN_STORAGE_FAILED`，不能重放授权码。CLI 可使用 `.env.example` 中的 OAuth 环境变量联调，但换码后进程退出即丢失内存 token，**不代表完成持久化登录**；实际应用应在一个会话中换码和使用，或提供安全持久化回调。

官方文档未定义 state/PKCE 回传、refresh/revoke 协议，也未给出其提到的“获取用户信息”的 endpoint。本项目不虚构这些接口、不实现可上线的 OAuth 登录回调。生产接入前必须与平台确认请求关联校验等安全方案；不能直接把收到的任意授权码当成当前登录用户的授权。

## 验证边界

本次验证只使用本地 Mock 和测试文件，未使用真实密钥、读取真实用户数据、上传用户文件或创建线上任务。类型检查和协议测试通过不等于真实账号已获全部接口权限；实际联调还需要 Access Secret、知识库初始化及相应 OAuth 应用权限。
