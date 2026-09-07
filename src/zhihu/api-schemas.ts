import { z } from "zod";

const text = z.string().trim().min(1);
const int64Text = z.string().regex(/^(0|[1-9]\d*)$/).refine(v => /^(0|[1-9]\d*)$/.test(v) && v.length <= 19 && BigInt(v) <= 9223372036854775807n);
const offset = z.union([int64Text, z.number().int().nonnegative()]).default("0");
const id = int64Text.refine(v => v !== "0").describe("十进制 ID 字符串，避免 JavaScript 大整数精度丢失");
const pathId = text.regex(/^[A-Za-z0-9_-]+$/);
const limit50 = z.number().int().min(1).max(50).default(20);
const limitUnspecified = z.number().int().min(1).default(20);
const page = { offset, limit: limit50 };
const uploadPath = text.describe("已由宿主授权的单个本地文件绝对路径");
const idempotencyKey = text.regex(/^[\x21-\x7e]+$/).optional().describe("可选幂等键；同一次逻辑提交应复用，同一个键不能用于不同请求");

export const emptyInput = z.strictObject({});
export const hotInput = z.strictObject({ limit: z.number().int().min(1).max(30).default(30) });
export const chatInput = z.strictObject({
  model: z.enum(["zhida-fast-1p5", "zhida-thinking-1p5", "zhida-agent"]),
  messages: z.array(z.strictObject({ role: text, content: z.string() })).min(1),
  stream: z.boolean().default(false),
});
export const basesInput = z.strictObject({ scope: z.enum(["all", "created", "subscribed"]).default("all") });
export const itemsInput = z.strictObject({ knowledge_base_id: id, cursor: z.string().optional(), limit: z.number().int().min(1).max(20).default(20) });
export const knowledgeUploadInput = z.strictObject({ file_path: uploadPath, knowledge_base_id: id.optional() });
export const knowledgeSearchInput = z.strictObject({
  query: text,
  knowledge_base_ids: z.array(id).optional(),
  recall_scopes: z.array(z.enum(["personal", "subscription", "public"])).optional(),
  limit: z.number().int().min(1).max(10).default(10),
}).refine(v => !!(v.knowledge_base_ids?.length || v.recall_scopes?.length), {
  message: "knowledge_base_ids 与 recall_scopes 至少一个非空",
});
export const contentsInput = z.strictObject({
  ...page, content_type: z.enum(["all", "answer", "article", "zvideo", "pin", "question"]),
  sort_field: z.enum(["like_count", "ts"]).default("ts"), sort_order: z.enum(["asc", "desc"]).default("desc"),
});
export const followeesInput = z.strictObject(page);
// 收藏相关文档没有声明最大值，不沿用旧 Skill 中的 50 上限。
export const collectionsInput = z.strictObject({ limit: limitUnspecified });
export const favlistsInput = collectionsInput;
export const favlistContentsInput = z.strictObject({ favlist_url_token: id, offset, limit: limitUnspecified });
export const pdfUploadInput = z.strictObject({ file_path: uploadPath });
export const pdfCreateInput = z.strictObject({ file_id: pathId, idempotency_key: idempotencyKey });
export const taskInput = z.strictObject({ task_id: pathId });
export const pptCreateInput = z.strictObject({
  resource_url: z.url().refine(value => {
    let u: URL;
    try { u = new URL(value); } catch { return false; }
    if (u.protocol !== "https:" || u.username || u.password || u.port) return false;
    return (u.hostname === "www.zhihu.com" && /^\/(?:question\/\d+\/)?answer\/\d+\/?$/.test(u.pathname)) ||
      (u.hostname === "zhuanlan.zhihu.com" && /^\/p\/\d+\/?$/.test(u.pathname));
  }, "只支持知乎回答或专栏文章 HTTPS 链接"),
  num_pages: z.number().int().min(6).max(21),
  idempotency_key: idempotencyKey,
});

const url = z.url({ protocol: /^https?$/ });
const count = z.number().int().nonnegative();
const record = <T extends z.ZodRawShape>(shape: T) => z.looseObject(shape);
const list = <T extends z.ZodType>(item: T) => record({ Items: z.array(item) });
export const hotData = record({ Total: count, Items: z.array(record({ Title: z.string(), Url: url, ThumbnailUrl: z.string(), Summary: z.string() })) });
export const basesData = list(record({
  KnowledgeBaseID: z.string(), Name: z.string(), Relation: z.string(), IsDefault: z.boolean(),
  Visibility: z.string(), ContentCount: count, UpdatedAt: z.number(), Description: z.string().optional(),
}));
export const itemsData = record({
  Items: z.array(record({ RecallContentID: z.string(), ContentType: z.string(), Title: z.string() })),
  Total: count, HasMore: z.boolean(), NextCursor: z.string().optional(),
});
export const knowledgeUploadData = record({ KnowledgeBaseID: z.string(), RecallContentID: z.string(), FileName: z.string(), FileSize: count });
export const knowledgeSearchData = list(record({ Content: z.array(z.string()), KnowledgeBaseID: z.string(), DocName: z.string() }));
const paging = record({ IsEnd: z.boolean(), NextOffset: z.string().optional(), Totals: count });
const content = record({
  ContentType: z.string(), Url: url, CreatedAt: z.number(), LikeCount: count,
  CommentCount: count, FavoriteCount: count, Title: z.string(), Summary: z.string(),
});
const urlToken = z.union([z.number().int(), int64Text]);
const collection = content.extend({
  FavTime: z.number(), Favlists: z.array(record({ UrlToken: urlToken, Title: z.string(), Url: z.string() })),
  Author: record({ Name: z.string(), UrlToken: z.string(), Url: z.string(), Gender: z.number().int(), Headline: z.string() }).optional(),
});
export const contentsData = list(content).extend({ Paging: paging });
export const followeesData = list(record({
  Fullname: z.string(), UrlToken: z.string(), Url: url, AvatarUrl: z.string(),
  Headline: z.string(), Gender: z.number().int(), FollowerCount: count,
})).extend({ Paging: paging });
export const collectionsData = list(collection);
export const favlistsData = list(record({ UrlToken: urlToken, Url: url, Title: z.string(), Description: z.string(), IsPublic: z.boolean() }));
export const favlistContentsData = collectionsData.extend({ Paging: paging });
export const pdfUploadData = record({ file_id: text });
const taskStatus = z.enum(["pending", "running", "succeeded", "failed"]);
export const taskCreatedData = record({ task_id: text, task_status: taskStatus });
export const taskData = taskCreatedData.extend({
  progress: z.number().min(0).max(1),
  result: record({ url, expires_at_ms: count, summary: z.string().optional() }).nullable(),
  error: record({ code: z.string(), message: z.string() }).nullable(),
});
export const chatData = record({
  id: z.string(), object: z.string(), created: z.number(), model: z.string(),
  choices: z.array(record({ index: z.number().int(), message: record({ role: z.string(), content: z.string().nullable() }), finish_reason: z.string().nullable() })),
});
export const chatChunk = record({
  id: z.string(), object: z.string(), created: z.number(), model: z.string(),
  choices: z.array(record({ index: z.number().int(), delta: record({}), finish_reason: z.string().nullable() })),
});
export const oauthTokenData = z.object({ access_token: text, token_type: text, expires_in: z.number().int().positive() });
