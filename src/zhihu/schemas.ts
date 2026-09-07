import { z } from "zod";

const query = z.string().trim().min(1).describe("查询关键词；不要发送密钥或个人隐私");
export const searchZhihuInput = z.strictObject({
  query,
  count: z.number().int().min(1).max(10).default(10),
});
export const searchGlobalInput = z.strictObject({
  query,
  count: z.number().int().min(1).max(20).default(10),
  filter: z.string().trim().min(1).optional().describe(
    '官方筛选表达式，如 host=="example.com" AND publish_time>=1778494631；知乎站内请用 search_zhihu',
  ),
  search_db: z.enum(["all", "realtime", "static"]).default("all"),
});
export const quotaInput = z.strictObject({
  api_ids: z.array(z.enum([
    "global_search", "zhihu_search", "hot_list", "user_data",
    "zhida_openai", "knowledge", "tools",
  ])).min(1).max(7).optional().describe("省略时返回所有额度项"),
});

// 校验可引用内容的必要字段，保留平台提供的其余质量信号，不伪造缺失值。
const sourceItem = z.looseObject({
  Title: z.string(),
  ContentID: z.string(),
  ContentType: z.string(),
  ContentText: z.string(),
  Url: z.url({ protocol: /^https?$/ }),
  AuthorName: z.string(),
  VoteUpCount: z.number(),
  CommentCount: z.number(),
  AuthorityLevel: z.string().optional(),
  RankingScore: z.number().optional(),
  EditTime: z.number().optional(),
  CommentInfoList: z.array(z.looseObject({ Content: z.string() })).optional(),
});
export const searchData = z.looseObject({
  HasMore: z.boolean(),
  SearchHashId: z.string().optional(),
  EmptyReason: z.string().optional(),
  Items: z.array(sourceItem),
});
export const quotaData = z.array(z.looseObject({
  APIID: z.string(),
  APIName: z.string(),
  TotalQuota: z.number().int().nonnegative(),
  TotalUsed: z.number().int().nonnegative(),
  RemainingQuota: z.number().int().nonnegative(),
}));
