import assert from "node:assert/strict";
import { test } from "node:test";
import { createZhihuTools } from "../src/agent/tools.ts";
import { ZhihuClient } from "../src/zhihu/client.ts";

const source = {
  Title: "测试资料", ContentID: "1903044959663284716", ContentType: "Answer",
  ContentText: "测试摘要", Url: "https://www.zhihu.com/answer/123?utm_source=test",
  AuthorName: "测试作者", VoteUpCount: 12, CommentCount: 2,
  AuthorityLevel: "2", RankingScore: 0.8, EditTime: 1788180000,
  CommentInfoList: [{ Content: "测试评论" }],
};
const searchBody = { Code: 0, Message: "success", Data: { HasMore: false, SearchHashId: "test", Items: [source] } };
function mockClient(handler: typeof fetch, options: { now?: () => number; cacheTtlMs?: number; maxCacheEntries?: number; timeoutMs?: number } = {}) {
  return new ZhihuClient({ accessSecret: "test-secret", fetch: handler, ...options });
}
function tool(client: ZhihuClient, name = "search_zhihu") {
  return createZhihuTools(client).find((item) => item.name === name)!;
}

test("Zhihu contract: query encoding, seconds timestamp, bearer, exact source preservation", async () => {
  const client = mockClient(async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://developer.zhihu.com");
    assert.equal(url.pathname, "/api/v1/content/zhihu_search");
    assert.equal(url.searchParams.get("Query"), "C++ & AI 学习");
    assert.equal(url.searchParams.get("Count"), "3");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("Authorization"), "Bearer test-secret");
    assert.equal(headers.get("X-Request-Timestamp"), "1788180000");
    assert.equal(headers.get("Content-Type"), "application/json");
    assert.equal(init?.redirect, "error");
    return Response.json(searchBody);
  }, { now: () => 1788180000123 });
  const result = await client.searchZhihu({ query: " C++ & AI 学习 ", count: 3 });
  assert.deepEqual(result.data.Items[0], source);
  assert.equal(result.meta.fetched_at, "2026-08-31T12:40:00.123Z");
});

test("global contract: Count 20 and filters remain one encoded query value", async () => {
  const filter = 'host=="example.com" AND publish_time>=1778494631';
  const client = mockClient(async (input) => {
    const url = new URL(String(input));
    assert.equal(url.pathname, "/api/v1/content/global_search");
    assert.equal(url.searchParams.get("Filter"), filter);
    assert.equal(url.searchParams.get("SearchDB"), "realtime");
    assert.equal(url.searchParams.get("Count"), "20");
    return Response.json(searchBody);
  });
  const result = await tool(client, "search_global").execute({ query: "课程", count: 20, filter, search_db: "realtime" });
  assert.equal(result.ok, true);
});

test("invalid arguments and absent credentials cause no network requests", async () => {
  let calls = 0;
  const fetchMock: typeof fetch = async () => { calls++; return Response.json(searchBody); };
  const client = mockClient(fetchMock);
  for (const input of [{ query: " " }, { query: "AI", count: 11 }, { query: "AI", count: "2" }, { query: "AI", accessSecret: "hidden" }]) {
    const result = await tool(client).execute(input);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "INVALID_ARGUMENT");
  }
  const missing = await tool(new ZhihuClient({ accessSecret: "", fetch: fetchMock })).execute({ query: "AI" });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.error.code, "AUTH_REQUIRED");
  assert.equal(calls, 0);
});

test("HTTP and business errors, malformed responses: no retries or secret reflection", async () => {
  const cases: Array<[() => Response, string]> = [
    [() => new Response("test-secret", { status: 401 }), "AUTH_FAILED"],
    [() => new Response("test-secret", { status: 429 }), "RATE_LIMITED"],
    [() => new Response("test-secret", { status: 500 }), "HTTP_ERROR"],
    [() => Response.json({ Code: 20001, Message: "test-secret" }), "AUTH_FAILED"],
    [() => Response.json({ Code: 30001, Message: "test-secret" }), "RATE_LIMITED"],
    [() => Response.json({ Code: 90001, Message: "test-secret" }), "API_ERROR"],
    [() => new Response("not json"), "INVALID_RESPONSE"],
    [() => Response.json({ Code: 0, Message: "success", Data: {} }), "INVALID_RESPONSE"],
    [() => Response.json({}), "INVALID_RESPONSE"],
  ];
  for (const [response, code] of cases) {
    let calls = 0;
    const client = mockClient(async () => { calls++; return response(); });
    const result = await tool(client).execute({ query: "AI" });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, code);
    assert.equal(calls, 1);
    assert.equal(JSON.stringify(result).includes("test-secret"), false);
  }
});

test("bounded cache, expiration, concurrent deduplication and mutation isolation", async () => {
  let calls = 0;
  let now = 1788180000000;
  const client = mockClient(async () => { calls++; return Response.json(searchBody); }, {
    now: () => now, cacheTtlMs: 1000, maxCacheEntries: 1,
  });
  const [first, second] = await Promise.all([client.searchZhihu({ query: "AI" }), client.searchZhihu({ query: "AI" })]);
  assert.equal(calls, 1);
  first.data.Items[0].Title = "changed";
  assert.equal(second.data.Items[0].Title, source.Title);
  const cached = await client.searchZhihu({ query: "AI" });
  assert.equal(cached.meta.cached, true);
  assert.equal(cached.data.Items[0].Title, source.Title);
  now += 1001;
  assert.equal((await client.searchZhihu({ query: "AI" })).meta.cached, false);
  assert.equal(calls, 2);
  await client.searchZhihu({ query: "other" });
  await client.searchZhihu({ query: "AI" });
  assert.equal(calls, 4);
});

test("quota contract uses APIIDs and array Data; sequential quota calls bypass cache", async () => {
  let calls = 0;
  const client = mockClient(async (input) => {
    calls++;
    const url = new URL(String(input));
    assert.equal(url.pathname, "/api/v1/quota");
    assert.equal(url.searchParams.get("APIIDs"), "zhihu_search,global_search");
    return Response.json({ Code: 0, Message: "success", Data: [
      { APIID: "zhihu_search", APIName: "知乎搜索", TotalQuota: 100, TotalUsed: calls, RemainingQuota: 100 - calls },
    ] });
  });
  const args = { api_ids: ["zhihu_search", "global_search"] };
  await client.getQuota(args);
  const result = await client.getQuota(args);
  assert.equal(result.data[0].RemainingQuota, 98);
  assert.equal(result.meta.cached, false);
  assert.equal(calls, 2);
});

test("timeouts and network failures produce distinct safe errors", async () => {
  const timeoutClient = mockClient(async (_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("test-secret")), { once: true });
  }), { timeoutMs: 10 });
  const timeout = await tool(timeoutClient).execute({ query: "AI" });
  assert.equal(timeout.ok, false);
  if (!timeout.ok) assert.equal(timeout.error.code, "TIMEOUT");
  const network = await tool(mockClient(async () => { throw new Error("test-secret"); })).execute({ query: "AI" });
  assert.equal(network.ok, false);
  if (!network.ok) assert.equal(network.error.code, "NETWORK_ERROR");
  assert.equal(JSON.stringify(network).includes("test-secret"), false);
});

test("empty results preserve reason; failures are not cached", async () => {
  let calls = 0;
  const client = mockClient(async () => {
    calls++;
    return Response.json(calls === 1 ? { Code: 90001, Message: "failed" } : {
      Code: 0, Message: "success", Data: { HasMore: false, Items: [], EmptyReason: "没有匹配内容" },
    });
  });
  const first = await tool(client).execute({ query: "AI" });
  assert.equal(first.ok, false);
  const second = await client.searchZhihu({ query: "AI" });
  assert.deepEqual(second.data.Items, []);
  assert.equal(second.data.EmptyReason, "没有匹配内容");
  assert.equal(calls, 2);
});

test("tool discovery needs no credential and exposes JSON Schema without secrets", () => {
  const tools = createZhihuTools(new ZhihuClient({ accessSecret: "" }));
  assert.deepEqual(tools.slice(0, 3).map((item) => item.name), ["search_zhihu", "search_global", "get_zhihu_quota"]);
  assert.equal(tools.length, 21);
  assert.equal(new Set(tools.map(item => item.name)).size, 21);
  assert.equal(tools[0].inputSchema.type, "object");
  assert.deepEqual(tools[0].inputSchema.required, ["query"]);
});
