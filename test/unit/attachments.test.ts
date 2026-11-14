import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PlankaClient } from "../../src/client.js";
import { formatAttachment, formatCard } from "../../src/format.js";
import { looksLikeText, MAX_INLINE_TEXT, resolveLocalPath, safeFileName } from "../../src/tools/attachments.js";
import { connect, fakePlanka, type Call } from "../helpers.js";

const tmp = mkdtempSync(join(tmpdir(), "planka-att-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const CARD = "500";
const FILE_URL = "https://planka.test/attachments/71/download/notes.txt";
const IMG_URL = "https://planka.test/attachments/72/download/pic.png";
const fileAtt = {
  id: "71", cardId: CARD, type: "file", name: "notes.txt", creatorUserId: "1", createdAt: "2026-11-14T10:00:00Z",
  data: { url: FILE_URL, mimeType: "text/plain", size: 11, image: null },
};
const imgAtt = {
  id: "72", cardId: CARD, type: "file", name: "pic.png", creatorUserId: "1", createdAt: "2026-11-14T11:00:00Z",
  data: { url: IMG_URL, mimeType: "image/png", size: 4, image: { width: 640, height: 480 }, thumbnailUrls: {} },
};
const linkAtt = {
  id: "73", cardId: CARD, type: "link", name: "docs", creatorUserId: "2", createdAt: "2026-11-14T12:00:00Z",
  data: { url: "https://example.com/docs", faviconUrl: null },
};
const cardResp = {
  item: { id: CARD, name: "C", listId: "1", boardId: "2", coverAttachmentId: "72", createdAt: "2026-11-14T09:00:00Z" },
  included: { attachments: [linkAtt, imgAtt, fileAtt], users: [{ id: "1", name: "Alex" }, { id: "2", name: "Carol" }] },
};
const raw = (bytes: Buffer | string, type: string) => () =>
  new Response(typeof bytes === "string" ? bytes : new Uint8Array(bytes), { headers: { "content-type": type } });

describe("formatAttachment / formatCard", () => {
  it("formats files, images and links compactly", () => {
    expect(formatAttachment(fileAtt)).toEqual({
      id: "71", name: "notes.txt", type: "file", url: FILE_URL, mimeType: "text/plain", size: 11, createdAt: fileAtt.createdAt,
    });
    expect(formatAttachment(imgAtt, "72")).toMatchObject({ image: "640x480", isCover: true });
    expect(formatAttachment(linkAtt, "72")).toEqual({
      id: "73", name: "docs", type: "link", url: "https://example.com/docs", createdAt: linkAtt.createdAt,
    });
  });

  it("formatCard lists attachments oldest first, with creator and cover", () => {
    const c: any = formatCard(cardResp);
    expect(c.attachments.map((a: any) => a.id)).toEqual(["71", "72", "73"]);
    expect(c.attachments[1]).toMatchObject({ isCover: true, creator: "Alex" });
    expect(c.attachments[2].creator).toBe("Carol");
  });
});

describe("helpers", () => {
  it("safeFileName strips directories and unsafe characters", () => {
    expect(safeFileName("../../etc/passwd")).toBe("passwd");
    expect(safeFileName('a<b>:"c|?.txt')).toBe("a_b___c__.txt");
    expect(safeFileName("..")).toBe("attachment");
    expect(safeFileName("")).toBe("attachment");
  });

  it("looksLikeText uses the MIME type, then the bytes", () => {
    expect(looksLikeText(Buffer.from([0, 1, 2]), "application/json")).toBe(true);
    expect(looksLikeText(Buffer.from("plain ünïcode"))).toBe(true);
    expect(looksLikeText(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0]))).toBe(false);
    expect(looksLikeText(Buffer.from([0xff, 0xfe, 0xfd]))).toBe(false);
  });

  it("resolveLocalPath keeps paths inside filesDir, including via symlinks", () => {
    const root = join(tmp, "files");
    mkdirSync(join(root, "sub"), { recursive: true });
    expect(resolveLocalPath("sub/a.txt", root)).toBe(join(root, "sub/a.txt"));
    expect(resolveLocalPath(join(root, "new/deep/b.txt"), root)).toBe(join(root, "new/deep/b.txt"));
    expect(() => resolveLocalPath("../outside.txt", root)).toThrow(/outside the allowed files directory/);
    expect(() => resolveLocalPath("/etc/passwd", root)).toThrow(/outside/);
    symlinkSync(tmpdir(), join(root, "escape"));
    expect(() => resolveLocalPath("escape/x.txt", root)).toThrow(/outside/);
  });

  it("resolveLocalPath without filesDir allows any path, relative to the current directory", () => {
    expect(resolveLocalPath("/etc/hosts")).toBe("/etc/hosts");
    expect(resolveLocalPath("x.txt")).toBe(join(process.cwd(), "x.txt"));
  });
});

describe("PlankaClient.download", () => {
  it("sends the API key only to the Planka host", async () => {
    const seen: { url: string; key?: string }[] = [];
    const client = new PlankaClient("https://planka.test", "SECRET", async (url, init) => {
      seen.push({ url, key: (init?.headers as Record<string, string>)["X-Api-Key"] });
      return new Response("hi", { headers: { "content-type": "text/plain" } });
    });
    const d = await client.download(FILE_URL);
    expect(d.data.toString()).toBe("hi");
    expect(d.contentType).toBe("text/plain");
    await client.download("/attachments/71/download/notes.txt");
    expect(seen.map((s) => s.url)).toEqual([FILE_URL, FILE_URL]);
    expect(seen.every((s) => s.key === "SECRET")).toBe(true);
    for (const bad of ["https://evil.example/x", "https://planka.test.evil.example/x", "http://planka.test/x"]) {
      await expect(client.download(bad)).rejects.toThrow(/Refusing to download/);
    }
    expect(seen).toHaveLength(2);
  });

  it("turns HTTP errors into PlankaError without leaking the key", async () => {
    const client = new PlankaClient("https://planka.test", "SECRET", async () => new Response("no", { status: 403, statusText: "Forbidden" }));
    await expect(client.download(FILE_URL)).rejects.toThrow(/failed \(403\)/);
    await expect(client.download(FILE_URL)).rejects.not.toThrow(/SECRET/);
  });
});

describe("planka_list_attachments", () => {
  it("returns the card's attachments and cover", async () => {
    const f = fakePlanka({ [`GET /cards/${CARD}`]: cardResp });
    const { call } = await connect(f.client);
    const r = await call("planka_list_attachments", { cardId: CARD });
    expect(r.data.coverAttachmentId).toBe("72");
    expect(r.data.attachments.map((a: any) => [a.id, a.type])).toEqual([["73", "link"], ["72", "file"], ["71", "file"]]);
  });
});

describe("planka_add_attachment", () => {
  const created = (call: Call) => ({ item: { ...fileAtt, id: "80", name: call.form?.get("name") } });

  it("uploads a local file as multipart, text fields before the file", async () => {
    const src = join(tmp, "report.txt");
    writeFileSync(src, "hello world");
    const f = fakePlanka({ [`POST /cards/${CARD}/attachments`]: created });
    const { call } = await connect(f.client);
    const r = await call("planka_add_attachment", { cardId: CARD, filePath: src });
    expect(r.isError).toBe(false);
    const form = f.calls[0].form!;
    expect([...form.keys()]).toEqual(["type", "name", "file"]);
    expect(form.get("type")).toBe("file");
    expect(form.get("name")).toBe("report.txt");
    const file = form.get("file") as File;
    expect(file.name).toBe("report.txt");
    expect(await file.text()).toBe("hello world");
    expect(r.data).toMatchObject({ id: "80", cardId: CARD });
  });

  it("uploads base64 content with a filename and custom name, and can set it as cover", async () => {
    const f = fakePlanka({
      [`POST /cards/${CARD}/attachments`]: created,
      [`PATCH /cards/${CARD}`]: (c: Call) => ({ item: { id: CARD, ...c.body } }),
    });
    const { call } = await connect(f.client);
    const r = await call("planka_add_attachment", {
      cardId: CARD, content: Buffer.from("PNGDATA").toString("base64"), filename: "../shot.png", name: "Screenshot", setAsCover: true,
    });
    expect(r.isError).toBe(false);
    const file = f.calls[0].form!.get("file") as File;
    expect(file.name).toBe("shot.png");
    expect(await file.text()).toBe("PNGDATA");
    expect(f.calls[1]).toEqual({ method: "PATCH", path: `/cards/${CARD}`, body: { coverAttachmentId: "80" }, form: undefined });
    expect(r.data.isCover).toBe(true);
  });

  it("creates link attachments as JSON, named after the host by default", async () => {
    const f = fakePlanka({ [`POST /cards/${CARD}/attachments`]: (c: Call) => ({ item: { ...linkAtt, ...c.body } }) });
    const { call } = await connect(f.client);
    await call("planka_add_attachment", { cardId: CARD, url: "https://docs.example.org/page" });
    expect(f.calls[0].body).toEqual({ type: "link", url: "https://docs.example.org/page", name: "docs.example.org" });
  });

  it("rejects bad input before calling Planka", async () => {
    const f = fakePlanka({});
    const { call } = await connect(f.client);
    const cases: [Record<string, unknown>, RegExp][] = [
      [{}, /exactly one/],
      [{ url: "https://x.example", filePath: "/a" }, /exactly one/],
      [{ content: "QUJD" }, /filename is required/],
      [{ content: "!!!!", filename: "x" }, /empty or not valid/],
      [{ filePath: join(tmp, "missing.txt") }, /Not a file/],
      [{ filePath: tmp }, /Not a file/],
      [{ url: "https://x.example", setAsCover: true }, /only works for uploaded images/],
    ];
    for (const [args, msg] of cases) {
      const r = await call("planka_add_attachment", { cardId: CARD, ...args });
      expect(r.isError, JSON.stringify(args)).toBe(true);
      expect(r.text).toMatch(msg);
    }
    expect(f.calls).toEqual([]);
  });

  it("respects filesDir", async () => {
    const root = join(tmp, "sandbox");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "ok.txt"), "ok");
    const f = fakePlanka({ [`POST /cards/${CARD}/attachments`]: created });
    const { call } = await connect(f.client, { filesDir: root });
    expect((await call("planka_add_attachment", { cardId: CARD, filePath: "ok.txt" })).isError).toBe(false);
    const outside = await call("planka_add_attachment", { cardId: CARD, filePath: "/etc/hosts" });
    expect(outside.text).toMatch(/outside the allowed files directory/);
    expect(f.calls).toHaveLength(1);
  });
});

describe("planka_rename_attachment / planka_delete_attachment", () => {
  it("renames with PATCH and deletes with DELETE", async () => {
    const f = fakePlanka({
      "PATCH /attachments/71": (c: Call) => ({ item: { ...fileAtt, ...c.body } }),
      "DELETE /attachments/71": { item: fileAtt },
    });
    const { call } = await connect(f.client);
    expect((await call("planka_rename_attachment", { attachmentId: "71", name: "Notes" })).data.name).toBe("Notes");
    expect(f.calls[0].body).toEqual({ name: "Notes" });
    expect((await call("planka_delete_attachment", { attachmentId: "71" })).data).toEqual({ deleted: true, id: "71", name: "notes.txt" });
    expect(f.calls[1]).toMatchObject({ method: "DELETE", path: "/attachments/71" });
  });
});

describe("planka_download_attachment", () => {
  const routes = (extra: Record<string, unknown> = {}) => ({
    [`GET /cards/${CARD}`]: cardResp,
    "GET /attachments/71/download/notes.txt": raw("hello notes", "text/plain"),
    "GET /attachments/72/download/pic.png": raw(Buffer.from([0x89, 0x50, 0x4e, 0x47]), "image/png"),
    ...extra,
  });

  it("returns small text inline", async () => {
    const { client } = await connect(fakePlanka(routes()).client);
    const r: any = await client.callTool({ name: "planka_download_attachment", arguments: { cardId: CARD, attachmentId: "71" } });
    expect(r.isError).toBeFalsy();
    expect(r.content[1]).toEqual({ type: "text", text: "hello notes" });
  });

  it("returns images as MCP image content", async () => {
    const { client } = await connect(fakePlanka(routes()).client);
    const r: any = await client.callTool({ name: "planka_download_attachment", arguments: { cardId: CARD, attachmentId: "72" } });
    expect(r.content[1]).toEqual({ type: "image", mimeType: "image/png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64") });
  });

  it("saves to a directory under the attachment name, and refuses to overwrite unless asked", async () => {
    const dir = join(tmp, "out");
    mkdirSync(dir, { recursive: true });
    const { call } = await connect(fakePlanka(routes()).client);
    const r = await call("planka_download_attachment", { cardId: CARD, attachmentId: "71", savePath: dir });
    expect(r.data).toMatchObject({ savedTo: join(dir, "notes.txt"), bytes: 11 });
    expect(readFileSync(join(dir, "notes.txt"), "utf8")).toBe("hello notes");
    expect((await call("planka_download_attachment", { cardId: CARD, attachmentId: "71", savePath: dir })).text).toMatch(/already exists/);
    writeFileSync(join(dir, "notes.txt"), "old");
    await call("planka_download_attachment", { cardId: CARD, attachmentId: "71", savePath: join(dir, "notes.txt"), overwrite: true });
    expect(readFileSync(join(dir, "notes.txt"), "utf8")).toBe("hello notes");
    expect((await call("planka_download_attachment", { cardId: CARD, attachmentId: "71", savePath: join(tmp, "nope/x.txt") })).text).toMatch(/does not exist/);
  });

  it("refuses large or binary files inline, and handles links and unknown IDs", async () => {
    const big = Buffer.alloc(MAX_INLINE_TEXT + 1, "a");
    const { call } = await connect(fakePlanka(routes({ "GET /attachments/71/download/notes.txt": raw(big, "text/plain") })).client);
    expect((await call("planka_download_attachment", { cardId: CARD, attachmentId: "71" })).text).toMatch(/pass savePath/);
    const binFile = { ...cardResp, included: { ...cardResp.included, attachments: [{ ...fileAtt, data: { ...fileAtt.data, mimeType: "application/zip" } }] } };
    const z = await connect(fakePlanka(routes({ [`GET /cards/${CARD}`]: binFile, "GET /attachments/71/download/notes.txt": raw(Buffer.from([0, 1, 2]), "application/zip") })).client);
    expect((await z.call("planka_download_attachment", { cardId: CARD, attachmentId: "71" })).text).toMatch(/Binary file \(application\/zip/);
    const link = await call("planka_download_attachment", { cardId: CARD, attachmentId: "73" });
    expect(link.text).toMatch(/Link attachment/);
    expect((await call("planka_download_attachment", { cardId: CARD, attachmentId: "99" })).text).toMatch(/not found on card/);
  });

  it("respects filesDir for savePath", async () => {
    const root = join(tmp, "dl-sandbox");
    mkdirSync(root, { recursive: true });
    const { call } = await connect(fakePlanka(routes()).client, { filesDir: root });
    expect((await call("planka_download_attachment", { cardId: CARD, attachmentId: "71", savePath: "n.txt" })).data.savedTo).toBe(join(root, "n.txt"));
    expect(existsSync(join(root, "n.txt"))).toBe(true);
    expect((await call("planka_download_attachment", { cardId: CARD, attachmentId: "71", savePath: join(tmp, "x.txt") })).text).toMatch(/outside/);
  });
});

describe("planka_update_card cover", () => {
  it("sets and clears coverAttachmentId", async () => {
    const f = fakePlanka({ [`PATCH /cards/${CARD}`]: (c: Call) => ({ item: { id: CARD, ...c.body } }) });
    const { call } = await connect(f.client);
    expect((await call("planka_update_card", { cardId: CARD, coverAttachmentId: "72" })).data.coverAttachmentId).toBe("72");
    expect((await call("planka_update_card", { cardId: CARD, coverAttachmentId: null })).data.coverAttachmentId).toBeNull();
    expect(f.calls.map((c) => c.body)).toEqual([{ coverAttachmentId: "72" }, { coverAttachmentId: null }]);
  });
});
