import { constants, realpathSync } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { basename, extname, isAbsolute } from "node:path";
import { ZhihuError } from "./errors.ts";

export const MAX_FILE_BYTES = 100 * 1024 * 1024;
const extensions = new Set(["pdf", "md", "txt", "ppt", "pptx", "xlsx", "xls", "docx", "doc", "webp", "png", "jpg", "mobi", "epub", "csv", "azw3"]);

export function authorizedFiles(paths: string[]) {
  try {
    if (paths.some(path => !isAbsolute(path))) throw new Error("absolute paths required");
    return new Set(paths.map(path => realpathSync(path)));
  } catch { throw new ZhihuError("CONFIG_ERROR", "上传白名单必须是已存在文件的绝对路径。"); }
}

export async function prepareUpload(path: string, allowed: Set<string>, pdfOnly: boolean) {
  if (!isAbsolute(path)) throw new ZhihuError("INVALID_FILE", "上传文件必须使用绝对路径。");
  let resolved: string;
  try { resolved = await realpath(path); }
  catch { throw new ZhihuError("INVALID_FILE", "上传文件不存在或不可访问。"); }
  if (!allowed.has(resolved)) throw new ZhihuError("FILE_NOT_AUTHORIZED", "文件不在宿主授权白名单中；不能读取或上传任意本地文件。");
  const rawName = basename(resolved);
  const name = rawName.trim();
  const extension = extname(name).slice(1).toLowerCase();
  if (!name || /\p{Cc}/u.test(rawName) || Buffer.byteLength(name) > 255 || Buffer.from(name).toString("utf8") !== name ||
      !(pdfOnly ? extension === "pdf" : extensions.has(extension))) {
    throw new ZhihuError("INVALID_FILE", "文件名、编码或扩展名不符合接口要求。");
  }
  try {
    const handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size < 1 || stat.size > MAX_FILE_BYTES) throw new ZhihuError("INVALID_FILE", "仅支持非空普通文件，最大 100 MiB。");
      const bytes = Buffer.alloc(stat.size + 1);
      let size = 0;
      while (size < bytes.length) {
        const result = await handle.read(bytes, size, bytes.length - size, size);
        if (!result.bytesRead) break;
        size += result.bytesRead;
      }
      if (size !== stat.size) throw new ZhihuError("INVALID_FILE", "文件在读取期间发生变化，请重新确认文件。");
      if (pdfOnly && bytes.subarray(0, 5).toString("ascii") !== "%PDF-") throw new ZhihuError("INVALID_FILE", "文件内容不是有效 PDF 文件头。");
      return { name, blob: new Blob([bytes.subarray(0, size)], { type: extension === "pdf" ? "application/pdf" : "application/octet-stream" }) };
    } finally { await handle.close(); }
  } catch (error) {
    if (error instanceof ZhihuError) throw error;
    throw new ZhihuError("INVALID_FILE", "文件读取失败。");
  }
}
