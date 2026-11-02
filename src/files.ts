import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, realpath, stat, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, sep } from "node:path";
import { z } from "zod";
import type { Config } from "./config.js";
import { getAccount } from "./config.js";
import { AppError } from "./errors.js";
import { atomicJson, readJson } from "./storage.js";

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
const uuidSchema = z.uuid();
export const fileSourceSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("path"), path: z.string().min(1).max(4096) }),
  z.strictObject({
    type: z.literal("base64"),
    filename: z.string().min(1).max(200),
    data: z
      .string()
      .min(1)
      .max(Math.ceil(MAX_FILE_BYTES / 3) * 4),
  }),
]);
export type FileSource = z.infer<typeof fileSourceSchema>;
export interface StagedFile {
  fileId: string;
  accountId: string;
  filename: string;
  bytes: number;
  createdAt: string;
  resourceUri: string;
}
const allowedExtensions = new Set([
  ".txt",
  ".pdf",
  ".doc",
  ".docx",
  ".xlsx",
  ".xls",
  ".zip",
  ".7z",
  ".odt",
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".mp4",
  ".webm",
  ".mov",
  ".mp3",
  ".wav",
  ".ogg",
  ".m4a",
]);

export class FileStore {
  constructor(private readonly config: Config) {}
  private directory(accountId: string) {
    getAccount(this.config, accountId);
    return join(this.config.dataDir, "accounts", accountId, "files");
  }
  async stage(accountId: string, source: FileSource): Promise<StagedFile> {
    let filename: string;
    let bytes: Buffer;
    if (source.type === "path") {
      const actual = await realpath(source.path);
      const roots = await Promise.all(this.config.attachmentRoots.map((p) => realpath(p)));
      if (
        !roots.some((root) => {
          const r = relative(root, actual);
          return r !== "" && !r.startsWith(`..${sep}`) && r !== ".." && !isAbsolute(r);
        })
      ) {
        throw new AppError(
          "FILE_ACCESS_DENIED",
          "The file must be inside a configured WG_MCP_ATTACHMENT_ROOTS directory.",
        );
      }
      const file = await open(actual, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      try {
        const info = await file.stat();
        if (!info.isFile() || info.size > MAX_FILE_BYTES)
          throw new AppError("INVALID_FILE", "Only regular files up to 10 MiB are accepted.");
        bytes = await file.readFile();
      } finally {
        await file.close();
      }
      filename = basename(actual);
    } else {
      filename = source.filename;
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(source.data))
        throw new AppError("INVALID_FILE", "File data must be canonical Base64.");
      bytes = Buffer.from(source.data, "base64");
    }
    return this.store(accountId, filename, bytes);
  }
  async store(accountId: string, filename: string, bytes: Buffer): Promise<StagedFile> {
    if (
      basename(filename) !== filename ||
      /[\\/]/.test(filename) ||
      [...filename].some((character) => character.charCodeAt(0) < 32) ||
      !allowedExtensions.has(extname(filename).toLowerCase())
    )
      throw new AppError(
        "INVALID_FILE",
        "Unsupported or unsafe filename. Use a supported document, image, audio, or video extension.",
      );
    if (!bytes.length || bytes.length > MAX_FILE_BYTES)
      throw new AppError("INVALID_FILE", "Files must contain between 1 byte and 10 MiB.");
    const directory = this.directory(accountId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const fileId = randomUUID();
    const metadata: StagedFile = {
      fileId,
      accountId,
      filename,
      bytes: bytes.length,
      createdAt: new Date().toISOString(),
      resourceUri: `wg-gesucht://accounts/${accountId}/files/${fileId}`,
    };
    await writeFile(join(directory, fileId), bytes, { flag: "wx", mode: 0o600 });
    await atomicJson(join(directory, `${fileId}.json`), metadata);
    return metadata;
  }
  async get(accountId: string, fileId: string): Promise<StagedFile & { path: string }> {
    if (!uuidSchema.safeParse(fileId).success)
      throw new AppError("INVALID_FILE", "Invalid file handle.");
    const directory = this.directory(accountId);
    const metadata = await readJson<StagedFile>(join(directory, `${fileId}.json`));
    if (!metadata || metadata.accountId !== accountId || metadata.fileId !== fileId)
      throw new AppError("FILE_NOT_FOUND", "The file handle does not belong to this account.");
    const path = join(directory, fileId);
    const info = await stat(path);
    if (!info.isFile() || info.size !== metadata.bytes)
      throw new AppError("INVALID_FILE", "The staged file changed. Stage it again.");
    return { ...metadata, path };
  }
}
