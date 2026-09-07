import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm, symlink, open } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createZhihuTools } from "../src/agent/tools.ts";
import { ZhihuClient, type ClientOptions } from "../src/zhihu/client.ts";
import { MAX_FILE_BYTES } from "../src/zhihu/uploads.ts";

const clientWith = (fetch: typeof globalThis.fetch, options: ClientOptions = {}) => new ZhihuClient({ accessSecret: "platform-secret", fetch, ...options });
const getTool = (client: ZhihuClient, name: string) => createZhihuTools(client).find(tool => tool.name === name)!;
const envelope = (Data: unknown) => Response.json({ Code: 0, Message: "success", Data });
const paging = { IsEnd: false, NextOffset: "9223372036854775807", Totals: 2 };
const task = { task_id: "task_123", task_status: "running", progress: 0.4, result: null, error: null };

test("documented GET contracts: paths, defaults, paging, user headers and no auto pagination", async t => {
  const cases: Array<[string, unknown, string, Record<string, string>, unknown]> = [
    ["get_zhihu_hot_list", {}, "/api/v1/content/hot_list", { Limit: "30" }, { Total: 0, Items: [] }],
    ["list_knowledge_bases", { scope: "subscribed" }, "/api/v1/knowledge/bases", { Scope: "subscribed" }, { Items: [] }],
    ["list_knowledge_items", { knowledge_base_id: "7526139256098382426", cursor: "a+/=& 不透明" }, "/api/v1/knowledge/bases/7526139256098382426/items", { Cursor: "a+/=& 不透明", Limit: "20" }, { Items: [], Total: 2, HasMore: true, NextCursor: "next+/=" }],
    ["get_user_contents", { content_type: "answer", offset: "9223372036854775807", sort_field: "like_count", sort_order: "asc", limit: 5 }, "/api/v1/user/contents", { ContentType: "answer", Offset: "9223372036854775807", Limit: "5", SortField: "like_count", SortOrder: "asc" }, { Items: [], Paging: paging }],
    ["get_user_followees", {}, "/api/v1/user/followees", { Offset: "0", Limit: "20" }, { Items: [], Paging: paging }],
    ["get_user_collections", { limit: 60 }, "/api/v1/user/collections", { Limit: "60" }, { Items: [] }],
    ["get_user_favlists", {}, "/api/v1/user/favlists", { Limit: "20" }, { Items: [] }],
    ["get_favlist_contents", { favlist_url_token: "9223372036854775807", offset: "20" }, "/api/v1/user/favlist_contents", { FavlistUrlToken: "9223372036854775807", Offset: "20", Limit: "20" }, { Items: [], Paging: paging }],
    ["get_pdf_parse_task", { task_id: "pdf_123" }, "/api/v1/pdf-parse/tasks/pdf_123", {}, task],
    ["get_ppt_generation_task", { task_id: "ppt_123" }, "/api/v1/ppt-generation/tasks/ppt_123", {}, task],
  ];
  for (const [name, input, path, params, data] of cases) {
    await t.test(name, async () => {
      let calls = 0;
      const client = clientWith(async (url, init) => {
        calls++;
        const actual = new URL(String(url));
        assert.equal(actual.origin, "https://developer.zhihu.com");
        assert.equal(actual.pathname, path);
        assert.deepEqual(Object.fromEntries(actual.searchParams), params);
        assert.equal(init?.method, "GET");
        assert.equal(new Headers(init?.headers).get("X-OAuth-Token"), path.includes("/user/") ? "user-token" : null);
        return envelope(data);
      }, { userAuthMode: "oauth", oauthToken: "user-token" });
      const result = await getTool(client, name).execute(input);
      assert.equal(result.ok, true);
      if (result.ok) assert.deepEqual(result.data, data);
      assert.equal(calls, 1);
    });
  }
});

test("knowledge RAG preserves ordered chunks and requires an explicit search scope", async () => {
  let calls = 0;
  const data = { Items: [{ Content: ["片段一", "片段二"], KnowledgeBaseID: "7526139256098382426", DocName: "文档", OriginUrl: "https://example.com/a" }] };
  const client = clientWith(async (url, init) => {
    calls++;
    assert.equal(new URL(String(url)).pathname, "/api/v1/knowledge/search");
    assert.equal(init?.method, "POST");
    assert.deepEqual(JSON.parse(String(init?.body)), { Query: "退款", KnowledgeBaseIDs: ["7526139256098382426"], RecallScopes: ["personal"], Limit: 10 });
    return envelope(data);
  });
  const tool = getTool(client, "search_knowledge");
  for (const input of [{ query: "退款" }, { query: "退款", knowledge_base_ids: [], recall_scopes: [] }]) {
    const bad = await tool.execute(input);
    assert.equal(bad.ok, false);
  }
  assert.equal(calls, 0);
  const good = await tool.execute({ query: "退款", knowledge_base_ids: ["7526139256098382426"], recall_scopes: ["personal"] });
  assert.equal(good.ok, true);
  if (good.ok) assert.deepEqual(good.data, data);
});

test("write tools require trusted confirmation, not an input field", async () => {
  let calls = 0;
  const client = clientWith(async () => { calls++; return envelope({}); });
  const examples: Record<string, unknown> = {
    upload_knowledge_file: { file_path: "/no-access/document.pdf" },
    upload_pdf_file: { file_path: "/no-access/document.pdf" },
    create_pdf_parse_task: { file_id: "file_123" },
    create_ppt_generation_task: { resource_url: "https://www.zhihu.com/answer/123", num_pages: 6 },
    exchange_zhihu_oauth_code: {},
  };
  for (const [name, input] of Object.entries(examples)) {
    const result = await getTool(client, name).execute(input);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "CONFIRMATION_REQUIRED");
  }
  const spoofed = await getTool(client, "create_pdf_parse_task").execute({ file_id: "file_123", confirmed: true });
  assert.equal(spoofed.ok, false);
  if (!spoofed.ok) assert.equal(spoofed.error.code, "INVALID_ARGUMENT");
  assert.equal(calls, 0);
});

test("PDF/PPT creation sends documented bodies and idempotency headers; no local coalescing", async () => {
  for (const [name, path, input, body] of [
    ["create_pdf_parse_task", "/api/v1/pdf-parse/tasks", { file_id: "file_123", idempotency_key: "same-request" }, { file_id: "file_123" }],
    ["create_ppt_generation_task", "/api/v1/ppt-generation/tasks", { resource_url: "https://zhuanlan.zhihu.com/p/123?utm_source=test", num_pages: 21, idempotency_key: "same-request" }, { resource_url: "https://zhuanlan.zhihu.com/p/123?utm_source=test", num_pages: 21 }],
  ] as const) {
    let calls = 0;
    const client = clientWith(async (url, init) => {
      calls++;
      assert.equal(new URL(String(url)).pathname, path);
      assert.equal(init?.method, "POST");
      assert.deepEqual(JSON.parse(String(init?.body)), body);
      assert.equal(new Headers(init?.headers).get("Idempotency-Key"), "same-request");
      return Response.json({ Code: 0, Message: "success", Data: { task_id: "task_same", task_status: "pending" } }, { headers: { "Idempotent-Replayed": "true" } });
    });
    const tool = getTool(client, name);
    const results = await Promise.all([tool.execute(input, { confirmed: true }), tool.execute(input, { confirmed: true })]);
    assert.equal(calls, 2);
    for (const result of results) {
      assert.equal(result.ok, true);
      if (result.ok) assert.equal(result.meta.idempotent_replayed, true);
    }
  }
});

test("task status queries preserve failed state and fresh signed download URLs", async () => {
  let calls = 0;
  const states = [
    { ...task, task_status: "failed", error: { code: "parse_failed", message: "PDF parse failed" } },
    { ...task, task_status: "succeeded", progress: 1, result: { url: "https://example.com/result?signature=one", expires_at_ms: 1788180000000 } },
    { ...task, task_status: "succeeded", progress: 1, result: { url: "https://example.com/result?signature=two", expires_at_ms: 1788180001000 } },
  ];
  const client = clientWith(async () => envelope(states[calls++]));
  for (const state of states) {
    const result = await client.getPdfTask({ task_id: "pdf_123" });
    assert.deepEqual(result.data, state);
    assert.equal(result.meta.cached, false);
  }
  assert.equal(calls, 3);
});

test("invalid IDs, unsupported PPT URLs, counts and forbidden credential fields fail before network", async () => {
  let calls = 0;
  const client = clientWith(async () => { calls++; return envelope({}); });
  const cases: Array<[string, unknown]> = [
    ["get_zhihu_hot_list", { limit: 31 }],
    ["get_user_contents", { content_type: "all", limit: 51 }],
    ["get_user_followees", { offset: "9223372036854775808" }],
    ["get_user_followees", { oauth_token: "secret" }],
    ["get_user_collections", { offset: 1 }],
    ["get_user_favlists", { offset: 1 }],
    ["get_favlist_contents", { favlist_url_token: 9223372036854775807 }],
    ["list_knowledge_items", { knowledge_base_id: "../../secret" }],
    ["get_pdf_parse_task", { task_id: "../other" }],
    ["create_pdf_parse_task", { file_id: "file_1", idempotency_key: "injected\nHeader" }],
    ["create_ppt_generation_task", { resource_url: "https://evil.example/answer/123", num_pages: 6 }],
    ["create_ppt_generation_task", { resource_url: "not a URL", num_pages: 6 }],
    ["create_ppt_generation_task", { resource_url: "https://www.zhihu.com/answer/123", num_pages: 22 }],
    ["exchange_zhihu_oauth_code", { code: "secret" }],
  ];
  for (const [name, input] of cases) {
    const result = await getTool(client, name).execute(input, { confirmed: true });
    assert.equal(result.ok, false, name);
    if (!result.ok) assert.equal(result.error.code, "INVALID_ARGUMENT", name);
  }
  assert.equal(calls, 0);
});

test("both multipart upload contracts, file allowlist, file type and size checks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zhihu-upload-test-"));
  try {
    const pdf = join(directory, "测试.PDF");
    const markdown = join(directory, "notes.md");
    const empty = join(directory, "empty.pdf");
    const fake = join(directory, "fake.pdf");
    const huge = join(directory, "huge.pdf");
    const secret = join(directory, "private.txt");
    const link = join(directory, "link.pdf");
    await writeFile(pdf, "%PDF-1.7\nfixture");
    await writeFile(markdown, "# 知识库测试");
    await writeFile(empty, "");
    await writeFile(fake, "not pdf");
    await writeFile(secret, "never-upload");
    await symlink(secret, link);
    const handle = await open(huge, "w");
    await handle.truncate(MAX_FILE_BYTES + 1);
    await handle.close();
    let calls = 0;
    const client = clientWith(async (url, init) => {
      calls++;
      assert.equal(init?.method, "POST");
      assert.equal(new Headers(init?.headers).has("Content-Type"), false);
      assert.ok(init?.body instanceof FormData);
      const form = init.body;
      if (new URL(String(url)).pathname === "/resources/v1/files") {
        assert.deepEqual([...form.keys()], ["file"]);
        assert.equal(await (form.get("file") as File).text(), "%PDF-1.7\nfixture");
        return envelope({ file_id: "file_uploaded" });
      }
      assert.equal(new URL(String(url)).pathname, "/api/v1/knowledge/files");
      assert.equal(form.get("KnowledgeBaseID"), "7526139256098382426");
      assert.equal(await (form.get("File") as File).text(), "# 知识库测试");
      return envelope({ KnowledgeBaseID: "7526139256098382426", RecallContentID: "content_1", FileName: "notes.md", FileSize: 23 });
    }, { allowedUploadFiles: [pdf, markdown, empty, fake, huge] });
    assert.equal((await getTool(client, "upload_pdf_file").execute({ file_path: pdf }, { confirmed: true })).ok, true);
    assert.equal((await getTool(client, "upload_knowledge_file").execute({ file_path: markdown, knowledge_base_id: "7526139256098382426" }, { confirmed: true })).ok, true);
    for (const path of [empty, fake, huge, markdown, secret, link]) {
      const result = await getTool(client, "upload_pdf_file").execute({ file_path: path }, { confirmed: true });
      assert.equal(result.ok, false, path);
    }
    assert.equal(calls, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

const completion = { id: "chat_1", object: "chat.completion", created: 1788180000, model: "zhida-fast-1p5", choices: [{ index: 0, message: { role: "assistant", content: "答案", reasoning_content: "分析" }, finish_reason: "stop" }] };
const chunk = { id: "chat_1", object: "chat.completion.chunk", created: 1788180000, model: "zhida-fast-1p5", choices: [{ index: 0, delta: { content: "中文片段" }, finish_reason: null }] };
const chatArgs = { model: "zhida-fast-1p5", messages: [{ role: "user", content: "问题" }] };
const streamResponse = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3));
    controller.close();
  } }), { headers: { "Content-Type": "text/event-stream" } });
};

test("Zhida non-streaming JSON keeps original completion and request fields", async () => {
  const client = clientWith(async (url, init) => {
    assert.equal(new URL(String(url)).pathname, "/v1/chat/completions");
    assert.equal(init?.method, "POST");
    assert.deepEqual(JSON.parse(String(init?.body)), { ...chatArgs, stream: false });
    return Response.json(completion);
  });
  const result = await client.askZhida(chatArgs);
  assert.deepEqual(result.data, completion);
});

test("SSE handles split UTF-8, CRLF, heartbeat, multiple events and trusted live callbacks", async () => {
  const received: unknown[] = [];
  const client = clientWith(async (_url, init) => {
    assert.equal(JSON.parse(String(init?.body)).stream, true);
    return streamResponse(`: keep-alive\r\n\r\ndata: ${JSON.stringify(chunk)}\r\n\r\ndata: [DONE]\r\n\r\n`);
  });
  const result = await getTool(client, "ask_zhihu").execute({ ...chatArgs, stream: true }, { onChunk: part => received.push(part) });
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.data, { chunks: [chunk] });
  assert.deepEqual(received, [chunk]);
});

test("stream errors, truncated streams and JSON errors never become successful answers", async () => {
  const cases: Array<[() => Response, boolean, string]> = [
    [() => streamResponse(`data: ${JSON.stringify(chunk)}\n\n`), true, "INCOMPLETE_STREAM"],
    [() => streamResponse('data: {"error":{"message":"platform-secret"}}\n\ndata: [DONE]\n\n'), true, "STREAM_ERROR"],
    [() => streamResponse('data: invalid\n\n'), true, "INVALID_RESPONSE"],
    [() => Response.json({ error: { message: "platform-secret" } }), false, "API_ERROR"],
  ];
  for (const [response, stream, code] of cases) {
    let calls = 0;
    const client = clientWith(async () => { calls++; return response(); });
    const result = await getTool(client, "ask_zhihu").execute({ ...chatArgs, stream });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, code);
    assert.equal(JSON.stringify(result).includes("platform-secret"), false);
    assert.equal(calls, 1);
  }
});

test("large Int64 favorite IDs round-trip losslessly", async () => {
  const client = clientWith(async () => new Response('{"Code":0,"Message":"success","Data":{"Items":[{"UrlToken":9223372036854775807,"Url":"https://www.zhihu.com/collection/9223372036854775807","Title":"收藏","Description":"","IsPublic":true}]}}'));
  const result = await client.getUserFavlists();
  assert.equal(result.data.Items[0].UrlToken, "9223372036854775807");
});

test("OAuth authorization URL, token form exchange and user identity are isolated from model outputs", async () => {
  let calls = 0;
  let persisted: unknown;
  const client = clientWith(async (url, init) => {
    calls++;
    const actual = new URL(String(url));
    const headers = new Headers(init?.headers);
    if (actual.hostname === "openapi.zhihu.com") {
      assert.equal(actual.pathname, "/access_token");
      assert.equal(headers.get("Content-Type"), "application/x-www-form-urlencoded");
      assert.equal(headers.has("Authorization"), false);
      assert.deepEqual(Object.fromEntries(init?.body as URLSearchParams), {
        app_id: "app-public", app_key: "app-secret", grant_type: "authorization_code", redirect_uri: "https://example.com/callback?a=1", code: "code-secret",
      });
      return Response.json({ access_token: "oauth-secret", token_type: "Bearer", expires_in: 3600 });
    }
    assert.equal(actual.pathname, "/api/v1/user/followees");
    assert.equal(headers.get("Authorization"), "Bearer platform-secret");
    assert.equal(headers.get("X-OAuth-Token"), "oauth-secret");
    return envelope({ Items: [], Paging: paging });
  }, {
    oauth: { appId: "app-public", appKey: "app-secret", redirectUri: "https://example.com/callback?a=1", authorizationCode: "code-secret" },
    now: () => 1788180000000,
    onOAuthToken: credentials => { persisted = credentials; },
  });
  const authorization = await client.getOAuthAuthorizationUrl();
  const url = new URL(authorization.data.authorization_url);
  assert.equal(url.pathname, "/authorize");
  assert.equal(url.searchParams.get("redirect_uri"), "https://example.com/callback?a=1");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(calls, 0);
  const exchanged = await getTool(client, "exchange_zhihu_oauth_code").execute({}, { confirmed: true });
  assert.equal(exchanged.ok, true);
  for (const secret of ["platform-secret", "app-secret", "code-secret", "oauth-secret"]) assert.equal(JSON.stringify(exchanged).includes(secret), false);
  assert.deepEqual(persisted, { accessToken: "oauth-secret", tokenType: "Bearer", expiresAt: 1788183600000 });
  await client.getUserFollowees();
  const second = await getTool(client, "exchange_zhihu_oauth_code").execute({}, { confirmed: true });
  assert.equal(second.ok, false);
  assert.equal(calls, 2);
});

test("OAuth missing/expired/rejected token cannot silently fall back to self", async () => {
  let calls = 0;
  const fetchMock: typeof fetch = async () => { calls++; return envelope({ Code: 20001 }); };
  for (const options of [{ userAuthMode: "oauth" as const }, { userAuthMode: "oauth" as const, oauthToken: "expired", oauthExpiresAt: 1 }]) {
    const result = await getTool(clientWith(fetchMock, options), "get_user_followees").execute({});
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "OAUTH_REQUIRED");
  }
  assert.equal(calls, 0);
  const client = clientWith(async (_url, init) => {
    calls++;
    assert.equal(new Headers(init?.headers).get("X-OAuth-Token"), "rejected");
    return Response.json({ Code: 20001, Message: "denied" });
  }, { userAuthMode: "oauth", oauthToken: "rejected" });
  const rejected = await getTool(client, "get_user_followees").execute({});
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.error.code, "AUTH_FAILED");
  assert.equal(calls, 1);
});

test("quota/idempotency errors, response size limits and cancellation do not retry", async () => {
  for (const [code, expected] of [[30002, "QUOTA_EXCEEDED"], [40001, "IDEMPOTENCY_CONFLICT"], [40003, "ACTIVE_TASK_LIMIT"]] as const) {
    let calls = 0;
    const result = await getTool(clientWith(async () => { calls++; return Response.json({ Code: code, Message: "failed" }); }), "create_pdf_parse_task").execute({ file_id: "file_1" }, { confirmed: true });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, expected);
    assert.equal(calls, 1);
  }
  const large = await getTool(clientWith(async () => envelope({ Items: [] }), { maxResponseBytes: 4 }), "get_user_favlists").execute({});
  assert.equal(large.ok, false);
  if (!large.ok) assert.equal(large.error.code, "RESPONSE_TOO_LARGE");
  let calls = 0;
  const controller = new AbortController();
  controller.abort();
  const cancelled = await getTool(clientWith(async () => { calls++; return envelope({}); }), "get_user_followees").execute({}, { signal: controller.signal });
  assert.equal(cancelled.ok, false);
  if (!cancelled.ok) assert.equal(cancelled.error.code, "CANCELLED");
  assert.equal(calls, 0);
});

test("OAuth ambiguous identity and failed token persistence remain explicit", async () => {
  assert.throws(() => new ZhihuClient({ userAuthMode: "self", oauthToken: "token" }), /self/);
  let calls = 0;
  const client = clientWith(async () => {
    calls++;
    return Response.json({ access_token: "secret-token", token_type: "Bearer", expires_in: 3600 });
  }, {
    oauth: { appId: "app", appKey: "secret-key", redirectUri: "https://example.com/callback", authorizationCode: "secret-code" },
    onOAuthToken: () => { throw new Error("secret-token"); },
  });
  const tool = getTool(client, "exchange_zhihu_oauth_code");
  const first = await tool.execute({}, { confirmed: true });
  assert.equal(first.ok, false);
  if (!first.ok) assert.equal(first.error.code, "TOKEN_STORAGE_FAILED");
  assert.equal(JSON.stringify(first).includes("secret-token"), false);
  assert.equal((await tool.execute({}, { confirmed: true })).ok, false);
  assert.equal(calls, 1);
});

test("long request timeout covers the SSE body and does not retry POST", async () => {
  let calls = 0;
  const client = clientWith(async (_url, init) => {
    calls++;
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(": keep-alive\n\n"));
      init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")), { once: true });
    } }), { headers: { "Content-Type": "text/event-stream" } });
  }, { longTimeoutMs: 10 });
  const result = await getTool(client, "ask_zhihu").execute({ ...chatArgs, stream: true });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "TIMEOUT");
  assert.equal(calls, 1);
});
