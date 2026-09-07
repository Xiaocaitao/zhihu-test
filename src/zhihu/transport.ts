import { z } from "zod";
import { ZhihuError } from "./errors.ts";
import { chatChunk } from "./api-schemas.ts";

export type RequestContext = { signal?: AbortSignal; onChunk?: (chunk: unknown) => void };
export type ApiResult<T> = { data: T; meta: { fetched_at: string; cached: boolean; idempotent_replayed?: boolean } };
export type TransportOptions = {
  accessSecret?: string; fetch?: typeof fetch; now?: () => number; timeoutMs?: number;
  longTimeoutMs?: number; cacheTtlMs?: number; maxCacheEntries?: number; maxResponseBytes?: number;
};
type RequestOptions = RequestContext & {
  method?: "GET" | "POST"; params?: Record<string, string>; body?: BodyInit;
  contentType?: string; oauthToken?: string; idempotencyKey?: string;
  protocol?: "envelope" | "json" | "sse"; oauthEndpoint?: boolean; long?: boolean; cacheable?: boolean;
};
const envelope = z.object({ Code: z.number().int(), Message: z.string(), Data: z.unknown().optional() });

/** 大于 JS 安全范围的整数保留原始十进制字符串，尤其是收藏夹 Int64 ID。 */
export function parseJson(text: string): unknown {
  return JSON.parse(text, (_key, value, context?: { source?: string }) => {
    if (typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value)) {
      if (!context?.source || !/^-?\d+$/.test(context.source)) throw new Error("unsafe number");
      return context.source;
    }
    return value;
  });
}

export class Transport {
  #secret: string;
  #fetch: typeof fetch;
  #now: () => number;
  #timeout: number;
  #longTimeout: number;
  #ttl: number;
  #maxEntries: number;
  #maxBytes: number;
  #cache = new Map<string, { expires: number; value: ApiResult<unknown> }>();
  #inflight = new Map<string, Promise<ApiResult<unknown>>>();

  constructor(options: TransportOptions = {}) {
    this.#secret = (options.accessSecret ?? process.env.ZHIHU_ACCESS_SECRET ?? "").trim();
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#timeout = options.timeoutMs ?? 15_000;
    this.#longTimeout = options.longTimeoutMs ?? 200_000;
    this.#ttl = options.cacheTtlMs ?? 300_000;
    this.#maxEntries = options.maxCacheEntries ?? 100;
    this.#maxBytes = options.maxResponseBytes ?? 16 * 1024 * 1024;
    if ([this.#timeout, this.#longTimeout, this.#maxEntries, this.#maxBytes].some(n => !Number.isSafeInteger(n) || n < 1) ||
        !Number.isFinite(this.#ttl) || this.#ttl < 0) throw new ZhihuError("CONFIG_ERROR", "超时或缓存配置无效。");
  }

  now() { return this.#now(); }
  requireAuth() {
    if (!this.#secret) throw new ZhihuError("AUTH_REQUIRED", "请在服务端配置 ZHIHU_ACCESS_SECRET。");
  }

  async request<T>(path: string, schema: z.ZodType<T>, options: RequestOptions = {}): Promise<ApiResult<T>> {
    if (!options.oauthEndpoint) this.requireAuth();
    if (options.signal?.aborted) throw new ZhihuError("CANCELLED", "请求已取消。");
    const url = new URL(path, options.oauthEndpoint ? "https://openapi.zhihu.com" : "https://developer.zhihu.com");
    url.search = new URLSearchParams(options.params).toString();
    // 仅公共搜索允许缓存/合并；用户请求、写请求及带独立取消信号的请求不合并。
    const cacheable = options.cacheable && !options.oauthToken && !options.signal && (!options.method || options.method === "GET");
    const key = url.toString();
    if (!cacheable) return this.#request(url, schema, options);
    const cached = this.#cache.get(key);
    if (cached && cached.expires > this.#now()) {
      return { ...structuredClone(cached.value), meta: { ...cached.value.meta, cached: true } } as ApiResult<T>;
    }
    this.#cache.delete(key);
    const pending = this.#inflight.get(key);
    if (pending) return structuredClone(await pending) as ApiResult<T>;
    const promise = this.#request(url, schema, options).then(value => {
      if (this.#ttl > 0) {
        if (this.#cache.size >= this.#maxEntries) this.#cache.delete(this.#cache.keys().next().value!);
        this.#cache.set(key, { expires: this.#now() + this.#ttl, value });
      }
      return value;
    });
    this.#inflight.set(key, promise);
    try { return structuredClone(await promise); }
    finally { this.#inflight.delete(key); }
  }

  async #request<T>(url: URL, schema: z.ZodType<T>, options: RequestOptions): Promise<ApiResult<T>> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, options.long ? this.#longTimeout : this.#timeout);
    try {
      const headers: Record<string, string> = options.oauthEndpoint ? {} : {
        Authorization: `Bearer ${this.#secret}`,
        "X-Request-Timestamp": String(Math.floor(this.#now() / 1000)),
      };
      if (options.contentType) headers["Content-Type"] = options.contentType;
      else if (!(options.body instanceof FormData)) headers["Content-Type"] = "application/json";
      if (options.oauthToken) headers["X-OAuth-Token"] = options.oauthToken;
      if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;
      const response = await this.#fetch(url, {
        method: options.method ?? "GET", headers, body: options.body,
        signal: controller.signal, redirect: "error",
      });
      if (!response.ok) {
        await response.body?.cancel();
        const status = response.status;
        const code = status === 401 || status === 403 ? "AUTH_FAILED" : status === 429 ? "RATE_LIMITED" : "HTTP_ERROR";
        throw new ZhihuError(code, "知乎接口 HTTP 请求失败，未自动重试。", status);
      }
      let body: unknown;
      if (options.protocol === "sse") body = { chunks: await this.#readSse(response, options.onChunk) };
      else {
        try { body = parseJson(await this.#readText(response)); }
        catch (error) {
          if (error instanceof ZhihuError) throw error;
          throw new ZhihuError("INVALID_RESPONSE", "知乎接口未返回有效 JSON。");
        }
      }
      if (!options.protocol || options.protocol === "envelope") {
        const parsed = envelope.safeParse(body);
        if (!parsed.success) throw new ZhihuError("INVALID_RESPONSE", "知乎接口响应结构不符合协议。");
        if (parsed.data.Code !== 0) {
          const apiCode = parsed.data.Code;
          const codes: Record<number, string> = { 10001: "API_INVALID_ARGUMENT", 20001: "AUTH_FAILED", 30001: "RATE_LIMITED", 30002: "QUOTA_EXCEEDED", 40001: "IDEMPOTENCY_CONFLICT", 40002: "FILE_UNAVAILABLE", 40003: "ACTIVE_TASK_LIMIT" };
          throw new ZhihuError(codes[apiCode] ?? "API_ERROR", "知乎接口返回业务错误；请根据 api_code 处理，不要自动重试。", response.status, apiCode);
        }
        body = parsed.data.Data;
      } else if (body && typeof body === "object" && "error" in body) {
        throw new ZhihuError("API_ERROR", "知乎接口返回错误，未自动重试。");
      }
      const parsed = schema.safeParse(body);
      if (!parsed.success) throw new ZhihuError("INVALID_RESPONSE", "知乎接口返回字段不符合协议。");
      return { data: parsed.data, meta: {
        fetched_at: new Date(this.#now()).toISOString(), cached: false,
        ...(options.idempotencyKey ? { idempotent_replayed: response.headers.get("Idempotent-Replayed") === "true" } : {}),
      } };
    } catch (error) {
      if (options.signal?.aborted) throw new ZhihuError("CANCELLED", "请求已取消；上传或任务提交的服务端结果可能仍在处理中，不要自动重试。");
      if (controller.signal.aborted) throw new ZhihuError("TIMEOUT", "请求超时；上传或任务提交的结果可能未知，未自动重试。");
      if (error instanceof ZhihuError) throw error;
      throw new ZhihuError("NETWORK_ERROR", "网络请求失败；写请求结果可能未知，未自动重试。");
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  }

  async *#textChunks(response: Response) {
    if (!response.body) throw new ZhihuError("INVALID_RESPONSE", "响应体为空。");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > this.#maxBytes) throw new ZhihuError("RESPONSE_TOO_LARGE", "响应超过客户端大小上限。");
        yield decoder.decode(value, { stream: true });
      }
      yield decoder.decode();
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  async #readText(response: Response) {
    let text = "";
    for await (const chunk of this.#textChunks(response)) text += chunk;
    return text;
  }

  async #readSse(response: Response, onChunk?: (chunk: unknown) => void) {
    if (!response.headers.get("Content-Type")?.includes("text/event-stream")) throw new ZhihuError("INVALID_RESPONSE", "直答流式接口未返回 SSE。");
    const chunks: z.infer<typeof chatChunk>[] = [];
    let buffer = "";
    for await (const text of this.#textChunks(response)) {
      buffer += text;
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const event = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const data = event.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n");
        if (!data) continue;
        if (data === "[DONE]") return chunks;
        let raw: unknown;
        try { raw = parseJson(data); } catch { throw new ZhihuError("INVALID_RESPONSE", "SSE 数据不是有效 JSON。"); }
        if (raw && typeof raw === "object" && "error" in raw) throw new ZhihuError("STREAM_ERROR", "直答流式生成中途失败；已收到的片段不是完整答案。");
        const parsed = chatChunk.safeParse(raw);
        if (!parsed.success) throw new ZhihuError("INVALID_RESPONSE", "SSE 片段格式无效。");
        if (parsed.data.choices.some(c => c.finish_reason === "error")) throw new ZhihuError("STREAM_ERROR", "直答流式生成失败。");
        chunks.push(parsed.data);
        try { onChunk?.(structuredClone(parsed.data)); }
        catch { throw new ZhihuError("CALLBACK_ERROR", "流式接收回调失败，已停止读取。"); }
      }
    }
    throw new ZhihuError("INCOMPLETE_STREAM", "SSE 未收到 [DONE]，不能将已有片段当作完整答案。");
  }
}
