import { z } from "zod";

export class ZhihuError extends Error {
  readonly code: string;
  readonly httpStatus?: number;
  readonly apiCode?: number;

  constructor(code: string, message: string, httpStatus?: number, apiCode?: number) {
    super(message);
    this.name = "ZhihuError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.apiCode = apiCode;
  }
}

export function safeError(error: unknown) {
  if (error instanceof z.ZodError) {
    // 不回传原始输入或上游响应，避免把凭证带入模型上下文和日志。
    return { code: "INVALID_ARGUMENT", message: "参数无效，请按工具 inputSchema 检查字段和范围。" };
  }
  if (error instanceof ZhihuError) {
    return { code: error.code, message: error.message, http_status: error.httpStatus, api_code: error.apiCode };
  }
  return { code: "INTERNAL_ERROR", message: "工具执行失败。" };
}
