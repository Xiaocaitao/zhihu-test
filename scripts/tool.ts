import { createZhihuTools } from "../src/agent/tools.ts";
import { ZhihuClient } from "../src/zhihu/client.ts";
import { safeError, ZhihuError } from "../src/zhihu/errors.ts";

async function main() {
  const argv = process.argv.slice(2);
  const confirmed = argv.includes("--approve");
  const [name, json = "{}", extra] = argv.filter(arg => arg !== "--approve");
  if (extra) throw new ZhihuError("INVALID_ARGUMENT", "用法：npm run tool -- <name> '<JSON>' [--approve]");
  if (!name || name === "list") {
    console.log(JSON.stringify(createZhihuTools().map(({ execute: _, ...definition }) => definition), null, 2));
    return;
  }
  let input: unknown;
  try { input = JSON.parse(json); }
  catch { throw new ZhihuError("INVALID_ARGUMENT", "参数必须是有效 JSON。"); }
  const mode = process.env.ZHIHU_USER_AUTH_MODE || undefined;
  if (mode !== undefined && mode !== "self" && mode !== "oauth") throw new ZhihuError("CONFIG_ERROR", "ZHIHU_USER_AUTH_MODE 必须为 self 或 oauth。");
  // CLI --approve 表示操作者明确批准本次命令和指定文件，不从模型 JSON 接收确认。
  const filePath = confirmed && ["upload_pdf_file", "upload_knowledge_file"].includes(name) &&
    input && typeof input === "object" && "file_path" in input && typeof input.file_path === "string" ? input.file_path : undefined;
  const client = new ZhihuClient({
    allowedUploadFiles: filePath ? [filePath] : [],
    userAuthMode: mode,
    oauthToken: process.env.ZHIHU_OAUTH_TOKEN,
    oauthExpiresAt: process.env.ZHIHU_OAUTH_EXPIRES_AT ? Number(process.env.ZHIHU_OAUTH_EXPIRES_AT) : undefined,
    oauth: process.env.ZHIHU_OAUTH_APP_ID ? {
      appId: process.env.ZHIHU_OAUTH_APP_ID,
      appKey: process.env.ZHIHU_OAUTH_APP_KEY,
      redirectUri: process.env.ZHIHU_OAUTH_REDIRECT_URI ?? "",
      authorizationCode: process.env.ZHIHU_OAUTH_AUTHORIZATION_CODE,
    } : undefined,
  });
  const tool = createZhihuTools(client).find(item => item.name === name);
  if (!tool) throw new ZhihuError("UNKNOWN_TOOL", "未知工具；运行 npm run tool -- list 查看工具。");
  const result = await tool.execute(input, { confirmed });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}
try { await main(); }
catch (error) {
  console.log(JSON.stringify({ ok: false, error: safeError(error) }, null, 2));
  process.exitCode = 1;
}
