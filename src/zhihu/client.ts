import { z } from "zod";
import { ZhihuError } from "./errors.ts";
import { quotaData, quotaInput, searchData, searchGlobalInput, searchZhihuInput } from "./schemas.ts";
import * as s from "./api-schemas.ts";
import { Transport, type RequestContext, type TransportOptions } from "./transport.ts";
import { authorizedFiles, prepareUpload } from "./uploads.ts";

export type ClientOptions = TransportOptions & {
  allowedUploadFiles?: string[];
  userAuthMode?: "self" | "oauth";
  oauthToken?: string;
  oauthExpiresAt?: number;
  onOAuthToken?: (credentials: { accessToken: string; tokenType: string; expiresAt: number }) => void | Promise<void>;
  oauth?: { appId: string; appKey?: string; redirectUri: string; authorizationCode?: string };
};
const query = (params: Record<string, string | number | undefined>) => Object.fromEntries(
  Object.entries(params).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]),
);

/** 仅在服务端创建，每个实例固定一个用户会话；禁止跨用户复用。 */
export class ZhihuClient {
  #transport: Transport;
  #files: Set<string>;
  #userMode: "self" | "oauth";
  #token: string;
  #expiresAt?: number;
  #oauth?: ClientOptions["oauth"];
  #onOAuthToken?: ClientOptions["onOAuthToken"];

  constructor(options: ClientOptions = {}) {
    this.#transport = new Transport(options);
    this.#files = authorizedFiles(options.allowedUploadFiles ?? []);
    this.#token = options.oauthToken?.trim() ?? "";
    this.#userMode = options.userAuthMode ?? (this.#token ? "oauth" : "self");
    if (this.#userMode === "self" && this.#token) throw new ZhihuError("CONFIG_ERROR", "self 模式不能同时配置 OAuth token，请明确选择调用身份。");
    this.#expiresAt = options.oauthExpiresAt;
    this.#oauth = options.oauth ? { ...options.oauth } : undefined;
    this.#onOAuthToken = options.onOAuthToken;
    if (this.#expiresAt !== undefined && (!Number.isFinite(this.#expiresAt) || this.#expiresAt < 0)) throw new ZhihuError("CONFIG_ERROR", "OAuth 过期时间配置无效。");
  }

  searchZhihu(input: unknown, context: RequestContext = {}) {
    const a = searchZhihuInput.parse(input);
    return this.#transport.request("/api/v1/content/zhihu_search", searchData, { ...context, params: query({ Query: a.query, Count: a.count }), cacheable: true });
  }
  searchGlobal(input: unknown, context: RequestContext = {}) {
    const a = searchGlobalInput.parse(input);
    return this.#transport.request("/api/v1/content/global_search", searchData, { ...context, params: query({ Query: a.query, Count: a.count, Filter: a.filter, SearchDB: a.search_db }), cacheable: true });
  }
  getQuota(input: unknown = {}, context: RequestContext = {}) {
    const a = quotaInput.parse(input);
    return this.#transport.request("/api/v1/quota", quotaData, { ...context, params: query({ APIIDs: a.api_ids ? [...new Set(a.api_ids)].join(",") : undefined }) });
  }
  getHotList(input: unknown = {}, context: RequestContext = {}) {
    const a = s.hotInput.parse(input);
    return this.#transport.request("/api/v1/content/hot_list", s.hotData, { ...context, params: query({ Limit: a.limit }) });
  }
  askZhida(input: unknown, context: RequestContext = {}) {
    const a = s.chatInput.parse(input);
    const options = { ...context, method: "POST" as const, body: JSON.stringify(a), long: true };
    if (a.stream) return this.#transport.request("/v1/chat/completions", z.object({ chunks: z.array(s.chatChunk) }), { ...options, protocol: "sse" });
    return this.#transport.request("/v1/chat/completions", s.chatData, { ...options, protocol: "json" });
  }
  listKnowledgeBases(input: unknown = {}, context: RequestContext = {}) {
    const a = s.basesInput.parse(input);
    return this.#transport.request("/api/v1/knowledge/bases", s.basesData, { ...context, params: query({ Scope: a.scope }) });
  }
  listKnowledgeItems(input: unknown, context: RequestContext = {}) {
    const a = s.itemsInput.parse(input);
    return this.#transport.request(`/api/v1/knowledge/bases/${a.knowledge_base_id}/items`, s.itemsData, { ...context, params: query({ Cursor: a.cursor, Limit: a.limit }) });
  }
  async uploadKnowledgeFile(input: unknown, context: RequestContext = {}) {
    const a = s.knowledgeUploadInput.parse(input);
    this.#transport.requireAuth();
    const file = await prepareUpload(a.file_path, this.#files, false);
    const body = new FormData();
    body.set("File", file.blob, file.name);
    if (a.knowledge_base_id) body.set("KnowledgeBaseID", a.knowledge_base_id);
    return this.#transport.request("/api/v1/knowledge/files", s.knowledgeUploadData, { ...context, method: "POST", body, long: true });
  }
  searchKnowledge(input: unknown, context: RequestContext = {}) {
    const a = s.knowledgeSearchInput.parse(input);
    return this.#transport.request("/api/v1/knowledge/search", s.knowledgeSearchData, { ...context, method: "POST", body: JSON.stringify({
      Query: a.query, KnowledgeBaseIDs: a.knowledge_base_ids, RecallScopes: a.recall_scopes, Limit: a.limit,
    }) });
  }

  #userToken() {
    if (this.#userMode === "self") return undefined;
    if (!this.#token || (this.#expiresAt !== undefined && this.#expiresAt <= this.#transport.now())) {
      throw new ZhihuError("OAUTH_REQUIRED", "OAuth 用户令牌缺失或过期；不能回退查询 Access Secret 所属账号。");
    }
    return this.#token;
  }
  getUserContents(input: unknown, context: RequestContext = {}) {
    const a = s.contentsInput.parse(input);
    return this.#transport.request("/api/v1/user/contents", s.contentsData, { ...context, oauthToken: this.#userToken(), params: query({ Offset: a.offset, Limit: a.limit, ContentType: a.content_type, SortField: a.sort_field, SortOrder: a.sort_order }) });
  }
  getUserFollowees(input: unknown = {}, context: RequestContext = {}) {
    const a = s.followeesInput.parse(input);
    return this.#transport.request("/api/v1/user/followees", s.followeesData, { ...context, oauthToken: this.#userToken(), params: query({ Offset: a.offset, Limit: a.limit }) });
  }
  getUserCollections(input: unknown = {}, context: RequestContext = {}) {
    const a = s.collectionsInput.parse(input);
    return this.#transport.request("/api/v1/user/collections", s.collectionsData, { ...context, oauthToken: this.#userToken(), params: query({ Limit: a.limit }) });
  }
  getUserFavlists(input: unknown = {}, context: RequestContext = {}) {
    const a = s.favlistsInput.parse(input);
    return this.#transport.request("/api/v1/user/favlists", s.favlistsData, { ...context, oauthToken: this.#userToken(), params: query({ Limit: a.limit }) });
  }
  getFavlistContents(input: unknown, context: RequestContext = {}) {
    const a = s.favlistContentsInput.parse(input);
    return this.#transport.request("/api/v1/user/favlist_contents", s.favlistContentsData, { ...context, oauthToken: this.#userToken(), params: query({ FavlistUrlToken: a.favlist_url_token, Offset: a.offset, Limit: a.limit }) });
  }
  async uploadPdfFile(input: unknown, context: RequestContext = {}) {
    const a = s.pdfUploadInput.parse(input);
    this.#transport.requireAuth();
    const file = await prepareUpload(a.file_path, this.#files, true);
    const body = new FormData();
    body.set("file", file.blob, file.name);
    return this.#transport.request("/resources/v1/files", s.pdfUploadData, { ...context, method: "POST", body, long: true });
  }
  createPdfTask(input: unknown, context: RequestContext = {}) {
    const a = s.pdfCreateInput.parse(input);
    return this.#transport.request("/api/v1/pdf-parse/tasks", s.taskCreatedData, { ...context, method: "POST", body: JSON.stringify({ file_id: a.file_id }), idempotencyKey: a.idempotency_key });
  }
  getPdfTask(input: unknown, context: RequestContext = {}) {
    const a = s.taskInput.parse(input);
    return this.#transport.request(`/api/v1/pdf-parse/tasks/${a.task_id}`, s.taskData, context);
  }
  createPptTask(input: unknown, context: RequestContext = {}) {
    const a = s.pptCreateInput.parse(input);
    return this.#transport.request("/api/v1/ppt-generation/tasks", s.taskCreatedData, { ...context, method: "POST", body: JSON.stringify({ resource_url: a.resource_url, num_pages: a.num_pages }), idempotencyKey: a.idempotency_key });
  }
  getPptTask(input: unknown, context: RequestContext = {}) {
    const a = s.taskInput.parse(input);
    return this.#transport.request(`/api/v1/ppt-generation/tasks/${a.task_id}`, s.taskData, context);
  }

  #oauthConfig() {
    const config = this.#oauth;
    if (!config?.appId?.trim() || !config.redirectUri) throw new ZhihuError("OAUTH_CONFIG_REQUIRED", "请由服务端配置 OAuth appId 和登记的 redirectUri。");
    let redirect: URL;
    try { redirect = new URL(config.redirectUri); }
    catch { throw new ZhihuError("CONFIG_ERROR", "OAuth 回调地址无效。"); }
    if (redirect.username || redirect.password || redirect.hash || (redirect.protocol !== "https:" && !(redirect.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(redirect.hostname)))) throw new ZhihuError("CONFIG_ERROR", "OAuth 回调地址必须为 HTTPS（本机开发除外）。");
    return config;
  }
  async getOAuthAuthorizationUrl(input: unknown = {}) {
    s.emptyInput.parse(input);
    const config = this.#oauthConfig();
    const url = new URL("https://openapi.zhihu.com/authorize");
    url.search = new URLSearchParams({ redirect_uri: config.redirectUri, app_id: config.appId, response_type: "code" }).toString();
    return { data: { authorization_url: url.toString(), warning: "仅生成官方授权地址，不自动登录或授权。文档没有说明 state/PKCE；生产登录需先确认回调关联校验方案。" }, meta: { fetched_at: new Date(this.#transport.now()).toISOString(), cached: false } };
  }
  async exchangeOAuthCode(input: unknown = {}, context: RequestContext = {}) {
    s.emptyInput.parse(input);
    if (context.signal?.aborted) throw new ZhihuError("CANCELLED", "请求已取消，尚未交换授权码。");
    const config = this.#oauthConfig();
    if (!config.appKey || !config.authorizationCode) throw new ZhihuError("OAUTH_CONFIG_REQUIRED", "请由可信后端回调提供 appKey 和一次性 authorizationCode，不要放入工具参数。");
    const code = config.authorizationCode;
    this.#oauth!.authorizationCode = undefined;
    this.#userMode = "oauth";
    this.#token = "";
    const response = await this.#transport.request("/access_token", s.oauthTokenData, {
      ...context, oauthEndpoint: true, protocol: "json", method: "POST", contentType: "application/x-www-form-urlencoded",
      body: new URLSearchParams({ app_id: config.appId, app_key: config.appKey, grant_type: "authorization_code", redirect_uri: config.redirectUri, code }),
    });
    this.#token = response.data.access_token;
    this.#expiresAt = this.#transport.now() + response.data.expires_in * 1000;
    try { await this.#onOAuthToken?.({ accessToken: this.#token, tokenType: response.data.token_type, expiresAt: this.#expiresAt }); }
    catch { throw new ZhihuError("TOKEN_STORAGE_FAILED", "令牌已换取但宿主持久化失败；当前实例仍持有令牌，不要重放授权码。"); }
    return { data: { authorized: true, token_type: response.data.token_type, expires_in: response.data.expires_in, expires_at: new Date(this.#expiresAt).toISOString() }, meta: response.meta };
  }
}
