import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { PlankaClient } from "../client.js";
import { formatAttachment } from "../format.js";
import { fail, id, ok, safe } from "../util.js";

const W = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;
/** Largest text file returned inline by planka_download_attachment. */
export const MAX_INLINE_TEXT = 256 * 1024;
/** Largest image returned inline (as MCP image content) by planka_download_attachment. */
export const MAX_INLINE_IMAGE = 2 * 1024 * 1024;

const TEXT_MIME = /^(text\/|application\/(json|xml|yaml|x-yaml|javascript|x-sh|toml|sql|csv)\b)|\+(json|xml)\b/;

export interface AttachmentToolOptions {
  /** If set, local files can only be read from / written to this directory (e.g. a Docker volume). */
  filesDir?: string;
}

/**
 * Resolve a user-supplied local path. Relative paths are taken from filesDir (if set) or the current
 * directory. With filesDir, the resolved path must stay inside it (symlinks resolved).
 */
export function resolveLocalPath(p: string, filesDir?: string): string {
  const base = filesDir ? resolve(filesDir) : process.cwd();
  const full = isAbsolute(p) ? resolve(p) : resolve(base, p);
  if (filesDir) {
    const real = (x: string) => {
      // The target itself may not exist yet (download): check its nearest existing parent.
      let cur = x;
      while (!existsSync(cur) && dirname(cur) !== cur) cur = dirname(cur);
      return join(realpathSync(cur), relative(cur, x));
    };
    const rel = relative(real(base), real(full));
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`Path ${p} is outside the allowed files directory ${base} (PLANKA_FILES_DIR)`);
    }
  }
  return full;
}

/** True if the bytes look like text: a text-ish MIME type, or valid UTF-8 without NUL bytes. */
export function looksLikeText(data: Buffer, mimeType?: string): boolean {
  if (mimeType && TEXT_MIME.test(mimeType)) return true;
  if (data.includes(0)) return false;
  return !new TextDecoder("utf-8", { fatal: false }).decode(data).includes("�");
}

/** A safe file name for saving: no directories, no control characters. */
export function safeFileName(name: string): string {
  const cleaned = basename(name).replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_").trim();
  return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : "attachment";
}

async function findAttachment(client: PlankaClient, cardId: string, attachmentId: string) {
  const card = await client.get(`/cards/${cardId}`);
  const a = (card.included?.attachments ?? []).find((x: any) => x.id === attachmentId);
  if (!a) throw new Error(`Attachment ${attachmentId} not found on card ${cardId}`);
  return { card: card.item, attachment: a };
}

export function registerAttachmentTools(server: McpServer, client: PlankaClient, opts: AttachmentToolOptions = {}) {
  const { filesDir } = opts;

  server.registerTool(
    "planka_list_attachments",
    {
      title: "List card attachments",
      description: "List a card's attachments (files and links) with name, type, URL, MIME type, size, and which one is the cover.",
      inputSchema: { cardId: id("Card ID") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async ({ cardId }) => {
      const card = await client.get(`/cards/${cardId}`);
      const users = new Map<string, string>(
        (card.included?.users ?? []).map((u: any) => [u.id, u.name ?? u.username]),
      );
      return {
        cardId,
        coverAttachmentId: card.item.coverAttachmentId ?? null,
        attachments: (card.included?.attachments ?? []).map((a: any) => formatAttachment(a, card.item.coverAttachmentId, users)),
      };
    }),
  );

  server.registerTool(
    "planka_add_attachment",
    {
      title: "Add attachment",
      description:
        "Attach something to a card. Give exactly one source: filePath (a local file the server can read), " +
        "content (base64-encoded bytes, with filename) or url (a link attachment). Set setAsCover=true to make an " +
        "uploaded image the card cover. Needs board editor rights." +
        (filesDir ? ` Local paths are limited to ${filesDir}.` : ""),
      inputSchema: {
        cardId: id("Card ID"),
        filePath: z.string().min(1).optional().describe("Local file to upload"),
        content: z.string().min(1).optional().describe("Base64-encoded file content (use with filename)"),
        filename: z.string().min(1).max(255).optional().describe("File name for content uploads (and the default name)"),
        url: z.string().url().max(2048).optional().describe("Create a link attachment instead of a file"),
        name: z.string().min(1).max(128).optional().describe("Display name (default: the file name, or the link's host)"),
        setAsCover: z.boolean().optional().describe("Make the uploaded image the card cover"),
      },
      annotations: W,
    },
    safe(async ({ cardId, filePath, content, filename, url, name, setAsCover }) => {
      const sources = [filePath, content, url].filter((v) => v !== undefined).length;
      if (sources !== 1) throw new Error("Give exactly one of filePath, content or url");

      let item: any;
      if (url !== undefined) {
        if (setAsCover) throw new Error("setAsCover only works for uploaded images, not links");
        const displayName = (name ?? new URL(url).hostname).slice(0, 128);
        ({ item } = await client.post(`/cards/${cardId}/attachments`, { type: "link", url, name: displayName }));
      } else {
        let bytes: Buffer;
        let fileName: string;
        if (filePath !== undefined) {
          const full = resolveLocalPath(filePath, filesDir);
          if (!existsSync(full) || !statSync(full).isFile()) throw new Error(`Not a file: ${full}`);
          bytes = readFileSync(full);
          fileName = filename ?? basename(full);
        } else {
          if (!filename) throw new Error("filename is required with content");
          bytes = Buffer.from(content!, "base64");
          if (!bytes.length) throw new Error("content is empty or not valid base64");
          fileName = filename;
        }
        const form = new FormData();
        // Planka (Skipper) needs the text fields before the file.
        form.append("type", "file");
        form.append("name", (name ?? fileName).slice(0, 128));
        form.append("file", new Blob([new Uint8Array(bytes)]), safeFileName(fileName));
        ({ item } = await client.upload(`/cards/${cardId}/attachments`, form));
      }

      let coverAttachmentId: string | null | undefined;
      if (setAsCover) {
        coverAttachmentId = (await client.patch(`/cards/${cardId}`, { coverAttachmentId: item.id })).item.coverAttachmentId;
      }
      return { ...formatAttachment(item, coverAttachmentId), cardId };
    }),
  );

  server.registerTool(
    "planka_rename_attachment",
    {
      title: "Rename attachment",
      description: "Change an attachment's display name.",
      inputSchema: { attachmentId: id("Attachment ID"), name: z.string().min(1).max(128) },
      annotations: W,
    },
    safe(async ({ attachmentId, name }) => {
      const { item } = await client.patch(`/attachments/${attachmentId}`, { name });
      return formatAttachment(item);
    }),
  );

  server.registerTool(
    "planka_delete_attachment",
    {
      title: "Delete attachment",
      description: "Permanently delete an attachment (and its file) from a card. If it was the cover, the card has no cover afterwards.",
      inputSchema: { attachmentId: id("Attachment ID") },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    safe(async ({ attachmentId }) => {
      const { item } = await client.delete(`/attachments/${attachmentId}`);
      return { deleted: true, id: item?.id ?? attachmentId, name: item?.name };
    }),
  );

  server.registerTool(
    "planka_download_attachment",
    {
      title: "Download attachment",
      description:
        "Get a file attachment's content. With savePath, the file is saved there (a directory keeps the attachment " +
        `name; existing files are only replaced with overwrite=true). Without savePath, text files up to ${MAX_INLINE_TEXT / 1024} KB ` +
        `are returned as text and images up to ${MAX_INLINE_IMAGE / 1024 / 1024} MB as an image. Link attachments return their URL.` +
        (filesDir ? ` Local paths are limited to ${filesDir}.` : ""),
      inputSchema: {
        cardId: id("Card ID the attachment belongs to"),
        attachmentId: id("Attachment ID"),
        savePath: z.string().min(1).optional().describe("Local file or directory to save to"),
        overwrite: z.boolean().optional().describe("Replace an existing file at savePath (default false)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ cardId, attachmentId, savePath, overwrite }): Promise<CallToolResult> => {
      try {
        const { attachment: a } = await findAttachment(client, cardId, attachmentId);
        const meta = formatAttachment(a);
        if (a.type !== "file") return ok({ ...meta, note: "Link attachment: nothing to download" });

        const { data, contentType } = await client.download(a.data.url);
        const mimeType = a.data.mimeType ?? contentType.split(";")[0];

        if (savePath !== undefined) {
          let target = resolveLocalPath(savePath, filesDir);
          if (savePath.endsWith("/") || (existsSync(target) && statSync(target).isDirectory())) {
            target = join(target, safeFileName(a.name || basename(a.data.url)));
          }
          if (existsSync(target) && !overwrite) throw new Error(`${target} already exists (pass overwrite=true to replace it)`);
          if (!existsSync(dirname(target))) throw new Error(`Directory does not exist: ${dirname(target)}`);
          writeFileSync(target, data);
          return ok({ ...meta, savedTo: target, bytes: data.length });
        }

        if (mimeType?.startsWith("image/")) {
          if (data.length > MAX_INLINE_IMAGE) throw new Error(`Image is ${data.length} bytes; pass savePath to save it`);
          return {
            content: [
              { type: "text", text: JSON.stringify(meta) },
              { type: "image", data: data.toString("base64"), mimeType },
            ],
          };
        }
        if (looksLikeText(data, mimeType)) {
          if (data.length > MAX_INLINE_TEXT) throw new Error(`File is ${data.length} bytes; pass savePath to save it`);
          return { content: [{ type: "text", text: JSON.stringify(meta) }, { type: "text", text: data.toString("utf8") }] };
        }
        throw new Error(`Binary file (${mimeType ?? "unknown type"}, ${data.length} bytes); pass savePath to save it`);
      } catch (err) {
        return fail(err);
      }
    },
  );
}
